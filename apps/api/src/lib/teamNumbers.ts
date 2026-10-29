import { ATTENDANCE_OVERTIME_THRESHOLD_HOURS, OVERTIME_RISK_HOURS, isOvertimeRisk } from '@alto-people/shared';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { EMPLOYED_WHERE } from './activeDefinition.js';
import { teamHours } from './attendanceInsights.js';
import { teamScope } from './delegations.js';
import { getLaborPolicy } from './stateLaborPolicy.js';
import { tenantIdForWrite } from './tenant.js';
import { companyWorkweek, dateKeyInZone, endOfWeekUTC, startOfWeekUTC, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { addDaysToKey } from './timezone.js';

/**
 * A line manager's team in numbers (F500 2026-10-22: My team showed only
 * pending counts). One definition per number, each from data we hold:
 *
 *   - On the clock: reports with an open punch right now.
 *   - Scheduled today: reports with a published shift starting today on the
 *     company clock (assigned or already worked).
 *   - Hours this week: worked hours (net of the unpaid meal, as Team hours
 *     counts them) against this week's scheduled hours (the same meal rule
 *     applied to each shift). The company workweek.
 *   - Late or no-show, 7 days: unexcused LATE and NO_CALL_NO_SHOW attendance
 *     events on the last seven company days, today included.
 *   - Overtime risk: reports whose worked hours plus what is still scheduled
 *     this week reach OVERTIME_RISK_HOURS (36, the shared definition —
 *     Time & attendance counts the same rule over everyone it reaches).
 *
 * The team is the caller's reports plus any team they cover (teamScope),
 * employed only — the same people /team/dashboard and /team/reports list.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface TeamPersonNumbers {
  workedHours: number;
  projectedHours: number;
  onClock: boolean;
  lateOrNoShow7d: number;
}

export interface TeamNumbers {
  weekStart: string;
  weekEnd: string;
  onClockNow: number;
  scheduledToday: number;
  hoursWorked: number;
  hoursScheduled: number;
  lateOrNoShow7d: number;
  lateOrNoShowPeople7d: number;
  overtimeRisk: number;
  /** The hours at which a week reads as overtime risk (OVERTIME_RISK_HOURS). */
  overtimeRiskHours: number;
  overtimeThresholdHours: number;
  people: Map<string, TeamPersonNumbers>;
}

/** Scheduled hours of one shift inside [from, to), net of the meal the state's rule (else 30 min at 6 h+) takes. */
function shiftHours(s: { startsAt: Date; endsAt: Date; state: string | null | undefined }, from: number, to: number): number {
  const span = (s.endsAt.getTime() - s.startsAt.getTime()) / HOUR_MS;
  let hours = Math.max(0, (Math.min(s.endsAt.getTime(), to) - Math.max(s.startsAt.getTime(), from)) / HOUR_MS);
  const policy = getLaborPolicy(s.state);
  const mealAfter = policy.mealBreakRequiredAfterHours ?? 6;
  const mealH = (policy.mealBreakRequiredAfterHours !== null ? policy.mealBreakMinMinutes : 30) / 60;
  if (span >= mealAfter) hours = Math.max(0, hours - mealH);
  return hours;
}

/**
 * The company's calendar day around `now` — its key and its [start, end)
 * instants. Every "today" on the manager's pages (My team, the manager's
 * Home) cuts here, never on the UTC day.
 */
export function companyDay(now: Date): { todayKey: string; dayStart: Date; dayEnd: Date } {
  const tz = companyWorkweek().timezone;
  const todayKey = dateKeyInZone(now, tz);
  const tomorrowKey = addDaysToKey(todayKey, 1);
  return { todayKey, dayStart: utcInstantOfLocalMidnight(todayKey, tz), dayEnd: utcInstantOfLocalMidnight(tomorrowKey, tz) };
}

export async function teamNumbers(user: SessionUser, now = new Date()): Promise<TeamNumbers> {
  const tz = companyWorkweek().timezone;
  const weekStart = startOfWeekUTC(now);
  const weekEnd = endOfWeekUTC(now);
  const { dayStart, dayEnd } = companyDay(now);
  const sevenDaysKey = dateKeyInZone(new Date(now.getTime() - 6 * DAY_MS), tz);

  const empty: TeamNumbers = {
    weekStart: dateKeyInZone(weekStart, tz),
    weekEnd: dateKeyInZone(weekEnd, tz),
    onClockNow: 0,
    scheduledToday: 0,
    hoursWorked: 0,
    hoursScheduled: 0,
    lateOrNoShow7d: 0,
    lateOrNoShowPeople7d: 0,
    overtimeRisk: 0,
    overtimeRiskHours: OVERTIME_RISK_HOURS,
    overtimeThresholdHours: ATTENDANCE_OVERTIME_THRESHOLD_HOURS,
    people: new Map(),
  };

  const reports = await prisma.associate.findMany({
    where: { AND: [{ tenantId: tenantIdForWrite() }, await teamScope(user), EMPLOYED_WHERE] },
    select: { id: true },
    take: 1000,
  });
  if (reports.length === 0) return empty;
  const ids = reports.map((r) => r.id);

  const [hours, weekShifts, events] = await Promise.all([
    teamHours(user, now),
    prisma.shift.findMany({
      where: {
        tenantId: tenantIdForWrite(),
        assignedAssociateId: { in: ids },
        status: { in: ['ASSIGNED', 'COMPLETED'] },
        publishedAt: { not: null },
        startsAt: { lt: weekEnd },
        endsAt: { gt: weekStart },
      },
      select: { assignedAssociateId: true, startsAt: true, endsAt: true, locationRel: { select: { state: true } } },
      take: 10_000,
    }),
    prisma.attendanceEvent.findMany({
      where: {
        tenantId: tenantIdForWrite(),
        associateId: { in: ids },
        kind: { in: ['LATE', 'NO_CALL_NO_SHOW'] },
        excusedAt: null,
        occurredOn: { gte: new Date(`${sevenDaysKey}T00:00:00Z`) },
      },
      select: { associateId: true },
      take: 10_000,
    }),
  ]);

  const people = new Map<string, TeamPersonNumbers>();
  for (const id of ids) people.set(id, { workedHours: 0, projectedHours: 0, onClock: false, lateOrNoShow7d: 0 });
  for (const p of hours.people) {
    const row = people.get(p.associateId);
    if (row) Object.assign(row, { workedHours: p.workedHours, projectedHours: p.projectedHours, onClock: p.onClock });
  }
  for (const e of events) {
    const row = people.get(e.associateId);
    if (row) row.lateOrNoShow7d += 1;
  }

  let scheduled = 0;
  const scheduledTodayIds = new Set<string>();
  for (const s of weekShifts) {
    scheduled += shiftHours({ startsAt: s.startsAt, endsAt: s.endsAt, state: s.locationRel?.state }, weekStart.getTime(), weekEnd.getTime());
    if (s.startsAt >= dayStart && s.startsAt < dayEnd) scheduledTodayIds.add(s.assignedAssociateId!);
  }

  const rows = [...people.values()];
  return {
    ...empty,
    onClockNow: rows.filter((r) => r.onClock).length,
    scheduledToday: scheduledTodayIds.size,
    hoursWorked: round1(rows.reduce((sum, r) => sum + r.workedHours, 0)),
    hoursScheduled: round1(scheduled),
    lateOrNoShow7d: events.length,
    lateOrNoShowPeople7d: rows.filter((r) => r.lateOrNoShow7d > 0).length,
    overtimeRisk: rows.filter((r) => isOvertimeRisk(r.projectedHours)).length,
    people,
  };
}

/** The JSON a route sends: the summary without the per-person map. */
export function teamNumbersSummary(n: TeamNumbers): Omit<TeamNumbers, 'people'> {
  const { people: _people, ...summary } = n;
  return summary;
}
