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
