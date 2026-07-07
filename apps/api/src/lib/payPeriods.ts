// Pay-period options for the admin time review picker.
//
// Periods come from two sources, merged and deduped:
//  1. The busiest ACTIVE PayrollSchedule (most associates attached): its
//     cadence generates a rolling window of recent periods plus the current
//     one — so the picker works from day one, before any payroll has run.
//  2. Actual REGULAR PayrollRun rows — real history wins, and periods that
//     have a run are flagged so the UI can show "paid".
//
// Cadence math is delegated to lib/payrollSchedule (the same helper the
// payroll wizard uses), so both features always agree on window boundaries.
// All boundaries are YYYY-MM-DD with `end` INCLUSIVE — callers turn it into
// an exclusive instant by adding a day, exactly like the payroll sheet.

import type { PrismaClient } from '@prisma/client';
import { getCurrentPeriod, type ScheduleInput, type PeriodWindow } from './payrollSchedule.js';

export interface PayPeriod {
  /** YYYY-MM-DD, inclusive. */
  start: string;
  /** YYYY-MM-DD, inclusive. */
  end: string;
  /** True when today falls inside the period. */
  current: boolean;
  /** True when a REGULAR PayrollRun exists for exactly this window. */
  hasRun: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ymdUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayBefore(ymd: string): Date {
  return new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - DAY_MS);
}

/** The period containing `now` plus the `count - 1` before it, oldest first. */
export function recentSchedulePeriods(
  schedule: ScheduleInput,
  now: Date,
  count: number,
): PeriodWindow[] {
  const out: PeriodWindow[] = [];
  let cursor = now;
  for (let i = 0; i < count; i++) {
    const period = getCurrentPeriod(schedule, cursor);
    out.unshift(period);
    cursor = dayBefore(period.periodStart);
  }
  return out;
}

/** Merge schedule-derived windows with actual run windows, newest first.
 *  A window present in both collapses to one entry with hasRun=true. */
export function mergePayPeriods(
  scheduleWindows: PeriodWindow[],
  runWindows: Array<{ start: string; end: string }>,
  now: Date,
): PayPeriod[] {
  const byKey = new Map<string, PayPeriod>();
  const nowKey = ymdUTC(now);

  const push = (start: string, end: string, hasRun: boolean) => {
    const key = `${start}|${end}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.hasRun = existing.hasRun || hasRun;
      return;
    }
    byKey.set(key, {
      start,
      end,
      current: start <= nowKey && nowKey <= end,
      hasRun,
    });
  };

  for (const w of scheduleWindows) push(w.periodStart, w.periodEnd, false);
  for (const r of runWindows) push(r.start, r.end, true);

  return [...byKey.values()].sort((a, b) => b.start.localeCompare(a.start));
}

export async function listPayPeriods(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<PayPeriod[]> {
  const [schedule, runs] = await Promise.all([
    prisma.payrollSchedule.findFirst({
      where: { isActive: true, deletedAt: null },
      orderBy: { associates: { _count: 'desc' } },
      select: { frequency: true, anchorDate: true, payDateOffsetDays: true },
    }),
    prisma.payrollRun.findMany({
      // Off-cycle and amendment runs have ad-hoc windows, not pay periods.
      where: { status: { not: 'CANCELLED' }, kind: 'REGULAR' },
      orderBy: { periodEnd: 'desc' },
      take: 12,
      select: { periodStart: true, periodEnd: true },
    }),
  ]);

  return mergePayPeriods(
    schedule ? recentSchedulePeriods(schedule, now, 8) : [],
    runs.map((r) => ({ start: ymdUTC(r.periodStart), end: ymdUTC(r.periodEnd) })),
    now,
  );
}
