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
 *
 *   What the engine PAID comes from the engine itself (lib/laborRules/hours
 *   splitHours with the tenant's live rules), not a re-derived "past 40": a
 *   jurisdiction a tenant took LIVE already pays its daily overtime, and
 *   those hours must not be reported as paid at straight time. The law side
 *   stays on the state table because it covers states no pack ships yet.
 */
import { getLaborPolicy } from './stateLaborPolicy.js';
import { payableMs, round2, type PayableEntry } from './payroll.js';
import { dateKeyInZone, startOfWeekForSite, companyWorkweek } from './timeAnomalies.js';
import { NO_LIVE_RULES, splitHours, type HoursEntry, type PayRules } from './laborRules/hours.js';

export interface LookbackEntry extends PayableEntry {
  associateId: string;
  /** The work site's state (two letters), or null when the entry has no site or the site no state. */
  siteState: string | null;
  siteTimezone: string | null;
  /** The associate's home state, used only when the site gives none. */
  associateState: string | null;
  /** The work site's id and city, so a site- or city-level live activation resolves. */
  siteId?: string | null;
  siteCity?: string | null;
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
  /** What the engine paid as overtime (and double time) that week: its own split, under the live rules. */
  enginePaidOvertimeHours: number;
  /** Overtime hours the engine paid at straight time. */
  straightTimeOvertimeHours: number;
  /** The recorded hourly rate for the period. */
  rate: number;
  /** straightTimeOvertimeHours x rate x 0.5: the overtime half the engine did not pay. */
  difference: number;
}

/**
 * Weeks with straight-time overtime, for one paid period. Only weeks with a
 * nonzero difference are returned. `rateByAssociate` is the hourly rate on
 * each payroll item (salaried items, rate 0, are skipped).
 */
export function dailyOvertimeLookback(entries: LookbackEntry[], rateByAssociate: Map<string, number>, rules: PayRules = NO_LIVE_RULES): LookbackWeek[] {
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

  // What the engine paid, per person and week: its split's overtime and double-time shares.
  const paidOt = new Map<string, number>();
  const people = new Map<string, Array<{ e: LookbackEntry; h: HoursEntry }>>();
  for (const e of entries) {
    if (e.status !== 'APPROVED' || !e.clockOutAt) continue;
    const list = people.get(e.associateId) ?? [];
    list.push({ e, h: { clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, site: { id: e.siteId ?? '', state: e.siteState, city: e.siteCity ?? null, timezone: e.siteTimezone } } });
    people.set(e.associateId, list);
  }
  for (const [associateId, list] of people) {
    const split = splitHours(rules, list.map((x) => x.h));
    split.entries.forEach((share, i) => {
      const e = list[i]!.e;
      const key = `${associateId}|${startOfWeekForSite(e.clockInAt, e.siteTimezone ?? companyWorkweek().timezone).getTime()}`;
      paidOt.set(key, (paidOt.get(key) ?? 0) + share.overtimeHours + share.doubleTimeHours);
    });
  }

  const out: LookbackWeek[] = [];
  for (const w of weeks.values()) {
    const weekHours = w.ms / 3_600_000;
    let daily = 0;
    for (const d of w.days.values()) {
      if (d.threshold === null) continue;
      daily += Math.max(0, d.ms / 3_600_000 - d.threshold);
    }
    // The law side's weekly line: 40 in every state the table holds (its weeklyOTHoursThreshold).
    const law = daily + Math.max(0, weekHours - daily - 40);
    const engine = paidOt.get(`${w.associateId}|${w.weekStart}`) ?? 0;
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
