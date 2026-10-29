import type { Prisma, PrismaClient } from '@prisma/client';
import type { SessionUser } from '../types/express.js';
import { scopeAssociates, scopePayrollSchedules } from './scope.js';
import { tenantIdForWrite } from './tenant.js';
import { addDaysYmd, dateOnly, membershipWindowsFor, periodContaining, todayYmd, ymd, type ScheduleWithVersions } from './payScheduleMembership.js';
import { inWindows, punchFetchRange, punchInPeriod, workDayOf, type PeriodWindow } from './payrollSchedule.js';
import { sumApprovedHours } from './payroll.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * The payroll period ledger (finance walk 1; system audit Tier 1 #5).
 *
 * For every pay schedule, every scheduled period back to a lookback: the
 * pay date it owed, the run that paid it (or none), and the approved hours
 * in it that are on no paystub. A payday that passed with no run is MISSED;
 * approved time in such a period is money owed to people that no screen
 * said a word about.
 *
 *   PAID       a run for the period disbursed
 *   DUE        the period's pay date is still ahead, or its run is a draft / finalized
 *   MISSED     the pay date passed and no run pays the period
 *   OFF_CYCLE  an off-cycle run made from this ledger pays the period's hours
 *   EXTERNAL   payments for the period were recorded on the Pay tab (before in-house payroll)
 */
export type LedgerStatus = 'PAID' | 'DUE' | 'MISSED' | 'OFF_CYCLE' | 'EXTERNAL';

export interface LedgerPeriod {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: LedgerStatus;
  runId: string | null;
  runStatus: string | null;
  runKind: string | null;
  /** Approved hours in the period on no non-voided paystub and no external payment. */
  unpaidHours: number;
  unpaidPeople: number;
}

export interface LedgerSchedule {
  scheduleId: string;
  name: string;
  frequency: string;
  clientId: string | null;
  periods: LedgerPeriod[];
}

export interface UnpaidRow {
  associateId: string;
  name: string;
  scheduleId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  hours: number;
}

export interface PeriodLedger {
  asOf: string;
  schedules: LedgerSchedule[];
  /** Paydays that passed with no run, across schedules. */
  missed: { periods: number; hours: number; people: number };
  /** Every person-period with approved time nobody paid, past its pay date. Oldest first. */
  unpaid: UnpaidRow[];
}

const LOOKBACK_DAYS = 180;
const MAX_PERIODS = 60;
const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

type ScheduleRow = ScheduleWithVersions & { clientId: string | null };

/** The periods of one schedule from `from` up to and including the first whose pay date is still ahead. */
export function ledgerWindows(s: ScheduleWithVersions, from: string, today: string): PeriodWindow[] {
  const out: PeriodWindow[] = [];
  let cursor = from;
  for (let i = 0; i < MAX_PERIODS; i++) {
    const p = periodContaining(s, cursor);
    out.push(p);
    if (p.payDate >= today) break;
    cursor = addDaysYmd(p.periodEnd, 1);
  }
  return out;
}

/** Where the lookback starts for a schedule: never before its anchor (or first version). */
function lookbackStart(s: ScheduleWithVersions, today: string, from?: string): string {
  const floor = ymd(new Date(dateOnly(today).getTime() - LOOKBACK_DAYS * DAY_MS));
  const anchors = [ymd(s.anchorDate), ...(s.versions ?? []).map((v) => ymd(v.anchorDate))].sort();
  const earliest = anchors[0] ?? floor;
  const start = from ?? floor;
  return start < earliest ? earliest : start;
}

export async function ledgerForSchedules(db: Db, schedules: ScheduleRow[], opts: { from?: string; today?: string; associateWhere?: Prisma.AssociateWhereInput } = {}): Promise<PeriodLedger> {
  const today = opts.today ?? todayYmd();
  const tenantId = tenantIdForWrite();
  const out: PeriodLedger = { asOf: today, schedules: [], missed: { periods: 0, hours: 0, people: 0 }, unpaid: [] };
  if (schedules.length === 0) return out;

  const windowsBySchedule = new Map(schedules.map((s) => [s.id, ledgerWindows(s, lookbackStart(s, today, opts.from), today)]));
  const allWindows = [...windowsBySchedule.values()].flat();
  const minStart = allWindows.map((w) => w.periodStart).sort()[0]!;
  const maxEnd = allWindows.map((w) => w.periodEnd).sort().reverse()[0]!;

  const [runs, externals, entries, members] = await Promise.all([
    db.payrollRun.findMany({
      where: {
        tenantId,
        status: { not: 'CANCELLED' },
        kind: { in: ['REGULAR', 'OFF_CYCLE'] },
        periodEnd: { gte: dateOnly(minStart) },
        periodStart: { lte: dateOnly(maxEnd) },
      },
      select: {
        id: true,
        status: true,
        kind: true,
        periodStart: true,
        periodEnd: true,
        payrollScheduleId: true,
        clientId: true,
        includesApprovedTime: true,
        items: { where: { status: { not: 'VOIDED' } }, select: { associateId: true } },
      },
    }),
    db.externalPayment.findMany({
      where: { tenantId, deletedAt: null, periodEnd: { gte: dateOnly(minStart) }, periodStart: { lte: dateOnly(maxEnd) } },
      select: { associateId: true, periodStart: true, periodEnd: true },
    }),
    db.timeEntry.findMany({
      // The caller's reach: a store-bound account sees its own people's hours only.
      // The pay-period cut (deep audit CODE-1): fetched with a margin day each side, kept by the site's day below.
      where: { tenantId, status: 'APPROVED', clockInAt: punchFetchRange({ periodStart: minStart, periodEnd: maxEnd }), ...(opts.associateWhere ? { associate: { is: opts.associateWhere } } : {}) },
      select: {
        associateId: true,
        status: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
        location: { select: { timezone: true } },
        associate: { select: { firstName: true, lastName: true } },
      },
      take: 50_000,
    }),
    membershipWindowsFor(db, schedules.map((s) => ({ scheduleId: s.id, from: minStart, to: maxEnd }))),
  ]);
  const membersBySchedule = new Map(members);

  const runsByStart = new Map<string, typeof runs>();
  for (const r of runs) {
    const k = ymd(r.periodStart);
    runsByStart.set(k, [...(runsByStart.get(k) ?? []), r]);
  }
  // Paid days: a locked run with a paystub for the person covering the day.
  const lockedRuns = runs.filter((r) => r.status === 'FINALIZED' || r.status === 'DISBURSED');
  const coveredBy = (associateId: string, day: string): boolean =>
    lockedRuns.some((r) => ymd(r.periodStart) <= day && day <= ymd(r.periodEnd) && r.items.some((i) => i.associateId === associateId)) ||
    externals.some((e) => e.associateId === associateId && ymd(e.periodStart) <= day && day <= ymd(e.periodEnd));

  for (const s of schedules) {
    const windows = windowsBySchedule.get(s.id)!;
    const membership = membersBySchedule.get(s.id) ?? new Map();
    const periods: LedgerPeriod[] = [];
    // Unpaid approved hours per period, per person.
    const unpaid = new Map<string, Map<string, { name: string; entries: typeof entries }>>();
    for (const e of entries) {
      const day = workDayOf(e.clockInAt, e.location?.timezone);
      if (!inWindows(membership, e.associateId, day)) continue;
      const w = windows.find((x) => x.periodStart <= day && day <= x.periodEnd);
      if (!w) continue;
      if (coveredBy(e.associateId, day)) continue;
      const byPerson = unpaid.get(w.periodStart) ?? new Map();
      const row = byPerson.get(e.associateId) ?? { name: `${e.associate.firstName} ${e.associate.lastName}`.trim(), entries: [] };
      row.entries.push(e);
      byPerson.set(e.associateId, row);
      unpaid.set(w.periodStart, byPerson);
    }

    for (const w of windows) {
      const candidates = runsByStart.get(w.periodStart) ?? [];
      const regular =
        candidates.find((r) => r.kind === 'REGULAR' && r.payrollScheduleId === s.id) ??
        candidates.find((r) => r.kind === 'REGULAR' && r.payrollScheduleId === null && (s.clientId === null || r.clientId === s.clientId));
      const offCycle = candidates.find((r) => r.kind === 'OFF_CYCLE' && r.includesApprovedTime && (r.payrollScheduleId === s.id || r.payrollScheduleId === null));
      const run = regular ?? offCycle ?? null;
      const external = !run && externals.some((e) => ymd(e.periodStart) <= w.periodEnd && ymd(e.periodEnd) >= w.periodStart && membership.has(e.associateId));
      const byPerson = unpaid.get(w.periodStart) ?? new Map<string, { name: string; entries: typeof entries }>();
      const hours = round1([...byPerson.values()].reduce((sum, p) => sum + sumApprovedHours(p.entries), 0));
      let status: LedgerStatus;
      if (run && run.kind === 'OFF_CYCLE') status = 'OFF_CYCLE';
      else if (run) status = run.status === 'DISBURSED' ? 'PAID' : 'DUE';
      else if (external) status = 'EXTERNAL';
      else status = w.payDate < today ? 'MISSED' : 'DUE';
      periods.push({
        periodStart: w.periodStart,
        periodEnd: w.periodEnd,
        payDate: w.payDate,
        status,
        runId: run?.id ?? null,
        runStatus: run?.status ?? null,
        runKind: run?.kind ?? null,
        unpaidHours: hours,
        unpaidPeople: [...byPerson.values()].filter((p) => sumApprovedHours(p.entries) > 0).length,
      });
      if (w.payDate < today) {
        if (status === 'MISSED') out.missed.periods += 1;
        for (const [associateId, p] of byPerson) {
          const h = round1(sumApprovedHours(p.entries));
          if (h <= 0) continue;
          out.unpaid.push({ associateId, name: p.name, scheduleId: s.id, periodStart: w.periodStart, periodEnd: w.periodEnd, payDate: w.payDate, hours: h });
        }
      }
    }
    out.schedules.push({ scheduleId: s.id, name: s.name, frequency: s.frequency, clientId: s.clientId, periods });
  }
  out.unpaid.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.name.localeCompare(b.name));
  out.missed.hours = round1(out.unpaid.reduce((s, r) => s + r.hours, 0));
  out.missed.people = new Set(out.unpaid.map((r) => r.associateId)).size;
  return out;
}

/** The ledger for the schedules the caller can run. */
export async function periodLedger(db: Db, user: SessionUser, opts: { scheduleId?: string | null; from?: string; today?: string } = {}): Promise<PeriodLedger> {
  const schedules = await db.payrollSchedule.findMany({
    where: { ...scopePayrollSchedules(user), isActive: true, ...(opts.scheduleId ? { id: opts.scheduleId } : {}) },
    select: { id: true, name: true, frequency: true, anchorDate: true, payDateOffsetDays: true, clientId: true, versions: true },
    orderBy: { name: 'asc' },
    take: 200,
  });
  return ledgerForSchedules(db, schedules, { ...opts, associateWhere: scopeAssociates(user) });
}

/**
 * Approved time on `scheduleId` from periods whose pay date passed with no
 * paystub for it — the LATE_APPROVED_TIME exception on the next run
 * (lib/payrollExceptions). Per person, oldest period first.
 */
export async function lateApprovedTime(db: Db, scheduleId: string, beforePeriodStart: string, today: string = todayYmd()): Promise<Array<{ associateId: string; name: string; hours: number; periods: Array<{ periodStart: string; periodEnd: string; payDate: string; hours: number }> }>> {
  const s = await db.payrollSchedule.findFirst({
    where: { id: scheduleId, tenantId: tenantIdForWrite() },
    select: { id: true, name: true, frequency: true, anchorDate: true, payDateOffsetDays: true, clientId: true, versions: true },
  });
  if (!s) return [];
  const ledger = await ledgerForSchedules(db, [s], { today });
  const byPerson = new Map<string, { name: string; hours: number; periods: Array<{ periodStart: string; periodEnd: string; payDate: string; hours: number }> }>();
  for (const r of ledger.unpaid) {
    if (r.periodEnd >= beforePeriodStart) continue;
    const cur = byPerson.get(r.associateId) ?? { name: r.name, hours: 0, periods: [] };
    cur.hours = round1(cur.hours + r.hours);
    cur.periods.push({ periodStart: r.periodStart, periodEnd: r.periodEnd, payDate: r.payDate, hours: r.hours });
    byPerson.set(r.associateId, cur);
  }
  return [...byPerson].map(([associateId, v]) => ({ associateId, ...v }));
}

/** The inbox count: paydays that passed with no run, with the hours they left unpaid. */
export async function missedPaydaysNeedingYou(db: Db, user: SessionUser): Promise<{ count: number; description: string; dueDate?: string | null }> {
  const ledger = await periodLedger(db, user);
  const n = ledger.missed.periods;
  if (n === 0) return { count: 0, description: 'Every past payday has a run.' };
  // Which paydays, by schedule: "Fri, Oct 2 and Fri, Oct 16 (Biweekly A)" —
  // the description used to repeat its title ("2 paydays passed with no run").
  const day = (ymdStr: string) => new Date(`${ymdStr}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const words = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const bySchedule = ledger.schedules
    .map((s) => ({ name: s.name, days: s.periods.filter((p) => p.status === 'MISSED').map((p) => p.payDate).sort() }))
    .filter((s) => s.days.length > 0);
  const which = bySchedule.map((s) => `${words(s.days.slice(0, 3).map(day))}${s.days.length > 3 ? ` and ${s.days.length - 3} more` : ''} (${s.name})`).join('; ');
  const oldest = bySchedule.flatMap((s) => s.days).sort()[0] ?? null;
  return {
    count: n,
    dueDate: oldest,
    description: `${which}${ledger.missed.hours > 0 ? ` · ${ledger.missed.hours}h approved and unpaid for ${ledger.missed.people} ${ledger.missed.people === 1 ? 'person' : 'people'}` : ''}.`,
  };
}

/**
 * For an off-cycle run made from the ledger: the people on its schedule
 * whose approved time in the period is on no other locked run's paystub
 * (and no external payment) — the only ones it pays.
 */
export async function unpaidAssociatesFor(db: Db, runId: string | null, from: string, to: string): Promise<Set<string>> {
  const [others, externals, entries] = await Promise.all([
    db.payrollRun.findMany({
      where: { tenantId: tenantIdForWrite(), ...(runId ? { id: { not: runId } } : {}), status: { in: ['FINALIZED', 'DISBURSED'] }, kind: { in: ['REGULAR', 'OFF_CYCLE'] }, periodEnd: { gte: dateOnly(from) }, periodStart: { lte: dateOnly(to) } },
      select: { periodStart: true, periodEnd: true, items: { where: { status: { not: 'VOIDED' } }, select: { associateId: true } } },
    }),
    db.externalPayment.findMany({ where: { tenantId: tenantIdForWrite(), deletedAt: null, periodEnd: { gte: dateOnly(from) }, periodStart: { lte: dateOnly(to) } }, select: { associateId: true, periodStart: true, periodEnd: true } }),
    db.timeEntry.findMany({
      where: { tenantId: tenantIdForWrite(), status: 'APPROVED', clockInAt: punchFetchRange({ periodStart: from, periodEnd: to }) },
      select: { associateId: true, clockInAt: true, location: { select: { timezone: true } } },
      take: 50_000,
    }),
  ]);
  const covered = (associateId: string, day: string) =>
    others.some((r) => ymd(r.periodStart) <= day && day <= ymd(r.periodEnd) && r.items.some((i) => i.associateId === associateId)) ||
    externals.some((e) => e.associateId === associateId && ymd(e.periodStart) <= day && day <= ymd(e.periodEnd));
  const out = new Set<string>();
  for (const e of entries) {
    if (out.has(e.associateId)) continue;
    if (!punchInPeriod(e, { periodStart: from, periodEnd: to })) continue;
    if (!covered(e.associateId, workDayOf(e.clockInAt, e.location?.timezone))) out.add(e.associateId);
  }
  return out;
}
