import type { TimeAnomaly } from '@alto-people/shared';

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
}

const NO_BREAK_THRESHOLD_HOURS = 6;
const MIN_MEAL_BREAK_MINUTES = 30;
const WEEKLY_OT_HOURS = 40;
const SHIFT_WINDOW_DRIFT_MINUTES = 60;

export function detectAnomalies(input: DetectAnomaliesInput): TimeAnomaly[] {
  const { entry, breaks, weeklyMinutesIncludingThis, matchedShift } = input;
  const out: TimeAnomaly[] = [];

  if (entry.geofenceInOk === false) out.push('GEOFENCE_VIOLATION_IN');
  if (entry.geofenceOutOk === false) out.push('GEOFENCE_VIOLATION_OUT');

  if (entry.clockOutAt) {
    const workedMs = entry.clockOutAt.getTime() - entry.clockInAt.getTime();
    const workedHours = workedMs / HOUR_MS;
    if (workedHours >= NO_BREAK_THRESHOLD_HOURS && breaks.length === 0) {
      out.push('NO_BREAK');
    }
    if (
      workedHours >= 5 &&
      breaks.some((b) => b.type === 'MEAL') &&
      totalMealBreakMinutes(breaks) < MIN_MEAL_BREAK_MINUTES
    ) {
      out.push('MEAL_BREAK_TOO_SHORT');
    }
  }

  if (weeklyMinutesIncludingThis > WEEKLY_OT_HOURS * 60) {
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

  return out;
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
