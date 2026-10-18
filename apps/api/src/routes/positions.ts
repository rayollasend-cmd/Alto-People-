import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  PositionAssignInputSchema,
  PositionInputSchema,
  PositionListResponseSchema,
  PositionStatusInputSchema,
  type Position,
  type PositionHeadcount,
} from '@alto-people/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { emit as emitWorkflow } from '../lib/workflow.js';
import { emitWebhookEvent } from '../lib/webhookDispatch.js';
import { enqueueAudit } from '../lib/audit.js';
import { pendingResponse } from '../lib/approvalRequests.js';
import { requestOpenPosition } from '../lib/requisitions.js';
import { deciderFrom } from './approvalRequests.js';
import { notifyAssociate, notifyManager } from '../lib/notify.js';
import { scopePositions } from '../lib/scope.js';

const POSITIONS_CAP = 1000;

export const positionsRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

function audit(
  req: Request,
  action: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
): void {
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action,
      entityType: 'Position',
      entityId,
      metadata: {
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ...metadata,
      },
    },
    `positions.${action}`
  );
}

function shape(
  row: Prisma.PositionGetPayload<{
    include: {
      jobProfile: { select: { title: true } };
      department: { select: { name: true } };
      costCenter: { select: { code: true } };
      manager: { select: { firstName: true; lastName: true } };
      filledBy: { select: { firstName: true; lastName: true } };
    };
  }>,
): Position {
  return {
    id: row.id,
    // A direct employer's position names no client; the contract still says string.
    clientId: row.clientId ?? '',
    code: row.code,
    title: row.title,
    jobProfileId: row.jobProfileId,
    jobProfileTitle: row.jobProfile?.title ?? null,
    departmentId: row.departmentId,
    departmentName: row.department?.name ?? null,
    costCenterId: row.costCenterId,
    costCenterCode: row.costCenter?.code ?? null,
    managerAssociateId: row.managerAssociateId,
    managerName: row.manager
      ? `${row.manager.firstName} ${row.manager.lastName}`.trim()
      : null,
    fteAuthorized: row.fteAuthorized.toString(),
    status: row.status,
    filledByAssociateId: row.filledByAssociateId,
    filledByName: row.filledBy
      ? `${row.filledBy.firstName} ${row.filledBy.lastName}`.trim()
      : null,
    filledAt: row.filledAt?.toISOString() ?? null,
    targetStartDate: row.targetStartDate
      ? row.targetStartDate.toISOString().slice(0, 10)
      : null,
    minHourlyRate: row.minHourlyRate?.toString() ?? null,
    maxHourlyRate: row.maxHourlyRate?.toString() ?? null,
    budgetAmount: row.budgetAmount?.toString() ?? null,
    budgetPeriod: row.budgetPeriod === 'ANNUAL' || row.budgetPeriod === 'MONTHLY' ? row.budgetPeriod : null,
    notes: row.notes,
    requisition: requisitionOf(row),
  };
}

/** The requisition's standing, from the approval the position points at (filled in by withRequisitions). */
const requisitionStatus = new Map<string, Position['requisition']>();
function requisitionOf(row: { id: string; requisitionApprovalId: string | null }): Position['requisition'] {
  if (!row.requisitionApprovalId) return null;
  return requisitionStatus.get(row.id) ?? null;
}
/** Load the approval behind each position's requisition before shaping. */
async function withRequisitions<T extends { id: string; requisitionApprovalId: string | null }>(rows: T[]): Promise<T[]> {
  const ids = rows.map((r) => r.requisitionApprovalId).filter((x): x is string => !!x);
  if (ids.length === 0) return rows;
  const approvals = await prisma.approvalRequest.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
  const byId = new Map(approvals.map((a) => [a.id, a.status]));
  for (const r of rows) {
    const status = r.requisitionApprovalId ? byId.get(r.requisitionApprovalId) : undefined;
    if (status) requisitionStatus.set(r.id, { approvalId: r.requisitionApprovalId!, status });
  }
  return rows;
}

const POS_INCLUDE = {
  jobProfile: { select: { title: true } },
  department: { select: { name: true } },
  costCenter: { select: { code: true } },
  manager: { select: { firstName: true, lastName: true } },
  filledBy: { select: { firstName: true, lastName: true } },
} as const;

positionsRouter.get('/', VIEW, async (req: Request, res: Response) => {
  const clientId =
    typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const status =
    typeof req.query.status === 'string' ? req.query.status : undefined;
  const where: Prisma.PositionWhereInput = {
    AND: [
      scopePositions(req.user!),
      {
        deletedAt: null,
        ...(clientId ? { clientId } : {}),
        ...(status ? { status: status as Position['status'] } : {}),
      },
    ],
  };
  const found = await prisma.position.findMany({
    take: POSITIONS_CAP + 1,
    where,
    include: POS_INCLUDE,
    orderBy: [{ status: 'asc' }, { code: 'asc' }],
  });
  const rows = await withRequisitions(found.slice(0, POSITIONS_CAP));
  const body = PositionListResponseSchema.parse({
    positions: rows.map(shape),
    truncated: found.length > POSITIONS_CAP,
  });
  res.json(body);
});

positionsRouter.get(
  '/headcount',
  VIEW,
  async (req: Request, res: Response) => {
    const clientId =
      typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
    const where: Prisma.PositionWhereInput = {
      AND: [scopePositions(req.user!), { deletedAt: null, ...(clientId ? { clientId } : {}) }],
    };
    const groups = await prisma.position.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { fteAuthorized: true },
    });
    const filledFte = await prisma.position.aggregate({
      where: { AND: [where, { status: 'FILLED' }] },
      _sum: { fteAuthorized: true },
    });
    const total = groups.reduce((acc, g) => acc + g._count._all, 0);
    const byStatus: Record<string, number> = {
      PLANNED: 0,
      OPEN: 0,
      FILLED: 0,
      FROZEN: 0,
      CLOSED: 0,
    };
    for (const g of groups) byStatus[g.status] = g._count._all;
    const fteAuthorized = groups
      .reduce(
        (acc, g) =>
          acc.add(g._sum.fteAuthorized ?? new Prisma.Decimal(0)),
        new Prisma.Decimal(0),
      )
      .toString();
    const fteFilled = (filledFte._sum.fteAuthorized ?? new Prisma.Decimal(0))
      .toString();
    const body: PositionHeadcount = {
      total,
      byStatus: byStatus as PositionHeadcount['byStatus'],
      fteAuthorized,
      fteFilled,
    };
    res.json(body);
  },
);

/**
 * Headcount plan (HR pack 2026-10): every position's budget against what
 * the seat actually costs. Actual = the filled person's current pay,
 * annualized (hourly × 2080 × FTE; salary as is); paid = their gross pay on
 * finalized runs year to date. Variance is budget minus projected, so a
 * negative number is a seat running over its plan. Rolled up by department.
 */
positionsRouter.get('/plan', VIEW, async (req: Request, res: Response) => {
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const year = typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year) ? Number(req.query.year) : new Date().getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
  const PLAN_CAP = 2000;
  const found = await prisma.position.findMany({
    take: PLAN_CAP + 1,
    where: { AND: [scopePositions(req.user!), { deletedAt: null, status: { not: 'CLOSED' }, ...(clientId ? { clientId } : {}) }] },
    include: {
      ...POS_INCLUDE,
      filledBy: { select: { id: true, firstName: true, lastName: true, compRecords: { where: { effectiveTo: null }, take: 1, select: { payType: true, amount: true } } } },
    },
    orderBy: [{ department: { name: 'asc' } }, { code: 'asc' }],
  });
  const truncated = found.length > PLAN_CAP;
  const rows = found.slice(0, PLAN_CAP);
  const filledIds = rows.map((r) => r.filledByAssociateId).filter((x): x is string => Boolean(x));
  const paid = filledIds.length
    ? await prisma.payrollItem.groupBy({
        by: ['associateId'],
        where: { associateId: { in: filledIds }, payrollRun: { status: { in: ['FINALIZED', 'DISBURSED'] }, periodStart: { gte: yearStart, lt: yearEnd } } },
        _sum: { grossPay: true },
      })
    : [];
  const paidBy = new Map(paid.map((p) => [p.associateId, Number(p._sum.grossPay ?? 0)]));
  const annualBudget = (p: { budgetAmount: Prisma.Decimal | null; budgetPeriod: string | null }) =>
    p.budgetAmount == null ? null : p.budgetPeriod === 'MONTHLY' ? Number(p.budgetAmount) * 12 : Number(p.budgetAmount);
  const positions = rows.map((p) => {
    const comp = p.filledBy?.compRecords[0] ?? null;
    const fte = Number(p.fteAuthorized);
    const projected = comp ? (comp.payType === 'HOURLY' ? Number(comp.amount) * 2080 * fte : Number(comp.amount)) : null;
    const budget = annualBudget(p);
    return {
      id: p.id,
      code: p.code,
      title: p.title,
      status: p.status,
      departmentId: p.departmentId,
      departmentName: p.department?.name ?? null,
      fteAuthorized: p.fteAuthorized.toString(),
      filledByAssociateId: p.filledByAssociateId,
      filledByName: p.filledBy ? `${p.filledBy.firstName} ${p.filledBy.lastName}`.trim() : null,
      budgetAmount: p.budgetAmount?.toString() ?? null,
      budgetPeriod: p.budgetPeriod,
      annualBudget: budget,
      projectedAnnualCost: projected,
      paidYearToDate: p.filledByAssociateId ? (paidBy.get(p.filledByAssociateId) ?? 0) : 0,
      variance: budget != null && projected != null ? Math.round((budget - projected) * 100) / 100 : null,
    };
  });
  const byDept = new Map<string, { departmentId: string | null; departmentName: string; positions: number; filled: number; budget: number; projected: number; paidYearToDate: number; unbudgeted: number }>();
  for (const p of positions) {
    const key = p.departmentId ?? 'none';
    const d = byDept.get(key) ?? { departmentId: p.departmentId, departmentName: p.departmentName ?? 'No department', positions: 0, filled: 0, budget: 0, projected: 0, paidYearToDate: 0, unbudgeted: 0 };
    d.positions += 1;
    if (p.filledByAssociateId) d.filled += 1;
    if (p.annualBudget != null) d.budget += p.annualBudget;
    else d.unbudgeted += 1;
    if (p.projectedAnnualCost != null) d.projected += p.projectedAnnualCost;
    d.paidYearToDate += p.paidYearToDate;
    byDept.set(key, d);
  }
  const departments = [...byDept.values()].map((d) => ({ ...d, variance: Math.round((d.budget - d.projected) * 100) / 100 }));
  const totals = departments.reduce(
    (acc, d) => ({ positions: acc.positions + d.positions, filled: acc.filled + d.filled, budget: acc.budget + d.budget, projected: acc.projected + d.projected, paidYearToDate: acc.paidYearToDate + d.paidYearToDate, unbudgeted: acc.unbudgeted + d.unbudgeted }),
    { positions: 0, filled: 0, budget: 0, projected: 0, paidYearToDate: 0, unbudgeted: 0 },
  );
  res.json({ year, truncated, positions, departments, totals: { ...totals, variance: Math.round((totals.budget - totals.projected) * 100) / 100 } });
});

positionsRouter.post('/', MANAGE, async (req: Request, res: Response) => {
  const input = PositionInputSchema.parse(req.body);
  const dup = await prisma.position.findFirst({
    where: { clientId: input.clientId, code: input.code, deletedAt: null },
  });
  if (dup) {
    throw new HttpError(409, 'duplicate_code', 'Position code already in use.');
  }
  const created = await prisma.position.create({
    data: {
      clientId: input.clientId,
      code: input.code,
      title: input.title,
      jobProfileId: input.jobProfileId ?? null,
      departmentId: input.departmentId ?? null,
      costCenterId: input.costCenterId ?? null,
      managerAssociateId: input.managerAssociateId ?? null,
      fteAuthorized: input.fteAuthorized
        ? new Prisma.Decimal(input.fteAuthorized)
        : new Prisma.Decimal(1),
      status: input.status ?? 'PLANNED',
      targetStartDate: input.targetStartDate
        ? new Date(input.targetStartDate)
        : null,
      minHourlyRate:
        input.minHourlyRate == null
          ? null
          : new Prisma.Decimal(input.minHourlyRate),
      maxHourlyRate:
        input.maxHourlyRate == null
          ? null
          : new Prisma.Decimal(input.maxHourlyRate),
      budgetAmount: input.budgetAmount == null ? null : new Prisma.Decimal(input.budgetAmount),
      budgetPeriod: input.budgetPeriod ?? null,
      notes: input.notes ?? null,
    },
    include: POS_INCLUDE,
  });
  await audit(req, 'position.create', created.id, {
    code: created.code,
    clientId: created.clientId,
  });
  res.status(201).json(shape(created));
});

positionsRouter.put('/:id', MANAGE, async (req: Request, res: Response) => {
  const id = req.params.id;
  const input = PositionInputSchema.partial({ clientId: true }).parse(req.body);
  const existing = await prisma.position.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Position not found.');
  }
  const updated = await prisma.position.update({
    where: { id },
    data: {
      code: input.code ?? undefined,
      title: input.title ?? undefined,
      jobProfileId:
        input.jobProfileId === undefined ? undefined : input.jobProfileId,
      departmentId:
        input.departmentId === undefined ? undefined : input.departmentId,
      costCenterId:
        input.costCenterId === undefined ? undefined : input.costCenterId,
      managerAssociateId:
        input.managerAssociateId === undefined
          ? undefined
          : input.managerAssociateId,
      fteAuthorized:
        input.fteAuthorized === undefined
          ? undefined
          : new Prisma.Decimal(input.fteAuthorized),
      targetStartDate:
        input.targetStartDate === undefined
          ? undefined
          : input.targetStartDate
            ? new Date(input.targetStartDate)
            : null,
      minHourlyRate:
        input.minHourlyRate === undefined
          ? undefined
          : input.minHourlyRate == null
            ? null
            : new Prisma.Decimal(input.minHourlyRate),
      maxHourlyRate:
        input.maxHourlyRate === undefined
          ? undefined
          : input.maxHourlyRate == null
            ? null
            : new Prisma.Decimal(input.maxHourlyRate),
      budgetAmount:
        input.budgetAmount === undefined
          ? undefined
          : input.budgetAmount == null
            ? null
            : new Prisma.Decimal(input.budgetAmount),
      budgetPeriod: input.budgetPeriod === undefined ? undefined : input.budgetPeriod,
      notes: input.notes === undefined ? undefined : input.notes,
    },
    include: POS_INCLUDE,
  });
  await audit(req, 'position.update', id, {
    ...(input.budgetAmount !== undefined || input.budgetPeriod !== undefined
      ? { budgetAmount: input.budgetAmount ?? null, budgetPeriod: input.budgetPeriod ?? null, previousBudgetAmount: existing.budgetAmount?.toString() ?? null }
      : {}),
  });
  res.json(shape(updated));
});

positionsRouter.post(
  '/:id/status',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const { status } = PositionStatusInputSchema.parse(req.body);
    const existing = await prisma.position.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Position not found.');
    }
    if (status === 'FILLED' && !existing.filledByAssociateId) {
      throw new HttpError(
        400,
        'not_assigned',
        'Cannot mark FILLED without an assigned associate. Use POST /positions/:id/assign first.',
      );
    }
    if (status === 'OPEN') {
      // Requisition → approval → posting: a seat opens through the engine, which
      // carries its budget to a second manage:org holder where the tenant requires one.
      const pending = await requestOpenPosition(prisma, id, deciderFrom(req.user!));
      if (pending) {
        res.status(202).json(pendingResponse(pending));
        return;
      }
      const opened = await withRequisitions([await prisma.position.findUniqueOrThrow({ where: { id }, include: POS_INCLUDE })]);
      res.json(shape(opened[0]));
      return;
    }
    if (status !== 'FILLED' && existing.filledByAssociateId) {
      // Status moving away from FILLED → unassign first.
      await prisma.position.update({
        where: { id },
        data: { filledByAssociateId: null, filledAt: null },
      });
    }
    const updated = await prisma.position.update({
      where: { id },
      data: { status },
      include: POS_INCLUDE,
    });
    await audit(req, 'position.status', id, { from: existing.status, to: status });
    res.json(shape(updated));
  },
);

positionsRouter.post(
  '/:id/assign',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const input = PositionAssignInputSchema.parse(req.body);
    const existing = await prisma.position.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Position not found.');
    }
    if (existing.status === 'CLOSED' || existing.status === 'FROZEN') {
      throw new HttpError(
        400,
        'invalid_status',
        `Cannot assign while status is ${existing.status}.`,
      );
    }
    const associate = await prisma.associate.findUnique({
      where: { id: input.associateId },
      select: { id: true, deletedAt: true },
    });
    if (!associate || associate.deletedAt) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    const updated = await prisma.position.update({
      where: { id },
      data: {
        filledByAssociateId: input.associateId,
        filledAt: input.filledAt ? new Date(input.filledAt) : new Date(),
        status: 'FILLED',
      },
      include: POS_INCLUDE,
    });
    await audit(req, 'position.assign', id, {
      associateId: input.associateId,
    });
    // Phase 80 — fire workflows.
    await emitWorkflow({
      trigger: 'POSITION_FILLED',
      entityType: 'Position',
      entityId: id,
      clientId: updated.clientId,
      context: {
        position: { id: updated.id, code: updated.code, title: updated.title },
        associateId: input.associateId,
      },
    });
    void emitWebhookEvent(
      'position.filled',
      {
        positionId: updated.id,
        clientId: updated.clientId,
        code: updated.code,
        title: updated.title,
        associateId: input.associateId,
        filledAt: updated.filledAt?.toISOString() ?? null,
      },
      { clientId: updated.clientId },
    );
    // Fire-and-forget, after the write: tell the person and their
    // manager about the placement.
    void notifyAssociate(input.associateId, {
      subject: "You've been placed in a new position",
      body: `You now fill ${updated.code} · ${updated.title}. Open your profile for details.`,
      category: 'org',
      linkUrl: '/me',
    });
    void notifyManager(input.associateId, {
      subject: 'Position filled on your team',
      body: `${updated.code} · ${updated.title} is now filled${
        updated.filledBy
          ? ` by ${updated.filledBy.firstName} ${updated.filledBy.lastName}`
          : ''
      }.`,
      category: 'org',
      linkUrl: `/people?associateId=${input.associateId}`, // who was placed
    });
    res.json(shape(updated));
  },
);

positionsRouter.post(
  '/:id/vacate',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const existing = await prisma.position.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Position not found.');
    }
    const updated = await prisma.position.update({
      where: { id },
      data: {
        filledByAssociateId: null,
        filledAt: null,
        status: 'OPEN',
      },
      include: POS_INCLUDE,
    });
    await audit(req, 'position.vacate', id, {
      previouslyFilledBy: existing.filledByAssociateId,
    });
    res.json(shape(updated));
  },
);

positionsRouter.delete(
  '/:id',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const existing = await prisma.position.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Position not found.');
    }
    if (existing.status === 'FILLED') {
      throw new HttpError(
        400,
        'still_filled',
        'Vacate the position before closing.',
      );
    }
    await prisma.position.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await audit(req, 'position.delete', id, {});
    res.status(204).end();
  },
);
