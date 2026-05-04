import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 125 — New-hire ramp plans (30/60/90).
 *
 * Reuses onboarding caps. Plans are typically created with default 30/60/90
 * milestones at creation time; managers update milestone status as the new
 * hire progresses.
 */

export const ramp125Router = Router();

// Ramp plans are HR-admin data — gate reads on view:hr-admin so
// associates with view:onboarding can't pull any associate's 30/60/90
// plan by UUID.
const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:onboarding');

const STATUS = z.enum(['PENDING', 'ON_TRACK', 'ACHIEVED', 'MISSED']);

// ----- Get the active plan for an associate (with milestones) -------------

ramp125Router.get(
  '/ramp-plans/by-associate/:associateId',
  VIEW,
  async (req, res) => {
    const associateId = z.string().uuid().parse(req.params.associateId);
    const plan = await prisma.rampPlan.findFirst({
      where: { associateId, archivedAt: null },
      include: {
        manager: { select: { email: true } },
        milestones: { orderBy: { dayCheckpoint: 'asc' } },
        associate: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
    });
    if (!plan) {
      return res.json({ plan: null });
    }
    res.json({
      plan: {
        id: plan.id,
        associateId: plan.associateId,
        associateName: `${plan.associate.firstName} ${plan.associate.lastName}`,
        startDate: plan.startDate.toISOString().slice(0, 10),
        managerEmail: plan.manager?.email ?? null,
        notes: plan.notes,
        milestones: plan.milestones.map((m) => ({
          id: m.id,
          dayCheckpoint: m.dayCheckpoint,
          title: m.title,
          description: m.description,
          status: m.status,
          achievedAt: m.achievedAt?.toISOString() ?? null,
          notes: m.notes,
        })),
      },
    });
  },
);

// ----- List active plans (HR-facing) --------------------------------------

ramp125Router.get('/ramp-plans', VIEW, async (_req, res) => {
  const plans = await prisma.rampPlan.findMany({
    take: 500,
    where: { archivedAt: null },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      manager: { select: { email: true } },
      milestones: {
        orderBy: { dayCheckpoint: 'asc' },
        select: {
          dayCheckpoint: true,
          status: true,
        },
      },
    },
    orderBy: { startDate: 'desc' },
  });
  res.json({
    plans: plans.map((p) => {
      const total = p.milestones.length;
      const achieved = p.milestones.filter((m) => m.status === 'ACHIEVED').length;
      const missed = p.milestones.filter((m) => m.status === 'MISSED').length;
      return {
        id: p.id,
        associateId: p.associateId,
        associateName: `${p.associate.firstName} ${p.associate.lastName}`,
        associateEmail: p.associate.email,
        startDate: p.startDate.toISOString().slice(0, 10),
        managerEmail: p.manager?.email ?? null,
        total,
        achieved,
        missed,
      };
    }),
  });
});

// ----- Create plan (with default milestones) -------------------------------

const CreateInputSchema = z.object({
  associateId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  managerId: z.string().uuid().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  // Optional: caller can override the default 30/60/90 set.
  milestones: z
    .array(
      z.object({
        dayCheckpoint: z.number().int().min(1).max(365),
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional().nullable(),
      }),
    )
    .min(1)
    .max(20)
    .optional(),
});

const DEFAULT_MILESTONES = [
  { dayCheckpoint: 30, title: 'Day 30 — fully onboarded', description: 'Tools, access, intro to team, key processes.' },
  { dayCheckpoint: 60, title: 'Day 60 — first contributions', description: 'Owning a meaningful piece of work end-to-end.' },
  { dayCheckpoint: 90, title: 'Day 90 — operating independently', description: 'Hitting expected output for the role.' },
];

ramp125Router.post('/ramp-plans', MANAGE, async (req, res) => {
  const input = CreateInputSchema.parse(req.body);
  const associate = await prisma.associate.findUnique({
    where: { id: input.associateId },
  });
  if (!associate || associate.deletedAt) {
    throw new HttpError(404, 'associate_not_found', 'Associate not found.');
  }
  const milestones = input.milestones ?? DEFAULT_MILESTONES;
  try {
    const created = await prisma.rampPlan.create({
      data: {
        associateId: input.associateId,
        startDate: new Date(input.startDate),
        managerId: input.managerId ?? null,
        notes: input.notes ?? null,
        createdById: req.user!.id,
        milestones: {
          create: milestones.map((m) => ({
            dayCheckpoint: m.dayCheckpoint,
            title: m.title,
            description: m.description ?? null,
          })),
        },
      },
    });
    res.status(201).json({ id: created.id });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      throw new HttpError(
        409,
        'plan_active',
        'Associate already has an active ramp plan. Archive it first.',
      );
    }
    throw err;
  }
});

// ----- Add a milestone to an existing plan ---------------------------------

const AddMilestoneInputSchema = z.object({
  dayCheckpoint: z.number().int().min(1).max(365),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
});

ramp125Router.post(
  '/ramp-plans/:planId/milestones',
  MANAGE,
  async (req, res) => {
    const planId = z.string().uuid().parse(req.params.planId);
    const input = AddMilestoneInputSchema.parse(req.body);
    const plan = await prisma.rampPlan.findUnique({ where: { id: planId } });
    if (!plan) {
      throw new HttpError(404, 'plan_not_found', 'Plan not found.');
    }
    const created = await prisma.rampMilestone.create({
      data: {
        planId,
        dayCheckpoint: input.dayCheckpoint,
        title: input.title,
        description: input.description ?? null,
      },
    });
    res.status(201).json({ id: created.id });
  },
);

// ----- Update milestone (status, notes) ------------------------------------

const MilestoneUpdateSchema = z.object({
  status: STATUS.optional(),
  notes: z.string().max(2000).optional().nullable(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
});

ramp125Router.patch(
  '/ramp-milestones/:id',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = MilestoneUpdateSchema.parse(req.body);
    const m = await prisma.rampMilestone.findUnique({ where: { id } });
    if (!m) {
      throw new HttpError(404, 'not_found', 'Milestone not found.');
    }
    await prisma.rampMilestone.update({
      where: { id },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.status === 'ACHIEVED' && !m.achievedAt
          ? { achievedAt: new Date() }
          : {}),
        ...(input.status && input.status !== 'ACHIEVED' && m.achievedAt
          ? { achievedAt: null }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      },
    });
    res.json({ ok: true });
  },
);

// ----- Delete milestone ----------------------------------------------------

ramp125Router.delete('/ramp-milestones/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const m = await prisma.rampMilestone.findUnique({ where: { id } });
  if (!m) {
    throw new HttpError(404, 'not_found', 'Milestone not found.');
  }
  await prisma.rampMilestone.delete({ where: { id } });
  res.status(204).end();
});

// ----- Archive plan --------------------------------------------------------

ramp125Router.post('/ramp-plans/:id/archive', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const plan = await prisma.rampPlan.findUnique({ where: { id } });
  if (!plan) {
    throw new HttpError(404, 'not_found', 'Plan not found.');
  }
  if (plan.archivedAt) {
    throw new HttpError(409, 'already_archived', 'Already archived.');
  }
  await prisma.rampPlan.update({
    where: { id },
    data: { archivedAt: new Date() },
  });
  res.json({ ok: true });
});
