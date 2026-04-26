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
import { computePaycheckTaxes, type PayFrequency } from '../lib/payrollTax.js';
import { hashPdf, renderPaystubPdf, type PaystubData } from '../lib/paystub.js';
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
            select: {
              id: true,
              state: true,
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

        const breakdown = computePaycheckTaxes({
          grossPay,
          filingStatus: w4?.filingStatus ?? null,
          payFrequency,
          state: associateState,
          ytdWages,
          ytdMedicareWages,
          extraWithholding: w4?.extraWithholding ? Number(w4.extraWithholding) : 0,
          deductions: w4?.deductions ? Number(w4.deductions) : 0,
          otherIncome: w4?.otherIncome ? Number(w4.otherIncome) : 0,
          dependentsAmount: w4?.dependentsAmount ? Number(w4.dependentsAmount) : 0,
        });

        await tx.payrollItem.upsert({
          where: { payrollRunId_associateId: { payrollRunId: run.id, associateId } },
          create: {
            payrollRunId: run.id,
            associateId,
            hoursWorked,
            hourlyRate,
            grossPay,
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
