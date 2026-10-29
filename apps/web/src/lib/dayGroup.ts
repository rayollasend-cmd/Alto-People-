/**
 * Helpers for grouping time-ordered lists by calendar day. Used by any
 * surface that renders an unbounded chronology (audit log, comms log,
 * paystubs, inbox) so the page can collapse all-but-today into native
 * <details> sections instead of becoming infinitely scrollable.
 *
 * Day boundaries use the user's local timezone via toLocaleDateString /
 * toISOString so a notification sent at 11:30 PM and one at 12:30 AM
 * aren't visually merged. The ISO key (YYYY-MM-DD) is computed from
 * the local date components, not UTC, so an event at 11pm PT on
 * May 6 doesn't appear under "May 7" because UTC rolled over.
 */
import { displayLocale, relativeDayWord, RELATIVE_DAY_WORDS } from './format';

function localDateKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** ISO YYYY-MM-DD key in the user's local timezone for a given ISO timestamp. */
export function dayKey(iso: string): string {
  return localDateKey(new Date(iso));
}

/** The app language's locale via <html lang> — lib/format.ts's channel, so
 *  this helper localizes without a lang param (every app language, not only es). */
function appLocale(): string {
  return displayLocale();
}

/** Friendly label: "Today" / "Yesterday" / "Friday, May 2" / "Friday, May 2, 2025". */
export function dayHeading(key: string): string {
  const today = new Date();
  const todayKey = localDateKey(today);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday);
  if (key === todayKey) return relativeDayWord('today');
  if (key === yesterdayKey) return relativeDayWord('yesterday');
  // Parse the local key back to a Date; use noon to dodge any DST fence.
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const sameYear = y === today.getFullYear();
  // Pinned to the APP locale (not the browser's) so headings match the
  // rest of the page in either language.
  return date.toLocaleDateString(appLocale(), {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

/**
 * True when dayHeading(key) returned a RELATIVE label (Today/Yesterday in
 * either app language). Callers that append the calendar date to relative
 * headings must use this instead of matching English words — a
 * /^(Today|Yesterday)$/ regex silently never matched 'Hoy'/'Ayer'.
 */
export function isRelativeDayHeading(heading: string): boolean {
  return RELATIVE_DAY_WORDS.has(heading);
}

/**
 * Time-only formatter for use inside a day-grouped table: "9:31 AM".
 * Seconds only where they are the evidence — the audit log passes
 * `{ seconds: true }` ("9:31:07 AM"); an inbox card or a sent log reading
 * "10:09:22 AM" was noise. Same clock as dayKey (the device's), so a
 * row's time always sits under the right day heading.
 */
export function fmtTimeOnly(iso: string, opts: { seconds?: boolean } = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(appLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' as const } : {}),
  });
}

/**
 * Group a list of {createdAt: ISO string, ...} rows into one bucket per
 * calendar day, preserving the input order (callers should pre-sort DESC
 * so the first bucket is the most recent day).
 */
export function groupByDay<T extends { createdAt: string }>(
  rows: T[],
): { key: string; entries: T[] }[] {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = dayKey(r.createdAt);
    const list = map.get(k);
    if (list) list.push(r);
    else map.set(k, [r]);
  }
  return [...map.entries()].map(([key, entries]) => ({ key, entries }));
}

/**
 * Same as groupByDay but takes an arbitrary timestamp accessor for
 * surfaces whose row uses a different field name (e.g. `payDate`,
 * `sentAt`, `createdAt`).
 */
export function groupByDayBy<T>(
  rows: T[],
  getIso: (row: T) => string,
): { key: string; entries: T[] }[] {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = dayKey(getIso(r));
    const list = map.get(k);
    if (list) list.push(r);
    else map.set(k, [r]);
  }
  return [...map.entries()].map(([key, entries]) => ({ key, entries }));
}
