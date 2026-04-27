import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 115 — Succession planning.
 *
 * Per-position bench of Associates flagged as ready to step in. Reuses
 * view:performance / manage:performance caps — succession is owned by HR
 * and senior managers, same audience as PIPs and 360s.
 *
 * Mutations are strictly scoped: HR_ADMIN + EXECUTIVE_CHAIRMAN can edit
 * the entire org's plan; managers (manage:performance is the gate) can
 * write but the route does not narrow further today — this is consistent
 * with how Phase 84 handles PIPs/360s.
 */

export const succession115Router = Router();

const VIEW = requireCapability('view:performance');
const MANAGE = requireCapability('manage:performance');

const READINESS = z.enum([
  'READY_NOW',
  'READY_1_2_YEARS',
  'READY_3_PLUS_YEARS',
  'EMERGENCY_COVER',
] as const);

// ----- List positions with successor counts --------------------------------

succession115Router.get('/succession/positions', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const positions = await prisma.position.findMany({
    where: {
      deletedAt: null,
      ...(clientId ? { clientId } : {}),
    },
    include: {
      client: { select: { name: true } },
      department: { select: { name: true } },
      filledBy: { select: { id: true, firstName: true, lastName: true } },
      _count: { select: { successionPlan: true } },
    },
    orderBy: [{ clientId: 'asc' }, { title: 'asc' }],
  });
  res.json({
    positions: positions.map((p) => ({
      id: p.id,
      code: p.code,
      title: p.title,
      status: p.status,
      clientId: p.clientId,
      clientName: p.client?.name ?? null,
      departmentName: p.department?.name ?? null,
      incumbent: p.filledBy
        ? {
            id: p.filledBy.id,
            name: `${p.filledBy.firstName} ${p.filledBy.lastName}`,
          }
        : null,
      successorCount: p._count.successionPlan,
    })),
  });
});

// ----- Per-position candidate list -----------------------------------------

succession115Router.get(
  '/succession/positions/:id/candidates',
  VIEW,
  async (req, res) => {
    const positionId = z.string().uuid().parse(req.params.id);
    const position = await prisma.position.findUnique({
      where: { id: positionId },
      include: {
        client: { select: { name: true } },
        filledBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!position || position.deletedAt) {
      throw new HttpError(404, 'not_found', 'Position not found.');
    }
    const candidates = await prisma.successionCandidate.findMany({
      where: { positionId },
      include: {
        associate: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            jobProfile: { select: { title: true } },
          },
        },
      },
      orderBy: [{ readiness: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({
      position: {
        id: position.id,
        title: position.title,
        code: position.code,
        clientName: position.client?.name ?? null,
        incumbent: position.filledBy
          ? {
              id: position.filledBy.id,
              name: `${position.filledBy.firstName} ${position.filledBy.lastName}`,
            }
          : null,
      },
      candidates: candidates.map((c) => ({
        id: c.id,
        associateId: c.associateId,
        associateName: `${c.associate.firstName} ${c.associate.lastName}`,
        associateEmail: c.associate.email,
        currentTitle: c.associate.jobProfile?.title ?? null,
        readiness: c.readiness,
        notes: c.notes,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  },
);

// ----- "What positions am I a successor for?" ------------------------------

succession115Router.get(
  '/succession/by-associate/:associateId',
  VIEW,
  async (req, res) => {
    const associateId = z.string().uuid().parse(req.params.associateId);
    const rows = await prisma.successionCandidate.findMany({
      where: { associateId },
      include: {
        position: {
          select: {
            id: true,
            title: true,
            code: true,
            client: { select: { name: true } },
          },
        },
      },
      orderBy: { readiness: 'asc' },
    });
    res.json({
      candidacies: rows.map((c) => ({
        id: c.id,
        positionId: c.positionId,
        positionTitle: c.position.title,
        positionCode: c.position.code,
        clientName: c.position.client?.name ?? null,
        readiness: c.readiness,
        notes: c.notes,
      })),
    });
  },
);

// ----- Create / update / remove --------------------------------------------

const CreateInputSchema = z.object({
  positionId: z.string().uuid(),
  associateId: z.string().uuid(),
  readiness: READINESS,
  notes: z.string().max(2000).optional().nullable(),
});

succession115Router.post(
  '/succession/candidates',
  MANAGE,
  async (req, res) => {
    const input = CreateInputSchema.parse(req.body);
    const [position, associate] = await Promise.all([
      prisma.position.findUnique({ where: { id: input.positionId } }),
      prisma.associate.findUnique({ where: { id: input.associateId } }),
    ]);
    if (!position || position.deletedAt) {
      throw new HttpError(404, 'position_not_found', 'Position not found.');
    }
    if (!associate || associate.deletedAt) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found.');
    }
    if (associate.id === position.filledByAssociateId) {
      throw new HttpError(
        409,
        'is_incumbent',
        'This associate currently fills the position.',
      );
    }
    try {
      const created = await prisma.successionCandidate.create({
        data: {
          positionId: input.positionId,
          associateId: input.associateId,
          readiness: input.readiness,
          notes: input.notes ?? null,
          createdById: req.user!.id,
        },
      });
      res.status(201).json({ id: created.id });
    } catch (err: unknown) {
      // Unique violation on (positionId, associateId).
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new HttpError(
          409,
          'already_designated',
          'This associate is already a successor for this position.',
        );
      }
      throw err;
    }
  },
);

const UpdateInputSchema = z.object({
  readiness: READINESS.optional(),
  notes: z.string().max(2000).optional().nullable(),
});

succession115Router.patch(
  '/succession/candidates/:id',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = UpdateInputSchema.parse(req.body);
    const existing = await prisma.successionCandidate.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Candidate not found.');
    }
    await prisma.successionCandidate.update({
      where: { id },
      data: {
        ...(input.readiness ? { readiness: input.readiness } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
    res.json({ ok: true });
  },
);

succession115Router.delete(
  '/succession/candidates/:id',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const existing = await prisma.successionCandidate.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Candidate not found.');
    }
    await prisma.successionCandidate.delete({ where: { id } });
    res.status(204).end();
  },
);

// ----- Org-wide readiness rollup -------------------------------------------

succession115Router.get('/succession/summary', VIEW, async (_req, res) => {
  const positions = await prisma.position.count({ where: { deletedAt: null } });
  const positionsWithSuccessor = await prisma.position.count({
    where: { deletedAt: null, successionPlan: { some: {} } },
  });
  const byReadiness = await prisma.successionCandidate.groupBy({
    by: ['readiness'],
    _count: { _all: true },
  });
  const counts: Record<string, number> = {
    READY_NOW: 0,
    READY_1_2_YEARS: 0,
    READY_3_PLUS_YEARS: 0,
    EMERGENCY_COVER: 0,
  };
  for (const r of byReadiness) {
    counts[r.readiness] = r._count._all;
  }
  res.json({
    positionCount: positions,
    positionsWithSuccessor,
    coverage:
      positions === 0
        ? 0
        : Math.round((positionsWithSuccessor / positions) * 1000) / 10,
    byReadiness: counts,
  });
});
