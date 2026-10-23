import type { Prisma, PrismaClient } from '@prisma/client';
import { inShiftWindow, minuteOfDayInZone } from '@alto-people/shared';
import { ledWindows, type LedWindow } from './shiftWindows.js';
import { utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { localDateKey } from './timezone.js';

/**
 * Today's short shift windows, for the people who lead them — the server
 * twin of the web's `coverageGaps` (components/floor/CoverageGapNotice).
 * The notice on the supervisor's home was client-side only, so the bell
 * and the phone badge said "all clear" above a hero reading 0 of 6. One
 * definition here feeds the Inbox source, the Needs-you queue and, through
 * them, every badge.
 *
 *   A gap is a led window today, not yet over on the store's clock, where
 *   the scheduled crew (published ASSIGNED or COMPLETED shifts whose start
 *   falls inside the window) is short of the window's contracted count.
 *   Open shifts in it are listed so one tap can send them to the bench.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface CoverageGap {
  window: LedWindow;
  /** Local day key at the store. */
  date: string;
  scheduled: number;
  openShiftIds: string[];
}

export async function coverageGapsForUser(db: Db, userId: string, now: Date = new Date()): Promise<CoverageGap[]> {
  const windows = await ledWindows(db, { userId }, now);
  if (windows.length === 0) return [];
  // Same-day windows that have ended are history; overnight ones run on.
  const open = windows.filter((w) => {
    if (w.targetCount <= 0) return false;
    const nowMin = minuteOfDayInZone(now, w.timezone);
    return !(w.endMinute > w.startMinute && nowMin >= w.endMinute);
  });
  if (open.length === 0) return [];

  // Today's shifts at each store, on the store's calendar.
  const byStore = new Map<string, { date: string; from: Date; to: Date }>();
  for (const w of open) {
    if (byStore.has(w.locationId)) continue;
    const date = localDateKey(now, w.timezone);
    const from = utcInstantOfLocalMidnight(date, w.timezone);
    byStore.set(w.locationId, { date, from, to: new Date(from.getTime() + 24 * 3_600_000) });
  }
  const shifts = await db.shift.findMany({
    where: {
      OR: [...byStore].map(([locationId, d]) => ({ locationId, startsAt: { gte: d.from, lt: d.to } })),
      status: { in: ['ASSIGNED', 'COMPLETED', 'OPEN'] },
      publishedAt: { not: null },
    },
    select: { id: true, locationId: true, startsAt: true, status: true },
    take: 2000,
  });

  const gaps: CoverageGap[] = [];
  for (const w of open) {
    const rows = shifts.filter((s) => s.locationId === w.locationId && inShiftWindow(minuteOfDayInZone(s.startsAt, w.timezone), w));
    const scheduled = rows.filter((s) => s.status !== 'OPEN').length;
    if (scheduled >= w.targetCount) continue;
    gaps.push({
      window: w,
      date: byStore.get(w.locationId)!.date,
      scheduled,
      openShiftIds: rows.filter((s) => s.status === 'OPEN').map((s) => s.id),
    });
  }
  return gaps;
}

/** "Tonight's Swing: 0 of 6 scheduled" — the way the floor says it. */
export function coverageGapLabel(g: CoverageGap): string {
  const when = g.window.startMinute >= 17 * 60 ? "Tonight's" : "Today's";
  return `${when} ${g.window.label}: ${g.scheduled} of ${g.window.targetCount} scheduled`;
}

/** Where a gap is fixed: that day's schedule for the store. */
export function coverageGapPath(g: CoverageGap): string {
  return `/scheduling?view=day&date=${g.date}&locationId=${g.window.locationId}`;
}

/** One led window on one day of the look-ahead: contracted vs scheduled. */
export interface CoverageAheadDay {
  /** Local day key at the store. */
  date: string;
  locationId: string;
  label: string;
  target: number;
  scheduled: number;
  /** Posted open shifts in the window that day. */
  open: number;
  /** max(0, target − scheduled): people the contract asks for that nobody is scheduled as. */
  short: number;
}

/**
 * The same definition as `coverageGapsForUser`, carried across the next
 * `days` days (today first, today's ended windows skipped): for every
 * window this person leads, the contracted count against the published
 * crew. The supervisor's "Open shifts · next 7 days" tile counted only
 * posted OPEN shifts, so it said "0 · Every shift covered" beside a hero
 * reading "0 of 6 · 6 short" — headcount nobody had even posted a shift for
 * was invisible. `shortOfContract` is that headcount; `openPosted` the
 * posted open shifts (the tile's sub-line).
 */
export async function coverageAheadForUser(
  db: Db,
  userId: string,
  now: Date = new Date(),
  days = 7,
): Promise<{ days: number; shortOfContract: number; windowsShort: number; openPosted: number; windows: number; byDay: CoverageAheadDay[] }> {
  const empty = { days, shortOfContract: 0, windowsShort: 0, openPosted: 0, windows: 0, byDay: [] as CoverageAheadDay[] };
  const windows = (await ledWindows(db, { userId }, now)).filter((w) => w.targetCount > 0);
  if (windows.length === 0) return empty;
  const zoneOf = new Map(windows.map((w) => [w.locationId, w.timezone]));
  const spans = [...zoneOf].map(([locationId, tz]) => {
    const first = localDateKey(now, tz);
    const from = utcInstantOfLocalMidnight(first, tz);
    // A day past the horizon covers overnight windows that start on the last day.
    return { locationId, tz, first, from, to: new Date(from.getTime() + (days + 1) * 24 * 3_600_000) };
  });
  const shifts = await db.shift.findMany({
    where: {
      OR: spans.map((s) => ({ locationId: s.locationId, startsAt: { gte: s.from, lt: s.to } })),
      status: { in: ['ASSIGNED', 'COMPLETED', 'OPEN'] },
      publishedAt: { not: null },
    },
    select: { locationId: true, startsAt: true, status: true },
    take: 5000,
  });
  const byDay: CoverageAheadDay[] = [];
  for (const span of spans) {
    for (let i = 0; i < days; i++) {
      const date = localDateKey(new Date(span.from.getTime() + (i * 24 + 12) * 3_600_000), span.tz);
      for (const w of windows.filter((x) => x.locationId === span.locationId)) {
        if (i === 0) {
          // Today: a same-day window that has ended is history.
          const nowMin = minuteOfDayInZone(now, w.timezone);
          if (w.endMinute > w.startMinute && nowMin >= w.endMinute) continue;
        }
        const rows = shifts.filter(
          (s) =>
            s.locationId === w.locationId &&
            localDateKey(s.startsAt, w.timezone) === date &&
            inShiftWindow(minuteOfDayInZone(s.startsAt, w.timezone), w),
        );
        const scheduled = rows.filter((s) => s.status !== 'OPEN').length;
        const open = rows.length - scheduled;
        byDay.push({ date, locationId: w.locationId, label: w.label, target: w.targetCount, scheduled, open, short: Math.max(0, w.targetCount - scheduled) });
      }
    }
  }
  byDay.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  return {
    days,
    shortOfContract: byDay.reduce((s, d) => s + d.short, 0),
    windowsShort: byDay.filter((d) => d.short > 0).length,
    openPosted: byDay.reduce((s, d) => s + d.open, 0),
    windows: byDay.length,
    byDay,
  };
}
