import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, type WorkflowTrigger } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { emit } from '../lib/workflow.js';

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
  ]),
  params: z.record(z.unknown()).default({}),
});

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

workflowsRouter.get('/runs', VIEW, async (req: Request, res: Response) => {
  const definitionId =
    typeof req.query.definitionId === 'string' ? req.query.definitionId : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const where: Prisma.WorkflowRunWhereInput = {
    ...(definitionId ? { definitionId } : {}),
    ...(status ? { status: status as 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' } : {}),
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
  res.json({
    runs: rows.map((r) => ({
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
    res.json({
      run: {
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
