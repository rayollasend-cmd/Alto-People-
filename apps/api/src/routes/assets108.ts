import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { notifyAssociate } from '../lib/notify.js';
import { internalSites, scopeAssociates } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { dateColumnKey } from '../lib/timezone.js';

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

/** Rows a list draws; more than this says so (`truncated`). */
const ASSET_PAGE = 2000;

/** A holder who has left: a separation is recorded or the record was erased (lib/peopleStatus). */
const LEFT: Prisma.AssociateWhereInput = { OR: [{ separatedAt: { not: null } }, { erasedAt: { not: null } }] };
const ASSIGNMENT_PAGE = 1000;

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

const ALL_KINDS = ['LAPTOP', 'PHONE', 'TABLET', 'DEVICE', 'BADGE', 'KEY', 'PPE', 'UNIFORM', 'VEHICLE', 'OTHER'] as const;
const ALL_STATUSES = ['AVAILABLE', 'ASSIGNED', 'RETIRED', 'LOST', 'IN_REPAIR'] as const;

const AssetInputSchema = z.object({
  kind: z.enum(ALL_KINDS),
  label: z.string().min(1).max(120),
  serial: z.string().max(120).optional().nullable(),
  model: z.string().max(120).optional().nullable(),
  purchasedAt: z.string().date().optional().nullable(),
  purchasePrice: z.number().nonnegative().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  /** The store it's kept at (badges, keys, PPE on site). */
  locationId: z.string().uuid().optional().nullable(),
});

/** A store named on an asset must be the caller's organization's (and within their reach). */
async function assertStore(user: Parameters<typeof internalSites>[0], locationId: string | null | undefined) {
  if (!locationId) return;
  const reach = internalSites(user);
  const ok = await prisma.site.findFirst({ where: { AND: [{ id: locationId, tenantId: tenantIdForWrite(), deletedAt: null }, reach ?? {}] }, select: { id: true } });
  if (!ok) throw new HttpError(404, 'store_not_found', 'No such store in your reach.');
}

assetsRouter.get('/assets', VIEW, async (req, res) => {
  const status = z.enum(ALL_STATUSES).optional().parse(req.query.status);
  const kind = z.enum(ALL_KINDS).optional().parse(req.query.kind);
  const locationId = z.string().uuid().optional().parse(req.query.locationId);
  const reach = internalSites(req.user!);
  // Everything the caller may see: their tenant, and for a site-scoped
  // lead, assets kept at their stores, held by their people, or unassigned
  // stock with no store.
  const inReach: Prisma.AssetWhereInput = {
    AND: [
      { tenantId: tenantIdForWrite() },
      reach
        ? {
            OR: [
              { location: { is: reach } },
              { locationId: null, assignments: { some: { returnedAt: null, associate: scopeAssociates(req.user!) } } },
              { locationId: null, assignments: { none: { returnedAt: null } } },
            ],
          }
        : {},
    ],
  };
  const fetched = await prisma.asset.findMany({
    take: ASSET_PAGE + 1,
    where: {
      AND: [inReach, status ? { status } : {}, kind ? { kind } : {}, locationId ? { locationId } : {}],
    },
    include: {
      location: { select: { id: true, name: true, client: { select: { name: true } } } },
      assignments: {
        where: { returnedAt: null },
        include: {
          associate: { select: { id: true, firstName: true, lastName: true, separatedAt: true, erasedAt: true } },
        },
        take: 1,
      },
    },
    orderBy: [{ kind: 'asc' }, { label: 'asc' }, { id: 'asc' }],
  });
  // The numbers that matter for the role (F500 G2), over everything in
  // reach (not the page's filters): by status, and the asset-recovery
  // view — kit still out with someone who has left.
  const [byStatus, heldByLeavers] = await Promise.all([
    prisma.asset.groupBy({ by: ['status'], where: inReach, _count: { _all: true } }),
    prisma.asset.count({
      where: {
        AND: [inReach, { assignments: { some: { returnedAt: null, associate: LEFT } } }],
      },
    }),
  ]);
  const countOf = (st: string) => byStatus.find((g) => g.status === st)?._count._all ?? 0;
  const truncated = fetched.length > ASSET_PAGE;
  const rows = truncated ? fetched.slice(0, ASSET_PAGE) : fetched;
  res.json({
    truncated,
    summary: {
      assigned: countOf('ASSIGNED'),
      available: countOf('AVAILABLE'),
      inRepair: countOf('IN_REPAIR'),
      lost: countOf('LOST'),
      heldByLeavers,
    },
    assets: rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      label: a.label,
      serial: a.serial,
      model: a.model,
      status: a.status,
      purchasedAt: a.purchasedAt ? dateColumnKey(a.purchasedAt) : null,
      purchasePrice: a.purchasePrice?.toString() ?? null,
      notes: a.notes,
      locationId: a.locationId,
      storeName: a.location?.name ?? null,
      clientName: a.location?.client?.name ?? null,
      currentAssignment: a.assignments[0]
        ? {
            id: a.assignments[0].id,
            associateId: a.assignments[0].associate.id,
            associateName: `${a.assignments[0].associate.firstName} ${a.assignments[0].associate.lastName}`,
            assignedAt: a.assignments[0].assignedAt.toISOString(),
            holderLeft: !!(a.assignments[0].associate.separatedAt || a.assignments[0].associate.erasedAt),
          }
        : null,
      createdAt: a.createdAt.toISOString(),
    })),
  });
});

assetsRouter.post('/assets', MANAGE, async (req, res) => {
  const input = AssetInputSchema.parse(req.body);
  await assertStore(req.user!, input.locationId);
  try {
    const created = await prisma.asset.create({
      data: {
        tenantId: tenantIdForWrite(),
        locationId: input.locationId ?? null,
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
  const existing = await prisma.asset.findFirst({ where: { id: String(req.params.id), tenantId: tenantIdForWrite() }, select: { id: true } });
  if (!existing) throw new HttpError(404, 'not_found', 'Asset not found.');
  await assertStore(req.user!, input.locationId);
  await prisma.asset.update({
    where: { id: existing.id },
    data: {
      ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
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
  const assigned = await prisma.$transaction(async (tx) => {
    // Asset must be AVAILABLE — block double-assigning even if the
    // partial unique would also catch it.
    const asset = await tx.asset.findUnique({
      where: { id: input.assetId },
      select: { status: true, kind: true, label: true, serial: true },
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
    return asset;
  });
  void notifyAssociate(input.associateId, {
    subject: 'An asset was assigned to you',
    body: `${assigned.label} (${assigned.kind}${assigned.serial ? `, serial ${assigned.serial}` : ''}). Please confirm receipt with your manager.`,
    category: 'assets',
    linkUrl: '/me',
    emailFallback: true,
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
  const fetched = await prisma.assetAssignment.findMany({
    where: {
      AND: [
        { tenantId: tenantIdForWrite() },
        associateId ? { associateId } : {},
        assetId ? { assetId } : {},
        // Former holders stay (recovery is the point); out-of-reach people don't.
        { associate: scopeAssociates(req.user!) },
      ],
    },
    include: {
      asset: { select: { kind: true, label: true, serial: true } },
      associate: { select: { firstName: true, lastName: true } },
    },
    orderBy: [{ assignedAt: 'desc' }, { id: 'asc' }],
    take: ASSIGNMENT_PAGE + 1,
  });
  const truncated = fetched.length > ASSIGNMENT_PAGE;
  const rows = truncated ? fetched.slice(0, ASSIGNMENT_PAGE) : fetched;
  res.json({
    truncated,
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
