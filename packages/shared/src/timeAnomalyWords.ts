import type { TimeAnomaly } from './contracts.js';

/**
 * A time entry's anomaly flags in plain words — one list for the API's
 * sentences (My team's "Waiting on you": "Shift on Tue, Oct 27 · Forgot
 * clock-out", never "flagged: forgot_clockout") and the web's chips
 * (apps/web/src/lib/timeLabels.ts carries the same words).
 *
 * Keyed on the TimeAnomaly union, so a new flag breaks the build instead of
 * falling through to its SCREAMING_CASE code.
 */
export const TIME_ANOMALY_WORDS: Record<TimeAnomaly, string> = {
  GEOFENCE_VIOLATION_IN: 'Off-site clock-in',
  GEOFENCE_VIOLATION_OUT: 'Off-site clock-out',
  NO_BREAK: 'No break taken',
  MEAL_BREAK_TOO_SHORT: 'Meal break under the state minimum',
  OVERTIME_UNAPPROVED: 'Overtime',
  FORGOT_CLOCKOUT: 'Forgot clock-out',
  OUTSIDE_SHIFT_WINDOW: 'Off-schedule',
  EARLY_OUT: 'Left early',
};

/** One flag in words; an unknown code reads as a sentence-case phrase, never the raw enum. */
export function timeAnomalyWords(code: string): string {
  const known = (TIME_ANOMALY_WORDS as Record<string, string>)[code];
  if (known) return known;
  const words = code.toLowerCase().replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}
