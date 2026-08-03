// Payroll-ready sheet aggregation.
//
// Turns a flat list of APPROVED time entries into a per-associate sheet:
// the dates each person worked + the duration on each date, plus their
// regular/overtime totals for the window. Overtime is the federal weekly
// rule (>40h per ISO week), bucketed exactly like payrollAggregator and the
// time-summary CSV export so the three reconcile.
//
// Pure — takes pre-fetched rows so it's trivially unit-testable and never
// touches the DB.

import { netWorkedMinutes, startOfWeekUTC } from './timeAnomalies.js';
import { getLaborPolicy } from './stateLaborPolicy.js';
import type { BreakFacts } from './timeAnomalies.js';

export interface PayrollSheetInputRow {
  associateId: string;
  associateName: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: BreakFacts[];
  /**
   * Work state (USPS code), driving the overtime thresholds. Null falls
   * back to the federal default (40h/week, no daily rule).
   *
   * This used to be absent and the sheet hardcoded 40h/week, which meant
   * the API contradicted itself: `timeAnomalies` reads
   * `dailyOTHoursThreshold` from `stateLaborPolicy` and FLAGS a 9-hour
   * California day as overtime, while this module PAID it at straight
   * time. One of those two had to be wrong on every CA timesheet.
   */
  state?: string | null;
}

export interface PayrollSheetDay {
  /** YYYY-MM-DD (UTC date of clock-in). */
  date: string;
  /** Net worked minutes that day (breaks excluded). */
  minutes: number;
}

export interface PayrollSheetAssociate {
  associateId: string;
  name: string;
  /** Dates worked, ascending, with that day's net duration. */
  days: PayrollSheetDay[];
  regularMinutes: number;
  overtimeMinutes: number;
  totalMinutes: number;
  /** Sum of assigned-shift minutes in the window — scheduled vs actual.
   *  Stamped by the route (needs a Shift query); absent in unit builds. */
  scheduledMinutes?: number;
}

export interface PayrollSheet {
  associates: PayrollSheetAssociate[];
  totalRegularMinutes: number;
  totalOvertimeMinutes: number;
  totalMinutes: number;
  /** See PayrollSheetAssociate.scheduledMinutes. */
  totalScheduledMinutes?: number;
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the payroll sheet from APPROVED entries. Reg/OT is computed per ISO
 * week (Mon-anchored UTC, matching startOfWeekUTC) then summed across weeks,
 * so a 45h week reads as 40 regular / 5 OT even when split across entries.
 */
export function buildPayrollSheet(rows: PayrollSheetInputRow[]): PayrollSheet {
  interface Acc {
    name: string;
    days: Map<string, number>;
    weeks: Map<string, number>;
    state: string | null;
  }
  const byAssoc = new Map<string, Acc>();

  for (const r of rows) {
    const acc =
      byAssoc.get(r.associateId) ??
      ({
        name: r.associateName,
        days: new Map(),
        weeks: new Map(),
        state: r.state ?? null,
      } as Acc);
    const net = netWorkedMinutes(r, r.breaks);
    const dayKey = utcDateKey(r.clockInAt);
    acc.days.set(dayKey, (acc.days.get(dayKey) ?? 0) + net);
    const weekKey = String(startOfWeekUTC(r.clockInAt).getTime());
    acc.weeks.set(weekKey, (acc.weeks.get(weekKey) ?? 0) + net);
    byAssoc.set(r.associateId, acc);
  }

  const associates: PayrollSheetAssociate[] = [];
  let totalRegularMinutes = 0;
  let totalOvertimeMinutes = 0;

  for (const [associateId, acc] of byAssoc) {
    // Thresholds come from the state policy table — the same source
    // timeAnomalies uses to decide what to FLAG — so the two modules can
    // no longer disagree about what overtime is.
    const policy = getLaborPolicy(acc.state);
    const weekCapMin = policy.weeklyOTHoursThreshold * 60;
    const dayCapMin =
      policy.dailyOTHoursThreshold !== null
        ? policy.dailyOTHoursThreshold * 60
        : null;

    // Daily OT first (California and friends): minutes past the daily
    // threshold are overtime regardless of the weekly total.
    let dailyOtMinutes = 0;
    if (dayCapMin !== null) {
      for (const dayMin of acc.days.values()) {
        dailyOtMinutes += Math.max(0, dayMin - dayCapMin);
      }
    }

    let regularMinutes = 0;
    let overtimeMinutes = 0;
    for (const weekMin of acc.weeks.values()) {
      regularMinutes += Math.min(weekMin, weekCapMin);
      overtimeMinutes += Math.max(0, weekMin - weekCapMin);
    }
    // Never pay the same minute twice: hours already counted as daily OT
    // are removed from the regular bucket rather than added on top. The
    // weekly calculation above already treats them as worked time, so
    // only the regular/overtime SPLIT moves.
    const dailyOtNotAlreadyWeekly = Math.min(dailyOtMinutes, regularMinutes);
    regularMinutes -= dailyOtNotAlreadyWeekly;
    overtimeMinutes += dailyOtNotAlreadyWeekly;
    const days: PayrollSheetDay[] = Array.from(acc.days.entries())
      .map(([date, minutes]) => ({ date, minutes }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const totalMinutes = regularMinutes + overtimeMinutes;
    totalRegularMinutes += regularMinutes;
    totalOvertimeMinutes += overtimeMinutes;
    associates.push({
      associateId,
      name: acc.name,
      days,
      regularMinutes,
      overtimeMinutes,
      totalMinutes,
    });
  }

  associates.sort((a, b) => a.name.localeCompare(b.name));

  return {
    associates,
    totalRegularMinutes,
    totalOvertimeMinutes,
    totalMinutes: totalRegularMinutes + totalOvertimeMinutes,
  };
}

/** Minutes → decimal hours string, e.g. 150 → "2.50". */
export function minutesToHours(min: number): string {
  return (min / 60).toFixed(2);
}
