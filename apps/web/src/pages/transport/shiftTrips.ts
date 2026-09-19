import { localInputToUtcIso, utcToZonedDatetimeInput, zonedDayKey } from '@/lib/format';
import type { RideDirection, RideStore, StoreShiftWindow } from '@/lib/transportApi';

/**
 * Store shifts, the way riders plan by them: "Morning · 6:00 AM–2:00 PM".
 * A seat booked for a shift rides at its start (to work) or its end (home
 * — the next morning for an overnight shift), the same rule the server
 * holds.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const hhmmOf = (minute: number) => `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;

/** "6:00 AM" of a minute past midnight. */
export function fmtMinute(minute: number): string {
  const d = new Date(Date.UTC(2000, 0, 1, Math.floor(minute / 60) % 24, minute % 60));
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

/** "6:00 AM–2:00 PM". */
export function fmtWindow(w: StoreShiftWindow): string {
  return `${fmtMinute(w.startMinute)}–${fmtMinute(w.endMinute)}`;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** When a shift's ride is, on store day `date`. */
export function shiftTargetIso(w: StoreShiftWindow, date: string, direction: RideDirection, tz: string): string {
  if (direction === 'TO_WORK') return localInputToUtcIso(`${date}T${hhmmOf(w.startMinute)}`, tz);
  const day = w.endMinute <= w.startMinute ? addDays(date, 1) : date;
  return localInputToUtcIso(`${day}T${hhmmOf(w.endMinute)}`, tz);
}

/** The store shift a scheduled shift is: the one it starts within 30
 *  minutes of (a 5:45 start is the 6:00 Morning shift). */
export function windowForShift(
  store: RideStore | undefined,
  startsAt: string,
): { window: StoreShiftWindow; date: string } | null {
  if (!store?.windows?.length) return null;
  const local = utcToZonedDatetimeInput(startsAt, store.timezone);
  const [h, m] = local.slice(11, 16).split(':').map(Number) as [number, number];
  const minute = h * 60 + m;
  const near = (a: number, b: number) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b)) <= 30;
  const w = store.windows.find((x) => near(x.startMinute, minute));
  if (!w) return null;
  // A 11:50 PM start of the midnight shift belongs to the next store day.
  const date = zonedDayKey(new Date(Date.parse(startsAt) + 45 * 60_000), store.timezone);
  return { window: w, date: w.startMinute < minute - 30 ? date : zonedDayKey(startsAt, store.timezone) };
}
