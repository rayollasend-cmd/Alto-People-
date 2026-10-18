import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { internalSites, scopeAssociates } from '../lib/scope.js';
import { accountPhotoUrlFor, profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Succession, shaped like the business: the seats that run a store (its
 * shift and floor leads) and who could take one — ready now, in six
 * months, in a year — store by store. And the 9-box: performance (the
 * latest review) against potential (rated here by HR).
 *
 * Reads clamp to the caller's reach (sites/regions, a bounded client);
 * the corporate positions view stays in routes/succession115.ts.
 */

export const successionBenchRouter = Router();

const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:performance');

const READINESS = z.enum(['READY_NOW', 'READY_6_MONTHS', 'READY_12_MONTHS']);

const name = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

/** Is this person someone the caller may put on a bench (in reach, employed)? */
async function assertCandidate(req: Parameters<Parameters<typeof successionBenchRouter.get>[1]>[0], associateId: string) {
  const ok = await prisma.associate.findFirst({
    where: { AND: [{ id: associateId, tenantId: tenantIdForWrite(), deletedAt: null, deactivatedAt: null }, scopeAssociates(req.user!)] },
    select: { id: true },
  });
  if (!ok) throw new HttpError(404, 'associate_not_found', 'No such person in your reach.');
}

async function storeInReach(req: Parameters<Parameters<typeof successionBenchRouter.get>[1]>[0], locationId: string) {
  const reach = internalSites(req.user!);
  const store = await prisma.site.findFirst({
    where: { AND: [{ id: locationId, tenantId: tenantIdForWrite(), deletedAt: null }, reach ?? {}] },
    select: { id: true, name: true },
  });
  if (!store) throw new HttpError(404, 'store_not_found', 'No such store in your reach.');
  return store;
}

/** GET /succession/stores?clientId= — every store's leads and its bench. */
successionBenchRouter.get('/succession/stores', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const tenantId = tenantIdForWrite();
  const reach = internalSites(req.user!);
  const stores = await prisma.site.findMany({
    where: { AND: [{ tenantId, deletedAt: null, isActive: true }, reach ?? {}, clientId ? { clientId } : {}] },
    orderBy: { name: 'asc' },
    take: 1000,
    select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
  });
  const ids = stores.map((s) => s.id);
  const [leads, bench] = await Promise.all([
    prisma.user.findMany({
      where: { tenantId, deletedAt: null, status: { not: 'DISABLED' }, role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] }, locationId: { in: ids } },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        locationId: true,
        photoS3Key: true,
        photoUpdatedAt: true,
        associate: { select: { id: true, firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true } },
      },
    }),
    prisma.leadBenchCandidate.findMany({
      where: { tenantId, locationId: { in: ids }, associate: { deletedAt: null, deactivatedAt: null } },
      orderBy: [{ readiness: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        locationId: true,
        readiness: true,
        notes: true,
        associate: { select: { id: true, firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true, jobProfile: { select: { title: true } } } },
      },
    }),
  ]);
  const rows = stores.map((s) => {
    const mine = bench.filter((b) => b.locationId === s.id);
    const readyNow = mine.filter((b) => b.readiness === 'READY_NOW').length;
    return {
      id: s.id,
      name: s.name,
      clientId: s.clientId,
      clientName: s.client?.name ?? null,
      leads: leads
        .filter((l) => l.locationId === s.id)
        .map((l) => ({
          userId: l.id,
          associateId: l.associate?.id ?? null,
          name: l.associate ? name(l.associate) : l.displayName?.trim() || l.email,
          role: l.role,
          photoUrl: accountPhotoUrlFor(l),
        })),
      bench: mine.map((b) => ({
        id: b.id,
        associateId: b.associate.id,
        name: name(b.associate),
        title: b.associate.jobProfile?.title ?? null,
        photoUrl: profilePhotoUrlFor(b.associate),
        readiness: b.readiness,
        notes: b.notes,
      })),
      // Covered: someone could step in today. Thin: only later. Empty: no one.
      strength: readyNow > 0 ? ('covered' as const) : mine.length > 0 ? ('thin' as const) : ('empty' as const),
    };
  });
  res.json({
    stores: rows,
    summary: {
      stores: rows.length,
      covered: rows.filter((r) => r.strength === 'covered').length,
      thin: rows.filter((r) => r.strength === 'thin').length,
      empty: rows.filter((r) => r.strength === 'empty').length,
      withoutLead: rows.filter((r) => r.leads.length === 0).length,
    },
  });
});

const BenchInput = z.object({ associateId: z.string().uuid(), readiness: READINESS, notes: z.string().trim().max(1000).optional().nullable() });

successionBenchRouter.post('/succession/stores/:locationId/bench', MANAGE, async (req, res) => {
  const locationId = z.string().uuid().parse(req.params.locationId);
  const input = BenchInput.parse(req.body ?? {});
  const store = await storeInReach(req, locationId);
  await assertCandidate(req, input.associateId);
  try {
    const created = await prisma.leadBenchCandidate.create({
      data: { tenantId: tenantIdForWrite(), locationId: store.id, associateId: input.associateId, readiness: input.readiness, notes: input.notes ?? null, createdById: req.user!.id },
      select: { id: true },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'succession.bench_added', entityType: 'LeadBenchCandidate', entityId: created.id, metadata: { locationId, associateId: input.associateId, readiness: input.readiness } }, 'succession.bench');
    res.status(201).json(created);
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new HttpError(409, 'already_on_bench', 'They are already on this store’s bench.');
    throw err;
  }
});

async function benchRow(req: Parameters<Parameters<typeof successionBenchRouter.get>[1]>[0], id: string) {
  const row = await prisma.leadBenchCandidate.findFirst({ where: { id, tenantId: tenantIdForWrite() }, select: { id: true, locationId: true } });
  if (!row) throw new HttpError(404, 'not_found', 'Not found.');
  await storeInReach(req, row.locationId);
  return row;
}

successionBenchRouter.patch('/succession/bench/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = z.object({ readiness: READINESS.optional(), notes: z.string().trim().max(1000).optional().nullable() }).parse(req.body ?? {});
  await benchRow(req, id);
  await prisma.leadBenchCandidate.update({
    where: { id },
    data: { ...(input.readiness ? { readiness: input.readiness } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}) },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'succession.bench_updated', entityType: 'LeadBenchCandidate', entityId: id, metadata: input }, 'succession.bench');
  res.json({ ok: true });
});

successionBenchRouter.delete('/succession/bench/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await benchRow(req, id);
  await prisma.leadBenchCandidate.delete({ where: { id } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'succession.bench_removed', entityType: 'LeadBenchCandidate', entityId: id }, 'succession.bench');
  res.status(204).end();
});

/* ----- 9-box ---------------------------------------------------------------- */

/** Review rating 1–5 → performance band 1 (low) – 3 (high). */
const perfBand = (rating: number) => (rating <= 2 ? 1 : rating === 3 ? 2 : 3);

/**
 * GET /succession/nine-box?clientId= — everyone in reach with a review or a
 * potential rating, placed on performance (latest shared review) × potential.
 * People missing one of the two are listed separately, so HR knows what to rate.
 */
successionBenchRouter.get('/succession/nine-box', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const tenantId = tenantIdForWrite();
  const where: Prisma.AssociateWhereInput = {
    AND: [
      { tenantId, deletedAt: null, deactivatedAt: null },
      scopeAssociates(req.user!),
      clientId ? { assignments: { some: { endedAt: null, location: { is: { clientId } } } } } : {},
      { OR: [{ talentRating: { isNot: null } }, { performanceReviews: { some: { status: { in: ['SUBMITTED', 'ACKNOWLEDGED'] } } } }] },
    ],
  };
  const LIMIT = 2000;
  const people = await prisma.associate.findMany({
    where,
    take: LIMIT + 1,
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      photoS3Key: true,
      photoUpdatedAt: true,
      jobProfile: { select: { title: true } },
      talentRating: { select: { potential: true, notes: true } },
      performanceReviews: {
        where: { status: { in: ['SUBMITTED', 'ACKNOWLEDGED'] } },
        orderBy: { periodEnd: 'desc' },
        take: 1,
        select: { overallRating: true },
      },
    },
  });
  const truncated = people.length > LIMIT;
  const rows = people.slice(0, LIMIT).map((p) => {
    const rating = p.performanceReviews[0]?.overallRating ?? null;
    return {
      associateId: p.id,
      name: name(p),
      title: p.jobProfile?.title ?? null,
      photoUrl: profilePhotoUrlFor(p),
      reviewRating: rating,
      performance: rating === null ? null : perfBand(rating),
      potential: p.talentRating?.potential ?? null,
      potentialNotes: p.talentRating?.notes ?? null,
    };
  });
  res.json({ people: rows, truncated, limit: LIMIT });
});

successionBenchRouter.put('/succession/potential/:associateId', MANAGE, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  const input = z.object({ potential: z.number().int().min(1).max(3), notes: z.string().trim().max(1000).optional().nullable() }).parse(req.body ?? {});
  await assertCandidate(req, associateId);
  await prisma.talentRating.upsert({
    where: { associateId },
    create: { tenantId: tenantIdForWrite(), associateId, potential: input.potential, notes: input.notes ?? null, ratedById: req.user!.id },
    update: { potential: input.potential, notes: input.notes ?? null, ratedById: req.user!.id, ratedAt: new Date() },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'succession.potential_rated', entityType: 'Associate', entityId: associateId, metadata: { potential: input.potential } }, 'succession.potential');
  res.json({ ok: true });
});
