import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, type WorkflowTrigger } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { emit, runWorkflowQueue } from '../lib/workflow.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { HUMAN_ROLES } from '@alto-people/shared';
import { enqueueAudit } from '../lib/audit.js';

export const workflowsRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

const TriggerSchema = z.enum([
  'ASSOCIATE_HIRED',
  'ASSOCIATE_TERMINATED',
  'TIME_OFF_REQUESTED',
  'TIME_OFF_APPROVED',
  'TIME_OFF_DENIED',
  'POSITION_OPENED',
  'POSITION_FILLED',
  'PAYROLL_FINALIZED',
  'ONBOARDING_COMPLETED',
  'COMPLIANCE_EXPIRING',
]);

const ActionSchema = z.object({
  kind: z.enum([
    'SEND_NOTIFICATION',
    'SET_FIELD',
    'ASSIGN_TASK',
    'CREATE_AUDIT_LOG',
    'WEBHOOK',
    'REQUIRE_APPROVAL',
  ]),
  params: z.record(z.unknown()).default({}),
});

/** The capabilities an approval gate may name: the ones that decide something. */
export const GATE_CAPABILITIES = ['manage:org', 'manage:comp', 'manage:onboarding', 'process:payroll', 'manage:scheduling', 'manage:compliance'] as const;

/** A REQUIRE_APPROVAL step must name exactly who decides, in the engine's terms. */
function gateProblems(actions: Array<{ kind: string; params: Record<string, unknown> }>): string | null {
  for (const [i, a] of actions.entries()) {
    if (a.kind !== 'REQUIRE_APPROVAL') continue;
    const p = a.params ?? {};
    const named = ['capability', 'userId', 'role'].filter((k) => typeof p[k] === 'string' && (p[k] as string).trim() !== '');
    if (named.length !== 1) return `Step ${i + 1}: an approval gate names exactly one decider — a role, a person, or a capability.`;
    if (typeof p.capability === 'string' && p.capability && !(GATE_CAPABILITIES as readonly string[]).includes(p.capability)) return `Step ${i + 1}: "${p.capability}" is not a capability that decides.`;
    if (typeof p.role === 'string' && p.role && !(HUMAN_ROLES as readonly string[]).includes(p.role)) return `Step ${i + 1}: "${p.role}" is not a role.`;
    if (typeof p.userId === 'string' && p.userId && !/^[0-9a-f-]{36}$/i.test(p.userId) && !p.userId.includes('{{')) return `Step ${i + 1}: the person must be an account id.`;
  }
  return null;
}

const DefinitionInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  trigger: TriggerSchema,
  conditions: z.record(z.unknown()).optional(),
  actions: z.array(ActionSchema).default([]),
  isActive: z.boolean().optional(),
});

workflowsRouter.get('/', VIEW, async (req: Request, res: Response) => {
  const clientId =
    typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const trigger =
    typeof req.query.trigger === 'string' ? req.query.trigger : undefined;
  const where: Prisma.WorkflowDefinitionWhereInput = {
    deletedAt: null,
    ...(clientId !== undefined
      ? { OR: [{ clientId: null }, { clientId }] }
      : {}),
    ...(trigger ? { trigger: trigger as WorkflowTrigger } : {}),
  };
  const rows = await prisma.workflowDefinition.findMany({
    take: 100,
    where,
    orderBy: [{ trigger: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { runs: true } } },
  });
  res.json({
    definitions: rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      name: r.name,
      description: r.description,
      trigger: r.trigger,
      conditions: r.conditions,
      actions: r.actions,
      isActive: r.isActive,
      runCount: r._count.runs,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
});

workflowsRouter.post('/', MANAGE, async (req: Request, res: Response) => {
  const input = DefinitionInputSchema.parse(req.body);
  const gate = gateProblems(input.actions);
  if (gate) throw new HttpError(400, 'invalid_gate', gate);
  const created = await prisma.workflowDefinition.create({
    data: {
      clientId: input.clientId ?? null,
      name: input.name,
      description: input.description ?? null,
      trigger: input.trigger,
      conditions: (input.conditions ?? {}) as Prisma.InputJsonValue,
      actions: input.actions as unknown as Prisma.InputJsonValue,
      isActive: input.isActive ?? true,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({
    id: created.id,
    name: created.name,
    trigger: created.trigger,
    isActive: created.isActive,
  });
});

workflowsRouter.put('/:id', MANAGE, async (req: Request, res: Response) => {
  const id = req.params.id;
  const input = DefinitionInputSchema.partial().parse(req.body);
  const gate = input.actions ? gateProblems(input.actions) : null;
  if (gate) throw new HttpError(400, 'invalid_gate', gate);
  const existing = await prisma.workflowDefinition.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Workflow not found.');
  }
  const updated = await prisma.workflowDefinition.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      description: input.description === undefined ? undefined : input.description,
      trigger: input.trigger ?? undefined,
      conditions:
        input.conditions === undefined
          ? undefined
          : (input.conditions as Prisma.InputJsonValue),
      actions:
        input.actions === undefined
          ? undefined
          : (input.actions as unknown as Prisma.InputJsonValue),
      isActive: input.isActive ?? undefined,
    },
  });
  res.json({
    id: updated.id,
    name: updated.name,
    isActive: updated.isActive,
  });
});

workflowsRouter.delete(
  '/:id',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const existing = await prisma.workflowDefinition.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Workflow not found.');
    }
    await prisma.workflowDefinition.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    res.status(204).end();
  },
);

/* ----- Tasks a workflow handed a person or a role ------------------------- */

function shapeTask(t: { id: string; title: string; details: string | null; assigneeUserId: string | null; assigneeRole: string | null; entityType: string | null; entityId: string | null; linkUrl: string | null; dueAt: Date | null; status: 'OPEN' | 'DONE'; doneAt: Date | null; createdAt: Date }) {
  return {
    id: t.id,
    title: t.title,
    details: t.details,
    assigneeUserId: t.assigneeUserId,
    assigneeRole: t.assigneeRole,
    entityType: t.entityType,
    entityId: t.entityId,
    linkUrl: t.linkUrl,
    dueAt: t.dueAt?.toISOString() ?? null,
    status: t.status,
    doneAt: t.doneAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

/** GET /workflows/tasks — open tasks for me (named, or my role), oldest due first. */
workflowsRouter.get('/tasks', requireAuth, async (req: Request, res: Response) => {
  const status = req.query.status === 'DONE' ? 'DONE' : 'OPEN';
  const rows = await prisma.workflowTask.findMany({
    where: { tenantId: tenantIdForWrite(), status, OR: [{ assigneeUserId: req.user!.id }, { assigneeRole: req.user!.role }] },
    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    take: 200,
  });
  res.json({ tasks: rows.map(shapeTask) });
});

workflowsRouter.post('/tasks/:id/done', requireAuth, async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const task = await prisma.workflowTask.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!task) throw new HttpError(404, 'not_found', 'Task not found.');
  if (task.assigneeUserId && task.assigneeUserId !== req.user!.id) throw new HttpError(403, 'forbidden', 'This task is for someone else.');
  if (!task.assigneeUserId && task.assigneeRole && task.assigneeRole !== req.user!.role) throw new HttpError(403, 'forbidden', 'This task is for another role.');
  const updated = await prisma.workflowTask.update({ where: { id }, data: { status: 'DONE', doneAt: new Date(), doneById: req.user!.id } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'workflow.task_done', entityType: 'WorkflowTask', entityId: id, metadata: { runId: task.runId } }, 'workflows.taskDone');
  res.json(shapeTask(updated));
});

/** POST /workflows/queue/run — drain the queue now (HR, while authoring; the worker does this on its own). */
workflowsRouter.post('/queue/run', MANAGE, async (_req: Request, res: Response) => {
  res.json(await runWorkflowQueue());
});

/** The open approval each run waits on (its REQUIRE_APPROVAL gate). */
async function gatesFor(runIds: string[]): Promise<Map<string, { approvalId: string; title: string; status: string }>> {
  if (runIds.length === 0) return new Map();
  const rows = await prisma.approvalRequest.findMany({
    where: { workflowRunId: { in: runIds } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, status: true, workflowRunId: true },
  });
  const out = new Map<string, { approvalId: string; title: string; status: string }>();
  for (const r of rows) if (r.workflowRunId && !out.has(r.workflowRunId)) out.set(r.workflowRunId, { approvalId: r.id, title: r.title, status: r.status });
  return out;
}

workflowsRouter.get('/runs', VIEW, async (req: Request, res: Response) => {
  const definitionId =
    typeof req.query.definitionId === 'string' ? req.query.definitionId : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const where: Prisma.WorkflowRunWhereInput = {
    ...(definitionId ? { definitionId } : {}),
    ...(status ? { status: status as 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'WAITING' } : {}),
  };
  const rows = await prisma.workflowRun.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      definition: { select: { name: true, trigger: true } },
      steps: { orderBy: { ordinal: 'asc' } },
    },
  });
  // A WAITING run names the approval it waits on, so the page can link it.
  const gates = await gatesFor(rows.filter((r) => r.status === 'WAITING').map((r) => r.id));
  res.json({
    runs: rows.map((r) => ({
      waitingOn: gates.get(r.id) ?? null,
      id: r.id,
      definitionId: r.definitionId,
      definitionName: r.definition.name,
      trigger: r.trigger,
      entityType: r.entityType,
      entityId: r.entityId,
      status: r.status,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      failureReason: r.failureReason,
      stepCount: r.steps.length,
      stepsCompleted: r.steps.filter((s) => s.status === 'COMPLETED').length,
      stepsFailed: r.steps.filter((s) => s.status === 'FAILED').length,
    })),
  });
});

workflowsRouter.get(
  '/runs/:id',
  VIEW,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const run = await prisma.workflowRun.findUnique({
      where: { id },
      include: {
        definition: true,
        steps: { orderBy: { ordinal: 'asc' } },
      },
    });
    if (!run) throw new HttpError(404, 'not_found', 'Run not found.');
    const gate = (await gatesFor([run.id])).get(run.id) ?? null;
    res.json({
      run: {
        waitingOn: gate,
        id: run.id,
        definition: {
          id: run.definition.id,
          name: run.definition.name,
          trigger: run.definition.trigger,
        },
        trigger: run.trigger,
        entityType: run.entityType,
        entityId: run.entityId,
        context: run.context,
        status: run.status,
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
        failureReason: run.failureReason,
        steps: run.steps.map((s) => ({
          id: s.id,
          ordinal: s.ordinal,
          kind: s.kind,
          params: s.params,
          status: s.status,
          result: s.result,
          failureReason: s.failureReason,
          startedAt: s.startedAt?.toISOString() ?? null,
          completedAt: s.completedAt?.toISOString() ?? null,
        })),
      },
    });
  },
);

// Manual fire — for HR to test a definition without producing the
// upstream business event. Useful during workflow authoring.
workflowsRouter.post(
  '/:id/test',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const def = await prisma.workflowDefinition.findUnique({ where: { id } });
    if (!def || def.deletedAt) {
      throw new HttpError(404, 'not_found', 'Workflow not found.');
    }
    const ctx = (req.body?.context ?? {}) as Record<string, unknown>;
    const result = await emit({
      trigger: def.trigger,
      entityType: 'manual_test',
      entityId: id,
      context: ctx,
      clientId: def.clientId,
    });
    res.json(result);
  },
);
