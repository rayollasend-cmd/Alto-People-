import type { TimeAnomaly } from '@alto-people/shared';
import { getLaborPolicy } from './stateLaborPolicy.js';

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
  }

  // Dedupe — daily + weekly OT can both fire and we don't want to repeat.
  return Array.from(new Set(out));
}

/** UTC ISO week-start (Sunday 00:00) for the given instant. */
export function startOfWeekUTC(d: Date): Date {
  const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  c.setUTCDate(c.getUTCDate() - c.getUTCDay());
  return c;
}

/** UTC end-of-week (next Sunday 00:00) for the given instant. */
export function endOfWeekUTC(d: Date): Date {
  const start = startOfWeekUTC(d);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return end;
}
