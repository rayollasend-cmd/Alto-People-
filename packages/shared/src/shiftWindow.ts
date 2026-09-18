/**
 * A store's named shift window ("Overnight 10p–6a") — site-local wall-clock
 * minutes from midnight. end <= start wraps past midnight: the StaffingTarget
 * / ShiftTemplate convention. Supervisors are assigned to windows; alerts,
 * their home and their Today page focus on the windows they hold.
 */
export interface ShiftWindowSpan {
  startMinute: number;
  endMinute: number;
}

/**
 * Does a site-local minute-of-day fall inside the window? A shift belongs to
 * the window its START falls in — the crew that walks in together.
 */
export function inShiftWindow(minute: number, w: ShiftWindowSpan): boolean {
  if (w.endMinute > w.startMinute) return minute >= w.startMinute && minute < w.endMinute;
  // Wraps midnight (start == end covers the whole day).
  return minute >= w.startMinute || minute < w.endMinute;
}

/** Minutes past local midnight of an instant in a store's timezone. */
export function minuteOfDayInZone(instant: Date | string, timeZone: string | null | undefined): number {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/** "10:00 PM" — a site-local minute of the day on the wall clock. */
export function fmtClockMinute(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

/** "10:00 PM – 6:00 AM" — a window's wall-clock span. */
export function fmtShiftWindow(w: ShiftWindowSpan): string {
  return `${fmtClockMinute(w.startMinute)} – ${fmtClockMinute(w.endMinute)}`;
}
