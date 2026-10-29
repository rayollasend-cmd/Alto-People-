import type { ClientHoursSignOff, Prisma, PrismaClient } from '@prisma/client';
import { toDateOnly } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { fullName, netMinutes, nextKey, readAll, storeCalendar, type StoreCalendar } from './portalMetrics.js';

/**
 * The client's sign-off on a store week's worked hours — the VMS-grade
 * timesheet approval (Fieldglass, Beeline): the store manager reads each
 * person's hours for a finished week in the portal and signs them off, or
 * flags the lines they question with a note. Staff read the status on the
 * client's page and beside its statements.
 *
 *   hours      closed punches (completed or approved) clocked in during the
 *              store's week (Saturday → Friday on the store's own clock) at
 *              the store, unpaid breaks out — the hours a statement bills.
 *              A punch still open in a finished week is counted apart
 *              (`openPunches`), never guessed at.
 *   the record one per store per week; re-signing replaces it. Its lines and
 *              total are frozen as signed, so hours that move afterwards (a
 *              late approval, an edit) read "changed since sign-off" on both
 *              sides rather than silently inheriting the signature.
 *
 * Hours only: no pay or bill rate ever reaches this payload.
 */

/** How far back a week can still be signed (and the staff list reaches). */
export const SIGNOFF_LOOKBACK_WEEKS = 12;

export interface HoursLine {
  associateId: string;
  name: string;
  hours: number;
  punches: number;
}

export interface WeekHours {
  lines: HoursLine[];
  totalHours: number;
  people: number;
  /** Punches in the week still open — not counted in the hours. */
  openPunches: number;
}

export interface SignOffFlag {
  associateId: string;
  name: string;
  hours: number;
  note: string;
}

export type SignOffState = 'unsigned' | 'signed' | 'flagged' | 'changed';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Any day inside a store week → that week's Saturday, on the store's calendar. */
export function storeWeekKey(cal: StoreCalendar, dayKey: string): string {
  // Noon of the day, so a DST night never tips it into the day before.
  return cal.key(cal.weekStart(new Date(cal.midnight(dayKey).getTime() + 12 * 3_600_000)));
}

/** The last week that has ended on the store's clock. */
export function lastFinishedWeek(cal: StoreCalendar, now: Date): string {
  return nextKey(cal.key(cal.weekStart(now)), -7);
}

/** Whether a store week may be signed now: it has ended, and it is recent. */
export function signableWeek(cal: StoreCalendar, weekKey: string, now: Date): boolean {
  const thisWeek = cal.key(cal.weekStart(now));
  return weekKey < thisWeek && weekKey >= nextKey(thisWeek, -7 * SIGNOFF_LOOKBACK_WEEKS);
}

/** One store's worked hours for one store week, person by person. */
export async function storeWeekHours(
  where: { clientId: string; locationId: string },
  cal: StoreCalendar,
  weekKey: string,
  now: Date,
  db: PrismaClient = defaultPrisma,
): Promise<WeekHours> {
  const from = cal.midnight(weekKey);
  const to = cal.midnight(nextKey(weekKey, 7));
  const { rows } = await readAll((page) =>
    db.timeEntry.findMany({
      where: {
        clientId: where.clientId,
        // A punch carries its own store (kiosk / geofence) or inherits its shift's — the portal's rule (entryScope).
        OR: [{ locationId: where.locationId }, { shift: { is: { locationId: where.locationId } } }],
        status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] },
        clockInAt: { gte: from, lt: to },
      },
      select: {
        id: true,
        status: true,
        associateId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
        associate: { select: { firstName: true, lastName: true } },
      },
      ...page,
    }),
  );
  const byPerson = new Map<string, HoursLine & { minutes: number }>();
  let openPunches = 0;
  for (const e of rows) {
    if (e.status === 'ACTIVE' || !e.clockOutAt) {
      openPunches += 1;
      continue;
    }
    const line = byPerson.get(e.associateId) ?? {
      associateId: e.associateId,
      name: fullName(e.associate),
      hours: 0,
      punches: 0,
      minutes: 0,
    };
    line.minutes += netMinutes(e, now);
    line.punches += 1;
    byPerson.set(e.associateId, line);
  }
  const lines = [...byPerson.values()]
    .map(({ minutes, ...l }) => ({ ...l, hours: round2(minutes / 60) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    lines,
    totalHours: round2(lines.reduce((a, l) => a + l.hours, 0)),
    people: lines.length,
    openPunches,
  };
}

/** Where a week stands against its sign-off. */
export function signOffState(current: Pick<WeekHours, 'lines' | 'totalHours'>, record: Pick<ClientHoursSignOff, 'status' | 'totalHours' | 'lines'> | null): SignOffState {
  if (!record) return 'unsigned';
  const signedLines = (Array.isArray(record.lines) ? record.lines : []) as unknown as HoursLine[];
  const signed = new Map(signedLines.map((l) => [l.associateId, round2(l.hours)]));
  const moved =
    round2(Number(record.totalHours)) !== round2(current.totalHours) ||
    signed.size !== current.lines.length ||
    current.lines.some((l) => signed.get(l.associateId) !== round2(l.hours));
  if (moved) return 'changed';
  return record.status === 'FLAGGED' ? 'flagged' : 'signed';
}

/** The record as a payload (dates as strings, numbers as numbers). */
export function signOffView(record: ClientHoursSignOff | null) {
  if (!record) return null;
  return {
    status: record.status,
    signedAt: record.signedAt.toISOString(),
    signedByName: record.signedByName,
    totalHours: Number(record.totalHours),
    people: record.people,
    flags: (Array.isArray(record.flags) ? record.flags : []) as unknown as SignOffFlag[],
    note: record.note,
  };
}

/** A DATE column's value for a week key. */
export const weekDate = (weekKey: string) => new Date(`${weekKey}T00:00:00.000Z`);

/**
 * The staff view: every active store of a client × its last `weeks` finished
 * weeks (each on the store's own clock), newest first — the week's worked
 * hours now, and the sign-off if there is one.
 */
export async function clientSignOffWeeks(
  clientId: string,
  opts: { weeks?: number; now?: Date; /** The caller's reach (lib/scope internalSites); null = every store. */ siteWhere?: Prisma.SiteWhereInput | null } = {},
  db: PrismaClient = defaultPrisma,
) {
  const now = opts.now ?? new Date();
  const weeks = Math.max(1, Math.min(opts.weeks ?? 6, SIGNOFF_LOOKBACK_WEEKS));
  const stores = await db.site.findMany({
    where: { AND: [{ clientId, deletedAt: null, isActive: true }, ...(opts.siteWhere ? [opts.siteWhere] : [])] },
    select: { id: true, name: true, timezone: true },
    orderBy: { name: 'asc' },
    take: 500,
  });
  const keysOf = (tz: string) => {
    const cal = storeCalendar(tz);
    const last = lastFinishedWeek(cal, now);
    return { cal, keys: Array.from({ length: weeks }, (_, i) => nextKey(last, -7 * i)) };
  };
  const allKeys = [...new Set(stores.flatMap((s) => keysOf(s.timezone).keys))];
  const records = allKeys.length
    ? await db.clientHoursSignOff.findMany({
        where: { clientId, locationId: { in: stores.map((s) => s.id) }, weekStart: { in: allKeys.map(weekDate) } },
        take: 5000,
      })
    : [];
  const recordOf = new Map(records.map((r) => [`${r.locationId}|${toDateOnly(r.weekStart)}`, r]));
  const rows: Array<{
    locationId: string;
    storeName: string;
    weekStart: string;
    weekEnd: string;
    hours: WeekHours;
    state: SignOffState;
    signOff: ReturnType<typeof signOffView>;
  }> = [];
  for (const s of stores) {
    const { cal, keys } = keysOf(s.timezone);
    for (const k of keys) {
      const hours = await storeWeekHours({ clientId, locationId: s.id }, cal, k, now, db);
      const record = recordOf.get(`${s.id}|${k}`) ?? null;
      if (hours.people === 0 && hours.openPunches === 0 && !record) continue;
      rows.push({ locationId: s.id, storeName: s.name, weekStart: k, weekEnd: nextKey(k, 6), hours, state: signOffState(hours, record), signOff: signOffView(record) });
    }
  }
  rows.sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.storeName.localeCompare(b.storeName));
  return rows;
}

/**
 * Beside each statement: of the store weeks its period covers, how many the
 * client signed off and how many it flagged. Reads the records only (the
 * statement is already frozen; the client page shows the live comparison).
 */
export async function signOffsForStatements(
  clientId: string,
  statements: Array<{ id: string; periodStart: Date; periodEnd: Date }>,
  db: PrismaClient = defaultPrisma,
): Promise<Map<string, { signed: number; flagged: number }>> {
  const out = new Map<string, { signed: number; flagged: number }>();
  if (statements.length === 0) return out;
  const min = statements.reduce((m, s) => (s.periodStart < m ? s.periodStart : m), statements[0]!.periodStart);
  const max = statements.reduce((m, s) => (s.periodEnd > m ? s.periodEnd : m), statements[0]!.periodEnd);
  const records = await db.clientHoursSignOff.findMany({
    where: { clientId, weekStart: { gte: new Date(min.getTime() - 6 * 86_400_000), lte: max } },
    select: { weekStart: true, status: true },
    take: 5000,
  });
  for (const st of statements) {
    const startKey = toDateOnly(st.periodStart)!;
    const endKey = toDateOnly(st.periodEnd)!;
    // A store week belongs to the statement whose period it falls inside (weeks are what statements bill).
    const mine = records.filter((r) => {
      const k = toDateOnly(r.weekStart)!;
      return k >= startKey && k <= endKey;
    });
    out.set(st.id, {
      signed: mine.filter((r) => r.status === 'SIGNED').length,
      flagged: mine.filter((r) => r.status === 'FLAGGED').length,
    });
  }
  return out;
}
