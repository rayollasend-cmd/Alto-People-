import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 108 — Asset tracking endpoints.
 *
 * Asset is the physical device. AssetAssignment is the audit trail of
 * who held it when. "Currently assigned" = the AssetAssignment row
 * with returnedAt IS NULL (enforced unique).
 *
 * Capability gating: reuses view:org / manage:org. These already exist
 * for the directory and are the natural home for HR-managed asset data.
 */

export const assetsRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

const ALL_KINDS = ['LAPTOP', 'PHONE', 'TABLET', 'BADGE', 'KEY', 'VEHICLE', 'UNIFORM', 'OTHER'] as const;
const ALL_STATUSES = ['AVAILABLE', 'ASSIGNED', 'RETIRED', 'LOST', 'IN_REPAIR'] as const;

const AssetInputSchema = z.object({
  kind: z.enum(ALL_KINDS),
  label: z.string().min(1).max(120),
  serial: z.string().max(120).optional().nullable(),
  model: z.string().max(120).optional().nullable(),
  purchasedAt: z.string().date().optional().nullable(),
  purchasePrice: z.number().nonnegative().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

assetsRouter.get('/assets', VIEW, async (req, res) => {
  const status = z.enum(ALL_STATUSES).optional().parse(req.query.status);
  const kind = z.enum(ALL_KINDS).optional().parse(req.query.kind);
  const rows = await prisma.asset.findMany({
    take: 1000,
    where: {
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
    },
    include: {
      assignments: {
        where: { returnedAt: null },
        include: {
          associate: { select: { id: true, firstName: true, lastName: true } },
        },
        take: 1,
      },
    },
    orderBy: [{ kind: 'asc' }, { label: 'asc' }],
  });
  res.json({
    assets: rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      label: a.label,
      serial: a.serial,
      model: a.model,
      status: a.status,
      purchasedAt: a.purchasedAt?.toISOString().slice(0, 10) ?? null,
      purchasePrice: a.purchasePrice?.toString() ?? null,
      notes: a.notes,
      currentAssignment: a.assignments[0]
        ? {
            id: a.assignments[0].id,
            associateId: a.assignments[0].associate.id,
            associateName: `${a.assignments[0].associate.firstName} ${a.assignments[0].associate.lastName}`,
            assignedAt: a.assignments[0].assignedAt.toISOString(),
          }
        : null,
      createdAt: a.createdAt.toISOString(),
    })),
  });
});

assetsRouter.post('/assets', MANAGE, async (req, res) => {
  const input = AssetInputSchema.parse(req.body);
  try {
    const created = await prisma.asset.create({
      data: {
        kind: input.kind,
        label: input.label,
        serial: input.serial ?? null,
        model: input.model ?? null,
        purchasedAt: input.purchasedAt ? new Date(input.purchasedAt) : null,
        purchasePrice: input.purchasePrice ?? null,
        notes: input.notes ?? null,
      },
    });
    res.status(201).json({ id: created.id });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new HttpError(
        409,
        'serial_taken',
        `Another ${input.kind} already uses that serial.`,
      );
    }
    throw err;
  }
});

assetsRouter.put('/assets/:id', MANAGE, async (req, res) => {
  const input = AssetInputSchema.partial().parse(req.body);
  await prisma.asset.update({
    where: { id: req.params.id },
    data: {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.label != null ? { label: input.label } : {}),
      ...(input.serial !== undefined ? { serial: input.serial } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.purchasedAt !== undefined
        ? { purchasedAt: input.purchasedAt ? new Date(input.purchasedAt) : null }
        : {}),
      ...(input.purchasePrice !== undefined
        ? { purchasePrice: input.purchasePrice }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
  res.json({ ok: true });
});

assetsRouter.delete('/assets/:id', MANAGE, async (req, res) => {
  await prisma.asset.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Assignments ------------------------------------------------------

const AssignSchema = z.object({
  assetId: z.string().uuid(),
  associateId: z.string().uuid(),
});

assetsRouter.post('/asset-assignments', MANAGE, async (req, res) => {
  const input = AssignSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    // Asset must be AVAILABLE — block double-assigning even if the
    // partial unique would also catch it.
    const asset = await tx.asset.findUnique({
      where: { id: input.assetId },
      select: { status: true },
    });
    if (!asset) throw new HttpError(404, 'not_found', 'Asset not found.');
    if (asset.status !== 'AVAILABLE') {
      throw new HttpError(
        409,
        'not_available',
        `Asset is ${asset.status}; return or repair before reassigning.`,
      );
    }
    await tx.assetAssignment.create({
      data: {
        assetId: input.assetId,
        associateId: input.associateId,
        assignedById: req.user!.id,
      },
    });
    await tx.asset.update({
      where: { id: input.assetId },
      data: { status: 'ASSIGNED' },
    });
  });
  res.status(201).json({ ok: true });
});

const ReturnSchema = z.object({
  notes: z.string().max(2000).optional(),
  /** Optional: mark asset LOST or IN_REPAIR instead of AVAILABLE on return. */
  newStatus: z.enum(['AVAILABLE', 'LOST', 'IN_REPAIR', 'RETIRED']).optional(),
});

assetsRouter.post(
  '/asset-assignments/:id/return',
  MANAGE,
  async (req, res) => {
    const input = ReturnSchema.parse(req.body);
    const assignment = await prisma.assetAssignment.findUnique({
      where: { id: req.params.id },
      select: { id: true, assetId: true, returnedAt: true },
    });
    if (!assignment) {
      throw new HttpError(404, 'not_found', 'Assignment not found.');
    }
    if (assignment.returnedAt) {
      throw new HttpError(
        409,
        'already_returned',
        'This assignment has already been returned.',
      );
    }
    await prisma.$transaction(async (tx) => {
      await tx.assetAssignment.update({
        where: { id: assignment.id },
        data: {
          returnedAt: new Date(),
          returnedById: req.user!.id,
          returnNotes: input.notes ?? null,
        },
      });
      await tx.asset.update({
        where: { id: assignment.assetId },
        data: { status: input.newStatus ?? 'AVAILABLE' },
      });
    });
    res.json({ ok: true });
  },
);

assetsRouter.get('/asset-assignments', VIEW, async (req, res) => {
  const associateId = z
    .string()
    .uuid()
    .optional()
    .parse(req.query.associateId);
  const assetId = z.string().uuid().optional().parse(req.query.assetId);
  const rows = await prisma.assetAssignment.findMany({
    where: {
      ...(associateId ? { associateId } : {}),
      ...(assetId ? { assetId } : {}),
    },
    include: {
      asset: { select: { kind: true, label: true, serial: true } },
      associate: { select: { firstName: true, lastName: true } },
    },
    orderBy: { assignedAt: 'desc' },
    take: 500,
  });
  res.json({
    assignments: rows.map((r) => ({
      id: r.id,
      assetId: r.assetId,
      assetKind: r.asset.kind,
      assetLabel: r.asset.label,
      assetSerial: r.asset.serial,
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      assignedAt: r.assignedAt.toISOString(),
      returnedAt: r.returnedAt?.toISOString() ?? null,
      returnNotes: r.returnNotes,
    })),
  });
});
