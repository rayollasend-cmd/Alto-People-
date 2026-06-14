/**
 * Timezone helpers for the scheduling system.
 *
 * Shifts store `startsAt`/`endsAt` as UTC instants. Associate availability,
 * however, is wall-clock: an associate enters "I'm free Sunday 8am–4pm"
 * meaning 8am AT THE STORE. Comparing a UTC shift against that requires
 * converting the instant to the store's local wall-clock day-of-week and
 * minute-of-day FIRST. Doing the comparison in UTC (the old bug) was off
 * by the store's offset — up to 5h for a Florida (Eastern) site, and it
 * rolled the day across midnight for evening shifts.
 *
 * Zero-dependency: built on Intl.DateTimeFormat, which is present in Node
 * 20 and every browser. The store timezone is an IANA name (e.g.
 * "America/New_York") from packages/shared SUPPORTED_TIMEZONES.
 */

/** Fallback when a Location has no timezone set (legacy rows). */
export const DEFAULT_TIMEZONE = 'America/New_York';

// One formatter per timezone, reused across calls. Intl.DateTimeFormat
// construction is the expensive part; the auto-fill / auto-schedule loops
// call into here once per (shift × associate-window), so caching matters.
const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    partsCache.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface ZonedWallClock {
  /** 0 = Sunday … 6 = Saturday, matching JS Date.getDay() and the
   *  AssociateAvailability.dayOfWeek convention. */
  dayOfWeek: number;
  /** Minutes since local midnight (0–1439). */
  minutes: number;
}

/**
 * Convert a UTC instant to the store's wall-clock day-of-week + minute.
 * This is the value that lines up with what the associate typed into the
 * availability editor.
 */
export function zonedWallClock(date: Date, timeZone: string): ZonedWallClock {
  const parts = partsFormatter(timeZone).formatToParts(date);
  let weekday = 'Sun';
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
  }
  // Intl renders midnight as "24" under hour12:false in some engines; pin to 0.
  if (hour === 24) hour = 0;
  return {
    dayOfWeek: WEEKDAY_INDEX[weekday] ?? 0,
    minutes: hour * 60 + minute,
  };
}

/** Local day-of-week (0=Sun) of a UTC instant at the store. */
export function zonedDayOfWeek(date: Date, timeZone: string): number {
  return zonedWallClock(date, timeZone).dayOfWeek;
}

/** Minutes since local midnight of a UTC instant at the store. */
export function zonedMinutes(date: Date, timeZone: string): number {
  return zonedWallClock(date, timeZone).minutes;
}

// Display formatters, also cached. Used by the schedule PDF and the
// notification bodies so associates see store-local times, not UTC.
const displayCache = new Map<string, Intl.DateTimeFormat>();

function displayFormatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let fmt = displayCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    displayCache.set(key, fmt);
  }
  return fmt;
}

/** "Mon, Jun 15" — store-local calendar date. */
export function formatDateInZone(date: Date, timeZone: string): string {
  return displayFormatter(timeZone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** "9:00 AM" — store-local time of day. */
export function formatTimeInZone(date: Date, timeZone: string): string {
  return displayFormatter(timeZone, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/** "Mon, Jun 15, 9:00 AM" — store-local date + time. */
export function formatDateTimeInZone(date: Date, timeZone: string): string {
  return displayFormatter(timeZone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}
