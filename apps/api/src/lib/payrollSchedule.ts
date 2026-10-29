// Wave 1.1 — Pay schedule cadence math.
//
// Computes the "next period to run" and matching pay date for a schedule
// based on its frequency + anchor. All dates are handled as plain
// YYYY-MM-DD strings (no timezone) so they match Postgres `DATE` columns
// and survive serialization round-trips. Day-arithmetic uses UTC midpoints
// to avoid DST jumps shifting a window by ±1 hr around the boundary.

import type { PayrollFrequency } from '@prisma/client';
import { adjustPayDate } from './banking/holidays.js';
import { companyWorkweek, dateKeyInZone } from './timeAnomalies.js';

export interface ScheduleInput {
  frequency: PayrollFrequency;
  anchorDate: Date | string;
  payDateOffsetDays: number;
}

export interface PeriodWindow {
  /** YYYY-MM-DD inclusive. */
  periodStart: string;
  /** YYYY-MM-DD inclusive. */
  periodEnd: string;
  /** YYYY-MM-DD; periodEnd + payDateOffsetDays, moved to the banking day before a weekend or holiday. */
  payDate: string;
  /** The date the schedule names, before the move (set only when the pay date moved). */
  nominalPayDate?: string;
  /** Why the pay date moved ("Christmas Day", "Saturday"), when it did. */
  payDateShiftReason?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcDate(d: Date | string): Date {
  if (typeof d === 'string') {
    // YYYY-MM-DD → midnight UTC
    const [y, m, day] = d.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day));
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function fmt(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/**
 * Returns the period containing `today` (or starting at/after it for
 * SEMIMONTHLY/MONTHLY). For WEEKLY/BIWEEKLY this is the cycle that contains
 * today. For SEMIMONTHLY this is the active half-month. For MONTHLY this is
 * the active calendar month. The wizard uses this as the default suggestion.
 */
export function getCurrentPeriod(schedule: ScheduleInput, today: Date = new Date()): PeriodWindow {
  const anchor = toUtcDate(schedule.anchorDate);
  // A date value (UTC midnight) is its own day; a moment — "now" — is the company's day,
  // not UTC's (after 8 PM Eastern on a period's last day, UTC already says the next period).
  const isDateValue = today.getUTCHours() === 0 && today.getUTCMinutes() === 0 && today.getUTCSeconds() === 0 && today.getUTCMilliseconds() === 0;
  const now = isDateValue ? toUtcDate(today) : toUtcDate(dateKeyInZone(today, companyWorkweek().timezone));

  switch (schedule.frequency) {
    // DAILY (PAYEXP): each day is paid by a daily settlement; the period here
    // is the weekly true-up that settles overtime and deductions.
    case 'DAILY':
    case 'WEEKLY': {
      // Period = anchor's day-of-week .. +6, sliding to contain `now`.
      const cycleLen = 7;
      const elapsed = daysBetween(anchor, now);
      const cyclesPassed = Math.floor(elapsed / cycleLen);
      const start = addDays(anchor, cyclesPassed * cycleLen);
      const end = addDays(start, cycleLen - 1);
      return buildWindow(start, end, schedule.payDateOffsetDays);
    }
    case 'BIWEEKLY': {
      const cycleLen = 14;
      const elapsed = daysBetween(anchor, now);
      const cyclesPassed = Math.floor(elapsed / cycleLen);
      const start = addDays(anchor, cyclesPassed * cycleLen);
      const end = addDays(start, cycleLen - 1);
      return buildWindow(start, end, schedule.payDateOffsetDays);
    }
    case 'SEMIMONTHLY': {
      // 1st..15th and 16th..end-of-month, every month. Anchor date is not
      // strictly required here (the rule is calendar-driven) but we honor
      // it as a tiebreaker for which half today falls in.
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth();
      const day = now.getUTCDate();
      if (day <= 15) {
        const start = new Date(Date.UTC(y, m, 1));
        const end = new Date(Date.UTC(y, m, 15));
        return buildWindow(start, end, schedule.payDateOffsetDays);
      } else {
        const start = new Date(Date.UTC(y, m, 16));
        const end = new Date(Date.UTC(y, m + 1, 0)); // last day of month
        return buildWindow(start, end, schedule.payDateOffsetDays);
      }
    }
    case 'MONTHLY': {
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth();
      const start = new Date(Date.UTC(y, m, 1));
      const end = new Date(Date.UTC(y, m + 1, 0));
      return buildWindow(start, end, schedule.payDateOffsetDays);
    }
  }
}

/**
 * Returns the period AFTER the one containing `today`. Used by the wizard
 * to offer "next period to run" once the current period has been disbursed.
 */
export function getNextPeriod(schedule: ScheduleInput, today: Date = new Date()): PeriodWindow {
  const current = getCurrentPeriod(schedule, today);
  const dayAfterEnd = addDays(toUtcDate(current.periodEnd), 1);
  return getCurrentPeriod(schedule, dayAfterEnd);
}

/**
 * The next payday on or after `today`, and the period it pays for. Usually
 * the PREVIOUS period's pay date (a Mon–Sun week paid the Friday after is
 * still owed on Tuesday) — else the current period's.
 */
export function getNextPayday(schedule: ScheduleInput, today: Date = new Date()): PeriodWindow {
  const todayKey = fmt(toUtcDate(today));
  const current = getCurrentPeriod(schedule, today);
  const previous = getCurrentPeriod(schedule, addDays(toUtcDate(current.periodStart), -1));
  return previous.payDate >= todayKey ? previous : current;
}

/** The period right after `w` — the one that runs once `w` is paid. */
export function getPeriodAfter(schedule: ScheduleInput, w: PeriodWindow): PeriodWindow {
  return getCurrentPeriod(schedule, addDays(toUtcDate(w.periodEnd), 1));
}

/** The calendar day a shift counts on: its clock-in, on the site's clock (the company's zone when the site's is unknown). */
export function workDayOf(clockInAt: Date, timezone: string | null | undefined): string {
  try {
    return dateKeyInZone(clockInAt, timezone || companyWorkweek().timezone);
  } catch {
    // An unknown zone name on a site: the company's day, never UTC's.
    try {
      return dateKeyInZone(clockInAt, companyWorkweek().timezone);
    } catch {
      return dateKeyInZone(clockInAt, 'America/New_York');
    }
  }
}

/** Whether a day is inside one of a person's windows on a pay schedule (lib/payScheduleMembership). */
export const inWindows = (windows: Map<string, Array<{ start: string; end: string }>>, associateId: string, day: string): boolean =>
  (windows.get(associateId) ?? []).some((w) => w.start <= day && day <= w.end);

/**
 * THE pay-period cut (deep audit CODE-1). A punch belongs to a period when
 * its clock-in's day ON THE SITE'S CLOCK is one of the period's days — and,
 * on a pay schedule's run, one of the person's days on that schedule. Runs
 * (schedule and legacy), payroll exceptions, the pay-and-bill check, the
 * period ledger and the earned-wage card all slice time this one way, so a
 * 7 PM Friday clock-in in Chicago (Saturday 00:30 UTC) is paid exactly once,
 * in the period whose last day is that Friday.
 */
export interface PayPeriodCut {
  /** YYYY-MM-DD, inclusive. */
  periodStart: string;
  /** YYYY-MM-DD, inclusive. */
  periodEnd: string;
}

/** A pay schedule's membership: per person, the inclusive YYYY-MM-DD windows they were on it (lib/payScheduleMembership). */
export type MembershipWindows = Map<string, Array<{ start: string; end: string }>>;

/** What a punch needs for the cut: who, when, and the site's zone. */
export interface PunchLike {
  associateId: string;
  clockInAt: Date;
  location?: { timezone?: string | null } | null;
}

/**
 * The clock-in range to FETCH for a period: a margin day on each side of
 * its UTC midnights, because membership is decided on the site's clock
 * (UTC−10 to UTC+14 all fit inside one day). Never pay from this range
 * directly — filter with punchInPeriod.
 */
export function punchFetchRange(period: PayPeriodCut): { gte: Date; lt: Date } {
  const start = toUtcDate(period.periodStart).getTime();
  const end = toUtcDate(period.periodEnd).getTime();
  return { gte: new Date(start - DAY_MS), lt: new Date(end + 2 * DAY_MS) };
}

/** Whether a punch belongs to the period (and, on a schedule's run, to the person's days on the schedule). */
export function punchInPeriod(p: PunchLike, period: PayPeriodCut, windows?: MembershipWindows | null): boolean {
  const day = workDayOf(p.clockInAt, p.location?.timezone);
  if (day < period.periodStart || day > period.periodEnd) return false;
  return windows ? inWindows(windows, p.associateId, day) : true;
}

/**
 * The punches a period pays: fetch with the margin, keep what the cut says.
 * `fetch` runs the caller's own query (its status filter, includes and
 * reach) over the clock-in range it is handed; the rows must carry
 * `location.timezone`. `schedule` is the run's membership windows, or null
 * for a run that isn't for one pay schedule.
 */
export async function punchesInPeriod<T extends PunchLike>(
  period: PayPeriodCut,
  schedule: MembershipWindows | null | undefined,
  fetch: (clockInAt: { gte: Date; lt: Date }) => Promise<T[]>,
): Promise<T[]> {
  const rows = await fetch(punchFetchRange(period));
  return rows.filter((p) => punchInPeriod(p, period, schedule));
}

/** A period given as Date bounds (UTC midnight of its first day, exclusive UTC midnight after its last) as YYYY-MM-DD days. */
export function cutOf(periodStart: Date, periodEndExclusive: Date): PayPeriodCut {
  return { periodStart: fmt(toUtcDate(periodStart)), periodEnd: fmt(new Date(toUtcDate(periodEndExclusive).getTime() - DAY_MS)) };
}

/** A window between explicit dates — a period cut short where a schedule's pattern changes. */
export function windowBetween(periodStart: string, periodEnd: string, payOffset: number): PeriodWindow {
  return buildWindow(toUtcDate(periodStart), toUtcDate(periodEnd), payOffset);
}

function buildWindow(start: Date, end: Date, payOffset: number): PeriodWindow {
  // People are paid early, never late: a pay date on a weekend or a Federal
  // Reserve holiday moves to the banking day before it (lib/banking/holidays).
  const nominal = fmt(addDays(end, payOffset));
  const adjusted = adjustPayDate(nominal);
  return {
    periodStart: fmt(start),
    periodEnd: fmt(end),
    payDate: adjusted.payDate,
    // Only a moved pay date carries where it came from and why.
    ...(adjusted.shifted ? { nominalPayDate: nominal, payDateShiftReason: adjusted.reason } : {}),
  };
}

/**
 * IRS Pub 15-T pay-period multiplier used for FIT annualization. Wave 1.2
 * earning math will use this when frequency-aware withholding is wired in.
 */
export function payPeriodsPerYear(frequency: PayrollFrequency): number {
  switch (frequency) {
    case 'WEEKLY':      return 52;
    // DAILY's period of record is its weekly true-up (daily settlements withhold on 260 themselves).
    case 'DAILY':       return 52;
    case 'BIWEEKLY':    return 26;
    case 'SEMIMONTHLY': return 24;
    case 'MONTHLY':     return 12;
  }
}
