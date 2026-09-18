/**
 * The workweek: Saturday 00:00 → Friday 24:00 — the week payroll and
 * overtime run on (server: lib/timeAnomalies startOfWeekInZone), and two
 * of them make a biweekly pay period. Every associate-facing "this week"
 * (the home tile, the Time page, My schedule, the timesheet's week groups)
 * reads it from here, so the 40-hour line they see is the one payroll
 * counts. Local calendar days — the device sits on the store's clock.
 */

/** Local Saturday 00:00 beginning the workweek that contains `d`. */
export function workweekStart(d: Date | string | number = new Date()): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  // Sat → 0 days back, Sun → 1, … Fri → 6.
  out.setDate(out.getDate() - ((out.getDay() + 1) % 7));
  return out;
}

/** [start, end) of the workweek containing `d`, stepped by calendar days
 *  (a DST week is 167 or 169 hours — never 7 × 24h of milliseconds). */
export function workweekBounds(d: Date | string | number = new Date(), weeksFromNow = 0): { start: Date; end: Date } {
  const start = workweekStart(d);
  start.setDate(start.getDate() + weeksFromNow * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}
