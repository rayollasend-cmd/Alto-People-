import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { orgDateKey, startOfWeekUTC, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import {
  DAY,
  ORG_TZ,
  attendanceWhere,
  coverageByHours,
  currentTarget,
  entryScope,
  gradeWeeks,
  loadPunches,
  loadTargets,
  nextKey,
  shiftScope,
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
  now: { onFloor: number; target: number | null; targetLabel: string | null; short: number };
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
  const todayKey = orgDateKey(now);
  const todayStart = utcInstantOfLocalMidnight(todayKey, ORG_TZ);
  const tomorrowStart = utcInstantOfLocalMidnight(nextKey(todayKey, 1), ORG_TZ);
  const dayAfterStart = utcInstantOfLocalMidnight(nextKey(todayKey, 2), ORG_TZ);
  const weekStart = startOfWeekUTC(now);
  const trendStart = new Date(weekStart.getTime() - 4 * 7 * DAY);
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
        where: { ...shifts, startsAt: { gte: trendStart, lt: weekStart } },
        select: { id: true, locationId: true, startsAt: true, endsAt: true, status: true, assignedAssociateId: true },
        take: 5000,
      }),
      currentTarget(scope, now),
      loadTargets(scope, now),
      loadPunches(scope, trendStart, now, now),
      prisma.clientRequest.findMany({
        where: { clientId: location.clientId, status: { not: 'RESOLVED' } },
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
  const shortNow = Math.max(0, expectedNow + openNow - presentNow);
  const graceMs = 15 * 60_000;
  const shortPastGrace =
    liveWaves.some((s) => s.startsAt.getTime() <= nowMs - graceMs) && shortNow > 0;

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
    to: weekStart,
    now,
    shifts: trendShifts,
    entries: punches.entries,
  });
  const ended = trendShifts.filter((s) => s.endsAt.getTime() <= nowMs);
  const showed = ended.filter((s) => s.status !== 'OPEN' && !ncns.has(s.id) && punches.punched(s)).length;
  const graded = gradeWeeks([
    {
      contracted: hours.reduce((a, h) => a + h.target, 0),
      delivered: hours.reduce((a, h) => a + h.delivered, 0),
      ended: ended.length,
      showed,
    },
  ]);

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
    now: { onFloor: onFloor.length, target: target.target, targetLabel: target.label, short: shortNow },
    today: {
      expected: todayShifts.filter((s) => s.status !== 'OPEN').length,
      present: presentNow,
      open: todayShifts.filter((s) => s.status === 'OPEN').length,
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
    alert: shortPastGrace ? `${shortNow} short on the floor right now` : null,
  };
}
