import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  PayrollExceptionsInputSchema,
  PayrollExceptionsResponseSchema,
  PayrollItemListResponseSchema,
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
import { aggregatePayrollProjection } from '../lib/payrollAggregator.js';
import { computePayrollExceptions } from '../lib/payrollExceptions.js';
import { hashPdf, renderPaystubPdf, type PaystubData } from '../lib/paystub.js';
import { pickAdapter, type DisbursementInput } from '../lib/disbursement.js';
import { decryptString } from '../lib/crypto.js';
import type { PayoutMethod } from '@prisma/client';
import { enqueueAudit, recordPayrollEvent } from '../lib/audit.js';
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

    for (const s of schedules) {
      const cur = getCurrentPeriod(
        {
          frequency: s.frequency,
          anchorDate: s.anchorDate,
          payDateOffsetDays: s.payDateOffsetDays,
        },
        today
      );
      // If the current period has been run already, skip to next. Cheap
      // check: any DRAFT-or-later run for this client + period.
      const periodStartDate = new Date(`${cur.periodStart}T00:00:00.000Z`);
      const existingRun = await prisma.payrollRun.findFirst({
        where: {
          ...(s.clientId ? { clientId: s.clientId } : {}),
          periodStart: periodStartDate,
        },
        select: { id: true },
      });
      const w = existingRun
        ? getNextPeriod(
            {
              frequency: s.frequency,
              anchorDate: s.anchorDate,
              payDateOffsetDays: s.payDateOffsetDays,
            },
            today
          )
        : cur;

      if (
        !chosenSchedule ||
        !chosenWindow ||
        w.periodEnd < chosenWindow.periodEnd
      ) {
        chosenSchedule = s;
        chosenWindow = w;
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
            netPay: p.netPay,
            status: 'PENDING',
          },
          update: {
            hoursWorked: p.hoursWorked,
            hourlyRate: p.hourlyRate,
            grossPay: p.grossPay,
            preTaxDeductions: p.preTaxDeductions,
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
            netPay: p.netPay,
          },
        });

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
      }

      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          totalGross: projection.totals.totalGross,
          totalTax: projection.totals.totalEmployeeTax,
          totalNet: projection.totals.totalNet,
          totalEmployerTax: projection.totals.totalEmployerTax,
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
