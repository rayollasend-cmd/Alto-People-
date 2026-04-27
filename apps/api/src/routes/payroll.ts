import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  PayrollItemListResponseSchema,
  PayrollRunCreateInputSchema,
  PayrollRunDetailSchema,
  PayrollRunListResponseSchema,
  type PayrollItem,
  type PayrollItemListResponse,
  type PayrollRunDetail,
  type PayrollRunListResponse,
  type PayrollRunSummary,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopePayrollRuns } from '../lib/scope.js';
import {
  pickHourlyRate,
  round2,
  sumApprovedHours,
} from '../lib/payroll.js';
import {
  computePaycheckTaxes,
  zeroTaxBreakdown,
  type PayFrequency,
} from '../lib/payrollTax.js';
import { hashPdf, renderPaystubPdf, type PaystubData } from '../lib/paystub.js';
import { pickAdapter, type DisbursementInput } from '../lib/disbursement.js';
import { decryptString } from '../lib/crypto.js';
import type { PayoutMethod } from '@prisma/client';
import { recordPayrollEvent } from '../lib/audit.js';
import {
  isStubMode as qboIsStubMode,
  postPayrollJournalEntry,
} from '../lib/quickbooks.js';
import archiver from 'archiver';

export const payrollRouter = Router();

const PROCESS = requireCapability('process:payroll');

const TX_OPTS = { timeout: 60_000, maxWait: 10_000 };

type RawRun = Prisma.PayrollRunGetPayload<{
  include: {
    client: { select: { name: true } };
    items: { include: { associate: { select: { firstName: true; lastName: true } } } };
  };
}>;

type RawItem = Prisma.PayrollItemGetPayload<{
  include: { associate: { select: { firstName: true; lastName: true } } };
}>;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toItem(i: RawItem): PayrollItem {
  return {
    id: i.id,
    payrollRunId: i.payrollRunId,
    associateId: i.associateId,
    associateName: i.associate ? `${i.associate.firstName} ${i.associate.lastName}` : null,
    hoursWorked: Number(i.hoursWorked),
    hourlyRate: Number(i.hourlyRate),
    grossPay: Number(i.grossPay),
    federalWithholding: Number(i.federalWithholding),
    fica: Number(i.fica),
    medicare: Number(i.medicare),
    stateWithholding: Number(i.stateWithholding),
    taxState: i.taxState,
    ytdWages: Number(i.ytdWages),
    ytdMedicareWages: Number(i.ytdMedicareWages),
    employerFica: Number(i.employerFica),
    employerMedicare: Number(i.employerMedicare),
    employerFuta: Number(i.employerFuta),
    employerSuta: Number(i.employerSuta),
    netPay: Number(i.netPay),
    status: i.status,
    disbursementRef: i.disbursementRef,
    disbursedAt: i.disbursedAt ? i.disbursedAt.toISOString() : null,
    failureReason: i.failureReason,
  };
}

function toSummary(r: RawRun): PayrollRunSummary {
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: r.client?.name ?? null,
    periodStart: ymd(r.periodStart),
    periodEnd: ymd(r.periodEnd),
    status: r.status,
    totalGross: Number(r.totalGross),
    totalTax: Number(r.totalTax),
    totalNet: Number(r.totalNet),
    totalEmployerTax: Number(r.totalEmployerTax),
    itemCount: r.items.length,
    notes: r.notes,
    finalizedAt: r.finalizedAt ? r.finalizedAt.toISOString() : null,
    disbursedAt: r.disbursedAt ? r.disbursedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    qboJournalEntryId: r.qboJournalEntryId,
    qboSyncedAt: r.qboSyncedAt ? r.qboSyncedAt.toISOString() : null,
    qboSyncError: r.qboSyncError,
  };
}

function toDetail(r: RawRun): PayrollRunDetail {
  return {
    ...toSummary(r),
    items: r.items.map(toItem),
  };
}

const RUN_INCLUDE = {
  client: { select: { name: true } },
  items: { include: { associate: { select: { firstName: true, lastName: true } } } },
} as const;

/* ===== HR/Finance reads ================================================= */

payrollRouter.get('/runs', async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const where: Prisma.PayrollRunWhereInput = {
      ...scopePayrollRuns(req.user!),
      ...(status ? { status: status as Prisma.PayrollRunWhereInput['status'] } : {}),
    };
    const rows = await prisma.payrollRun.findMany({
      where,
      orderBy: { periodStart: 'desc' },
      take: 100,
      include: RUN_INCLUDE,
    });
    const payload: PayrollRunListResponse = PayrollRunListResponseSchema.parse({
      runs: rows.map(toSummary),
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

payrollRouter.get('/runs/:id', async (req, res, next) => {
  try {
    const row = await prisma.payrollRun.findFirst({
      where: { id: req.params.id, ...scopePayrollRuns(req.user!) },
      include: RUN_INCLUDE,
    });
    if (!row) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
    const payload: PayrollRunDetail = PayrollRunDetailSchema.parse(toDetail(row));
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/* ===== Branch enrollment (HR) =========================================== */

/**
 * GET /payroll/associates/:id/branch-enrollment
 * Returns just enough payout-method state for HR to decide what to do:
 * which rail will be used for the next disbursement, whether a bank
 * account is on file (we never expose the actual decrypted numbers),
 * and the Branch card id if any.
 */
payrollRouter.get(
  '/associates/:id/branch-enrollment',
  PROCESS,
  async (req, res, next) => {
    try {
      const associate = await prisma.associate.findUnique({
        where: { id: req.params.id },
        include: { payoutMethods: { where: { isPrimary: true }, take: 1 } },
      });
      if (!associate) {
        throw new HttpError(404, 'associate_not_found', 'Associate not found');
      }
      const pm = associate.payoutMethods[0] ?? null;
      const hasBankAccount = !!(pm?.routingNumberEnc && pm?.accountNumberEnc);
      const branchCardId = pm?.branchCardId ?? null;
      let rail: 'BRANCH_CARD' | 'BANK_ACCOUNT' | 'NONE';
      if (branchCardId) rail = 'BRANCH_CARD';
      else if (hasBankAccount) rail = 'BANK_ACCOUNT';
      else rail = 'NONE';
      res.json({
        associateId: associate.id,
        firstName: associate.firstName,
        lastName: associate.lastName,
        hasBankAccount,
        branchCardId,
        accountType: pm?.accountType ?? null,
        rail,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /payroll/associates/:id/branch-enrollment
 * Body: { branchCardId: string | null }
 *
 * Stores (or clears) the Branch-side card identifier on the associate's
 * primary PayoutMethod. If no primary method exists, creates a card-only
 * row. Sending null clears the card without touching the bank fields,
 * so the next run falls back to ACH if available.
 */
payrollRouter.patch(
  '/associates/:id/branch-enrollment',
  PROCESS,
  async (req, res, next) => {
    try {
      const associate = await prisma.associate.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!associate) {
        throw new HttpError(404, 'associate_not_found', 'Associate not found');
      }
      const raw = req.body?.branchCardId;
      const branchCardId =
        raw === null || raw === undefined || raw === ''
          ? null
          : typeof raw === 'string'
            ? raw.trim()
            : null;
      if (raw && typeof raw !== 'string') {
        throw new HttpError(400, 'invalid_body', 'branchCardId must be a string or null');
      }
      if (branchCardId !== null && (branchCardId.length === 0 || branchCardId.length > 64)) {
        throw new HttpError(400, 'invalid_body', 'branchCardId length must be 1–64 chars');
      }

      const existing = await prisma.payoutMethod.findFirst({
        where: { associateId: associate.id, isPrimary: true },
      });
      if (existing) {
        await prisma.payoutMethod.update({
          where: { id: existing.id },
          data: { branchCardId },
        });
      } else if (branchCardId) {
        await prisma.payoutMethod.create({
          data: {
            associateId: associate.id,
            type: 'BRANCH_CARD',
            branchCardId,
            isPrimary: true,
          },
        });
      }
      // No-op when there's no primary method AND HR sent null — nothing to clear.

      // Audit at the associate scope (recordPayrollEvent hardcodes
      // entityType: 'PayrollRun' which would be wrong here).
      await prisma.auditLog.create({
        data: {
          actorUserId: req.user!.id,
          action: 'payroll.branch_enrollment_updated',
          entityType: 'Associate',
          entityId: associate.id,
          metadata: {
            ip: req.ip ?? null,
            userAgent: req.headers['user-agent'] ?? null,
            hasCard: branchCardId !== null,
          },
        },
      });

      res.json({ ok: true, branchCardId });
    } catch (err) {
      next(err);
    }
  }
);

/* ===== HR-only writes (process:payroll) ================================= */

/**
 * Create a payroll run for the given period. Aggregates APPROVED time
 * entries for every associate that has any in the period (optionally
 * scoped to a single client). Items are computed and snapshotted.
 */
payrollRouter.post('/runs', PROCESS, async (req, res, next) => {
  try {
    const parsed = PayrollRunCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    const periodStart = new Date(`${input.periodStart}T00:00:00.000Z`);
    // Treat periodEnd as inclusive — pull entries that started before the
    // start of the next day.
    const periodEndExclusive = new Date(`${input.periodEnd}T00:00:00.000Z`);
    periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);

    const defaultRate = input.defaultHourlyRate ?? 15;

    const result = await prisma.$transaction(async (tx) => {
      const run = await tx.payrollRun.create({
        data: {
          clientId: input.clientId ?? null,
          periodStart,
          periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
          status: 'DRAFT',
          notes: input.notes ?? null,
          createdById: req.user!.id,
        },
      });

      const entries = await tx.timeEntry.findMany({
        where: {
          status: 'APPROVED',
          clockInAt: { gte: periodStart, lt: periodEndExclusive },
          ...(input.clientId ? { clientId: input.clientId } : {}),
        },
        include: {
          associate: {
            select: {
              id: true,
              state: true,
              employmentType: true,
              w4Submission: {
                select: {
                  filingStatus: true,
                  extraWithholding: true,
                  deductions: true,
                  otherIncome: true,
                  dependentsAmount: true,
                },
              },
            },
          },
        },
      });

      const byAssociate = new Map<string, typeof entries>();
      for (const e of entries) {
        const arr = byAssociate.get(e.associateId) ?? [];
        arr.push(e);
        byAssociate.set(e.associateId, arr);
      }

      const payFrequency: PayFrequency = 'BIWEEKLY';

      let totalGross = 0;
      let totalTax = 0;
      let totalNet = 0;
      let totalEmployerTax = 0;

      const yearStart = new Date(Date.UTC(periodStart.getUTCFullYear(), 0, 1));

      for (const [associateId, group] of byAssociate) {
        const hoursWorked = sumApprovedHours(group);
        if (hoursWorked === 0) continue;

        const shifts = await tx.shift.findMany({
          where: {
            assignedAssociateId: associateId,
            startsAt: { gte: periodStart, lt: periodEndExclusive },
          },
          select: { hourlyRate: true },
        });
        const hourlyRate = pickHourlyRate(shifts, defaultRate);
        const grossPay = round2(hoursWorked * hourlyRate);

        // Pull YTD wages so FICA cap and Medicare surcharge math is right.
        // We sum prior PayrollItems in this calendar year EXCLUDING items
        // belonging to this run (so re-aggregating doesn't double-count).
        const priorYtd = await tx.payrollItem.aggregate({
          where: {
            associateId,
            payrollRun: { periodStart: { gte: yearStart, lt: periodStart } },
          },
          _sum: { grossPay: true },
        });
        const ytdWages = Number(priorYtd._sum.grossPay ?? 0);
        const ytdMedicareWages = ytdWages; // no Medicare exclusions in our model

        const w4 = group[0].associate.w4Submission;
        const associateState = group[0].associate.state ?? null;
        const employmentType = group[0].associate.employmentType;

        // Phase 42 — sum active pre-tax benefit elections for this period.
        // Active = effectiveDate <= periodEnd AND (terminationDate is null
        // OR terminationDate >= periodStart). 1099 contractors don't take
        // payroll deductions through us — they handle their own benefits.
        let preTaxDeductions = 0;
        if (employmentType === 'W2_EMPLOYEE') {
          const enrollments = await tx.benefitsEnrollment.findMany({
            where: {
              associateId,
              effectiveDate: { lte: periodEndExclusive },
              OR: [
                { terminationDate: null },
                { terminationDate: { gte: periodStart } },
              ],
            },
            select: { electedAmountCentsPerPeriod: true },
          });
          const totalCents = enrollments.reduce(
            (acc, e) => acc + e.electedAmountCentsPerPeriod,
            0
          );
          preTaxDeductions = round2(totalCents / 100);
        }
        const taxableGross = round2(Math.max(0, grossPay - preTaxDeductions));

        // Phase 41 — 1099 contractors are paid gross. No federal/state
        // withholding, no FICA/Medicare, no employer-side payroll tax.
        // 1099-NEC reporting (Box 1 = grossPay totals) is downstream.
        const breakdown =
          employmentType === 'W2_EMPLOYEE'
            ? computePaycheckTaxes({
                grossPay: taxableGross,
                filingStatus: w4?.filingStatus ?? null,
                payFrequency,
                state: associateState,
                ytdWages,
                ytdMedicareWages,
                extraWithholding: w4?.extraWithholding ? Number(w4.extraWithholding) : 0,
                deductions: w4?.deductions ? Number(w4.deductions) : 0,
                otherIncome: w4?.otherIncome ? Number(w4.otherIncome) : 0,
                dependentsAmount: w4?.dependentsAmount ? Number(w4.dependentsAmount) : 0,
              })
            : zeroTaxBreakdown(grossPay);

        await tx.payrollItem.upsert({
          where: { payrollRunId_associateId: { payrollRunId: run.id, associateId } },
          create: {
            payrollRunId: run.id,
            associateId,
            hoursWorked,
            hourlyRate,
            grossPay,
            preTaxDeductions,
            federalWithholding: breakdown.federalIncomeTax,
            fica: breakdown.socialSecurity,
            medicare: breakdown.medicare,
            stateWithholding: breakdown.stateIncomeTax,
            taxState: associateState,
            ytdWages,
            ytdMedicareWages,
            employerFica: breakdown.employer.fica,
            employerMedicare: breakdown.employer.medicare,
            employerFuta: breakdown.employer.futa,
            employerSuta: breakdown.employer.suta,
            netPay: breakdown.netPay,
            status: 'PENDING',
          },
          update: {
            hoursWorked,
            hourlyRate,
            grossPay,
            preTaxDeductions,
            federalWithholding: breakdown.federalIncomeTax,
            fica: breakdown.socialSecurity,
            medicare: breakdown.medicare,
            stateWithholding: breakdown.stateIncomeTax,
            taxState: associateState,
            ytdWages,
            ytdMedicareWages,
            employerFica: breakdown.employer.fica,
            employerMedicare: breakdown.employer.medicare,
            employerFuta: breakdown.employer.futa,
            employerSuta: breakdown.employer.suta,
            netPay: breakdown.netPay,
          },
        });

        totalGross += grossPay;
        totalTax += breakdown.totalEmployeeTax;
        totalNet += breakdown.netPay;
        totalEmployerTax +=
          breakdown.employer.fica +
          breakdown.employer.medicare +
          breakdown.employer.futa +
          breakdown.employer.suta;
      }

      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          totalGross: round2(totalGross),
          totalTax: round2(totalTax),
          totalNet: round2(totalNet),
          totalEmployerTax: round2(totalEmployerTax),
        },
      });

      return run;
    }, TX_OPTS);

    await recordPayrollEvent({
      actorUserId: req.user!.id,
      action: 'payroll.run_created',
      payrollRunId: result.id,
      clientId: result.clientId,
      metadata: { periodStart: input.periodStart, periodEnd: input.periodEnd },
      req,
    });

    const full = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: result.id },
      include: RUN_INCLUDE,
    });
    res.status(201).json(toDetail(full));
  } catch (err) {
    next(err);
  }
});

payrollRouter.post('/runs/:id/finalize', PROCESS, async (req, res, next) => {
  try {
    const run = await prisma.payrollRun.findFirst({
      where: { id: req.params.id, ...scopePayrollRuns(req.user!) },
    });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
    if (run.status !== 'DRAFT') {
      throw new HttpError(409, 'not_draft', 'Only DRAFT runs can be finalized');
    }
    const updated = await prisma.payrollRun.update({
      where: { id: run.id },
      data: { status: 'FINALIZED', finalizedAt: new Date() },
      include: RUN_INCLUDE,
    });
    await recordPayrollEvent({
      actorUserId: req.user!.id,
      action: 'payroll.run_finalized',
      payrollRunId: updated.id,
      clientId: updated.clientId,
      req,
    });
    res.json(toDetail(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * Disbursement runs each PENDING item through the configured provider
 * adapter (Phase 22: STUB by default; WISE/BRANCH stubbed-but-wired). Each
 * call appends a PayrollDisbursementAttempt row regardless of outcome so
 * finance can reconstruct retries. Provider-level failures don't fail the
 * whole batch — the failing item stays PENDING with failureReason and HR
 * can retry. The run flips to DISBURSED only when every item succeeded.
 */
payrollRouter.post('/runs/:id/disburse', PROCESS, async (req, res, next) => {
  try {
    const run = await prisma.payrollRun.findFirst({
      where: { id: req.params.id, ...scopePayrollRuns(req.user!) },
    });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
    if (run.status !== 'FINALIZED') {
      throw new HttpError(409, 'not_finalized', 'Run must be FINALIZED before disbursement');
    }

    const adapter = pickAdapter();
    const items = await prisma.payrollItem.findMany({
      where: { payrollRunId: run.id, status: 'PENDING' },
      include: {
        associate: {
          include: {
            // Pull the primary payout method so the adapter can address
            // the right rail per associate (Branch card vs ACH bank).
            payoutMethods: { where: { isPrimary: true }, take: 1 },
          },
        },
      },
    });

    let allSucceeded = true;
    const now = new Date();
    for (const item of items) {
      const primary = item.associate.payoutMethods[0] ?? null;
      const result = await adapter.disburse({
        amount: Number(item.netPay),
        currency: 'USD',
        recipient: recipientFromPayoutMethod(item.associate, primary),
        idempotencyKey: item.id,
        memo: `Payroll ${ymd(run.periodStart)}–${ymd(run.periodEnd)}`,
      }).catch((err: unknown) => ({
        provider: adapter.provider,
        externalRef: '',
        status: 'FAILED' as const,
        failureReason: err instanceof Error ? err.message : String(err),
      }));

      // Append the attempt log first — we want it persisted even if the
      // PayrollItem update later races.
      await prisma.payrollDisbursementAttempt.create({
        data: {
          payrollItemId: item.id,
          provider: result.provider,
          status: result.status,
          externalRef: result.externalRef || null,
          failureReason: result.failureReason ?? null,
          attemptedById: req.user!.id,
        },
      });

      if (result.status === 'SUCCESS') {
        await prisma.payrollItem.update({
          where: { id: item.id },
          data: {
            status: 'DISBURSED',
            disbursementRef: result.externalRef,
            disbursedAt: now,
            failureReason: null,
          },
        });
      } else if (result.status === 'PENDING') {
        // Provider accepted the request but hasn't settled. Leave PayrollItem
        // PENDING; webhook handler (future) will flip to DISBURSED.
        allSucceeded = false;
      } else {
        // FAILED — mark the item HELD so HR sees it in the failure queue
        // without polluting the future SUCCESS retry attempt log.
        await prisma.payrollItem.update({
          where: { id: item.id },
          data: { status: 'HELD', failureReason: result.failureReason ?? 'unknown' },
        });
        allSucceeded = false;
      }
    }

    const updated = await prisma.payrollRun.update({
      where: { id: run.id },
      data: allSucceeded
        ? { status: 'DISBURSED', disbursedAt: now }
        : {},
      include: RUN_INCLUDE,
    });

    await recordPayrollEvent({
      actorUserId: req.user!.id,
      action: 'payroll.run_disbursed',
      payrollRunId: updated.id,
      clientId: updated.clientId,
      metadata: {
        provider: adapter.provider,
        items: items.length,
        allSucceeded,
      },
      req,
    });

    // Best-effort QBO journal-entry sync. Only attempt when the run fully
    // disbursed against a single client AND a QuickbooksConnection exists.
    // Failures are stamped on the run (qboSyncError) and audited but never
    // block the disbursement response — accounting drift is a workable
    // problem, a 502 from /disburse is not.
    if (allSucceeded && updated.clientId) {
      const conn = await prisma.quickbooksConnection.findUnique({
        where: { clientId: updated.clientId },
      });
      if (conn) {
        const allItems = await prisma.payrollItem.findMany({
          where: { payrollRunId: updated.id },
        });
        const totals = aggregateForQbo(allItems);
        try {
          const result = await postPayrollJournalEntry(prisma, updated.clientId, {
            txnDate: updated.disbursedAt ?? now,
            memo: `Payroll ${updated.periodStart.toISOString().slice(0, 10)} – ${updated.periodEnd
              .toISOString()
              .slice(0, 10)}`,
            ...totals,
          });
          await prisma.payrollRun.update({
            where: { id: updated.id },
            data: {
              qboJournalEntryId: result.journalEntryId,
              qboSyncedAt: new Date(),
              qboSyncError: null,
            },
          });
          await recordPayrollEvent({
            actorUserId: req.user!.id,
            action: 'payroll.qbo_synced',
            payrollRunId: updated.id,
            clientId: updated.clientId,
            metadata: {
              journalEntryId: result.journalEntryId,
              stubMode: qboIsStubMode(),
              auto: true,
            },
            req,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await prisma.payrollRun.update({
            where: { id: updated.id },
            data: { qboSyncError: msg.slice(0, 500) },
          });
        }
      }
    }

    res.json(toDetail(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /payroll/runs/:id/retry-failures
 *
 * Retry every PayrollItem in HELD status for a run. The disburse handler
 * marks items HELD when the provider rejected them (FAILED) — this is the
 * HR-driven recovery path after they fix the underlying issue (rotated
 * a Branch enrollment, corrected a routing number, topped up the source
 * account, etc.). Idempotent on the Branch side because we keep using
 * PayrollItem.id as the idempotency key.
 */
payrollRouter.post('/runs/:id/retry-failures', PROCESS, async (req, res, next) => {
  try {
    const run = await prisma.payrollRun.findFirst({
      where: { id: req.params.id, ...scopePayrollRuns(req.user!) },
    });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
    if (run.status !== 'FINALIZED' && run.status !== 'DISBURSED') {
      throw new HttpError(
        409,
        'wrong_status',
        'Only FINALIZED or DISBURSED runs can have failures retried'
      );
    }
    const adapter = pickAdapter();
    const held = await prisma.payrollItem.findMany({
      where: { payrollRunId: run.id, status: 'HELD' },
      include: {
        associate: {
          include: {
            payoutMethods: { where: { isPrimary: true }, take: 1 },
          },
        },
      },
    });
    if (held.length === 0) {
      res.json({ retried: 0, succeeded: 0 });
      return;
    }
    let succeeded = 0;
    const now = new Date();
    for (const item of held) {
      const primary = item.associate.payoutMethods[0] ?? null;
      const result = await adapter.disburse({
        amount: Number(item.netPay),
        currency: 'USD',
        recipient: recipientFromPayoutMethod(item.associate, primary),
        idempotencyKey: item.id,
        memo: `Payroll ${ymd(run.periodStart)}–${ymd(run.periodEnd)}`,
      }).catch((err: unknown) => ({
        provider: adapter.provider,
        externalRef: '',
        status: 'FAILED' as const,
        failureReason: err instanceof Error ? err.message : String(err),
      }));
      await prisma.payrollDisbursementAttempt.create({
        data: {
          payrollItemId: item.id,
          provider: result.provider,
          status: result.status,
          externalRef: result.externalRef || null,
          failureReason: result.failureReason ?? null,
          attemptedById: req.user!.id,
        },
      });
      if (result.status === 'SUCCESS') {
        await prisma.payrollItem.update({
          where: { id: item.id },
          data: {
            status: 'DISBURSED',
            disbursementRef: result.externalRef,
            disbursedAt: now,
            failureReason: null,
          },
        });
        succeeded++;
      } else if (result.status === 'PENDING') {
        await prisma.payrollItem.update({
          where: { id: item.id },
          data: {
            status: 'PENDING',
            disbursementRef: result.externalRef,
            failureReason: null,
          },
        });
      } else {
        await prisma.payrollItem.update({
          where: { id: item.id },
          data: { failureReason: result.failureReason ?? 'unknown' },
        });
      }
    }

    // If every item is now DISBURSED, flip the run.
    const stillOpen = await prisma.payrollItem.count({
      where: { payrollRunId: run.id, status: { not: 'DISBURSED' } },
    });
    if (stillOpen === 0 && run.status !== 'DISBURSED') {
      await prisma.payrollRun.update({
        where: { id: run.id },
        data: { status: 'DISBURSED', disbursedAt: now },
      });
    }

    await recordPayrollEvent({
      actorUserId: req.user!.id,
      action: 'payroll.failures_retried',
      payrollRunId: run.id,
      clientId: run.clientId,
      metadata: { provider: adapter.provider, retried: held.length, succeeded },
      req,
    });

    res.json({ retried: held.length, succeeded });
  } catch (err) {
    next(err);
  }
});

/**
 * Build the adapter recipient block from an associate's primary payout
 * method. Decrypts the routing/account ciphertext only at the call site
 * (never store decrypted bank numbers in any object that lingers). When
 * the BRANCH_CARD branchCardId is set it wins; otherwise we forward the
 * BANK_ACCOUNT details so Branch can push ACH to their own bank.
 */
function recipientFromPayoutMethod(
  associate: { id: string; firstName: string; lastName: string },
  pm: PayoutMethod | null
): DisbursementInput['recipient'] {
  const fullName = `${associate.firstName} ${associate.lastName}`;
  if (!pm) {
    return { associateId: associate.id, fullName };
  }
  if (pm.branchCardId) {
    return {
      associateId: associate.id,
      fullName,
      branchCardId: pm.branchCardId,
    };
  }
  if (pm.routingNumberEnc && pm.accountNumberEnc) {
    return {
      associateId: associate.id,
      fullName,
      routingNumber: decryptString(pm.routingNumberEnc),
      accountNumber: decryptString(pm.accountNumberEnc),
      accountType: pm.accountType === 'SAVINGS' ? 'SAVINGS' : 'CHECKING',
    };
  }
  return { associateId: associate.id, fullName };
}

function aggregateForQbo(items: Array<{
  grossPay: Prisma.Decimal;
  federalWithholding: Prisma.Decimal;
  stateWithholding: Prisma.Decimal;
  fica: Prisma.Decimal;
  medicare: Prisma.Decimal;
  preTaxDeductions: Prisma.Decimal;
  netPay: Prisma.Decimal;
  employerFica: Prisma.Decimal;
  employerMedicare: Prisma.Decimal;
  employerFuta: Prisma.Decimal;
  employerSuta: Prisma.Decimal;
}>) {
  let totalGross = 0;
  let totalFederal = 0;
  let totalState = 0;
  let totalFica = 0;
  let totalMedicare = 0;
  let totalBenefits = 0;
  let totalNet = 0;
  let totalEmployerTax = 0;
  for (const i of items) {
    totalGross += Number(i.grossPay);
    totalFederal += Number(i.federalWithholding);
    totalState += Number(i.stateWithholding);
    totalFica += Number(i.fica) + Number(i.employerFica);
    totalMedicare += Number(i.medicare) + Number(i.employerMedicare);
    totalBenefits += Number(i.preTaxDeductions);
    totalNet += Number(i.netPay);
    totalEmployerTax +=
      Number(i.employerFica) +
      Number(i.employerMedicare) +
      Number(i.employerFuta) +
      Number(i.employerSuta);
  }
  return {
    totalGross,
    totalEmployerTax,
    totalFederal,
    totalState,
    totalFica,
    totalMedicare,
    totalBenefits,
    totalNet,
  };
}

/* ===== Bulk paystubs ZIP (HR/Finance) ================================ */
//
// Streams a ZIP of every paystub PDF in the run. Renders each PDF on the
// fly using the same path as the single-paystub endpoint so the bytes
// match (and Phase 18's paystubHash stamping works for downstream
// re-verification). Capability gate is the existing payroll view scope —
// associates would 404 anyway because their scope doesn't include
// other associates' items.
payrollRouter.get('/runs/:runId/paystubs.zip', async (req, res, next) => {
  try {
    const run = await prisma.payrollRun.findFirst({
      where: { id: req.params.runId, ...scopePayrollRuns(req.user!) },
      include: { client: { select: { name: true } } },
    });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');

    const items = await prisma.payrollItem.findMany({
      where: { payrollRunId: run.id },
      include: { associate: true },
      orderBy: { associate: { lastName: 'asc' } },
    });
    if (items.length === 0) {
      throw new HttpError(404, 'no_items', 'Run has no paystubs');
    }

    const periodStart = ymd(run.periodStart);
    const periodEnd = ymd(run.periodEnd);
    const filename = `paystubs-${periodStart}-${run.id.slice(0, 8)}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      res.destroy(err);
    });
    archive.pipe(res);

    const issuedAt = new Date().toISOString();
    for (const item of items) {
      const stateLabel = item.taxState
        ? `${item.taxState} state withholding`
        : 'State withholding';
      const data: PaystubData = {
        company: { name: run.client?.name ?? 'Alto Etho LLC' },
        associate: {
          firstName: item.associate.firstName,
          lastName: item.associate.lastName,
          email: item.associate.email,
          addressLine1: item.associate.addressLine1,
          city: item.associate.city,
          state: item.associate.state,
          zip: item.associate.zip,
        },
        period: { start: periodStart, end: periodEnd },
        earnings: {
          hours: Number(item.hoursWorked),
          rate: Number(item.hourlyRate),
          gross: Number(item.grossPay),
        },
        taxes: {
          federalIncomeTax: Number(item.federalWithholding),
          socialSecurity: Number(item.fica),
          medicare: Number(item.medicare),
          stateIncomeTax: Number(item.stateWithholding),
          stateLabel,
        },
        totals: {
          totalEmployeeTax: round2(
            Number(item.federalWithholding) +
              Number(item.fica) +
              Number(item.medicare) +
              Number(item.stateWithholding)
          ),
          netPay: Number(item.netPay),
        },
        ytd: { wages: Number(item.ytdWages), medicareWages: Number(item.ytdMedicareWages) },
        employer: {
          fica: Number(item.employerFica),
          medicare: Number(item.employerMedicare),
          futa: Number(item.employerFuta),
          suta: Number(item.employerSuta),
        },
        meta: { runId: run.id, itemId: item.id, issuedAt },
      };
      const pdf = await renderPaystubPdf(data);
      const hash = hashPdf(pdf);
      // Stamp the per-item hash on first generation, exactly like the
      // single-paystub route, so a later single-download verifies as
      // identical to the bytes we just packed.
      if (!item.paystubHash) {
        await prisma.payrollItem.update({
          where: { id: item.id },
          data: { paystubHash: hash },
        });
      }
      const safeName = `${item.associate.lastName}-${item.associate.firstName}-${item.id.slice(0, 8)}.pdf`
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-');
      archive.append(pdf, { name: safeName });
    }

    await recordPayrollEvent({
      actorUserId: req.user!.id,
      action: 'payroll.paystubs_bulk_downloaded',
      payrollRunId: run.id,
      clientId: run.clientId,
      metadata: { items: items.length },
      req,
    });

    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

/* ===== Paystub PDF ===================================================== */

// Streams the rendered paystub PDF for a single PayrollItem. Scope:
// associates can fetch their own item; HR/Finance can fetch any item
// inside a run their scope sees. The first download stamps the
// PayrollItem.paystubHash; subsequent downloads must produce the same
// hash. If the PDF byte stream ever changes (font swap, layout tweak)
// finance gets a verifiable signal that the immutable record drifted.
payrollRouter.get('/items/:itemId/paystub.pdf', async (req, res, next) => {
  try {
    const item = await prisma.payrollItem.findUnique({
      where: { id: req.params.itemId },
      include: {
        payrollRun: { include: { client: { select: { name: true } } } },
        associate: true,
      },
    });
    if (!item) throw new HttpError(404, 'item_not_found', 'Paystub not found');

    const user = req.user!;
    const isOwner = user.associateId && user.associateId === item.associateId;
    const canManage = ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'FINANCE_ACCOUNTANT', 'EXECUTIVE_CHAIRMAN'].includes(user.role);
    if (!isOwner && !canManage) {
      throw new HttpError(404, 'item_not_found', 'Paystub not found');
    }

    const stateCode = item.taxState ?? null;
    const stateLabel = stateCode ? `${stateCode} state withholding` : 'State withholding';

    const data: PaystubData = {
      company: { name: item.payrollRun.client?.name ?? 'Alto Etho LLC' },
      associate: {
        firstName: item.associate.firstName,
        lastName: item.associate.lastName,
        email: item.associate.email,
        addressLine1: item.associate.addressLine1,
        city: item.associate.city,
        state: item.associate.state,
        zip: item.associate.zip,
      },
      period: {
        start: ymd(item.payrollRun.periodStart),
        end: ymd(item.payrollRun.periodEnd),
      },
      earnings: {
        hours: Number(item.hoursWorked),
        rate: Number(item.hourlyRate),
        gross: Number(item.grossPay),
      },
      taxes: {
        federalIncomeTax: Number(item.federalWithholding),
        socialSecurity: Number(item.fica),
        medicare: Number(item.medicare),
        stateIncomeTax: Number(item.stateWithholding),
        stateLabel,
      },
      totals: {
        totalEmployeeTax: round2(
          Number(item.federalWithholding) +
            Number(item.fica) +
            Number(item.medicare) +
            Number(item.stateWithholding)
        ),
        netPay: Number(item.netPay),
      },
      ytd: {
        wages: Number(item.ytdWages),
        medicareWages: Number(item.ytdMedicareWages),
      },
      employer: {
        fica: Number(item.employerFica),
        medicare: Number(item.employerMedicare),
        futa: Number(item.employerFuta),
        suta: Number(item.employerSuta),
      },
      meta: {
        runId: item.payrollRunId,
        itemId: item.id,
        issuedAt: new Date().toISOString(),
      },
    };

    const pdf = await renderPaystubPdf(data);
    const hash = hashPdf(pdf);

    if (!item.paystubHash) {
      // Stamp the first-download hash so future downloads can be verified.
      await prisma.payrollItem.update({
        where: { id: item.id },
        data: { paystubHash: hash },
      });
    }

    await recordPayrollEvent({
      actorUserId: user.id,
      action: 'payroll.paystub_downloaded',
      payrollRunId: item.payrollRunId,
      clientId: item.payrollRun.clientId,
      metadata: { itemId: item.id, sha256: hash },
      req,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="paystub-${item.payrollRun.periodStart.toISOString().slice(0, 10)}-${item.id.slice(0, 8)}.pdf"`
    );
    res.setHeader('X-Paystub-Hash', hash);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

/* ===== Associate-facing /me ============================================ */

payrollRouter.get('/me/items', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      const empty: PayrollItemListResponse = { items: [] };
      res.json(empty);
      return;
    }
    const rows = await prisma.payrollItem.findMany({
      where: { associateId: user.associateId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { associate: { select: { firstName: true, lastName: true } } },
    });
    const payload: PayrollItemListResponse = PayrollItemListResponseSchema.parse({
      items: rows.map(toItem),
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});
