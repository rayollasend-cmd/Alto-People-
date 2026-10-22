import type { Prisma, PrismaClient } from '@prisma/client';
import type { AssignmentReason, RankedCandidate, WorkTaskAssignmentView, WorkTaskDetailView, WorkTaskEventView, WorkTaskPolicyView, WorkTaskSummary, WorkTaskView } from '@alto-people/shared';
import { DEFAULT_WORK_TASK_POLICY, WORKER_CAPABILITIES } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../../db.js';
import { enqueueAudit } from '../audit.js';
import { notifyUser } from '../notify.js';
import { loadRateCards, resolveRate } from '../rateCards.js';
import { tenantIdForWrite } from '../tenant.js';
import { fmtTimeInZone } from './time.js';
import { decideAssignment, decideHandoff, type CandidateInput, type RankingDecision } from './rank.js';
import { robotAvailability } from './robotAvailability.js';

/**
 * Brief 3-2: the assignment engine's database side. It gathers the
 * candidates for a task (people on shift at the site in the window, the
 * tenant's active agents, the site's robots), prices each, hands them to
 * the pure ranker (rank.ts), and writes the decision down with every
 * factor — the assignment's `reasons` and the whole `ranking` — so a
 * supervisor can read why. The handoff sweep (sweep.ts) calls
 * `handOffExceptions` every fifteen seconds per tenant.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const CAP_LABEL = new Map<string, string>(WORKER_CAPABILITIES.map((c) => [c.code, c.label]));
export const capabilityLabel = (code: string) => CAP_LABEL.get(code) ?? code;

const include = {
  location: { select: { id: true, name: true, timezone: true, clientId: true } },
  assignments: { orderBy: { createdAt: 'desc' as const }, include: { worker: { select: { id: true, type: true, name: true } } } },
  events: { orderBy: { at: 'asc' as const } },
} satisfies Prisma.WorkTaskInclude;

type TaskRow = Prisma.WorkTaskGetPayload<{ include: typeof include }>;

const TASK_NOTIFY_CATEGORY = 'tasks.handoff';

// ---------------------------------------------------------------- policy

export async function policyFor(db: Db, locationId: string | null): Promise<WorkTaskPolicyView> {
  const tenantId = tenantIdForWrite();
  const rows = await db.workTaskPolicy.findMany({ where: { tenantId, OR: [{ locationId: null }, ...(locationId ? [{ locationId }] : [])] } });
  const site = locationId ? rows.find((r) => r.locationId === locationId) : undefined;
  const tenant = rows.find((r) => r.locationId === null);
  return mergePolicies(locationId, site ?? null, tenant ?? null);
}

type PolicyRow = Pick<
  Prisma.WorkTaskPolicyGetPayload<Record<string, never>>,
  'handoffSeconds' | 'maxAutoAssignCents' | 'highRiskPolicy' | 'robotCostPerTaskCents' | 'robotDefaultCostCents' | 'agentCostPerTaskCents' | 'maxRobotsPerCrewLead' | 'robotUtilizationPct' | 'backupCrewRatioPct'
>;

/**
 * The policy in force at a site, field by field: the site's own value when it
 * set one, else the company's, else the shared default. A site row used to
 * replace the company row whole, so a site that only set its handoff seconds
 * silently fell back to the schema defaults for cost and cap (audit 2026-10-21).
 * The cap is the one field a null cannot lift: a site inherits the company's.
 */
export function mergePolicies(locationId: string | null, site: PolicyRow | null, tenant: PolicyRow | null): WorkTaskPolicyView {
  const pick = <K extends keyof PolicyRow>(k: K): NonNullable<PolicyRow[K]> | null => {
    const s = site?.[k];
    if (s !== null && s !== undefined) return s as NonNullable<PolicyRow[K]>;
    const t = tenant?.[k];
    if (t !== null && t !== undefined) return t as NonNullable<PolicyRow[K]>;
    return null;
  };
  const d = DEFAULT_WORK_TASK_POLICY;
  return {
    locationId,
    handoffSeconds: pick('handoffSeconds') ?? d.handoffSeconds,
    maxAutoAssignCents: pick('maxAutoAssignCents') ?? d.maxAutoAssignCents,
    highRiskPolicy: pick('highRiskPolicy') ?? d.highRiskPolicy,
    robotCostPerTaskCents: { ...d.robotCostPerTaskCents, ...((tenant?.robotCostPerTaskCents ?? {}) as Record<string, number>), ...((site?.robotCostPerTaskCents ?? {}) as Record<string, number>) },
    robotDefaultCostCents: pick('robotDefaultCostCents') ?? d.robotDefaultCostCents,
    agentCostPerTaskCents: pick('agentCostPerTaskCents') ?? d.agentCostPerTaskCents,
    maxRobotsPerCrewLead: pick('maxRobotsPerCrewLead') ?? d.maxRobotsPerCrewLead,
    robotUtilizationPct: pick('robotUtilizationPct') ?? d.robotUtilizationPct,
    backupCrewRatioPct: pick('backupCrewRatioPct') ?? d.backupCrewRatioPct,
  };
}

// ------------------------------------------------------------ candidates

interface TaskLike {
  id: string;
  locationId: string;
  capability: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  estimatedMinutes: number;
  windowStart: Date;
  windowEnd: Date;
  location: { id: string; name: string; timezone: string; clientId: string | null };
}

/** Everyone the engine may weigh for a task: who is on shift here, which agents and robots are on. */
export async function candidatesFor(db: Db, task: TaskLike, policy: WorkTaskPolicyView, excludeWorkerIds: readonly string[] = []): Promise<CandidateInput[]> {
  const tenantId = tenantIdForWrite();
  const tz = task.location.timezone;

  // People: assigned shifts at this site that overlap the window.
  const shifts = await db.shift.findMany({
    where: {
      tenantId,
      locationId: task.locationId,
      status: { in: ['ASSIGNED', 'COMPLETED'] },
      assignedAssociateId: { not: null },
      startsAt: { lt: task.windowEnd },
      endsAt: { gt: task.windowStart },
    },
    select: { assignedAssociateId: true, position: true, startsAt: true, endsAt: true, payRate: true, clientId: true },
  });
  const associateIds = [...new Set(shifts.map((s) => s.assignedAssociateId!))];
  const people = associateIds.length
    ? await db.worker.findMany({ where: { tenantId, type: 'PERSON', associateId: { in: associateIds }, status: 'ACTIVE' }, select: { id: true, name: true, capabilities: true, associateId: true } })
    : [];
  const cards = await loadRateCards(db, [...new Set(shifts.map((s) => s.clientId))]);

  // Load: active assignments in the same window, per worker.
  const held = await db.workTaskAssignment.groupBy({
    by: ['workerId'],
    where: { tenantId, state: 'ACTIVE', task: { windowStart: { lt: task.windowEnd }, windowEnd: { gt: task.windowStart }, id: { not: task.id } } },
    _count: { _all: true },
  });
  const loadOf = new Map(held.map((h) => [h.workerId, h._count._all]));

  const out: CandidateInput[] = [];
  for (const w of people) {
    if (excludeWorkerIds.includes(w.id)) continue;
    const shift = shifts.find((s) => s.assignedAssociateId === w.associateId)!;
    const rate = resolveRate(cards, { clientId: shift.clientId ?? '', position: shift.position, startsAt: shift.startsAt, payRate: shift.payRate == null ? null : Number(shift.payRate) });
    const hourly = rate.payRate ?? 0;
    out.push({
      workerId: w.id,
      workerType: 'PERSON',
      name: w.name,
      capabilities: w.capabilities,
      available: true,
      availabilityNote: `On shift ${fmtTimeInZone(shift.startsAt, tz)}–${fmtTimeInZone(shift.endsAt, tz)} as ${shift.position}`,
      costCents: Math.round((hourly * task.estimatedMinutes * 100) / 60),
      load: loadOf.get(w.id) ?? 0,
    });
  }
  const personOnShift = out.length > 0;

  // Agents and robots: the tenant's non-person workers, certified or not (the ranking says which).
  const machines = await db.worker.findMany({ where: { tenantId, type: { in: ['AGENT', 'ROBOT'] }, status: { in: ['ACTIVE', 'SUSPENDED', 'ONBOARDING'] } }, select: { id: true, name: true, type: true, status: true, capabilities: true } });
  // A robot works where it is placed: the candidates are the robots at the task's
  // site. One placed elsewhere stays in the ranking, ineligible, with the reason —
  // "why not the robot" is half of explainability (audit 2026-10-21).
  const robotIds = machines.filter((m) => m.type === 'ROBOT').map((m) => m.id);
  const placements = robotIds.length
    ? await db.workerAssignment.findMany({ where: { workerId: { in: robotIds }, endedAt: null }, orderBy: { startedAt: 'desc' }, select: { workerId: true, locationId: true, location: { select: { name: true } } } })
    : [];
  const placedAt = new Map<string, { locationId: string; name: string }>();
  for (const p of placements) if (!placedAt.has(p.workerId)) placedAt.set(p.workerId, { locationId: p.locationId, name: p.location.name });
  for (const m of machines) {
    if (excludeWorkerIds.includes(m.id)) continue;
    if (m.type === 'ROBOT') {
      const placement = placedAt.get(m.id) ?? null;
      const elsewhere = placement !== null && placement.locationId !== task.locationId;
      const r = elsewhere ? { available: false, note: `Placed at ${placement!.name}, not ${task.location.name}`, batteryPct: null } : await robotAvailability(db, m.id);
      out.push({
        workerId: m.id,
        workerType: 'ROBOT',
        name: m.name,
        capabilities: m.capabilities,
        available: r.available,
        availabilityNote: r.note,
        costCents: (policy.robotCostPerTaskCents as Record<string, number>)[task.capability] ?? policy.robotDefaultCostCents,
        load: loadOf.get(m.id) ?? 0,
        batteryPct: r.batteryPct,
        personOnShift,
      });
    } else {
      const active = m.status === 'ACTIVE';
      out.push({
        workerId: m.id,
        workerType: 'AGENT',
        name: m.name,
        capabilities: m.capabilities,
        available: active,
        availabilityNote: active ? 'Running' : `Agent is ${m.status.toLowerCase()}`,
        costCents: policy.agentCostPerTaskCents,
        load: loadOf.get(m.id) ?? 0,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------ assignment

async function writeDecision(
  db: Db,
  task: TaskLike,
  decision: RankingDecision,
  decidedBy: 'ENGINE' | 'HANDOFF',
  eventKind: 'ASSIGNED' | 'HANDED_OFF',
  byUserId: string | null,
): Promise<void> {
  const tenantId = tenantIdForWrite();
  if (decision.assign) {
    await db.workTaskAssignment.create({
      data: {
        tenantId,
        taskId: task.id,
        workerId: decision.assign.workerId,
        decidedBy,
        decidedByUserId: byUserId,
        score: decision.assign.score,
        costCents: decision.assign.costCents,
        reasons: decision.assign.reasons as unknown as Prisma.InputJsonValue,
        ranking: decision.ranking as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workTask.update({ where: { id: task.id }, data: { status: eventKind === 'HANDED_OFF' ? 'HANDED_OFF' : 'ASSIGNED', queuedReason: null } });
    await db.workTaskEvent.create({ data: { tenantId, taskId: task.id, kind: eventKind, workerId: decision.assign.workerId, byUserId, note: decision.assign.reasons[0]?.note ?? null } });
  } else {
    await db.workTask.update({ where: { id: task.id }, data: { status: 'QUEUED', queuedReason: decision.queuedReason } });
    await db.workTaskEvent.create({ data: { tenantId, taskId: task.id, kind: 'QUEUED', byUserId, note: decision.queuedReason } });
  }
}

/** The engine's own decision for an OPEN or QUEUED task. */
export async function autoAssign(db: Db, taskId: string, byUserId: string | null = null): Promise<WorkTaskDetailView> {
  const task = await db.workTask.findUniqueOrThrow({ where: { id: taskId }, include });
  const policy = await policyFor(db, task.locationId);
  const candidates = await candidatesFor(db, task, policy);
  const decision = decideAssignment(task, candidates, policy);
  await writeDecision(db, task, decision, 'ENGINE', 'ASSIGNED', byUserId);
  return taskDetail(db, taskId);
}

/** A person's own choice, recorded with the ranking that stood at the time. */
export async function assignByPerson(db: Db, taskId: string, workerId: string, userId: string, note: string | null): Promise<WorkTaskDetailView> {
  const tenantId = tenantIdForWrite();
  const task = await db.workTask.findUniqueOrThrow({ where: { id: taskId }, include });
  const worker = await db.worker.findFirst({ where: { id: workerId, tenantId }, select: { id: true, name: true, type: true } });
  if (!worker) throw new Error('worker_not_found');
  const policy = await policyFor(db, task.locationId);
  const candidates = await candidatesFor(db, task, policy);
  const ranking = decideAssignment(task, candidates, policy).ranking;
  const picked = ranking.find((r) => r.workerId === workerId);
  const reasons: AssignmentReason[] = [{ factor: 'handoff', points: 0, note: note?.trim() ? `Chosen by a person: ${note.trim()}` : 'Chosen by a person' }, ...(picked?.reasons ?? [])];
  await releaseActive(db, task.id);
  await db.workTaskAssignment.create({
    data: { tenantId, taskId: task.id, workerId, decidedBy: 'PERSON', decidedByUserId: userId, score: picked?.score ?? 0, costCents: picked?.costCents ?? 0, reasons: reasons as unknown as Prisma.InputJsonValue, ranking: ranking as unknown as Prisma.InputJsonValue },
  });
  await db.workTask.update({ where: { id: task.id }, data: { status: 'ASSIGNED', queuedReason: null } });
  await db.workTaskEvent.create({ data: { tenantId, taskId: task.id, kind: 'ASSIGNED', workerId, byUserId: userId, note: note?.trim() || `Assigned by a person to ${worker.name}` } });
  return taskDetail(db, taskId);
}

async function releaseActive(db: Db, taskId: string): Promise<void> {
  await db.workTaskAssignment.updateMany({ where: { taskId, state: 'ACTIVE' }, data: { state: 'RELEASED', releasedAt: new Date() } });
}

/**
 * Hand a stalled or failed machine's task to a person, now. Used by the
 * sweep once the policy's seconds have passed and by the "Hand to a person"
 * action straight away. Returns false when no person could take it (the
 * task stays QUEUED for the crew lead).
 */
export async function handOffToPerson(db: Db, taskId: string, byUserId: string | null, kind: 'STALLED' | 'FAILED'): Promise<{ handed: boolean; toWorkerId: string | null }> {
  const task = await db.workTask.findUniqueOrThrow({ where: { id: taskId }, include });
  const active = task.assignments.find((a) => a.state === 'ACTIVE');
  const policy = await policyFor(db, task.locationId);
  const candidates = await candidatesFor(db, task, policy, active ? [active.workerId] : []);
  const decision = decideHandoff(task, candidates, policy, { name: active?.worker.name ?? 'nobody', workerType: active?.worker.type ?? 'ROBOT', kind });
  await releaseActive(db, task.id);
  await writeDecision(db, task, decision, 'HANDOFF', 'HANDED_OFF', byUserId);
  await notifyCrewLeads(db, task, decision, active?.worker.name ?? null, kind);
  return { handed: !!decision.assign, toWorkerId: decision.assign?.workerId ?? null };
}

/** The crew leads of the site: supervisors placed there, else the tenant's workforce managers. */
async function notifyCrewLeads(db: Db, task: TaskLike, decision: RankingDecision, fromName: string | null, kind: 'STALLED' | 'FAILED'): Promise<void> {
  const tenantId = tenantIdForWrite();
  const placed = await db.associateAssignment.findMany({
    where: { locationId: task.locationId, endedAt: null, associate: { user: { role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] }, status: 'ACTIVE', tenantId } } },
    select: { associate: { select: { user: { select: { id: true } } } } },
  });
  let leadIds = [...new Set(placed.map((p) => p.associate.user?.id).filter((id): id is string => !!id))];
  if (leadIds.length === 0) {
    const managers = await db.user.findMany({ where: { tenantId, status: 'ACTIVE', role: { in: ['WORKFORCE_MANAGER', 'OPERATIONS_MANAGER'] } }, select: { id: true } });
    leadIds = managers.map((m) => m.id);
  }
  const what = `${task.location.name}: ${fromName ?? 'a machine'} ${kind === 'FAILED' ? 'failed' : 'stalled'} on ${capabilityLabel(task.capability).toLowerCase()}`;
  const body = decision.assign ? `${decision.assign.name} has it now. ${decision.assign.reasons[0]?.note ?? ''}`.trim() : `Nobody on shift can take it: ${decision.queuedReason ?? 'the task is waiting for you'}.`;
  for (const userId of leadIds) {
    await notifyUser(userId, { subject: decision.assign ? 'A task was handed to a person' : 'A task needs a person', body: `${what}. ${body}`, category: TASK_NOTIFY_CATEGORY, linkUrl: `/tasks?task=${task.id}` });
  }
  enqueueAudit(
    { actorUserId: null, clientId: task.location.clientId, tenantId, action: 'task.handed_off', entityType: 'WorkTask', entityId: task.id, metadata: { from: fromName, to: decision.assign?.name ?? null, kind, notified: leadIds.length } },
    'tasks',
  );
}

/**
 * The sweep: every machine-held task whose last STALLED or FAILED event is
 * older than the policy's handoff seconds goes to a person. Runs per tenant.
 */
export async function handOffExceptions(db: Db = defaultPrisma, now: Date = new Date()): Promise<{ handed: number; queued: number }> {
  const tenantId = tenantIdForWrite();
  const stuck = await db.workTask.findMany({
    where: { tenantId, status: { in: ['STALLED', 'FAILED'] } },
    include: { assignments: { where: { state: 'ACTIVE' }, include: { worker: { select: { type: true } } } }, events: { where: { kind: { in: ['STALLED', 'FAILED'] } }, orderBy: { at: 'desc' }, take: 1 } },
  });
  let handed = 0;
  let queued = 0;
  for (const t of stuck) {
    const holder = t.assignments[0];
    if (!holder || holder.worker.type === 'PERSON') continue;
    const policy = await policyFor(db, t.locationId);
    const since = t.events[0]?.at ?? t.updatedAt;
    if (now.getTime() - since.getTime() < policy.handoffSeconds * 1000) continue;
    const r = await handOffToPerson(db, t.id, null, t.status === 'FAILED' ? 'FAILED' : 'STALLED');
    if (r.handed) handed += 1;
    else queued += 1;
  }
  return { handed, queued };
}

// ----------------------------------------------------------------- views

const assignmentView = (a: TaskRow['assignments'][number]): WorkTaskAssignmentView => ({
  id: a.id,
  workerId: a.workerId,
  workerType: a.worker.type,
  workerName: a.worker.name,
  state: a.state,
  decidedBy: a.decidedBy,
  decidedByUserId: a.decidedByUserId,
  score: a.score,
  costCents: a.costCents,
  reasons: a.reasons as unknown as AssignmentReason[],
  ranking: a.ranking as unknown as RankedCandidate[],
  createdAt: a.createdAt.toISOString(),
  releasedAt: a.releasedAt?.toISOString() ?? null,
});

export function taskView(t: TaskRow): WorkTaskView {
  const active = t.assignments.find((a) => a.state === 'ACTIVE') ?? null;
  return {
    id: t.id,
    type: t.type,
    locationId: t.locationId,
    locationName: t.location.name,
    area: t.area,
    windowStart: t.windowStart.toISOString(),
    windowEnd: t.windowEnd.toISOString(),
    capability: t.capability,
    risk: t.risk,
    estimatedMinutes: t.estimatedMinutes,
    reference: t.reference,
    notes: t.notes,
    status: t.status,
    assignment: active ? assignmentView(active) : null,
    queuedReason: t.queuedReason,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function taskDetail(db: Db, taskId: string): Promise<WorkTaskDetailView> {
  const t = await db.workTask.findUniqueOrThrow({ where: { id: taskId }, include });
  const events: WorkTaskEventView[] = t.events.map((e) => ({ id: e.id, kind: e.kind, at: e.at.toISOString(), note: e.note, byUserId: e.byUserId, workerId: e.workerId }));
  return { ...taskView(t), events, history: t.assignments.filter((a) => a.state !== 'ACTIVE').map(assignmentView) };
}

export async function listTasks(db: Db, filter: { locationId?: string | null; from?: Date | null; to?: Date | null; status?: string | null }): Promise<WorkTaskView[]> {
  const tenantId = tenantIdForWrite();
  const rows = await db.workTask.findMany({
    where: {
      tenantId,
      ...(filter.locationId ? { locationId: filter.locationId } : {}),
      ...(filter.status ? { status: filter.status as TaskRow['status'] } : {}),
      ...(filter.from ? { windowEnd: { gt: filter.from } } : {}),
      ...(filter.to ? { windowStart: { lt: filter.to } } : {}),
    },
    include,
    orderBy: [{ windowStart: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  });
  return rows.map(taskView);
}

export async function taskSummary(db: Db, locationId: string | null, now: Date = new Date()): Promise<WorkTaskSummary> {
  const tenantId = tenantIdForWrite();
  const where = { tenantId, ...(locationId ? { locationId } : {}) };
  const counts = await db.workTask.groupBy({ by: ['status'], where, _count: { _all: true } });
  const n = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  const dayStart = new Date(now.getTime() - 24 * 3_600_000);
  const doneToday = await db.workTask.count({ where: { ...where, status: 'DONE', updatedAt: { gte: dayStart } } });
  return { open: n('OPEN'), queued: n('QUEUED'), assigned: n('ASSIGNED') + n('HANDED_OFF'), inProgress: n('IN_PROGRESS'), exceptions: n('STALLED') + n('FAILED'), doneToday };
}

/** A task's own timeline entry from the worker or a person: start, stall, fail, done, cancel. */
export async function recordEvent(db: Db, taskId: string, kind: 'STARTED' | 'STALLED' | 'FAILED' | 'DONE' | 'CANCELLED', byUserId: string | null, note: string | null): Promise<WorkTaskDetailView> {
  const tenantId = tenantIdForWrite();
  const task = await db.workTask.findUniqueOrThrow({ where: { id: taskId }, include });
  const active = task.assignments.find((a) => a.state === 'ACTIVE') ?? null;
  const status = kind === 'STARTED' ? 'IN_PROGRESS' : kind === 'STALLED' ? 'STALLED' : kind === 'FAILED' ? 'FAILED' : kind === 'DONE' ? 'DONE' : 'CANCELLED';
  await db.workTaskEvent.create({ data: { tenantId, taskId, kind, byUserId, workerId: active?.workerId ?? null, note } });
  await db.workTask.update({ where: { id: taskId }, data: { status } });
  if (kind === 'DONE' || kind === 'CANCELLED') await releaseActive(db, taskId);
  return taskDetail(db, taskId);
}
