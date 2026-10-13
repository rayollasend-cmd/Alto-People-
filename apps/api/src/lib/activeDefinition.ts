import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';

/**
 * ONE DEFINITION OF "ACTIVE" (Brief 1A-2).
 *
 *   An active associate is EMPLOYED (not deleted, erased, separated or
 *   deactivated), PLACED (an open assignment at a site, or, with no open
 *   assignment anywhere, an approved application at a client), and has
 *   RECENT WORK there: a clock-in in the trailing window that was not
 *   rejected, or a future shift assigned to them. The window is the
 *   company setting OrgSetting.activeWindowDays (14 by default).
 *
 *   Scoped to a site or a client, both the placement and the work are read
 *   at that site or client, so a person placed at two stores counts once
 *   per store they actually work at and once for the company.
 *
 *   Every headcount on the platform reads this module: the dashboards, the
 *   directory badge, the executive summary, the clients list, the
 *   compliance scorecard, the audit packet roster, the Headcount screen,
 *   the season planner and the reconciliation report. Screens that mean
 *   something else ("on the floor now" = an open punch; "scheduled this
 *   week" = an assigned shift) say so and do not call it "active".
 *
 *   EMPLOYED_WHERE is the shared employment predicate for the surfaces
 *   that need everyone who can be scheduled, active or not: the scheduling
 *   pools, a manager's direct reports, the compliance populations.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_ACTIVE_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

/** Not deleted, erased, separated or deactivated. */
export const EMPLOYED_WHERE = {
  deletedAt: null,
  erasedAt: null,
  separatedAt: null,
  deactivatedAt: null,
} satisfies Prisma.AssociateWhereInput;

export interface ActiveScope {
  locationId?: string | null;
  clientId?: string | null;
}

export interface ActiveDefinitionOptions extends ActiveScope {
  /** Trailing days of work that count; defaults to the company setting. */
  windowDays?: number;
}

export interface Placement {
  associateId: string;
  /** Null for a direct employer's site (Brief 2-1b): the placement is the site alone. */
  clientId: string | null;
  locationId: string | null;
  source: 'assignment' | 'application';
}

/** The company's window, read each call (cheap: one indexed row). */
export async function activeWindowDays(db: Db = defaultPrisma): Promise<number> {
  const row = await db.orgSetting.findUnique({ where: { id: 'singleton' }, select: { activeWindowDays: true } });
  return row?.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS;
}

async function clientOfLocation(db: Db, locationId: string): Promise<string | null> {
  const loc = await db.location.findUnique({ where: { id: locationId }, select: { clientId: true } });
  return loc?.clientId ?? null;
}

/**
 * Where each employed associate is placed, in scope. The open assignment
 * wins; an approved application places only someone with no open
 * assignment anywhere (a transfer moves the assignment, the application
 * stays behind).
 */
export async function placements(scope: ActiveScope = {}, db: Db = defaultPrisma): Promise<Map<string, Placement>> {
  const out = new Map<string, Placement>();
  const scopeClientId = scope.clientId ?? (scope.locationId ? await clientOfLocation(db, scope.locationId) : null);
  if (scope.locationId && !scopeClientId) return out;

  const assigned = await db.associateAssignment.findMany({
    where: {
      endedAt: null,
      ...(scope.locationId ? { locationId: scope.locationId } : scopeClientId ? { location: { clientId: scopeClientId } } : {}),
      associate: EMPLOYED_WHERE,
    },
    select: { associateId: true, locationId: true, location: { select: { clientId: true } } },
    orderBy: { startedAt: 'desc' },
  });
  for (const a of assigned) {
    if (!out.has(a.associateId)) out.set(a.associateId, { associateId: a.associateId, clientId: a.location.clientId, locationId: a.locationId, source: 'assignment' });
  }

  const applied = await db.application.findMany({
    where: {
      status: 'APPROVED',
      deletedAt: null,
      ...(scopeClientId ? { clientId: scopeClientId } : {}),
      ...(scope.locationId ? { OR: [{ locationId: scope.locationId }, { locationId: null }] } : {}),
      associate: { ...EMPLOYED_WHERE, assignments: { none: { endedAt: null } } },
    },
    select: { associateId: true, clientId: true, locationId: true },
    orderBy: { approvedAt: 'desc' },
  });
  for (const a of applied) {
    if (!out.has(a.associateId)) out.set(a.associateId, { associateId: a.associateId, clientId: a.clientId, locationId: a.locationId, source: 'application' });
  }
  return out;
}

/** The ids that worked in scope within the window, or have a future assigned shift there. */
async function workedOrScheduled(ids: string[], scope: ActiveScope, since: Date, now: Date, db: Db): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const scopeClientId = scope.clientId ?? (scope.locationId ? await clientOfLocation(db, scope.locationId) : null);
  // A kiosk punch may carry no location; under a site scope it counts when the client matches.
  const entryScope: Prisma.TimeEntryWhereInput = scope.locationId
    ? { OR: [{ locationId: scope.locationId }, { locationId: null, clientId: scopeClientId }] }
    : scopeClientId
      ? { clientId: scopeClientId }
      : {};
  const shiftScope: Prisma.ShiftWhereInput = scope.locationId ? { locationId: scope.locationId } : scopeClientId ? { clientId: scopeClientId } : {};
  const [worked, scheduled] = await Promise.all([
    db.timeEntry.findMany({
      where: { associateId: { in: ids }, clockInAt: { gte: since, lte: now }, status: { not: 'REJECTED' }, ...entryScope },
      select: { associateId: true },
      distinct: ['associateId'],
    }),
    db.shift.findMany({
      where: { assignedAssociateId: { in: ids }, startsAt: { gte: now }, status: 'ASSIGNED', ...shiftScope },
      select: { assignedAssociateId: true },
      distinct: ['assignedAssociateId'],
    }),
  ]);
  for (const w of worked) out.add(w.associateId);
  for (const s of scheduled) if (s.assignedAssociateId) out.add(s.assignedAssociateId);
  return out;
}

/** The one definition: the ids active in scope right now. */
export async function activeAssociateIds(opts: ActiveDefinitionOptions = {}, now: Date = new Date(), db: Db = defaultPrisma): Promise<Set<string>> {
  const windowDays = opts.windowDays ?? (await activeWindowDays(db));
  const placed = await placements(opts, db);
  if (placed.size === 0) return new Set();
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  return workedOrScheduled([...placed.keys()], opts, since, now, db);
}

export async function activeHeadcount(opts: ActiveDefinitionOptions = {}, now: Date = new Date(), db: Db = defaultPrisma): Promise<number> {
  return (await activeAssociateIds(opts, now, db)).size;
}

export interface ActiveBreakdown {
  windowDays: number;
  total: number;
  ids: Set<string>;
  /** Where each active associate counts, by their placement. */
  placements: Map<string, Placement>;
  byClient: Map<string, number>;
  byLocation: Map<string, number>;
}

/**
 * The company's active associates with their placement, in one pass, for
 * the surfaces that show a number per client or per store beside the
 * total (the Headcount screen, the clients list, the executive summary).
 * Company-wide work counts here: a placement says where the person
 * belongs, the per-site view (activeAssociateIds with a scope) says where
 * they worked.
 */
export async function activeBreakdown(now: Date = new Date(), db: Db = defaultPrisma, windowDays?: number): Promise<ActiveBreakdown> {
  const days = windowDays ?? (await activeWindowDays(db));
  const placed = await placements({}, db);
  const since = new Date(now.getTime() - days * DAY_MS);
  const ids = await workedOrScheduled([...placed.keys()], {}, since, now, db);
  const byClient = new Map<string, number>();
  const byLocation = new Map<string, number>();
  const kept = new Map<string, Placement>();
  for (const id of ids) {
    const p = placed.get(id);
    if (!p) continue;
    kept.set(id, p);
    if (p.clientId) byClient.set(p.clientId, (byClient.get(p.clientId) ?? 0) + 1);
    if (p.locationId) byLocation.set(p.locationId, (byLocation.get(p.locationId) ?? 0) + 1);
  }
  return { windowDays: days, total: ids.size, ids, placements: kept, byClient, byLocation };
}

export interface ActiveExplanation {
  active: boolean;
  employed: boolean;
  placement: Placement | null;
  lastClockInAt: Date | null;
  nextShiftAt: Date | null;
  windowDays: number;
  /** One line a person can read. */
  reason: string;
}

/** Why one associate is, or is not, active — for the directory drawer and audits. */
export async function explainActive(associateId: string, now: Date = new Date(), db: Db = defaultPrisma): Promise<ActiveExplanation> {
  const windowDays = await activeWindowDays(db);
  const a = await db.associate.findUnique({ where: { id: associateId }, select: { deletedAt: true, erasedAt: true, separatedAt: true, deactivatedAt: true } });
  const employed = !!a && !a.deletedAt && !a.erasedAt && !a.separatedAt && !a.deactivatedAt;
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  const [placed, lastEntry, nextShift] = await Promise.all([
    placements({}, db),
    db.timeEntry.findFirst({ where: { associateId, status: { not: 'REJECTED' }, clockInAt: { lte: now } }, orderBy: { clockInAt: 'desc' }, select: { clockInAt: true } }),
    db.shift.findFirst({ where: { assignedAssociateId: associateId, status: 'ASSIGNED', startsAt: { gte: now } }, orderBy: { startsAt: 'asc' }, select: { startsAt: true } }),
  ]);
  const placement = placed.get(associateId) ?? null;
  const worked = !!lastEntry && lastEntry.clockInAt >= since;
  const scheduled = !!nextShift;
  const active = employed && !!placement && (worked || scheduled);
  let reason: string;
  if (!a) reason = 'No such associate.';
  else if (a.deletedAt || a.erasedAt) reason = 'Record removed.';
  else if (a.separatedAt) reason = 'Separated.';
  else if (a.deactivatedAt) reason = 'Deactivated.';
  else if (!placement) reason = 'Not placed at any site (no open assignment or approved application).';
  else if (worked) reason = `Clocked in within the last ${windowDays} days.`;
  else if (scheduled) reason = 'Has a shift assigned ahead.';
  else reason = lastEntry ? `Last clock-in ${lastEntry.clockInAt.toISOString().slice(0, 10)} is outside the ${windowDays}-day window and nothing is scheduled.` : `Never clocked in and nothing is scheduled.`;
  return { active, employed, placement, lastClockInAt: lastEntry?.clockInAt ?? null, nextShiftAt: nextShift?.startsAt ?? null, windowDays, reason };
}
