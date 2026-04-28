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
import { enqueueAudit } from '../lib/audit.js';

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
    clientId: row.clientId,
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
    notes: row.notes,
  };
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
    deletedAt: null,
    ...(clientId ? { clientId } : {}),
    ...(status ? { status: status as Position['status'] } : {}),
  };
  const rows = await prisma.position.findMany({
    where,
    include: POS_INCLUDE,
    orderBy: [{ status: 'asc' }, { code: 'asc' }],
  });
  const body = PositionListResponseSchema.parse({
    positions: rows.map(shape),
  });
  res.json(body);
});

positionsRouter.get(
  '/headcount',
  VIEW,
  async (req: Request, res: Response) => {
    const clientId =
      typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
    const where = {
      deletedAt: null,
      ...(clientId ? { clientId } : {}),
    };
    const groups = await prisma.position.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { fteAuthorized: true },
    });
    const filledFte = await prisma.position.aggregate({
      where: { ...where, status: 'FILLED' },
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
      notes: input.notes === undefined ? undefined : input.notes,
    },
    include: POS_INCLUDE,
  });
  await audit(req, 'position.update', id, {});
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
    if (status === 'OPEN') {
      await emitWorkflow({
        trigger: 'POSITION_OPENED',
        entityType: 'Position',
        entityId: id,
        clientId: updated.clientId,
        context: {
          position: { id: updated.id, code: updated.code, title: updated.title },
        },
      });
    }
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
