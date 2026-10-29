import type { TimeAnomaly } from '@alto-people/shared';
import { getLaborPolicy } from './stateLaborPolicy.js';
import { getBrandingSync } from './branding.js';
import { addDaysToKey } from './timezone.js';

/**
 * Pure functions for detecting anomalies on a completed TimeEntry.
 * Inputs are plain values (no Prisma) so this is easy to unit-test
 * without spinning up a database.
 */

export interface TimeEntryFacts {
  clockInAt: Date;
  clockOutAt: Date | null;
  geofenceInOk: boolean | null;   // true=inside, false=outside, null=no geofence
  geofenceOutOk: boolean | null;
}

export interface BreakFacts {
  type: 'MEAL' | 'REST';
  startedAt: Date;
  endedAt: Date | null;
}

export interface ShiftFacts {
  startsAt: Date;
  endsAt: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** Worked-minute count, *excluding* break time. */
export function netWorkedMinutes(
  entry: { clockInAt: Date; clockOutAt: Date | null },
  breaks: BreakFacts[]
): number {
  const end = entry.clockOutAt ?? new Date();
  const totalMs = Math.max(0, end.getTime() - entry.clockInAt.getTime());
  let breakMs = 0;
  for (const b of breaks) {
    const bEnd = b.endedAt ?? end;
    breakMs += Math.max(0, bEnd.getTime() - b.startedAt.getTime());
  }
  return Math.max(0, Math.floor((totalMs - breakMs) / MIN_MS));
}

/**
 * Sum minutes of MEAL breaks. State law (CA, OR, WA, NY, etc.) typically
 * mandates a 30-minute meal period after 5-6 hours worked. We use a
 * conservative 30-minute floor and don't try to model state-specific
 * waiver/coverage rules in v1.
 */
export function totalMealBreakMinutes(breaks: BreakFacts[]): number {
  let ms = 0;
  for (const b of breaks) {
    if (b.type !== 'MEAL') continue;
    if (!b.endedAt) continue;
    ms += b.endedAt.getTime() - b.startedAt.getTime();
  }
  return Math.floor(ms / MIN_MS);
}

export interface DetectAnomaliesInput {
  entry: TimeEntryFacts;
  breaks: BreakFacts[];
  /** Total weekly *worked* minutes for this associate INCLUDING this entry. */
  weeklyMinutesIncludingThis: number;
  /** Optional Shift the entry should fall within. */
  matchedShift?: ShiftFacts;
  /**
   * Phase 23 — two-letter state code for the associate (or the work site).
   * Drives meal-break / OT thresholds via lib/stateLaborPolicy. Null →
   * FEDERAL fallback (same as the pre-Phase-23 hard-coded behavior).
   */
  state?: string | null;
}

const NO_BREAK_THRESHOLD_HOURS = 6;
const SHIFT_WINDOW_DRIFT_MINUTES = 60;
// Leaving >15min before the scheduled end is worth a reviewer's glance;
// smaller gaps are shift-change noise (registers handed over early, etc.).
const EARLY_OUT_THRESHOLD_MINUTES = 15;
// Floor used when the state policy doesn't mandate a meal break but the
// associate still took one — under federal rules, a "break" of less than
// 30min that's spent off-task is paid time, not unpaid lunch. We flag
// short federal-state meal breaks to surface possible payroll bugs.
const FEDERAL_DEFAULT_MEAL_FLOOR_MIN = 30;

export function detectAnomalies(input: DetectAnomaliesInput): TimeAnomaly[] {
  const { entry, breaks, weeklyMinutesIncludingThis, matchedShift } = input;
  const policy = getLaborPolicy(input.state ?? null);
  const out: TimeAnomaly[] = [];

  if (entry.geofenceInOk === false) out.push('GEOFENCE_VIOLATION_IN');
  if (entry.geofenceOutOk === false) out.push('GEOFENCE_VIOLATION_OUT');

  if (entry.clockOutAt) {
    const workedMs = entry.clockOutAt.getTime() - entry.clockInAt.getTime();
    const workedHours = workedMs / HOUR_MS;
    if (workedHours >= NO_BREAK_THRESHOLD_HOURS && breaks.length === 0) {
      out.push('NO_BREAK');
    }
    const mealRequiredAfter = policy.mealBreakRequiredAfterHours;
    const mealMinMinutes = policy.mealBreakMinMinutes || FEDERAL_DEFAULT_MEAL_FLOOR_MIN;
    const triggerHours = mealRequiredAfter ?? 5;
    if (
      workedHours >= triggerHours &&
      breaks.some((b) => b.type === 'MEAL') &&
      totalMealBreakMinutes(breaks) < mealMinMinutes
    ) {
      out.push('MEAL_BREAK_TOO_SHORT');
    }
  }

  // Daily OT (CA + CO have 8h or 12h thresholds).
  if (entry.clockOutAt && policy.dailyOTHoursThreshold !== null) {
    const workedHours = (entry.clockOutAt.getTime() - entry.clockInAt.getTime()) / HOUR_MS;
    if (workedHours > policy.dailyOTHoursThreshold) {
      out.push('OVERTIME_UNAPPROVED');
    }
  }

  if (weeklyMinutesIncludingThis > policy.weeklyOTHoursThreshold * 60) {
    out.push('OVERTIME_UNAPPROVED');
  }

  if (matchedShift && entry.clockOutAt) {
    const inDrift = Math.abs(
      (entry.clockInAt.getTime() - matchedShift.startsAt.getTime()) / MIN_MS
    );
    const outDrift = Math.abs(
      (entry.clockOutAt.getTime() - matchedShift.endsAt.getTime()) / MIN_MS
    );
    if (inDrift > SHIFT_WINDOW_DRIFT_MINUTES || outDrift > SHIFT_WINDOW_DRIFT_MINUTES) {
      out.push('OUTSIDE_SHIFT_WINDOW');
    }
    // Direction-aware early departure — OUTSIDE_SHIFT_WINDOW only fires
    // at 60min drift in either direction; leaving 20min early is the
    // case managers actually chase.
    const earlyMin =
      (matchedShift.endsAt.getTime() - entry.clockOutAt.getTime()) / MIN_MS;
    if (earlyMin > EARLY_OUT_THRESHOLD_MINUTES) {
      out.push('EARLY_OUT');
    }
  }

  // Dedupe — daily + weekly OT can both fire and we don't want to repeat.
  return Array.from(new Set(out));
}

/**
 * THE org workweek: Saturday 00:00 → Friday 24:00, in the org's home
 * timezone (America/New_York — every store is in Florida). This is the
 * employer-defined FLSA workweek, and it matches the Fieldglass
 * timesheet builder's `saturdayWeek` exactly.
 *
 * History: this helper was Monday-anchored in raw UTC, which was wrong
 * on two axes at once — wrong day (the real week starts Saturday) and
 * wrong clock (Monday 00:00 UTC is Sunday evening in Florida), so
 * weekend hours could split into the wrong week and mis-state overtime
 * in payroll, exports, statements, and the OT radar.
 *
 * Attribution note: every consumer buckets a punch by its CLOCK-IN
 * instant, never splitting a shift at midnight — so the overnight crew's
 * Friday 10 PM → Saturday 7 AM shift belongs wholly to the week ending
 * that Friday, per policy.
 *
 * The functions still RETURN UTC instants (hence the names): the exact
 * moment the local Saturday begins, DST-correct.
 */
/**
 * Brief 1A-2: the company workweek is a setting (OrgSetting.weekStartsOn,
 * 0 = Sunday ... 6 = Saturday, and OrgSetting.timezone), read from the
 * branding cache so these helpers stay synchronous. Saturday in
 * America/New_York is the default, so nothing moves until the setting does.
 * A site's hours use the site's own zone: pass Location.timezone to the
 * ...InZone helpers; the UTC-named helpers are the company week.
 */
export function companyWorkweek(): { weekStartsOn: number; timezone: string } {
  const b = getBrandingSync();
  return { weekStartsOn: b.weekStartsOn, timezone: b.timezone };
}

/** UTC instant of local midnight for a YYYY-MM-DD in `tz`, DST-correct.
 *  Classic two-pass correction: guess, measure the local rendering of the
 *  guess, shift by the difference. */
// Building an Intl.DateTimeFormat is expensive and this runs once per time
// entry in a payroll — at 50,000 people it was more than half the run. The
// formatter is cached per zone and the answer per (day, zone): it is a pure
// function of the two.
const midnightFormats = new Map<string, Intl.DateTimeFormat>();
const midnightCache = new Map<string, number>();
const MIDNIGHT_CACHE_MAX = 50_000;

function midnightFormat(tz: string): Intl.DateTimeFormat {
  let f = midnightFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    midnightFormats.set(tz, f);
  }
  return f;
}

export function utcInstantOfLocalMidnight(ymdKey: string, tz: string): Date {
  const cacheKey = `${tz}|${ymdKey}`;
  const hit = midnightCache.get(cacheKey);
  if (hit !== undefined) return new Date(hit);
  const [y, m, d] = ymdKey.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = new Date(target);
  const fmt = midnightFormat(tz);
  for (let i = 0; i < 3; i++) {
    const parts = fmt.formatToParts(guess);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const localAsUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
    );
    if (localAsUtc === target) break;
    guess = new Date(guess.getTime() + (target - localAsUtc));
  }
  if (midnightCache.size >= MIDNIGHT_CACHE_MAX) midnightCache.clear();
  midnightCache.set(cacheKey, guess.getTime());
  return guess;
}

const keyFormats = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD of the instant on a zone's calendar, without importing
 *  timezone.ts (kept dependency-free; en-CA renders ISO order). */
export function dateKeyInZone(d: Date, tz: string): string {
  let fmt = keyFormats.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    keyFormats.set(tz, fmt);
  }
  return fmt.format(d);
}

/** YYYY-MM-DD of the instant in the org zone. */
export function orgDateKey(d: Date): string {
  return dateKeyInZone(d, companyWorkweek().timezone);
}

/** UTC instant of the Saturday 00:00 (zone-local) beginning the workweek
 *  that contains `d`. */
export function startOfWeekInZone(d: Date, tz: string, weekStartsOn: number = companyWorkweek().weekStartsOn): Date {
  const localKey = dateKeyInZone(d, tz);
  // Days back to the week's first day (Saturday by default: Sat->0, Sun->1, ... Fri->6).
  const back = (new Date(`${localKey}T12:00:00Z`).getUTCDay() - weekStartsOn + 7) % 7;
  return utcInstantOfLocalMidnight(addDaysToKey(localKey, -back), tz);
}

/** UTC instant of the NEXT Saturday 00:00 (zone-local) — the exclusive end
 *  of the workweek containing `d`. DST weeks are 167/169 real hours. */
export function endOfWeekInZone(d: Date, tz: string, weekStartsOn: number = companyWorkweek().weekStartsOn): Date {
  const start = startOfWeekInZone(d, tz, weekStartsOn);
  return utcInstantOfLocalMidnight(addDaysToKey(dateKeyInZone(start, tz), 7), tz);
}

/** The org workweek (Sat 00:00 Eastern) containing `d`. */
export function startOfWeekUTC(d: Date): Date {
  return startOfWeekInZone(d, companyWorkweek().timezone);
}

/** The exclusive end of the org workweek containing `d`. */
export function endOfWeekUTC(d: Date): Date {
  return endOfWeekInZone(d, companyWorkweek().timezone);
}

/** The company week containing `d` as a site sees it: the site's zone, the company's start day. */
export function startOfWeekForSite(d: Date, siteTimezone: string | null | undefined): Date {
  return startOfWeekInZone(d, siteTimezone ?? companyWorkweek().timezone);
}
