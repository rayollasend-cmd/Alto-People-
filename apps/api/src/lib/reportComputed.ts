import type { PrismaClient } from '@prisma/client';
import type { Capability } from '@alto-people/shared';
import type { SessionUser } from '../types/express.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from './tenant.js';
import { scopeAssociates, scopeAssociatesIncludingFormer, scopeCandidates, scopeTimeEntries } from './scope.js';
import { startOfWeekForSite, startOfWeekUTC } from './timeAnomalies.js';
import { loadLiveRules } from './laborRules/live.js';
import { splitByPerson, type HoursEntry } from './laborRules/hours.js';

/**
 * The report builder's computed columns (HR walk 17, wave 2): the answers a
 * template needs that no single table column holds —
 *
 *   ASSOCIATE.store / client / active   where a person works now (their open
 *                                       placement) — headcount by store
 *   PAY_CHANGE                          compensation change records with the
 *                                       amount before and the change
 *   TIME_TO_FILL                        a hire against the posting it filled:
 *                                       posting opened → hired, in days
 *   OVERTIME                            overtime hours by store and week, from
 *                                       the labor engine's split
 *                                       (lib/laborRules/hours) — the same hours
 *                                       the paycheck pays
 *
 * These rows are built here and the spec's filters, sort and group-by run
 * over them in memory, with the same operators and the same caller scope as
 * the database path (lib/reportRun). Every loader is bounded by the spec's
 * date filter, or a default window when there is none.
 */

type Db = PrismaClient;
type Row = Record<string, unknown>;
export type Window = { gte?: Date; lt?: Date };

const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface ComputedEntity {
  /** Public column key → itself (the whitelist shape lib/reportRun reads). */
  columns: string[];
  /** Columns sum/avg/min/max may roll up. */
  numeric: string[];
  /** The date column a period filter narrows the load by. */
  dateColumn: string;
  /** With no filter on the date column, how far back the load reaches. */
  defaultDays: number;
  capability?: Capability;
  load(db: Db, user: SessionUser, window: Window, now: Date): Promise<Row[]>;
}

/* ----- ASSOCIATE: where a person works now --------------------------------- */

/** ASSOCIATE columns that only the in-memory path can serve. */
export const ASSOCIATE_COMPUTED_COLUMNS = ['store', 'client', 'active'] as const;

async function loadAssociates(db: Db, user: SessionUser): Promise<Row[]> {
  const rows = await db.associate.findMany({
    where: { AND: [scopeAssociates(user), { tenantId: tenantIdForWrite() }] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      state: true,
      createdAt: true,
      hireDate: true,
      employmentType: true,
      separatedAt: true,
      deactivatedAt: true,
      assignments: {
        where: { endedAt: null },
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { location: { select: { name: true, client: { select: { name: true } } } } },
      },
    },
    take: 50_000,
  });
  return rows.map(({ assignments, deactivatedAt, ...a }) => ({
    ...a,
    store: assignments[0]?.location.name ?? null,
    client: assignments[0]?.location.client?.name ?? null,
    active: a.separatedAt === null && deactivatedAt === null,
  }));
}

/* ----- PAY_CHANGE: compensation changes with the amount before -------------- */

const PAY_CHANGE: ComputedEntity = {
  columns: ['id', 'associateId', 'name', 'store', 'effectiveFrom', 'payType', 'previousAmount', 'amount', 'change', 'changePct', 'reason', 'createdAt'],
  numeric: ['previousAmount', 'amount', 'change', 'changePct'],
  dateColumn: 'effectiveFrom',
  defaultDays: 365,
  capability: 'view:comp',
  async load(db, user, window) {
    const tenantId = tenantIdForWrite();
    const inWindow = await db.compensationRecord.findMany({
      where: {
        tenantId,
        associate: { is: scopeAssociatesIncludingFormer(user) },
        effectiveFrom: { ...(window.gte ? { gte: window.gte } : {}), ...(window.lt ? { lt: window.lt } : {}) },
      },
      select: {
        id: true,
        associateId: true,
        effectiveFrom: true,
        payType: true,
        amount: true,
        reason: true,
        createdAt: true,
        associate: {
          select: {
            firstName: true,
            lastName: true,
            assignments: { where: { endedAt: null }, orderBy: { startedAt: 'desc' }, take: 1, select: { location: { select: { name: true } } } },
          },
        },
      },
      orderBy: { effectiveFrom: 'asc' },
      take: 20_000,
    });
    if (inWindow.length === 0) return [];
    // The record each change replaced: the person's latest one before it.
    const ids = [...new Set(inWindow.map((r) => r.associateId))];
    const history = await db.compensationRecord.findMany({
      where: { tenantId, associateId: { in: ids } },
      select: { id: true, associateId: true, effectiveFrom: true, amount: true },
      orderBy: { effectiveFrom: 'asc' },
      take: 100_000,
    });
    const byPerson = new Map<string, typeof history>();
    for (const h of history) byPerson.set(h.associateId, [...(byPerson.get(h.associateId) ?? []), h]);
    return inWindow.map((r) => {
      const earlier = (byPerson.get(r.associateId) ?? []).filter((h) => h.id !== r.id && h.effectiveFrom < r.effectiveFrom);
      const prev = earlier.length ? Number(earlier[earlier.length - 1]!.amount) : null;
      const amount = Number(r.amount);
      return {
        id: r.id,
        associateId: r.associateId,
        name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
        store: r.associate.assignments[0]?.location.name ?? null,
        effectiveFrom: r.effectiveFrom,
        payType: r.payType,
        previousAmount: prev,
        amount,
        change: prev === null ? null : round2(amount - prev),
        changePct: prev === null || prev === 0 ? null : round1(((amount - prev) / prev) * 100),
        reason: r.reason,
        createdAt: r.createdAt,
      };
    });
  },
};

/* ----- TIME_TO_FILL: posting opened → hired ---------------------------------- */

const TIME_TO_FILL: ComputedEntity = {
  columns: ['id', 'firstName', 'lastName', 'posting', 'postingId', 'client', 'clientId', 'postingOpenedAt', 'hiredAt', 'daysToFill'],
  numeric: ['daysToFill'],
  dateColumn: 'hiredAt',
  defaultDays: 365,
  capability: 'view:recruiting',
  async load(db, user, window) {
    const rows = await db.candidate.findMany({
      where: {
        AND: [
          scopeCandidates(user),
          { tenantId: tenantIdForWrite(), deletedAt: null, stage: 'HIRED' },
          { hiredAt: { not: null, ...(window.gte ? { gte: window.gte } : {}), ...(window.lt ? { lt: window.lt } : {}) } },
        ],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        hiredAt: true,
        jobPosting: { select: { id: true, title: true, clientId: true, openedAt: true, createdAt: true, client: { select: { name: true } } } },
      },
      take: 20_000,
    });
    return rows.map((c) => {
      const p = c.jobPosting;
      // A posting saved and opened later is open from the day it opened.
      const opened = p ? (p.openedAt ?? p.createdAt) : null;
      return {
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        posting: p?.title ?? null,
        postingId: p?.id ?? null,
        client: p?.client?.name ?? null,
        clientId: p?.clientId ?? null,
        postingOpenedAt: opened,
        hiredAt: c.hiredAt,
        daysToFill: opened && c.hiredAt ? round1(Math.max(0, (c.hiredAt.getTime() - opened.getTime()) / DAY_MS)) : null,
      };
    });
  },
};

/* ----- OVERTIME: the labor engine's hours by store and week ----------------- */

const OVERTIME: ComputedEntity = {
  columns: ['associateId', 'name', 'store', 'storeId', 'client', 'weekStart', 'workedHours', 'regularHours', 'overtimeHours', 'doubleTimeHours'],
  numeric: ['workedHours', 'regularHours', 'overtimeHours', 'doubleTimeHours'],
  dateColumn: 'weekStart',
  defaultDays: 91,
  async load(db, user, window, now) {
    const tenantId = tenantIdForWrite();
    // Whole weeks: overtime is decided by the week, so every punch of a week the window touches.
    const from = startOfWeekUTC(window.gte ?? new Date(now.getTime() - 91 * DAY_MS));
    const to = window.lt ?? now;
    const worked = { status: { in: ['COMPLETED', 'APPROVED'] as Array<'COMPLETED' | 'APPROVED'> }, clockOutAt: { not: null }, clockInAt: { gte: from, lt: to } };
    // The punches in the caller's reach; the person's week is counted across every site.
    const visible = await db.timeEntry.findMany({
      where: { AND: [scopeTimeEntries(user), { tenantId, ...worked }] },
      select: { id: true, associateId: true },
      take: 100_000,
    });
    if (visible.length === 0) return [];
    const inReach = new Set(visible.map((e) => e.id));
    const people = [...new Set(visible.map((e) => e.associateId))];
    const entries = await db.timeEntry.findMany({
      where: { tenantId, associateId: { in: people }, ...worked },
      select: {
        id: true,
        associateId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { type: true, startedAt: true, endedAt: true } },
        location: { select: { id: true, name: true, state: true, city: true, timezone: true, client: { select: { name: true } } } },
        associate: { select: { firstName: true, lastName: true } },
      },
      take: 200_000,
    });
    const rules = await loadLiveRules(db, tenantId);
    const work = entries.map((e) => ({
      associateId: e.associateId,
      id: e.id,
      clockInAt: e.clockInAt,
      clockOutAt: e.clockOutAt,
      breaks: e.breaks.map((b) => ({ type: (b.type === 'MEAL' || b.type === 'REST' ? b.type : null) as 'MEAL' | 'REST' | null, startedAt: b.startedAt, endedAt: b.endedAt })),
      site: e.location ? { id: e.location.id, state: e.location.state, city: e.location.city, timezone: e.location.timezone } : null,
      entry: e,
    })) satisfies Array<HoursEntry & { associateId: string }>;
    const { byEntry } = splitByPerson(rules, work);
    const rows = new Map<string, Row & { workedHours: number; regularHours: number; overtimeHours: number; doubleTimeHours: number }>();
    for (const w of work) {
      if (!inReach.has(w.id)) continue;
      const h = byEntry.get(w);
      if (!h) continue;
      const e = w.entry;
      const weekStart = startOfWeekForSite(e.clockInAt, e.location?.timezone);
      const key = `${e.associateId}|${weekStart.getTime()}|${e.location?.id ?? ''}`;
      const cur =
        rows.get(key) ??
        {
          associateId: e.associateId,
          name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
          store: e.location?.name ?? null,
          storeId: e.location?.id ?? null,
          client: e.location?.client?.name ?? null,
          weekStart,
          workedHours: 0,
          regularHours: 0,
          overtimeHours: 0,
          doubleTimeHours: 0,
        };
      cur.workedHours += h.workedHours;
      cur.regularHours += h.regularHours;
      cur.overtimeHours += h.overtimeHours;
      cur.doubleTimeHours += h.doubleTimeHours;
      rows.set(key, cur);
    }
    return [...rows.values()].map((r) => ({
      ...r,
      workedHours: round2(r.workedHours),
      regularHours: round2(r.regularHours),
      overtimeHours: round2(r.overtimeHours),
      doubleTimeHours: round2(r.doubleTimeHours),
    }));
  },
};

export const COMPUTED_ENTITIES: Record<string, ComputedEntity> = { PAY_CHANGE, TIME_TO_FILL, OVERTIME };

/* ----- Running a spec over computed rows ------------------------------------ */

type Spec = {
  columns: string[];
  sort: Array<{ column: string; direction: 'asc' | 'desc' }>;
  limit: number;
  groupBy?: string[];
  aggregates?: Array<{ fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; column?: string | null; alias?: string | null }>;
};

/** Comparable form of a value: instants and ISO dates as epoch ms, numeric strings as numbers. */
function comparable(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) {
      const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
      if (!Number.isNaN(t)) return t;
    }
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  if (v !== null && typeof v === 'object' && 'toNumber' in (v as object)) return Number(v);
  return v;
}

function same(a: unknown, b: unknown): boolean {
  const x = comparable(a);
  const y = comparable(b);
  if (typeof x === 'number' && typeof y === 'string' && y.trim() !== '' && !Number.isNaN(Number(y))) return x === Number(y);
  if (typeof y === 'number' && typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))) return Number(x) === y;
  return x === y || (x == null && y == null);
}

function cmp(a: unknown, b: unknown): number {
  const x = comparable(a);
  const y = comparable(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  const nx = typeof x === 'string' && typeof y === 'number' ? Number(x) : x;
  const ny = typeof y === 'string' && typeof x === 'number' ? Number(y) : y;
  if (typeof nx === 'number' && typeof ny === 'number') return nx - ny;
  return String(nx).localeCompare(String(ny));
}

/** Does a row pass a compiled where (the shape lib/reportRun.buildWhere makes)? */
export function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  for (const [col, cond] of Object.entries(where)) {
    const v = row[col];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ('not' in c && same(v, c.not)) return false;
      if ('in' in c && !(c.in as unknown[]).some((x) => same(v, x))) return false;
      if ('contains' in c && !String(v ?? '').toLowerCase().includes(String(c.contains).toLowerCase())) return false;
      for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
        if (!(op in c)) continue;
        if (v === null || v === undefined) return false;
        const d = cmp(v, c[op]);
        if ((op === 'gt' && !(d > 0)) || (op === 'gte' && !(d >= 0)) || (op === 'lt' && !(d < 0)) || (op === 'lte' && !(d <= 0))) return false;
      }
    } else if (!same(v, cond)) {
      return false;
    }
  }
  return true;
}

/** The load window a compiled where implies for the date column (gte/gt → from, lt/lte → to). */
export function windowFrom(where: Record<string, unknown>, dateColumn: string, now: Date, defaultDays: number): Window {
  const c = where[dateColumn];
  const asDate = (x: unknown) => {
    const t = comparable(x);
    return typeof t === 'number' ? new Date(t) : null;
  };
  if (c instanceof Date || typeof c === 'string') {
    const d = asDate(c);
    return d ? { gte: d, lt: new Date(d.getTime() + DAY_MS) } : {};
  }
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>;
    const gte = asDate(o.gte ?? o.gt);
    const lt = asDate(o.lt) ?? (o.lte !== undefined ? new Date((asDate(o.lte)?.getTime() ?? now.getTime()) + DAY_MS) : null);
    return { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
  }
  return { gte: new Date(now.getTime() - defaultDays * DAY_MS) };
}

const aliasOf = (a: NonNullable<Spec['aggregates']>[number]) => a.alias?.trim() || (a.fn === 'count' ? 'count' : `${a.fn}_${a.column ?? ''}`);

/** Filter, then group and roll up, or sort and project — a spec over rows. */
export function runSpecOverRows(rows: Row[], spec: Spec, where: Record<string, unknown>): Row[] {
  const kept = rows.filter((r) => rowMatches(r, where));
  if (spec.groupBy && spec.groupBy.length > 0) {
    const groups = new Map<string, Row[]>();
    for (const r of kept) {
      const k = JSON.stringify(spec.groupBy.map((g) => comparable(r[g]) ?? null));
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const out: Row[] = [];
    for (const members of groups.values()) {
      const row: Row = {};
      for (const g of spec.groupBy) row[g] = members[0]![g] ?? null;
      for (const a of spec.aggregates ?? [{ fn: 'count' as const, column: null, alias: null }]) {
        const alias = aliasOf(a);
        if (a.fn === 'count') {
          row[alias] = members.length;
          continue;
        }
        const nums = members.map((m) => m[a.column!]).filter((x) => x !== null && x !== undefined).map(Number).filter((n) => Number.isFinite(n));
        row[alias] =
          nums.length === 0
            ? null
            : a.fn === 'sum'
              ? round2(nums.reduce((s, n) => s + n, 0))
              : a.fn === 'avg'
                ? round2(nums.reduce((s, n) => s + n, 0) / nums.length)
                : a.fn === 'min'
                  ? Math.min(...nums)
                  : Math.max(...nums);
      }
      out.push(row);
    }
    out.sort((x, y) => {
      for (const g of spec.groupBy!) {
        const d = cmp(x[g], y[g]);
        if (d !== 0) return d;
      }
      return 0;
    });
    return out.slice(0, Math.min(spec.limit, 2000));
  }
  const sorted = [...kept];
  if (spec.sort.length) {
    sorted.sort((x, y) => {
      for (const s of spec.sort) {
        const d = cmp(x[s.column], y[s.column]);
        if (d !== 0) return s.direction === 'asc' ? d : -d;
      }
      return 0;
    });
  }
  return sorted.slice(0, spec.limit).map((r) => Object.fromEntries(spec.columns.map((c) => [c, r[c] ?? null])));
}

/** Rows for a computed entity (or ASSOCIATE with its computed columns), as the caller sees them. */
export async function loadComputedRows(
  entity: string,
  db: Db,
  user: SessionUser,
  where: Record<string, unknown>,
  now: Date,
): Promise<Row[]> {
  if (entity === 'ASSOCIATE') return loadAssociates(db, user);
  const def = COMPUTED_ENTITIES[entity];
  if (!def) throw new HttpError(400, 'invalid_entity', 'Unknown report entity.');
  return def.load(db, user, windowFrom(where, def.dateColumn, now, def.defaultDays), now);
}

/** Does this spec need the in-memory path? (A computed entity, or a computed ASSOCIATE column.) */
export function needsComputedPath(entity: string, spec: Spec & { filters: Array<{ column: string }> }): boolean {
  if (COMPUTED_ENTITIES[entity]) return true;
  if (entity !== 'ASSOCIATE') return false;
  const used = [...spec.columns, ...spec.filters.map((f) => f.column), ...spec.sort.map((s) => s.column), ...(spec.groupBy ?? []), ...(spec.aggregates ?? []).map((a) => a.column ?? '')];
  return used.some((c) => (ASSOCIATE_COMPUTED_COLUMNS as readonly string[]).includes(c));
}

