import { Prisma, type PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import type { SessionUser } from '../types/express.js';
import { enqueueAudit } from './audit.js';
import { createApprovalRequest, registerApplyHandler } from './approvalRequests.js';
import { secondPersonExists } from './approvalPolicy.js';
import { fmtDay, fmtDayRange } from './humanDates.js';
import { payableMs, splitWeeklyOvertime, type PayableEntry } from './payroll.js';
import { paidPunchFiltersFrom, runPunchFilter, type PaidPunch, type RunCutSource } from './payrollRunCut.js';
import { inWindows, workDayOf, type MembershipWindows } from './payrollSchedule.js';
import { roundCents } from './roundCents.js';
import { scopeAssociates, scopePayrollRuns, scopeWhere } from './scope.js';
import { tenantIdForWrite } from './tenant.js';
import { companyWorkweek } from './timeAnomalies.js';

/**
 * BACK PAY: THE EVENING HOURS THE OLD UTC CUT MISSED (deep audit 2026-10-29;
 * the owner: "pay the evening hours the old UTC cut never paid").
 *
 * Runs made before the site-day cut (PayrollRun.timeCut = 'UTC') paid the
 * punches whose clock-in fell inside their UTC days. A punch whose day ON
 * THE SITE'S CLOCK is one of the run's days but whose instant is not — at a
 * US site, the last day's evening after UTC midnight (Friday 7 PM in
 * Chicago); east of UTC, the first day's early morning — was not that run's
 * to pay, and often no other run paid it either. This module finds those
 * punches, prices them, and puts them on the next regular run as BACK_PAY
 * add-ons, once per punch.
 *
 *   missed   a punch whose site day is a UTC-cut run's day (its person and
 *            client inside that run's population) and whose instant is
 *            outside the run's UTC days — that no run paid (a locked run
 *            with a paycheck for the person whose own cut takes the punch,
 *            the first site-day run's carry-in included) and no draft run
 *            will pay, and that isn't already claimed (BackPayClaim).
 *   priced   hours (net of breaks) × the person's hourly rate on that day
 *            (their compensation record then; a salaried day is never back
 *            pay), plus the overtime premium the hours would have earned:
 *            that company week's overtime recomputed with them in, minus
 *            what was paid, at half the rate.
 *   added    one BACK_PAY add-on per person on the next DRAFT regular run
 *            that pays them (taxable regular wages; the paystub line names
 *            the periods), with a unique claim per punch — behind the
 *            second-person approval where a second person exists.
 */

type Db = Prisma.TransactionClient | PrismaClient;
const DAY = 86_400_000;
const round2 = (n: number) => roundCents(n);
// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: YYYY-MM-DD of a @db.Date column (stored at UTC midnight).
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number): string => ymd(new Date(Date.parse(`${s}T00:00:00.000Z`) + n * DAY));

/* ---- The pure core -------------------------------------------------------- */

/** A run as the detector sees it. */
export interface BackPayRun extends RunCutSource {
  status: string;
  /** People with a non-voided paycheck on it. */
  payees: ReadonlySet<string>;
}

/** An approved, closed punch. */
export interface BackPayPunch extends PaidPunch, PayableEntry {
  id: string;
  associateId: string;
  clientId: string | null;
  clockOutAt: Date;
  location?: { timezone: string } | null;
}

export interface MissedPunch {
  punch: BackPayPunch;
  /** Its day on the site's clock. */
  workDay: string;
  /** The UTC-cut run whose period holds that day. */
  sourceRun: BackPayRun;
}

const LOCKED = new Set(['FINALIZED', 'DISBURSED']);

/**
 * The punches the UTC cut left out of every run. `windows` is each pay
 * schedule's membership (by schedule id) over the runs' days; `claimed` the
 * punch ids already on a live back-pay claim.
 */
export function missedByUtcCut(input: {
  runs: ReadonlyArray<BackPayRun>;
  punches: ReadonlyArray<BackPayPunch>;
  windows: ReadonlyMap<string, MembershipWindows>;
  claimed: ReadonlySet<string>;
}): MissedPunch[] {
  const live = input.runs.filter((r) => r.status !== 'CANCELLED');
  const sources = live.filter((r) => r.timeCut === 'UTC' && r.kind === 'REGULAR' && LOCKED.has(r.status));
  if (sources.length === 0) return [];
  const utcPrev = live.filter((r) => r.timeCut === 'UTC' && r.kind === 'REGULAR');
  const paidBy = paidPunchFiltersFrom(live, input.windows, utcPrev);
  // A draft run is re-worked before it pays, under either cut (lib/payrollRunCut keepsUtcCut): what either takes, it will pay.
  const draftCovers = new Map(
    live
      .filter((r) => r.status === 'DRAFT')
      .map((r) => {
        const windows = r.payrollScheduleId ? (input.windows.get(r.payrollScheduleId) ?? new Map()) : null;
        const cut = { periodStart: ymd(r.periodStart), periodEnd: ymd(r.periodEnd), windows, prevUtc: null };
        const utc = runPunchFilter({ ...cut, utc: true });
        const site = paidBy.get(r.id)!;
        return [r.id, (p: PaidPunch) => site(p) || ((!r.clientId || p.clientId === r.clientId) && utc(p))] as const;
      }),
  );
  const coveredByAnotherRun = (p: BackPayPunch, source: BackPayRun): boolean =>
    live.some((q) => {
      if (q.id === source.id) return false;
      if (q.status === 'DRAFT') return draftCovers.get(q.id)!(p);
      return q.payees.has(p.associateId) && paidBy.get(q.id)!(p);
    });

  const out: MissedPunch[] = [];
  for (const p of input.punches) {
    if (input.claimed.has(p.id)) continue;
    const day = workDayOf(p.clockInAt, p.location?.timezone);
    const t = p.clockInAt.getTime();
    const source = sources.find((r) => {
      const start = ymd(r.periodStart);
      const end = ymd(r.periodEnd);
      if (day < start || day > end) return false;
      // Inside its UTC days: the run's own cut took it — paid there or not, it isn't this cut's miss.
      if (t >= r.periodStart.getTime() && t < r.periodEnd.getTime() + DAY) return false;
      if (r.clientId && p.clientId !== r.clientId) return false;
      if (r.payrollScheduleId) return inWindows(input.windows.get(r.payrollScheduleId) ?? new Map(), p.associateId, day);
      return true;
    });
    if (!source) continue;
    if (coveredByAnotherRun(p, source)) continue;
    out.push({ punch: p, workDay: day, sourceRun: source });
  }
  return out;
}

/** The first day of the company week (Saturday by default) holding a day. */
export function weekOf(day: string, weekStartsOn: number = companyWorkweek().weekStartsOn): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  return addDays(day, -((d.getUTCDay() - weekStartsOn + 7) % 7));
}

export interface PricedPunch {
  timeEntryId: string;
  workDay: string;
  hours: number;
  rate: number;
  sourceRunId: string;
  /** Its share of the back pay: hours × rate plus its share of the week's overtime premium. */
  amount: number;
}

export interface BackPayPerson {
  associateId: string;
  name: string;
  punches: PricedPunch[];
  hours: number;
  /** The hourly rates that applied (one, usually). */
  rates: number[];
  overtimeHours: number;
  overtimePremium: number;
  amount: number;
  /** The paid periods the hours belong to. */
  periods: Array<{ periodStart: string; periodEnd: string }>;
}

/**
 * Price the missed punches. `weekEntries` holds each person's approved,
 * closed punches around the affected weeks (the missed ones included);
 * `rateOn` the hourly rate on a day — null for a salaried day, which is
 * never hourly back pay.
 */
export function priceBackPay(input: {
  missed: ReadonlyArray<MissedPunch>;
  weekEntries: ReadonlyMap<string, ReadonlyArray<BackPayPunch>>;
  rateOn: (associateId: string, day: string) => number | null;
  nameOf: (associateId: string) => string;
  weekStartsOn?: number;
}): BackPayPerson[] {
  const byPerson = new Map<string, MissedPunch[]>();
  for (const m of input.missed) byPerson.set(m.punch.associateId, [...(byPerson.get(m.punch.associateId) ?? []), m]);
  const out: BackPayPerson[] = [];
  for (const [associateId, missedAll] of byPerson) {
    const priced: PricedPunch[] = [];
    let overtimeHours = 0;
    let overtimePremium = 0;
    const missed = missedAll.filter((m) => input.rateOn(associateId, m.workDay) !== null);
    const missedIds = new Set(missed.map((m) => m.punch.id));
    const byWeek = new Map<string, MissedPunch[]>();
    for (const m of missed) {
      const w = weekOf(m.workDay, input.weekStartsOn);
      byWeek.set(w, [...(byWeek.get(w) ?? []), m]);
    }
    for (const [week, ms] of [...byWeek].sort(([a], [b]) => a.localeCompare(b))) {
      const weekEnd = addDays(week, 6);
      const inWeek = (input.weekEntries.get(associateId) ?? []).filter((e) => {
        const d = workDayOf(e.clockInAt, e.location?.timezone);
        return d >= week && d <= weekEnd;
      });
      // The missed punches themselves are always in the week's set, fetched or not.
      const all = [...inWeek.filter((e) => !missedIds.has(e.id)), ...ms.map((m) => m.punch)];
      const ot = (entries: ReadonlyArray<BackPayPunch>) => splitWeeklyOvertime(entries.map((e) => ({ ...e, status: 'APPROVED' }))).overtimeHours;
      const extraOt = Math.max(0, round2(ot(all) - ot(all.filter((e) => !missedIds.has(e.id)))));
      const sorted = [...ms].sort((a, b) => a.punch.clockInAt.getTime() - b.punch.clockInAt.getTime());
      const weekRate = input.rateOn(associateId, sorted[sorted.length - 1]!.workDay)!;
      const premium = round2(extraOt * weekRate * 0.5);
      overtimeHours = round2(overtimeHours + extraOt);
      overtimePremium = round2(overtimePremium + premium);
      const hoursOf = (m: MissedPunch) => round2(payableMs(m.punch) / 3_600_000);
      const weekHours = sorted.reduce((s, m) => s + hoursOf(m), 0);
      let premiumLeft = premium;
      sorted.forEach((m, i) => {
        const hours = hoursOf(m);
        const rate = input.rateOn(associateId, m.workDay)!;
        const share = i === sorted.length - 1 ? premiumLeft : round2(weekHours > 0 ? (premium * hours) / weekHours : 0);
        premiumLeft = round2(premiumLeft - share);
        priced.push({ timeEntryId: m.punch.id, workDay: m.workDay, hours, rate, sourceRunId: m.sourceRun.id, amount: round2(hours * rate + share) });
      });
    }
    if (priced.length === 0) continue;
    const periods = new Map<string, { periodStart: string; periodEnd: string }>();
    for (const m of missed) periods.set(m.sourceRun.id, { periodStart: ymd(m.sourceRun.periodStart), periodEnd: ymd(m.sourceRun.periodEnd) });
    out.push({
      associateId,
      name: input.nameOf(associateId),
      punches: priced.sort((a, b) => a.workDay.localeCompare(b.workDay)),
      hours: round2(priced.reduce((s, p) => s + p.hours, 0)),
      rates: [...new Set(priced.map((p) => p.rate))].sort((a, b) => a - b),
      overtimeHours,
      overtimePremium,
      amount: round2(priced.reduce((s, p) => s + p.amount, 0)),
      periods: [...periods.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The paystub line: what it pays for, in plain words. */
export function backPayNote(p: Pick<BackPayPerson, 'hours' | 'overtimePremium' | 'periods' | 'punches'>): string {
  const days = [...new Set(p.punches.map((x) => x.workDay))].map((d) => fmtDay(d)).join(', ');
  const periods = p.periods.map((x) => fmtDayRange(x.periodStart, x.periodEnd)).join('; ');
  const ot = p.overtimePremium > 0 ? ` incl. $${p.overtimePremium.toFixed(2)} overtime premium` : '';
  return `Back pay: ${p.hours.toFixed(2)}h on ${days} (evening hours the ${periods} check missed)${ot}`.slice(0, 500);
}

/* ---- Reading it from the database ----------------------------------------- */

export interface BackPayTarget {
  runId: string;
  periodStart: string;
  periodEnd: string;
}

export interface BackPayOwed {
  total: number;
  people: Array<BackPayPerson & { target: BackPayTarget | null }>;
  /** People owed back pay who are on no open regular run yet. */
  waitingForRun: number;
}

/** Claims that stand: approval still pending, or an add-on on a run that isn't cancelled. */
async function liveClaimIds(db: Db, timeEntryIds: string[]): Promise<{ live: Set<string>; stale: string[] }> {
  if (timeEntryIds.length === 0) return { live: new Set(), stale: [] };
  const claims = await db.backPayClaim.findMany({ where: { tenantId: tenantIdForWrite(), timeEntryId: { in: timeEntryIds } } });
  const addOnIds = claims.map((c) => c.addOnId).filter((x): x is string => !!x);
  const approvalIds = claims.map((c) => c.approvalRequestId).filter((x): x is string => !!x);
  const [addOns, approvals] = await Promise.all([
    addOnIds.length ? db.payrollRunAddOn.findMany({ where: { id: { in: addOnIds } }, select: { id: true, payrollRun: { select: { status: true } } } }) : [],
    approvalIds.length ? db.approvalRequest.findMany({ where: { id: { in: approvalIds } }, select: { id: true, status: true } }) : [],
  ]);
  const addOnLive = new Set(addOns.filter((a) => a.payrollRun.status !== 'CANCELLED').map((a) => a.id));
  const pending = new Set(approvals.filter((a) => a.status === 'PENDING').map((a) => a.id));
  const live = new Set<string>();
  const stale: string[] = [];
  for (const c of claims) {
    const ok = c.status === 'PENDING_APPROVAL' ? !!c.approvalRequestId && pending.has(c.approvalRequestId) : !!c.addOnId && addOnLive.has(c.addOnId);
    if (ok) live.add(c.timeEntryId);
    else stale.push(c.id);
  }
  return { live, stale };
}

const runSelect = {
  id: true,
  periodStart: true,
  periodEnd: true,
  payrollScheduleId: true,
  clientId: true,
  kind: true,
  status: true,
  timeCut: true,
  items: { where: { status: { not: 'VOIDED' as const } }, select: { associateId: true, hourlyRate: true } },
} as const;

/**
 * What is owed, for the people in the caller's reach: the detector over the
 * tenant's UTC-cut runs, priced, each person with the open run that would pay it.
 */
export async function backPayOwed(db: Db, user: SessionUser): Promise<BackPayOwed> {
  const tenantId = tenantIdForWrite();
  const empty: BackPayOwed = { total: 0, people: [], waitingForRun: 0 };
  const sources = await db.payrollRun.findMany({
    where: scopeWhere<Prisma.PayrollRunWhereInput>({ tenantId, timeCut: 'UTC', kind: 'REGULAR', status: { in: ['FINALIZED', 'DISBURSED'] } }, scopePayrollRuns(user)),
    select: { periodStart: true, periodEnd: true },
  });
  if (sources.length === 0) return empty;

  // The only instants a UTC cut can miss: the day after each period's UTC end (evening at a site west of UTC)
  // and the day before its start (early morning east of it).
  const edges: Prisma.TimeEntryWhereInput[] = sources.flatMap((r) => [
    { clockInAt: { gte: new Date(r.periodEnd.getTime() + DAY), lt: new Date(r.periodEnd.getTime() + 2 * DAY) } },
    { clockInAt: { gte: new Date(r.periodStart.getTime() - DAY), lt: r.periodStart } },
  ]);
  const punchSelect = {
    id: true,
    associateId: true,
    clientId: true,
    status: true,
    clockInAt: true,
    clockOutAt: true,
    breaks: { select: { startedAt: true, endedAt: true } },
    location: { select: { timezone: true } },
  } as const;
  const candidates = (
    await db.timeEntry.findMany({
      where: scopeWhere<Prisma.TimeEntryWhereInput>({ tenantId, status: 'APPROVED', clockOutAt: { not: null }, OR: edges }, { associate: { is: scopeAssociates(user) } }),
      select: punchSelect,
    })
  ).map(asPunch);
  if (candidates.length === 0) return empty;

  const t0 = Math.min(...candidates.map((c) => c.clockInAt.getTime()));
  const t1 = Math.max(...candidates.map((c) => c.clockInAt.getTime()));
  const fromDay = addDays(ymd(new Date(t0)), -2);
  const toDay = addDays(ymd(new Date(t1)), 2);
  const runs = (
    await db.payrollRun.findMany({
      where: { tenantId, status: { not: 'CANCELLED' }, periodEnd: { gte: new Date(`${fromDay}T00:00:00.000Z`) }, periodStart: { lte: new Date(`${toDay}T00:00:00.000Z`) } },
      select: runSelect,
    })
  ).map(asRun);
  const windows = await windowsFor(db, runs);
  const { live } = await liveClaimIds(db, candidates.map((c) => c.id));
  const missed = missedByUtcCut({ runs, punches: candidates, windows, claimed: live });
  if (missed.length === 0) return empty;

  const people = [...new Set(missed.map((m) => m.punch.associateId))];
  const weeks = missed.map((m) => weekOf(m.workDay));
  const wFrom = addDays(weeks.reduce((a, b) => (a < b ? a : b)), -1);
  const wTo = addDays(weeks.reduce((a, b) => (a > b ? a : b)), 8);
  const [weekRows, comps, names] = await Promise.all([
    db.timeEntry.findMany({
      where: { tenantId, associateId: { in: people }, status: 'APPROVED', clockOutAt: { not: null }, clockInAt: { gte: new Date(`${wFrom}T00:00:00.000Z`), lt: new Date(`${wTo}T00:00:00.000Z`) } },
      select: punchSelect,
    }),
    db.compensationRecord.findMany({ where: { associateId: { in: people } }, select: { associateId: true, payType: true, amount: true, effectiveFrom: true, effectiveTo: true }, orderBy: { effectiveFrom: 'desc' } }),
    db.associate.findMany({ where: { id: { in: people } }, select: { id: true, firstName: true, lastName: true } }),
  ]);
  const weekEntries = new Map<string, BackPayPunch[]>();
  for (const r of weekRows.map(asPunch)) weekEntries.set(r.associateId, [...(weekEntries.get(r.associateId) ?? []), r]);
  const nameById = new Map(names.map((n) => [n.id, `${n.firstName} ${n.lastName}`.trim()]));
  // The rate that applied that day; else what the run paid them that period; else the default.
  const paidRate = new Map<string, number>();
  for (const m of missed) {
    const it = runs.find((r) => r.id === m.sourceRun.id)?.items.find((i) => i.associateId === m.punch.associateId);
    if (it && Number(it.hourlyRate) > 0) paidRate.set(`${m.punch.associateId}|${m.workDay}`, Number(it.hourlyRate));
  }
  const rateOn = (associateId: string, day: string): number | null => {
    const rec = comps.find((c) => c.associateId === associateId && ymd(c.effectiveFrom) <= day && (c.effectiveTo === null || ymd(c.effectiveTo) >= day));
    if (rec) return rec.payType === 'HOURLY' ? Number(rec.amount) : null;
    return paidRate.get(`${associateId}|${day}`) ?? env.DEFAULT_ASSOCIATE_PAY_RATE;
  };
  const priced = priceBackPay({ missed, weekEntries, rateOn, nameOf: (id) => nameById.get(id) ?? 'Someone' });
  const targets = await openRunsFor(db, user, priced.map((p) => p.associateId));
  const rows = priced.map((p) => ({ ...p, target: targets.get(p.associateId) ?? null }));
  return { total: round2(rows.reduce((s, r) => s + r.amount, 0)), people: rows, waitingForRun: rows.filter((r) => !r.target).length };
}

type RunRow = Prisma.PayrollRunGetPayload<{ select: typeof runSelect }>;
type BackPayRunRow = BackPayRun & { items: RunRow['items'] };
function asRun(r: RunRow): BackPayRunRow {
  return { ...r, payees: new Set(r.items.map((i) => i.associateId)) };
}
function asPunch(e: { id: string; associateId: string; clientId: string | null; status: string; clockInAt: Date; clockOutAt: Date | null; breaks: Array<{ startedAt: Date; endedAt: Date | null }>; location: { timezone: string } | null }): BackPayPunch {
  return { ...e, clockOutAt: e.clockOutAt! };
}

/** Each pay schedule's membership over its runs' days (and the day before, for a carried-in evening). */
async function windowsFor(db: Db, runs: ReadonlyArray<RunCutSource>): Promise<Map<string, MembershipWindows>> {
  const ranges = new Map<string, { from: string; to: string }>();
  for (const r of runs) {
    if (!r.payrollScheduleId) continue;
    const from = addDays(ymd(r.periodStart), -1);
    const to = ymd(r.periodEnd);
    const cur = ranges.get(r.payrollScheduleId);
    ranges.set(r.payrollScheduleId, { from: cur && cur.from < from ? cur.from : from, to: cur && cur.to > to ? cur.to : to });
  }
  if (ranges.size === 0) return new Map();
  const { membershipWindowsFor } = await import('./payScheduleMembership.js');
  return membershipWindowsFor(db, [...ranges].map(([scheduleId, r]) => ({ scheduleId, ...r })));
}

/**
 * The open (DRAFT) regular run that would pay each person: the earliest one
 * whose people they're among — a run not on a schedule takes anyone; a
 * schedule's run only its members for its days.
 */
export async function openRunsFor(db: Db, user: SessionUser, associateIds: string[]): Promise<Map<string, BackPayTarget>> {
  const out = new Map<string, BackPayTarget>();
  if (associateIds.length === 0) return out;
  const drafts = await db.payrollRun.findMany({
    where: scopeWhere<Prisma.PayrollRunWhereInput>({ tenantId: tenantIdForWrite(), kind: 'REGULAR', status: 'DRAFT' }, scopePayrollRuns(user)),
    select: { id: true, periodStart: true, periodEnd: true, payrollScheduleId: true },
    orderBy: { periodStart: 'asc' },
  });
  if (drafts.length === 0) return out;
  const { membershipWindowsFor } = await import('./payScheduleMembership.js');
  const scheduled = drafts.filter((d) => d.payrollScheduleId);
  const byRun = new Map<string, MembershipWindows>();
  for (const d of scheduled) {
    const m = await membershipWindowsFor(db, [{ scheduleId: d.payrollScheduleId!, from: ymd(d.periodStart), to: ymd(d.periodEnd) }]);
    byRun.set(d.id, m.get(d.payrollScheduleId!) ?? new Map());
  }
  for (const id of associateIds) {
    const run = drafts.find((d) => !d.payrollScheduleId || (byRun.get(d.id)?.get(id)?.length ?? 0) > 0);
    if (run) out.set(id, { runId: run.id, periodStart: ymd(run.periodStart), periodEnd: ymd(run.periodEnd) });
  }
  return out;
}

/* ---- Adding it to a run ---------------------------------------------------- */

export interface BackPayAddResult {
  /** Added now (or, gated, sent for approval). */
  people: Array<{ associateId: string; name: string; amount: number; runId: string | null }>;
  total: number;
  /** People with nothing open to add to. */
  waiting: Array<{ associateId: string; name: string; amount: number }>;
  pending?: { approvalId: string };
}

interface ClaimInput {
  associateId: string;
  name: string;
  target: BackPayTarget | null;
  punches: PricedPunch[];
  hours: number;
  amount: number;
  note: string;
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Put what's owed on the next regular run(s): one BACK_PAY add-on per person,
 * one claim per punch (unique — two presses add it once). With a second
 * person to decide, it waits for them (the claims hold the punches meanwhile).
 * `reaggregate` re-works a run after its add-ons change (routes/payroll).
 */
export async function addBackPay(
  db: PrismaClient,
  user: SessionUser,
  input: { associateIds?: string[] | null },
  reaggregate: (runId: string) => Promise<void>,
): Promise<BackPayAddResult> {
  const owed = await backPayOwed(db, user);
  const chosen = owed.people.filter((p) => !input.associateIds || input.associateIds.includes(p.associateId));
  if (chosen.length === 0) throw new HttpError(409, 'nothing_owed', 'There is no back pay to add — it may have been added already.');
  const ready = chosen.filter((p) => p.target);
  const waiting = chosen.filter((p) => !p.target).map((p) => ({ associateId: p.associateId, name: p.name, amount: p.amount }));
  if (ready.length === 0) throw new HttpError(409, 'no_open_run', 'There is no open regular run to add it to. Start the next run, then add it there.');
  const claims: ClaimInput[] = ready.map((p) => ({ associateId: p.associateId, name: p.name, target: p.target, punches: p.punches, hours: p.hours, amount: p.amount, note: backPayNote(p) }));
  const total = round2(claims.reduce((s, c) => s + c.amount, 0));
  const tenantId = tenantIdForWrite();

  // The second person (memory: second-person approvals): where one exists, it waits for them.
  if (await secondPersonExists(db, 'process:payroll', user.id)) {
    const periods = [...new Set(ready.flatMap((p) => p.periods.map((x) => fmtDayRange(x.periodStart, x.periodEnd))))];
    const approvalId = await db.$transaction(async (tx) => {
      await dropStale(tx, claims.flatMap((c) => c.punches.map((p) => p.timeEntryId)));
      const req = await createApprovalRequest(tx as unknown as PrismaClient, {
        kind: 'BACK_PAY',
        subjectType: 'BackPay',
        subjectId: ready[0]!.associateId,
        title: `Back pay: $${total.toFixed(2)} for ${ready.length} ${ready.length === 1 ? 'person' : 'people'} (evening hours the old cut missed)`,
        summary: ready.map((p) => `${p.name} $${p.amount.toFixed(2)}`).join(', ').slice(0, 500),
        proposed: { total: `$${total.toFixed(2)}`, people: String(ready.length), periods: periods.join('; ').slice(0, 300), claims: claims.map((c) => ({ associateId: c.associateId, name: c.name, note: c.note })) },
        requesterUserId: user.id,
        approver: { capability: 'process:payroll' },
        associateId: ready.length === 1 ? ready[0]!.associateId : null,
      });
      await writeClaims(tx, claims, { status: 'PENDING_APPROVAL', approvalRequestId: req.id, createdById: user.id });
      return req.id;
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new HttpError(409, 'already_added', 'This back pay was just added or sent for approval.');
      throw err;
    });
    enqueueAudit({ actorUserId: user.id, action: 'payroll.back_pay_requested', entityType: 'ApprovalRequest', entityId: approvalId, metadata: { tenantId, total, people: ready.length, punches: claims.reduce((n, c) => n + c.punches.length, 0) } }, 'payrollBackPay');
    return { people: claims.map((c) => ({ associateId: c.associateId, name: c.name, amount: c.amount, runId: null })), total, waiting, pending: { approvalId } };
  }

  const runIds = await putOnRuns(db, claims, user.id, null);
  for (const runId of runIds) await reaggregate(runId);
  enqueueAudit({ actorUserId: user.id, action: 'payroll.back_pay_added', entityType: 'PayrollRun', entityId: [...runIds][0] ?? 'none', metadata: { tenantId, total, people: claims.length, runs: [...runIds], note: 'No second person holds process:payroll — added without one.' } }, 'payrollBackPay');
  return { people: claims.map((c) => ({ associateId: c.associateId, name: c.name, amount: c.amount, runId: c.target!.runId })), total, waiting };
}

/** Remove claims that no longer stand for these punches, so they can be claimed again. */
async function dropStale(tx: Db, timeEntryIds: string[]): Promise<void> {
  const { stale } = await liveClaimIds(tx, timeEntryIds);
  if (stale.length) await tx.backPayClaim.deleteMany({ where: { id: { in: stale } } });
}

async function writeClaims(tx: Db, claims: ClaimInput[], extra: { status: string; approvalRequestId?: string | null; createdById: string | null; addOnByPerson?: Map<string, { addOnId: string; runId: string }> }): Promise<void> {
  await tx.backPayClaim.createMany({
    data: claims.flatMap((c) =>
      c.punches.map((p) => ({
        tenantId: tenantIdForWrite(),
        timeEntryId: p.timeEntryId,
        associateId: c.associateId,
        sourceRunId: p.sourceRunId,
        payrollRunId: extra.addOnByPerson?.get(c.associateId)?.runId ?? null,
        addOnId: extra.addOnByPerson?.get(c.associateId)?.addOnId ?? null,
        approvalRequestId: extra.approvalRequestId ?? null,
        workDate: new Date(`${p.workDay}T00:00:00.000Z`),
        hours: p.hours,
        rate: p.rate,
        amount: p.amount,
        status: extra.status,
        createdById: extra.createdById,
      })),
    ),
  });
}

/** The add-ons and their claims, in one transaction (the unique claim per punch is the guard). Returns the runs touched. */
async function putOnRuns(db: PrismaClient, claims: ClaimInput[], actorUserId: string | null, approvalRequestId: string | null): Promise<Set<string>> {
  const runIds = new Set<string>();
  await db
    .$transaction(async (tx) => {
      if (!approvalRequestId) await dropStale(tx, claims.flatMap((c) => c.punches.map((p) => p.timeEntryId)));
      const addOnByPerson = new Map<string, { addOnId: string; runId: string }>();
      for (const c of claims) {
        // The run must still be open: an add-on only lands on a draft.
        const run = await tx.payrollRun.findFirst({ where: { id: c.target!.runId, status: 'DRAFT' }, select: { id: true } });
        if (!run) throw new HttpError(409, 'run_not_open', 'The run it was going on is no longer open — refresh and add it again.');
        const addOn = await tx.payrollRunAddOn.create({
          data: { payrollRunId: run.id, associateId: c.associateId, kind: 'BACK_PAY', amount: c.amount, hours: c.hours, note: c.note, createdById: actorUserId },
        });
        addOnByPerson.set(c.associateId, { addOnId: addOn.id, runId: run.id });
        runIds.add(run.id);
      }
      if (approvalRequestId) {
        for (const c of claims) {
          const a = addOnByPerson.get(c.associateId)!;
          await tx.backPayClaim.updateMany({ where: { approvalRequestId, associateId: c.associateId, status: 'PENDING_APPROVAL' }, data: { status: 'ADDED', addOnId: a.addOnId, payrollRunId: a.runId } });
        }
      } else {
        await writeClaims(tx, claims, { status: 'ADDED', createdById: actorUserId, addOnByPerson });
      }
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new HttpError(409, 'already_added', 'This back pay was just added — it is on the run once.');
      throw err;
    });
  return runIds;
}

/* ---- The second person's decision ------------------------------------------ */

registerApplyHandler(
  'BACK_PAY',
  async (db, row, decider) => {
    const claimRows = await db.backPayClaim.findMany({ where: { approvalRequestId: row.id, status: 'PENDING_APPROVAL' } });
    if (claimRows.length === 0) return;
    const proposed = (row.proposed ?? {}) as { claims?: Array<{ associateId: string; name: string; note: string }> };
    const people = [...new Set(claimRows.map((c) => c.associateId))];
    // The decider's reach decides which open runs they may add to (a company-wide decider when absent).
    const deciderUser = decider.reach ?? ({ id: decider.id, role: decider.role } as unknown as SessionUser);
    const targets = await openRunsFor(db, deciderUser, people);
    const claims: ClaimInput[] = people.flatMap((associateId) => {
      const rows = claimRows.filter((c) => c.associateId === associateId);
      const target = targets.get(associateId) ?? null;
      if (!target) return [];
      const meta = proposed.claims?.find((c) => c.associateId === associateId);
      return [
        {
          associateId,
          name: meta?.name ?? 'Someone',
          target,
          punches: rows.map((r) => ({ timeEntryId: r.timeEntryId, workDay: ymd(r.workDate), hours: Number(r.hours), rate: Number(r.rate), sourceRunId: r.sourceRunId ?? '', amount: Number(r.amount) })),
          hours: round2(rows.reduce((s, r) => s + Number(r.hours), 0)),
          amount: round2(rows.reduce((s, r) => s + Number(r.amount), 0)),
          note: meta?.note ?? 'Back pay: evening hours an earlier check missed',
        },
      ];
    });
    // Someone with no open run now: their claims let go, so the punches are offered again when one opens.
    const without = people.filter((id) => !targets.has(id));
    if (without.length) await db.backPayClaim.deleteMany({ where: { approvalRequestId: row.id, associateId: { in: without } } });
    if (claims.length === 0) return;
    const runIds = await putOnRuns(db, claims, decider.id, row.id);
    const { aggregateAndPersistRun } = await import('../routes/payroll.js');
    for (const runId of runIds) {
      const run = await db.payrollRun.findUniqueOrThrow({ where: { id: runId }, select: { id: true, clientId: true, periodStart: true, periodEnd: true } });
      await db.$transaction((tx) => aggregateAndPersistRun(tx, run, 15), { timeout: 120_000, maxWait: 10_000 });
    }
    enqueueAudit({ actorUserId: decider.id, action: 'payroll.back_pay_added', entityType: 'ApprovalRequest', entityId: row.id, metadata: { runs: [...runIds], people: claims.length, total: round2(claims.reduce((s, c) => s + c.amount, 0)) } }, 'payrollBackPay');
  },
  // Rejected: the claims let go — the hours are offered again.
  async (db, row) => {
    await db.backPayClaim.deleteMany({ where: { approvalRequestId: row.id } });
  },
);
