import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { tenantIdForWrite } from './tenant.js';
import { fmtDayInZone } from './humanDates.js';

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
  /**
   * Brief 2-1: count only this tenant's people. Omitted, every tenant
   * counts (today's behaviour, and every existing row is Alto HR's).
   */
  tenantId?: string | null;
  /**
   * Only these people. A page of a list asks about its own rows instead of
   * the whole tenant (the people directory computed every associate's
   * standing per request; at 50,000 that was five seconds a page).
   */
  associateIds?: string[];
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
/** Ids per evidence query: well under Postgres's 65,535-parameter limit with room for the scope. */
const ACTIVE_ID_BATCH = 10_000;

export async function activeWindowDays(db: Db = defaultPrisma): Promise<number> {
  const row = await db.orgSetting.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { activeWindowDays: true } });
  return row?.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS;
}

async function clientOfLocation(db: Db, locationId: string): Promise<string | null> {
  const loc = await db.site.findUnique({ where: { id: locationId }, select: { clientId: true } });
  return loc?.clientId ?? null;
}

/**
 * Brief 2-1b: a site scope needs to know whether the site exists at all
 * (unknown → nobody) apart from whether it has a client (a direct
 * employer's property has none, and is scoped to the site alone).
 */
async function siteScope(db: Db, locationId: string): Promise<{ exists: boolean; clientId: string | null }> {
  const loc = await db.site.findUnique({ where: { id: locationId }, select: { clientId: true } });
  return { exists: !!loc, clientId: loc?.clientId ?? null };
}

/**
 * Where each employed associate is placed, in scope. The open assignment
 * wins; an approved application places only someone with no open
 * assignment anywhere (a transfer moves the assignment, the application
 * stays behind).
 */
export async function placements(scope: ActiveScope = {}, db: Db = defaultPrisma): Promise<Map<string, Placement>> {
  const out = new Map<string, Placement>();
  const site = scope.locationId ? await siteScope(db, scope.locationId) : null;
  if (site && !site.exists) return out;
  const scopeClientId = scope.clientId ?? site?.clientId ?? null;
  // A client-less site (a direct employer's property): the site alone, never the client-wide fallbacks.
  const siteOnly = !!scope.locationId && !scopeClientId;

  const assigned = await db.associateAssignment.findMany({
    where: {
      endedAt: null,
      ...(scope.associateIds ? { associateId: { in: scope.associateIds } } : {}),
      ...(scope.locationId ? { locationId: scope.locationId } : scopeClientId ? { location: { clientId: scopeClientId } } : {}),
      associate: { ...EMPLOYED_WHERE, ...(scope.tenantId ? { tenantId: scope.tenantId } : {}) },
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
      ...(scope.associateIds ? { associateId: { in: scope.associateIds } } : {}),
      ...(scopeClientId ? { clientId: scopeClientId } : {}),
      ...(siteOnly ? { locationId: scope.locationId! } : scope.locationId ? { OR: [{ locationId: scope.locationId }, { locationId: null }] } : {}),
      associate: { ...EMPLOYED_WHERE, assignments: { none: { endedAt: null } }, ...(scope.tenantId ? { tenantId: scope.tenantId } : {}) },
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
  // A client-less site counts only punches at the site: a punch with neither location nor client is not this site's.
  const entryScope: Prisma.TimeEntryWhereInput = scope.locationId && !scopeClientId
    ? { locationId: scope.locationId }
    : scope.locationId
    ? { OR: [{ locationId: scope.locationId }, { locationId: null, clientId: scopeClientId }] }
    : scopeClientId
      ? { clientId: scopeClientId }
      : {};
  const shiftScope: Prisma.ShiftWhereInput = scope.locationId ? { locationId: scope.locationId } : scopeClientId ? { clientId: scopeClientId } : {};
  // In batches: at tens of thousands of ids the negated status filter stops
  // Prisma from splitting the id list itself and Postgres refuses the
  // parameter count (seen at 50,000 associates in the load test).
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += ACTIVE_ID_BATCH) batches.push(ids.slice(i, i + ACTIVE_ID_BATCH));
  for (const batch of batches) {
    const [worked, scheduled] = await Promise.all([
      db.timeEntry.findMany({
        where: { associateId: { in: batch }, clockInAt: { gte: since, lte: now }, status: { not: 'REJECTED' }, ...entryScope },
        select: { associateId: true },
        distinct: ['associateId'],
      }),
      db.shift.findMany({
        where: { assignedAssociateId: { in: batch }, startsAt: { gte: now }, status: 'ASSIGNED', ...shiftScope },
        select: { assignedAssociateId: true },
        distinct: ['assignedAssociateId'],
      }),
    ]);
    for (const w of worked) out.add(w.associateId);
    for (const s of scheduled) if (s.assignedAssociateId) out.add(s.assignedAssociateId);
  }
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

/**
 * The active set and every placement it was read from, in one pass, for
 * the one status per person (lib/peopleStatus): "No recent shifts" is
 * placed but not active, so it needs both halves of the same reading.
 */
export async function activeAndPlaced(
  opts: ActiveDefinitionOptions = {},
  now: Date = new Date(),
  db: Db = defaultPrisma,
): Promise<{ active: Set<string>; placed: Map<string, Placement>; windowDays: number }> {
  const windowDays = opts.windowDays ?? (await activeWindowDays(db));
  const placed = await placements(opts, db);
  if (placed.size === 0) return { active: new Set(), placed, windowDays };
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  return { active: await workedOrScheduled([...placed.keys()], opts, since, now, db), placed, windowDays };
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
export async function activeBreakdown(
  now: Date = new Date(),
  db: Db = defaultPrisma,
  windowDays?: number,
  /** associateIds: only these people (a site/region-bound caller's reach). */
  opts: { tenantId?: string | null; associateIds?: string[] } = {},
): Promise<ActiveBreakdown> {
  const days = windowDays ?? (await activeWindowDays(db));
  const placed = await placements({ ...(opts.tenantId ? { tenantId: opts.tenantId } : {}), ...(opts.associateIds ? { associateIds: opts.associateIds } : {}) }, db);
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
  else reason = lastEntry ? `Last clock-in ${fmtDayInZone(lastEntry.clockInAt)} is outside the ${windowDays}-day window and nothing is scheduled.` : `Never clocked in and nothing is scheduled.`;
  return { active, employed, placement, lastClockInAt: lastEntry?.clockInAt ?? null, nextShiftAt: nextShift?.startsAt ?? null, windowDays, reason };
}

/**
 * Brief 2-6 step 4 (decision 2) — who is active on a day, by worker type, for
 * billing. The one rule, extended here and nowhere else:
 *
 *   PERSON  the rule above (activeAssociateIds), read at the day's end;
 *   AGENT   a Worker of type AGENT, status ACTIVE, with at least one audited
 *           action in the day (every agent call writes AuditLog.workerId);
 *   ROBOT   a Worker of type ROBOT, status ACTIVE, at a site that day (an
 *           assignment overlapping it) or on a shift starting in it.
 *
 * `from` and `to` are the day's bounds in the organization's time zone.
 */
export async function activeWorkersBetween(
  tenantId: string,
  from: Date,
  to: Date,
  db: Db = defaultPrisma,
): Promise<{ PERSON: string[]; AGENT: string[]; ROBOT: string[] }> {
  const people = await activeAssociateIds({ tenantId }, to, db);
  const agents = await db.worker.findMany({ where: { tenantId, type: 'AGENT', status: 'ACTIVE' }, select: { id: true } });
  const acted = agents.length
    ? await db.auditLog.findMany({ where: { workerId: { in: agents.map((a) => a.id) }, createdAt: { gte: from, lt: to } }, select: { workerId: true }, distinct: ['workerId'] })
    : [];
  const robots = await db.worker.findMany({
    where: {
      tenantId,
      type: 'ROBOT',
      status: 'ACTIVE',
      OR: [
        { assignments: { some: { startedAt: { lt: to }, OR: [{ endedAt: null }, { endedAt: { gte: from } }] } } },
        { shifts: { some: { startsAt: { gte: from, lt: to }, status: { not: 'CANCELLED' } } } },
      ],
    },
    select: { id: true },
  });
  return {
    PERSON: [...people].sort(),
    AGENT: acted.map((a) => a.workerId!).filter(Boolean).sort(),
    ROBOT: robots.map((r) => r.id).sort(),
  };
}
