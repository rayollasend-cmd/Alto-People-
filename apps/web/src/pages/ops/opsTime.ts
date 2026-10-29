import { ymdLocal } from '@/lib/format';

/**
 * Time, on a board whose whole subject is what happened when.
 *
 * The board used to show three relative timestamps and nothing else, so
 * anything older than a day read "2 days ago" and a closed shift showed
 * no closing time at all. "The overnight at Destin finished at 6:04am" is
 * a different fact from "2 days ago", and only one of them settles an
 * argument.
 *
 * Everything here is rendered in the store's operating timezone, which is
 * how the people being asked about it experienced the clock. The zone is
 * always named, because an unlabelled time across several stores is a
 * guess.
 */

/**
 * Where the org runs: the zone the API names on every ops read (the board's
 * and history's `timezone`, the company's own — apps/api/src/lib/siteDay.ts),
 * never a zone written into the code (F500 SH-4: a board in New York time for
 * a store on Central time said "as of 1:03 PM" beside the header's 10:03).
 * Until the first read lands it is the company default the API itself
 * falls back to (apps/api/src/lib/timezone.ts DEFAULT_TIMEZONE).
 */
let currentTz = 'America/New_York';

/** @deprecated read opsTimeZone(): the zone follows the company's setting now. */
export const OPS_TZ = currentTz;

let clock: Intl.DateTimeFormat;
let full: Intl.DateTimeFormat;
let dayLabel: Intl.DateTimeFormat;
function build(tz: string) {
  clock = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  full = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });
  dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
}
build(currentTz);

/** The zone every time on the ops pages is shown in. */
export function opsTimeZone(): string {
  return currentTz;
}

/** The zone, said plainly: "Chicago" for America/Chicago. */
export function opsTimeZoneCity(): string {
  return currentTz.split('/').pop()?.replace(/_/g, ' ') ?? currentTz;
}

/** The zone with its abbreviation, for a label beside the times: "New York (EDT)". */
export function opsTimeZoneLabel(at: Date = new Date()): string {
  let abbr: string;
  try {
    abbr =
      new Intl.DateTimeFormat('en-US', { timeZone: currentTz, timeZoneName: 'short' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    abbr = '';
  }
  const city = opsTimeZoneCity();
  return abbr ? `${city} (${abbr})` : city;
}

/** Take the zone an ops read names (idempotent; call it with each response). */
export function setOpsTimeZone(tz: string | null | undefined): void {
  if (!tz || tz === currentTz) return;
  try {
    build(tz);
    currentTz = tz;
  } catch {
    build(currentTz); // an unknown zone keeps the last good one
  }
}

/** "6:04 AM" — the clock time on the floor. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : clock.format(d);
}

/** "Sat, Sep 20, 6:04 AM EDT" — for the title attribute and the record. */
export function fmtFull(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : full.format(d);
}

/** "Sat, Sep 20" from an org day key (YYYY-MM-DD), read as that day. */
export function fmtDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  // Noon UTC keeps the date from sliding backwards in a western zone.
  return dayLabel.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** "3m ago" / "4h ago" — only ever ALONGSIDE a real time, never instead. */
export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** How long a shift ran, from two instants. "7h 12m". */
export function fmtDuration(from: string, to: string | null | undefined): string {
  if (!to) return '';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Today in the org's zone, as YYYY-MM-DD. */
export function opsToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: currentTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
}

/** N days before a day key, as a day key. */
export function shiftDayKey(key: string, days: number): string {
  // Calendar math on the key itself: local noon of that day, stepped by calendar days.
  const [y, m, d] = key.split('-').map(Number);
  const base = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
  base.setDate(base.getDate() + days);
  return ymdLocal(base);
}

/** "Sep 20" from an org day key — for chart ticks, where the weekday is
 *  noise and the year is already established by the range. */
const shortDay = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});
export function fmtShortDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  return shortDay.format(new Date(Date.UTC(y, m - 1, d, 12)));
}
