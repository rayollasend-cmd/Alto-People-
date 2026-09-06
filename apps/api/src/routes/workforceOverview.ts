import { Router } from 'express';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import {
  orgDateKey,
  startOfWeekUTC,
  utcInstantOfLocalMidnight,
} from '../lib/timeAnomalies.js';

/**
 * The Workforce Manager's field cockpit — one round trip behind the
 * WORKFORCE_MANAGER dashboard, shaped by the field-leadership charter:
 *
 *   - THE FLOOR NOW: clocked-in vs scheduled-now, org-wide.
 *   - PRE-SHIFT CHECK: people ON the clock with NO shift behind the punch
 *     ("unscheduled associates go home before clock-in") — named, so the
 *     call to the store can happen this minute.
 *   - TODAY'S GAPS: open shifts today by client — where coverage is thin.
 *   - TOMORROW: confirmed / awaiting / open headcount.
 *   - THE WEEK'S EXCEPTIONS ("silence means green"): unexcused no-shows,
 *     call-outs, lates this org week; incidents reported today.
 *   - DISPATCH: open shifts in the next 48h — the backfill workload.
 *
 * Gated on manage:scheduling — coverage is a scheduler-tier read.
 */

export const workforceOverviewRouter = Router();

const ORG_TZ = 'America/New_York';
const HOUR_MS = 3600_000;

workforceOverviewRouter.get(
  '/workforce/overview',
  requireCapability('manage:scheduling'),
  async (_req, res, next) => {
    try {
      const now = new Date();
      const todayKey = orgDateKey(now);
      const todayStart = utcInstantOfLocalMidnight(todayKey, ORG_TZ);
      const dayKeyPlus = (key: string, days: number) => {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
      };
      const tomorrowStart = utcInstantOfLocalMidnight(dayKeyPlus(todayKey, 1), ORG_TZ);
      const dayAfterStart = utcInstantOfLocalMidnight(dayKeyPlus(todayKey, 2), ORG_TZ);
      const weekStart = startOfWeekUTC(now);

      const published = { publishedAt: { not: null } } as const;

      const [activeEntries, todayShifts, tomorrowShifts, weekEvents, incidentsToday, openNext48h] =
        await Promise.all([
          prisma.timeEntry.findMany({
            where: { status: 'ACTIVE' },
            select: {
              clockInAt: true,
              shiftId: true,
              clientId: true,
              associate: { select: { id: true, firstName: true, lastName: true } },
            },
            take: 1000,
          }),
          prisma.shift.findMany({
            where: {
              ...published,
              status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] },
              startsAt: { lt: tomorrowStart },
              endsAt: { gt: todayStart },
            },
            select: {
              status: true,
              startsAt: true,
              endsAt: true,
              client: { select: { id: true, name: true } },
            },
            take: 2000,
          }),
          prisma.shift.findMany({
            where: {
              ...published,
              status: { in: ['OPEN', 'ASSIGNED'] },
              startsAt: { gte: tomorrowStart, lt: dayAfterStart },
            },
            select: { status: true, acknowledgedAt: true },
            take: 2000,
          }),
          prisma.attendanceEvent.findMany({
            where: { occurredOn: { gte: weekStart }, excusedAt: null },
            select: { kind: true },
            take: 2000,
          }),
          prisma.oshaIncident.count({
            where: { occurredAt: { gte: todayStart } },
          }),
          prisma.shift.count({
            where: {
              ...published,
              status: 'OPEN',
              startsAt: { gte: now, lt: new Date(now.getTime() + 48 * HOUR_MS) },
            },
          }),
        ]);

      // Pre-shift check: on the clock with no shift behind the punch.
      const unscheduled = activeEntries.filter((e) => e.shiftId === null);
      const unscheduledClientIds = [
        ...new Set(unscheduled.map((e) => e.clientId).filter((c): c is string => !!c)),
      ];
      const clientNames = new Map(
        (
          await prisma.client.findMany({
            where: { id: { in: unscheduledClientIds } },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );

      const scheduledNow = todayShifts.filter(
        (s) =>
          s.status !== 'OPEN' &&
          s.startsAt.getTime() <= now.getTime() &&
          s.endsAt.getTime() > now.getTime(),
      ).length;

      // Today's coverage gaps, by client.
      const gapMap = new Map<string, { clientName: string; open: number; filled: number }>();
      for (const s of todayShifts) {
        const key = s.client?.id ?? 'none';
        const bucket =
          gapMap.get(key) ?? { clientName: s.client?.name ?? '—', open: 0, filled: 0 };
        if (s.status === 'OPEN') bucket.open += 1;
        else bucket.filled += 1;
        gapMap.set(key, bucket);
      }
      const gaps = [...gapMap.values()]
        .filter((g) => g.open > 0)
        .sort((a, b) => b.open - a.open)
        .slice(0, 5);

      const kindCount = (kind: string) =>
        weekEvents.filter((e) => e.kind === kind).length;

      const weekShiftAgg = await prisma.shift.groupBy({
        by: ['status'],
        where: {
          ...published,
          status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] },
          startsAt: { gte: weekStart, lt: new Date(weekStart.getTime() + 7 * 24 * HOUR_MS) },
        },
        _count: true,
      });
      const weekOpen = weekShiftAgg.find((r) => r.status === 'OPEN')?._count ?? 0;
      const weekFilled = weekShiftAgg
        .filter((r) => r.status !== 'OPEN')
        .reduce((s, r) => s + r._count, 0);
      const weekTotal = weekOpen + weekFilled;

      res.json({
        generatedAt: now.toISOString(),
        now: {
          onFloor: activeEntries.length,
          scheduledNow,
          unscheduled: unscheduled.slice(0, 10).map((e) => ({
            associateId: e.associate.id,
            name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
            clientName: e.clientId ? clientNames.get(e.clientId) ?? null : null,
            clockInAt: e.clockInAt.toISOString(),
          })),
          unscheduledCount: unscheduled.length,
        },
        today: {
          filled: todayShifts.filter((s) => s.status !== 'OPEN').length,
          open: todayShifts.filter((s) => s.status === 'OPEN').length,
          gaps,
        },
        tomorrow: {
          confirmed: tomorrowShifts.filter(
            (s) => s.status === 'ASSIGNED' && s.acknowledgedAt !== null,
          ).length,
          unconfirmed: tomorrowShifts.filter(
            (s) => s.status === 'ASSIGNED' && s.acknowledgedAt === null,
          ).length,
          open: tomorrowShifts.filter((s) => s.status === 'OPEN').length,
        },
        week: {
          start: orgDateKey(weekStart),
          fillRatePct: weekTotal > 0 ? Math.round((weekFilled / weekTotal) * 100) : null,
          noCallNoShows: kindCount('NO_CALL_NO_SHOW'),
          callOuts: kindCount('CALL_OUT'),
          lates: kindCount('LATE'),
        },
        incidentsToday,
        dispatch: { openNext48h },
      });
    } catch (err) {
      next(err);
    }
  },
);
