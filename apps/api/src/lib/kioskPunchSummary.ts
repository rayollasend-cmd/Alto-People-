import type { Prisma, PrismaClient } from '@prisma/client';
import { breakQuestionsFor } from './timeCorrections.js';
import { startOfWeekForSite } from './timeAnomalies.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * What the kiosk's result screen says back after a punch — the answers a
 * worker otherwise walks over to a supervisor for:
 *
 *   shift      the scheduled window this punch belongs to
 *   late       on a clock-in, how far from the shift's start (minutes;
 *              negative = early)
 *   meal due   on a clock-in where the state requires a meal break, when
 *              it's due
 *   week       paid hours so far this workweek (the site's zone, the
 *              company's start day), the open entry counted up to now
 *
 * Shown on a shared screen, so: no pay, no rate, nothing a coworker in
 * line shouldn't see. Best-effort — a failure here never fails the punch.
 */
export interface KioskPunchSummary {
  timezone: string;
  shift: { startsAt: string; endsAt: string } | null;
  lateMinutes: number | null;
  mealDueAt: string | null;
  weekMinutes: number;
}

const MIN = 60_000;

export async function kioskPunchSummary(
  db: Db,
  input: {
    associateId: string;
    timeEntryId: string;
    action: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END';
    at: Date;
    site: { timezone: string | null; state: string | null } | null;
  },
): Promise<KioskPunchSummary> {
  const timezone = input.site?.timezone ?? 'America/New_York';
  const entry = await db.timeEntry.findUnique({
    where: { id: input.timeEntryId },
    select: { clockInAt: true, shift: { select: { startsAt: true, endsAt: true } } },
  });
  const shift = entry?.shift ?? null;
  const lateMinutes =
    input.action === 'CLOCK_IN' && entry && shift
      ? Math.round((entry.clockInAt.getTime() - shift.startsAt.getTime()) / MIN)
      : null;

  let mealDueAt: string | null = null;
  if (input.action === 'CLOCK_IN' && entry) {
    const q = breakQuestionsFor(input.site?.state ?? null);
    if (q.meal && q.mealAfterHours !== null) {
      mealDueAt = new Date(entry.clockInAt.getTime() + q.mealAfterHours * 60 * MIN).toISOString();
    }
  }

  const weekStart = startOfWeekForSite(input.at, timezone);
  const entries = await db.timeEntry.findMany({
    where: {
      associateId: input.associateId,
      status: { not: 'REJECTED' },
      clockInAt: { gte: weekStart, lte: input.at },
    },
    select: { clockInAt: true, clockOutAt: true, breaks: { select: { type: true, startedAt: true, endedAt: true } } },
    take: 200,
  });
  let weekMs = 0;
  for (const e of entries) {
    const end = e.clockOutAt ?? input.at;
    let ms = Math.max(0, end.getTime() - e.clockInAt.getTime());
    // Meal breaks are unpaid; rest breaks are paid and stay in.
    for (const b of e.breaks) {
      if (b.type !== 'MEAL') continue;
      const bEnd = b.endedAt ?? end;
      ms -= Math.max(0, Math.min(bEnd.getTime(), end.getTime()) - b.startedAt.getTime());
    }
    weekMs += Math.max(0, ms);
  }

  return {
    timezone,
    shift: shift ? { startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString() } : null,
    lateMinutes,
    mealDueAt,
    weekMinutes: Math.round(weekMs / MIN),
  };
}
