import { Router } from 'express';
import { z } from 'zod';
import { WorkTaskAssignSchema, WorkTaskCreateSchema, WorkTaskEventCreateSchema, WorkTaskPolicyUpdateSchema, WORKER_CAPABILITIES, type WorkTaskPolicyView } from '@alto-people/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assignByPerson, autoAssign, handOffToPerson, listTasks, policyFor, recordEvent, taskDetail, taskSummary } from '../lib/tasks/engine.js';
import { spanWarningsFor } from '../lib/tasks/spanWarnings.js';
import { siteDay } from '../lib/siteDay.js';
import { assertCompanyWide, assertSiteInScope, loadInScope, scopeSites } from '../lib/scope.js';
import { taskForViewer } from '../lib/tasks/costs.js';

/**
 * Brief 3-2: tasks and their assignment.
 *
 *   GET    /tasks                      the board: by site, window and status
 *   GET    /tasks/summary              counts for the board's strip
 *   GET    /tasks/policy[?locationId]  the engine's rules in force
 *   PUT    /tasks/policy               set them (tenant-wide or for one site)
 *   POST   /tasks                      create; the engine assigns or queues at once
 *   GET    /tasks/:id                  the task, its assignment and reasons, its timeline
 *   POST   /tasks/:id/assign           a person picks the worker (recorded as such)
 *   POST   /tasks/:id/auto             ask the engine again (a queued task)
 *   POST   /tasks/:id/handoff          hand a machine's task to a person now
 *   POST   /tasks/:id/events           started / stalled / failed / done / cancelled
 *
 * Reads need view:time-live (the floor's live view: supervisors and up, never an
 * associate, a driver or the client portal); writes need manage:scheduling. The policy
 * needs manage:org. Everything is the caller's tenant and reach: a
 * client-bound supervisor sees and works her client's sites only (FLOOR-9),
 * and a person's cost — their pay × minutes — is shown only to a role that
 * may see pay (FLOOR-6, lib/tasks/costs).
 */
export const tasksRouter = Router();

const read = requireCapability('view:time-live');
const write = requireCapability('manage:scheduling');
const admin = requireCapability('manage:org');

const dateParam = (v: unknown) => (typeof v === 'string' && v ? new Date(v) : null);

tasksRouter.get('/', read, async (req, res) => {
  const q = z
    .object({
      locationId: z.string().uuid().optional(),
      /** A calendar day (YYYY-MM-DD) on the site's clock — else the company's (lib/siteDay). Beats from/to. */
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      status: z.string().optional(),
    })
    .parse(req.query);
  // "The site's day" (F500 SH-4): midnight to midnight on the floor's own
  // clock, never a UTC day (after 5 PM Pacific that was tomorrow's tasks).
  const day = q.day ? await siteDay(q.locationId ?? null, q.day, prisma) : null;
  const tasks = await listTasks(prisma, {
    locationId: q.locationId ?? null,
    from: day ? day.start : dateParam(q.from),
    to: day ? day.end : dateParam(q.to),
    status: q.status ?? null,
    sites: scopeSites(req.user!),
  });
  res.json({ tasks: tasks.map((t) => taskForViewer(req.user!, t)), ...(day ? { day: day.day, timezone: day.timezone } : {}) });
});

/** Today on a site's clock (else the company's): the board opens on it and names the zone. */
tasksRouter.get('/day', read, async (req, res) => {
  const q = z.object({ locationId: z.string().uuid().optional() }).parse(req.query);
  const d = await siteDay(q.locationId ?? null, null, prisma);
  res.json({ day: d.day, timezone: d.timezone });
});

tasksRouter.get('/summary', read, async (req, res) => {
  const q = z.object({ locationId: z.string().uuid().optional() }).parse(req.query);
  res.json(await taskSummary(prisma, q.locationId ?? null, new Date(), scopeSites(req.user!)));
});

tasksRouter.get('/policy', read, async (req, res) => {
  const q = z.object({ locationId: z.string().uuid().optional() }).parse(req.query);
  // Which sites carry their own policy, so the scope picker can mark them (F500 G4).
  const overrides = await prisma.workTaskPolicy.findMany({ where: { tenantId: tenantIdForWrite(), locationId: { not: null } }, select: { locationId: true } });
  res.json({ ...(await policyFor(prisma, q.locationId ?? null)), overrideLocationIds: overrides.map((o) => o.locationId!) });
});

tasksRouter.put('/policy', admin, async (req, res) => {
  const q = z.object({ locationId: z.string().uuid().optional() }).parse(req.query);
  const input = WorkTaskPolicyUpdateSchema.parse(req.body);
  const tenantId = tenantIdForWrite();
  const locationId = q.locationId ?? null;
  // A site's rules for a site in reach; the company's rules for a company-wide caller.
  if (locationId) await assertSiteInScope(prisma, req.user!, locationId);
  else assertCompanyWide(req.user!, 'The company-wide task rules are for someone without a site limit; set this location’s own.');
  const existing = await prisma.workTaskPolicy.findFirst({ where: { tenantId, locationId } });
  const data: Prisma.WorkTaskPolicyUncheckedUpdateInput = {
    ...(input.handoffSeconds !== undefined ? { handoffSeconds: input.handoffSeconds } : {}),
    ...(input.maxAutoAssignCents !== undefined ? { maxAutoAssignCents: input.maxAutoAssignCents } : {}),
    ...(input.highRiskPolicy !== undefined ? { highRiskPolicy: input.highRiskPolicy } : {}),
    ...(input.robotCostPerTaskCents !== undefined ? { robotCostPerTaskCents: input.robotCostPerTaskCents } : {}),
    ...(input.robotDefaultCostCents !== undefined ? { robotDefaultCostCents: input.robotDefaultCostCents } : {}),
    ...(input.agentCostPerTaskCents !== undefined ? { agentCostPerTaskCents: input.agentCostPerTaskCents } : {}),
    ...(input.maxRobotsPerCrewLead !== undefined ? { maxRobotsPerCrewLead: input.maxRobotsPerCrewLead } : {}),
    ...(input.robotUtilizationPct !== undefined ? { robotUtilizationPct: input.robotUtilizationPct } : {}),
    ...(input.backupCrewRatioPct !== undefined ? { backupCrewRatioPct: input.backupCrewRatioPct } : {}),
    updatedByUserId: req.user!.id,
  };
  if (existing) await prisma.workTaskPolicy.update({ where: { id: existing.id }, data });
  else await prisma.workTaskPolicy.create({ data: { tenantId, locationId, ...(data as Prisma.WorkTaskPolicyUncheckedCreateInput) } });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'task.policy.updated', entityType: 'WorkTaskPolicy', entityId: existing?.id ?? 'new', metadata: { locationId, ...input } }, 'tasks');
  const view: WorkTaskPolicyView = await policyFor(prisma, locationId);
  res.json(view);
});

tasksRouter.post('/', write, async (req, res) => {
  const input = WorkTaskCreateSchema.parse(req.body);
  if (!WORKER_CAPABILITIES.some((c) => c.code === input.capability)) throw new HttpError(400, 'unknown_capability', `No capability "${input.capability}" in the catalog.`);
  const start = new Date(input.windowStart);
  const end = new Date(input.windowEnd);
  if (!(end > start)) throw new HttpError(400, 'window_invalid', 'The window must end after it starts.');
  const tenantId = tenantIdForWrite();
  const site = await prisma.site.findFirst({ where: { AND: [{ id: input.locationId, tenantId, deletedAt: null }, scopeSites(req.user!)] }, select: { id: true } });
  if (!site) throw new HttpError(404, 'site_not_found', 'No such site.');
  const row = await prisma.workTask.create({
    data: {
      tenantId,
      type: input.type,
      locationId: input.locationId,
      area: input.area ?? null,
      windowStart: start,
      windowEnd: end,
      capability: input.capability,
      risk: input.risk,
      estimatedMinutes: input.estimatedMinutes,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      createdByUserId: req.user!.id,
    },
  });
  const detail = await autoAssign(prisma, row.id, req.user!.id);
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'task.created', entityType: 'WorkTask', entityId: row.id, metadata: { capability: input.capability, risk: input.risk, assignedTo: detail.assignment?.workerName ?? null, queued: detail.status === 'QUEUED' } }, 'tasks');
  res.status(201).json({ ...taskForViewer(req.user!, detail), warnings: await spanWarningsFor(prisma, detail) });
});

/** The task, through the caller's tenant and reach (lib/scope loadInScope) — another client's id is not found. */
async function ownTask(id: string, user: NonNullable<Express.Request['user']>) {
  await loadInScope(prisma, 'task', id, user);
  const t = await prisma.workTask.findFirst({ where: { id, tenantId: tenantIdForWrite() }, select: { id: true, status: true } });
  if (!t) throw new HttpError(404, 'not_found', 'No such task.');
  return t;
}

tasksRouter.get('/:id', read, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await ownTask(id, req.user!);
  res.json(taskForViewer(req.user!, await taskDetail(prisma, id)));
});

tasksRouter.post('/:id/assign', write, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const t = await ownTask(id, req.user!);
  if (t.status === 'DONE' || t.status === 'CANCELLED') throw new HttpError(409, 'task_closed', 'This task is closed.');
  const input = WorkTaskAssignSchema.parse(req.body);
  let detail;
  try {
    detail = await assignByPerson(prisma, id, input.workerId, req.user!.id, input.note ?? null);
  } catch (err) {
    if (err instanceof Error && err.message === 'worker_not_found') throw new HttpError(404, 'worker_not_found', 'No such worker on the roster.');
    throw err;
  }
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId: tenantIdForWrite(), action: 'task.assigned_by_person', entityType: 'WorkTask', entityId: id, metadata: { workerId: input.workerId } }, 'tasks');
  res.json(taskForViewer(req.user!, detail));
});

tasksRouter.post('/:id/auto', write, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const t = await ownTask(id, req.user!);
  if (t.status !== 'OPEN' && t.status !== 'QUEUED') throw new HttpError(409, 'task_not_open', 'Only an open or queued task is assigned by the engine.');
  const detail = await autoAssign(prisma, id, req.user!.id);
  res.json({ ...taskForViewer(req.user!, detail), warnings: await spanWarningsFor(prisma, detail) });
});

tasksRouter.post('/:id/handoff', write, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const t = await ownTask(id, req.user!);
  if (!['ASSIGNED', 'IN_PROGRESS', 'STALLED', 'FAILED', 'HANDED_OFF'].includes(t.status)) throw new HttpError(409, 'task_not_held', 'Nothing holds this task.');
  const kind = t.status === 'FAILED' ? 'FAILED' : 'STALLED';
  await handOffToPerson(prisma, id, req.user!.id, kind);
  res.json(taskForViewer(req.user!, await taskDetail(prisma, id)));
});

tasksRouter.post('/:id/events', write, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const t = await ownTask(id, req.user!);
  if (t.status === 'DONE' || t.status === 'CANCELLED') throw new HttpError(409, 'task_closed', 'This task is closed.');
  const input = WorkTaskEventCreateSchema.parse(req.body);
  const detail = await recordEvent(prisma, id, input.kind, req.user!.id, input.note ?? null);
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId: tenantIdForWrite(), action: `task.${input.kind.toLowerCase()}`, entityType: 'WorkTask', entityId: id, metadata: { note: input.note ?? null } }, 'tasks');
  res.json(taskForViewer(req.user!, detail));
});
