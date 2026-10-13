import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';

/**
 * ONE DEFINITION OF "ACTIVE" (Brief 1A-2, applied here ahead of that brief).
 *
 * An active associate: has an open assignment (or an approved application)
 * at the site, is not separated or deactivated, and has either a verified
 * clock-in in the trailing window or a future assigned shift. The window
 * is configurable; the default is 14 days.
 *
 * Every headcount the planner compares against reads this. When Brief 1A-2
 * lands, the dashboard and the directory should move onto it too.
 */

export interface ActiveDefinitionOptions {
  windowDays?: number;
  locationId?: string | null;
  clientId?: string | null;
}

export const DEFAULT_ACTIVE_WINDOW_DAYS = 14;

export async function activeAssociateIds(
  opts: ActiveDefinitionOptions = {},
  now: Date = new Date(),
  db: PrismaClient = defaultPrisma,
): Promise<Set<string>> {
  const windowDays = opts.windowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS;
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const siteFilter = opts.locationId
    ? { locationId: opts.locationId }
    : opts.clientId
      ? { location: { clientId: opts.clientId } }
      : {};
  const placed = await db.associateAssignment.findMany({
    where: { endedAt: null, ...siteFilter, associate: { deletedAt: null, separatedAt: null, deactivatedAt: null } },
    select: { associateId: true },
  });
  const ids = [...new Set(placed.map((p) => p.associateId))];
  if (ids.length === 0) return new Set();
  const [worked, scheduled] = await Promise.all([
    db.timeEntry.findMany({
      where: { associateId: { in: ids }, clockInAt: { gte: since }, status: { not: 'REJECTED' } },
      select: { associateId: true },
      distinct: ['associateId'],
    }),
    db.shift.findMany({
      where: { assignedAssociateId: { in: ids }, startsAt: { gte: now }, status: { in: ['ASSIGNED'] } },
      select: { assignedAssociateId: true },
      distinct: ['assignedAssociateId'],
    }),
  ]);
  const out = new Set<string>();
  for (const w of worked) out.add(w.associateId);
  for (const s of scheduled) if (s.assignedAssociateId) out.add(s.assignedAssociateId);
  return out;
}

export async function activeHeadcount(opts: ActiveDefinitionOptions = {}, now: Date = new Date(), db: PrismaClient = defaultPrisma): Promise<number> {
  return (await activeAssociateIds(opts, now, db)).size;
}
