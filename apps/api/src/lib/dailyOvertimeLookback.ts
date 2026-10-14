/**
 * Brief 2-2, step 0 — the daily-overtime look-back (read-only).
 *
 *   The pay engine pays weekly overtime only (lib/payroll.ts
 *   splitWeeklyOvertime). In a state with daily overtime (the state table
 *   in lib/stateLaborPolicy.ts), hours past the daily threshold are owed at
 *   1.5x even in a week under 40. This finds those hours in paid periods:
 *   per associate and company week, what the law's daily-plus-weekly split
 *   calls overtime, what the engine paid as overtime, and the hours the
 *   engine paid at straight time instead, with the half-rate difference at
 *   the rate recorded on the payroll item.
 *
 *   Jurisdiction is the WORK SITE's state (the owner's decision 1, 2-2),
 *   falling back to the associate's state only where the site has none.
 *   The day an hour belongs to is the site-local date of the clock-in; the
 *   week is the company week in the site's zone, as pay counts it.
 *
 *   Reports only. The owner and counsel decide what, if anything, is owed
 *   (decision 4); nothing here pays or writes.
 *
 *   Not assessed: California's double time past 12 hours a day and on the
 *   seventh consecutive day (the state table has no double-time tier); the
 *   report says so beside its totals.
 */
import { getLaborPolicy } from './stateLaborPolicy.js';
import { payableMs, round2, type PayableEntry } from './payroll.js';
import { dateKeyInZone, startOfWeekForSite, companyWorkweek } from './timeAnomalies.js';

export interface LookbackEntry extends PayableEntry {
  associateId: string;
  /** The work site's state (two letters), or null when the entry has no site or the site no state. */
  siteState: string | null;
  siteTimezone: string | null;
  /** The associate's home state, used only when the site gives none. */
  associateState: string | null;
}

export interface LookbackWeek {
  associateId: string;
  /** ISO instant of the company week's start in the site's zone. */
  weekStart: string;
  workStates: string[];
  weekHours: number;
  /** Hours past each day's threshold, summed over the week. */
  dailyOvertimeHours: number;
  /** Daily overtime plus the weekly overtime left after it (no hour counted twice). */
  lawOvertimeHours: number;
  /** What the engine paid as overtime: the week's hours past 40. */
  enginePaidOvertimeHours: number;
  /** Overtime hours the engine paid at straight time. */
  straightTimeOvertimeHours: number;
  /** The recorded hourly rate for the period. */
  rate: number;
  /** straightTimeOvertimeHours x rate x 0.5: the overtime half the engine did not pay. */
  difference: number;
}

const WEEKLY_THRESHOLD = 40;

/**
 * Weeks with straight-time overtime, for one paid period. Only weeks with a
 * nonzero difference are returned. `rateByAssociate` is the hourly rate on
 * each payroll item (salaried items, rate 0, are skipped).
 */
export function dailyOvertimeLookback(entries: LookbackEntry[], rateByAssociate: Map<string, number>): LookbackWeek[] {
  type Week = { associateId: string; weekStart: number; ms: number; days: Map<string, { ms: number; threshold: number | null }>; states: Set<string> };
  const weeks = new Map<string, Week>();
  for (const e of entries) {
    if (e.status !== 'APPROVED' || !e.clockOutAt) continue;
    const rate = rateByAssociate.get(e.associateId) ?? 0;
    if (rate <= 0) continue;
    const ms = payableMs(e);
    if (ms <= 0) continue;
    const zone = e.siteTimezone ?? companyWorkweek().timezone;
    const state = (e.siteState ?? e.associateState ?? '').toUpperCase() || null;
    const threshold = getLaborPolicy(state).dailyOTHoursThreshold;
    const weekStart = startOfWeekForSite(e.clockInAt, zone).getTime();
    const key = `${e.associateId}|${weekStart}`;
    const w = weeks.get(key) ?? { associateId: e.associateId, weekStart, ms: 0, days: new Map(), states: new Set<string>() };
    w.ms += ms;
    if (state) w.states.add(state);
    const dayKey = `${dateKeyInZone(e.clockInAt, zone)}|${threshold ?? 'none'}`;
    const d = w.days.get(dayKey) ?? { ms: 0, threshold };
    d.ms += ms;
    w.days.set(dayKey, d);
    weeks.set(key, w);
  }

  const out: LookbackWeek[] = [];
  for (const w of weeks.values()) {
    const weekHours = w.ms / 3_600_000;
    let daily = 0;
    for (const d of w.days.values()) {
      if (d.threshold === null) continue;
      daily += Math.max(0, d.ms / 3_600_000 - d.threshold);
    }
    const law = daily + Math.max(0, weekHours - daily - WEEKLY_THRESHOLD);
    const engine = Math.max(0, weekHours - WEEKLY_THRESHOLD);
    const straight = round2(Math.max(0, law - engine));
    if (straight <= 0) continue;
    const rate = rateByAssociate.get(w.associateId) ?? 0;
    out.push({
      associateId: w.associateId,
      weekStart: new Date(w.weekStart).toISOString(),
      workStates: [...w.states].sort(),
      weekHours: round2(weekHours),
      dailyOvertimeHours: round2(daily),
      lawOvertimeHours: round2(law),
      enginePaidOvertimeHours: round2(engine),
      straightTimeOvertimeHours: straight,
      rate,
      difference: round2(straight * rate * 0.5),
    });
  }
  return out.sort((a, b) => a.associateId.localeCompare(b.associateId) || a.weekStart.localeCompare(b.weekStart));
}
