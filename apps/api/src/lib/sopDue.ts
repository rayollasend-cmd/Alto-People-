import { localDateKey, zonedWallTimeToUtcInstant } from './timezone.js';

/**
 * SOP due times — a library block says "by 9:00 AM"; a run of it needs the
 * instant: 9:00 AM on THAT shift's clock, at the store. An overnight SOP's
 * "by 2:00 AM" is the morning after it opened.
 *
 * The first due time lands on its occurrence nearest the shift's start
 * (so a shift opened late still owes its early blocks — they're overdue);
 * every other lands in the day that follows from there, 2h of slack
 * before it for a block an admin put out of order.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const H = 3_600_000;

export function isDueTime(s: string): boolean {
  return HHMM.test(s);
}

/** "HH:MM" → minutes past midnight, null when absent or malformed. */
export function dueMinute(s: string | null | undefined): number | null {
  const m = s ? HHMM.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** `minute` past midnight on the store calendar day `days` after the one
 *  containing `at`. */
function onDay(at: Date, days: number, minute: number, tz: string): Date {
  const [y, m, d] = localDateKey(at, tz).split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d + days));
  return zonedWallTimeToUtcInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), minute, tz);
}

/** The due instant of each "HH:MM" (null stays null), for a shift that
 *  starts at `start` in store zone `tz`. */
export function dueInstants(dueTimes: Array<string | null | undefined>, start: Date, tz: string): Array<Date | null> {
  const minutes = dueTimes.map(dueMinute);
  const first = minutes.find((m): m is number => m !== null);
  if (first === undefined) return minutes.map(() => null);
  const base = [-1, 0, 1]
    .map((k) => onDay(start, k, first, tz))
    .reduce((a, b) => (Math.abs(b.getTime() - start.getTime()) < Math.abs(a.getTime() - start.getTime()) ? b : a));
  const from = base.getTime() - 2 * H;
  return minutes.map((minute) => {
    if (minute === null) return null;
    const hits = [-1, 0, 1, 2].map((k) => onDay(base, k, minute, tz));
    return hits.find((d) => d.getTime() >= from && d.getTime() < from + 24 * H) ?? hits[1]!;
  });
}
