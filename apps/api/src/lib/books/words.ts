import { fmtDay, fmtDayRange } from '../humanDates.js';

/**
 * The words the books' memos and labels use for periods people read
 * (deep audit 2026-10-29 MONEY-24): "Sep 26 – Oct 9, 2026", not
 * "2026-09-26 – 2026-10-09"; "Oct–Dec 2026", not "2026-Q4". The ISO keys
 * stay in source keys and links, where machines read them.
 */

/** "2026-Q4" → "Oct–Dec 2026"; anything else is returned as given. */
export function quarterWords(label: string): string {
  const m = /^(\d{4})-Q([1-4])$/.exec(label);
  if (!m) return label;
  return `${['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'][Number(m[2]) - 1]} ${m[1]}`;
}

/** "2026-10" → "October 2026"; anything else is returned as given. */
export function monthWords(periodKey: string): string {
  if (!/^\d{4}-\d{2}$/.test(periodKey)) return periodKey;
  return new Date(`${periodKey}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** A pay period or statement period, "Sep 26 – Oct 9, 2026". */
export function periodWords(start: string, end: string): string {
  return fmtDayRange(start, end, { year: true });
}

/** A label that may hold ISO dates or a quarter ("2026-07-18 payday", "2026-Q3"), in words. */
export function labelWords(label: string): string {
  return quarterWords(label).replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (d) => fmtDay(d, { year: true }));
}
