import type { TimeAnomaly } from '@alto-people/shared';

/** Friendly names for TimeEntry anomaly flags. Shared by the associate
 *  history list and the admin queue/drawer so nobody reads
 *  GEOFENCE_VIOLATION_IN off a screen.
 *
 *  Keyed on the TimeAnomaly union rather than `string`: an untyped
 *  Record silently falls through to the raw SCREAMING_CASE code when a
 *  new anomaly is added, whereas this breaks the build. That's the
 *  pattern every other label map in the app already uses.
 */
export const TIME_ANOMALY_LABELS: Record<TimeAnomaly, string> = {
  GEOFENCE_VIOLATION_IN: 'Off-site clock-in',
  GEOFENCE_VIOLATION_OUT: 'Off-site clock-out',
  NO_BREAK: 'No break taken',
  // Deliberately names no number. The server's threshold comes from the
  // per-state labor policy — Illinois is 20 minutes, not 30 — so the old
  // "Meal break < 30 min" told an Illinois associate a rule that wasn't
  // theirs. The exact minimum belongs next to the policy, not in a label.
  MEAL_BREAK_TOO_SHORT: 'Meal break under the state minimum',
  OVERTIME_UNAPPROVED: 'Overtime',
  FORGOT_CLOCKOUT: 'Forgot clock-out',
  OUTSIDE_SHIFT_WINDOW: 'Off-schedule',
  EARLY_OUT: 'Left early',
};

export function timeAnomalyLabel(code: string): string {
  return TIME_ANOMALY_LABELS[code as TimeAnomaly] ?? code;
}

/**
 * Time-entry tone overrides for `statusTone` / `<StatusBadge>` — the one
 * deliberate domain departure from the shared status vocabulary, shared by
 * every timesheet surface (associate history, My Timesheet, the team and
 * admin queues) so a punch reads the same everywhere:
 * - ACTIVE — the clock is literally running: an in-flight state (gold per
 *   the Badge contract), not the vocabulary's healthy-record green.
 * - COMPLETED — a completed punch is *awaiting review*, not terminal-good,
 *   so it reads amber. (The views label it "Pending review" for the same
 *   reason.)
 */
export const TIME_ENTRY_STATUS_TONES = {
  ACTIVE: 'accent',
  COMPLETED: 'pending',
} as const;
