import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertSameTenant } from '../lib/sameTenant.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { notifyAssociate, notifyManager } from '../lib/notify.js';
import { scopeActiveAssociates } from '../lib/scope.js';

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
    await assertSameTenant('associate', associateId);
    const plan = await prisma.rampPlan.findFirst({
      where: { associateId, archivedAt: null },
      include: {
        manager: {
          select: {
            email: true,
            // User has no name columns; the linked Associate carries them.
            associate: { select: { firstName: true, lastName: true } },
          },
        },
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
        template: plan.template,
        managerEmail: plan.manager?.email ?? null,
        managerName: plan.manager?.associate
          ? `${plan.manager.associate.firstName} ${plan.manager.associate.lastName}`
          : null,
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

// ----- Who can own a plan ----------------------------------------------------

/** GET /ramp-plans/owners — managers and store leads who can own a plan, with where they lead. */
ramp125Router.get('/ramp-plans/owners', VIEW, async (_req, res) => {
  const rows = await prisma.user.findMany({
    where: {
      tenantId: tenantIdForWrite(),
      deletedAt: null,
      status: { not: 'DISABLED' },
      role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'MANAGER', 'OPERATIONS_MANAGER', 'HR_ADMINISTRATOR', 'WORKFORCE_MANAGER'] },
    },
    take: 1000,
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      associate: { select: { firstName: true, lastName: true } },
      location: { select: { name: true } },
    },
  });
  res.json({
    owners: rows
      .map((u) => ({
        id: u.id,
        name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.displayName?.trim() || u.email,
        role: u.role,
        siteName: u.location?.name ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

// ----- List active plans (HR-facing) --------------------------------------

ramp125Router.get('/ramp-plans', VIEW, async (req, res) => {
  const plans = await prisma.rampPlan.findMany({
    take: 500,
    // People in the caller's tenant and reach.
    where: { archivedAt: null, associate: { is: scopeActiveAssociates(req.user!, { former: true }) } },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      manager: {
        select: {
          email: true,
          // User has no name columns; the linked Associate carries them.
          associate: { select: { firstName: true, lastName: true } },
        },
      },
      milestones: {
        orderBy: { dayCheckpoint: 'asc' },
        select: {
          dayCheckpoint: true,
          status: true,
          title: true,
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
        managerName: p.manager?.associate
          ? `${p.manager.associate.firstName} ${p.manager.associate.lastName}`
          : null,
        template: p.template,
        total,
        achieved,
        missed,
        // The plan's timeline at a glance: each checkpoint and how it went.
        milestones: p.milestones.map((m) => ({ dayCheckpoint: m.dayCheckpoint, status: m.status, title: m.title })),
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
  /** STANDARD: first shift → week 2 → 30/60/90. SEASONAL: a 6–8 week season. */
  template: z.enum(['STANDARD', 'SEASONAL']).optional(),
  // Optional: caller can override the template's milestones.
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

/**
 * The first weeks matter most on the floor: a plan starts at the first
 * shift, checks in at week 1 and week 2, then 30/60/90. A seasonal hire's
 * plan runs the length of a season instead.
 */
const TEMPLATES = {
  STANDARD: [
    { dayCheckpoint: 1, title: 'First shift', description: 'Badge, clock-in, the store walk, safety and who to ask.' },
    { dayCheckpoint: 7, title: 'Week 1 — on the floor', description: 'Working shifts to standard with a buddy nearby.' },
    { dayCheckpoint: 14, title: 'Week 2 — working solo', description: 'Covering a station without a buddy.' },
    { dayCheckpoint: 30, title: 'Day 30 — fully onboarded', description: 'Every station they’re scheduled for, to standard.' },
    { dayCheckpoint: 60, title: 'Day 60 — reliable', description: 'On time, every shift, and helping new crew.' },
    { dayCheckpoint: 90, title: 'Day 90 — operating independently', description: 'Ready for more hours, a lead track, or cross-training.' },
  ],
  SEASONAL: [
    { dayCheckpoint: 1, title: 'First shift', description: 'Badge, clock-in, the store walk, safety and who to ask.' },
    { dayCheckpoint: 7, title: 'Week 1 — on the floor', description: 'Working shifts to standard with a buddy nearby.' },
    { dayCheckpoint: 14, title: 'Week 2 — working solo', description: 'Covering a station without a buddy.' },
    { dayCheckpoint: 28, title: 'Week 4 — peak ready', description: 'Ready for the busiest days of the season.' },
    { dayCheckpoint: 42, title: 'Week 6 — rehire check', description: 'Would we bring them back next season?' },
    { dayCheckpoint: 56, title: 'Season end', description: 'Wrap-up, feedback, and an invitation for next season.' },
  ],
} as const;

ramp125Router.post('/ramp-plans', MANAGE, async (req, res) => {
  const input = CreateInputSchema.parse(req.body);
  const associate = await prisma.associate.findUnique({
    where: { id: input.associateId },
  });
  if (!associate || associate.deletedAt) {
    throw new HttpError(404, 'associate_not_found', 'Associate not found.');
  }
  const template = input.template ?? 'STANDARD';
  const milestones = input.milestones ?? TEMPLATES[template];
  if (input.managerId) {
    // The owner is anyone who leads them — a manager or the store's shift supervisor.
    const owner = await prisma.user.findFirst({ where: { id: input.managerId, tenantId: tenantIdForWrite(), deletedAt: null, status: { not: 'DISABLED' } }, select: { id: true } });
    if (!owner) throw new HttpError(404, 'owner_not_found', 'No such plan owner.');
  }
  try {
    const created = await prisma.rampPlan.create({
      data: {
        associateId: input.associateId,
        startDate: new Date(input.startDate),
        managerId: input.managerId ?? null,
        notes: input.notes ?? null,
        template,
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
    const m = await prisma.rampMilestone.findUnique({
      where: { id },
      include: {
        plan: {
          select: {
            associateId: true,
            associate: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
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
    // Fire once on the transition INTO missed, not on every re-save of an
    // already-missed milestone.
    if (input.status === 'MISSED' && m.status !== 'MISSED') {
      const associateName = `${m.plan.associate.firstName} ${m.plan.associate.lastName}`;
      const milestoneLabel = `"${m.title}" (Day ${m.dayCheckpoint})`;
      void notifyAssociate(m.plan.associateId, {
        subject: 'Ramp milestone missed',
        body: `Milestone ${milestoneLabel} on your ramp plan was marked missed. Talk to your manager about a catch-up plan.`,
        category: 'ramp',
        linkUrl: '/ramp',
      });
      void notifyManager(m.plan.associateId, {
        subject: 'Ramp milestone missed',
        body: `${associateName} missed ramp milestone ${milestoneLabel}. Review their plan and adjust the timeline if needed.`,
        category: 'ramp',
        linkUrl: '/ramp',
      });
    }
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
