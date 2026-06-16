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

/** "May 13, 2026". Accepts ISO date or full datetime. */
export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return DASH;
  const d = value instanceof Date ? value : new Date(value);
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
  const dtf = new Intl.DateTimeFormat(EN_US, {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
export function zonedDayKey(
  value: string | Date,
  timeZone?: string | null,
): string {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (!timeZone) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const dtf = new Intl.DateTimeFormat(EN_US, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
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
export function zonedMinutesOfDay(
  value: string | Date,
  timeZone?: string | null,
): number {
  const d = value instanceof Date ? value : new Date(value);
  if (!timeZone) return d.getHours() * 60 + d.getMinutes();
  const dtf = new Intl.DateTimeFormat(EN_US, {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return p.hour * 60 + p.minute;
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
