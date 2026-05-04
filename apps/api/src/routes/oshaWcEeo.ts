import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 88 — OSHA + WC class codes + EEO-1.
 *
 * /osha/incidents               GET / POST / PUT
 * /osha/300a?clientId&year      OSHA Form 300A annual summary numbers
 *
 * /wc/class-codes               GET / POST / PUT (catalog of codes + rates)
 *
 * /eeo/associates/:id           GET / PUT (per-associate EEO record)
 * /eeo/report?clientId&year     OSHA Form 300A-style aggregate counts by
 *                               EEO category × race × gender
 */

export const oshaWcEeoRouter = Router();

const VIEW_COMP = requireCapability('view:compliance');
const MANAGE_COMP = requireCapability('manage:compliance');

// ----- OSHA --------------------------------------------------------------

const OshaInputSchema = z.object({
  clientId: z.string().uuid(),
  associateId: z.string().uuid().nullable().optional(),
  occurredAt: z.string().datetime(),
  location: z.string().max(250).optional().nullable(),
  description: z.string().min(1).max(8000),
  bodyPart: z.string().max(120).optional().nullable(),
  severity: z.enum([
    'FIRST_AID',
    'MEDICAL_TREATMENT',
    'RESTRICTED_DUTY',
    'DAYS_AWAY',
    'FATAL',
  ]),
  daysAway: z.number().int().nonnegative().optional(),
  daysRestricted: z.number().int().nonnegative().optional(),
  isRecordable: z.boolean().optional(),
});

const OshaUpdateSchema = z.object({
  status: z.enum(['REPORTED', 'INVESTIGATING', 'RESOLVED', 'ESCALATED']).optional(),
  resolutionNote: z.string().max(8000).nullable().optional(),
  daysAway: z.number().int().nonnegative().optional(),
  daysRestricted: z.number().int().nonnegative().optional(),
  isRecordable: z.boolean().optional(),
});

oshaWcEeoRouter.get('/osha/incidents', VIEW_COMP, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.oshaIncident.findMany({
    where: clientId ? { clientId } : {},
    include: {
      associate: { select: { firstName: true, lastName: true } },
      client: { select: { name: true } },
    },
    orderBy: { occurredAt: 'desc' },
    take: 200,
  });
  res.json({
    incidents: rows.map((i) => ({
      id: i.id,
      clientId: i.clientId,
      clientName: i.client.name,
      associateId: i.associateId,
      associateName: i.associate
        ? `${i.associate.firstName} ${i.associate.lastName}`
        : null,
      occurredAt: i.occurredAt.toISOString(),
      reportedAt: i.reportedAt.toISOString(),
      location: i.location,
      description: i.description,
      bodyPart: i.bodyPart,
      severity: i.severity,
      daysAway: i.daysAway,
      daysRestricted: i.daysRestricted,
      isRecordable: i.isRecordable,
      status: i.status,
      resolutionNote: i.resolutionNote,
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
    })),
  });
});

oshaWcEeoRouter.post('/osha/incidents', MANAGE_COMP, async (req, res) => {
  const input = OshaInputSchema.parse(req.body);
  const created = await prisma.oshaIncident.create({
    data: {
      clientId: input.clientId,
      associateId: input.associateId ?? null,
      occurredAt: new Date(input.occurredAt),
      location: input.location ?? null,
      description: input.description,
      bodyPart: input.bodyPart ?? null,
      severity: input.severity,
      daysAway: input.daysAway ?? 0,
      daysRestricted: input.daysRestricted ?? 0,
      isRecordable: input.isRecordable ?? true,
      reportedById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

oshaWcEeoRouter.put('/osha/incidents/:id', MANAGE_COMP, async (req, res) => {
  const id = req.params.id;
  const input = OshaUpdateSchema.parse(req.body);
  const resolved = input.status === 'RESOLVED';
  await prisma.oshaIncident.update({
    where: { id },
    data: {
      status: input.status ?? undefined,
      resolutionNote:
        input.resolutionNote === undefined ? undefined : input.resolutionNote,
      daysAway: input.daysAway ?? undefined,
      daysRestricted: input.daysRestricted ?? undefined,
      isRecordable: input.isRecordable ?? undefined,
      resolvedAt: resolved ? new Date() : undefined,
    },
  });
  res.json({ ok: true });
});

/**
 * OSHA Form 300A annual summary aggregates. Returns the seven counts
 * employers post by Feb 1 each year covering the prior calendar year.
 */
oshaWcEeoRouter.get('/osha/300a', VIEW_COMP, async (req, res) => {
  const clientId = z.string().uuid().parse(req.query.clientId);
  const year = z.coerce.number().int().min(2000).max(2100).parse(req.query.year);
  const start = new Date(`${year}-01-01T00:00:00Z`);
  const end = new Date(`${year + 1}-01-01T00:00:00Z`);
  const rows = await prisma.oshaIncident.findMany({
    take: 500,
    where: {
      clientId,
      occurredAt: { gte: start, lt: end },
      isRecordable: true,
    },
  });
  const totalCases = rows.length;
  const fatalities = rows.filter((r) => r.severity === 'FATAL').length;
  const daysAwayCases = rows.filter((r) => r.severity === 'DAYS_AWAY').length;
  const restrictedCases = rows.filter(
    (r) => r.severity === 'RESTRICTED_DUTY',
  ).length;
  const otherRecordable = rows.filter(
    (r) => r.severity === 'MEDICAL_TREATMENT' || r.severity === 'FIRST_AID',
  ).length;
  const totalDaysAway = rows.reduce((s, r) => s + r.daysAway, 0);
  const totalDaysRestricted = rows.reduce((s, r) => s + r.daysRestricted, 0);
  res.json({
    clientId,
    year,
    totalCases,
    fatalities,
    daysAwayCases,
    restrictedCases,
    otherRecordable,
    totalDaysAway,
    totalDaysRestricted,
  });
});

// ----- Workers' Comp class codes -----------------------------------------

const WcInputSchema = z.object({
  stateCode: z.string().length(2).nullable().optional(),
  code: z.string().min(1).max(10),
  description: z.string().min(1).max(500),
  ratePer100: z.number().nonnegative(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

oshaWcEeoRouter.get('/wc/class-codes', VIEW_COMP, async (req, res) => {
  const stateCode = z.string().length(2).optional().parse(req.query.stateCode);
  const rows = await prisma.wcClassCode.findMany({
    take: 1000,
    where: stateCode ? { stateCode } : {},
    orderBy: [{ stateCode: 'asc' }, { code: 'asc' }, { effectiveFrom: 'desc' }],
  });
  res.json({
    codes: rows.map((c) => ({
      id: c.id,
      stateCode: c.stateCode,
      code: c.code,
      description: c.description,
      ratePer100: c.ratePer100.toFixed(4),
      effectiveFrom: c.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: c.effectiveTo?.toISOString().slice(0, 10) ?? null,
    })),
  });
});

oshaWcEeoRouter.post('/wc/class-codes', MANAGE_COMP, async (req, res) => {
  const input = WcInputSchema.parse(req.body);
  const created = await prisma.wcClassCode.create({
    data: {
      stateCode: input.stateCode ?? null,
      code: input.code,
      description: input.description,
      ratePer100: new Prisma.Decimal(input.ratePer100),
      effectiveFrom: new Date(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
    },
  });
  res.status(201).json({ id: created.id });
});

oshaWcEeoRouter.put('/wc/class-codes/:id', MANAGE_COMP, async (req, res) => {
  const id = req.params.id;
  const input = WcInputSchema.partial().parse(req.body);
  await prisma.wcClassCode.update({
    where: { id },
    data: {
      stateCode: input.stateCode === undefined ? undefined : input.stateCode,
      code: input.code ?? undefined,
      description: input.description ?? undefined,
      ratePer100:
        input.ratePer100 !== undefined ? new Prisma.Decimal(input.ratePer100) : undefined,
      effectiveFrom:
        input.effectiveFrom !== undefined ? new Date(input.effectiveFrom) : undefined,
      effectiveTo:
        input.effectiveTo === undefined
          ? undefined
          : input.effectiveTo === null
            ? null
            : new Date(input.effectiveTo),
    },
  });
  res.json({ ok: true });
});

// ----- EEO -----------------------------------------------------------------

const EeoInputSchema = z.object({
  category: z
    .enum([
      'EXEC_SR_OFFICIALS',
      'FIRST_MID_OFFICIALS',
      'PROFESSIONALS',
      'TECHNICIANS',
      'SALES_WORKERS',
      'ADMIN_SUPPORT',
      'CRAFT_WORKERS',
      'OPERATIVES',
      'LABORERS_HELPERS',
      'SERVICE_WORKERS',
    ])
    .nullable()
    .optional(),
  race: z
    .enum([
      'HISPANIC_LATINO',
      'WHITE',
      'BLACK_AFRICAN_AMERICAN',
      'NATIVE_HAWAIIAN_PACIFIC_ISLANDER',
      'ASIAN',
      'AMERICAN_INDIAN_ALASKA_NATIVE',
      'TWO_OR_MORE',
      'NOT_DISCLOSED',
    ])
    .nullable()
    .optional(),
  gender: z.enum(['MALE', 'FEMALE', 'NON_BINARY', 'NOT_DISCLOSED']).nullable().optional(),
  isVeteran: z.boolean().nullable().optional(),
  isDisabled: z.boolean().nullable().optional(),
  selfDeclared: z.boolean().optional(),
});

oshaWcEeoRouter.get('/eeo/associates/:id', VIEW_COMP, async (req, res) => {
  const associateId = req.params.id;
  const row = await prisma.associateEeo.findUnique({ where: { associateId } });
  res.json({ eeo: row });
});

oshaWcEeoRouter.put('/eeo/associates/:id', MANAGE_COMP, async (req, res) => {
  const associateId = req.params.id;
  const input = EeoInputSchema.parse(req.body);
  await prisma.associateEeo.upsert({
    where: { associateId },
    create: {
      associateId,
      category: input.category ?? null,
      race: input.race ?? null,
      gender: input.gender ?? null,
      isVeteran: input.isVeteran ?? null,
      isDisabled: input.isDisabled ?? null,
      selfDeclared: input.selfDeclared ?? true,
    },
    update: {
      category: input.category === undefined ? undefined : input.category,
      race: input.race === undefined ? undefined : input.race,
      gender: input.gender === undefined ? undefined : input.gender,
      isVeteran: input.isVeteran === undefined ? undefined : input.isVeteran,
      isDisabled: input.isDisabled === undefined ? undefined : input.isDisabled,
      selfDeclared: input.selfDeclared ?? undefined,
    },
  });
  res.json({ ok: true });
});

/**
 * EEO-1 aggregate: counts by (category × race × gender) for all active
 * associates of a given client. NOT_DISCLOSED rows count toward the
 * "Decline to Self-Identify" buckets EEOC requires.
 */
oshaWcEeoRouter.get('/eeo/report', VIEW_COMP, async (req, res) => {
  const clientId = z.string().uuid().parse(req.query.clientId);
  // We approximate "associates of a client" via Application linkage; an
  // associate may have applications across clients. Phase 76's
  // ClientPortal scoping already takes this approach.
  const associates = await prisma.associate.findMany({
    take: 1000,
    where: {
      deletedAt: null,
      applications: { some: { clientId } },
    },
    include: { eeo: true },
  });
  const buckets: Record<string, number> = {};
  for (const a of associates) {
    const cat = a.eeo?.category ?? 'UNCATEGORIZED';
    const race = a.eeo?.race ?? 'NOT_DISCLOSED';
    const gender = a.eeo?.gender ?? 'NOT_DISCLOSED';
    const key = `${cat}|${race}|${gender}`;
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  res.json({
    clientId,
    total: associates.length,
    buckets: Object.entries(buckets).map(([key, count]) => {
      const [category, race, gender] = key.split('|');
      return { category, race, gender, count };
    }),
  });
});
