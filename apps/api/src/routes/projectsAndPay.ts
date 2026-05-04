import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 86 — Projects, premium pay rules, tip pools.
 *
 * /projects                          (view:time / manage:time)
 *   GET  ?clientId
 *   POST
 *   PUT  /:id
 *   DELETE /:id (sets isActive = false)
 *
 * /premium-pay-rules                 (view:payroll / process:payroll)
 *   GET  ?clientId
 *   POST
 *   PUT  /:id
 *   DELETE /:id (sets isActive = false)
 *
 * /tip-pools                         (view:payroll / process:payroll)
 *   GET  ?clientId
 *   POST
 *   POST /:id/allocations             — manual add
 *   POST /:id/auto-allocate-by-hours  — distribute by hours over a window
 *   PUT  /:id/close
 *   PUT  /:id/pay-out
 */

export const projectsAndPayRouter = Router();

const VIEW_TIME = requireCapability('view:time');
const MANAGE_TIME = requireCapability('manage:time');
const VIEW_PAY = requireCapability('view:payroll');
const PROCESS_PAY = requireCapability('process:payroll');

// ----- Projects ----------------------------------------------------------

const ProjectInputSchema = z.object({
  clientId: z.string().uuid(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  isBillable: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

projectsAndPayRouter.get('/projects', VIEW_TIME, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const includeInactive = req.query.includeInactive === '1';
  const rows = await prisma.project.findMany({
    take: 1000,
    where: {
      ...(clientId ? { clientId } : {}),
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
  res.json({ projects: rows });
});

projectsAndPayRouter.post('/projects', MANAGE_TIME, async (req, res) => {
  const input = ProjectInputSchema.parse(req.body);
  const created = await prisma.project.create({
    data: {
      clientId: input.clientId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      isBillable: input.isBillable ?? true,
      isActive: input.isActive ?? true,
    },
  });
  res.status(201).json({ id: created.id });
});

projectsAndPayRouter.put('/projects/:id', MANAGE_TIME, async (req, res) => {
  const id = req.params.id;
  const input = ProjectInputSchema.partial().parse(req.body);
  await prisma.project.update({
    where: { id },
    data: {
      code: input.code ?? undefined,
      name: input.name ?? undefined,
      description: input.description === undefined ? undefined : input.description,
      isBillable: input.isBillable ?? undefined,
      isActive: input.isActive ?? undefined,
    },
  });
  res.json({ ok: true });
});

projectsAndPayRouter.delete('/projects/:id', MANAGE_TIME, async (req, res) => {
  const id = req.params.id;
  await prisma.project.update({
    where: { id },
    data: { isActive: false },
  });
  res.status(204).end();
});

// ----- Premium-pay rules -------------------------------------------------

const PremiumPayRuleSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(120),
  kind: z.enum([
    'OVERTIME_DAILY',
    'OVERTIME_WEEKLY',
    'NIGHT_DIFFERENTIAL',
    'WEEKEND_DIFFERENTIAL',
    'HOLIDAY',
    'SHIFT_DIFFERENTIAL',
    'CALL_BACK',
    'ON_CALL',
  ]),
  multiplier: z.number().positive().nullable().optional(),
  addPerHour: z.number().nonnegative().nullable().optional(),
  thresholdHours: z.number().nonnegative().nullable().optional(),
  startMinute: z.number().int().min(0).max(1440).nullable().optional(),
  endMinute: z.number().int().min(0).max(1440).nullable().optional(),
  dowMask: z.number().int().min(0).max(127).nullable().optional(),
  isActive: z.boolean().optional(),
});

projectsAndPayRouter.get('/premium-pay-rules', VIEW_PAY, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.premiumPayRule.findMany({
    take: 1000,
    where: clientId ? { clientId } : {},
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
  res.json({
    rules: rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      name: r.name,
      kind: r.kind,
      multiplier: r.multiplier?.toFixed(2) ?? null,
      addPerHour: r.addPerHour?.toFixed(2) ?? null,
      thresholdHours: r.thresholdHours?.toFixed(2) ?? null,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      dowMask: r.dowMask,
      isActive: r.isActive,
    })),
  });
});

projectsAndPayRouter.post('/premium-pay-rules', PROCESS_PAY, async (req, res) => {
  const input = PremiumPayRuleSchema.parse(req.body);
  if (input.multiplier == null && input.addPerHour == null) {
    throw new HttpError(
      400,
      'no_modifier',
      'Rule must specify multiplier and/or addPerHour.',
    );
  }
  const created = await prisma.premiumPayRule.create({
    data: {
      clientId: input.clientId,
      name: input.name,
      kind: input.kind,
      multiplier: input.multiplier != null ? new Prisma.Decimal(input.multiplier) : null,
      addPerHour: input.addPerHour != null ? new Prisma.Decimal(input.addPerHour) : null,
      thresholdHours:
        input.thresholdHours != null ? new Prisma.Decimal(input.thresholdHours) : null,
      startMinute: input.startMinute ?? null,
      endMinute: input.endMinute ?? null,
      dowMask: input.dowMask ?? null,
      isActive: input.isActive ?? true,
    },
  });
  res.status(201).json({ id: created.id });
});

projectsAndPayRouter.put(
  '/premium-pay-rules/:id',
  PROCESS_PAY,
  async (req, res) => {
    const id = req.params.id;
    const input = PremiumPayRuleSchema.partial().parse(req.body);
    await prisma.premiumPayRule.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        kind: input.kind ?? undefined,
        multiplier:
          input.multiplier === undefined
            ? undefined
            : input.multiplier === null
              ? null
              : new Prisma.Decimal(input.multiplier),
        addPerHour:
          input.addPerHour === undefined
            ? undefined
            : input.addPerHour === null
              ? null
              : new Prisma.Decimal(input.addPerHour),
        thresholdHours:
          input.thresholdHours === undefined
            ? undefined
            : input.thresholdHours === null
              ? null
              : new Prisma.Decimal(input.thresholdHours),
        startMinute: input.startMinute === undefined ? undefined : input.startMinute,
        endMinute: input.endMinute === undefined ? undefined : input.endMinute,
        dowMask: input.dowMask === undefined ? undefined : input.dowMask,
        isActive: input.isActive ?? undefined,
      },
    });
    res.json({ ok: true });
  },
);

projectsAndPayRouter.delete(
  '/premium-pay-rules/:id',
  PROCESS_PAY,
  async (req, res) => {
    await prisma.premiumPayRule.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.status(204).end();
  },
);

// ----- Tip pools ---------------------------------------------------------

const TipPoolCreateSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(120),
  shiftDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalAmount: z.number().nonnegative(),
  notes: z.string().max(2000).optional().nullable(),
});

const AllocationCreateSchema = z.object({
  associateId: z.string().uuid(),
  hoursWorked: z.number().nonnegative().optional(),
  sharePct: z.number().min(0).max(100).optional(),
  amount: z.number().nonnegative(),
});

projectsAndPayRouter.get('/tip-pools', VIEW_PAY, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.tipPool.findMany({
    where: clientId ? { clientId } : {},
    include: { _count: { select: { allocations: true } } },
    orderBy: [{ shiftDate: 'desc' }],
    take: 100,
  });
  res.json({
    pools: rows.map((p) => ({
      id: p.id,
      clientId: p.clientId,
      name: p.name,
      shiftDate: p.shiftDate.toISOString().slice(0, 10),
      totalAmount: p.totalAmount.toFixed(2),
      currency: p.currency,
      status: p.status,
      notes: p.notes,
      closedAt: p.closedAt?.toISOString() ?? null,
      paidOutAt: p.paidOutAt?.toISOString() ?? null,
      allocationCount: p._count.allocations,
    })),
  });
});

projectsAndPayRouter.post('/tip-pools', PROCESS_PAY, async (req, res) => {
  const input = TipPoolCreateSchema.parse(req.body);
  const created = await prisma.tipPool.create({
    data: {
      clientId: input.clientId,
      name: input.name,
      shiftDate: new Date(input.shiftDate),
      totalAmount: new Prisma.Decimal(input.totalAmount),
      notes: input.notes ?? null,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

projectsAndPayRouter.get(
  '/tip-pools/:id/allocations',
  VIEW_PAY,
  async (req, res) => {
    const tipPoolId = req.params.id;
    const rows = await prisma.tipPoolAllocation.findMany({
      take: 500,
      where: { tipPoolId },
      include: {
        associate: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { amount: 'desc' },
    });
    res.json({
      allocations: rows.map((a) => ({
        id: a.id,
        associateId: a.associateId,
        associateName: `${a.associate.firstName} ${a.associate.lastName}`,
        hoursWorked: a.hoursWorked.toFixed(2),
        sharePct: a.sharePct?.toFixed(3) ?? null,
        amount: a.amount.toFixed(2),
      })),
    });
  },
);

projectsAndPayRouter.post(
  '/tip-pools/:id/allocations',
  PROCESS_PAY,
  async (req, res) => {
    const tipPoolId = req.params.id;
    const input = AllocationCreateSchema.parse(req.body);
    const pool = await prisma.tipPool.findUnique({ where: { id: tipPoolId } });
    if (!pool) throw new HttpError(404, 'not_found', 'Pool not found.');
    if (pool.status !== 'OPEN') {
      throw new HttpError(400, 'pool_locked', 'Pool is no longer open.');
    }
    await prisma.tipPoolAllocation.upsert({
      where: {
        tipPoolId_associateId: { tipPoolId, associateId: input.associateId },
      },
      create: {
        tipPoolId,
        associateId: input.associateId,
        hoursWorked: new Prisma.Decimal(input.hoursWorked ?? 0),
        sharePct: input.sharePct != null ? new Prisma.Decimal(input.sharePct) : null,
        amount: new Prisma.Decimal(input.amount),
      },
      update: {
        hoursWorked:
          input.hoursWorked !== undefined ? new Prisma.Decimal(input.hoursWorked) : undefined,
        sharePct: input.sharePct != null ? new Prisma.Decimal(input.sharePct) : undefined,
        amount: new Prisma.Decimal(input.amount),
      },
    });
    res.status(201).json({ ok: true });
  },
);

/**
 * Auto-distribute the pool's remaining-to-allocate amount by hours-worked
 * across associates who clocked in/out within the [from, to) window. Last
 * recipient absorbs rounding so the sum exactly matches totalAmount.
 */
projectsAndPayRouter.post(
  '/tip-pools/:id/auto-allocate-by-hours',
  PROCESS_PAY,
  async (req, res) => {
    const tipPoolId = req.params.id;
    const input = z
      .object({
        from: z.string().datetime(),
        to: z.string().datetime(),
      })
      .parse(req.body);
    const pool = await prisma.tipPool.findUnique({ where: { id: tipPoolId } });
    if (!pool) throw new HttpError(404, 'not_found', 'Pool not found.');
    if (pool.status !== 'OPEN') {
      throw new HttpError(400, 'pool_locked', 'Pool is no longer open.');
    }
    const entries = await prisma.timeEntry.findMany({
      take: 100,
      where: {
        clientId: pool.clientId,
        clockInAt: { gte: new Date(input.from), lt: new Date(input.to) },
        clockOutAt: { not: null },
      },
      select: { associateId: true, clockInAt: true, clockOutAt: true },
    });
    if (entries.length === 0) {
      throw new HttpError(400, 'no_hours', 'No completed time entries in window.');
    }
    // Sum hours per associate.
    const hoursMap = new Map<string, number>();
    for (const e of entries) {
      if (!e.clockOutAt) continue;
      const hrs = (e.clockOutAt.getTime() - e.clockInAt.getTime()) / 1000 / 3600;
      hoursMap.set(e.associateId, (hoursMap.get(e.associateId) ?? 0) + hrs);
    }
    const totalHours = Array.from(hoursMap.values()).reduce((a, b) => a + b, 0);
    if (totalHours === 0) {
      throw new HttpError(400, 'zero_hours', 'No hours to weight by.');
    }
    const totalCents = Math.round(Number(pool.totalAmount) * 100);
    const associates = Array.from(hoursMap.entries());
    let allocated = 0;
    await prisma.$transaction(async (tx) => {
      // Wipe any prior allocations on this pool — auto-allocate is idempotent.
      await tx.tipPoolAllocation.deleteMany({ where: { tipPoolId } });
      for (let i = 0; i < associates.length; i++) {
        const [associateId, hrs] = associates[i];
        const isLast = i === associates.length - 1;
        const cents = isLast
          ? totalCents - allocated
          : Math.floor((hrs / totalHours) * totalCents);
        allocated += cents;
        const sharePct = (hrs / totalHours) * 100;
        await tx.tipPoolAllocation.create({
          data: {
            tipPoolId,
            associateId,
            hoursWorked: new Prisma.Decimal(hrs.toFixed(2)),
            sharePct: new Prisma.Decimal(sharePct.toFixed(3)),
            amount: new Prisma.Decimal((cents / 100).toFixed(2)),
          },
        });
      }
    });
    res.json({ allocated: associates.length, totalHours });
  },
);

projectsAndPayRouter.put(
  '/tip-pools/:id/close',
  PROCESS_PAY,
  async (req, res) => {
    const tipPoolId = req.params.id;
    const pool = await prisma.tipPool.findUnique({
      where: { id: tipPoolId },
      include: { allocations: true },
    });
    if (!pool) throw new HttpError(404, 'not_found', 'Pool not found.');
    const allocSum = pool.allocations.reduce(
      (a, b) => a + Number(b.amount),
      0,
    );
    if (Math.abs(allocSum - Number(pool.totalAmount)) > 0.01) {
      throw new HttpError(
        400,
        'allocation_mismatch',
        `Allocations sum to ${allocSum.toFixed(2)} but pool total is ${pool.totalAmount.toFixed(2)}.`,
      );
    }
    await prisma.tipPool.update({
      where: { id: tipPoolId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    res.json({ ok: true });
  },
);

projectsAndPayRouter.put(
  '/tip-pools/:id/pay-out',
  PROCESS_PAY,
  async (req, res) => {
    const tipPoolId = req.params.id;
    await prisma.tipPool.update({
      where: { id: tipPoolId },
      data: { status: 'PAID_OUT', paidOutAt: new Date() },
    });
    res.json({ ok: true });
  },
);
