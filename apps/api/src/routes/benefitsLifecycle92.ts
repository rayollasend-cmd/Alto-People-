import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

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
