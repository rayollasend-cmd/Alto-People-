import type { PrismaClient } from '@prisma/client';
import type {
  ControlRoomAgent,
  ControlRoomException,
  ControlRoomPerson,
  ControlRoomResponse,
  ControlRoomRobot,
  ControlRoomSiteOption,
  ControlRoomWaiting,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { listAgents, listApprovals } from './agents.js';
import { listRobots, listZones } from './robots.js';
import { listTasks, policyFor } from './tasks/engine.js';
import { crewLeadsOnFloor, spanOfControl } from './tasks/spanOfControl.js';
import { moduleOn } from './tenantProfile.js';
import { companyWorkweek } from './timeAnomalies.js';
import { formatDateTimeInZone } from './timezone.js';

/**
 * Brief 3-3 — the control room's one read: every worker on shift at a site
 * right now (person, agent, robot), the exceptions, what waits for a
 * person, the safety zones and the span of control. Composed from the
 * records that own each fact (shifts and punches, the robot registry, the
 * task engine, the agent registry) so the page shows what those pages
 * show, fifteen seconds at a time.
 */

type Db = PrismaClient;

const LATE_GRACE_MS = 15 * 60_000;
const UNCONFIRMED_HORIZON_MS = 2 * 3_600_000;
const NO_SHOW_LOOKBACK_MS = 24 * 3_600_000;

export async function controlRoomSites(db: Db, tenantId: string | null, scope: { clientId?: string | null; locationId?: string | null } = {}): Promise<ControlRoomSiteOption[]> {
  const sites = await db.site.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      isActive: true,
      deletedAt: null,
      ...(scope.locationId ? { id: scope.locationId } : scope.clientId ? { clientId: scope.clientId } : {}),
    },
    select: { id: true, name: true, timezone: true, client: { select: { name: true } } },
    orderBy: { name: 'asc' },
    take: 500,
  });
  // Who is on an assigned shift at each site right now, so the page can open
  // on the busiest floor instead of the alphabetically first (F500 G2).
  const now = new Date();
  const onShift = sites.length
    ? await db.shift.groupBy({
        by: ['locationId'],
        where: {
          ...(tenantId ? { tenantId } : {}),
          locationId: { in: sites.map((s) => s.id) },
          status: 'ASSIGNED',
          assignedAssociateId: { not: null },
          startsAt: { lte: now },
          endsAt: { gt: now },
        },
        _count: { _all: true },
      })
    : [];
  const counts = new Map(onShift.map((g) => [g.locationId, g._count._all]));
  return sites.map((s) => ({
    id: s.id,
    name: s.name,
    timezone: s.timezone,
    clientName: s.client?.name ?? null,
    onShiftNow: counts.get(s.id) ?? 0,
  }));
}

export async function controlRoom(db: Db = defaultPrisma, locationId: string, tenantId: string | null, now: Date = new Date()): Promise<ControlRoomResponse> {
  const site = await db.site.findFirst({
    where: { id: locationId, ...(tenantId ? { tenantId } : {}), deletedAt: null },
    select: { id: true, name: true, timezone: true, client: { select: { name: true } } },
  });
  if (!site) throw new HttpError(404, 'site_not_found', 'No such site.');
  const roboticsOn = tenantId ? await moduleOn('robotics', tenantId) : await moduleOn('robotics');

  const nowMs = now.getTime();
  const [shiftsNow, entries, upcoming, ended, policy, leads, zones] = await Promise.all([
    db.shift.findMany({
      where: { locationId, status: 'ASSIGNED', startsAt: { lte: now }, endsAt: { gt: now } },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        position: true,
        assignedAssociateId: true,
        workerId: true,
        worker: { select: { id: true, type: true, name: true } },
        assignedAssociate: { select: { id: true, firstName: true, lastName: true } },
      },
      take: 500,
    }),
    db.timeEntry.findMany({ where: { locationId, status: 'ACTIVE' }, select: { associateId: true, clockInAt: true }, take: 500 }),
    db.shift.findMany({
      where: { locationId, status: 'ASSIGNED', acknowledgedAt: null, assignedAssociateId: { not: null }, startsAt: { gt: now, lte: new Date(nowMs + UNCONFIRMED_HORIZON_MS) } },
      select: { id: true, startsAt: true, position: true, assignedAssociate: { select: { firstName: true, lastName: true } } },
      take: 100,
    }),
    db.shift.findMany({
      where: { locationId, status: { in: ['ASSIGNED', 'COMPLETED'] }, assignedAssociateId: { not: null }, endsAt: { gt: new Date(nowMs - NO_SHOW_LOOKBACK_MS), lte: now } },
      select: { id: true, startsAt: true, endsAt: true, position: true, assignedAssociateId: true, assignedAssociate: { select: { firstName: true, lastName: true } } },
      take: 300,
    }),
    policyFor(db, locationId),
    crewLeadsOnFloor(db, locationId, now),
    listZones(db, locationId, tenantId),
  ]);

  // People: one row per person on an assigned shift now, with their punch.
  const clockIn = new Map(entries.map((e) => [e.associateId, e.clockInAt]));
  const leadIds = new Set(leads.map((l) => l.associateId));
  const peopleShifts = shiftsNow.filter((s) => s.assignedAssociateId && (!s.worker || s.worker.type === 'PERSON'));
  const personWorkers = peopleShifts.length
    ? await db.worker.findMany({ where: { associateId: { in: peopleShifts.map((s) => s.assignedAssociateId!) } }, select: { id: true, associateId: true } })
    : [];
  const workerByAssociate = new Map(personWorkers.map((w) => [w.associateId, w.id]));
  const seen = new Set<string>();
  const people: ControlRoomPerson[] = [];
  for (const s of peopleShifts) {
    const id = s.assignedAssociateId!;
    if (seen.has(id)) continue;
    seen.add(id);
    const punched = clockIn.get(id) ?? null;
    people.push({
      associateId: id,
      workerId: workerByAssociate.get(id) ?? null,
      name: s.assignedAssociate ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}`.trim() : 'Associate',
      position: s.position,
      shiftId: s.id,
      shiftStart: s.startsAt.toISOString(),
      shiftEnd: s.endsAt.toISOString(),
      clockedIn: punched !== null,
      clockInAt: punched ? punched.toISOString() : null,
      late: punched === null && s.startsAt.getTime() <= nowMs - LATE_GRACE_MS,
      crewLead: leadIds.has(id),
    });
  }
  people.sort((a, b) => Number(b.crewLead) - Number(a.crewLead) || a.name.localeCompare(b.name));

  // Robots: placed here, or on a shift here now.
  const robotShifts = new Map(shiftsNow.filter((s) => s.worker?.type === 'ROBOT' && s.workerId).map((s) => [s.workerId!, s]));
  const robots: ControlRoomRobot[] = [];
  if (roboticsOn) {
    const registry = await listRobots(db, tenantId, now);
    for (const r of registry.robots) {
      if (r.status === 'OFFBOARDED') continue;
      const shift = robotShifts.get(r.id);
      if (r.site?.id !== locationId && !shift) continue;
      robots.push({
        id: r.id,
        name: r.name,
        status: r.status,
        fleetStatus: r.latest?.status ?? null,
        batteryPct: r.latest?.batteryPct ?? null,
        currentTask: r.latest?.currentTask ?? null,
        x: r.latest?.x ?? null,
        y: r.latest?.y ?? null,
        readAt: r.latest?.at ?? null,
        onShift: !!shift,
        shift: shift ? { id: shift.id, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(), position: shift.position } : null,
        checklistReady: r.checklistReady,
        commissioned: r.commissioned,
        openIncidents: r.openIncidents,
      });
    }
  }

  // Agents: this organization's, with the switch.
  const registry = await listAgents(db, now, tenantId);
  const agents: ControlRoomAgent[] = registry.agents
    .filter((a) => a.status !== 'OFFBOARDED')
    .map((a) => ({
      id: a.id,
      name: a.name,
      family: a.profile.family ?? null,
      capability: a.profile.capability ?? null,
      status: a.status,
      lastActiveAt: a.profile.lastActiveAt ?? null,
      pendingApprovals: a.pendingApprovals,
    }));
  const agentsSuspended = !!registry.control?.allSuspendedAt;

  // Tasks around now: exceptions and the queue for a person.
  const tasks = await listTasks(db, { locationId, from: new Date(nowMs - 12 * 3_600_000), to: new Date(nowMs + 12 * 3_600_000) });
  const exceptions: ControlRoomException[] = [];
  const waiting: ControlRoomWaiting[] = [];
  for (const t of tasks) {
    if (t.status === 'STALLED' || t.status === 'FAILED' || t.status === 'HANDED_OFF') {
      exceptions.push({
        kind: t.status === 'STALLED' ? 'TASK_STALLED' : t.status === 'FAILED' ? 'TASK_FAILED' : 'TASK_HANDED_OFF',
        id: `task:${t.id}`,
        taskId: t.id,
        title: `${t.type}${t.area ? ` · ${t.area}` : ''}`,
        detail: t.assignment ? `${t.status === 'HANDED_OFF' ? 'Handed to' : 'Held by'} ${t.assignment.workerName}` : 'No one holds it',
        at: t.updatedAt,
        link: `/tasks?task=${t.id}`,
      });
    } else if (t.status === 'QUEUED') {
      waiting.push({ kind: 'TASK_QUEUED', id: `task:${t.id}`, title: `${t.type}${t.area ? ` · ${t.area}` : ''}`, detail: t.queuedReason ?? 'Waiting for a person to assign it', at: t.updatedAt, link: `/tasks?task=${t.id}` });
    }
  }
  for (const r of robots) {
    if (r.status === 'SUSPENDED') exceptions.push({ kind: 'ROBOT_STOPPED', id: `robot:${r.id}:stopped`, robotId: r.id, title: r.name, detail: 'Under an emergency stop', at: r.readAt, link: `/robots/${r.id}` });
    else if (r.fleetStatus === 'ERROR') exceptions.push({ kind: 'ROBOT_ERROR', id: `robot:${r.id}:error`, robotId: r.id, title: r.name, detail: 'The fleet reports an error', at: r.readAt, link: `/robots/${r.id}` });
    else if (r.fleetStatus === 'OFFLINE' && r.onShift) exceptions.push({ kind: 'ROBOT_OFFLINE', id: `robot:${r.id}:offline`, robotId: r.id, title: r.name, detail: 'Offline during its shift', at: r.readAt, link: `/robots/${r.id}` });
  }
  for (const s of upcoming) {
    exceptions.push({
      kind: 'UNCONFIRMED_SHIFT',
      id: `shift:${s.id}`,
      title: s.assignedAssociate ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}`.trim() : 'Associate',
      detail: `${s.position} starts ${Math.max(1, Math.round((s.startsAt.getTime() - nowMs) / 60_000))} min from now, not confirmed`,
      at: s.startsAt.toISOString(),
      link: `/approvals?tab=unconfirmed`,
    });
  }
  if (ended.length) {
    const punches = await db.timeEntry.findMany({
      where: { locationId, associateId: { in: [...new Set(ended.map((s) => s.assignedAssociateId!))] }, clockInAt: { gte: new Date(nowMs - NO_SHOW_LOOKBACK_MS - 3_600_000) } },
      select: { associateId: true, clockInAt: true },
      take: 1000,
    });
    for (const s of ended) {
      const showed = punches.some((p) => p.associateId === s.assignedAssociateId && p.clockInAt.getTime() >= s.startsAt.getTime() - 3_600_000 && p.clockInAt.getTime() < s.endsAt.getTime());
      if (!showed) {
        exceptions.push({
          kind: 'NO_SHOW',
          id: `noshow:${s.id}`,
          title: s.assignedAssociate ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}`.trim() : 'Associate',
          detail: `${s.position}: no punch for the shift that ended`,
          at: s.endsAt.toISOString(),
          link: `/time-attendance`,
        });
      }
    }
  }
  if (robots.some((r) => r.onShift)) {
    for (const z of zones) {
      if (z.guestOccupied && !z.robotsAllowedWhenOccupied) exceptions.push({ kind: 'ZONE_OCCUPIED', id: `zone:${z.id}`, title: z.name, detail: 'Occupied by guests: robots keep out', at: z.occupiedSince, link: `/robots/sites/${locationId}/zones` });
    }
  }
  // What an agent proposes for THIS site: the requests whose shift is here, or that name the site itself.
  const approvals = await listApprovals(db, { status: 'PENDING', tenantId }, 200);
  const shiftIds = approvals.map((a) => a.payload.subjectId).filter((v): v is string => typeof v === 'string');
  const shiftsHere = new Set(
    shiftIds.length ? (await db.shift.findMany({ where: { id: { in: shiftIds }, locationId }, select: { id: true } })).map((s) => s.id) : [],
  );
  const siteTz = site.timezone ?? companyWorkweek().timezone;
  for (const a of approvals) {
    const subjectId = typeof a.payload.subjectId === 'string' ? a.payload.subjectId : null;
    const here = (subjectId && shiftsHere.has(subjectId)) || a.evidence.affects.some((x) => x.kind === 'site' && x.id === locationId);
    if (!here) continue;
    waiting.push({
      kind: 'AGENT_APPROVAL',
      id: `approval:${a.id}`,
      title: `${a.agentName} asks: ${a.summary}`,
      detail: `Expires ${formatDateTimeInZone(new Date(a.expiresAt), siteTz)}`,
      at: a.requestedAt,
      link: `/approvals?tab=proposals&proposal=${a.id}`,
    });
  }
  exceptions.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  waiting.sort((a, b) => a.at.localeCompare(b.at));

  const robotsOnShift = robots.filter((r) => r.onShift).length;
  const span = spanOfControl(robotsOnShift, leads.length, policy.maxRobotsPerCrewLead);

  return {
    site: { id: site.id, name: site.name, timezone: site.timezone, clientName: site.client?.name ?? null },
    asOf: now.toISOString(),
    strip: {
      onFloor: people.filter((p) => p.clockedIn).length,
      expectedNow: people.length,
      robotsRunning: robots.filter((r) => r.fleetStatus === 'WORKING').length,
      robotsOnShift,
      exceptions: exceptions.length,
      waiting: waiting.length,
    },
    people,
    robots,
    agents,
    exceptions,
    waiting,
    zones,
    span,
    agentsSuspended,
    roboticsOn,
  };
}
