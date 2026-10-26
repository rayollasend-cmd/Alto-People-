import { DEFAULT_TIMEZONE, localDateKey } from './timezone.js';

/**
 * Dates the way a person reads them, for text the API writes itself — a
 * bell's subject and body, an email line, an approval's summary, an agenda
 * item. The web formats its own (apps/web/src/lib/format.ts); this is the
 * server's twin, so nothing a person reads says "2026-10-26".
 *
 * Calendar days (a DATE column, a "YYYY-MM-DD" string, or the date part of
 * an ISO timestamp that stands for a day, like an effective-from) are read
 * and printed in UTC, so no time zone moves them a day. An instant that
 * should be told as the day it fell on somewhere goes through
 * `fmtDayInZone`.
 */

type DayValue = string | Date | null | undefined;

export interface DayFormat {
  /** 'auto' (the default) prints the year only when it isn't this year; true always; false never. */
  year?: boolean | 'auto';
  /** "Fri, Oct 30". */
  weekday?: boolean;
  /** "This year" is judged against this instant (tests pin it). */
  now?: Date;
}

const DASH = '—';

/** The calendar day a value stands for, as UTC midnight; null when it isn't one. */
export function calendarDay(value: DayValue): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function thisYear(now: Date): number {
  return Number(localDateKey(now, DEFAULT_TIMEZONE).slice(0, 4));
}

function showYear(d: Date, opts: DayFormat): boolean {
  const y = opts.year ?? 'auto';
  if (y === 'auto') return d.getUTCFullYear() !== thisYear(opts.now ?? new Date());
  return y;
}

/** "Oct 26" · "Oct 26, 2026" · "Mon, Oct 26" — a calendar day. "—" when there is none. */
export function fmtDay(value: DayValue, opts: DayFormat = {}): string {
  const d = calendarDay(value);
  if (!d) return typeof value === 'string' && value ? value : DASH;
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    ...(opts.weekday ? { weekday: 'short' as const } : {}),
    month: 'short',
    day: 'numeric',
    ...(showYear(d, opts) ? { year: 'numeric' as const } : {}),
  });
}

/**
 * A span of calendar days, said once: "Oct 17 – 23", "Oct 30 – Nov 5",
 * "Dec 28, 2026 – Jan 3, 2027"; the year joins the tail when it isn't this
 * year ("Oct 17 – 23, 2025"). One day reads as that day.
 */
export function fmtDayRange(from: DayValue, to: DayValue, opts: Omit<DayFormat, 'weekday'> = {}): string {
  const a = calendarDay(from);
  const b = calendarDay(to);
  if (!a || !b) return a ? fmtDay(a, opts) : b ? fmtDay(b, opts) : DASH;
  if (a.getTime() === b.getTime()) return fmtDay(a, opts);
  if (a.getUTCFullYear() !== b.getUTCFullYear()) {
    return `${fmtDay(a, { ...opts, year: true })} – ${fmtDay(b, { ...opts, year: true })}`;
  }
  const year = showYear(b, opts) ? `, ${b.getUTCFullYear()}` : '';
  const head = fmtDay(a, { year: false });
  if (a.getUTCMonth() === b.getUTCMonth()) return `${head} – ${b.getUTCDate()}${year}`;
  return `${head} – ${fmtDay(b, { year: false })}${year}`;
}

/** The day an instant fell on in a zone: "Oct 26" · "Mon, Oct 26" · "Oct 26, 2025". */
export function fmtDayInZone(at: Date, timeZone: string = DEFAULT_TIMEZONE, opts: DayFormat = {}): string {
  return fmtDay(localDateKey(at, timeZone), opts);
}

/** "SOME_CODE" → "Some code": the fallback for an enum code no label table names. */
export function sentenceFromCode(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}

/** An instant as a person reads it, with its zone: "Mon, Oct 26, 6:00 PM EDT". */
export function fmtMomentInZone(at: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at);
}
