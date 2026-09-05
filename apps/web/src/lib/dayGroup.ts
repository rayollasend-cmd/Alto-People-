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

/** The app language via <html lang> — same non-React channel
 *  lib/format.ts uses, so this helper localizes without a lang param. */
function appLocale(): string {
  return typeof document !== 'undefined' && document.documentElement.lang === 'es'
    ? 'es-US'
    : 'en-US';
}

/** Friendly label: "Today" / "Yesterday" / "Friday, May 2" / "Friday, May 2, 2025". */
export function dayHeading(key: string): string {
  const es = appLocale() === 'es-US';
  const today = new Date();
  const todayKey = localDateKey(today);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday);
  if (key === todayKey) return es ? 'Hoy' : 'Today';
  if (key === yesterdayKey) return es ? 'Ayer' : 'Yesterday';
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
  return ['Today', 'Yesterday', 'Hoy', 'Ayer'].includes(heading);
}

/** Time-only formatter for use inside a day-grouped table. */
export function fmtTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString(appLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
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
