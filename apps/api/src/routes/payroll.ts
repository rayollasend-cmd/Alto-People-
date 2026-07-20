import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  PayrollExceptionsInputSchema,
  PayrollExceptionsResponseSchema,
  PayrollItemListResponseSchema,
  PayrollRunAmendInputSchema,
  PayrollRunCreateInputSchema,
  PayrollRunDetailSchema,
  PayrollRunListResponseSchema,
  PayrollRunPreviewResponseSchema,
  PayrollScheduleAssignInputSchema,
  PayrollScheduleCreateInputSchema,
  PayrollScheduleListResponseSchema,
  PayrollScheduleSchema,
  PayrollScheduleUpdateInputSchema,
  PayrollUpcomingSummarySchema,
  type PayrollConfig as PayrollConfigDto,
  type PayrollException,
  type PayrollExceptionsResponse,
  type PayrollItem,
  type PayrollItemListResponse,
  type PayrollRunDetail,
  type PayrollRunListResponse,
  type PayrollRunPreviewResponse,
  type PayrollRunSummary,
  type PayrollSchedule as PayrollScheduleDto,
  type PayrollScheduleListResponse,
  type PayrollUpcomingSummary,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopePayrollRuns, scopePayrollSchedules } from '../lib/scope.js';
import { getCurrentPeriod, getNextPeriod } from '../lib/payrollSchedule.js';
import { round2 } from '../lib/payroll.js';
import { isStateTaxSupported } from '../lib/payrollTax.js';
import { aggregatePayrollProjection } from '../lib/payrollAggregator.js';
import { consumePendingDeductions } from '../lib/payrollYtd.js';
import { computePayrollExceptions } from '../lib/payrollExceptions.js';
import { hashPdf, renderPaystubPdf, type PaystubData } from '../lib/paystub.js';
import { sendPaystubEmail } from '../lib/sendPaystubEmail.js';
import { checkAdapter, pickAdapter, type DisbursementInput } from '../lib/disbursement.js';
import { renderCheckRegisterPdf } from '../lib/checkRegister.js';
import { decryptString } from '../lib/crypto.js';
import type { PayoutMethod } from '@prisma/client';
import { enqueueAudit, recordPayrollEvent } from '../lib/audit.js';
import {
  isStubMode as qboIsStubMode,
  postPayrollJournalEntry,
  postReversingJournalEntry,
} from '../lib/quickbooks.js';
import { notifyAssociatesOfRunVoid } from '../lib/payrollVoidNotify.js';
import { env } from '../config/env.js';
import { listW2EligibleAssociates } from '../lib/w2Aggregator.js';
import { listF1099NecEligibleAssociates } from '../lib/f1099NecAggregator.js';
import { listF1099MiscEligibleAssociates } from '../lib/f1099MiscAggregator.js';
import archiver from 'archiver';

export const payrollRouter = Router();

const PROCESS = requireCapability('process:payroll');
const VOID = requireCapability('void:payroll');

const TX_OPTS = { timeout: 60_000, maxWait: 10_000 };

// Pagination ceiling for `GET /payroll/runs`. Pulled into a named
// constant so the cap is visible in PR diffs.
const RUN_LIST_PAGE_SIZE = 100;

type RawRun = Prisma.PayrollRunGetPayload<{
  include: {
    client: { select: { name: true } };
    items: {
      include: {
        associate: { select: { firstName: true; lastName: true } };
        earnings: true;
      };
    };
  };
}>;

type RawItem = Prisma.PayrollItemGetPayload<{
  include: {
    associate: { select: { firstName: true; lastName: true } };
    earnings: true;
  };
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
    postTaxDeductions: Number(i.postTaxDeductions),
    status: i.status,
    disbursementRef: i.disbursementRef,
    disbursedAt: i.disbursedAt ? i.disbursedAt.toISOString() : null,
    failureReason: i.failureReason,
    earnings: i.earnings.map((e) => ({
      id: e.id,
      kind: e.kind,
      hours: e.hours === null ? null : Number(e.hours),
      rate: e.rate === null ? null : Number(e.rate),
      amount: Number(e.amount),
      isTaxable: e.isTaxable,
      notes: e.notes,
    })),
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
    kind: r.kind,
    amendsRunId: r.amendsRunId,
    amendmentReason: r.amendmentReason,
    cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
    cancelledById: r.cancelledById,
    cancelReason: r.cancelReason,
    voidJournalEntryId: r.voidJournalEntryId,
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
  items: {
    include: {
      associate: { select: { firstName: true, lastName: true } },
      earnings: true,
    },
  },
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
      take: RUN_LIST_PAGE_SIZE,
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
      enqueueAudit(
        {
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
        'payroll.branch_enrollment_updated'
      );

      res.json({ ok: true, branchCardId });
    } catch (err) {
      next(err);
    }
  }
);

/* ===== HR-only writes (process:payroll) ================================= */

/**
 * Wave 6.2 — Preview a run without creating any rows. Same input shape as
 * POST /runs; returns the projected per-associate items and run totals so
 * HR can verify the math (OT split, FIT, SIT, FICA, garnishments, net pay)
 * before committing.
 */
payrollRouter.post('/runs/preview', PROCESS, async (req, res, next) => {
  try {
    const parsed = PayrollRunCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    const periodStart = new Date(`${input.periodStart}T00:00:00.000Z`);
    const periodEndExclusive = new Date(`${input.periodEnd}T00:00:00.000Z`);
    periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);
    const defaultRate = input.defaultHourlyRate ?? 15;

    // Use the top-level prisma client (no transaction); aggregator does
    // reads only, so we don't need transactional consistency here.
    const projection = await aggregatePayrollProjection(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: input.clientId ?? null,
      defaultRate,
    });

    const body: PayrollRunPreviewResponse = PayrollRunPreviewResponseSchema.parse({
      items: projection.items.map((p) => ({
        associateId: p.associateId,
        associateName: p.associateName,
        hoursWorked: p.hoursWorked,
        hourlyRate: p.hourlyRate,
        regularHours: p.regularHours,
        overtimeHours: p.overtimeHours,
        grossPay: p.grossPay,
        preTaxDeductions: p.preTaxDeductions,
        preTaxRetirement: p.preTaxRetirement,
        federalIncomeTax: p.federalIncomeTax,
        fica: p.fica,
        medicare: p.medicare,
        stateIncomeTax: p.stateIncomeTax,
        taxState: p.taxState,
        payFrequency: p.payFrequency,
        disposableEarnings: p.disposableEarnings,
        postTaxDeductions: p.postTaxDeductions,
        netPay: p.netPay,
        employerFica: p.employerFica,
        employerMedicare: p.employerMedicare,
        employerFuta: p.employerFuta,
        employerSuta: p.employerSuta,
        ytdWages: p.ytdWages,
      })),
      totals: projection.totals,
    });
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * Wave 8 — Pre-flight exceptions for a period. Same input shape as preview
 * minus defaultHourlyRate (exceptions don't depend on rate). The wizard
 * fetches this alongside the preview and renders an exception strip; the
 * landing page uses just the counts to badge the "Run payroll" CTA.
 */
payrollRouter.post('/runs/exceptions', PROCESS, async (req, res, next) => {
  try {
    const parsed = PayrollExceptionsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    const periodStart = new Date(`${input.periodStart}T00:00:00.000Z`);
    const periodEndExclusive = new Date(`${input.periodEnd}T00:00:00.000Z`);
    periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);

    const result = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: input.clientId ?? null,
    });

    const body: PayrollExceptionsResponse = PayrollExceptionsResponseSchema.parse({
      exceptions: result.exceptions.map((e): PayrollException => ({
        associateId: e.associateId,
        associateName: e.associateName,
        kind: e.kind,
        severity: e.severity,
        message: e.message,
        ...(e.detail ? { detail: e.detail } : {}),
      })),
      counts: result.counts,
    });
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * Wave 8 — Payroll-home summary card. Returns the soonest schedule's
 * projected next run (employee count, projected gross/net, exception
 * counts) plus the most recent run the user can see. Mirrors QuickBooks
 * Online's "Run payroll" landing card — one fetch, one render.
 */
payrollRouter.get('/upcoming', async (req, res, next) => {
  try {
    // Pick the schedule with the SOONEST nextPeriodEnd among the ones the
    // user can see. We compute periods in JS using getCurrentPeriod /
    // getNextPeriod against the schedule's anchor, since today might fall
    // mid-period. Fall back to today's biweekly frame if no schedule.
    const schedules = await prisma.payrollSchedule.findMany({
      take: 1000,
      where: {
        ...scopePayrollSchedules(req.user!),
        isActive: true,
      },
      include: {
        client: { select: { name: true } },
        _count: { select: { associates: true } },
      },
    });

    const today = new Date();

    let chosenSchedule: typeof schedules[number] | null = null;
    let chosenWindow: { periodStart: string; periodEnd: string; payDate: string } | null = null;
    let chosenDraftRunId: string | null = null;

    for (const s of schedules) {
      const cur = getCurrentPeriod(
        {
          frequency: s.frequency,
          anchorDate: s.anchorDate,
          payDateOffsetDays: s.payDateOffsetDays,
        },
        today
      );
      // If a finalized/disbursed run exists for this period we've already
      // run it — skip to the next period. A DRAFT, however, means HR
      // started the run but didn't approve yet — that's the *resumable*
      // path the landing CTA points at.
      const periodStartDate = new Date(`${cur.periodStart}T00:00:00.000Z`);
      const existingRun = await prisma.payrollRun.findFirst({
        where: {
          ...(s.clientId ? { clientId: s.clientId } : {}),
          periodStart: periodStartDate,
        },
        select: { id: true, status: true },
      });
      const isCompleted =
        existingRun &&
        (existingRun.status === 'FINALIZED' ||
          existingRun.status === 'DISBURSED');
      const w = isCompleted
        ? getNextPeriod(
            {
              frequency: s.frequency,
              anchorDate: s.anchorDate,
              payDateOffsetDays: s.payDateOffsetDays,
            },
            today
          )
        : cur;
      const draftRunId =
        existingRun && existingRun.status === 'DRAFT' ? existingRun.id : null;

      if (
        !chosenSchedule ||
        !chosenWindow ||
        w.periodEnd < chosenWindow.periodEnd
      ) {
        chosenSchedule = s;
        chosenWindow = w;
        chosenDraftRunId = draftRunId;
      }
    }

    let nextRun: PayrollUpcomingSummary['nextRun'] = null;
    if (chosenSchedule && chosenWindow) {
      const periodStart = new Date(`${chosenWindow.periodStart}T00:00:00.000Z`);
      const periodEndExclusive = new Date(`${chosenWindow.periodEnd}T00:00:00.000Z`);
      periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);

      const projection = await aggregatePayrollProjection(prisma, {
        periodStart,
        periodEndExclusive,
        clientId: chosenSchedule.clientId,
        defaultRate: 15,
      });

      const exceptions = await computePayrollExceptions(prisma, {
        periodStart,
        periodEndExclusive,
        clientId: chosenSchedule.clientId,
      });

      nextRun = {
        scheduleId: chosenSchedule.id,
        scheduleName: chosenSchedule.name,
        clientId: chosenSchedule.clientId,
        clientName: chosenSchedule.client?.name ?? null,
        frequency: chosenSchedule.frequency,
        periodStart: chosenWindow.periodStart,
        periodEnd: chosenWindow.periodEnd,
        payDate: chosenWindow.payDate,
        employeeCount: projection.totals.itemCount,
        projectedGross: projection.totals.totalGross,
        projectedNet: projection.totals.totalNet,
        projectedEmployerCost: projection.totals.totalEmployerTax,
        blockingExceptions: exceptions.counts.blocking,
        totalExceptions:
          exceptions.counts.blocking +
          exceptions.counts.warning +
          exceptions.counts.info,
        draftRunId: chosenDraftRunId,
      };
    }

    const lastRunRow = await prisma.payrollRun.findFirst({
      where: scopePayrollRuns(req.user!),
      orderBy: { periodEnd: 'desc' },
      include: { _count: { select: { items: true } } },
    });

    const lastRun: PayrollUpcomingSummary['lastRun'] = lastRunRow
      ? {
          id: lastRunRow.id,
          periodStart: ymd(lastRunRow.periodStart),
          periodEnd: ymd(lastRunRow.periodEnd),
          status: lastRunRow.status,
          itemCount: lastRunRow._count.items,
          totalNet: Number(lastRunRow.totalNet),
          finalizedAt: lastRunRow.finalizedAt
            ? lastRunRow.finalizedAt.toISOString()
            : null,
          disbursedAt: lastRunRow.disbursedAt
            ? lastRunRow.disbursedAt.toISOString()
            : null,
        }
      : null;

    const body: PayrollUpcomingSummary = PayrollUpcomingSummarySchema.parse({
      nextRun,
      lastRun,
    });
    res.json(body);
  } catch (err) {
    next(err);
  }
});

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

    // Wave 6.1 — Pure-ish aggregation lifted into payrollAggregator.
    // POST /runs creates the run row, then asks the aggregator for the
    // projected per-associate items, then persists. POST /runs/preview
    // calls the same aggregator without creating a run row.
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

      const projection = await aggregatePayrollProjection(tx, {
        periodStart,
        periodEndExclusive,
        clientId: input.clientId ?? null,
        defaultRate,
      });

      for (const p of projection.items) {
        const upserted = await tx.payrollItem.upsert({
          where: { payrollRunId_associateId: { payrollRunId: run.id, associateId: p.associateId } },
          create: {
            payrollRunId: run.id,
            associateId: p.associateId,
            hoursWorked: p.hoursWorked,
            hourlyRate: p.hourlyRate,
            grossPay: p.grossPay,
            preTaxDeductions: p.preTaxDeductions,
            preTaxRetirement: p.preTaxRetirement,
            postTaxDeductions: p.postTaxDeductions,
            federalWithholding: p.federalIncomeTax,
            fica: p.fica,
            medicare: p.medicare,
            stateWithholding: p.stateIncomeTax,
            taxState: p.taxState,
            ytdWages: p.ytdWages,
            ytdMedicareWages: p.ytdMedicareWages,
            employerFica: p.employerFica,
            employerMedicare: p.employerMedicare,
            employerFuta: p.employerFuta,
            employerSuta: p.employerSuta,
            reimbursementsTotal: p.reimbursementsTotal,
            netPay: p.netPay,
            status: 'PENDING',
          },
          update: {
            hoursWorked: p.hoursWorked,
            hourlyRate: p.hourlyRate,
            grossPay: p.grossPay,
            preTaxDeductions: p.preTaxDeductions,
            preTaxRetirement: p.preTaxRetirement,
            postTaxDeductions: p.postTaxDeductions,
            federalWithholding: p.federalIncomeTax,
            fica: p.fica,
            medicare: p.medicare,
            stateWithholding: p.stateIncomeTax,
            taxState: p.taxState,
            ytdWages: p.ytdWages,
            ytdMedicareWages: p.ytdMedicareWages,
            employerFica: p.employerFica,
            employerMedicare: p.employerMedicare,
            employerFuta: p.employerFuta,
            employerSuta: p.employerSuta,
            reimbursementsTotal: p.reimbursementsTotal,
            netPay: p.netPay,
          },
        });

        // Gap 3 — drain open overpayment-clawback deductions for this
        // associate, capped at the item's current net. Touches DB rows
        // so it lives only on the writing path (preview never calls this).
        const consumed = await consumePendingDeductions(tx, {
          associateId: p.associateId,
          availableNet: Number(upserted.netPay),
          payrollRunId: run.id,
          payrollItemId: upserted.id,
        });
        if (consumed.totalApplied > 0) {
          await tx.payrollItem.update({
            where: { id: upserted.id },
            data: {
              postTaxDeductions: round2(
                Number(upserted.postTaxDeductions) + consumed.totalApplied
              ),
              netPay: round2(Number(upserted.netPay) - consumed.totalApplied),
            },
          });
        }

        // Replace earning lines on every (re-)aggregation.
        await tx.payrollItemEarning.deleteMany({ where: { payrollItemId: upserted.id } });
        if (p.earnings.length > 0) {
          await tx.payrollItemEarning.createMany({
            data: p.earnings.map((e) => ({
              payrollItemId: upserted.id,
              kind: e.kind,
              hours: new Prisma.Decimal(e.hours),
              rate: new Prisma.Decimal(e.rate),
              amount: new Prisma.Decimal(e.amount),
              isTaxable: e.isTaxable,
            })),
          });
        }

        // Persist garnishment deductions for this run, recompute each
        // garnishment's running amountWithheld, close any that hit the cap.
        if (p.garnishments.length > 0) {
          await tx.garnishmentDeduction.deleteMany({
            where: {
              payrollRunId: run.id,
              garnishmentId: { in: p.garnishments.map((g) => g.garnishmentId) },
            },
          });
          for (const d of p.garnishments) {
            await tx.garnishmentDeduction.create({
              data: {
                garnishmentId: d.garnishmentId,
                payrollRunId: run.id,
                amount: new Prisma.Decimal(d.amount),
              },
            });
            const sum = await tx.garnishmentDeduction.aggregate({
              where: { garnishmentId: d.garnishmentId },
              _sum: { amount: true },
            });
            const newWithheld = Number(sum._sum.amount ?? 0);
            await tx.garnishment.update({
              where: { id: d.garnishmentId },
              data: {
                amountWithheld: new Prisma.Decimal(newWithheld),
                ...(d.reachedCap ? { status: 'COMPLETED' as const } : {}),
              },
            });
          }
        }

        // Gap 10 — fold SETTLED reimbursements into this item. Stamp the
        // Reimbursement rows with payrollItemId so a later run can't
        // double-fold them, and mirror as PayrollItemEarning rows
        // (kind=REIMBURSEMENT, isTaxable=false) so the paystub PDF can
        // show a per-row breakdown. Re-aggregation safety: the WHERE
        // filter requires status=SETTLED + payrollItemId IS NULL so a
        // re-run (which sees the rows already PAID) is a no-op.
        if (p.reimbursementIds.length > 0) {
          const updated = await tx.reimbursement.updateMany({
            where: {
              id: { in: p.reimbursementIds },
              status: 'SETTLED',
              payrollItemId: null,
            },
            data: {
              status: 'PAID',
              payrollItemId: upserted.id,
              paidPayrollRunId: run.id,
              paidAt: new Date(),
            },
          });
          if (updated.count > 0) {
            const folded = await tx.reimbursement.findMany({
              where: { payrollItemId: upserted.id },
              select: { id: true, title: true, totalAmount: true },
            });
            await tx.payrollItemEarning.createMany({
              data: folded.map((r) => ({
                payrollItemId: upserted.id,
                kind: 'REIMBURSEMENT' as const,
                hours: null,
                rate: null,
                amount: r.totalAmount,
                isTaxable: false,
                notes: r.title,
              })),
            });
          }
        }
      }

      // Re-read totals from the persisted items so any deduction-consumer
      // adjustments are reflected at the run level (the projection was
      // computed before pending overpayment clawbacks were drained).
      const persisted = await tx.payrollItem.findMany({
        where: { payrollRunId: run.id },
        select: {
          grossPay: true,
          federalWithholding: true,
          fica: true,
          medicare: true,
          stateWithholding: true,
          netPay: true,
          employerFica: true,
          employerMedicare: true,
          employerFuta: true,
          employerSuta: true,
        },
      });
      const totals = persisted.reduce(
        (acc, i) => {
          acc.totalGross += Number(i.grossPay);
          acc.totalTax +=
            Number(i.federalWithholding) +
            Number(i.fica) +
            Number(i.medicare) +
            Number(i.stateWithholding);
          acc.totalNet += Number(i.netPay);
          acc.totalEmployerTax +=
            Number(i.employerFica) +
            Number(i.employerMedicare) +
            Number(i.employerFuta) +
            Number(i.employerSuta);
          return acc;
        },
        { totalGross: 0, totalTax: 0, totalNet: 0, totalEmployerTax: 0 }
      );
      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          totalGross: round2(totals.totalGross),
          totalTax: round2(totals.totalTax),
          totalNet: round2(totals.totalNet),
          totalEmployerTax: round2(totals.totalEmployerTax),
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
      take: 100,
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
      // Gap 3 — AMENDMENT runs with non-positive net: no rail call. A
      // negative net is an overpayment clawback (queued as a
      // PendingPayrollDeduction the next REGULAR run will absorb); a
      // zero net is a cosmetic correction (e.g. fixing taxState only).
      // Either way, mark the item DISBURSED — "settled in Alto" — and
      // skip the adapter entirely.
      const netPayNum = Number(item.netPay);
      if (run.kind === 'AMENDMENT' && netPayNum <= 0) {
        if (netPayNum < 0) {
          await prisma.pendingPayrollDeduction.create({
            data: {
              associateId: item.associateId,
              sourceAmendmentItemId: item.id,
              amount: Math.abs(netPayNum),
              note:
                `Overpayment clawback from amended pay period ` +
                `${ymd(run.periodStart)}–${ymd(run.periodEnd)}`,
            },
          });
        }
        await prisma.payrollItem.update({
          where: { id: item.id },
          data: { status: 'DISBURSED', disbursedAt: now, failureReason: null },
        });
        continue;
      }

      const primary = item.associate.payoutMethods[0] ?? null;
      const disburseInput = {
        amount: netPayNum,
        currency: 'USD',
        recipient: recipientFromPayoutMethod(item.associate, primary),
        idempotencyKey: item.id,
        memo: `Payroll ${ymd(run.periodStart)}–${ymd(run.periodEnd)}`,
      };
      let result = await adapter.disburse(disburseInput).catch((err: unknown) => ({
        provider: adapter.provider,
        externalRef: '',
        status: 'FAILED' as const,
        failureReason: err instanceof Error ? err.message : String(err),
      }));
      // Electronic → paper fallback: an associate with no card and no bank
      // account gets a check from the register instead of stranding in the
      // HELD queue, when ops opted in.
      if (
        result.status === 'FAILED' &&
        env.PAYROLL_CHECK_FALLBACK &&
        adapter.provider !== 'CHECK' &&
        (result.failureReason ?? '').startsWith('no_payout_rail')
      ) {
        result = await checkAdapter.disburse(disburseInput).catch((err: unknown) => ({
          provider: 'CHECK' as const,
          externalRef: '',
          status: 'FAILED' as const,
          failureReason: err instanceof Error ? err.message : String(err),
        }));
      }

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
        // Fire-and-forget paystub email. The helper renders the PDF and
        // attaches it; idempotent via paystubEmailedAt so a webhook
        // re-delivery for the same item is a no-op. Never await — a Resend
        // hiccup must not roll back a successful disbursement.
        void sendPaystubEmail(prisma, { payrollItemId: item.id });
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
      // Irreversible money movement — record-then-respond.
      critical: true,
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
          take: 100,
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
 * GET /payroll/runs/:id/check-register.pdf — the printable register of
 * paper checks issued for this run (CHECK rail or electronic fallback).
 * Voided checks stay on the sheet, struck through, so every check number
 * ever issued is accounted for.
 */
payrollRouter.get('/runs/:id/check-register.pdf', PROCESS, async (req, res, next) => {
  try {
    const run = await prisma.payrollRun.findFirst({
      where: { id: req.params.id, ...scopePayrollRuns(req.user!) },
    });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
    const checks = await prisma.payCheck.findMany({
      where: { payrollItem: { payrollRunId: run.id } },
      orderBy: { checkNumber: 'asc' },
    });
    if (checks.length === 0) {
      throw new HttpError(404, 'no_checks', 'No paper checks were issued for this run.');
    }
    const pdf = await renderCheckRegisterPdf({
      company: { name: 'Alto HR' },
      run: {
        id: run.id,
        periodStart: ymd(run.periodStart),
        periodEnd: ymd(run.periodEnd),
      },
      rows: checks.map((c) => ({
        checkNumber: c.checkNumber,
        issuedAt: c.issuedAt.toISOString(),
        payeeName: c.payeeName,
        memo: c.memo,
        amount: Number(c.amount),
        voided: c.voidedAt !== null,
      })),
      generatedAt: new Date().toISOString(),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="check-register-${ymd(run.periodStart)}-${ymd(run.periodEnd)}.pdf"`,
    );
    res.send(pdf);
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
      take: 100,
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
 * POST /payroll/runs/:id/void
 *
 * Gap 3 — destructive financial operation. HR Admin only (`void:payroll`
 * capability — narrower than process:payroll).
 *
 * Voids a DISBURSED run as a system record correction. Items flip
 * DISBURSED -> VOIDED, the run flips DISBURSED -> CANCELLED, and a
 * reversing JournalEntry is posted to QBO so the period's accounting
 * unwinds. Money is NOT clawed back from the rail — that conversation
 * happens between HR and the associate outside Alto. Each affected
 * associate gets an IN_APP notification with the HR-supplied reason.
 *
 * Guards (return 409 with a code so the UI can render specific copy):
 *   - run.status must be DISBURSED                      → not_disbursed
 *   - disbursedAt must be within the last 30 days       → window_expired
 *   - run must not already have a downstream amendment  → has_amendment
 *
 * Body: { reason: string } — required, non-empty. Stored verbatim on
 * run.cancelReason and surfaces in the QBO reversal memo and the
 * associate notification.
 */
payrollRouter.post('/runs/:id/void', VOID, async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      throw new HttpError(400, 'invalid_body', 'reason is required');
    }

    const run = await prisma.payrollRun.findFirst({
      where: { id: req.params.id, ...scopePayrollRuns(req.user!) },
      include: {
        items: {
          include: {
            associate: {
              select: { id: true, firstName: true, lastName: true, user: { select: { id: true } } },
            },
          },
        },
      },
    });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');

    if (run.status !== 'DISBURSED') {
      throw new HttpError(409, 'not_disbursed', 'Only DISBURSED runs can be voided');
    }
    if (!run.disbursedAt) {
      // Defensive — DISBURSED without a disbursedAt would be a data
      // integrity bug, but it's the field we're gating the window on so
      // refuse rather than silently void a run we can't time-bound.
      throw new HttpError(409, 'not_disbursed', 'Run has no disbursedAt timestamp');
    }
    const now = new Date();
    const ageMs = now.getTime() - run.disbursedAt.getTime();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    if (ageMs > THIRTY_DAYS_MS) {
      throw new HttpError(
        409,
        'window_expired',
        'Run is more than 30 days past disbursement and can no longer be voided'
      );
    }
    const downstreamAmendment = await prisma.payrollRun.findFirst({
      where: { amendsRunId: run.id },
      select: { id: true },
    });
    if (downstreamAmendment) {
      throw new HttpError(
        409,
        'has_amendment',
        'Run has a downstream amendment — unwind the amendment before voiding'
      );
    }

    // Single transaction — flip run + every item that's currently
    // DISBURSED. Items that ended up HELD/FAILED stay as-is (their money
    // never moved, so there's nothing to void). PENDING items are
    // similarly left alone — voiding a run with PENDING items is a
    // pathological state, but we'd want HR to retry-or-hold first; the
    // not_disbursed guard above already blocks that path because the run
    // can only be DISBURSED if everything settled.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.payrollItem.updateMany({
        where: { payrollRunId: run.id, status: 'DISBURSED' },
        data: { status: 'VOIDED', voidedAt: now },
      });
      return tx.payrollRun.update({
        where: { id: run.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledById: req.user!.id,
          cancelReason: reason,
        },
        include: RUN_INCLUDE,
      });
    }, TX_OPTS);

    // Best-effort reversing JE — same posture as forward-sync on
    // disburse: failures stamp qboSyncError but never fail the void.
    if (run.qboJournalEntryId && updated.clientId) {
      const conn = await prisma.quickbooksConnection.findUnique({
        where: { clientId: updated.clientId },
      });
      if (conn) {
        const totals = aggregateForQbo(run.items);
        try {
          const result = await postReversingJournalEntry(prisma, updated.clientId, {
            txnDate: now,
            memo: `Payroll ${ymd(updated.periodStart)}–${ymd(updated.periodEnd)} (REVERSAL)`,
            ...totals,
            originalJournalEntryId: run.qboJournalEntryId,
            periodStart: run.periodStart,
            periodEnd: run.periodEnd,
            voidDate: now,
            reason,
          });
          await prisma.payrollRun.update({
            where: { id: updated.id },
            data: { voidJournalEntryId: result.journalEntryId, qboSyncError: null },
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

    // Audit at the run scope. Metadata captures the reason so audit-log
    // viewers see why without joining the run row.
    await recordPayrollEvent({
      actorUserId: req.user!.id,
      action: 'payroll.run_voided',
      payrollRunId: updated.id,
      clientId: updated.clientId,
      metadata: {
        reason,
        items: run.items.length,
        voidedItems: run.items.filter((i) => i.status === 'DISBURSED').length,
        ageDays: Math.round(ageMs / (24 * 60 * 60 * 1000)),
      },
      req,
      critical: true,
    });

    // Fan out — only associates with an actual user account get a
    // notification (no point creating a row no one can read).
    const recipients = run.items
      .map((i) => ({
        userId: i.associate.user?.id ?? null,
        name: `${i.associate.firstName} ${i.associate.lastName}`,
      }))
      .filter((r): r is { userId: string; name: string } => r.userId !== null);
    await notifyAssociatesOfRunVoid(prisma, {
      payrollRunId: updated.id,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      reason,
      associates: recipients,
    });

    res.json(toDetail(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /payroll/runs/:id/amend
 *
 * Gap 3 — destructive financial operation. HR Admin only (`void:payroll`
 * capability — same gate as void; both touch settled financial records).
 *
 * Creates a new AMENDMENT run that references the original (`amendsRunId`)
 * and carries one PayrollItem per corrected associate, where each item
 * stores SIGNED DELTAS vs. the original (positive = supplemental pay,
 * negative = clawback). The new run lands in DRAFT so HR can review the
 * computed deltas in the UI before finalizing.
 *
 * Body: `{ reason: string, corrections: [{ associateId, ... corrected
 * absolute values ... }] }`. Server matches each correction to the
 * original item by associateId, computes the delta, and persists. The
 * mandatory free-text `reason` lands on PayrollRun.amendmentReason and
 * is rendered on the amendment paystub PDF.
 *
 * Guards (409 with code):
 *   - run.status === CANCELLED → 'run_cancelled' (can't amend a voided run)
 *   - any correction's associateId not on the original run → 'unknown_associate'
 */
payrollRouter.post('/runs/:id/amend', VOID, async (req, res, next) => {
  try {
    const parsed = PayrollRunAmendInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { reason, corrections } = parsed.data;

    const original = await prisma.payrollRun.findFirst({
      where: { id: req.params.id, ...scopePayrollRuns(req.user!) },
      include: { items: true },
    });
    if (!original) throw new HttpError(404, 'run_not_found', 'Payroll run not found');

    if (original.status === 'CANCELLED') {
      throw new HttpError(409, 'run_cancelled', 'Cannot amend a voided run');
    }

    // Build a lookup of original items by associateId so we can validate
    // every correction targets a real associate on the run AND compute
    // deltas in a single pass.
    const originalByAssociate = new Map(
      original.items.map((i) => [i.associateId, i] as const)
    );
    for (const c of corrections) {
      if (!originalByAssociate.has(c.associateId)) {
        throw new HttpError(
          409,
          'unknown_associate',
          `Associate ${c.associateId} is not on the original run`,
        );
      }
    }

    // Server-computed delta per correction. We store the magnitude on
    // every column so the engine + reports + paystub PDF can render the
    // before/after picture without re-fetching the original.
    const amendmentItems = corrections.map((c) => {
      const orig = originalByAssociate.get(c.associateId)!;
      const correctedNet =
        c.grossPay -
        c.federalWithholding -
        c.fica -
        c.medicare -
        c.stateWithholding -
        c.preTaxDeductions -
        c.postTaxDeductions;
      const origNet = Number(orig.netPay);
      const dx = (corrected: number, origVal: Prisma.Decimal | number) =>
        round2(corrected - Number(origVal));
      return {
        associateId: c.associateId,
        amendsItemId: orig.id,
        hoursWorked: dx(c.hoursWorked, orig.hoursWorked),
        // hourlyRate isn't a delta — it's a rate; we copy what HR sent.
        hourlyRate: c.hourlyRate,
        grossPay: dx(c.grossPay, orig.grossPay),
        federalWithholding: dx(c.federalWithholding, orig.federalWithholding),
        fica: dx(c.fica, orig.fica),
        medicare: dx(c.medicare, orig.medicare),
        stateWithholding: dx(c.stateWithholding, orig.stateWithholding),
        preTaxDeductions: dx(c.preTaxDeductions, orig.preTaxDeductions),
        preTaxRetirement: dx(c.preTaxRetirement, orig.preTaxRetirement),
        postTaxDeductions: dx(c.postTaxDeductions, orig.postTaxDeductions),
        employerFica: dx(c.employerFica, orig.employerFica),
        employerMedicare: dx(c.employerMedicare, orig.employerMedicare),
        employerFuta: dx(c.employerFuta, orig.employerFuta),
        employerSuta: dx(c.employerSuta, orig.employerSuta),
        netPay: round2(correctedNet - origNet),
        // YTD snapshot fields are kept at zero on amendment items —
        // computeYtdWages sums signed grossPay across DISBURSED items
        // so the snapshot column on the amendment row isn't load-bearing.
        ytdWages: 0,
        ytdMedicareWages: 0,
        taxState: c.taxState ?? orig.taxState,
        status: 'PENDING' as const,
      };
    });

    // Run-level totals are deltas too — sum the per-associate deltas.
    const totals = amendmentItems.reduce(
      (acc, i) => {
        acc.totalGross += i.grossPay;
        acc.totalTax +=
          i.federalWithholding + i.fica + i.medicare + i.stateWithholding;
        acc.totalNet += i.netPay;
        acc.totalEmployerTax +=
          i.employerFica + i.employerMedicare + i.employerFuta + i.employerSuta;
        return acc;
      },
      { totalGross: 0, totalTax: 0, totalNet: 0, totalEmployerTax: 0 }
    );

    const amendment = await prisma.payrollRun.create({
      data: {
        clientId: original.clientId,
        periodStart: original.periodStart,
        periodEnd: original.periodEnd,
        status: 'DRAFT',
        kind: 'AMENDMENT',
        amendsRunId: original.id,
        amendmentReason: reason,
        createdById: req.user!.id,
        totalGross: round2(totals.totalGross),
        totalTax: round2(totals.totalTax),
        totalNet: round2(totals.totalNet),
        totalEmployerTax: round2(totals.totalEmployerTax),
        items: {
          create: amendmentItems,
        },
      },
      include: RUN_INCLUDE,
    });

    await recordPayrollEvent({
      actorUserId: req.user!.id,
      action: 'payroll.run_amended',
      payrollRunId: amendment.id,
      clientId: amendment.clientId,
      metadata: {
        reason,
        amendsRunId: original.id,
        corrections: corrections.length,
        netDeltaTotal: round2(totals.totalNet),
      },
      req,
      critical: true,
    });

    res.status(201).json(toDetail(amendment));
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
  associate: {
    id: string;
    firstName: string;
    lastName: string;
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  },
  pm: PayoutMethod | null
): DisbursementInput['recipient'] {
  const fullName = `${associate.firstName} ${associate.lastName}`;
  // Mailing address rides along on every rail: Wise requires it for ABA
  // recipients, and the check register prints it.
  const address = {
    addressLine1: associate.addressLine1 ?? null,
    city: associate.city ?? null,
    state: associate.state ?? null,
    zip: associate.zip ?? null,
  };
  if (!pm) {
    return { associateId: associate.id, fullName, ...address };
  }
  if (pm.branchCardId) {
    return {
      associateId: associate.id,
      fullName,
      branchCardId: pm.branchCardId,
      ...address,
    };
  }
  if (pm.routingNumberEnc && pm.accountNumberEnc) {
    return {
      associateId: associate.id,
      fullName,
      routingNumber: decryptString(pm.routingNumberEnc),
      accountNumber: decryptString(pm.accountNumberEnc),
      accountType: pm.accountType === 'SAVINGS' ? 'SAVINGS' : 'CHECKING',
      ...address,
    };
  }
  return { associateId: associate.id, fullName, ...address };
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
      take: 100,
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
        // Gap 10 — non-taxable reimbursements rolled into this paycheck.
        ...(Number(item.reimbursementsTotal) > 0
          ? { reimbursements: { total: Number(item.reimbursementsTotal) } }
          : {}),
        // Gap 3 — amendment banner + voided watermark for the audit trail.
        ...(run.kind === 'AMENDMENT' && run.amendsRunId
          ? {
              amendment: {
                reason: run.amendmentReason ?? '',
                sourceRunId: run.amendsRunId,
              },
            }
          : {}),
        ...(run.status === 'CANCELLED' || item.status === 'VOIDED'
          ? {
              voided: {
                voidedAt: (run.cancelledAt ?? item.voidedAt ?? new Date()).toISOString(),
                reason: run.cancelReason,
              },
            }
          : {}),
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
      // Gap 10 — non-taxable reimbursements rolled into this paycheck.
      ...(Number(item.reimbursementsTotal) > 0
        ? { reimbursements: { total: Number(item.reimbursementsTotal) } }
        : {}),
      // Gap 3 — amendment banner + voided watermark for the audit trail.
      ...(item.payrollRun.kind === 'AMENDMENT' && item.payrollRun.amendsRunId
        ? {
            amendment: {
              reason: item.payrollRun.amendmentReason ?? '',
              sourceRunId: item.payrollRun.amendsRunId,
            },
          }
        : {}),
      ...(item.payrollRun.status === 'CANCELLED' || item.status === 'VOIDED'
        ? {
            voided: {
              voidedAt: (
                item.payrollRun.cancelledAt ?? item.voidedAt ?? new Date()
              ).toISOString(),
              reason: item.payrollRun.cancelReason,
            },
          }
        : {}),
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

// Resend the paystub email for a single PayrollItem. Bypasses the
// paystubEmailedAt idempotency guard via force=true so HR can deliberately
// re-email when an associate says they didn't receive it. Returns a small
// JSON status the UI can render ("Sent", "Skipped: no email on file", etc.).
payrollRouter.post(
  '/items/:itemId/email-paystub',
  PROCESS,
  async (req, res, next) => {
    try {
      const item = await prisma.payrollItem.findUnique({
        where: { id: req.params.itemId },
        select: { id: true, payrollRunId: true, payrollRun: { select: { clientId: true } } },
      });
      if (!item) {
        throw new HttpError(404, 'item_not_found', 'Paystub not found');
      }
      // Run-scope check — same shape as the surrounding routes use.
      const inScope = await prisma.payrollRun.findFirst({
        where: { id: item.payrollRunId, ...scopePayrollRuns(req.user!) },
        select: { id: true },
      });
      if (!inScope) {
        throw new HttpError(404, 'item_not_found', 'Paystub not found');
      }

      const result = await sendPaystubEmail(prisma, {
        payrollItemId: item.id,
        force: true,
      });

      await recordPayrollEvent({
        actorUserId: req.user!.id,
        action: 'payroll.paystub_email_resent',
        payrollRunId: item.payrollRunId,
        clientId: item.payrollRun.clientId,
        metadata: {
          itemId: item.id,
          sent: result.sent,
          skipped: result.skipped,
          externalRef: result.externalRef,
        },
        req,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

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
      include: {
        associate: { select: { firstName: true, lastName: true } },
        earnings: true,
      },
    });
    const payload: PayrollItemListResponse = PayrollItemListResponseSchema.parse({
      items: rows.map(toItem),
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/* ===== Wave 1.1 — Pay schedules ======================================== */

type RawSchedule = Prisma.PayrollScheduleGetPayload<{
  include: {
    client: { select: { name: true } };
    _count: { select: { associates: true } };
  };
}>;

function toSchedule(s: RawSchedule): PayrollScheduleDto {
  const cur = getCurrentPeriod({
    frequency: s.frequency,
    anchorDate: s.anchorDate,
    payDateOffsetDays: s.payDateOffsetDays,
  });
  const nxt = getNextPeriod({
    frequency: s.frequency,
    anchorDate: s.anchorDate,
    payDateOffsetDays: s.payDateOffsetDays,
  });
  // Use the next un-disbursed window as the wizard suggestion. We can't
  // tell here whether the current period has been run yet (would need a
  // cross-table check); UI will handle the "is this period already run?"
  // affordance. For the schedule listing, surfacing "next" is honest.
  void cur;
  return {
    id: s.id,
    clientId: s.clientId,
    clientName: s.client?.name ?? null,
    name: s.name,
    frequency: s.frequency,
    anchorDate: ymd(s.anchorDate),
    payDateOffsetDays: s.payDateOffsetDays,
    isActive: s.isActive,
    notes: s.notes,
    associateCount: s._count.associates,
    nextPeriodStart: nxt.periodStart,
    nextPeriodEnd: nxt.periodEnd,
    nextPayDate: nxt.payDate,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

const SCHEDULE_INCLUDE = {
  client: { select: { name: true } },
  _count: { select: { associates: true } },
} as const;

payrollRouter.get('/schedules', PROCESS, async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const where: Prisma.PayrollScheduleWhereInput = {
      ...scopePayrollSchedules(req.user!),
      ...(includeInactive ? {} : { isActive: true }),
    };
    const rows = await prisma.payrollSchedule.findMany({
      take: 1000,
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: SCHEDULE_INCLUDE,
    });
    const payload: PayrollScheduleListResponse = PayrollScheduleListResponseSchema.parse({
      schedules: rows.map(toSchedule),
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

payrollRouter.post('/schedules', PROCESS, async (req, res, next) => {
  try {
    const input = PayrollScheduleCreateInputSchema.parse(req.body);
    if (input.clientId) {
      const client = await prisma.client.findFirst({
        where: { id: input.clientId, deletedAt: null },
      });
      if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    }
    const created = await prisma.payrollSchedule.create({
      data: {
        clientId: input.clientId ?? null,
        name: input.name,
        frequency: input.frequency,
        anchorDate: new Date(input.anchorDate),
        payDateOffsetDays: input.payDateOffsetDays ?? 5,
        notes: input.notes ?? null,
      },
      include: SCHEDULE_INCLUDE,
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        entityType: 'PayrollSchedule',
        entityId: created.id,
        action: 'payroll.schedule.create',
        metadata: { name: created.name, frequency: created.frequency },
      },
      'createPayrollSchedule'
    );
    res.status(201).json(PayrollScheduleSchema.parse(toSchedule(created)));
  } catch (err) {
    next(err);
  }
});

payrollRouter.patch('/schedules/:id', PROCESS, async (req, res, next) => {
  try {
    const input = PayrollScheduleUpdateInputSchema.parse(req.body);
    const existing = await prisma.payrollSchedule.findFirst({
      where: { id: req.params.id, ...scopePayrollSchedules(req.user!) },
    });
    if (!existing) throw new HttpError(404, 'schedule_not_found', 'Pay schedule not found');
    const data: Prisma.PayrollScheduleUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.frequency !== undefined) data.frequency = input.frequency;
    if (input.anchorDate !== undefined) data.anchorDate = new Date(input.anchorDate);
    if (input.payDateOffsetDays !== undefined) data.payDateOffsetDays = input.payDateOffsetDays;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.notes !== undefined) data.notes = input.notes;
    const updated = await prisma.payrollSchedule.update({
      where: { id: existing.id },
      data,
      include: SCHEDULE_INCLUDE,
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        entityType: 'PayrollSchedule',
        entityId: updated.id,
        action: 'payroll.schedule.update',
        metadata: { changed: Object.keys(data) },
      },
      'updatePayrollSchedule'
    );
    res.json(PayrollScheduleSchema.parse(toSchedule(updated)));
  } catch (err) {
    next(err);
  }
});

payrollRouter.delete('/schedules/:id', PROCESS, async (req, res, next) => {
  try {
    const existing = await prisma.payrollSchedule.findFirst({
      where: { id: req.params.id, ...scopePayrollSchedules(req.user!) },
      include: { _count: { select: { associates: true } } },
    });
    if (!existing) throw new HttpError(404, 'schedule_not_found', 'Pay schedule not found');
    if (existing._count.associates > 0) {
      throw new HttpError(
        409,
        'schedule_in_use',
        `Cannot delete a schedule with ${existing._count.associates} assigned associate(s). Reassign them first.`
      );
    }
    await prisma.payrollSchedule.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        entityType: 'PayrollSchedule',
        entityId: existing.id,
        action: 'payroll.schedule.delete',
        metadata: { name: existing.name },
      },
      'deletePayrollSchedule'
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /payroll/schedules/:id/assign
 * Body: { associateIds: string[] }
 *
 * Bulk-assigns associates to this schedule. Idempotent — re-assigning an
 * associate already on this schedule is a no-op. Associates can only
 * belong to one schedule, so this overwrites any prior assignment.
 */
payrollRouter.post('/schedules/:id/assign', PROCESS, async (req, res, next) => {
  try {
    const input = PayrollScheduleAssignInputSchema.parse(req.body);
    const schedule = await prisma.payrollSchedule.findFirst({
      where: { id: req.params.id, ...scopePayrollSchedules(req.user!) },
    });
    if (!schedule) throw new HttpError(404, 'schedule_not_found', 'Pay schedule not found');
    // If the schedule is client-scoped, restrict assignments to associates
    // working at clients with applications under that client. The simplest
    // correct rule: only pull associates whose latest application's clientId
    // matches. For Wave 1.1 we don't enforce this — HR can override — but
    // we do need to make sure the IDs exist.
    const found = await prisma.associate.findMany({
      take: 1000,
      where: { id: { in: input.associateIds }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== input.associateIds.length) {
      throw new HttpError(404, 'associate_not_found', 'One or more associates not found');
    }
    const result = await prisma.associate.updateMany({
      where: { id: { in: input.associateIds } },
      data: { payrollScheduleId: schedule.id },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        entityType: 'PayrollSchedule',
        entityId: schedule.id,
        action: 'payroll.schedule.assign',
        metadata: { count: result.count, associateIds: input.associateIds },
      },
      'assignPayrollSchedule'
    );
    res.json({ assigned: result.count });
  } catch (err) {
    next(err);
  }
});

/**
 * Read-only view of the payroll_config row that's driving the withholding
 * engine right now. Lets HR sanity-check what tax tables are loaded
 * without reading the migration SQL or shelling into the DB. Returns the
 * row for `?year=YYYY` if provided, otherwise the current calendar year.
 *
 * Gated by process:payroll (matches who runs payroll). Read-only for
 * everyone — federal-bracket edits go through a migration, not this UI.
 */
payrollRouter.get('/config', PROCESS, async (req, res, next) => {
  try {
    const yearRaw = (req.query.year ?? '').toString();
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new HttpError(400, 'invalid_year', 'year must be a 4-digit calendar year');
    }
    const row = await prisma.payrollConfig.findUnique({ where: { year } });
    if (!row) {
      throw new HttpError(
        404,
        'not_found',
        `No payroll_config row for year ${year}. Insert one via migration.`,
      );
    }
    const dto: PayrollConfigDto = {
      year: row.year,
      ssWageBase: Number(row.ssWageBase),
      medicareSurchargeThreshold: Number(row.medicareSurchargeThreshold),
      fedBracketsSingle: row.fedBracketsSingle as unknown as PayrollConfigDto['fedBracketsSingle'],
      fedBracketsMfj: row.fedBracketsMfj as unknown as PayrollConfigDto['fedBracketsMfj'],
      fedBracketsHoh: row.fedBracketsHoh as unknown as PayrollConfigDto['fedBracketsHoh'],
      updatedAt: row.updatedAt.toISOString(),
    };
    res.json(dto);
  } catch (err) {
    next(err);
  }
});

/* ===== Payroll readiness dashboard ====================================== */

/**
 * GET /payroll/readiness — one row per active associate, with five
 * green/red flags so HR can fix missing data BEFORE the run is created
 * (rather than discovering it during the wizard).
 *
 *   - w4OnFile          W-2 employees: W4Submission row exists.
 *                       1099 contractors: tinEncrypted is non-null
 *                       (W-9 capture). Same column, polymorphic by
 *                       employmentType — the column header in the UI
 *                       reads "W-4 / TIN".
 *   - taxStateSet       Associate.state non-null AND in the supported
 *                       state-tax table (FL passes — it's a no-SIT
 *                       state in the supported set).
 *   - payoutMethodOnFile  Primary PayoutMethod with at least one rail:
 *                         a Branch card OR encrypted bank account.
 *   - payScheduleAssigned  Associate.payrollScheduleId non-null.
 *   - userLinked        A User row points at this Associate.
 *
 * Read-only. The web UI links each red flag to the associate's profile
 * with a `?focus=` query param so HR lands on the right field.
 */
payrollRouter.get('/readiness', PROCESS, async (_req, res, next) => {
  try {
    const associates = await prisma.associate.findMany({
      where: { deletedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        state: true,
        employmentType: true,
        payrollScheduleId: true,
        tinEncrypted: true,
        w4Submission: { select: { id: true } },
        user: { select: { id: true } },
        payoutMethods: {
          where: { isPrimary: true },
          take: 1,
          select: { branchCardId: true, accountNumberEnc: true },
        },
      },
    });

    const rows = associates.map((a) => {
      const primary = a.payoutMethods[0] ?? null;
      const w4OnFile =
        a.employmentType === 'W2_EMPLOYEE'
          ? a.w4Submission !== null
          : a.tinEncrypted !== null;
      const taxStateSet = isStateTaxSupported(a.state);
      const payoutMethodOnFile =
        !!primary && (primary.branchCardId !== null || primary.accountNumberEnc !== null);
      const payScheduleAssigned = a.payrollScheduleId !== null;
      const userLinked = a.user !== null;
      const ready =
        w4OnFile && taxStateSet && payoutMethodOnFile && payScheduleAssigned && userLinked;
      return {
        associateId: a.id,
        firstName: a.firstName,
        lastName: a.lastName,
        email: a.email,
        employmentType: a.employmentType,
        flags: {
          w4OnFile,
          taxStateSet,
          payoutMethodOnFile,
          payScheduleAssigned,
          userLinked,
        },
        ready,
      };
    });

    const readyCount = rows.filter((r) => r.ready).length;
    res.json({
      total: rows.length,
      readyCount,
      missingCount: rows.length - readyCount,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Year-end close readiness — single endpoint that answers "is the tax
 * year ready to be closed?" Used by the dashboard checklist UI. Each
 * check returns done/total + a deeplink the operator can follow.
 *
 * The check set covers what closes a tax year operationally:
 *   1. All payroll runs in the year are DISBURSED (no DRAFT/FINALIZED).
 *   2. All eligible W-2s exist as TaxForm rows (DRAFT or FILED).
 *   3. All eligible 1099-NECs exist.
 *   4. All eligible 1099-MISCs exist.
 *   5. All TaxForm rows for the year are FILED (not DRAFT).
 *
 * Distribution (sending recipient copies) isn't tracked in the data
 * model today, so we surface it as a manual-confirm checkbox in the UI
 * rather than a derived check here.
 */
payrollRouter.get('/year-end-close', PROCESS, async (req, res, next) => {
  try {
    const yearParam = req.query.year ? Number(req.query.year) : new Date().getUTCFullYear() - 1;
    if (!Number.isInteger(yearParam) || yearParam < 2000 || yearParam > 2100) {
      throw new HttpError(400, 'invalid_year', 'year must be a 4-digit integer');
    }
    const yearStart = new Date(Date.UTC(yearParam, 0, 1));
    const yearEndExclusive = new Date(Date.UTC(yearParam + 1, 0, 1));

    const [openRuns, allW2EligibleIds, allNecEligibleIds, allMiscEligibleIds, formsForYear] =
      await Promise.all([
        prisma.payrollRun.count({
          where: {
            status: { in: ['DRAFT', 'FINALIZED'] },
            OR: [
              { disbursedAt: { gte: yearStart, lt: yearEndExclusive } },
              {
                AND: [
                  { disbursedAt: null },
                  { periodEnd: { gte: yearStart, lt: yearEndExclusive } },
                ],
              },
            ],
          },
        }),
        listW2EligibleAssociates(prisma, yearParam, null),
        listF1099NecEligibleAssociates(prisma, yearParam, null),
        listF1099MiscEligibleAssociates(prisma, yearParam, null),
        prisma.taxForm.findMany({
          where: {
            taxYear: yearParam,
            status: { not: 'VOIDED' },
            kind: { in: ['W2', 'F1099_NEC', 'F1099_MISC'] },
          },
          select: { kind: true, status: true, associateId: true },
        }),
      ]);

    const w2Generated = new Set(
      formsForYear.filter((f) => f.kind === 'W2' && f.associateId).map((f) => f.associateId!),
    );
    const necGenerated = new Set(
      formsForYear
        .filter((f) => f.kind === 'F1099_NEC' && f.associateId)
        .map((f) => f.associateId!),
    );
    const miscGenerated = new Set(
      formsForYear
        .filter((f) => f.kind === 'F1099_MISC' && f.associateId)
        .map((f) => f.associateId!),
    );

    const w2Missing = allW2EligibleIds.filter((id) => !w2Generated.has(id)).length;
    const necMissing = allNecEligibleIds.filter((id) => !necGenerated.has(id)).length;
    const miscMissing = allMiscEligibleIds.filter((id) => !miscGenerated.has(id)).length;

    const formsDraft = formsForYear.filter((f) => f.status === 'DRAFT').length;
    const formsTotal = formsForYear.length;

    const checks = [
      {
        key: 'runs_disbursed',
        label: 'All payroll runs disbursed',
        done: openRuns === 0,
        detail:
          openRuns === 0
            ? 'No DRAFT or FINALIZED runs touching this tax year.'
            : `${openRuns} run(s) still open. Finalize and disburse before closing.`,
        href: '/payroll',
      },
      {
        key: 'w2_generated',
        label: 'W-2s generated for all eligible employees',
        done: w2Missing === 0,
        detail:
          w2Missing === 0
            ? `${allW2EligibleIds.length} eligible · ${w2Generated.size} on file.`
            : `${w2Missing} eligible employee(s) missing a W-2.`,
        href: '/payroll/tax',
      },
      {
        key: 'nec_generated',
        label: '1099-NECs generated for all eligible contractors',
        done: necMissing === 0,
        detail:
          necMissing === 0
            ? `${allNecEligibleIds.length} eligible · ${necGenerated.size} on file.`
            : `${necMissing} eligible contractor(s) missing a 1099-NEC.`,
        href: '/payroll/tax',
      },
      {
        key: 'misc_generated',
        label: '1099-MISCs generated for all eligible recipients',
        done: miscMissing === 0,
        detail:
          miscMissing === 0
            ? `${allMiscEligibleIds.length} eligible · ${miscGenerated.size} on file.`
            : `${miscMissing} eligible recipient(s) missing a 1099-MISC.`,
        href: '/payroll/tax',
      },
      {
        key: 'forms_filed',
        label: 'All generated forms filed',
        done: formsTotal > 0 && formsDraft === 0,
        detail:
          formsTotal === 0
            ? 'No forms generated yet for this tax year.'
            : formsDraft === 0
              ? `All ${formsTotal} form(s) marked FILED.`
              : `${formsDraft} of ${formsTotal} form(s) still in DRAFT.`,
        href: '/payroll/tax',
      },
    ];

    const readyToClose = checks.every((c) => c.done);

    res.json({
      taxYear: yearParam,
      readyToClose,
      checks,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Per-associate YTD rollup for the requested tax year. Used by the YTD
 * report view so HR can answer "what has X earned and what's been
 * withheld this year" without paging through individual run drawers.
 *
 * Excludes VOIDED items and CANCELLED runs. AMENDMENT signed deltas
 * flow through naturally because the underlying items live in the
 * disbursed AMENDMENT run.
 */
payrollRouter.get('/ytd', PROCESS, async (req, res, next) => {
  try {
    const yearParam = req.query.year ? Number(req.query.year) : new Date().getUTCFullYear();
    if (!Number.isInteger(yearParam) || yearParam < 2000 || yearParam > 2100) {
      throw new HttpError(400, 'invalid_year', 'year must be a 4-digit integer');
    }
    const yearStart = new Date(Date.UTC(yearParam, 0, 1));
    const yearEndExclusive = new Date(Date.UTC(yearParam + 1, 0, 1));

    const items = await prisma.payrollItem.findMany({
      where: {
        status: { not: 'VOIDED' },
        payrollRun: {
          status: { not: 'CANCELLED' },
          disbursedAt: { gte: yearStart, lt: yearEndExclusive },
        },
      },
      select: {
        associateId: true,
        grossPay: true,
        federalWithholding: true,
        fica: true,
        medicare: true,
        stateWithholding: true,
        netPay: true,
        preTaxDeductions: true,
        postTaxDeductions: true,
        associate: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            employmentType: true,
          },
        },
      },
    });

    type Bucket = {
      associateId: string;
      firstName: string;
      lastName: string;
      email: string;
      employmentType: string;
      gross: number;
      fit: number;
      fica: number;
      medicare: number;
      sit: number;
      preTax: number;
      postTax: number;
      net: number;
      paystubCount: number;
    };
    const buckets = new Map<string, Bucket>();
    for (const it of items) {
      let b = buckets.get(it.associateId);
      if (!b) {
        b = {
          associateId: it.associateId,
          firstName: it.associate.firstName,
          lastName: it.associate.lastName,
          email: it.associate.email,
          employmentType: it.associate.employmentType,
          gross: 0,
          fit: 0,
          fica: 0,
          medicare: 0,
          sit: 0,
          preTax: 0,
          postTax: 0,
          net: 0,
          paystubCount: 0,
        };
        buckets.set(it.associateId, b);
      }
      b.gross += Number(it.grossPay);
      b.fit += Number(it.federalWithholding);
      b.fica += Number(it.fica);
      b.medicare += Number(it.medicare);
      b.sit += Number(it.stateWithholding);
      b.preTax += Number(it.preTaxDeductions);
      b.postTax += Number(it.postTaxDeductions);
      b.net += Number(it.netPay);
      b.paystubCount += 1;
    }

    const rows = [...buckets.values()]
      .map((b) => ({
        ...b,
        gross: round2(b.gross),
        fit: round2(b.fit),
        fica: round2(b.fica),
        medicare: round2(b.medicare),
        sit: round2(b.sit),
        preTax: round2(b.preTax),
        postTax: round2(b.postTax),
        net: round2(b.net),
      }))
      .sort((a, b) =>
        a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName),
      );

    const totals = rows.reduce(
      (acc, r) => {
        acc.gross += r.gross;
        acc.fit += r.fit;
        acc.fica += r.fica;
        acc.medicare += r.medicare;
        acc.sit += r.sit;
        acc.preTax += r.preTax;
        acc.postTax += r.postTax;
        acc.net += r.net;
        return acc;
      },
      { gross: 0, fit: 0, fica: 0, medicare: 0, sit: 0, preTax: 0, postTax: 0, net: 0 },
    );

    res.json({
      taxYear: yearParam,
      totals: {
        gross: round2(totals.gross),
        fit: round2(totals.fit),
        fica: round2(totals.fica),
        medicare: round2(totals.medicare),
        sit: round2(totals.sit),
        preTax: round2(totals.preTax),
        postTax: round2(totals.postTax),
        net: round2(totals.net),
        associateCount: rows.length,
        paystubCount: rows.reduce((s, r) => s + r.paystubCount, 0),
      },
      rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Branch webhook health summary. Reads from BranchWebhookEvent and the
 * configured PAYROLL_DISBURSEMENT_PROVIDER to give the operator a single
 * answer to "is the disbursement webhook still wired up?" The dashboard
 * tile polls this endpoint and turns red if the webhook has gone silent
 * while we still have FINALIZED-but-not-DISBURSED items waiting.
 */
payrollRouter.get('/disbursement/webhook-status', PROCESS, async (_req, res, next) => {
  try {
    const provider = env.PAYROLL_DISBURSEMENT_PROVIDER;

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [latest, last24h, errors24h, latestError, pendingFinalizedCount] =
      await Promise.all([
        prisma.branchWebhookEvent.findFirst({
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true, status: true, eventType: true },
        }),
        prisma.branchWebhookEvent.count({
          where: { receivedAt: { gte: dayAgo } },
        }),
        prisma.branchWebhookEvent.count({
          where: { status: 'ERROR', receivedAt: { gte: weekAgo } },
        }),
        prisma.branchWebhookEvent.findFirst({
          where: { status: 'ERROR' },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true, notes: true, eventType: true },
        }),
        prisma.payrollItem.count({
          where: {
            status: 'PENDING',
            payrollRun: { status: 'FINALIZED' },
          },
        }),
      ]);

    const lastEventAt = latest?.receivedAt ?? null;
    const minutesSinceLastEvent = lastEventAt
      ? Math.floor((Date.now() - lastEventAt.getTime()) / 60_000)
      : null;

    let health: 'healthy' | 'idle' | 'stale' | 'erroring' | 'unconfigured' | 'stub';
    let detail: string;
    if (provider === 'STUB') {
      health = 'stub';
      detail =
        'Disbursement provider is STUB. Runs marked "disbursed" are NOT actually paid out. Set PAYROLL_DISBURSEMENT_PROVIDER=BRANCH (or WISE) before processing real payroll.';
    } else if (provider !== 'BRANCH') {
      health = 'unconfigured';
      detail = `Disbursement provider is ${provider}, not BRANCH. Webhook health is N/A.`;
    } else if (errors24h > 0) {
      health = 'erroring';
      detail = `${errors24h} error event(s) in the last 7 days. Latest: ${latestError?.notes ?? 'unknown'}`;
    } else if (lastEventAt === null) {
      health = pendingFinalizedCount > 0 ? 'stale' : 'idle';
      detail = pendingFinalizedCount > 0
        ? 'No webhook events ever received, and there are pending disbursements. Branch may not be configured to call us.'
        : 'No webhook events received yet. Will populate after first disbursement.';
    } else if (minutesSinceLastEvent !== null && minutesSinceLastEvent > 60 * 24 && pendingFinalizedCount > 0) {
      health = 'stale';
      detail = `Last webhook ${minutesSinceLastEvent} minutes ago and ${pendingFinalizedCount} item(s) still awaiting disbursement.`;
    } else {
      health = 'healthy';
      detail = lastEventAt
        ? `Last event ${minutesSinceLastEvent} minute(s) ago.`
        : 'No events yet.';
    }

    res.json({
      provider,
      health,
      detail,
      lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
      minutesSinceLastEvent,
      eventsLast24h: last24h,
      errorsLast7d: errors24h,
      pendingFinalizedItems: pendingFinalizedCount,
      latestError: latestError
        ? {
            at: latestError.receivedAt.toISOString(),
            eventType: latestError.eventType,
            notes: latestError.notes,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});
