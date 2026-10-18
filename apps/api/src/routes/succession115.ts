import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { assertSameTenant } from '../lib/sameTenant.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeActiveAssociates, scopePositions } from '../lib/scope.js';

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

// Succession plans are HR-admin org strategy — gate reads on
// view:hr-admin so associates with view:performance can't see
// who's been designated successor for every position.
const VIEW = requireCapability('view:hr-admin');
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
  const CAP = 1000;
  const found = await prisma.position.findMany({
    take: CAP + 1,
    // This tenant's seats in the caller's reach (lib/scope.scopePositions).
    where: { AND: [scopePositions(req.user!), clientId ? { clientId } : {}] },
    include: {
      client: { select: { name: true } },
      department: { select: { name: true } },
      filledBy: { select: { id: true, firstName: true, lastName: true } },
      _count: { select: { successionPlan: true } },
    },
    orderBy: [{ clientId: 'asc' }, { title: 'asc' }],
  });
  const positions = found.slice(0, CAP);
  res.json({
    truncated: found.length > CAP,
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
    const position = await prisma.position.findFirst({
      where: { AND: [{ id: positionId }, scopePositions(req.user!)] },
      include: {
        client: { select: { name: true } },
        filledBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!position) {
      throw new HttpError(404, 'not_found', 'Position not found.');
    }
    // Active people only: a former employee is nobody's successor.
    const candidates = await prisma.successionCandidate.findMany({
      take: 500,
      where: { positionId, associate: { is: scopeActiveAssociates(req.user!) } },
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
    await assertSameTenant('associate', associateId);
    const rows = await prisma.successionCandidate.findMany({
      take: 500,
      where: { associateId, associate: { is: scopeActiveAssociates(req.user!, { former: true }) }, position: { is: scopePositions(req.user!) } },
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
      prisma.position.findFirst({ where: { AND: [{ id: input.positionId }, scopePositions(req.user!)] } }),
      // A successor must be active, in this tenant and the caller's reach.
      prisma.associate.findFirst({ where: { AND: [{ id: input.associateId }, scopeActiveAssociates(req.user!)] } }),
    ]);
    if (!position) {
      throw new HttpError(404, 'position_not_found', 'Position not found.');
    }
    if (!associate) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found — they must be active and within your reach.');
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
    // Only a candidacy on a seat in the caller's reach.
    const existing = await prisma.successionCandidate.findFirst({
      where: { id, position: { is: scopePositions(req.user!) } },
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
    // Only a candidacy on a seat in the caller's reach.
    const existing = await prisma.successionCandidate.findFirst({
      where: { id, position: { is: scopePositions(req.user!) } },
    });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Candidate not found.');
    }
    await prisma.successionCandidate.delete({ where: { id } });
    res.status(204).end();
  },
);

// ----- Org-wide readiness rollup -------------------------------------------

succession115Router.get('/succession/summary', VIEW, async (req, res) => {
  const seats = scopePositions(req.user!);
  const positions = await prisma.position.count({ where: seats });
  const positionsWithSuccessor = await prisma.position.count({
    where: { AND: [seats, { successionPlan: { some: {} } }] },
  });
  const byReadiness = await prisma.successionCandidate.groupBy({
    by: ['readiness'],
    where: { position: { is: seats }, associate: { is: scopeActiveAssociates(req.user!) } },
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
