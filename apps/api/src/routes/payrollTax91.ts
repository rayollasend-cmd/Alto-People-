import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { decryptString } from '../lib/crypto.js';
import {
  aggregateW2Wages,
  listW2EligibleAssociates,
  type W2Boxes,
} from '../lib/w2Aggregator.js';
import { hashW2Pdf, renderW2Pdf, type W2PdfData } from '../lib/w2Pdf.js';
import { hashW2cPdf, renderW2cPdf, type W2cPdfData } from '../lib/w2cPdf.js';
import { hasW2cDelta, type W2cAmounts } from '../lib/w2cAggregator.js';
import { buildEfw2File, type Efw2Employee, type Efw2File } from '../lib/efw2.js';
import { buildEfw2cFile, type Efw2cEmployee, type Efw2cFile } from '../lib/efw2c.js';
import {
  aggregateF1099NecPayments,
  listF1099NecEligibleAssociates,
  type Form1099NecBoxes,
} from '../lib/f1099NecAggregator.js';
import {
  hashForm1099NecPdf,
  renderForm1099NecPdf,
  type Form1099NecPdfData,
} from '../lib/f1099NecPdf.js';
import { buildIrsFireFile, type IrsFireFile, type IrsFirePayee } from '../lib/irsFire.js';

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

// ----- W-2 generation (Gap 1) --------------------------------------------

const GenerateW2BodySchema = z.object({
  taxYear: z.number().int().min(2000).max(2100),
  // Null / omitted = generate W-2s for every client. Specific UUID = scope
  // to one client (the typical case from the admin UI's per-client view).
  clientId: z.string().uuid().nullable().optional(),
});

/**
 * POST /tax-forms/w2/generate { taxYear, clientId? } — for every associate
 * with at least one disbursed paystub in the year, run the aggregator and
 * persist a TaxForm(kind=W2, status=DRAFT) row carrying the box totals.
 *
 * Idempotent at the per-associate level: if a non-VOIDED W-2 already
 * exists for {associate, year}, it is skipped (re-runs are safe). The
 * caller can void an existing form first to force regeneration.
 */
payrollTax91Router.post('/tax-forms/w2/generate', MANAGE, async (req, res) => {
  const input = GenerateW2BodySchema.parse(req.body ?? {});
  const associateIds = await listW2EligibleAssociates(
    prisma,
    input.taxYear,
    input.clientId ?? null,
  );

  let createdCount = 0;
  let skippedCount = 0;
  const created: { id: string; associateId: string }[] = [];

  for (const associateId of associateIds) {
    const existing = await prisma.taxForm.findFirst({
      where: {
        kind: 'W2',
        taxYear: input.taxYear,
        associateId,
        status: { not: 'VOIDED' },
      },
      select: { id: true },
    });
    if (existing) {
      skippedCount += 1;
      continue;
    }

    const boxes = await aggregateW2Wages(prisma, associateId, input.taxYear);

    const row = await prisma.taxForm.create({
      data: {
        kind: 'W2',
        taxYear: input.taxYear,
        associateId,
        amounts: boxes as unknown as Prisma.InputJsonValue,
        status: 'DRAFT',
      },
    });
    created.push({ id: row.id, associateId });
    createdCount += 1;
  }

  res.json({
    eligibleAssociateCount: associateIds.length,
    createdCount,
    skippedCount,
    created,
  });
});

// ----- 1099-NEC generation (Gap 11) --------------------------------------

const GenerateF1099NecBodySchema = z.object({
  taxYear: z.number().int().min(2020).max(2100),
  // Null / omitted = generate 1099-NECs for every client. Specific UUID =
  // scope to one client.
  clientId: z.string().uuid().nullable().optional(),
});

/**
 * POST /tax-forms/1099-nec/generate { taxYear, clientId? } — for every
 * contractor associate that meets the IRS reporting threshold (Box 1
 * >= $600 OR Box 4 > 0), run the aggregator and persist a TaxForm
 * (kind=F1099_NEC, status=DRAFT) row. Mirrors the W-2 generate route
 * exactly except the eligibility filter — see f1099NecAggregator.
 *
 * Idempotent at the per-associate level: if a non-VOIDED 1099-NEC
 * already exists for {associate, year}, it's skipped (re-runs are
 * safe). The caller can void an existing form first to force
 * regeneration.
 */
payrollTax91Router.post('/tax-forms/1099-nec/generate', MANAGE, async (req, res) => {
  const input = GenerateF1099NecBodySchema.parse(req.body ?? {});
  const associateIds = await listF1099NecEligibleAssociates(
    prisma,
    input.taxYear,
    input.clientId ?? null,
  );

  let createdCount = 0;
  let skippedCount = 0;
  const created: { id: string; associateId: string }[] = [];

  for (const associateId of associateIds) {
    const existing = await prisma.taxForm.findFirst({
      where: {
        kind: 'F1099_NEC',
        taxYear: input.taxYear,
        associateId,
        status: { not: 'VOIDED' },
      },
      select: { id: true },
    });
    if (existing) {
      skippedCount += 1;
      continue;
    }

    const boxes = await aggregateF1099NecPayments(prisma, associateId, input.taxYear);

    const row = await prisma.taxForm.create({
      data: {
        kind: 'F1099_NEC',
        taxYear: input.taxYear,
        associateId,
        amounts: boxes as unknown as Prisma.InputJsonValue,
        status: 'DRAFT',
      },
    });
    created.push({ id: row.id, associateId });
    createdCount += 1;
  }

  res.json({
    eligibleAssociateCount: associateIds.length,
    createdCount,
    skippedCount,
    created,
  });
});

// ----- W-2c (corrections) ------------------------------------------------

const W2cBodySchema = z
  .object({
    originalW2FormId: z.string().uuid(),
    /**
     * Reason is required and surfaced on the W-2c PDF so the recipient
     * knows why their W-2 changed (e.g. "Bonus paid in Q4 was missed
     * from the original filing").
     */
    correctionReason: z.string().trim().min(1).max(500),
    /**
     * Optional explicit corrected box values. When omitted the route
     * recomputes from current PayrollItems via aggregateW2Wages —
     * the typical case after an AMENDMENT run posts to a year that's
     * already been W-2'd. When supplied, the caller is expressing a
     * manual override (e.g. spotted a data-entry mistake).
     */
    correctedBoxes: z
      .object({
        box1Wages: z.number(),
        box2FitWithheld: z.number(),
        box3SsWages: z.number(),
        box4SsTax: z.number(),
        box5MedicareWages: z.number(),
        box6MedicareTax: z.number(),
        stateLines: z.array(
          z.object({
            state: z.string().length(2),
            stateWages: z.number(),
            stateIncomeTax: z.number(),
          }),
        ),
      })
      .optional(),
  })
  .strict();

/**
 * POST /tax-forms/w2c — creates a W-2c TaxForm correcting an existing
 * W-2. The original must be FILED or AMENDED (you don't W-2c a DRAFT —
 * just edit and re-generate). On success the original flips to AMENDED
 * (it stays in the table; the IRS keeps it as the historical record)
 * and the new W2C row is returned.
 *
 * Idempotency: if `correctedBoxes` is omitted and the recomputed totals
 * match the original exactly, returns 409 — no point creating a no-op
 * correction.
 */
payrollTax91Router.post('/tax-forms/w2c', MANAGE, async (req, res) => {
  const input = W2cBodySchema.parse(req.body);

  const original = await prisma.taxForm.findUnique({
    where: { id: input.originalW2FormId },
  });
  if (!original) throw new HttpError(404, 'not_found', 'Original W-2 not found.');
  if (original.kind !== 'W2') {
    throw new HttpError(
      400,
      'invalid_kind',
      `Cannot W-2c a ${original.kind} form. Only kind=W2 supports correction.`,
    );
  }
  if (!original.associateId) {
    throw new HttpError(500, 'malformed_form', 'Original W-2 has no associate.');
  }
  if (original.status !== 'FILED' && original.status !== 'AMENDED') {
    throw new HttpError(
      409,
      'invalid_state',
      `Cannot correct a ${original.status} W-2. File the original first, or edit it directly while it's still DRAFT.`,
    );
  }

  // Resolve corrected boxes — caller-supplied or recomputed from current
  // PayrollItems (the AMENDMENT-run case).
  const corrected: W2Boxes = input.correctedBoxes
    ? { ...input.correctedBoxes, sourceItemCount: 0 }
    : await aggregateW2Wages(prisma, original.associateId, original.taxYear);

  const previous = original.amounts as unknown as W2Boxes;
  if (!hasW2cDelta(previous, corrected)) {
    throw new HttpError(
      409,
      'no_delta',
      'Corrected totals match the original. Nothing to amend.',
    );
  }

  const w2cAmounts = {
    previous,
    corrected,
    correctionReason: input.correctionReason,
  };

  const w2c = await prisma.$transaction(async (tx) => {
    const created = await tx.taxForm.create({
      data: {
        kind: 'W2C',
        taxYear: original.taxYear,
        associateId: original.associateId,
        amounts: w2cAmounts as unknown as Prisma.InputJsonValue,
        status: 'DRAFT',
        amendsTaxFormId: original.id,
      },
    });
    // Flip the original to AMENDED so the active-list filter
    // (status: { not: 'AMENDED' }) hides it. The IRS still has the
    // FILED bytes; our UI just stops surfacing it as the live record.
    if (original.status !== 'AMENDED') {
      await tx.taxForm.update({
        where: { id: original.id },
        data: { status: 'AMENDED' },
      });
    }
    return created;
  });

  res.status(201).json({
    id: w2c.id,
    amendsTaxFormId: original.id,
    delta: {
      box1: corrected.box1Wages - previous.box1Wages,
      box2: corrected.box2FitWithheld - previous.box2FitWithheld,
      box3: corrected.box3SsWages - previous.box3SsWages,
      box4: corrected.box4SsTax - previous.box4SsTax,
      box5: corrected.box5MedicareWages - previous.box5MedicareWages,
      box6: corrected.box6MedicareTax - previous.box6MedicareTax,
    },
  });
});

// Shared helper — pulls the form + associate + W-4, looks up an employer
// block from the associate's first disbursed run in the year, and renders
// the W-2 (or W-2c) PDF. Used by single-PDF and bulk-zip routes. Throws
// HttpError on missing inputs so the caller's catch block produces a clean
// HTTP response. The pdfHash stamp lives at the call site so the bulk
// route can opt into a single batched update.
async function renderW2ForForm(formId: string): Promise<{
  pdf: Buffer;
  hash: string;
  form: NonNullable<Awaited<ReturnType<typeof loadW2Form>>>;
  filename: string;
}> {
  const form = await loadW2Form(formId);
  if (!form) throw new HttpError(404, 'not_found', 'Form not found.');
  if (form.kind !== 'W2' && form.kind !== 'W2C') {
    throw new HttpError(
      400,
      'unsupported_kind',
      `PDF rendering is only supported for W-2 / W-2c today. ${form.kind} renderers land in a follow-up.`,
    );
  }
  if (!form.associateId || !form.associate) {
    throw new HttpError(500, 'malformed_form', 'W-2 has no associate row.');
  }
  if (!form.associate.w4Submission?.ssnEncrypted) {
    throw new HttpError(
      400,
      'missing_ssn',
      'Cannot render W-2: associate has no SSN on file (W-4 not yet completed).',
    );
  }

  const yearStart = new Date(Date.UTC(form.taxYear, 0, 1));
  const yearEndExclusive = new Date(Date.UTC(form.taxYear + 1, 0, 1));
  const sampleItem = await prisma.payrollItem.findFirst({
    where: {
      associateId: form.associateId,
      payrollRun: {
        status: { not: 'CANCELLED' },
        disbursedAt: { gte: yearStart, lt: yearEndExclusive },
      },
    },
    include: { payrollRun: { include: { client: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const client = sampleItem?.payrollRun.client ?? null;
  if (!client?.legalName || !client.ein) {
    throw new HttpError(
      400,
      'missing_employer_info',
      'Cannot render W-2: client is missing legalName or EIN. HR must fill these in on the client record before generating tax forms.',
    );
  }

  const ssn = decryptString(form.associate.w4Submission.ssnEncrypted);
  const ssnFormatted =
    ssn.length === 9
      ? `${ssn.slice(0, 3)}-${ssn.slice(3, 5)}-${ssn.slice(5)}`
      : ssn;

  if (form.kind === 'W2C') {
    const amounts = form.amounts as unknown as W2cAmounts;
    const pdfData: W2cPdfData = {
      taxYear: form.taxYear,
      employer: {
        ein: client.ein,
        name: client.legalName,
        addressLine1: client.addressLine1,
        addressLine2: client.addressLine2,
        city: client.city,
        state: client.state,
        zip: client.zip,
      },
      employee: {
        ssn: ssnFormatted,
        firstName: form.associate.firstName,
        lastName: form.associate.lastName,
        addressLine1: form.associate.addressLine1,
        addressLine2: form.associate.addressLine2,
        city: form.associate.city,
        state: form.associate.state,
        zip: form.associate.zip,
      },
      // The control number on a W-2c carries over from the original W-2
      // so the IRS can match the correction back to the prior submission.
      // We store the original form id on amendsTaxFormId.
      controlNumber: (form.amendsTaxFormId ?? form.id).slice(0, 8).toUpperCase(),
      amounts,
      // Reason is stored alongside amounts for the W-2c. Loose typing
      // because the JSON column can carry it; route validation set it.
      correctionReason:
        ((form.amounts as unknown as { correctionReason?: string | null })
          .correctionReason ?? null),
      meta: {
        formId: form.id,
        originalFormId: form.amendsTaxFormId ?? form.id,
        generatedAt: new Date().toISOString(),
      },
    };
    const pdf = await renderW2cPdf(pdfData);
    const hash = hashW2cPdf(pdf);
    const filename =
      `W2c-${form.taxYear}-${form.associate.lastName}-${form.associate.firstName}.pdf`
        .toLowerCase()
        .replace(/[^\x20-\x7e]/g, '');
    return { pdf, hash, form, filename };
  }

  const pdfData: W2PdfData = {
    taxYear: form.taxYear,
    employer: {
      ein: client.ein,
      name: client.legalName,
      addressLine1: client.addressLine1,
      addressLine2: client.addressLine2,
      city: client.city,
      state: client.state,
      zip: client.zip,
    },
    employee: {
      ssn: ssnFormatted,
      firstName: form.associate.firstName,
      lastName: form.associate.lastName,
      addressLine1: form.associate.addressLine1,
      addressLine2: form.associate.addressLine2,
      city: form.associate.city,
      state: form.associate.state,
      zip: form.associate.zip,
    },
    controlNumber: form.id.slice(0, 8).toUpperCase(),
    boxes: form.amounts as unknown as W2PdfData['boxes'],
    meta: { formId: form.id, generatedAt: new Date().toISOString() },
  };

  const pdf = await renderW2Pdf(pdfData);
  const hash = hashW2Pdf(pdf);
  const filename =
    `W2-${form.taxYear}-${form.associate.lastName}-${form.associate.firstName}.pdf`
      .toLowerCase()
      .replace(/[^\x20-\x7e]/g, '');
  return { pdf, hash, form, filename };
}

async function loadW2Form(formId: string) {
  // Loads the form + the bits needed for either W-2 or 1099-NEC rendering:
  // W-4 SSN (W-2 path) and the Associate.tinEncrypted column (1099 path).
  // Routes pick the right field per form.kind.
  return prisma.taxForm.findUnique({
    where: { id: formId },
    include: {
      associate: {
        include: { w4Submission: { select: { ssnEncrypted: true } } },
      },
    },
  });
}

/**
 * Renders Form 1099-NEC for one TaxForm row. Mirrors renderW2ForForm but
 * pulls the recipient TIN from Associate.tinEncrypted (W-2 SSN lives on
 * W4Submission and isn't appropriate for contractors). Surfaces missing
 * inputs as 400s the same way as the W-2 path so the client gets a clean
 * actionable error.
 */
async function renderF1099NecForForm(formId: string): Promise<{
  pdf: Buffer;
  hash: string;
  form: NonNullable<Awaited<ReturnType<typeof loadW2Form>>>;
  filename: string;
}> {
  const form = await loadW2Form(formId);
  if (!form) throw new HttpError(404, 'not_found', 'Form not found.');
  if (form.kind !== 'F1099_NEC') {
    throw new HttpError(
      500,
      'wrong_helper',
      `renderF1099NecForForm called on a ${form.kind} form.`,
    );
  }
  if (!form.associateId || !form.associate) {
    throw new HttpError(500, 'malformed_form', '1099-NEC has no associate row.');
  }
  if (!form.associate.tinEncrypted) {
    throw new HttpError(
      400,
      'missing_tin',
      'Cannot render 1099-NEC: contractor has no TIN on file. HR must capture the W-9 before generating tax forms.',
    );
  }

  // Pull payer (client) info from a sample disbursed item, same trick as
  // the W-2 path. Contractors might invoice multiple clients; we pick the
  // one tied to the chronologically-first disbursed item in the year.
  const yearStart = new Date(Date.UTC(form.taxYear, 0, 1));
  const yearEndExclusive = new Date(Date.UTC(form.taxYear + 1, 0, 1));
  const sampleItem = await prisma.payrollItem.findFirst({
    where: {
      associateId: form.associateId,
      payrollRun: {
        status: { not: 'CANCELLED' },
        disbursedAt: { gte: yearStart, lt: yearEndExclusive },
      },
    },
    include: { payrollRun: { include: { client: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const client = sampleItem?.payrollRun.client ?? null;
  if (!client?.legalName || !client.ein) {
    throw new HttpError(
      400,
      'missing_payer_info',
      'Cannot render 1099-NEC: client is missing legalName or EIN. HR must fill these in on the client record before generating tax forms.',
    );
  }

  const tin = decryptString(form.associate.tinEncrypted);
  // Format: SSN as XXX-XX-XXXX for individuals; EIN as XX-XXXXXXX for
  // businesses. Both are 9 digits, so we use employmentType to decide.
  const tinFormatted =
    tin.length === 9
      ? form.associate.employmentType === 'CONTRACTOR_1099_BUSINESS'
        ? `${tin.slice(0, 2)}-${tin.slice(2)}`
        : `${tin.slice(0, 3)}-${tin.slice(3, 5)}-${tin.slice(5)}`
      : tin;

  const pdfData: Form1099NecPdfData = {
    taxYear: form.taxYear,
    payer: {
      ein: client.ein,
      name: client.legalName,
      addressLine1: client.addressLine1,
      addressLine2: client.addressLine2,
      city: client.city,
      state: client.state,
      zip: client.zip,
    },
    recipient: {
      tin: tinFormatted,
      name: `${form.associate.firstName} ${form.associate.lastName}`.trim(),
      addressLine1: form.associate.addressLine1,
      addressLine2: form.associate.addressLine2,
      city: form.associate.city,
      state: form.associate.state,
      zip: form.associate.zip,
    },
    accountNumber: form.id.slice(0, 12).toUpperCase(),
    boxes: form.amounts as unknown as Form1099NecBoxes,
    meta: { formId: form.id, generatedAt: new Date().toISOString() },
  };

  const pdf = await renderForm1099NecPdf(pdfData);
  const hash = hashForm1099NecPdf(pdf);
  const filename =
    `1099NEC-${form.taxYear}-${form.associate.lastName}-${form.associate.firstName}.pdf`
      .toLowerCase()
      .replace(/[^\x20-\x7e]/g, '');
  return { pdf, hash, form, filename };
}

/**
 * GET /tax-forms/:id/pdf — renders the PDF for a TaxForm. Dispatches on
 * form.kind:
 *   - W2 / W2C       → renderW2ForForm
 *   - F1099_NEC      → renderF1099NecForForm
 *   - else           → 400 unsupported_kind
 * Stamps `pdfHash` on first download (matching the paystub immutability
 * contract). Same hash semantics across kinds; the per-helper hash
 * function returns sha256 of the rendered bytes.
 *
 * Scope: associates may download their own form; HR/Finance/Manager can
 * download any. Mirrors /payroll/items/:itemId/paystub.pdf scoping.
 */
payrollTax91Router.get('/tax-forms/:id/pdf', async (req, res, next) => {
  try {
    const form = await loadW2Form(req.params.id);
    if (!form) throw new HttpError(404, 'not_found', 'Form not found.');

    const user = req.user!;
    const isOwner = user.associateId && user.associateId === form.associateId;
    const canManage = [
      'HR_ADMINISTRATOR',
      'OPERATIONS_MANAGER',
      'FINANCE_ACCOUNTANT',
      'EXECUTIVE_CHAIRMAN',
    ].includes(user.role);
    if (!isOwner && !canManage) {
      throw new HttpError(404, 'not_found', 'Form not found.');
    }

    const { pdf, hash, filename } =
      form.kind === 'F1099_NEC'
        ? await renderF1099NecForForm(req.params.id)
        : await renderW2ForForm(req.params.id);

    if (!form.pdfHash) {
      await prisma.taxForm.update({
        where: { id: form.id },
        data: { pdfHash: hash },
      });
    } else if (form.pdfHash !== hash) {
      // Layout change between renders. Surface in logs but still serve
      // the bytes — finance shouldn't be blocked by a font swap or PDF
      // engine update. Hash mismatch is observable via the audit log.
      // eslint-disable-next-line no-console
      console.warn(
        `[w2] pdfHash mismatch for TaxForm ${form.id}: stored ${form.pdfHash}, current ${hash}`,
      );
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /tax-forms/w2/bulk.zip?taxYear=YYYY&clientId=UUID — streams a zip of
 * every non-VOIDED W-2 PDF for the year (and optional client scope). Skips
 * forms that fail to render (missing SSN / employer info) and surfaces the
 * skip count in a manifest.txt at the root of the zip so finance can spot
 * gaps.
 *
 * Capability: process:payroll. Associates can't bulk-download (they only
 * see their own via the per-form route).
 */
payrollTax91Router.get('/tax-forms/w2/bulk.zip', MANAGE, async (req, res, next) => {
  try {
    const taxYear = z
      .preprocess((v) => Number(v), z.number().int().min(2000).max(2100))
      .parse(req.query.taxYear);
    const clientId = z.string().uuid().optional().parse(req.query.clientId);

    const where: Prisma.TaxFormWhereInput = {
      kind: 'W2',
      taxYear,
      status: { not: 'VOIDED' },
    };
    if (clientId) {
      // Filter to associates who had at least one disbursed run for this
      // client in the year. The W-2 row itself doesn't carry clientId, so
      // we resolve it via the associate's payroll history.
      const yearStart = new Date(Date.UTC(taxYear, 0, 1));
      const yearEndExclusive = new Date(Date.UTC(taxYear + 1, 0, 1));
      const eligible = await prisma.payrollItem.findMany({
        where: {
          payrollRun: {
            clientId,
            status: { not: 'CANCELLED' },
            disbursedAt: { gte: yearStart, lt: yearEndExclusive },
          },
        },
        select: { associateId: true },
        distinct: ['associateId'],
      });
      where.associateId = { in: eligible.map((e) => e.associateId) };
    }

    const forms = await prisma.taxForm.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    if (forms.length === 0) {
      throw new HttpError(
        404,
        'no_forms',
        `No W-2 forms found for year ${taxYear}${clientId ? ` and client ${clientId}` : ''}. Generate them first.`,
      );
    }

    // Lazy-import archiver so the route file's startup cost stays tiny.
    const { default: archiver } = await import('archiver');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="w2-${taxYear}${clientId ? `-${clientId.slice(0, 8)}` : ''}.zip"`,
    );

    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', (err) => res.destroy(err));
    zip.pipe(res);

    const skipped: { formId: string; reason: string }[] = [];
    for (const { id } of forms) {
      try {
        const { pdf, filename, hash, form } = await renderW2ForForm(id);
        if (!form.pdfHash) {
          await prisma.taxForm.update({
            where: { id: form.id },
            data: { pdfHash: hash },
          });
        }
        zip.append(pdf, { name: filename });
      } catch (err) {
        const reason = err instanceof HttpError ? err.code : 'unknown';
        skipped.push({ formId: id, reason });
      }
    }

    if (skipped.length > 0) {
      const manifest =
        `Skipped ${skipped.length} of ${forms.length} W-2 forms.\n\n` +
        skipped.map((s) => `${s.formId}\t${s.reason}`).join('\n') +
        '\n';
      zip.append(manifest, { name: 'manifest.txt' });
    }

    await zip.finalize();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /tax-forms/1099-nec/bulk.zip?taxYear=YYYY&clientId=UUID — sibling of
 * the W-2 bulk endpoint. Streams every non-VOIDED 1099-NEC PDF for the
 * year (and optional client scope), skips forms that fail to render, and
 * appends a manifest.txt listing the skips.
 */
payrollTax91Router.get('/tax-forms/1099-nec/bulk.zip', MANAGE, async (req, res, next) => {
  try {
    const taxYear = z
      .preprocess((v) => Number(v), z.number().int().min(2000).max(2100))
      .parse(req.query.taxYear);
    const clientId = z.string().uuid().optional().parse(req.query.clientId);

    const where: Prisma.TaxFormWhereInput = {
      kind: 'F1099_NEC',
      taxYear,
      status: { not: 'VOIDED' },
    };
    if (clientId) {
      const yearStart = new Date(Date.UTC(taxYear, 0, 1));
      const yearEndExclusive = new Date(Date.UTC(taxYear + 1, 0, 1));
      const eligible = await prisma.payrollItem.findMany({
        where: {
          payrollRun: {
            clientId,
            status: { not: 'CANCELLED' },
            disbursedAt: { gte: yearStart, lt: yearEndExclusive },
          },
        },
        select: { associateId: true },
        distinct: ['associateId'],
      });
      where.associateId = { in: eligible.map((e) => e.associateId) };
    }

    const forms = await prisma.taxForm.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    if (forms.length === 0) {
      throw new HttpError(
        404,
        'no_forms',
        `No 1099-NEC forms found for year ${taxYear}${clientId ? ` and client ${clientId}` : ''}. Generate them first.`,
      );
    }

    const { default: archiver } = await import('archiver');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="1099nec-${taxYear}${clientId ? `-${clientId.slice(0, 8)}` : ''}.zip"`,
    );

    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', (err) => res.destroy(err));
    zip.pipe(res);

    const skipped: { formId: string; reason: string }[] = [];
    for (const { id } of forms) {
      try {
        const { pdf, filename, hash, form } = await renderF1099NecForForm(id);
        if (!form.pdfHash) {
          await prisma.taxForm.update({
            where: { id: form.id },
            data: { pdfHash: hash },
          });
        }
        zip.append(pdf, { name: filename });
      } catch (err) {
        const reason = err instanceof HttpError ? err.code : 'unknown';
        skipped.push({ formId: id, reason });
      }
    }

    if (skipped.length > 0) {
      const manifest =
        `Skipped ${skipped.length} of ${forms.length} 1099-NEC forms.\n\n` +
        skipped.map((s) => `${s.formId}\t${s.reason}`).join('\n') +
        '\n';
      zip.append(manifest, { name: 'manifest.txt' });
    }

    await zip.finalize();
  } catch (err) {
    next(err);
  }
});

// ----- Submitter profile (Gap 1) -----------------------------------------

// Singleton row carrying the SSA BSO submitter info used at the top of
// every EFW2 file. HR sets it once during BSO enrollment; the EFW2 route
// reads it instead of accepting per-request body.
const EinPattern = /^\d{9}$/; // EFW2 wants no dashes
const SubmitterProfileBodySchema = z.object({
  ein: z.string().regex(EinPattern, 'EIN must be 9 digits, no dashes'),
  userId: z.string().min(1).max(17),
  name: z.string().min(1).max(57),
  addressLine1: z.string().min(1).max(22),
  addressLine2: z.string().max(22).optional().nullable(),
  city: z.string().min(1).max(22),
  state: z.string().length(2),
  zip5: z.string().regex(/^\d{5}$/),
  zip4: z.string().regex(/^\d{4}$/).optional().nullable(),
  contactName: z.string().min(1).max(57),
  contactPhone: z.string().min(7).max(20),
  contactEmail: z.string().email().max(40),
  // Gap 11 — IRS FIRE Transmitter Control Code, 5 chars, IRS-assigned.
  // Required for 1099-NEC e-file; nullable so W-2-only filers can save
  // a profile without it. Validated as exactly 5 alphanumerics when set.
  irsTcc: z
    .string()
    .regex(/^[A-Z0-9]{5}$/, 'IRS TCC must be 5 uppercase alphanumerics')
    .optional()
    .nullable(),
});

payrollTax91Router.get('/tax-forms/submitter', VIEW, async (_req, res) => {
  const row = await prisma.submitterProfile.findUnique({ where: { id: 'singleton' } });
  res.json({ profile: row ?? null });
});

payrollTax91Router.post('/tax-forms/submitter', MANAGE, async (req, res) => {
  const input = SubmitterProfileBodySchema.parse(req.body);
  const data = {
    ...input,
    addressLine2: input.addressLine2 ?? null,
    zip4: input.zip4 ?? null,
    irsTcc: input.irsTcc ?? null,
  };
  const row = await prisma.submitterProfile.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...data },
    update: data,
  });
  res.json({ profile: row });
});

// ----- EFW2 generator (Gap 1) --------------------------------------------

/**
 * GET /tax-forms/w2/efw2.txt?taxYear=YYYY&clientId=UUID — builds and
 * streams the EFW2 e-file. Includes every non-VOIDED W-2 row whose
 * associate has a disbursed run for that client in the year. GET so
 * the admin UI can trigger the download with a plain anchor tag.
 *
 * Submitter block is read from the SubmitterProfile singleton — finance
 * sets it up once via POST /tax-forms/submitter. The route 400s with a
 * clear error if the profile is missing.
 *
 * Output is plain ASCII (Windows-1252 compatible). Capability:
 * process:payroll.
 */
payrollTax91Router.get('/tax-forms/w2/efw2.txt', MANAGE, async (req, res, next) => {
  try {
    const input = {
      taxYear: z
        .preprocess((v) => Number(v), z.number().int().min(2000).max(2100))
        .parse(req.query.taxYear),
      clientId: z.string().uuid().parse(req.query.clientId),
    };

    const submitter = await prisma.submitterProfile.findUnique({
      where: { id: 'singleton' },
    });
    if (!submitter) {
      throw new HttpError(
        400,
        'submitter_profile_missing',
        'No SubmitterProfile on file. HR must POST /tax-forms/submitter with the BSO User ID + contact info before generating an EFW2 file.',
      );
    }

    const client = await prisma.client.findUnique({
      where: { id: input.clientId },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found.');
    if (!client.legalName || !client.ein) {
      throw new HttpError(
        400,
        'missing_employer_info',
        'Client missing legalName or EIN.',
      );
    }
    if (!client.addressLine1 || !client.city || !client.state || !client.zip) {
      throw new HttpError(
        400,
        'missing_employer_address',
        'EFW2 requires a full employer address (line1, city, state, ZIP).',
      );
    }

    // Pull eligible associates and their W-2 forms for this client + year.
    const yearStart = new Date(Date.UTC(input.taxYear, 0, 1));
    const yearEndExclusive = new Date(Date.UTC(input.taxYear + 1, 0, 1));
    const eligible = await prisma.payrollItem.findMany({
      where: {
        payrollRun: {
          clientId: input.clientId,
          status: { not: 'CANCELLED' },
          disbursedAt: { gte: yearStart, lt: yearEndExclusive },
        },
      },
      select: { associateId: true },
      distinct: ['associateId'],
    });
    const associateIds = eligible.map((e) => e.associateId);

    const forms = await prisma.taxForm.findMany({
      where: {
        kind: 'W2',
        taxYear: input.taxYear,
        status: { not: 'VOIDED' },
        associateId: { in: associateIds },
      },
      include: {
        associate: {
          include: {
            w4Submission: { select: { ssnEncrypted: true } },
          },
        },
      },
    });
    if (forms.length === 0) {
      throw new HttpError(
        404,
        'no_forms',
        `No W-2 forms found for year ${input.taxYear} and client ${input.clientId}. Generate them first.`,
      );
    }

    const employees: Efw2Employee[] = [];
    const skipped: { associateId: string; reason: string }[] = [];
    for (const f of forms) {
      if (!f.associate) {
        skipped.push({ associateId: f.associateId ?? 'unknown', reason: 'no_associate' });
        continue;
      }
      if (!f.associate.w4Submission?.ssnEncrypted) {
        skipped.push({ associateId: f.associate.id, reason: 'missing_ssn' });
        continue;
      }
      if (
        !f.associate.addressLine1 ||
        !f.associate.city ||
        !f.associate.state ||
        !f.associate.zip
      ) {
        skipped.push({ associateId: f.associate.id, reason: 'missing_address' });
        continue;
      }
      const ssn = decryptString(f.associate.w4Submission.ssnEncrypted);
      const cleanedSsn = ssn.replace(/[^0-9]/g, '');
      if (cleanedSsn.length !== 9) {
        skipped.push({ associateId: f.associate.id, reason: 'invalid_ssn' });
        continue;
      }
      const zip = f.associate.zip;
      const zipMatch = zip.match(/^(\d{5})(?:[- ]?(\d{4}))?$/);
      if (!zipMatch) {
        skipped.push({ associateId: f.associate.id, reason: 'invalid_zip' });
        continue;
      }
      employees.push({
        ssn: cleanedSsn,
        firstName: f.associate.firstName,
        lastName: f.associate.lastName,
        addressLine1: f.associate.addressLine1,
        addressLine2: f.associate.addressLine2 ?? undefined,
        city: f.associate.city,
        state: f.associate.state,
        zip5: zipMatch[1],
        zip4: zipMatch[2] ?? undefined,
        boxes: f.amounts as unknown as Efw2Employee['boxes'],
      });
    }

    if (employees.length === 0) {
      throw new HttpError(
        400,
        'no_eligible_employees',
        `Every W-2 was skipped due to missing data: ${skipped.map((s) => s.reason).join(', ')}.`,
      );
    }

    const employerZip = client.zip!.match(/^(\d{5})(?:[- ]?(\d{4}))?$/);
    if (!employerZip) {
      throw new HttpError(400, 'invalid_employer_zip', 'Client ZIP must be 5 or 9 digits.');
    }
    const employerEin = client.ein!.replace(/[^0-9]/g, '');
    if (employerEin.length !== 9) {
      throw new HttpError(400, 'invalid_employer_ein', 'Client EIN must be 9 digits.');
    }

    const efw2Input: Efw2File = {
      submitter: {
        ein: submitter.ein,
        userId: submitter.userId,
        name: submitter.name,
        addressLine1: submitter.addressLine1,
        addressLine2: submitter.addressLine2 ?? undefined,
        city: submitter.city,
        state: submitter.state,
        zip5: submitter.zip5,
        zip4: submitter.zip4 ?? undefined,
        contactName: submitter.contactName,
        contactPhone: submitter.contactPhone,
        contactEmail: submitter.contactEmail,
      },
      employer: {
        ein: employerEin,
        taxYear: input.taxYear,
        name: client.legalName!,
        addressLine1: client.addressLine1!,
        addressLine2: client.addressLine2 ?? undefined,
        city: client.city!,
        state: client.state ?? '',
        zip5: employerZip[1],
        zip4: employerZip[2] ?? undefined,
      },
      employees,
    };

    const fileBody = buildEfw2File(efw2Input);

    res.setHeader('Content-Type', 'text/plain; charset=us-ascii');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="W2_REPORT_${input.taxYear}_${employerEin}.txt"`,
    );
    if (skipped.length > 0) {
      res.setHeader(
        'X-EFW2-Skipped',
        JSON.stringify(skipped).slice(0, 4096),
      );
    }
    res.send(fileBody);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /tax-forms/w2/efw2c.txt?taxYear=YYYY&clientId=UUID — streams the
 * EFW2C correction e-file. Includes every non-VOIDED W-2c row whose
 * associate has a disbursed run for that client in the year. Same
 * caveats as the EFW2 route: spec verification needed before BSO upload
 * (this one against SSA Pub 42-014 + AccuWage W-2c validator).
 */
payrollTax91Router.get(
  '/tax-forms/w2/efw2c.txt',
  MANAGE,
  async (req, res, next) => {
    try {
      const input = {
        taxYear: z
          .preprocess((v) => Number(v), z.number().int().min(2000).max(2100))
          .parse(req.query.taxYear),
        clientId: z.string().uuid().parse(req.query.clientId),
      };

      const submitter = await prisma.submitterProfile.findUnique({
        where: { id: 'singleton' },
      });
      if (!submitter) {
        throw new HttpError(
          400,
          'submitter_profile_missing',
          'No SubmitterProfile on file. POST /tax-forms/submitter first.',
        );
      }

      const client = await prisma.client.findUnique({
        where: { id: input.clientId },
      });
      if (!client) throw new HttpError(404, 'client_not_found', 'Client not found.');
      if (!client.legalName || !client.ein) {
        throw new HttpError(
          400,
          'missing_employer_info',
          'Client missing legalName or EIN.',
        );
      }
      if (!client.addressLine1 || !client.city || !client.state || !client.zip) {
        throw new HttpError(
          400,
          'missing_employer_address',
          'EFW2C requires a full employer address (line1, city, state, ZIP).',
        );
      }

      const yearStart = new Date(Date.UTC(input.taxYear, 0, 1));
      const yearEndExclusive = new Date(Date.UTC(input.taxYear + 1, 0, 1));
      const eligible = await prisma.payrollItem.findMany({
        where: {
          payrollRun: {
            clientId: input.clientId,
            status: { not: 'CANCELLED' },
            disbursedAt: { gte: yearStart, lt: yearEndExclusive },
          },
        },
        select: { associateId: true },
        distinct: ['associateId'],
      });
      const associateIds = eligible.map((e) => e.associateId);

      const forms = await prisma.taxForm.findMany({
        where: {
          kind: 'W2C',
          taxYear: input.taxYear,
          status: { not: 'VOIDED' },
          associateId: { in: associateIds },
        },
        include: {
          associate: {
            include: { w4Submission: { select: { ssnEncrypted: true } } },
          },
        },
      });
      if (forms.length === 0) {
        throw new HttpError(
          404,
          'no_forms',
          `No W-2c forms found for year ${input.taxYear} and client ${input.clientId}. Generate corrections first.`,
        );
      }

      const employees: Efw2cEmployee[] = [];
      const skipped: { associateId: string; reason: string }[] = [];
      for (const f of forms) {
        if (!f.associate) {
          skipped.push({ associateId: f.associateId ?? 'unknown', reason: 'no_associate' });
          continue;
        }
        if (!f.associate.w4Submission?.ssnEncrypted) {
          skipped.push({ associateId: f.associate.id, reason: 'missing_ssn' });
          continue;
        }
        if (
          !f.associate.addressLine1 ||
          !f.associate.city ||
          !f.associate.state ||
          !f.associate.zip
        ) {
          skipped.push({ associateId: f.associate.id, reason: 'missing_address' });
          continue;
        }
        const ssn = decryptString(f.associate.w4Submission.ssnEncrypted);
        const cleanedSsn = ssn.replace(/[^0-9]/g, '');
        if (cleanedSsn.length !== 9) {
          skipped.push({ associateId: f.associate.id, reason: 'invalid_ssn' });
          continue;
        }
        const zip = f.associate.zip;
        const zipMatch = zip.match(/^(\d{5})(?:[- ]?(\d{4}))?$/);
        if (!zipMatch) {
          skipped.push({ associateId: f.associate.id, reason: 'invalid_zip' });
          continue;
        }
        const amounts = f.amounts as unknown as {
          previous: W2Boxes;
          corrected: W2Boxes;
        };
        employees.push({
          ssn: cleanedSsn,
          firstName: f.associate.firstName,
          lastName: f.associate.lastName,
          addressLine1: f.associate.addressLine1,
          addressLine2: f.associate.addressLine2 ?? undefined,
          city: f.associate.city,
          state: f.associate.state,
          zip5: zipMatch[1],
          zip4: zipMatch[2] ?? undefined,
          previous: amounts.previous,
          corrected: amounts.corrected,
        });
      }

      if (employees.length === 0) {
        throw new HttpError(
          400,
          'no_eligible_employees',
          `Every W-2c was skipped due to missing data: ${skipped.map((s) => s.reason).join(', ')}.`,
        );
      }

      const employerZip = client.zip!.match(/^(\d{5})(?:[- ]?(\d{4}))?$/);
      if (!employerZip) {
        throw new HttpError(400, 'invalid_employer_zip', 'Client ZIP must be 5 or 9 digits.');
      }
      const employerEin = client.ein!.replace(/[^0-9]/g, '');
      if (employerEin.length !== 9) {
        throw new HttpError(400, 'invalid_employer_ein', 'Client EIN must be 9 digits.');
      }

      const efw2cInput: Efw2cFile = {
        submitter: {
          ein: submitter.ein,
          userId: submitter.userId,
          name: submitter.name,
          addressLine1: submitter.addressLine1,
          addressLine2: submitter.addressLine2 ?? undefined,
          city: submitter.city,
          state: submitter.state,
          zip5: submitter.zip5,
          zip4: submitter.zip4 ?? undefined,
          contactName: submitter.contactName,
          contactPhone: submitter.contactPhone,
          contactEmail: submitter.contactEmail,
        },
        employer: {
          ein: employerEin,
          taxYear: input.taxYear,
          name: client.legalName!,
          addressLine1: client.addressLine1!,
          addressLine2: client.addressLine2 ?? undefined,
          city: client.city!,
          state: client.state ?? '',
          zip5: employerZip[1],
          zip4: employerZip[2] ?? undefined,
        },
        employees,
      };

      const fileBody = buildEfw2cFile(efw2cInput);

      res.setHeader('Content-Type', 'text/plain; charset=us-ascii');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="W2C_REPORT_${input.taxYear}_${employerEin}.txt"`,
      );
      if (skipped.length > 0) {
        res.setHeader(
          'X-EFW2C-Skipped',
          JSON.stringify(skipped).slice(0, 4096),
        );
      }
      res.send(fileBody);
    } catch (err) {
      next(err);
    }
  },
);

// ----- IRS FIRE 1099-NEC generator (Gap 11) ------------------------------

/**
 * GET /tax-forms/1099-nec/fire.txt?taxYear=YYYY&clientId=UUID — streams
 * the IRS FIRE-format e-file for every non-VOIDED 1099-NEC whose
 * recipient was paid by this client in the year. Distinct from EFW2/
 * EFW2C (those file with SSA via BSO; this files with the IRS via
 * fire.test.irs.gov / fire.irs.gov).
 *
 * Required state:
 *   - SubmitterProfile.irsTcc must be set (5-char IRS-assigned code)
 *   - Each contractor must have tinEncrypted and a valid 5-or-9 ZIP
 *   - Client must have legalName / EIN / address fields
 * Surfaces missing inputs as 400s with actionable codes; surfaces
 * per-recipient skips via X-IrsFire-Skipped response header so finance
 * can chase data quality without re-running the route.
 *
 * Capability: process:payroll. The body is plain ASCII; downloader is
 * an <a download> link.
 */
payrollTax91Router.get(
  '/tax-forms/1099-nec/fire.txt',
  MANAGE,
  async (req, res, next) => {
    try {
      const input = {
        taxYear: z
          .preprocess((v) => Number(v), z.number().int().min(2000).max(2100))
          .parse(req.query.taxYear),
        clientId: z.string().uuid().parse(req.query.clientId),
      };

      const submitter = await prisma.submitterProfile.findUnique({
        where: { id: 'singleton' },
      });
      if (!submitter) {
        throw new HttpError(
          400,
          'submitter_profile_missing',
          'No SubmitterProfile on file. POST /tax-forms/submitter first.',
        );
      }
      if (!submitter.irsTcc) {
        throw new HttpError(
          400,
          'submitter_tcc_missing',
          'SubmitterProfile.irsTcc is null. Register for IRS FIRE and save the 5-char Transmitter Control Code on the submitter profile before generating 1099-NEC e-files.',
        );
      }

      const client = await prisma.client.findUnique({
        where: { id: input.clientId },
      });
      if (!client) throw new HttpError(404, 'client_not_found', 'Client not found.');
      if (!client.legalName || !client.ein) {
        throw new HttpError(
          400,
          'missing_payer_info',
          'Client missing legalName or EIN.',
        );
      }
      if (!client.addressLine1 || !client.city || !client.state || !client.zip) {
        throw new HttpError(
          400,
          'missing_payer_address',
          'IRS FIRE requires a full payer address (line1, city, state, ZIP).',
        );
      }

      const forms = await prisma.taxForm.findMany({
        where: {
          kind: 'F1099_NEC',
          taxYear: input.taxYear,
          status: { not: 'VOIDED' },
        },
        include: { associate: true },
      });
      // Filter to forms whose recipient was paid by THIS client in the
      // year (form rows don't carry clientId — resolve via PayrollItem).
      const yearStart = new Date(Date.UTC(input.taxYear, 0, 1));
      const yearEndExclusive = new Date(Date.UTC(input.taxYear + 1, 0, 1));
      const eligibleAssociateIds = new Set<string>(
        (
          await prisma.payrollItem.findMany({
            where: {
              payrollRun: {
                clientId: input.clientId,
                status: { not: 'CANCELLED' },
                disbursedAt: { gte: yearStart, lt: yearEndExclusive },
              },
            },
            select: { associateId: true },
            distinct: ['associateId'],
          })
        ).map((e) => e.associateId),
      );
      const scopedForms = forms.filter(
        (f) => f.associateId && eligibleAssociateIds.has(f.associateId),
      );
      if (scopedForms.length === 0) {
        throw new HttpError(
          404,
          'no_forms',
          `No 1099-NEC forms found for year ${input.taxYear} and client ${input.clientId}. Generate them first.`,
        );
      }

      const payees: IrsFirePayee[] = [];
      const skipped: { associateId: string; reason: string }[] = [];
      for (const f of scopedForms) {
        if (!f.associate) {
          skipped.push({ associateId: f.associateId ?? 'unknown', reason: 'no_associate' });
          continue;
        }
        if (!f.associate.tinEncrypted) {
          skipped.push({ associateId: f.associate.id, reason: 'missing_tin' });
          continue;
        }
        if (
          !f.associate.addressLine1 ||
          !f.associate.city ||
          !f.associate.state ||
          !f.associate.zip
        ) {
          skipped.push({ associateId: f.associate.id, reason: 'missing_address' });
          continue;
        }
        const tin = decryptString(f.associate.tinEncrypted).replace(/[^0-9]/g, '');
        if (tin.length !== 9) {
          skipped.push({ associateId: f.associate.id, reason: 'invalid_tin' });
          continue;
        }
        const zipMatch = f.associate.zip.match(/^(\d{5})(?:[- ]?(\d{4}))?$/);
        if (!zipMatch) {
          skipped.push({ associateId: f.associate.id, reason: 'invalid_zip' });
          continue;
        }
        payees.push({
          tin,
          tinTypeCode:
            f.associate.employmentType === 'CONTRACTOR_1099_BUSINESS' ? '2' : '1',
          name: `${f.associate.firstName} ${f.associate.lastName}`.trim(),
          addressLine1: f.associate.addressLine1,
          city: f.associate.city,
          state: f.associate.state,
          zip5: zipMatch[1],
          zip4: zipMatch[2] ?? undefined,
          accountNumber: f.id.slice(0, 12).toUpperCase(),
          boxes: f.amounts as unknown as Form1099NecBoxes,
        });
      }

      if (payees.length === 0) {
        throw new HttpError(
          400,
          'no_eligible_payees',
          `Every 1099-NEC was skipped due to missing data: ${skipped.map((s) => s.reason).join(', ')}.`,
        );
      }

      const payerZip = client.zip!.match(/^(\d{5})(?:[- ]?(\d{4}))?$/);
      if (!payerZip) {
        throw new HttpError(400, 'invalid_payer_zip', 'Client ZIP must be 5 or 9 digits.');
      }
      const payerEin = client.ein!.replace(/[^0-9]/g, '');
      if (payerEin.length !== 9) {
        throw new HttpError(400, 'invalid_payer_ein', 'Client EIN must be 9 digits.');
      }

      const fireInput: IrsFireFile = {
        transmitter: {
          tcc: submitter.irsTcc,
          ein: submitter.ein,
          name: submitter.name,
          contactName: submitter.contactName,
          contactPhone: submitter.contactPhone,
          contactEmail: submitter.contactEmail,
          taxYear: input.taxYear,
        },
        payer: {
          ein: payerEin,
          name: client.legalName!,
          addressLine1: client.addressLine1!,
          city: client.city!,
          state: client.state ?? '',
          zip5: payerZip[1],
          zip4: payerZip[2] ?? undefined,
        },
        payees,
      };

      const fileBody = buildIrsFireFile(fireInput);

      res.setHeader('Content-Type', 'text/plain; charset=us-ascii');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="IRS_FIRE_1099NEC_${input.taxYear}_${payerEin}.txt"`,
      );
      if (skipped.length > 0) {
        res.setHeader(
          'X-IrsFire-Skipped',
          JSON.stringify(skipped).slice(0, 4096),
        );
      }
      res.send(fileBody);
    } catch (err) {
      next(err);
    }
  },
);
