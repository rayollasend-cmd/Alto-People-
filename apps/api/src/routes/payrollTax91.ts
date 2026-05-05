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
} from '../lib/w2Aggregator.js';
import { hashW2Pdf, renderW2Pdf, type W2PdfData } from '../lib/w2Pdf.js';
import { buildEfw2File, type Efw2Employee, type Efw2File } from '../lib/efw2.js';

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

// Shared helper — pulls the form + associate + W-4, looks up an employer
// block from the associate's first disbursed run in the year, and renders
// the W-2 PDF. Used by both the single-PDF and bulk-zip routes. Throws
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
  if (form.kind !== 'W2') {
    throw new HttpError(
      400,
      'unsupported_kind',
      `PDF rendering is only supported for W-2 today. ${form.kind} renderers land in a follow-up.`,
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
 * GET /tax-forms/:id/pdf — renders the PDF for a TaxForm. W-2 only at this
 * phase; other kinds 400 until their renderers land. Stamps `pdfHash` on
 * first download (matching the paystub immutability contract).
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

    const { pdf, hash, filename } = await renderW2ForForm(req.params.id);

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
});

payrollTax91Router.get('/tax-forms/submitter', VIEW, async (_req, res) => {
  const row = await prisma.submitterProfile.findUnique({ where: { id: 'singleton' } });
  res.json({ profile: row ?? null });
});

payrollTax91Router.post('/tax-forms/submitter', MANAGE, async (req, res) => {
  const input = SubmitterProfileBodySchema.parse(req.body);
  const row = await prisma.submitterProfile.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...input, addressLine2: input.addressLine2 ?? null, zip4: input.zip4 ?? null },
    update: { ...input, addressLine2: input.addressLine2 ?? null, zip4: input.zip4 ?? null },
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
