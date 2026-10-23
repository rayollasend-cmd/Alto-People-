import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { paidMinutesForRange } from '@alto-people/shared';
import { pendingTimeWhere } from './pendingTime.js';
import { scopeShifts, scopeTimeEntries } from './scope.js';
import { tenantIdForWrite } from './tenant.js';
import {
  endOfWeekUTC,
  netWorkedMinutes,
  orgDateKey,
  startOfWeekUTC,
  utcInstantOfLocalMidnight,
  companyWorkweek,
} from './timeAnomalies.js';
import { profilePhotoUrlFor } from './profilePhotoUrl.js';

/**
 * The exceptions a time manager acts on, counted from the punches and the
 * schedule we hold (Time & attendance's KPI strip — F500 G2):
 *
 *   missed punches  finished punches waiting for review (the one pending
 *                   predicate the Pending review tile counts) that the
 *                   clock-out sweep flagged FORGOT_CLOCKOUT;
 *   late today      punches that started in the caller's "today" more than
 *                   LATE_GRACE_MINUTES after their linked shift began — the
 *                   queue's Late chip, counted (rejected punches aside);
 *   overtime risk   people whose worked time this workweek plus the rest of
 *                   their assigned shifts reaches OT_RISK_MINUTES (36h) —
 *                   the four hours before the 40-hour line, while a
 *                   schedule change can still keep them under it.
 *
 * Every read is the caller's reach (scopeTimeEntries / scopeShifts) and the
 * page's client/site filter, AND-ed — never spread — so a filter can't
 * replace the scope.
 */

type SessionUser = NonNullable<Request['user']>;

export const LATE_GRACE_MINUTES = 5;
export const OT_RISK_MINUTES = 36 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TimeExceptionsInput {
  clientId?: string;
  locationId?: string;
  /** The reader's "today" as instants [from, to). Default: the org zone's day. */
  dayFrom?: Date;
  dayTo?: Date;
  now?: Date;
}

export interface OvertimeRiskPerson {
  associateId: string;
  name: string;
  photoUrl: string | null;
  workedMinutes: number;
  scheduledMinutes: number;
  projectedMinutes: number;
}

export interface TimeExceptions {
  missedPunches: { count: number; oldestAt: string | null };
  lateToday: { count: number; dayFrom: string; dayTo: string };
  overtimeRisk: {
    count: number;
    thresholdHours: number;
    weekStart: string;
    weekEnd: string;
    people: OvertimeRiskPerson[];
  };
}

export async function timeExceptions(
  prisma: PrismaClient,
  user: SessionUser,
  input: TimeExceptionsInput = {},
): Promise<TimeExceptions> {
  const now = input.now ?? new Date();
  const tenantId = tenantIdForWrite();
  const entryNarrow: Prisma.TimeEntryWhereInput = {
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
  };
  const shiftNarrow: Prisma.ShiftWhereInput = {
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.locationId ? { locationId: input.locationId } : {}),
  };

  // Missed punches: pending review AND flagged FORGOT_CLOCKOUT.
  const missedWhere: Prisma.TimeEntryWhereInput = {
    AND: [
      pendingTimeWhere(user),
      entryNarrow,
      { tenantId },
      { anomalies: { array_contains: ['FORGOT_CLOCKOUT'] } },
    ],
  };

  // Late today.
  const tz = companyWorkweek().timezone;
  const dayFrom = input.dayFrom ?? utcInstantOfLocalMidnight(orgDateKey(now), tz);
  const dayTo = input.dayTo ?? new Date(dayFrom.getTime() + DAY_MS);
  const lateWhere: Prisma.TimeEntryWhereInput = {
    AND: [
      scopeTimeEntries(user),
      entryNarrow,
      { tenantId },
      { status: { not: 'REJECTED' } },
      { shiftId: { not: null } },
      { clockInAt: { gte: dayFrom, lt: dayTo } },
    ],
  };

  // Overtime risk: this org workweek.
  const weekStart = startOfWeekUTC(now);
  const weekEnd = endOfWeekUTC(now);
  const weekEntriesWhere: Prisma.TimeEntryWhereInput = {
    AND: [
      scopeTimeEntries(user),
      entryNarrow,
      { tenantId },
      { status: { in: ['APPROVED', 'COMPLETED', 'ACTIVE'] } },
      { clockInAt: { gte: weekStart, lt: weekEnd } },
    ],
  };
  const remainingShiftsWhere: Prisma.ShiftWhereInput = {
    AND: [
      scopeShifts(user),
      shiftNarrow,
      { tenantId },
      { status: 'ASSIGNED' },
      { assignedAssociateId: { not: null } },
      { endsAt: { gt: now } },
      { startsAt: { lt: weekEnd } },
    ],
  };

  const PERSON = { select: { id: true, firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true } } as const;
  const [missedCount, missedOldest, lateRows, weekEntries, remainingShifts] = await Promise.all([
    prisma.timeEntry.count({ where: missedWhere }),
    prisma.timeEntry.findFirst({ where: missedWhere, orderBy: { clockInAt: 'asc' }, select: { clockInAt: true } }),
    prisma.timeEntry.findMany({
      where: lateWhere,
      select: { clockInAt: true, shift: { select: { startsAt: true } } },
      take: 5000,
    }),
    prisma.timeEntry.findMany({
      where: weekEntriesWhere,
      select: {
        associateId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { type: true, startedAt: true, endedAt: true } },
        associate: PERSON,
      },
      take: 20_000,
    }),
    prisma.shift.findMany({
      where: remainingShiftsWhere,
      select: { assignedAssociateId: true, startsAt: true, endsAt: true, assignedAssociate: PERSON },
      take: 20_000,
    }),
  ]);

  const lateCount = lateRows.filter((r) => {
    if (!r.shift) return false;
    const lateMin = Math.floor((r.clockInAt.getTime() - r.shift.startsAt.getTime()) / 60_000);
    return lateMin > LATE_GRACE_MINUTES;
  }).length;

  type Person = { id: string; firstName: string; lastName: string; photoS3Key: string | null; photoUpdatedAt: Date | null };
  const tally = new Map<string, { person: Person; worked: number; scheduled: number }>();
  const slot = (p: Person) => {
    let t = tally.get(p.id);
    if (!t) {
      t = { person: p, worked: 0, scheduled: 0 };
      tally.set(p.id, t);
    }
    return t;
  };
  for (const e of weekEntries) {
    // A running punch counts to now (netWorkedMinutes' own rule).
    slot(e.associate).worked += netWorkedMinutes({ clockInAt: e.clockInAt, clockOutAt: e.clockOutAt }, e.breaks);
  }
  for (const s of remainingShifts) {
    if (!s.assignedAssociate) continue;
    // The rest of the schedule: a future shift in full, an in-progress one
    // from now (the walked part is in worked time) — paid minutes, so the
    // unpaid meal hour never pushes anyone over.
    const from = s.startsAt > now ? s.startsAt : now;
    slot(s.assignedAssociate).scheduled += paidMinutesForRange(from, s.endsAt);
  }
  const people: OvertimeRiskPerson[] = [...tally.values()]
    .map(({ person, worked, scheduled }) => ({
      associateId: person.id,
      name: `${person.firstName} ${person.lastName}`.trim(),
      photoUrl: profilePhotoUrlFor(person),
      workedMinutes: worked,
      scheduledMinutes: scheduled,
      projectedMinutes: worked + scheduled,
    }))
    .filter((p) => p.projectedMinutes >= OT_RISK_MINUTES)
    .sort((a, b) => b.projectedMinutes - a.projectedMinutes || a.name.localeCompare(b.name));

  return {
    missedPunches: { count: missedCount, oldestAt: missedOldest?.clockInAt.toISOString() ?? null },
    lateToday: { count: lateCount, dayFrom: dayFrom.toISOString(), dayTo: dayTo.toISOString() },
    overtimeRisk: {
      count: people.length,
      thresholdHours: OT_RISK_MINUTES / 60,
      weekStart: orgDateKey(weekStart),
      weekEnd: orgDateKey(new Date(weekEnd.getTime() - 1)),
      people,
    },
  };
}
