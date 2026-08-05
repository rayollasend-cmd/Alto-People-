import { isDateOnly, parseDateOnly } from '@alto-people/shared';
/**
 * Centralized formatters. Pages have spawned ~3 implementations of money
 * (`toLocaleString(currency)`, custom `fmtPay`, bare `$${n}`) and a
 * matching spread of date formats. This module is the one place every
 * surface should reach for, so a single tweak (e.g., the currency symbol
 * convention for an EU client) updates the whole app at once.
 *
 * Conventions:
 *   - Money: en-US, 2 decimals always (never strip trailing zeros — the
 *     visual rhythm of `$24.00` next to `$24.50` matters in a table).
 *   - Dates: prefer "May 13, 2026" over "5/13/26"; year is included
 *     because HR data spans years.
 *   - Percent: 1 decimal by default, no `.0` if integer.
 *   - All formatters accept null/undefined and return '—' so callers
 *     don't have to scatter null guards.
 */

const EN_US = 'en-US';
const DASH = '—';

export function fmtMoney(
  value: number | string | null | undefined,
  opts: { currency?: string; precise?: boolean } = {},
): string {
  if (value === null || value === undefined || value === '') return DASH;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return DASH;
  return n.toLocaleString(EN_US, {
    style: 'currency',
    currency: opts.currency ?? 'USD',
    minimumFractionDigits: 2,
    // `precise` keeps 4 decimals — for things like hourly rates derived
    // from cents-precision data (24.0625/hr instead of 24.06).
    maximumFractionDigits: opts.precise ? 4 : 2,
  });
}

/**
 * Compact money for DENSE surfaces only — KPI strips, calendar day-total
 * rows, chart axes — where `fmtMoney`'s two decimals don't fit: "$840",
 * "$1.2k", "$24k", "$3.4M". Grouped en-US digits below the compaction
 * tiers. Anywhere the exact amount matters (tables, payroll, dialogs),
 * use `fmtMoney` — compaction deliberately throws away precision.
 */
export function fmtMoneyCompact(
  value: number | string | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return DASH;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return DASH;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    // One decimal keeps signal on low millions ($3.4M); ≥$10M the decimal
    // is noise at grid density.
    return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  }
  // ≥$10k the hundred-dollar digit stops mattering at a glance ($24k);
  // $1k–$10k keeps one decimal ($1.2k).
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}k`;
  if (abs >= 1_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs).toLocaleString(EN_US)}`;
}

/** "/hr" or "/yr" suffix tacked on for pay rates. */
export function fmtPayRate(
  amount: number | string | null | undefined,
  payType: 'HOURLY' | 'SALARY' | null | undefined,
): string {
  const money = fmtMoney(amount);
  if (money === DASH) return DASH;
  if (payType === 'SALARY') return `${money}/yr`;
  if (payType === 'HOURLY') return `${money}/hr`;
  return money;
}

export function fmtPercent(
  value: number | null | undefined,
  opts: { decimals?: number; fromFraction?: boolean } = {},
): string {
  if (value === null || value === undefined) return DASH;
  if (!Number.isFinite(value)) return DASH;
  // Pass `fromFraction: true` when the value is 0–1 (e.g., 0.05 → 5%).
  const pct = opts.fromFraction ? value * 100 : value;
  const decimals = opts.decimals ?? 1;
  // Drop the trailing `.0` for whole numbers: 5% not 5.0%.
  const rounded = Math.round(pct * 10 ** decimals) / 10 ** decimals;
  if (Number.isInteger(rounded)) return `${rounded}%`;
  return `${rounded.toFixed(decimals)}%`;
}

/**
 * "May 13, 2026". Accepts a date-only string, a full datetime, or a Date.
 *
 * Date-only strings ("2026-03-01") are anchored at LOCAL midnight rather
 * than handed to `new Date()`, which parses them as UTC and then renders
 * the PREVIOUS day everywhere west of Greenwich. That was a live bug:
 * an application's start date read a day early on the list screen while
 * the detail screen — which parsed it locally — read correctly. Doing it
 * here means every caller is right by default instead of each screen
 * needing to remember its own workaround.
 */
export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return DASH;
  // isDateOnly is a STRICT full match: a genuine timestamp
  // ("2026-03-01T23:00:00Z") still goes through `new Date()` so it keeps
  // rendering in the viewer's zone, which for a real instant is correct.
  const d =
    typeof value === 'string' && isDateOnly(value)
      ? (parseDateOnly(value) ?? new Date(value))
      : new Date(value as string | number | Date);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString(EN_US, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** "May 13, 2026, 9:31 AM". For event timestamps. */
export function fmtDateTime(
  value: string | Date | null | undefined,
): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString(EN_US, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "9:31 AM". For times where the date is implicit (today's punches, etc.). */
export function fmtTime(value: string | Date | null | undefined): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleTimeString(EN_US, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Timezone-aware variants for the scheduling calendar. A shift is a UTC
 * instant but belongs to a STORE — rendering it in the viewer's browser
 * zone shows the wrong wall-clock for anyone not physically at the site
 * (a CA manager viewing a FL store sees every shift 3h early). Pass the
 * shift's `timezone` (an IANA name) so the grid shows store-local time.
 * Falls back to the browser zone when no timezone is given.
 */
export function fmtTimeTz(
  value: string | Date | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleTimeString(EN_US, {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Store-local date, e.g. "May 13". For calendar day labels. */
export function fmtDateTz(
  value: string | Date | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString(EN_US, {
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Store-local short weekday, e.g. "Mon". For schedule day headers. Browser
 *  zone when `timeZone` is absent. */
export function fmtWeekdayTz(
  value: string | Date | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString(EN_US, {
    weekday: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * Full day header for calendar surfaces: "Friday, Jun 13" (or
 * "Friday, Jun 13, 2026" with `year`). The weekday-with-date sibling of
 * fmtWeekdayTz/fmtDateTz, so day headers can't drift from the chip dates
 * rendered next to them.
 *
 * Zone rule, same as the whole *Tz family: pass the STORE zone when the
 * value is a shift instant; pass nothing when the value is a calendar
 * anchor (a browser-local-midnight Date whose local Y/M/D IS the day the
 * grid buckets by — see calendarDates.ts), so the label always matches
 * the `ymd(anchor)` bucketing key.
 */
export function fmtDayHeaderTz(
  value: string | Date | null | undefined,
  timeZone?: string | null,
  opts: { year?: boolean } = {},
): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString(EN_US, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(opts.year ? { year: 'numeric' } : {}),
    ...(timeZone ? { timeZone } : {}),
  });
}

/** "June 2026" — month-view headers. Same zone rule as fmtDayHeaderTz. */
export function fmtMonthYearTz(
  value: string | Date | null | undefined,
  timeZone?: string | null,
): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString(EN_US, {
    month: 'long',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** The viewer's own IANA timezone (e.g. "America/Los_Angeles"). */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Short zone abbreviation for a timezone at a given instant ("EDT", "PST").
 * Used to label the schedule "times shown in <zone>" when the viewer isn't
 * in the store's timezone, so nobody misreads a shift.
 */
export function tzAbbrev(
  timeZone: string,
  at: string | Date = new Date(),
): string {
  const d = at instanceof Date ? at : new Date(at);
  const parts = new Intl.DateTimeFormat(EN_US, {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(d);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

/**
 * Convert a wall-clock time in a given IANA zone to the matching UTC Date.
 *
 * The scheduling grid renders every shift in its work-site's zone
 * (`fmtTimeTz`), so the times an admin TYPES in the create/edit dialogs must
 * be interpreted in that SAME zone — not the admin's browser zone. Without
 * this, a CA admin entering "4am" for a FL store stores 4am Pacific (= 7am
 * Eastern), and the admin's published view and the associate's app both show
 * the shift 3h late.
 *
 * Single-pass offset correction: treat the wall-clock as UTC, measure how far
 * that instant's wall-clock in `timeZone` differs, and subtract. Accurate
 * except inside the ~1h DST-transition gap, which shifts almost never start in.
 * Falls back to browser-local when `timeZone` is absent (location-less shift).
 */
// PERF: Intl.DateTimeFormat construction is expensive (locale + tz data
// resolution). zonedWallTimeToUtc runs associates × days times the moment
// a shift chip is picked up in the scheduling grid (up to 3,500 calls per
// drag-start), so the formatter is cached per zone — same treatment
// zonedDayKey already had.
const WALL_TIME_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

export function zonedWallTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone?: string | null,
): Date {
  if (!timeZone) return new Date(year, month - 1, day, hour, minute, 0, 0);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let dtf = WALL_TIME_FMT_CACHE.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat(EN_US, {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    WALL_TIME_FMT_CACHE.set(timeZone, dtf);
  }
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(asUtc))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const zonedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return new Date(asUtc - (zonedAsUtc - asUtc));
}

/** Parse a `datetime-local` value ("YYYY-MM-DDTHH:MM") as wall-clock in
 *  `timeZone` and return the UTC ISO string. */
export function localInputToUtcIso(value: string, timeZone?: string | null): string {
  const [datePart, timePart] = value.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = (timePart ?? '00:00').split(':').map(Number);
  return zonedWallTimeToUtc(y, mo, d, h, mi, timeZone).toISOString();
}

/** Format a UTC instant as a `datetime-local` value ("YYYY-MM-DDTHH:MM")
 *  showing the wall-clock in `timeZone` (so the editor matches the grid). */
export function utcToZonedDatetimeInput(
  value: string | Date,
  timeZone?: string | null,
): string {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (!timeZone) {
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }
  const dtf = new Intl.DateTimeFormat(EN_US, {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * Calendar-day key ("YYYY-MM-DD") of an instant AS SEEN in `timeZone`.
 *
 * The calendar grid buckets shifts into day columns. A shift is a UTC instant
 * but belongs to a STORE, and the grid labels its time in the store's zone —
 * so it must be bucketed by the store-local calendar day, not the browser's.
 * Otherwise an 11pm-Eastern shift viewed from Pacific files under the previous
 * day (8pm browser-local) and vanishes from its real column.
 *
 * Returns the browser-local calendar date when `timeZone` is absent (so the
 * same-zone case is byte-for-byte the previous behavior).
 */
// Intl.DateTimeFormat construction is expensive (locale + tz data
// resolution); zonedDayKey runs per shift in the calendar bucketing hot
// path, so cache one formatter per zone.
const DAY_KEY_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

export function zonedDayKey(
  value: string | Date,
  timeZone?: string | null,
): string {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (!timeZone) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  let dtf = DAY_KEY_FMT_CACHE.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat(EN_US, {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DAY_KEY_FMT_CACHE.set(timeZone, dtf);
  }
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Minutes-from-midnight (0–1439) of an instant AS SEEN in `timeZone`. Used to
 * position a chip on the vertical hour axis so it lands at its store-local
 * time, matching its label. Browser-local when `timeZone` is absent.
 */
// PERF: called once per shift chip for vertical positioning in the
// calendar views — cache the formatter per zone (see WALL_TIME_FMT_CACHE).
const MINUTES_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

export function zonedMinutesOfDay(
  value: string | Date,
  timeZone?: string | null,
): number {
  const d = value instanceof Date ? value : new Date(value);
  if (!timeZone) return d.getHours() * 60 + d.getMinutes();
  let dtf = MINUTES_FMT_CACHE.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat(EN_US, {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    MINUTES_FMT_CACHE.set(timeZone, dtf);
  }
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return p.hour * 60 + p.minute;
}

/**
 * Shift time range in the WORK SITE's timezone: "7:00 AM – 3:00 PM".
 * Cross-midnight shifts carry the end date ("11:00 PM – 7:00 AM (Jun 17)"),
 * and the zone abbreviation is appended when the viewer's browser isn't in
 * the store's zone so nobody misreads a shift. The single source of truth
 * for rendering a shift's hours anywhere in the associate portal — the
 * schedule list, the dashboard card, and swap cards must all agree.
 */
export function fmtShiftRangeTz(
  startsAt: string | Date,
  endsAt: string | Date,
  timeZone?: string | null,
): string {
  const start = fmtTimeTz(startsAt, timeZone);
  const end = fmtTimeTz(endsAt, timeZone);
  const crossesMidnight =
    zonedDayKey(startsAt, timeZone) !== zonedDayKey(endsAt, timeZone);
  const base = crossesMidnight
    ? `${start} – ${end} (${fmtDateTz(endsAt, timeZone)})`
    : `${start} – ${end}`;
  const showZone = timeZone && timeZone !== browserTimeZone();
  return showZone ? `${base} ${tzAbbrev(timeZone, startsAt)}` : base;
}

/**
 * "Today", "Tomorrow", or "Mon, Jun 16" — relative to `now`, evaluated in
 * the store's timezone so a store across a date line doesn't flip the label.
 * Shared by the schedule day headers and the dashboard next-shift card so
 * the two surfaces never disagree about what day a shift is.
 */
export function fmtRelativeDayTz(
  value: string | Date,
  timeZone?: string | null,
  now: number = Date.now(),
): string {
  // Date FORMATTING stays en-US app-wide, but "Today"/"Tomorrow" are our
  // own words and read badly inside otherwise-Spanish sentences. The
  // I18nProvider keeps <html lang> current, so this non-React helper can
  // localize the two words without threading a lang param everywhere.
  const es =
    typeof document !== 'undefined' && document.documentElement.lang === 'es';
  const key = zonedDayKey(value, timeZone);
  const todayKey = zonedDayKey(new Date(now), timeZone);
  if (key === todayKey) return es ? 'Hoy' : 'Today';
  // Tomorrow is derived from today's CALENDAR key, not from now + 86.4e6 ms.
  // The instant-based version broke in any DST-observing zone: on the
  // fall-back day (25 hours long) now + 24h is still today, so "Tomorrow"
  // silently degraded to "Sun, Nov 1" — on the associate schedule, which is
  // the surface that leans hardest on the relative wording.
  if (key === nextCalendarDayKey(todayKey)) return es ? 'Mañana' : 'Tomorrow';
  return `${fmtWeekdayTz(value, timeZone)}, ${fmtDateTz(value, timeZone)}`;
}

/**
 * "YYYY-MM-DD" → the next calendar day, same format. Uses UTC arithmetic on
 * a date-only value, which has no offset to shift, so the result is exact in
 * every timezone regardless of DST.
 */
function nextCalendarDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/**
 * Today's calendar date in the BROWSER's timezone as "YYYY-MM-DD".
 * `new Date().toISOString().slice(0, 10)` is UTC, so an evening user west
 * of UTC gets tomorrow's date pre-filled in forms — several pages carried
 * private copies of this helper to avoid exactly that.
 */
export function ymdLocal(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight on `ymd`, as an ISO instant — the inclusive start of a range. */
export function ymdToIsoStart(ymd: string): string {
  return new Date(`${ymd}T00:00:00`).toISOString();
}

/**
 * Local midnight on the day AFTER `ymd` — the exclusive end of a range.
 *
 * Uses calendar arithmetic (`setDate(+1)`), not `+ 24h`. A local day is 23 or
 * 25 hours long across a DST change, so adding a fixed 24h lands at 23:00 or
 * 01:00 rather than midnight: on the fall-back day that silently drops the
 * final hour of the range, and on spring-forward it pulls in an hour of the
 * next day.
 */
export function ymdToIsoEndExclusive(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/**
 * Parse a date-only "YYYY-MM-DD" string as LOCAL midnight. `new Date(s)`
 * parses date-only strings as UTC midnight, which renders/compares as the
 * previous day west of UTC (birthdays a day early, expiries a day late).
 * Returns null for malformed input.
 */
export function parseYmd(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** "2h ago", "yesterday", "Mar 4". For activity feeds. */
export function fmtRelativeDate(
  value: string | Date | null | undefined,
): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return fmtDate(d);
}

/**
 * Human-readable byte size: "512 B", "3.4 KB", "1.25 MB". Binary units
 * (1 KB = 1024 B) — matches what the OS file pickers show, so the size an
 * associate sees next to their upload agrees with Finder/Explorer.
 * Consolidates six identical per-page copies (documents views, onboarding
 * upload tasks, DocumentPreview). Follows the module convention: null /
 * undefined / non-finite input renders as '—'.
 */
export function fmtSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return DASH;
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
