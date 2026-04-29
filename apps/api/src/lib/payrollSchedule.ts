// Wave 1.1 — Pay schedule cadence math.
//
// Computes the "next period to run" and matching pay date for a schedule
// based on its frequency + anchor. All dates are handled as plain
// YYYY-MM-DD strings (no timezone) so they match Postgres `DATE` columns
// and survive serialization round-trips. Day-arithmetic uses UTC midpoints
// to avoid DST jumps shifting a window by ±1 hr around the boundary.

import type { PayrollFrequency } from '@prisma/client';

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
  /** YYYY-MM-DD; periodEnd + payDateOffsetDays. */
  payDate: string;
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
  const now = toUtcDate(today);

  switch (schedule.frequency) {
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

function buildWindow(start: Date, end: Date, payOffset: number): PeriodWindow {
  return {
    periodStart: fmt(start),
    periodEnd: fmt(end),
    payDate: fmt(addDays(end, payOffset)),
  };
}

/**
 * IRS Pub 15-T pay-period multiplier used for FIT annualization. Wave 1.2
 * earning math will use this when frequency-aware withholding is wired in.
 */
export function payPeriodsPerYear(frequency: PayrollFrequency): number {
  switch (frequency) {
    case 'WEEKLY':      return 52;
    case 'BIWEEKLY':    return 26;
    case 'SEMIMONTHLY': return 24;
    case 'MONTHLY':     return 12;
  }
}
