import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 91 — Garnishments + tax forms (941, 940, W-2, 1099-NEC).
 *
 * Garnishments are recurring deductions; the per-pay-run withholding
 * worker (separate cron) walks active garnishments and inserts
 * GarnishmentDeduction rows. Routes here manage the lifecycle.
 *
 * Tax forms are immutable once filed. The "filing" routes don't
 * actually transmit to the IRS — they just freeze the snapshot and
 * mark FILED. Real e-file integration is out of scope for this phase.
 */

export const payrollTax91Router = Router();

const VIEW = requireCapability('view:payroll');
const MANAGE = requireCapability('process:payroll');

// ----- Garnishments ------------------------------------------------------

const GarnishmentInputSchema = z
  .object({
    associateId: z.string().uuid(),
    kind: z.enum([
      'CHILD_SUPPORT',
      'TAX_LEVY',
      'STUDENT_LOAN',
      'BANKRUPTCY',
      'CREDITOR',
      'OTHER',
    ]),
    caseNumber: z.string().max(120).optional().nullable(),
    agencyName: z.string().max(200).optional().nullable(),
    amountPerRun: z.number().nonnegative().optional().nullable(),
    percentOfDisp: z.number().min(0).max(1).optional().nullable(),
    totalCap: z.number().nonnegative().optional().nullable(),
    remitTo: z.string().max(200).optional().nullable(),
    remitAddress: z.string().max(500).optional().nullable(),
    startDate: z.string(),
    endDate: z.string().optional().nullable(),
    priority: z.number().int().min(1).max(999).optional(),
    notes: z.string().max(4000).optional().nullable(),
  })
  .refine(
    (v) =>
      (v.amountPerRun != null && v.percentOfDisp == null) ||
      (v.amountPerRun == null && v.percentOfDisp != null),
    { message: 'Specify exactly one of amountPerRun or percentOfDisp.' },
  );

payrollTax91Router.get('/garnishments', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const status = z
    .enum(['ACTIVE', 'SUSPENDED', 'COMPLETED', 'TERMINATED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.garnishment.findMany({
    where: {
      deletedAt: null,
      ...(associateId ? { associateId } : {}),
      ...(status ? { status } : {}),
    },
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
      _count: { select: { deductions: true } },
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  });
  res.json({
    garnishments: rows.map((g) => ({
      id: g.id,
      associateId: g.associateId,
      associateName: `${g.associate.firstName} ${g.associate.lastName}`,
      kind: g.kind,
      caseNumber: g.caseNumber,
      agencyName: g.agencyName,
      amountPerRun: g.amountPerRun?.toString() ?? null,
      percentOfDisp: g.percentOfDisp?.toString() ?? null,
      totalCap: g.totalCap?.toString() ?? null,
      amountWithheld: g.amountWithheld.toString(),
      remitTo: g.remitTo,
      remitAddress: g.remitAddress,
      startDate: g.startDate.toISOString().slice(0, 10),
      endDate: g.endDate?.toISOString().slice(0, 10) ?? null,
      status: g.status,
      priority: g.priority,
      notes: g.notes,
      deductionCount: g._count.deductions,
      createdAt: g.createdAt.toISOString(),
    })),
  });
});

payrollTax91Router.post('/garnishments', MANAGE, async (req, res) => {
  const input = GarnishmentInputSchema.parse(req.body);
  const created = await prisma.garnishment.create({
    data: {
      associateId: input.associateId,
      kind: input.kind,
      caseNumber: input.caseNumber ?? null,
      agencyName: input.agencyName ?? null,
      amountPerRun: input.amountPerRun ?? null,
      percentOfDisp: input.percentOfDisp ?? null,
      totalCap: input.totalCap ?? null,
      remitTo: input.remitTo ?? null,
      remitAddress: input.remitAddress ?? null,
      startDate: new Date(input.startDate),
      endDate: input.endDate ? new Date(input.endDate) : null,
      priority: input.priority ?? 100,
      notes: input.notes ?? null,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

payrollTax91Router.post('/garnishments/:id/status', MANAGE, async (req, res) => {
  const status = z
    .enum(['ACTIVE', 'SUSPENDED', 'COMPLETED', 'TERMINATED'])
    .parse(req.body?.status);
  await prisma.garnishment.update({
    where: { id: req.params.id },
    data: { status },
  });
  res.json({ ok: true });
});

payrollTax91Router.post('/garnishments/:id/deduct', MANAGE, async (req, res) => {
  const input = z
    .object({
      payrollRunId: z.string().uuid().optional().nullable(),
      amount: z.number().positive(),
    })
    .parse(req.body);
  const g = await prisma.garnishment.findUnique({
    where: { id: req.params.id },
  });
  if (!g || g.deletedAt) throw new HttpError(404, 'not_found', 'Garnishment not found.');
  if (g.status !== 'ACTIVE') {
    throw new HttpError(409, 'invalid_state', `Garnishment is ${g.status}.`);
  }

  const result = await prisma.$transaction(async (tx) => {
    const ded = await tx.garnishmentDeduction.create({
      data: {
        garnishmentId: g.id,
        payrollRunId: input.payrollRunId ?? null,
        amount: input.amount,
      },
    });
    const newWithheld = g.amountWithheld.plus(input.amount);
    const reachedCap = g.totalCap != null && newWithheld.gte(g.totalCap);
    await tx.garnishment.update({
      where: { id: g.id },
      data: {
        amountWithheld: newWithheld,
        ...(reachedCap ? { status: 'COMPLETED' } : {}),
      },
    });
    return { id: ded.id, completed: reachedCap };
  });
  res.status(201).json(result);
});

payrollTax91Router.get('/garnishments/:id/deductions', VIEW, async (req, res) => {
  const rows = await prisma.garnishmentDeduction.findMany({
    where: { garnishmentId: req.params.id },
    orderBy: { deductedOn: 'desc' },
    take: 500,
  });
  res.json({
    deductions: rows.map((d) => ({
      id: d.id,
      payrollRunId: d.payrollRunId,
      amount: d.amount.toString(),
      deductedOn: d.deductedOn.toISOString(),
    })),
  });
});

// ----- Tax forms ---------------------------------------------------------

const TaxFormInputSchema = z.object({
  kind: z.enum(['F941', 'F940', 'W2', 'F1099_NEC']),
  taxYear: z.number().int().min(2000).max(2100),
  quarter: z.number().int().min(1).max(4).optional().nullable(),
  associateId: z.string().uuid().optional().nullable(),
  amounts: z.record(z.string(), z.unknown()),
  ein: z.string().max(20).optional().nullable(),
});

payrollTax91Router.get('/tax-forms', VIEW, async (req, res) => {
  const kind = z
    .enum(['F941', 'F940', 'W2', 'F1099_NEC'])
    .optional()
    .parse(req.query.kind);
  const taxYear = z
    .preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional())
    .parse(req.query.taxYear);
  const status = z
    .enum(['DRAFT', 'FILED', 'AMENDED', 'VOIDED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.taxForm.findMany({
    where: {
      ...(kind ? { kind } : {}),
      ...(taxYear ? { taxYear } : {}),
      ...(status ? { status } : {}),
    },
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: [{ taxYear: 'desc' }, { quarter: 'desc' }],
    take: 500,
  });
  res.json({
    forms: rows.map((f) => ({
      id: f.id,
      kind: f.kind,
      taxYear: f.taxYear,
      quarter: f.quarter,
      associateId: f.associateId,
      associateName: f.associate
        ? `${f.associate.firstName} ${f.associate.lastName}`
        : null,
      amounts: f.amounts,
      status: f.status,
      filedAt: f.filedAt?.toISOString() ?? null,
      ein: f.ein,
      createdAt: f.createdAt.toISOString(),
    })),
  });
});

payrollTax91Router.post('/tax-forms', MANAGE, async (req, res) => {
  const input = TaxFormInputSchema.parse(req.body);

  // Cross-field validation matches the DB CHECK constraint.
  if (input.kind === 'F941' && input.quarter == null) {
    throw new HttpError(400, 'quarter_required', '941 requires a quarter.');
  }
  if (input.kind !== 'F941' && input.quarter != null) {
    throw new HttpError(400, 'quarter_invalid', 'Only 941 has a quarter.');
  }
  if ((input.kind === 'W2' || input.kind === 'F1099_NEC') && !input.associateId) {
    throw new HttpError(
      400,
      'associate_required',
      'W-2 / 1099-NEC require an associateId.',
    );
  }
  if (
    (input.kind === 'F941' || input.kind === 'F940') &&
    input.associateId
  ) {
    throw new HttpError(
      400,
      'associate_invalid',
      '941 / 940 are aggregate forms; do not set associateId.',
    );
  }

  const created = await prisma.taxForm.create({
    data: {
      kind: input.kind,
      taxYear: input.taxYear,
      quarter: input.quarter ?? null,
      associateId: input.associateId ?? null,
      amounts: input.amounts as Prisma.InputJsonValue,
      ein: input.ein ?? null,
      status: 'DRAFT',
    },
  });
  res.status(201).json({ id: created.id });
});

payrollTax91Router.post('/tax-forms/:id/file', MANAGE, async (req, res) => {
  const f = await prisma.taxForm.findUnique({ where: { id: req.params.id } });
  if (!f) throw new HttpError(404, 'not_found', 'Form not found.');
  if (f.status !== 'DRAFT' && f.status !== 'AMENDED') {
    throw new HttpError(409, 'invalid_state', `Cannot file ${f.status} form.`);
  }
  try {
    await prisma.taxForm.update({
      where: { id: f.id },
      data: {
        status: 'FILED',
        filedAt: new Date(),
        filedById: req.user!.id,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(
        409,
        'duplicate_filing',
        'A form for this kind/year/quarter/associate is already filed. Amend instead.',
      );
    }
    throw err;
  }
  res.json({ ok: true });
});

payrollTax91Router.post('/tax-forms/:id/void', MANAGE, async (req, res) => {
  await prisma.taxForm.update({
    where: { id: req.params.id },
    data: { status: 'VOIDED' },
  });
  res.json({ ok: true });
});

/**
 * Aggregate "build" helper for 941: pulls the YTD payroll figures for
 * the given quarter so HR doesn't have to type them in. Returns a
 * suggested amounts object — caller can review, edit, then POST.
 */
payrollTax91Router.get('/tax-forms/build/941', VIEW, async (req, res) => {
  const taxYear = z
    .preprocess((v) => Number(v), z.number().int().min(2000).max(2100))
    .parse(req.query.taxYear);
  const quarter = z
    .preprocess((v) => Number(v), z.number().int().min(1).max(4))
    .parse(req.query.quarter);

  const startMonth = (quarter - 1) * 3;
  const periodStart = new Date(Date.UTC(taxYear, startMonth, 1));
  const periodEnd = new Date(Date.UTC(taxYear, startMonth + 3, 0));

  const runs = await prisma.payrollRun.findMany({
    take: 100,
    where: {
      periodStart: { gte: periodStart, lte: periodEnd },
      status: { in: ['FINALIZED', 'DISBURSED'] },
    },
    select: {
      totalGross: true,
      totalTax: true,
      totalEmployerTax: true,
      items: { select: { id: true } },
    },
  });

  const totalWages = runs.reduce(
    (sum, r) => sum + Number(r.totalGross),
    0,
  );
  const totalFedWithheld = runs.reduce(
    (sum, r) => sum + Number(r.totalTax),
    0,
  );
  const totalEmployerTax = runs.reduce(
    (sum, r) => sum + Number(r.totalEmployerTax),
    0,
  );
  const employeeCount = new Set(runs.flatMap((r) => r.items.map((i) => i.id)))
    .size;

  res.json({
    suggestedAmounts: {
      employeeCount,
      totalWages: totalWages.toFixed(2),
      totalFederalWithheld: totalFedWithheld.toFixed(2),
      totalEmployerTax: totalEmployerTax.toFixed(2),
      // 7.65% combined (FICA 6.2 + Medicare 1.45) — illustrative only.
      ficaMedicareWages: totalWages.toFixed(2),
    },
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: periodEnd.toISOString().slice(0, 10),
  });
});
