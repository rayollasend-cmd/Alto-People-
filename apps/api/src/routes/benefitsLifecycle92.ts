import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { notifyAssociate } from '../lib/notify.js';
import { decryptString } from '../lib/crypto.js';
import { employerFor } from '../lib/employment.js';
import { hash1095cPdf, render1095cPdf, type F1095cMonth } from '../lib/f1095cPdf.js';
import { buildAcaAirXml, type AirEmployee } from '../lib/acaAir.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Phase 92 — Benefits lifecycle: open enrollment, QLE, COBRA, ACA.
 *
 * Open enrollment windows belong to a client and gate non-QLE election
 * changes during the window. QLEs grant a 30/60-day change window
 * outside OE. COBRA offers are sent on termination/RoH. ACA monthly
 * snapshots feed the 1095-C reporting.
 */

export const benefitsLifecycle92Router = Router();

const VIEW = requireCapability('view:payroll');
const MANAGE = requireCapability('process:payroll');

// ----- Open enrollment windows -------------------------------------------

const OeInputSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(160),
  startsOn: z.string(),
  endsOn: z.string(),
  effectiveOn: z.string(),
});

benefitsLifecycle92Router.get('/open-enrollment', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.openEnrollmentWindow.findMany({
    where: { ...(clientId ? { clientId } : {}) },
    include: { client: { select: { name: true } } },
    orderBy: { startsOn: 'desc' },
    take: 100,
  });
  res.json({
    windows: rows.map((w) => ({
      id: w.id,
      clientId: w.clientId,
      clientName: w.client.name,
      name: w.name,
      startsOn: w.startsOn.toISOString().slice(0, 10),
      endsOn: w.endsOn.toISOString().slice(0, 10),
      effectiveOn: w.effectiveOn.toISOString().slice(0, 10),
      status: w.status,
      createdAt: w.createdAt.toISOString(),
    })),
  });
});

benefitsLifecycle92Router.post('/open-enrollment', MANAGE, async (req, res) => {
  const input = OeInputSchema.parse(req.body);
  if (new Date(input.startsOn) > new Date(input.endsOn)) {
    throw new HttpError(400, 'invalid_dates', 'startsOn must be ≤ endsOn.');
  }
  const created = await prisma.openEnrollmentWindow.create({
    data: {
      clientId: input.clientId,
      name: input.name,
      startsOn: new Date(input.startsOn),
      endsOn: new Date(input.endsOn),
      effectiveOn: new Date(input.effectiveOn),
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

benefitsLifecycle92Router.post(
  '/open-enrollment/:id/open',
  MANAGE,
  async (req, res) => {
    await prisma.openEnrollmentWindow.update({
      where: { id: req.params.id },
      data: { status: 'OPEN' },
    });
    res.json({ ok: true });
  },
);

benefitsLifecycle92Router.post(
  '/open-enrollment/:id/close',
  MANAGE,
  async (req, res) => {
    await prisma.openEnrollmentWindow.update({
      where: { id: req.params.id },
      data: { status: 'CLOSED' },
    });
    res.json({ ok: true });
  },
);

// ----- Qualifying life events --------------------------------------------

const QLE_KINDS = [
  'MARRIAGE',
  'DIVORCE',
  'BIRTH',
  'ADOPTION',
  'DEATH_OF_DEPENDENT',
  'LOSS_OF_COVERAGE',
  'GAIN_OF_COVERAGE',
  'RELOCATION',
  'OTHER',
] as const;

const QleInputSchema = z.object({
  associateId: z.string().uuid(),
  kind: z.enum(QLE_KINDS),
  eventDate: z.string(),
  // Default to 30 days from event date if not provided.
  allowedUntil: z.string().optional(),
  evidenceUrl: z.string().url().optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
});

benefitsLifecycle92Router.get('/qles', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const status = z
    .enum(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.qualifyingLifeEvent.findMany({
    where: {
      ...(associateId ? { associateId } : {}),
      ...(status ? { status } : {}),
    },
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: { eventDate: 'desc' },
    take: 200,
  });
  res.json({
    qles: rows.map((q) => ({
      id: q.id,
      associateId: q.associateId,
      associateName: `${q.associate.firstName} ${q.associate.lastName}`,
      kind: q.kind,
      eventDate: q.eventDate.toISOString().slice(0, 10),
      allowedUntil: q.allowedUntil.toISOString().slice(0, 10),
      evidenceUrl: q.evidenceUrl,
      notes: q.notes,
      status: q.status,
      decidedAt: q.decidedAt?.toISOString() ?? null,
      createdAt: q.createdAt.toISOString(),
    })),
  });
});

benefitsLifecycle92Router.post('/qles', VIEW, async (req, res) => {
  const input = QleInputSchema.parse(req.body);
  const eventDate = new Date(input.eventDate);
  const allowedUntil = input.allowedUntil
    ? new Date(input.allowedUntil)
    : new Date(eventDate.getTime() + 30 * 24 * 3600 * 1000);
  const created = await prisma.qualifyingLifeEvent.create({
    data: {
      associateId: input.associateId,
      kind: input.kind,
      eventDate,
      allowedUntil,
      evidenceUrl: input.evidenceUrl ?? null,
      notes: input.notes ?? null,
    },
  });
  res.status(201).json({ id: created.id });
});

benefitsLifecycle92Router.post('/qles/:id/decide', MANAGE, async (req, res) => {
  const decision = z.enum(['APPROVED', 'DENIED']).parse(req.body?.decision);
  // Optional denial reason — not persisted (no column), but surfaced in the
  // associate's notification so a denial never arrives unexplained.
  const reason = z
    .string()
    .max(2000)
    .optional()
    .parse(req.body?.reason)
    ?.trim();
  const q = await prisma.qualifyingLifeEvent.findUnique({
    where: { id: req.params.id },
  });
  if (!q) throw new HttpError(404, 'not_found', 'QLE not found.');
  if (q.status !== 'PENDING') {
    throw new HttpError(409, 'invalid_state', `QLE already ${q.status}.`);
  }
  await prisma.qualifyingLifeEvent.update({
    where: { id: q.id },
    data: {
      status: decision,
      decidedAt: new Date(),
      decidedById: req.user!.id,
    },
  });
  const approved = decision === 'APPROVED';
  void notifyAssociate(q.associateId, {
    subject: approved
      ? 'Your qualifying life event was approved'
      : 'Your qualifying life event was denied',
    body: approved
      ? `Your qualifying life event was approved. You can update your benefit elections until ${q.allowedUntil.toISOString().slice(0, 10)}.`
      : `Your qualifying life event was denied.${reason ? ` Reason: ${reason}` : ''} Contact HR if you have questions.`,
    category: 'benefits',
    linkUrl: '/benefits',
    emailFallback: true,
  });
  res.json({ ok: true });
});

// ----- COBRA -------------------------------------------------------------

const CobraInputSchema = z.object({
  associateId: z.string().uuid(),
  qualifyingEvent: z.string().min(1).max(80),
  qeDate: z.string(),
  electionDeadline: z.string().optional(),
  coverageEndsOn: z.string().optional(),
  premiumPerMonth: z.number().nonnegative().optional().nullable(),
});

benefitsLifecycle92Router.get('/cobra', VIEW, async (_req, res) => {
  const rows = await prisma.cobraOffer.findMany({
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: { noticedAt: 'desc' },
    take: 200,
  });
  res.json({
    offers: rows.map((c) => ({
      id: c.id,
      associateId: c.associateId,
      associateName: `${c.associate.firstName} ${c.associate.lastName}`,
      qualifyingEvent: c.qualifyingEvent,
      qeDate: c.qeDate.toISOString().slice(0, 10),
      electionDeadline: c.electionDeadline.toISOString().slice(0, 10),
      coverageEndsOn: c.coverageEndsOn.toISOString().slice(0, 10),
      noticedAt: c.noticedAt.toISOString(),
      electedAt: c.electedAt?.toISOString() ?? null,
      premiumPerMonth: c.premiumPerMonth?.toString() ?? null,
      status: c.status,
    })),
  });
});

benefitsLifecycle92Router.post('/cobra', MANAGE, async (req, res) => {
  const input = CobraInputSchema.parse(req.body);
  const qeDate = new Date(input.qeDate);
  // Defaults: 60-day election, 18 months coverage from QE date.
  const electionDeadline = input.electionDeadline
    ? new Date(input.electionDeadline)
    : new Date(qeDate.getTime() + 60 * 24 * 3600 * 1000);
  const coverageEndsOn = input.coverageEndsOn
    ? new Date(input.coverageEndsOn)
    : new Date(qeDate.getTime() + 18 * 30 * 24 * 3600 * 1000);
  const created = await prisma.cobraOffer.create({
    data: {
      associateId: input.associateId,
      qualifyingEvent: input.qualifyingEvent,
      qeDate,
      electionDeadline,
      coverageEndsOn,
      premiumPerMonth: input.premiumPerMonth ?? null,
    },
  });
  // emailFallback matters here: the COBRA population (terminated / reduced
  // hours) is exactly the group least likely to still have an active login.
  void notifyAssociate(created.associateId, {
    subject: 'COBRA continuation coverage offer',
    body:
      `You are eligible to continue your health coverage under COBRA. ` +
      `Elect or waive by ${electionDeadline.toISOString().slice(0, 10)}` +
      `${input.premiumPerMonth != null ? ` (premium $${input.premiumPerMonth}/month)` : ''}. ` +
      `If you do nothing, the offer expires on that date.`,
    category: 'benefits',
    linkUrl: '/benefits',
    emailFallback: true,
  });
  res.status(201).json({ id: created.id });
});

benefitsLifecycle92Router.post('/cobra/:id/elect', MANAGE, async (req, res) => {
  const c = await prisma.cobraOffer.findUnique({ where: { id: req.params.id } });
  if (!c) throw new HttpError(404, 'not_found', 'Offer not found.');
  if (c.status !== 'NOTIFIED') {
    throw new HttpError(409, 'invalid_state', `Offer already ${c.status}.`);
  }
  if (new Date() > c.electionDeadline) {
    throw new HttpError(409, 'expired', 'Election deadline passed.');
  }
  await prisma.cobraOffer.update({
    where: { id: c.id },
    data: { status: 'ELECTED', electedAt: new Date() },
  });
  res.json({ ok: true });
});

benefitsLifecycle92Router.post('/cobra/:id/waive', MANAGE, async (req, res) => {
  await prisma.cobraOffer.update({
    where: { id: req.params.id },
    data: { status: 'WAIVED' },
  });
  res.json({ ok: true });
});

// ----- ACA ---------------------------------------------------------------

const AcaMonthInputSchema = z.object({
  associateId: z.string().uuid(),
  year: z.number().int().min(2014).max(2100),
  month: z.number().int().min(1).max(12),
  offerOfCoverage: z
    .enum([
      'CODE_1A',
      'CODE_1B',
      'CODE_1C',
      'CODE_1D',
      'CODE_1E',
      'CODE_1F',
      'CODE_1G',
      'CODE_1H',
    ])
    .optional()
    .nullable(),
  lowestPremiumCents: z.number().int().nonnegative().optional().nullable(),
  safeHarbor: z.string().max(3).optional().nullable(),
  isFullTime: z.boolean().optional(),
});

benefitsLifecycle92Router.post('/aca/months', MANAGE, async (req, res) => {
  const input = AcaMonthInputSchema.parse(req.body);
  // Upsert keyed on (associate, year, month) — the unique index handles
  // collisions; this lets HR re-run the importer without duplicating.
  await prisma.acaMonth.upsert({
    where: {
      associateId_year_month: {
        associateId: input.associateId,
        year: input.year,
        month: input.month,
      },
    },
    update: {
      offerOfCoverage: input.offerOfCoverage ?? null,
      lowestPremiumCents: input.lowestPremiumCents ?? null,
      safeHarbor: input.safeHarbor ?? null,
      isFullTime: input.isFullTime ?? false,
    },
    create: {
      associateId: input.associateId,
      year: input.year,
      month: input.month,
      offerOfCoverage: input.offerOfCoverage ?? null,
      lowestPremiumCents: input.lowestPremiumCents ?? null,
      safeHarbor: input.safeHarbor ?? null,
      isFullTime: input.isFullTime ?? false,
    },
  });
  res.json({ ok: true });
});

/**
 * Build the 1095-C grid for a given year: one row per associate × 12
 * months. Used to drive the per-employee form generator.
 */
benefitsLifecycle92Router.get('/aca/1095c', VIEW, async (req, res) => {
  const year = z
    .preprocess((v) => Number(v), z.number().int().min(2014).max(2100))
    .parse(req.query.year);
  const rows = await prisma.acaMonth.findMany({
    take: 500,
    where: { year },
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: [{ associateId: 'asc' }, { month: 'asc' }],
  });
  // Bucket by associate.
  const byAssociate = new Map<
    string,
    {
      associateId: string;
      associateName: string;
      months: Array<{
        month: number;
        offerOfCoverage: string | null;
        lowestPremiumCents: number | null;
        safeHarbor: string | null;
        isFullTime: boolean;
      } | null>;
    }
  >();
  for (const r of rows) {
    if (!byAssociate.has(r.associateId)) {
      byAssociate.set(r.associateId, {
        associateId: r.associateId,
        associateName: `${r.associate.firstName} ${r.associate.lastName}`,
        months: Array(12).fill(null),
      });
    }
    const bucket = byAssociate.get(r.associateId)!;
    bucket.months[r.month - 1] = {
      month: r.month,
      offerOfCoverage: r.offerOfCoverage,
      lowestPremiumCents: r.lowestPremiumCents,
      safeHarbor: r.safeHarbor,
      isFullTime: r.isFullTime,
    };
  }
  res.json({ year, employees: Array.from(byAssociate.values()) });
});

/* ===== ACA — Form 1095-C / 1094-C ======================================= */

const YearQuery = z.preprocess((v) => Number(v), z.number().int().min(2014).max(2100));

/** The SSN behind a W-4, or null when there is none or the key rotated. */
function readSsn(blob: Uint8Array | null): string | null {
  if (!blob) return null;
  try {
    return decryptString(blob);
  } catch {
    return null;
  }
}

async function acaMonthsByAssociate(year: number) {
  const rows = await prisma.acaMonth.findMany({
    take: 5000,
    where: { year },
    orderBy: [{ associateId: 'asc' }, { month: 'asc' }],
  });
  const by = new Map<string, Array<F1095cMonth | null>>();
  for (const r of rows) {
    const arr = by.get(r.associateId) ?? Array<F1095cMonth | null>(12).fill(null);
    arr[r.month - 1] = { month: r.month, offerOfCoverage: r.offerOfCoverage, lowestPremiumCents: r.lowestPremiumCents, safeHarbor: r.safeHarbor, isFullTime: r.isFullTime };
    by.set(r.associateId, arr);
  }
  return by;
}

/**
 * POST /aca/1095c/generate { year } — one F1095C TaxForm per employee with
 * ACA months on file (skips anyone already on file for the year), and the
 * F1094C transmittal with the counts. Drafts; filing marks them with the
 * IRS acknowledgment.
 */
benefitsLifecycle92Router.post('/aca/1095c/generate', MANAGE, async (req, res) => {
  const year = YearQuery.parse(req.body?.year);
  const months = await acaMonthsByAssociate(year);
  const existing = await prisma.taxForm.findMany({
    where: { kind: 'F1095C', taxYear: year, status: { not: 'VOIDED' } },
    select: { associateId: true },
  });
  const have = new Set(existing.map((e) => e.associateId));
  let created = 0;
  let skipped = 0;
  for (const [associateId, m] of months) {
    if (have.has(associateId)) {
      skipped += 1;
      continue;
    }
    const employer = await employerFor(prisma, associateId, new Date(Date.UTC(year, 11, 31)));
    await prisma.taxForm.create({
      data: {
        kind: 'F1095C',
        taxYear: year,
        associateId,
        ein: employer.ein,
        amounts: { months: m } as unknown as Prisma.InputJsonValue,
        status: 'DRAFT',
      },
    });
    created += 1;
  }
  const fullTimeByMonth = Array(12).fill(0) as number[];
  const totalByMonth = Array(12).fill(0) as number[];
  for (const m of months.values()) {
    m.forEach((x, i) => {
      if (x) totalByMonth[i] += 1;
      if (x?.isFullTime) fullTimeByMonth[i] += 1;
    });
  }
  const transmittal = await prisma.taxForm.findFirst({ where: { kind: 'F1094C', taxYear: year, status: { not: 'VOIDED' } } });
  if (!transmittal) {
    await prisma.taxForm.create({
      data: { kind: 'F1094C', taxYear: year, amounts: { forms: months.size, fullTimeByMonth, totalByMonth } as unknown as Prisma.InputJsonValue, status: 'DRAFT' },
    });
  } else {
    await prisma.taxForm.update({
      where: { id: transmittal.id },
      data: { amounts: { forms: months.size, fullTimeByMonth, totalByMonth } as unknown as Prisma.InputJsonValue },
    });
  }
  res.json({ year, created, skipped, employees: months.size });
});

/** GET /aca/1095c/:formId/pdf — the employee's copy. */
benefitsLifecycle92Router.get('/aca/1095c/:formId/pdf', VIEW, async (req, res) => {
  const form = await prisma.taxForm.findUnique({
    where: { id: z.string().uuid().parse(req.params.formId) },
    include: { associate: { select: { id: true, firstName: true, lastName: true, addressLine1: true, city: true, state: true, zip: true, w4Submission: { select: { ssnEncrypted: true } } } } },
  });
  if (!form || form.kind !== 'F1095C' || !form.associate) throw new HttpError(404, 'not_found', 'Form not found.');
  const employer = await employerFor(prisma, form.associate.id, new Date(Date.UTC(form.taxYear, 11, 31)));
  const profile = await prisma.submitterProfile.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { contactPhone: true } });
  const ssn = readSsn(form.associate.w4Submission?.ssnEncrypted ?? null);
  const months = ((form.amounts as { months?: Array<F1095cMonth | null> }).months ?? Array(12).fill(null)) as Array<F1095cMonth | null>;
  const pdf = await render1095cPdf({
    taxYear: form.taxYear,
    corrected: form.status === 'AMENDED',
    employee: { firstName: form.associate.firstName, lastName: form.associate.lastName, ssn, addressLine1: form.associate.addressLine1, city: form.associate.city, state: form.associate.state, zip: form.associate.zip },
    employer: { name: employer.legalName, ein: employer.ein, addressLine1: employer.addressLine1, city: employer.city, state: employer.state, zip: employer.zip, contactPhone: profile?.contactPhone ?? null },
    months,
    meta: { formId: form.id, generatedAt: form.createdAt.toISOString() },
  });
  const hash = hash1095cPdf(pdf);
  if (!form.pdfHash) await prisma.taxForm.update({ where: { id: form.id }, data: { pdfHash: hash } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="1095-C-${form.taxYear}-${form.associate.lastName}.pdf"`);
  res.send(pdf);
});

/**
 * GET /aca/air.xml?year= — the 1094-C/1095-C AIR transmission for the
 * year, built from the generated forms. Transmission is the filing
 * partner's (or the employer's TCC) through the IRS AIR channel.
 */
benefitsLifecycle92Router.get('/aca/air.xml', MANAGE, async (req, res) => {
  const year = YearQuery.parse(req.query.year);
  const forms = await prisma.taxForm.findMany({
    where: { kind: 'F1095C', taxYear: year, status: { not: 'VOIDED' } },
    include: { associate: { select: { id: true, firstName: true, lastName: true, dob: true, addressLine1: true, city: true, state: true, zip: true, w4Submission: { select: { ssnEncrypted: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  if (forms.length === 0) throw new HttpError(409, 'no_forms', `Generate the ${year} 1095-C forms first.`);
  const transmittal = await prisma.taxForm.findFirst({ where: { kind: 'F1094C', taxYear: year, status: { not: 'VOIDED' } } });
  const counts = (transmittal?.amounts ?? {}) as { fullTimeByMonth?: number[]; totalByMonth?: number[] };
  const employer = await employerFor(prisma, forms[0].associate!.id, new Date(Date.UTC(year, 11, 31)));
  const profile = await prisma.submitterProfile.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { contactName: true, contactPhone: true } });
  const employees: AirEmployee[] = forms.map((f, i) => {
    const ssn = readSsn(f.associate!.w4Submission?.ssnEncrypted ?? null);
    return {
      recordId: i + 1,
      firstName: f.associate!.firstName,
      lastName: f.associate!.lastName,
      ssn,
      dob: f.associate!.dob ? f.associate!.dob.toISOString().slice(0, 10) : null,
      addressLine1: f.associate!.addressLine1,
      city: f.associate!.city,
      state: f.associate!.state,
      zip: f.associate!.zip,
      months: ((f.amounts as { months?: Array<F1095cMonth | null> }).months ?? Array(12).fill(null)) as Array<F1095cMonth | null>,
    };
  });
  const xml = buildAcaAirXml({
    taxYear: year,
    employer: { name: employer.legalName, ein: employer.ein, addressLine1: employer.addressLine1, city: employer.city, state: employer.state, zip: employer.zip, contactName: profile?.contactName ?? null, contactPhone: profile?.contactPhone ?? null },
    employees,
    fullTimeByMonth: counts.fullTimeByMonth ?? Array(12).fill(0),
    totalByMonth: counts.totalByMonth ?? Array(12).fill(forms.length),
    generatedAt: new Date(),
  });
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="1094C-1095C-${year}-AIR.xml"`);
  res.send(xml);
});
