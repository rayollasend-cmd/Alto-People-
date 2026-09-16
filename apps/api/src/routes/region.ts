import { Router } from 'express';
import { z } from 'zod';
import { hasCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';
import { storeSnapshot, type StoreSnapshot } from '../lib/storeSnapshot.js';

/**
 * The region command center — the Manager, Business Operations Support's
 * portal: every store in their region, at a glance, on the same numbers
 * each store manager sees, ranked so the short store is at the top.
 *
 *   GET /region/overview            the region: totals + a card per store
 *   GET /regions                    (manage:org) regions with their stores
 *   POST /regions                   (manage:org) create
 *   PATCH /regions/:id              (manage:org) rename / assign stores
 *   DELETE /regions/:id             (manage:org) retire (stores unassigned)
 *
 * ACCESS: a CLIENT_PORTAL account with a regionId (and no client) sees
 * exactly its region. view:executive / manage:org preview any region via
 * ?regionId=. Drilling into a store from here reuses the store site
 * (/portal?clientId&locationId) — the portal's resolveScope admits a
 * region account to any store in its region.
 */

export const regionRouter = Router();
export const regionsAdminRouter = Router();

async function resolveRegion(user: SessionUser, query: { regionId?: unknown }) {
  let regionId: string;
  if (user.role === 'CLIENT_PORTAL') {
    if (!user.regionId) {
      throw new HttpError(403, 'no_region_assigned', 'No region is linked to this account yet — ask your Alto contact.');
    }
    regionId = user.regionId;
  } else if (hasCapability(user.role, 'view:executive') || hasCapability(user.role, 'manage:org')) {
    if (typeof query.regionId !== 'string' || !query.regionId) {
      throw new HttpError(400, 'region_required', 'Pass ?regionId= to preview a region.');
    }
    regionId = query.regionId;
  } else {
    throw new HttpError(403, 'forbidden', 'The region command center is for region accounts.');
  }
  const region = await prisma.region.findFirst({
    where: { id: regionId, deletedAt: null },
    select: {
      id: true,
      name: true,
      locations: {
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true, timezone: true, clientId: true, client: { select: { name: true } } },
        orderBy: { name: 'asc' },
        take: 200,
      },
    },
  });
  if (!region) throw new HttpError(404, 'region_not_found', 'Region not found');
  return region;
}

const RANK: Record<NonNullable<StoreSnapshot['reliability']['grade']>, number> = { F: 0, D: 1, C: 2, B: 3, A: 4 };

regionRouter.get('/overview', requireAuth, async (req, res, next) => {
  try {
    const region = await resolveRegion(req.user!, req.query);
    const now = new Date();
    const stores = await Promise.all(
      region.locations.map((l) =>
        storeSnapshot(
          { id: l.id, name: l.name, timezone: l.timezone, clientId: l.clientId, clientName: l.client.name },
          now,
        ),
      ),
    );
    // Short stores first, then by grade, then by name.
    stores.sort(
      (a, b) =>
        (b.alert ? 1 : 0) - (a.alert ? 1 : 0) ||
        b.now.short - a.now.short ||
        (a.reliability.grade ? RANK[a.reliability.grade] : 5) - (b.reliability.grade ? RANK[b.reliability.grade] : 5) ||
        a.name.localeCompare(b.name),
    );
    const sum = (f: (s: StoreSnapshot) => number) => stores.reduce((a, s) => a + f(s), 0);
    const graded = stores.filter((s) => s.reliability.score !== null);
    const gradeCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0, none: 0 };
    for (const s of stores) gradeCounts[s.reliability.grade ?? 'none'] = (gradeCounts[s.reliability.grade ?? 'none'] ?? 0) + 1;
    res.json({
      region: { id: region.id, name: region.name },
      generatedAt: now.toISOString(),
      preview: req.user!.role !== 'CLIENT_PORTAL',
      totals: {
        stores: stores.length,
        onFloor: sum((s) => s.now.onFloor),
        target: stores.some((s) => s.now.target !== null) ? sum((s) => s.now.target ?? 0) : null,
        shortNow: stores.filter((s) => s.now.short > 0).length,
        alerts: stores.filter((s) => s.alert).length,
        openToday: sum((s) => s.today.open),
        openTomorrow: sum((s) => s.tomorrow.open),
        unconfirmedTomorrow: sum((s) => s.tomorrow.unconfirmed),
        openRequests: sum((s) => s.requests.open),
        overdueRequests: sum((s) => s.requests.overdue),
        score:
          graded.length > 0
            ? Math.round(graded.reduce((a, s) => a + (s.reliability.score ?? 0), 0) / graded.length)
            : null,
        gradeCounts,
      },
      stores,
    });
  } catch (err) {
    next(err);
  }
});

/* ---- Admin: regions and their stores ----------------------------------- */

const ADMIN = requireCapability('manage:org');

regionsAdminRouter.get('/', requireCapability('view:org'), async (_req, res, next) => {
  try {
    const rows = await prisma.region.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        locations: {
          where: { deletedAt: null },
          select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
          orderBy: { name: 'asc' },
        },
        users: { where: { deletedAt: null, role: 'CLIENT_PORTAL' }, select: { id: true, email: true, status: true } },
      },
      take: 200,
    });
    const unassigned = await prisma.location.findMany({
      where: { deletedAt: null, isActive: true, regionId: null },
      select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
      orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
      take: 500,
    });
    res.json({
      regions: rows.map((r) => ({
        id: r.id,
        name: r.name,
        stores: r.locations.map((l) => ({ id: l.id, name: l.name, clientId: l.clientId, clientName: l.client.name })),
        accounts: r.users,
      })),
      unassigned: unassigned.map((l) => ({ id: l.id, name: l.name, clientId: l.clientId, clientName: l.client.name })),
    });
  } catch (err) {
    next(err);
  }
});

const RegionInput = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  /** Full replacement of the region's stores. */
  locationIds: z.array(z.string().uuid()).max(500).optional(),
});

regionsAdminRouter.post('/', ADMIN, async (req, res, next) => {
  try {
    const input = RegionInput.extend({ name: z.string().trim().min(2).max(120) }).parse(req.body);
    const region = await prisma.region.create({ data: { name: input.name }, select: { id: true } });
    if (input.locationIds?.length) {
      await prisma.location.updateMany({ where: { id: { in: input.locationIds } }, data: { regionId: region.id } });
    }
    res.status(201).json({ id: region.id });
  } catch (err) {
    next(err);
  }
});

regionsAdminRouter.patch('/:id', ADMIN, async (req, res, next) => {
  try {
    const input = RegionInput.parse(req.body);
    const region = await prisma.region.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { id: true } });
    if (!region) throw new HttpError(404, 'region_not_found', 'Region not found');
    await prisma.$transaction(async (tx) => {
      if (input.name) await tx.region.update({ where: { id: region.id }, data: { name: input.name } });
      if (input.locationIds) {
        await tx.location.updateMany({ where: { regionId: region.id }, data: { regionId: null } });
        if (input.locationIds.length) {
          await tx.location.updateMany({ where: { id: { in: input.locationIds } }, data: { regionId: region.id } });
        }
      }
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

regionsAdminRouter.delete('/:id', ADMIN, async (req, res, next) => {
  try {
    const region = await prisma.region.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { id: true } });
    if (!region) throw new HttpError(404, 'region_not_found', 'Region not found');
    await prisma.$transaction([
      prisma.location.updateMany({ where: { regionId: region.id }, data: { regionId: null } }),
      prisma.user.updateMany({ where: { regionId: region.id }, data: { regionId: null, tokenVersion: { increment: 1 } } }),
      prisma.region.update({ where: { id: region.id }, data: { deletedAt: new Date() } }),
    ]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
