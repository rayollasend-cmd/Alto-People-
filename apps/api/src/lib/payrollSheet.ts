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
import type { BreakFacts } from './timeAnomalies.js';

/** Federal weekly overtime threshold — over 40h/week is OT. */
const WEEK_REGULAR_CAP_MIN = 40 * 60;

export interface PayrollSheetInputRow {
  associateId: string;
  associateName: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: BreakFacts[];
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
  }
  const byAssoc = new Map<string, Acc>();

  for (const r of rows) {
    const acc =
      byAssoc.get(r.associateId) ??
      ({ name: r.associateName, days: new Map(), weeks: new Map() } as Acc);
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
    let regularMinutes = 0;
    let overtimeMinutes = 0;
    for (const weekMin of acc.weeks.values()) {
      regularMinutes += Math.min(weekMin, WEEK_REGULAR_CAP_MIN);
      overtimeMinutes += Math.max(0, weekMin - WEEK_REGULAR_CAP_MIN);
    }
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
