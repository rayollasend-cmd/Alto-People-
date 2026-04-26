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
  computeFederalWithholding,
  computeNet,
  pickHourlyRate,
  round2,
  sumApprovedHours,
} from '../lib/payroll.js';
import { recordPayrollEvent } from '../lib/audit.js';

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
    itemCount: r.items.length,
    notes: r.notes,
    finalizedAt: r.finalizedAt ? r.finalizedAt.toISOString() : null,
    disbursedAt: r.disbursedAt ? r.disbursedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
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
            select: { id: true, w4Submission: { select: { filingStatus: true, extraWithholding: true } } },
          },
        },
      });

      const byAssociate = new Map<string, typeof entries>();
      for (const e of entries) {
        const arr = byAssociate.get(e.associateId) ?? [];
        arr.push(e);
        byAssociate.set(e.associateId, arr);
      }

      let totalGross = 0;
      let totalTax = 0;
      let totalNet = 0;

      for (const [associateId, group] of byAssociate) {
        const hoursWorked = sumApprovedHours(group);
        if (hoursWorked === 0) continue;

        // Pull recent shifts for this associate in the period to pick a rate.
        const shifts = await tx.shift.findMany({
          where: {
            assignedAssociateId: associateId,
            startsAt: { gte: periodStart, lt: periodEndExclusive },
          },
          select: { hourlyRate: true },
        });
        const hourlyRate = pickHourlyRate(shifts, defaultRate);
        const grossPay = round2(hoursWorked * hourlyRate);

        const w4 = group[0].associate.w4Submission;
        const federalWithholding = computeFederalWithholding({
          grossPay,
          filingStatus: w4?.filingStatus ?? null,
          extraWithholding: w4?.extraWithholding ? Number(w4.extraWithholding) : 0,
        });
        const netPay = computeNet(grossPay, federalWithholding);

        await tx.payrollItem.upsert({
          where: { payrollRunId_associateId: { payrollRunId: run.id, associateId } },
          create: {
            payrollRunId: run.id,
            associateId,
            hoursWorked,
            hourlyRate,
            grossPay,
            federalWithholding,
            netPay,
            status: 'PENDING',
          },
          update: {
            hoursWorked,
            hourlyRate,
            grossPay,
            federalWithholding,
            netPay,
          },
        });

        totalGross += grossPay;
        totalTax += federalWithholding;
        totalNet += netPay;
      }

      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          totalGross: round2(totalGross),
          totalTax: round2(totalTax),
          totalNet: round2(totalNet),
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
 * Disbursement is STUBBED. In production this calls Wise/Branch per item;
 * here we just flip every PENDING item to DISBURSED with a synthetic ref
 * and mark the run DISBURSED. The route is wired so the UI flow works
 * end-to-end; swapping the body for real provider calls is a future PR.
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

    const updated = await prisma.$transaction(async (tx) => {
      const items = await tx.payrollItem.findMany({
        where: { payrollRunId: run.id, status: 'PENDING' },
      });
      const now = new Date();
      for (const item of items) {
        await tx.payrollItem.update({
          where: { id: item.id },
          data: {
            status: 'DISBURSED',
            disbursementRef: `STUB-${item.id.slice(0, 8)}`,
            disbursedAt: now,
          },
        });
      }
      return tx.payrollRun.update({
        where: { id: run.id },
        data: { status: 'DISBURSED', disbursedAt: now },
        include: RUN_INCLUDE,
      });
    }, TX_OPTS);

    await recordPayrollEvent({
      actorUserId: req.user!.id,
      action: 'payroll.run_disbursed',
      payrollRunId: updated.id,
      clientId: updated.clientId,
      metadata: { items: updated.items.length, stub: true },
      req,
    });

    res.json(toDetail(updated));
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
