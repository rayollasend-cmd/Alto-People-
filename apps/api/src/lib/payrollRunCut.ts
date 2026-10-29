import type { Prisma, PrismaClient } from '@prisma/client';
import { adjustPayDate } from './banking/holidays.js';
import { tenantIdForWrite } from './tenant.js';
import { orgDateKey } from './timeAnomalies.js';
import { membershipWindows } from './payScheduleMembership.js';
import { inWindows, punchFetchRange, workDayOf, type MembershipWindows, type PayPeriodCut, type PunchLike } from './payrollSchedule.js';

/**
 * How a pay run slices time (deep audit CODE-1) and when it pays (CODE-2).
 *
 * The cut itself is lib/payrollSchedule `punchesInPeriod`: a punch belongs
 * to the period whose days hold its clock-in ON THE SITE'S CLOCK. This file
 * adds what a RUN needs on top of it:
 *
 *  - The deploy transition. Runs made before the site-day cut sliced time by
 *    UTC midnights (PayrollRun.timeCut = 'UTC'). The evening of such a run's
 *    last day at a US site (Friday 8 PM Eastern = Saturday 00:00 UTC) was
 *    outside its UTC range, so it never paid those hours; under the site-day
 *    cut that evening belongs to the old period, which is already paid. The
 *    first site-day run after a UTC-cut run therefore also pays that one
 *    evening (`carry-in`), and leaves out anything the UTC-cut run already
 *    paid (east-of-UTC sites, whose early morning is the previous UTC day).
 *    Paid exactly once, across the change.
 *  - The run's pay date: tax-year inputs (year-to-date wages, wage bases,
 *    deferral limits) key on it, as the W-2 does.
 */

type Db = Prisma.TransactionClient | PrismaClient;
const DAY = 86_400_000;
/** YYYY-MM-DD of a DATE column (stored at UTC midnight). */
// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: YYYY-MM-DD of a @db.Date column (stored at UTC midnight).
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number): string => ymd(new Date(Date.parse(`${s}T00:00:00.000Z`) + n * DAY));

/** The UTC-cut run just before a run, for the deploy transition. */
export interface UtcCutPredecessor {
  periodStart: string;
  periodEnd: string;
  /** On a schedule's run: who was on the schedule on its last day (the carried-in evening). Null for a run not on one schedule. */
  windows: MembershipWindows | null;
}

/** Everything a run's punches are sliced by. */
export interface RunCut extends PayPeriodCut {
  /** The run's schedule membership (null: a run not for one pay schedule). */
  windows: MembershipWindows | null;
  /** The run before it sliced by UTC midnights (deploy transition), else null. */
  prevUtc: UtcCutPredecessor | null;
  /**
   * Slice by UTC midnights, as runs did before the site-day cut: only for
   * re-working a run made that way whose next run already carried its last
   * evening (lib/payrollRunCut keepsUtcCut) — so that evening is never paid twice.
   */
  utc?: boolean;
}

/**
 * The REGULAR run that paid the period just before this one, when it sliced
 * time by UTC midnights. Same schedule — or, for a run not on a schedule,
 * the same client filter. Null when there is none (or it used the site-day
 * cut), which after the first period past the deploy is always.
 */
export async function utcCutPredecessor(
  db: Db,
  input: { runId?: string | null; kind?: string | null; payrollScheduleId: string | null; clientId: string | null; periodStart: string },
): Promise<UtcCutPredecessor | null> {
  if ((input.kind ?? 'REGULAR') !== 'REGULAR') return null;
  const prevEnd = addDays(input.periodStart, -1);
  const prev = await db.payrollRun.findFirst({
    where: {
      tenantId: tenantIdForWrite(),
      kind: 'REGULAR',
      status: { not: 'CANCELLED' },
      timeCut: 'UTC',
      periodEnd: new Date(`${prevEnd}T00:00:00.000Z`),
      payrollScheduleId: input.payrollScheduleId,
      ...(input.payrollScheduleId ? {} : { clientId: input.clientId }),
      ...(input.runId ? { id: { not: input.runId } } : {}),
    },
    select: { periodStart: true },
  });
  if (!prev) return null;
  const windows = input.payrollScheduleId ? await membershipWindows(db, input.payrollScheduleId, prevEnd, prevEnd) : null;
  return { periodStart: ymd(prev.periodStart), periodEnd: prevEnd, windows };
}

/**
 * Re-working (re-aggregating) a run made under the UTC cut: it moves to the
 * site-day cut — unless the run after it already exists, because that run
 * carried this one's last evening in; then it keeps the UTC cut, so the
 * evening is paid once.
 */
export async function keepsUtcCut(db: Db, run: { id: string; periodEnd: Date; payrollScheduleId: string | null; clientId: string | null }): Promise<boolean> {
  const row = await db.payrollRun.findUnique({ where: { id: run.id }, select: { timeCut: true, kind: true } });
  if (row?.timeCut !== 'UTC' || row.kind !== 'REGULAR') return false;
  const next = await db.payrollRun.findFirst({
    where: {
      tenantId: tenantIdForWrite(),
      id: { not: run.id },
      kind: 'REGULAR',
      status: { not: 'CANCELLED' },
      periodStart: new Date(`${addDays(ymd(run.periodEnd), 1)}T00:00:00.000Z`),
      payrollScheduleId: run.payrollScheduleId,
      ...(run.payrollScheduleId ? {} : { clientId: run.clientId }),
    },
    select: { id: true },
  });
  return next !== null;
}

/** The clock-in range to fetch for a run (the period's, with its margin days — the carried-in evening is inside it). */
export function runFetchRange(cut: RunCut): { gte: Date; lt: Date } {
  return punchFetchRange(cut);
}

/**
 * Whether a run pays a punch: its site day is one of the run's days (and on
 * a schedule's run, one of the person's days on it) — plus, across the
 * deploy, the UTC-cut predecessor's unpaid last evening, minus anything the
 * predecessor already paid.
 */
export function runPunchFilter(cut: RunCut): (p: PunchLike) => boolean {
  const startUtc = Date.parse(`${cut.periodStart}T00:00:00.000Z`);
  if (cut.utc) {
    // The cut before CODE-1: its UTC days — on a schedule's run, only its people's site days.
    const endUtc = Date.parse(`${cut.periodEnd}T00:00:00.000Z`) + DAY;
    return (p) => {
      const t = p.clockInAt.getTime();
      if (t < startUtc || t >= endUtc) return false;
      if (!cut.windows) return true;
      const day = workDayOf(p.clockInAt, p.location?.timezone);
      return day >= cut.periodStart && day <= cut.periodEnd && inWindows(cut.windows, p.associateId, day);
    };
  }
  const prev = cut.prevUtc;
  const prevStartUtc = prev ? Date.parse(`${prev.periodStart}T00:00:00.000Z`) : 0;
  return (p) => {
    const day = workDayOf(p.clockInAt, p.location?.timezone);
    if (prev) {
      const t = p.clockInAt.getTime();
      // The UTC-cut run paid its UTC days — on a schedule's run, only its people's site days.
      const paidByPrev =
        t >= prevStartUtc && t < startUtc && (prev.windows === null || (day >= prev.periodStart && day <= prev.periodEnd && inWindows(prev.windows, p.associateId, day)));
      if (paidByPrev) return false;
      // Its last evening, which its UTC range left out (US sites: on or after this period's first UTC midnight).
      if (day === prev.periodEnd && t >= startUtc) return prev.windows === null || inWindows(prev.windows, p.associateId, day);
    }
    if (day < cut.periodStart || day > cut.periodEnd) return false;
    return cut.windows ? inWindows(cut.windows, p.associateId, day) : true;
  };
}

/** A run's punches: fetch with the margin, keep what the cut says (see runPunchFilter). */
export async function runPunches<T extends PunchLike>(cut: RunCut, fetch: (clockInAt: { gte: Date; lt: Date }) => Promise<T[]>): Promise<T[]> {
  const keep = runPunchFilter(cut);
  return (await fetch(runFetchRange(cut))).filter(keep);
}

/**
 * The day a run's checks are paid (YYYY-MM-DD), before it exists: the
 * period end plus the pay schedule's offset — the run's own schedule (the
 * pattern in force at the period end), else the client's, else the
 * company's, else 7 days — moved to the banking day before a weekend or
 * holiday. The same rule as lib/banking/funding payDateFor.
 */
export async function expectedPayDate(db: Db, input: { payrollScheduleId: string | null; clientId: string | null; periodEnd: string }): Promise<string> {
  const end = new Date(`${input.periodEnd}T00:00:00.000Z`);
  let offset: number | null = null;
  if (input.payrollScheduleId) {
    const s = await db.payrollSchedule.findFirst({
      where: { id: input.payrollScheduleId },
      select: { payDateOffsetDays: true, versions: { where: { effectiveFrom: { lte: end } }, orderBy: { effectiveFrom: 'desc' }, take: 1, select: { payDateOffsetDays: true } } },
    });
    if (s) offset = s.versions[0]?.payDateOffsetDays ?? s.payDateOffsetDays;
  }
  if (offset === null && input.clientId) {
    offset = (await db.payrollSchedule.findFirst({ where: { clientId: input.clientId, isActive: true, deletedAt: null }, select: { payDateOffsetDays: true } }))?.payDateOffsetDays ?? null;
  }
  if (offset === null) {
    offset = (await db.payrollSchedule.findFirst({ where: { tenantId: tenantIdForWrite(), clientId: null, isActive: true, deletedAt: null }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { payDateOffsetDays: true } }))?.payDateOffsetDays ?? null;
  }
  return adjustPayDate(addDays(input.periodEnd, offset ?? 7)).payDate;
}

/**
 * The cut and pay date for a run (or a preview of one), in one call. The
 * pay date is the schedule's — or today on the company's calendar when that
 * has already passed (a late run is paid when it's paid, and the W-2 counts
 * it then).
 */
export async function runCutFor(
  db: Db,
  input: { runId?: string | null; kind?: string | null; payrollScheduleId: string | null; clientId: string | null; periodStart: string; periodEnd: string; windows: MembershipWindows | null },
  now: Date = new Date(),
): Promise<{ cut: RunCut; payDate: Date }> {
  const [prevUtc, scheduled] = await Promise.all([utcCutPredecessor(db, input), expectedPayDate(db, input)]);
  const today = orgDateKey(now);
  const payDate = scheduled < today ? today : scheduled;
  return {
    cut: { periodStart: input.periodStart, periodEnd: input.periodEnd, windows: input.windows, prevUtc },
    payDate: new Date(`${payDate}T00:00:00.000Z`),
  };
}

/** What a locked run needs to say which punches it paid. */
export interface RunCutSource {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  payrollScheduleId: string | null;
  clientId: string | null;
  kind: string;
  timeCut: string;
}

/** A punch with the client it was worked for (a client's run pays only that client's time). */
export type PaidPunch = PunchLike & { clientId?: string | null };

/**
 * For runs already made: per run, whether it paid a punch — under the cut
 * it was MADE with (PayrollRun.timeCut). A UTC-cut run paid its UTC days
 * (on a schedule's run, only its people's site days inside the period); a
 * site-day run pays by runPunchFilter, the deploy carry-in included. Used
 * by the pay-and-bill check (deep audit MONEY-1) so "paid" means the check
 * that paid those very hours, not "had some check that period".
 */
export async function paidPunchFilters(db: Db, runs: ReadonlyArray<RunCutSource>): Promise<Map<string, (p: PaidPunch) => boolean>> {
  if (runs.length === 0) return new Map();
  // Membership per schedule over every run of it (one range each, a day early for a carried-in evening).
  const ranges = new Map<string, { from: string; to: string }>();
  for (const r of runs) {
    if (!r.payrollScheduleId) continue;
    const from = addDays(ymd(r.periodStart), -1);
    const to = ymd(r.periodEnd);
    const cur = ranges.get(r.payrollScheduleId);
    ranges.set(r.payrollScheduleId, { from: cur && cur.from < from ? cur.from : from, to: cur && cur.to > to ? cur.to : to });
  }
  const { membershipWindowsFor } = await import('./payScheduleMembership.js');
  const members = await membershipWindowsFor(db, [...ranges].map(([scheduleId, r]) => ({ scheduleId, ...r })));
  // UTC-cut REGULAR runs just before a site-day run (the deploy transition), in one query.
  const siteDay = runs.filter((r) => r.timeCut !== 'UTC' && r.kind === 'REGULAR');
  const prevEnds = [...new Set(siteDay.map((r) => addDays(ymd(r.periodStart), -1)))];
  const utcPrev = prevEnds.length
    ? await db.payrollRun.findMany({
        where: { tenantId: tenantIdForWrite(), kind: 'REGULAR', status: { not: 'CANCELLED' }, timeCut: 'UTC', periodEnd: { in: prevEnds.map((d) => new Date(`${d}T00:00:00.000Z`)) } },
        select: { periodStart: true, periodEnd: true, payrollScheduleId: true, clientId: true },
      })
    : [];
  return paidPunchFiltersFrom(runs, members, utcPrev);
}

/**
 * paidPunchFilters without the database: the runs, each schedule's
 * membership windows (keyed by schedule id), and the UTC-cut REGULAR runs
 * that may sit just before a site-day run. Pure — lib/payrollBackPay and
 * its tests build on it.
 */
export function paidPunchFiltersFrom(
  runs: ReadonlyArray<RunCutSource>,
  members: ReadonlyMap<string, MembershipWindows>,
  utcPrev: ReadonlyArray<{ periodStart: Date; periodEnd: Date; payrollScheduleId: string | null; clientId: string | null }>,
): Map<string, (p: PaidPunch) => boolean> {
  const out = new Map<string, (p: PaidPunch) => boolean>();
  for (const r of runs) {
    const period: PayPeriodCut = { periodStart: ymd(r.periodStart), periodEnd: ymd(r.periodEnd) };
    const windows = r.payrollScheduleId ? (members.get(r.payrollScheduleId) ?? new Map()) : null;
    // A run made for one client (schedule or not) fetched only that client's time.
    const clientOnly = r.clientId;
    let paid: (p: PaidPunch) => boolean;
    if (r.timeCut === 'UTC') {
      paid = runPunchFilter({ ...period, windows, prevUtc: null, utc: true });
    } else {
      const prevEnd = addDays(period.periodStart, -1);
      const prev = r.kind === 'REGULAR' ? utcPrev.find((x) => ymd(x.periodEnd) === prevEnd && x.payrollScheduleId === r.payrollScheduleId && (r.payrollScheduleId ? true : x.clientId === r.clientId)) : undefined;
      paid = runPunchFilter({ ...period, windows, prevUtc: prev ? { periodStart: ymd(prev.periodStart), periodEnd: prevEnd, windows } : null });
    }
    out.set(r.id, clientOnly ? (p) => p.clientId === clientOnly && paid(p) : paid);
  }
  return out;
}
