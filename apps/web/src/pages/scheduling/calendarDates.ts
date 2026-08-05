import type { Shift } from '@alto-people/shared';

/**
 * The calendar views' shared date arithmetic. Four views each carried
 * private copies of these five helpers (17 definitions total, found by the
 * 2026-08 scheduling sweep) — a DST or bucketing fix had to be applied four
 * times and the copies had already started to drift in formatting. One
 * source now; the views import from here.
 *
 * These are BROWSER-LOCAL calendar helpers by design: columns/cells are the
 * viewer's calendar dates. Store-zone math (bucketing a shift under its
 * store-local day, wall-time construction) lives in @/lib/format's zoned*
 * helpers — don't add zone logic here.
 */

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Local calendar-date key ("YYYY-MM-DD") — the stable cell/column label. */
export function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** setDate-based, so DST-transition days (23h/25h) can't skew the date. */
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function shiftMinutes(s: Shift): number {
  return Math.max(
    0,
    Math.round(
      (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 60_000,
    ),
  );
}
