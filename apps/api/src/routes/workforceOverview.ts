import { Router } from 'express';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import {
  orgDateKey,
  startOfWeekUTC,
  utcInstantOfLocalMidnight,
} from '../lib/timeAnomalies.js';
import { soonestPayday } from '../lib/payday.js';

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
// Client-bounded callers (SHIFT_SUPERVISOR holds manage:scheduling!) are
// clamped to their own client on EVERY query — fail closed when unset,
// same NO_CLIENT convention as lib/scope.ts.
const NO_CLIENT = '00000000-0000-0000-0000-000000000000';
function clientClampFor(user: { role: string; clientId: string | null }): {
  clientId?: string;
} {
  if (user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR') {
    return { clientId: user.clientId ?? NO_CLIENT };
  }
  return {};
}

workforceOverviewRouter.get(
  '/workforce/overview',
  requireCapability('manage:scheduling'),
  async (req, res, next) => {
    try {
      const user = req.user!;
      const clamp = clientClampFor(user);
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

      const [activeEntries, todayShifts, tomorrowShifts, weekEvents, incidentRows, openNext48h, todayEvents, upcomingOpen, pendingApprovals, payday, recentApproved] =
        await Promise.all([
          prisma.timeEntry.findMany({
            where: { status: 'ACTIVE', ...clamp },
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
              ...clamp,
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
              ...clamp,
              startsAt: { gte: tomorrowStart, lt: dayAfterStart },
            },
            select: { status: true, acknowledgedAt: true, client: { select: { id: true } } },
            take: 2000,
          }),
          prisma.attendanceEvent.findMany({
            where: { occurredOn: { gte: weekStart }, excusedAt: null, ...clamp },
            select: { kind: true },
            take: 2000,
          }),
          prisma.oshaIncident.findMany({
            where: { occurredAt: { gte: todayStart }, ...clamp },
            orderBy: { occurredAt: 'desc' },
            take: 20,
            select: { occurredAt: true, clientId: true, severity: true },
          }),
          prisma.shift.count({
            where: {
              ...published,
              status: 'OPEN',
              ...clamp,
              startsAt: { gte: now, lt: new Date(now.getTime() + 48 * HOUR_MS) },
            },
          }),
          // Today's exception FEED — names, not just counts ("daily
          // exception post; silence means green").
          prisma.attendanceEvent.findMany({
            where: { occurredOn: { gte: todayStart }, excusedAt: null, ...clamp },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: {
              kind: true,
              clientId: true,
              createdAt: true,
              associate: { select: { firstName: true, lastName: true } },
            },
          }),
          // The dispatch list itself — the next open shifts to backfill.
          prisma.shift.findMany({
            where: {
              ...published,
              status: 'OPEN',
              ...clamp,
              startsAt: { gte: now, lt: new Date(now.getTime() + 48 * HOUR_MS) },
            },
            orderBy: { startsAt: 'asc' },
            take: 5,
            select: {
              id: true,
              position: true,
              startsAt: true,
              client: { select: { name: true } },
            },
          }),
          // SEAM: the money cycle. Completed-but-unapproved timesheets are
          // what Finance chases to close payroll — surface the number on
          // the field side so the chase mostly never has to happen.
          prisma.timeEntry.count({
            where: { status: 'COMPLETED', clockOutAt: { not: null }, ...clamp },
          }),
          soonestPayday(prisma, now),
          // SEAM: the people supply chain. HR approved them; the next move
          // (scheduling) is THIS desk's. Candidates resolve below.
          prisma.application.findMany({
            where: {
              status: 'APPROVED',
              approvedAt: { gte: new Date(now.getTime() - 60 * 24 * HOUR_MS) },
              deletedAt: null,
              ...clamp,
            },
            orderBy: { approvedAt: 'desc' },
            take: 100,
            select: {
              associateId: true,
              approvedAt: true,
              client: { select: { name: true } },
              associate: {
                select: { id: true, firstName: true, lastName: true, deletedAt: true },
              },
            },
          }),
        ]);

      // Ready to schedule: approved in the last 60 days, and NOT holding a
      // single upcoming assigned shift — the baton is on the floor.
      const approvedIds = recentApproved
        .filter((a) => a.associate.deletedAt === null)
        .map((a) => a.associateId);
      const withUpcoming =
        approvedIds.length > 0
          ? await prisma.shift.findMany({
              where: {
                assignedAssociateId: { in: approvedIds },
                status: 'ASSIGNED',
                startsAt: { gte: now },
              },
              select: { assignedAssociateId: true },
              distinct: ['assignedAssociateId'],
            })
          : [];
      const scheduledIds = new Set(withUpcoming.map((s) => s.assignedAssociateId));
      const readyRows = recentApproved
        .filter(
          (a) => a.associate.deletedAt === null && !scheduledIds.has(a.associateId),
        )
        .map((a) => ({
          associateId: a.associateId,
          name: `${a.associate.firstName} ${a.associate.lastName}`.trim(),
          clientName: a.client?.name ?? null,
          approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
        }));

      // THE INTERNAL LABOR MARKET: for each of the next 3 days, stores
      // that are short (open shifts) side by side with the bench — active
      // workers (worked in the last 30 days) holding NO shift that day.
      // The field trades labor like one organism instead of silos.
      // Skipped for client-bounded callers: the bench is org-wide data.
      let rebalance: Array<{
        dateKey: string;
        clientId: string;
        clientName: string;
        open: number;
        bench: number;
      }> = [];
      if (!('clientId' in clamp)) {
        const horizon = 3;
        const openAhead = await prisma.shift.findMany({
          where: {
            ...published,
            status: 'OPEN',
            startsAt: { gte: todayStart, lt: utcInstantOfLocalMidnight(dayKeyPlus(todayKey, horizon), ORG_TZ) },
          },
          select: { startsAt: true, client: { select: { id: true, name: true } } },
          take: 500,
        });
        if (openAhead.length > 0) {
          const recentWorkers = await prisma.timeEntry.findMany({
            where: {
              clockInAt: { gte: new Date(now.getTime() - 30 * 24 * HOUR_MS) },
              associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
            },
            select: { associateId: true },
            distinct: ['associateId'],
            take: 2000,
          });
          const activeIds = recentWorkers.map((w) => w.associateId);
          const busyAhead = await prisma.shift.findMany({
            where: {
              assignedAssociateId: { in: activeIds },
              status: 'ASSIGNED',
              startsAt: { gte: todayStart, lt: utcInstantOfLocalMidnight(dayKeyPlus(todayKey, horizon), ORG_TZ) },
            },
            select: { assignedAssociateId: true, startsAt: true },
            take: 2000,
          });
          const busyByDay = new Map<string, Set<string>>();
          for (const s of busyAhead) {
            const key = orgDateKey(s.startsAt);
            const set = busyByDay.get(key) ?? new Set<string>();
            if (s.assignedAssociateId) set.add(s.assignedAssociateId);
            busyByDay.set(key, set);
          }
          const needMap = new Map<
            string,
            { dateKey: string; clientId: string; clientName: string; open: number }
          >();
          for (const s of openAhead) {
            if (!s.client) continue;
            const dateKey = orgDateKey(s.startsAt);
            const k = `${dateKey}:${s.client.id}`;
            const row =
              needMap.get(k) ??
              ({ dateKey, clientId: s.client.id, clientName: s.client.name, open: 0 });
            row.open += 1;
            needMap.set(k, row);
          }
          rebalance = [...needMap.values()]
            .map((r) => ({
              ...r,
              bench: Math.max(
                0,
                activeIds.length - (busyByDay.get(r.dateKey)?.size ?? 0),
              ),
            }))
            .sort(
              (a, b) => a.dateKey.localeCompare(b.dateKey) || b.open - a.open,
            )
            .slice(0, 6);
        }
      }

      // Pre-shift check: on the clock with no shift behind the punch.
      const unscheduled = activeEntries.filter((e) => e.shiftId === null);
      const nameNeededIds = [
        ...new Set(
          [...unscheduled.map((e) => e.clientId), ...todayEvents.map((e) => e.clientId), ...incidentRows.map((i) => i.clientId)]
            .filter((c): c is string => !!c),
        ),
      ];
      const clientNames = new Map(
        (
          await prisma.client.findMany({
            where: { id: { in: nameNeededIds } },
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

      // THE BOARD: every operationally-live store as a status tile —
      // now-state, today's holes, tomorrow's uncertainty, today's
      // exceptions and incidents — triage-sorted red → amber → green.
      interface StoreTile {
        clientId: string | null;
        clientName: string;
        onFloor: number;
        scheduledNow: number;
        openToday: number;
        unconfirmedTomorrow: number;
        openTomorrow: number;
        exceptionsToday: number;
        noShowsToday: number;
        incidentsToday: number;
        unscheduledNow: number;
        status: 'red' | 'amber' | 'green';
      }
      const storeMap = new Map<string, StoreTile>();
      const storeBucket = (id: string | null, name: string | null) => {
        const key = id ?? 'none';
        const b =
          storeMap.get(key) ??
          ({
            clientId: id,
            clientName: name ?? '—',
            onFloor: 0,
            scheduledNow: 0,
            openToday: 0,
            unconfirmedTomorrow: 0,
            openTomorrow: 0,
            exceptionsToday: 0,
            noShowsToday: 0,
            incidentsToday: 0,
            unscheduledNow: 0,
            status: 'green',
          } as StoreTile);
        storeMap.set(key, b);
        return b;
      };
      for (const s of todayShifts) {
        const b = storeBucket(s.client?.id ?? null, s.client?.name ?? null);
        if (s.status === 'OPEN') b.openToday += 1;
        else if (
          s.startsAt.getTime() <= now.getTime() &&
          s.endsAt.getTime() > now.getTime()
        ) {
          b.scheduledNow += 1;
        }
      }
      for (const s of tomorrowShifts) {
        if (!s.client?.id) continue;
        if (!storeMap.has(s.client.id)) continue; // named below if needed
        const b = storeMap.get(s.client.id)!;
        if (s.status === 'OPEN') b.openTomorrow += 1;
        else if (s.acknowledgedAt === null) b.unconfirmedTomorrow += 1;
      }
      for (const e of todayEvents) {
        if (!e.clientId) continue;
        const b = storeMap.get(e.clientId);
        if (!b) continue;
        b.exceptionsToday += 1;
        if (e.kind === 'NO_CALL_NO_SHOW') b.noShowsToday += 1;
      }
      for (const i of incidentRows) {
        const b = storeMap.get(i.clientId);
        if (b) b.incidentsToday += 1;
      }
      for (const e of activeEntries) {
        if (!e.clientId) continue;
        const existing = storeMap.get(e.clientId);
        if (existing) {
          existing.onFloor += 1;
          if (e.shiftId === null) existing.unscheduledNow += 1;
        }
      }
      // Punches at clients with no shifts today still deserve a tile.
      const missingIds = [
        ...new Set(
          activeEntries
            .map((e) => e.clientId)
            .filter((c): c is string => !!c && !storeMap.has(c)),
        ),
      ];
      if (missingIds.length > 0) {
        const named = await prisma.client.findMany({
          where: { id: { in: missingIds } },
          select: { id: true, name: true },
        });
        for (const c of named) storeBucket(c.id, c.name);
        for (const e of activeEntries) {
          if (e.clientId && missingIds.includes(e.clientId)) {
            const b = storeMap.get(e.clientId)!;
            b.onFloor += 1;
            if (e.shiftId === null) b.unscheduledNow += 1;
          }
        }
      }
      const rank = { red: 0, amber: 1, green: 2 } as const;
      const stores = [...storeMap.values()]
        .filter(
          (s) =>
            s.onFloor + s.scheduledNow + s.openToday + s.unconfirmedTomorrow + s.openTomorrow > 0,
        )
        .map((s) => {
          s.status =
            s.noShowsToday > 0 ||
            s.incidentsToday > 0 ||
            s.unscheduledNow > 0 ||
            s.onFloor < s.scheduledNow
              ? 'red'
              : s.openToday > 0 || s.openTomorrow > 0 || s.unconfirmedTomorrow > 0
                ? 'amber'
                : 'green';
          return s;
        })
        .sort(
          (a, b) =>
            rank[a.status] - rank[b.status] ||
            b.openToday - a.openToday ||
            a.clientName.localeCompare(b.clientName),
        )
        .slice(0, 12);
      const needsAttention = stores.filter((s) => s.status !== 'green').length;

      // THE WIRE: everything happening everywhere, newest first —
      // exceptions, incidents, and unscheduled punches, one stream.
      const wire = [
        ...todayEvents.slice(0, 8).map((e) => ({
          type: 'exception' as const,
          kind: e.kind as string,
          name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
          clientName: e.clientId ? clientNames.get(e.clientId) ?? null : null,
          at: e.createdAt.toISOString(),
        })),
        ...incidentRows.slice(0, 6).map((i) => ({
          type: 'incident' as const,
          kind: i.severity as string,
          name: null as string | null,
          clientName: clientNames.get(i.clientId) ?? null,
          at: i.occurredAt.toISOString(),
        })),
        ...unscheduled.slice(0, 6).map((e) => ({
          type: 'unscheduled' as const,
          kind: null as string | null,
          name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
          clientName: e.clientId ? clientNames.get(e.clientId) ?? null : null,
          at: e.clockInAt.toISOString(),
        })),
      ]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, 12);

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
          // Faces for the hero — who is actually out there right now.
          people: activeEntries.slice(0, 12).map((e) => ({
            associateId: e.associate.id,
            name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
          })),
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
          stores,
        },
        exceptionsToday: {
          count: todayEvents.length,
          feed: todayEvents.slice(0, 6).map((e) => ({
            kind: e.kind,
            name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
            clientName: e.clientId ? clientNames.get(e.clientId) ?? null : null,
            at: e.createdAt.toISOString(),
          })),
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
        incidentsToday: incidentRows.length,
        needsAttention,
        wire,
        close: {
          pendingApprovals,
          payday: payday ? { date: payday.date, schedule: payday.schedule } : null,
        },
        readyToSchedule: {
          count: readyRows.length,
          rows: readyRows.slice(0, 8),
        },
        rebalance,
        dispatch: {
          openNext48h,
          upcoming: upcomingOpen.map((s) => ({
            shiftId: s.id,
            clientName: s.client?.name ?? '—',
            position: s.position,
            startsAt: s.startsAt.toISOString(),
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The supervisor corps — the WFM's direct line. Every active shift and
 * floor supervisor account, with the contact facts that make the call
 * possible: name/phone/photo from the linked associate record (accounts
 * themselves carry only an email), grouped by store.
 */
workforceOverviewRouter.get(
  '/workforce/supervisors',
  requireCapability('manage:scheduling'),
  async (req, res, next) => {
    try {
      const users = await prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] },
          ...clientClampFor(req.user!),
        },
        select: {
          id: true,
          email: true,
          role: true,
          clientId: true,
          associate: {
            select: { id: true, firstName: true, lastName: true, phone: true },
          },
        },
        take: 200,
      });
      const clientIds = [
        ...new Set(users.map((u) => u.clientId).filter((c): c is string => !!c)),
      ];
      const clients = new Map(
        (
          await prisma.client.findMany({
            where: { id: { in: clientIds } },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );
      const rows = users
        .map((u) => ({
          userId: u.id,
          role: u.role as 'SHIFT_SUPERVISOR' | 'FLOOR_SUPERVISOR',
          email: u.email,
          name: u.associate
            ? `${u.associate.firstName} ${u.associate.lastName}`.trim()
            : u.email.split('@')[0]!,
          phone: u.associate?.phone ?? null,
          associateId: u.associate?.id ?? null,
          clientId: u.clientId,
          clientName: u.clientId ? clients.get(u.clientId) ?? null : null,
        }))
        .sort(
          (a, b) =>
            (a.clientName ?? 'zz').localeCompare(b.clientName ?? 'zz') ||
            a.role.localeCompare(b.role) ||
            a.name.localeCompare(b.name),
        );
      res.json({ supervisors: rows });
    } catch (err) {
      next(err);
    }
  },
);
