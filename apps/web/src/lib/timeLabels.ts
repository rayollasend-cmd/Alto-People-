/** Friendly names for TimeEntry anomaly flags. Shared by the associate
 *  history list and the admin queue/drawer so nobody reads
 *  GEOFENCE_VIOLATION_IN off a screen. */
export const TIME_ANOMALY_LABELS: Record<string, string> = {
  GEOFENCE_VIOLATION_IN: 'Off-site clock-in',
  GEOFENCE_VIOLATION_OUT: 'Off-site clock-out',
  NO_BREAK: 'No break taken',
  MEAL_BREAK_TOO_SHORT: 'Meal break < 30 min',
  OVERTIME_UNAPPROVED: 'Overtime',
  FORGOT_CLOCKOUT: 'Forgot clock-out',
  OUTSIDE_SHIFT_WINDOW: 'Off-schedule',
  EARLY_OUT: 'Left early',
};

export function timeAnomalyLabel(code: string): string {
  return TIME_ANOMALY_LABELS[code] ?? code;
}
