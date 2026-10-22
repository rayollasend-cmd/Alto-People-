import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { companyWorkweek, dateKeyInZone, utcInstantOfLocalMidnight } from './timeAnomalies.js';

/**
 * "THE SITE'S DAY" (F500 SH-4).
 *
 *   A floor's day starts and ends at midnight on the floor's own clock: the
 *   site's time zone, else the company's (OrgSetting/branding timezone).
 *   Never UTC, never a zone written into the code. Every screen that asks
 *   for "today's tasks", "closed today" or "this site's day" reads its
 *   bounds here, and says which zone it read them in.
 *
 *   Before: the tasks board asked for `${day}T00:00Z…23:59Z` — a UTC day, so
 *   after 5 PM Pacific it showed tomorrow's tasks — and the ops board took
 *   the company's date but measured "closed today" from midnight in a
 *   hard-coded America/New_York while Front Beach 218 runs on Central time.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The company's zone (its branding setting; the workweek is counted in it). */
export function orgTimeZone(): string {
  return companyWorkweek().timezone;
}

/** A site's own zone, else the company's. */
export async function siteTimeZone(siteId: string | null | undefined, db: Db = defaultPrisma): Promise<string> {
  if (!siteId) return orgTimeZone();
  const site = await db.site.findUnique({ where: { id: siteId }, select: { timezone: true } });
  return site?.timezone || orgTimeZone();
}

/** Today's date (YYYY-MM-DD) on a zone's clock. */
export function todayInTz(tz: string, now: Date = new Date()): string {
  return dateKeyInZone(now, tz);
}

/** The next calendar day of a YYYY-MM-DD. */
function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** [start, end) of the calendar day `ymd` on `tz`'s clock, as instants (DST-correct: a day may be 23 or 25 hours). */
export function dayBoundsInTz(ymd: string, tz: string): { start: Date; end: Date } {
  return { start: utcInstantOfLocalMidnight(ymd, tz), end: utcInstantOfLocalMidnight(nextDay(ymd), tz) };
}

/** A site's day (today by default): its zone, its key and its bounds. */
export async function siteDay(siteId: string | null | undefined, ymd?: string | null, db: Db = defaultPrisma, now: Date = new Date()): Promise<{ timezone: string; day: string; start: Date; end: Date }> {
  const timezone = await siteTimeZone(siteId, db);
  const day = ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : todayInTz(timezone, now);
  return { timezone, day, ...dayBoundsInTz(day, timezone) };
}
