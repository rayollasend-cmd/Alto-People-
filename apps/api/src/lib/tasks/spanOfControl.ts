import type { Prisma, PrismaClient } from '@prisma/client';
import type { SpanOfControl } from '@alto-people/shared';

/**
 * Brief 3-3: span of control. A crew lead can watch only so many robots at
 * once; the policy says how many (WorkTaskPolicy.maxRobotsPerCrewLead). The
 * control room shows the ratio and the scheduler warns when a robot shift
 * would exceed it — a warning, never a block: the floor decides.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Roles that count as a crew lead on the floor. */
const LEAD_ROLES = new Set(['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'WORKFORCE_MANAGER', 'OPS_MANAGER']);

export function spanOfControl(robotsOnShift: number, crewLeadsOnShift: number, maxRobotsPerCrewLead: number): SpanOfControl {
  const max = Math.max(1, Math.floor(maxRobotsPerCrewLead));
  const allowed = crewLeadsOnShift * max;
  const exceeded = robotsOnShift > allowed;
  const text =
    robotsOnShift === 0
      ? 'No robots on shift.'
      : crewLeadsOnShift === 0
        ? `${robotsOnShift} robot${robotsOnShift === 1 ? '' : 's'} on shift with no crew lead on the floor.`
        : exceeded
          ? `${robotsOnShift} robots for ${crewLeadsOnShift} crew lead${crewLeadsOnShift === 1 ? '' : 's'}: ${robotsOnShift - allowed} over the ${max}-per-lead limit.`
          : `${robotsOnShift} robot${robotsOnShift === 1 ? '' : 's'} for ${crewLeadsOnShift} crew lead${crewLeadsOnShift === 1 ? '' : 's'} (${max} per lead allowed).`;
  return { robots: robotsOnShift, leads: crewLeadsOnShift, maxPerLead: max, allowed, exceeded, text };
}

/** Robots with an assigned shift at the site covering `now` (or the window given). */
export async function robotsOnShiftAt(db: Db, locationId: string, from: Date, to: Date = from): Promise<Array<{ workerId: string; shiftId: string; name: string }>> {
  const shifts = await db.shift.findMany({
    where: { locationId, status: { in: ['ASSIGNED', 'DRAFT'] }, startsAt: { lte: to }, endsAt: { gt: from }, worker: { type: 'ROBOT' } },
    select: { id: true, workerId: true, worker: { select: { name: true } } },
    take: 200,
  });
  return shifts.filter((s) => s.workerId).map((s) => ({ workerId: s.workerId!, shiftId: s.id, name: s.worker?.name ?? 'Robot' }));
}

/**
 * Crew leads on the floor now: people clocked in at the site whose account
 * holds a lead role, or whose worker record is certified for supervision.
 */
export async function crewLeadsOnFloor(db: Db, locationId: string, now: Date): Promise<Array<{ associateId: string; name: string }>> {
  const entries = await db.timeEntry.findMany({ where: { locationId, status: 'ACTIVE' }, select: { associateId: true }, take: 500 });
  const ids = [...new Set(entries.map((e) => e.associateId))];
  if (ids.length === 0) return [];
  const [users, workers, associates] = await Promise.all([
    db.user.findMany({ where: { associateId: { in: ids }, status: 'ACTIVE', deletedAt: null }, select: { associateId: true, role: true } }),
    db.worker.findMany({ where: { associateId: { in: ids } }, select: { associateId: true, capabilities: true } }),
    db.associate.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }),
  ]);
  const leadIds = new Set<string>();
  for (const u of users) if (u.associateId && LEAD_ROLES.has(u.role)) leadIds.add(u.associateId);
  for (const w of workers) if (w.associateId && w.capabilities.includes('supervision')) leadIds.add(w.associateId);
  void now;
  return associates.filter((a) => leadIds.has(a.id)).map((a) => ({ associateId: a.id, name: `${a.firstName} ${a.lastName}`.trim() }));
}

/** The span at a site right now, against the policy in force there. */
export async function spanOfControlAt(db: Db, locationId: string, maxRobotsPerCrewLead: number, now: Date = new Date()): Promise<SpanOfControl> {
  const [robots, leads] = await Promise.all([robotsOnShiftAt(db, locationId, now), crewLeadsOnFloor(db, locationId, now)]);
  return spanOfControl(robots.length, leads.length, maxRobotsPerCrewLead);
}
