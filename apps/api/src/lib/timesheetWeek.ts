/**
 * Fieldglass-shaped weekly timesheet builder.
 *
 * Produces the SAP Fieldglass group-timesheet view: one row per worker per
 * week (Saturday → Friday), keyed by the week-ending Friday, worked hours
 * dropped into the ST / OT / DT / Others / NB buckets. Per the current SOW
 * (sample: FL–Destin) every worked hour is billed flat under "Others" with
 * NO overtime split; the other buckets stay 0.00. Hours are NET of unpaid
 * breaks and APPROVED-only, matching what the buyer invoices.
 *
 * Two seams:
 *   - `saturdayWeek(instant, tz)` — pure week math (which Sat–Fri week an
 *     instant falls in, as store-local calendar dates).
 *   - `aggregateTimesheetRows(entries, dateKeys, tz)` — pure aggregation,
 *     unit-testable with fixed dates and no database.
 * `buildTimesheetWeek` glues them to Prisma.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  TimesheetAssociateDetailResponse,
  TimesheetDay,
  TimesheetDriftRow,
  TimesheetFilingInfo,
  TimesheetIssue,
  TimesheetRow,
  TimesheetScheduleRow,
  TimesheetWeekResponse,
} from '@alto-people/shared';
import { localDateKey, formatTimeInZone, DEFAULT_TIMEZONE } from './timezone.js';
import { netWorkedMinutes, type BreakFacts } from './timeAnomalies.js';
import { round2 } from './payroll.js';

/**
 * The single Fieldglass bucket every worked hour lands in for the current
 * SOW. Change this one value (and the zeros below) if a buyer splits ST/OT.
 */
type HoursBucket = 'st' | 'ot' | 'dt' | 'others' | 'nb';
const HOURS_BUCKET: HoursBucket = 'others';

export interface TimesheetSourceEntry {
  associateId: string;
  firstName: string;
  lastName: string;
  clientId: string | null;
  /** Worksite label (location name) or client name — the Fieldglass Site. */
  site: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  /** APPROVED | COMPLETED | … — only APPROVED contributes hours. */
  status: string;
  breaks: BreakFacts[];
  /**
   * The IANA timezone of the SITE where this entry was punched
   * (Location.timezone, falling back to DEFAULT_TIMEZONE). Bucketing and
   * time display use this per entry — the sheet used to run everything
   * through a hardcoded America/New_York, so a Chicago site's Friday
   * 11:30pm clock-in read as Saturday 12:30am ET and migrated into the
   * NEXT Sat–Fri week. Reviewers approved a shift in one week; the
   * timesheet totalled it in another.
   */
  timeZone: string;
}

export interface SaturdayWeek {
  /** Saturday, YYYY-MM-DD (store-local). */
  weekStart: string;
  /** Friday, YYYY-MM-DD (store-local). */
  weekEnd: string;
  /** The seven local date keys Sat…Fri. */
  dateKeys: string[];
}

/**
 * Which Saturday→Friday week a UTC instant falls in, expressed as the seven
 * store-local calendar dates. Anchoring at noon UTC of the local date keeps
 * the weekday stable across DST edges.
 */
export function saturdayWeek(instant: Date, timeZone: string): SaturdayWeek {
  const localKey = localDateKey(instant, timeZone); // YYYY-MM-DD (local)
  const anchor = new Date(`${localKey}T12:00:00Z`);
  const dow = anchor.getUTCDay(); // 0=Sun … 6=Sat
  const daysBackToSat = (dow + 1) % 7; // Sat→0, Sun→1, … Fri→6
  anchor.setUTCDate(anchor.getUTCDate() - daysBackToSat);

  const dateKeys: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + i);
    dateKeys.push(d.toISOString().slice(0, 10));
  }
  return { weekStart: dateKeys[0], weekEnd: dateKeys[6], dateKeys };
}

/** "YYYY-MM-DD" → "MM/DD/YYYY" (Fieldglass End-date display). */
export function toUsDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

interface RowAccumulator {
  associateId: string;
  worker: string;
  site: string;
  minutes: number;
  hasPending: boolean;
}

/**
 * Fold approved time entries into one Fieldglass row per worker+client. Pure:
 * only entries whose local clock-in date is inside `weekDateKeys` count, and
 * only APPROVED entries with a clock-out contribute hours. COMPLETED entries
 * in-week flag the row/sheet as provisional.
 */
export function aggregateTimesheetRows(
  entries: TimesheetSourceEntry[],
  weekDateKeys: Set<string>,
): { rows: TimesheetRow[]; totalHours: number; pendingCount: number } {
  const groups = new Map<string, RowAccumulator>();
  let pendingCount = 0;

  for (const e of entries) {
    // Per-entry site clock — see TimesheetSourceEntry.timeZone.
    const dayKey = localDateKey(e.clockInAt, e.timeZone);
    if (!weekDateKeys.has(dayKey)) continue;

    const gkey = `${e.associateId}|${e.clientId ?? ''}`;
    let g = groups.get(gkey);
    if (!g) {
      g = {
        associateId: e.associateId,
        worker: `${e.lastName}, ${e.firstName}`.trim(),
        site: e.site ?? '—',
        minutes: 0,
        hasPending: false,
      };
      groups.set(gkey, g);
    }

    if (e.status === 'APPROVED' && e.clockOutAt) {
      g.minutes += netWorkedMinutes(
        { clockInAt: e.clockInAt, clockOutAt: e.clockOutAt },
        e.breaks,
      );
    } else if (e.status === 'COMPLETED') {
      // Clocked out, awaiting HR approval — the sheet isn't final yet.
      g.hasPending = true;
      pendingCount += 1;
    }
  }

  let totalHours = 0;
  const rows: TimesheetRow[] = [];
  for (const g of groups.values()) {
    const hours = round2(g.minutes / 60);
    // A worker with only pending entries (0 approved hours) still surfaces so
    // HR sees the week isn't done; approved workers show READY.
    if (hours === 0 && !g.hasPending) continue;
    totalHours += hours;
    const buckets = { st: 0, ot: 0, dt: 0, others: 0, nb: 0 };
    buckets[HOURS_BUCKET] = hours;
    rows.push({
      associateId: g.associateId,
      worker: g.worker,
      site: g.site,
      ...buckets,
      total: hours,
      status: g.hasPending ? 'PENDING' : 'READY',
    });
  }

  rows.sort((a, b) => a.worker.localeCompare(b.worker));
  return { rows, totalHours: round2(totalHours), pendingCount };
}

/**
 * Build the full Fieldglass timesheet for the Sat–Fri week containing
 * `weekStart`, across all clients (or one when `clientId` is set). Queries a
 * padded UTC window and filters by local calendar day so timezone/DST edges
 * don't clip a shift.
 */
/** Snapshot shape stored on TimesheetFiling.snapshot (per associate). */
export type TimesheetSnapshot = Record<string, { worker: string; hours: number }>;

export async function buildTimesheetWeek(
  db: Pick<
    PrismaClient,
    'timeEntry' | 'client' | 'shift' | 'timesheetFiling' | 'user'
  >,
  input: {
    weekStart: Date;
    clientId?: string;
    /** Row-level scope fragment (e.g. from scopeTimeEntries) merged into the query. */
    scopeWhere?: Prisma.TimeEntryWhereInput;
    /** Shift-side scope (from scopeShifts) for the scheduled-vs-actual query. */
    shiftScopeWhere?: Prisma.ShiftWhereInput;
  },
  timeZone: string = DEFAULT_TIMEZONE,
): Promise<TimesheetWeekResponse> {
  const week = saturdayWeek(input.weekStart, timeZone);
  const dateKeySet = new Set(week.dateKeys);

  // Pad ±1–2 days in UTC so any local-day entry in the week is fetched, then
  // filter precisely by local date inside the aggregator.
  const windowStart = new Date(`${week.dateKeys[0]}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - 1);
  const windowEnd = new Date(`${week.dateKeys[6]}T00:00:00Z`);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 2);

  const rawEntries = await db.timeEntry.findMany({
    where: {
      ...(input.scopeWhere ?? {}),
      // ACTIVE is included only for the missing-clock-out validation; it
      // contributes no hours (aggregateTimesheetRows counts APPROVED only).
      status: { in: ['APPROVED', 'COMPLETED', 'ACTIVE'] },
      clockInAt: { gte: windowStart, lt: windowEnd },
      ...(input.clientId ? { clientId: input.clientId } : {}),
    },
    select: {
      associateId: true,
      clientId: true,
      clockInAt: true,
      clockOutAt: true,
      status: true,
      associate: { select: { firstName: true, lastName: true } },
      location: { select: { name: true, timezone: true } },
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
    },
  });

  // TimeEntry.clientId is a denormalized scalar (no relation), so resolve
  // client names for the Site fallback in one batched lookup.
  const clientIds = [
    ...new Set(rawEntries.map((e) => e.clientId).filter((id): id is string => !!id)),
  ];
  // Prefer the verbatim Fieldglass site label per client; fall back to the
  // worksite (location) name, then the plain client name.
  const clientSiteById = new Map<string, { name: string; fieldglass: string | null }>();
  if (clientIds.length > 0) {
    const clients = await db.client.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, name: true, fieldglassSiteName: true },
    });
    for (const c of clients) {
      clientSiteById.set(c.id, { name: c.name, fieldglass: c.fieldglassSiteName });
    }
  }

  const entries: TimesheetSourceEntry[] = rawEntries.map((e) => {
    const client = e.clientId ? clientSiteById.get(e.clientId) : undefined;
    return {
      associateId: e.associateId,
      firstName: e.associate.firstName,
      lastName: e.associate.lastName,
      clientId: e.clientId,
      site: client?.fieldglass ?? e.location?.name ?? client?.name ?? null,
      clockInAt: e.clockInAt,
      clockOutAt: e.clockOutAt,
      status: e.status,
      breaks: e.breaks.map((b) => ({
        type: b.type as BreakFacts['type'],
        startedAt: b.startedAt,
        endedAt: b.endedAt,
      })),
      // The site's own clock, not the sheet-wide default — see
      // TimesheetSourceEntry.timeZone.
      timeZone: e.location?.timezone ?? timeZone,
    };
  });

  const { rows, totalHours, pendingCount } = aggregateTimesheetRows(
    entries,
    dateKeySet,
  );

  const issues = computeTimesheetIssues(entries, rows, dateKeySet);

  // Scheduled-vs-actual — published assigned shifts (ASSIGNED/COMPLETED, not
  // DRAFT scratch) starting in the week, by local day, summed per associate.
  const shifts = await db.shift.findMany({
    where: {
      ...(input.shiftScopeWhere ?? {}),
      status: { in: ['ASSIGNED', 'COMPLETED'] },
      assignedAssociateId: { not: null },
      startsAt: { gte: windowStart, lt: windowEnd },
      ...(input.clientId ? { clientId: input.clientId } : {}),
    },
    select: {
      assignedAssociateId: true,
      startsAt: true,
      endsAt: true,
      assignedAssociate: { select: { firstName: true, lastName: true } },
      // locationRel, not location — Shift.location is the LEGACY free-text
      // sub-zone string; the site relation (and its timezone) is locationRel.
      locationRel: { select: { timezone: true } },
    },
  });
  const scheduled = new Map<string, { hours: number; worker: string }>();
  for (const s of shifts) {
    if (!s.assignedAssociateId) continue;
    if (!dateKeySet.has(localDateKey(s.startsAt, s.locationRel?.timezone ?? timeZone))) continue;
    const mins = Math.max(0, (s.endsAt.getTime() - s.startsAt.getTime()) / 60000);
    const worker = s.assignedAssociate
      ? `${s.assignedAssociate.lastName}, ${s.assignedAssociate.firstName}`.trim()
      : '—';
    const cur = scheduled.get(s.assignedAssociateId);
    scheduled.set(s.assignedAssociateId, {
      hours: (cur?.hours ?? 0) + mins / 60,
      worker: cur?.worker ?? worker,
    });
  }
  const scheduleComparison = buildScheduleComparison(rows, scheduled);

  // Lock/drift — if this week (and client scope) was filed, surface the
  // filing plus any drift between the snapshot and the current hours.
  const weekStartDate = new Date(`${week.weekStart}T00:00:00Z`);
  // orderBy filedAt desc: the schema's @@unique([weekStart, clientId])
  // does NOT constrain clientId=null rows (Postgres treats NULLs as
  // distinct), so historical duplicates of the org-wide filing are
  // possible. An unordered findFirst returned whichever the planner felt
  // like, and drift was computed against an arbitrary snapshot. The
  // partial unique index added in 20260730* stops NEW duplicates; the
  // ordering makes reads deterministic regardless.
  const filingRow = await db.timesheetFiling.findFirst({
    where: { weekStart: weekStartDate, clientId: input.clientId ?? null },
    orderBy: { filedAt: 'desc' },
  });
  let filing: TimesheetFilingInfo | null = null;
  if (filingRow) {
    const snapshot = (filingRow.snapshot as TimesheetSnapshot | null) ?? {};
    let filedBy: string | null = null;
    if (filingRow.filedById) {
      const u = await db.user.findUnique({
        where: { id: filingRow.filedById },
        select: { email: true },
      });
      filedBy = u?.email ?? null;
    }
    filing = {
      filedAt: filingRow.filedAt.toISOString(),
      filedBy,
      filedTotalHours: Number(filingRow.totalHours),
      drift: computeDrift(snapshot, rows),
    };
  }

  return {
    weekStart: week.weekStart,
    weekEndIso: week.weekEnd,
    weekEnding: toUsDate(week.weekEnd),
    rows,
    totalHours,
    pendingCount,
    issues,
    scheduleComparison,
    filing,
    timeZone,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Drift between a filing snapshot and the current rows: any worker whose
 * hours changed (or was added/removed) since filing. Pure; sorted by worker.
 */
export function computeDrift(
  snapshot: TimesheetSnapshot,
  rows: TimesheetRow[],
): TimesheetDriftRow[] {
  const currentById = new Map(
    rows.map((r) => [r.associateId, { worker: r.worker, hours: r.total }]),
  );
  const ids = new Set<string>([...Object.keys(snapshot), ...currentById.keys()]);
  const drift: TimesheetDriftRow[] = [];
  for (const id of ids) {
    const filed = round2(snapshot[id]?.hours ?? 0);
    const current = round2(currentById.get(id)?.hours ?? 0);
    if (filed === current) continue;
    drift.push({
      associateId: id,
      worker: currentById.get(id)?.worker ?? snapshot[id]?.worker ?? '—',
      filedHours: filed,
      currentHours: current,
      delta: round2(current - filed),
    });
  }
  drift.sort((a, b) => a.worker.localeCompare(b.worker));
  return drift;
}

/**
 * Record (or re-record) a filing for the week: snapshots each worker's hours
 * + the total, stamped with who filed it. Returns the freshly-filed week
 * response (filing set, drift empty).
 */
export async function fileTimesheetWeek(
  db: Pick<
    PrismaClient,
    'timeEntry' | 'client' | 'shift' | 'timesheetFiling' | 'user'
  >,
  input: {
    weekStart: Date;
    clientId?: string;
    scopeWhere?: Prisma.TimeEntryWhereInput;
    shiftScopeWhere?: Prisma.ShiftWhereInput;
  },
  filedById: string,
  timeZone: string = DEFAULT_TIMEZONE,
): Promise<TimesheetWeekResponse> {
  const response = await buildTimesheetWeek(db, input, timeZone);

  const snapshot: TimesheetSnapshot = {};
  for (const r of response.rows) {
    snapshot[r.associateId] = { worker: r.worker, hours: r.total };
  }

  const weekStartDate = new Date(`${response.weekStart}T00:00:00Z`);
  const clientId = input.clientId ?? null;
  const filingData = {
    filedById,
    filedAt: new Date(),
    totalHours: response.totalHours,
    snapshot,
  };
  // findFirst→create is racy: two admins filing the same week concurrently
  // both saw "no existing" and both created. For client-scoped filings the
  // compound unique made the loser 500; for the org-wide (clientId=null)
  // filing Postgres's NULLs-are-distinct semantics let BOTH rows land. Now
  // the partial unique index rejects the loser, and we catch the unique
  // violation and convert it into the update it was always meant to be.
  const existing = await db.timesheetFiling.findFirst({
    where: { weekStart: weekStartDate, clientId },
    orderBy: { filedAt: 'desc' },
  });
  let row;
  if (existing) {
    row = await db.timesheetFiling.update({
      where: { id: existing.id },
      data: filingData,
    });
  } else {
    try {
      row = await db.timesheetFiling.create({
        data: { weekStart: weekStartDate, clientId, ...filingData },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await db.timesheetFiling.findFirst({
          where: { weekStart: weekStartDate, clientId },
          orderBy: { filedAt: 'desc' },
        });
        if (!winner) throw err; // constraint fired but row vanished — surface it
        row = await db.timesheetFiling.update({
          where: { id: winner.id },
          data: filingData,
        });
      } else {
        throw err;
      }
    }
  }

  const u = await db.user.findUnique({
    where: { id: filedById },
    select: { email: true },
  });

  return {
    ...response,
    filing: {
      filedAt: row.filedAt.toISOString(),
      filedBy: u?.email ?? null,
      filedTotalHours: Number(row.totalHours),
      drift: [],
    },
  };
}

/**
 * Pair each worker's scheduled hours (from assigned shifts) with hours
 * actually worked (approved rows). Union of both sets — a no-show has
 * scheduled > 0 and actual 0; unscheduled work has scheduled 0 and actual > 0.
 * Pure and unit-testable. Sorted by worker.
 */
export function buildScheduleComparison(
  rows: TimesheetRow[],
  scheduled: Map<string, { hours: number; worker: string }>,
): TimesheetScheduleRow[] {
  const actualById = new Map<string, { hours: number; worker: string }>();
  for (const r of rows) actualById.set(r.associateId, { hours: r.total, worker: r.worker });

  const ids = new Set<string>([...actualById.keys(), ...scheduled.keys()]);
  const out: TimesheetScheduleRow[] = [];
  for (const id of ids) {
    const a = actualById.get(id);
    const s = scheduled.get(id);
    const scheduledHours = round2(s?.hours ?? 0);
    const actualHours = round2(a?.hours ?? 0);
    if (scheduledHours === 0 && actualHours === 0) continue;
    out.push({
      associateId: id,
      worker: a?.worker ?? s?.worker ?? '—',
      scheduledHours,
      actualHours,
      delta: round2(actualHours - scheduledHours),
    });
  }
  out.sort((x, y) => x.worker.localeCompare(y.worker));
  return out;
}

/** Weekly total above this (net hours) is flagged for review before filing. */
const OVER_HOURS_THRESHOLD = 60;

/**
 * Pre-file validation over the week's entries: missing clock-outs (ACTIVE
 * entries that never closed), workers with time still pending approval (their
 * hours won't ship), and implausibly high weekly totals. Pure — sorted most
 * blocking first. Only in-week entries (by local clock-in day) count.
 */
export function computeTimesheetIssues(
  entries: TimesheetSourceEntry[],
  rows: TimesheetRow[],
  weekDateKeys: Set<string>,
): TimesheetIssue[] {
  const nameById = new Map<string, string>();
  const missingClockout = new Set<string>();
  const pendingByAssoc = new Map<string, number>();

  for (const e of entries) {
    if (!weekDateKeys.has(localDateKey(e.clockInAt, e.timeZone))) continue;
    const id = e.associateId;
    nameById.set(id, `${e.lastName}, ${e.firstName}`.trim());
    if (!e.clockOutAt) missingClockout.add(id);
    if (e.status === 'COMPLETED') {
      pendingByAssoc.set(id, (pendingByAssoc.get(id) ?? 0) + 1);
    }
  }

  const issues: TimesheetIssue[] = [];
  // Most blocking first: a missing clock-out means the day has no hours at all.
  for (const id of missingClockout) {
    issues.push({
      kind: 'MISSING_CLOCKOUT',
      associateId: id,
      worker: nameById.get(id) ?? '—',
      detail: 'Still clocked in / no clock-out — that shift has no hours yet.',
    });
  }
  for (const [id, count] of pendingByAssoc) {
    issues.push({
      kind: 'PENDING_APPROVAL',
      associateId: id,
      worker: nameById.get(id) ?? '—',
      detail: `${count} entr${count === 1 ? 'y' : 'ies'} pending approval — not included until approved.`,
    });
  }
  for (const r of rows) {
    if (r.total > OVER_HOURS_THRESHOLD) {
      issues.push({
        kind: 'OVER_HOURS',
        associateId: r.associateId,
        worker: r.worker,
        detail: `${r.total.toFixed(2)}h this week — over ${OVER_HOURS_THRESHOLD}h, worth a look.`,
      });
    }
  }
  return issues;
}

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "1h", "45m", or "1h 30m". */
function formatDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/**
 * The Fieldglass "Time in / time out" grid for one associate: a cell per day
 * (Sat→Fri) with the day's clock-in (earliest), meal breaks, clock-out
 * (latest), and net hours. Buckets by the local clock-in day so an overnight
 * shift (in 10pm Sat, out 7am Sun) sits under Saturday — matching Fieldglass.
 * Pure and unit-testable.
 */
export function buildAssociateDays(
  entries: TimesheetSourceEntry[],
  dateKeys: string[],
): { days: TimesheetDay[]; totalHours: number } {
  const byDay = new Map<string, TimesheetSourceEntry[]>();
  for (const e of entries) {
    if (e.status !== 'APPROVED' || !e.clockOutAt) continue;
    const key = localDateKey(e.clockInAt, e.timeZone);
    const arr = byDay.get(key) ?? [];
    arr.push(e);
    byDay.set(key, arr);
  }

  let totalHours = 0;
  const days = dateKeys.map((key) => {
    const anchor = new Date(`${key}T12:00:00Z`);
    const weekday = WEEKDAY_ABBR[anchor.getUTCDay()];
    const monthDay = `${anchor.getUTCMonth() + 1}/${anchor.getUTCDate()}`;
    const dayEntries = byDay.get(key) ?? [];

    let netMin = 0;
    let timeInAt: Date | null = null;
    let timeOutAt: Date | null = null;
    // Times render in the zone of the entry that produced them — the site's
    // wall clock, which is what the associate and their supervisor saw.
    let timeInZone = DEFAULT_TIMEZONE;
    let timeOutZone = DEFAULT_TIMEZONE;
    const breaks: string[] = [];
    for (const e of dayEntries) {
      netMin += netWorkedMinutes(
        { clockInAt: e.clockInAt, clockOutAt: e.clockOutAt },
        e.breaks,
      );
      if (!timeInAt || e.clockInAt < timeInAt) {
        timeInAt = e.clockInAt;
        timeInZone = e.timeZone;
      }
      if (e.clockOutAt && (!timeOutAt || e.clockOutAt > timeOutAt)) {
        timeOutAt = e.clockOutAt;
        timeOutZone = e.timeZone;
      }
      for (const b of e.breaks) {
        const start = formatTimeInZone(b.startedAt, e.timeZone);
        if (b.endedAt) {
          const mins = Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 60000);
          breaks.push(`${start} – ${formatTimeInZone(b.endedAt, e.timeZone)} (${formatDuration(mins)})`);
        } else {
          breaks.push(`${start} – open`);
        }
      }
    }

    const netHours = round2(netMin / 60);
    totalHours += netHours;
    return {
      date: key,
      weekday,
      monthDay,
      timeIn: timeInAt ? formatTimeInZone(timeInAt, timeInZone) : null,
      timeOut: timeOutAt ? formatTimeInZone(timeOutAt, timeOutZone) : null,
      breaks,
      netHours,
    };
  });

  return { days, totalHours: round2(totalHours) };
}

/**
 * DB-backed per-associate detail for one Sat→Fri week — the drill-down behind
 * a worker row on the Timesheets grid. Mirrors the Fieldglass individual sheet
 * header (Worker / Period / Site) plus the day-by-day punch grid.
 */
// There is deliberately NO default pay rate. An earlier version substituted
// a flat $15/hr when the associate had no open HOURLY comp record — a
// fabricated number rendered on a billing-adjacent document with nothing
// marking it as fake. A missing rate now surfaces as null and the sheet
// shows a dash: "we don't know" beats "here's a plausible lie".

export async function buildAssociateTimesheetDetail(
  db: Pick<
    PrismaClient,
    'timeEntry' | 'client' | 'associate' | 'compensationRecord'
  >,
  input: {
    associateId: string;
    weekStart: Date;
    clientId?: string;
    scopeWhere?: Prisma.TimeEntryWhereInput;
  },
  timeZone: string = DEFAULT_TIMEZONE,
): Promise<TimesheetAssociateDetailResponse> {
  const week = saturdayWeek(input.weekStart, timeZone);
  const dateKeySet = new Set(week.dateKeys);

  const windowStart = new Date(`${week.dateKeys[0]}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - 1);
  const windowEnd = new Date(`${week.dateKeys[6]}T00:00:00Z`);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 2);

  const raw = await db.timeEntry.findMany({
    where: {
      ...(input.scopeWhere ?? {}),
      associateId: input.associateId,
      status: { in: ['APPROVED', 'COMPLETED'] },
      clockInAt: { gte: windowStart, lt: windowEnd },
      ...(input.clientId ? { clientId: input.clientId } : {}),
    },
    // Deterministic order is load-bearing: entries[0] below supplies the
    // Site label AND the billRate that prices the whole week's Amount.
    // Unordered, an associate who worked two clients in one week got an
    // Amount computed against whichever client the planner returned first
    // — two runs of the same sheet could disagree. Earliest in-week entry
    // is the rule now.
    orderBy: { clockInAt: 'asc' },
    select: {
      associateId: true,
      clientId: true,
      clockInAt: true,
      clockOutAt: true,
      status: true,
      associate: { select: { firstName: true, lastName: true } },
      location: { select: { name: true, timezone: true } },
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
    },
  });

  const clientIds = [
    ...new Set(raw.map((e) => e.clientId).filter((id): id is string => !!id)),
  ];
  const clientById = new Map<
    string,
    { name: string; fieldglass: string | null; billRate: number | null }
  >();
  if (clientIds.length > 0) {
    const clients = await db.client.findMany({
      where: { id: { in: clientIds } },
      select: {
        id: true,
        name: true,
        fieldglassSiteName: true,
        fieldglassBillRate: true,
      },
    });
    for (const c of clients) {
      clientById.set(c.id, {
        name: c.name,
        fieldglass: c.fieldglassSiteName,
        billRate: c.fieldglassBillRate == null ? null : Number(c.fieldglassBillRate),
      });
    }
  }

  const entries: TimesheetSourceEntry[] = raw
    .filter((e) => dateKeySet.has(localDateKey(e.clockInAt, e.location?.timezone ?? timeZone)))
    .map((e) => {
      const client = e.clientId ? clientById.get(e.clientId) : undefined;
      return {
        associateId: e.associateId,
        firstName: e.associate.firstName,
        lastName: e.associate.lastName,
        clientId: e.clientId,
        site: client?.fieldglass ?? e.location?.name ?? client?.name ?? null,
        clockInAt: e.clockInAt,
        clockOutAt: e.clockOutAt,
        status: e.status,
        breaks: e.breaks.map((b) => ({
          type: b.type as BreakFacts['type'],
          startedAt: b.startedAt,
          endedAt: b.endedAt,
        })),
        timeZone: e.location?.timezone ?? timeZone,
      };
    });

  // Worker name + site: from the entries if present, else fall back to the
  // associate record (drawer opened for a worker with no in-week entries).
  let worker = '';
  let site = '—';
  const first = entries[0];
  if (first) {
    worker = `${first.lastName}, ${first.firstName}`.trim();
    site = first.site ?? '—';
  } else {
    const a = await db.associate.findUnique({
      where: { id: input.associateId },
      select: { firstName: true, lastName: true },
    });
    if (a) worker = `${a.lastName}, ${a.firstName}`.trim();
  }

  const { days, totalHours } = buildAssociateDays(entries, week.dateKeys);
  const pendingCount = entries.filter((e) => e.status === 'COMPLETED').length;

  // Accounting block — the associate's pay rate (their open HOURLY comp
  // record, else the $15 default) and the client-billed rate → Amount.
  const comp = await db.compensationRecord.findFirst({
    where: { associateId: input.associateId, payType: 'HOURLY', effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
    select: { amount: true },
  });
  const payRate = comp ? Number(comp.amount) : null;
  const billRate = first?.clientId
    ? clientById.get(first.clientId)?.billRate ?? null
    : null;
  const amount = billRate != null ? round2(billRate * totalHours) : null;

  return {
    associateId: input.associateId,
    worker,
    site,
    weekStart: week.weekStart,
    weekEndIso: week.weekEnd,
    weekEnding: toUsDate(week.weekEnd),
    periodLabel: `${toUsDate(week.weekStart)} to ${toUsDate(week.weekEnd)}`,
    days,
    totalHours,
    status: pendingCount > 0 ? 'PENDING' : 'READY',
    pendingCount,
    rateLabel: 'Standard Hourly Rate /Hr',
    payRate: payRate != null ? round2(payRate) : null,
    billRate: billRate != null ? round2(billRate) : null,
    amount,
    timeZone,
    generatedAt: new Date().toISOString(),
  };
}
