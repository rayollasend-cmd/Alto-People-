import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { zonedMinutes } from './timezone.js';
import {
  HOUR,
  attendanceWhere,
  coverageByHours,
  currentTarget,
  entryScope,
  gradeWeeks,
  loadPunches,
  loadTargets,
  nextKey,
  shiftScope,
  storeCalendar,
  targetAtMinute,
  type PortalScope,
} from './portalMetrics.js';

/**
 * One store, at a glance — the card on the region command center.
 *
 * The same numbers the store manager's own page leads with, computed by
 * the same instruments (portalMetrics), reduced to what a regional
 * manager needs to rank thirty stores: on the floor vs contracted right
 * now, today's expected / in / unfilled, tomorrow's open slots, the
 * 4-week delivered-vs-contracted grade, open requests, and whether a
 * wave is short this minute.
 */

export interface StoreSnapshot {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  timezone: string;
  /**
   * TWO MEANINGS OF "SHORT", kept apart and named (F500 SH-4):
   *   shortOfContract      the contract's people for this window minus who is
   *                        on the floor (null when no contract target is set)
   *   missingFromSchedule  people scheduled into a wave under way (or its open
   *                        slots) who are not on the floor
   * `short` is the one a headline shows — the contract when a target exists,
   * else the schedule — and `shortBasis` says which, so a label can name it.
   * The region page once said "0 / 8 · 8 short" (contract) and "Every store
   * at or above its contract" (schedule) at once.
   */
  now: {
    onFloor: number;
    target: number | null;
    targetLabel: string | null;
    short: number;
    shortBasis: 'contract' | 'schedule';
    shortOfContract: number | null;
    missingFromSchedule: number;
    /** PEOPLE assigned to a wave that started more than the grace period ago
     *  and not on the floor — "late, not in yet". Open slots aren't people. */
    lateNotIn: number;
  };
  today: { expected: number; present: number; open: number; missedSoFar: number };
  tomorrow: { expected: number; open: number; unconfirmed: number };
  reliability: {
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    score: number | null;
    basis: 'contract' | 'schedule' | null;
  };
  requests: { open: number; overdue: number };
  leads: { onFloor: number; total: number };
  /** Live alert this minute: a wave under way is short. */
  alert: string | null;
  /** Today by hour (the store's day): assigned, unfilled, contracted — the store's
   *  own coverage curve, summable across a region. */
  hours: Array<{ hour: number; scheduled: number; open: number; target: number | null }>;
  /** 4 completed weeks + this one: delivered vs contracted (or showed-up). */
  weeks: Array<{ start: string; reliabilityPct: number | null; current: boolean }>;
}

export async function storeSnapshot(
  location: { id: string; name: string; timezone: string; clientId: string; clientName: string },
  now: Date,
  prisma: PrismaClient = defaultPrisma,
): Promise<StoreSnapshot> {
  const scope: PortalScope = {
    clientId: location.clientId,
    locationId: location.id,
    client: { id: location.clientId, name: location.clientName },
    location: {
      id: location.id,
      name: location.name,
      timezone: location.timezone,
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: null,
      zip: null,
    },
  };
  // Days and weeks on the store's own clock.
  const cal = storeCalendar(location.timezone);
  const todayKey = cal.key(now);
  const todayStart = cal.midnight(todayKey);
  const tomorrowStart = cal.midnight(nextKey(todayKey, 1));
  const dayAfterStart = cal.midnight(nextKey(todayKey, 2));
  const weekStart = cal.weekStart(now);
  const thisWeekKey = cal.key(weekStart);
  const trendStart = cal.midnight(nextKey(thisWeekKey, -4 * 7));
  const shifts = shiftScope(scope);

  const [onFloor, todayShifts, tomorrowShifts, trendShifts, target, targets, punches, requests, leads] =
    await Promise.all([
      prisma.timeEntry.findMany({
        where: { ...entryScope(scope), status: 'ACTIVE' },
        select: { associateId: true },
        take: 500,
      }),
      prisma.shift.findMany({
        where: { ...shifts, startsAt: { lt: tomorrowStart }, endsAt: { gt: todayStart } },
        select: { id: true, status: true, startsAt: true, endsAt: true, assignedAssociateId: true },
        take: 500,
      }),
      prisma.shift.findMany({
        where: { ...shifts, startsAt: { gte: tomorrowStart, lt: dayAfterStart } },
        select: { status: true, acknowledgedAt: true },
        take: 500,
      }),
      prisma.shift.findMany({
        where: { ...shifts, startsAt: { gte: trendStart, lt: tomorrowStart } },
        select: { id: true, locationId: true, startsAt: true, endsAt: true, status: true, assignedAssociateId: true },
        take: 5000,
      }),
      currentTarget(scope, now),
      loadTargets(scope, now),
      loadPunches(scope, trendStart, now, now),
      prisma.clientRequest.findMany({
        // This store's requests, plus client-wide ones raised by the market.
        where: { clientId: location.clientId, status: { not: 'RESOLVED' }, OR: [{ locationId: location.id }, { locationId: null }] },
        select: { dueAt: true },
        take: 200,
      }),
      prisma.user.findMany({
        where: {
          clientId: location.clientId,
          status: 'ACTIVE',
          deletedAt: null,
          role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] },
        },
        select: { associateId: true },
        take: 50,
      }),
    ]);

  const onFloorIds = new Set(onFloor.map((e) => e.associateId));
  const nowMs = now.getTime();
  const liveWaves = todayShifts.filter((s) => s.startsAt.getTime() <= nowMs && s.endsAt.getTime() > nowMs);
  const expectedNow = liveWaves.filter((s) => s.status !== 'OPEN').length;
  const presentNow = liveWaves.filter((s) => s.assignedAssociateId && onFloorIds.has(s.assignedAssociateId)).length;
  const openNow = liveWaves.filter((s) => s.status === 'OPEN').length;
  // Short of the SCHEDULE: scheduled into a wave under way (or its open slots) and not on the floor.
  const missingFromSchedule = Math.max(0, expectedNow + openNow - presentNow);
  const graceMs = 15 * 60_000;
  const lateNotIn = liveWaves.filter(
    (s) =>
      s.status !== 'OPEN' &&
      s.startsAt.getTime() <= nowMs - graceMs &&
      !(s.assignedAssociateId && onFloorIds.has(s.assignedAssociateId)),
  ).length;
  const shortPastGrace =
    liveWaves.some((s) => s.startsAt.getTime() <= nowMs - graceMs) && missingFromSchedule > 0;

  // The 4-week grade on the same instruments as the store's own page.
  const ncns = new Set(
    (
      await prisma.attendanceEvent.findMany({
        where: { ...attendanceWhere(scope, trendStart, trendShifts.map((s) => s.id)), kind: 'NO_CALL_NO_SHOW' },
        select: { shiftId: true },
        take: 2000,
      })
    ).map((e) => e.shiftId),
  );
  const hours = coverageByHours({
    locations: targets,
    storeScoped: true,
    from: trendStart,
    to: tomorrowStart,
    now,
    shifts: trendShifts,
    entries: punches.entries,
  });
  const completedTrend = trendShifts.filter((s) => s.startsAt.getTime() < weekStart.getTime());
  const completedHours = hours.filter((h) => h.instant.getTime() < weekStart.getTime());
  const ended = completedTrend.filter((s) => s.endsAt.getTime() <= nowMs);
  const showed = ended.filter((s) => s.status !== 'OPEN' && !ncns.has(s.id) && punches.punched(s)).length;
  const graded = gradeWeeks([
    {
      contracted: completedHours.reduce((a, h) => a + h.target, 0),
      delivered: completedHours.reduce((a, h) => a + h.delivered, 0),
      ended: ended.length,
      showed,
    },
  ]);
  // Week by week (4 completed + this one), on the same basis.
  const weekKeys: string[] = [];
  for (let i = 4; i >= 0; i--) weekKeys.push(nextKey(thisWeekKey, -7 * i));
  const weekOf = (d: Date) => cal.key(cal.weekStart(d));
  const weeks = weekKeys.map((k) => {
    const hs = hours.filter((h) => weekOf(h.instant) === k);
    const ws = trendShifts.filter((s) => weekOf(s.startsAt) === k && s.endsAt.getTime() <= nowMs);
    const contracted = hs.reduce((a, h) => a + h.target, 0);
    const delivered = hs.reduce((a, h) => a + h.delivered, 0);
    const showedW = ws.filter((s) => s.status !== 'OPEN' && !ncns.has(s.id) && punches.punched(s)).length;
    const g = gradeWeeks([{ contracted, delivered, ended: ws.length, showed: showedW }]);
    return { start: k, reliabilityPct: g.score, current: k === thisWeekKey };
  });
  // Today by hour in the store's own zone: assigned, unfilled, contracted.
  const tz = location.timezone;
  const dayLoc = targets[0] ?? null;
  const hourRows = Array.from({ length: 24 }, (_, h) => {
    const at = new Date(todayStart.getTime() + h * HOUR);
    const covering = todayShifts.filter((s) => s.startsAt.getTime() <= at.getTime() && s.endsAt.getTime() > at.getTime());
    const t = dayLoc ? targetAtMinute(dayLoc, zonedMinutes(at, tz)) : null;
    return {
      hour: h,
      scheduled: covering.filter((s) => s.status !== 'OPEN').length,
      open: covering.filter((s) => s.status === 'OPEN').length,
      target: t ? t.target : null,
    };
  });

  const todayEnded = todayShifts.filter((s) => s.endsAt.getTime() <= nowMs && s.status !== 'OPEN');
  const missedSoFar = todayEnded.filter(
    (s) => !(s.assignedAssociateId && onFloorIds.has(s.assignedAssociateId)) && !punches.punched(s),
  ).length;

  return {
    id: location.id,
    name: location.name,
    clientId: location.clientId,
    clientName: location.clientName,
    timezone: location.timezone,
    now: {
      onFloor: onFloor.length,
      target: target.target,
      targetLabel: target.label,
      // Short of the CONTRACT: its people for this window minus who is on the floor.
      ...(() => {
        const shortOfContract = target.target !== null ? Math.max(0, target.target - onFloor.length) : null;
        return {
          short: shortOfContract ?? missingFromSchedule,
          shortBasis: shortOfContract !== null ? ('contract' as const) : ('schedule' as const),
          shortOfContract,
          missingFromSchedule,
          lateNotIn,
        };
      })(),
    },
    // Today's shifts start today on the store's clock — the store page's and
    // the Schedule's count; last night's overnight still finishing is last night's (LEAD-3).
    today: {
      expected: todayShifts.filter((s) => s.status !== 'OPEN' && cal.key(s.startsAt) === todayKey).length,
      present: presentNow,
      open: todayShifts.filter((s) => s.status === 'OPEN' && cal.key(s.startsAt) === todayKey).length,
      missedSoFar,
    },
    tomorrow: {
      expected: tomorrowShifts.filter((s) => s.status !== 'OPEN').length,
      open: tomorrowShifts.filter((s) => s.status === 'OPEN').length,
      unconfirmed: tomorrowShifts.filter((s) => s.status === 'ASSIGNED' && !s.acknowledgedAt).length,
    },
    reliability: { grade: graded.grade, score: graded.score, basis: graded.basis },
    requests: {
      open: requests.length,
      overdue: requests.filter((r) => r.dueAt && r.dueAt.getTime() < nowMs).length,
    },
    leads: {
      onFloor: leads.filter((l) => l.associateId && onFloorIds.has(l.associateId)).length,
      total: leads.length,
    },
    alert: shortPastGrace ? `${missingFromSchedule} scheduled ${missingFromSchedule === 1 ? 'person is' : 'people are'} not on the floor` : null,
    hours: hourRows,
    weeks,
  };
}
