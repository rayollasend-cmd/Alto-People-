import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 83 — Compensation: history + bands + merit cycles.
 *
 * Endpoints
 *   GET    /comp/associates/:id/records       full effective-dated history
 *   GET    /comp/associates/:id/current       single row (effectiveTo IS NULL)
 *   POST   /comp/associates/:id/records       open a new record (closes current)
 *
 *   GET    /comp/bands?clientId
 *   POST   /comp/bands
 *   PUT    /comp/bands/:id
 *   DELETE /comp/bands/:id
 *
 *   GET    /comp/cycles?clientId
 *   POST   /comp/cycles
 *   POST   /comp/cycles/:id/proposals/seed    auto-create a proposal row
 *                                             for every active associate
 *   PUT    /comp/cycles/:id/proposals/:pid
 *   POST   /comp/cycles/:id/apply             write APPROVED proposals as
 *                                             new comp records, mark cycle
 *                                             APPLIED
 */

export const compensationRouter = Router();

// ----- helpers -----------------------------------------------------------

function shapeRecord(r: {
  id: string;
  associateId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  payType: 'HOURLY' | 'SALARY';
  amount: Prisma.Decimal;
  currency: string;
  reason: string;
  notes: string | null;
  meritProposalId: string | null;
}) {
  return {
    id: r.id,
    associateId: r.associateId,
    effectiveFrom: r.effectiveFrom.toISOString(),
    effectiveTo: r.effectiveTo?.toISOString() ?? null,
    payType: r.payType,
    amount: r.amount.toFixed(2),
    currency: r.currency,
    reason: r.reason,
    notes: r.notes,
    meritProposalId: r.meritProposalId,
  };
}

function shapeBand(b: {
  id: string;
  clientId: string;
  jobProfileId: string | null;
  name: string;
  level: string | null;
  payType: 'HOURLY' | 'SALARY';
  minAmount: Prisma.Decimal;
  midAmount: Prisma.Decimal;
  maxAmount: Prisma.Decimal;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  jobProfile?: { id: string; title: string } | null;
}) {
  return {
    id: b.id,
    clientId: b.clientId,
    jobProfileId: b.jobProfileId,
    jobProfileTitle: b.jobProfile?.title ?? null,
    name: b.name,
    level: b.level,
    payType: b.payType,
    minAmount: b.minAmount.toFixed(2),
    midAmount: b.midAmount.toFixed(2),
    maxAmount: b.maxAmount.toFixed(2),
    currency: b.currency,
    effectiveFrom: b.effectiveFrom.toISOString(),
    effectiveTo: b.effectiveTo?.toISOString() ?? null,
  };
}

// ----- /comp/associates/:id/records --------------------------------------

const RecordCreateSchema = z.object({
  effectiveFrom: z.string().datetime().optional(),
  payType: z.enum(['HOURLY', 'SALARY']),
  amount: z.number().positive(),
  reason: z.enum([
    'HIRE',
    'MERIT',
    'PROMOTION',
    'MARKET_ADJUSTMENT',
    'CORRECTION',
    'OTHER',
  ]),
  notes: z.string().max(2000).optional().nullable(),
});

compensationRouter.get(
  '/associates/:id/records',
  requireCapability('view:comp'),
  async (req, res) => {
    const associateId = req.params.id;
    const rows = await prisma.compensationRecord.findMany({
      where: { associateId },
      orderBy: { effectiveFrom: 'desc' },
    });
    res.json({ records: rows.map(shapeRecord) });
  },
);

compensationRouter.get(
  '/associates/:id/current',
  requireCapability('view:comp'),
  async (req, res) => {
    const associateId = req.params.id;
    const row = await prisma.compensationRecord.findFirst({
      where: { associateId, effectiveTo: null },
    });
    res.json({ record: row ? shapeRecord(row) : null });
  },
);

compensationRouter.post(
  '/associates/:id/records',
  requireCapability('manage:comp'),
  async (req, res) => {
    const associateId = req.params.id;
    const input = RecordCreateSchema.parse(req.body);
    const associate = await prisma.associate.findUnique({ where: { id: associateId } });
    if (!associate || associate.deletedAt) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    await prisma.$transaction(async (tx) => {
      await tx.compensationRecord.updateMany({
        where: { associateId, effectiveTo: null },
        data: { effectiveTo: effectiveFrom },
      });
      await tx.compensationRecord.create({
        data: {
          associateId,
          effectiveFrom,
          payType: input.payType,
          amount: new Prisma.Decimal(input.amount),
          reason: input.reason,
          notes: input.notes ?? null,
          actorUserId: req.user!.id,
        },
      });
    });
    res.status(201).json({ ok: true });
  },
);

// ----- /comp/bands -------------------------------------------------------

const BandInputSchema = z.object({
  clientId: z.string().uuid(),
  jobProfileId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  level: z.string().max(40).nullable().optional(),
  payType: z.enum(['HOURLY', 'SALARY']),
  minAmount: z.number().positive(),
  midAmount: z.number().positive(),
  maxAmount: z.number().positive(),
  currency: z.string().length(3).optional(),
  effectiveFrom: z.string().datetime().optional(),
});

compensationRouter.get(
  '/bands',
  requireCapability('view:comp'),
  async (req, res) => {
    const clientId = z.string().uuid().optional().parse(req.query.clientId);
    const rows = await prisma.compBand.findMany({
      where: {
        deletedAt: null,
        ...(clientId ? { clientId } : {}),
      },
      include: { jobProfile: { select: { id: true, title: true } } },
      orderBy: [{ name: 'asc' }],
    });
    res.json({ bands: rows.map(shapeBand) });
  },
);

compensationRouter.post(
  '/bands',
  requireCapability('manage:comp'),
  async (req, res) => {
    const input = BandInputSchema.parse(req.body);
    if (!(input.minAmount <= input.midAmount && input.midAmount <= input.maxAmount)) {
      throw new HttpError(400, 'invalid_range', 'min ≤ mid ≤ max required.');
    }
    const created = await prisma.compBand.create({
      data: {
        clientId: input.clientId,
        jobProfileId: input.jobProfileId ?? null,
        name: input.name,
        level: input.level ?? null,
        payType: input.payType,
        minAmount: new Prisma.Decimal(input.minAmount),
        midAmount: new Prisma.Decimal(input.midAmount),
        maxAmount: new Prisma.Decimal(input.maxAmount),
        currency: input.currency ?? 'USD',
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
      },
    });
    res.status(201).json({ id: created.id });
  },
);

compensationRouter.put(
  '/bands/:id',
  requireCapability('manage:comp'),
  async (req, res) => {
    const id = req.params.id;
    const input = BandInputSchema.partial().parse(req.body);
    if (
      input.minAmount !== undefined &&
      input.midAmount !== undefined &&
      input.maxAmount !== undefined &&
      !(input.minAmount <= input.midAmount && input.midAmount <= input.maxAmount)
    ) {
      throw new HttpError(400, 'invalid_range', 'min ≤ mid ≤ max required.');
    }
    const existing = await prisma.compBand.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Band not found.');
    }
    await prisma.compBand.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        level: input.level === undefined ? undefined : input.level,
        jobProfileId: input.jobProfileId === undefined ? undefined : input.jobProfileId,
        payType: input.payType ?? undefined,
        minAmount:
          input.minAmount !== undefined ? new Prisma.Decimal(input.minAmount) : undefined,
        midAmount:
          input.midAmount !== undefined ? new Prisma.Decimal(input.midAmount) : undefined,
        maxAmount:
          input.maxAmount !== undefined ? new Prisma.Decimal(input.maxAmount) : undefined,
        currency: input.currency ?? undefined,
      },
    });
    res.json({ ok: true });
  },
);

compensationRouter.delete(
  '/bands/:id',
  requireCapability('manage:comp'),
  async (req, res) => {
    const id = req.params.id;
    const existing = await prisma.compBand.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Band not found.');
    }
    await prisma.compBand.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  },
);

// ----- /comp/cycles ------------------------------------------------------

const CycleCreateSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(120),
  reviewPeriodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reviewPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  budget: z.number().positive().optional(),
});

const ProposalUpdateSchema = z.object({
  proposedAmount: z.number().positive().optional(),
  proposedNotes: z.string().max(2000).nullable().optional(),
  status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']).optional(),
  decisionNote: z.string().max(2000).nullable().optional(),
});

compensationRouter.get(
  '/cycles',
  requireCapability('view:comp'),
  async (req, res) => {
    const clientId = z.string().uuid().optional().parse(req.query.clientId);
    const rows = await prisma.meritCycle.findMany({
      where: clientId ? { clientId } : {},
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      cycles: rows.map((c) => ({
        id: c.id,
        clientId: c.clientId,
        name: c.name,
        status: c.status,
        reviewPeriodStart: c.reviewPeriodStart.toISOString().slice(0, 10),
        reviewPeriodEnd: c.reviewPeriodEnd.toISOString().slice(0, 10),
        effectiveDate: c.effectiveDate.toISOString().slice(0, 10),
        budget: c.budget?.toFixed(2) ?? null,
        appliedAt: c.appliedAt?.toISOString() ?? null,
      })),
    });
  },
);

compensationRouter.post(
  '/cycles',
  requireCapability('manage:comp'),
  async (req, res) => {
    const input = CycleCreateSchema.parse(req.body);
    const created = await prisma.meritCycle.create({
      data: {
        clientId: input.clientId,
        name: input.name,
        reviewPeriodStart: new Date(input.reviewPeriodStart),
        reviewPeriodEnd: new Date(input.reviewPeriodEnd),
        effectiveDate: new Date(input.effectiveDate),
        budget: input.budget ? new Prisma.Decimal(input.budget) : null,
      },
    });
    res.status(201).json({ id: created.id });
  },
);

compensationRouter.get(
  '/cycles/:id/proposals',
  requireCapability('view:comp'),
  async (req, res) => {
    const cycleId = req.params.id;
    const rows = await prisma.meritProposal.findMany({
      where: { cycleId },
      include: {
        associate: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ status: 'asc' }, { associate: { lastName: 'asc' } }],
    });
    res.json({
      proposals: rows.map((p) => ({
        id: p.id,
        cycleId: p.cycleId,
        associateId: p.associateId,
        associateName: `${p.associate.firstName} ${p.associate.lastName}`,
        currentAmount: p.currentAmount.toFixed(2),
        currentPayType: p.currentPayType,
        proposedAmount: p.proposedAmount.toFixed(2),
        proposedNotes: p.proposedNotes,
        status: p.status,
        decisionNote: p.decisionNote,
        decidedAt: p.decidedAt?.toISOString() ?? null,
      })),
    });
  },
);

/**
 * Seed a proposal row for every currently-active associate at this client
 * who doesn't already have one in the cycle. Uses each associate's current
 * comp record as the snapshot. Idempotent.
 */
compensationRouter.post(
  '/cycles/:id/proposals/seed',
  requireCapability('manage:comp'),
  async (req, res) => {
    const cycleId = req.params.id;
    const cycle = await prisma.meritCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) throw new HttpError(404, 'not_found', 'Cycle not found.');
    if (cycle.status !== 'DRAFT' && cycle.status !== 'OPEN') {
      throw new HttpError(400, 'wrong_state', 'Cycle is not editable.');
    }

    // All active associates with at least one current comp record. We can't
    // propose for someone whose comp baseline we don't know.
    const associates = await prisma.associate.findMany({
      where: {
        deletedAt: null,
        compRecords: { some: { effectiveTo: null } },
      },
      select: { id: true },
    });
    const existing = await prisma.meritProposal.findMany({
      where: { cycleId },
      select: { associateId: true },
    });
    const existingIds = new Set(existing.map((p) => p.associateId));

    let created = 0;
    for (const a of associates) {
      if (existingIds.has(a.id)) continue;
      const cur = await prisma.compensationRecord.findFirst({
        where: { associateId: a.id, effectiveTo: null },
      });
      if (!cur) continue;
      await prisma.meritProposal.create({
        data: {
          cycleId,
          associateId: a.id,
          currentAmount: cur.amount,
          currentPayType: cur.payType,
          proposedAmount: cur.amount, // default = no change; reviewer edits up
          proposedById: req.user!.id,
        },
      });
      created++;
    }

    if (cycle.status === 'DRAFT') {
      await prisma.meritCycle.update({
        where: { id: cycleId },
        data: { status: 'OPEN' },
      });
    }

    res.json({ created, total: associates.length });
  },
);

compensationRouter.put(
  '/cycles/:id/proposals/:pid',
  requireCapability('manage:comp'),
  async (req, res) => {
    const cycleId = req.params.id;
    const pid = req.params.pid;
    const input = ProposalUpdateSchema.parse(req.body);
    const proposal = await prisma.meritProposal.findUnique({ where: { id: pid } });
    if (!proposal || proposal.cycleId !== cycleId) {
      throw new HttpError(404, 'not_found', 'Proposal not found.');
    }
    if (proposal.status === 'APPLIED') {
      throw new HttpError(400, 'already_applied', 'Proposal is already applied.');
    }
    const decided = input.status === 'APPROVED' || input.status === 'REJECTED';
    await prisma.meritProposal.update({
      where: { id: pid },
      data: {
        proposedAmount:
          input.proposedAmount !== undefined
            ? new Prisma.Decimal(input.proposedAmount)
            : undefined,
        proposedNotes:
          input.proposedNotes === undefined ? undefined : input.proposedNotes,
        status: input.status ?? undefined,
        decisionNote:
          input.decisionNote === undefined ? undefined : input.decisionNote,
        decidedAt: decided ? new Date() : undefined,
        decidedById: decided ? req.user!.id : undefined,
      },
    });
    res.json({ ok: true });
  },
);

/**
 * Apply step: write every APPROVED proposal as a new comp record on the
 * cycle's effectiveDate. Skip proposals whose snapshot diverged from the
 * associate's current comp (somebody got an out-of-cycle adjustment) —
 * they get re-marked DRAFT and the cycle apply continues.
 */
compensationRouter.post(
  '/cycles/:id/apply',
  requireCapability('manage:comp'),
  async (req, res) => {
    const cycleId = req.params.id;
    const cycle = await prisma.meritCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) throw new HttpError(404, 'not_found', 'Cycle not found.');
    if (cycle.status !== 'OPEN') {
      throw new HttpError(400, 'wrong_state', 'Cycle is not open.');
    }
    const approved = await prisma.meritProposal.findMany({
      where: { cycleId, status: 'APPROVED' },
    });
    let applied = 0;
    let stale = 0;
    const effectiveFrom = cycle.effectiveDate;
    await prisma.$transaction(async (tx) => {
      for (const p of approved) {
        const cur = await tx.compensationRecord.findFirst({
          where: { associateId: p.associateId, effectiveTo: null },
        });
        if (!cur || !cur.amount.equals(p.currentAmount) || cur.payType !== p.currentPayType) {
          // Snapshot diverged — bounce back for re-review.
          await tx.meritProposal.update({
            where: { id: p.id },
            data: { status: 'DRAFT', decisionNote: 'Stale snapshot; re-review required.' },
          });
          stale++;
          continue;
        }
        await tx.compensationRecord.updateMany({
          where: { associateId: p.associateId, effectiveTo: null },
          data: { effectiveTo: effectiveFrom },
        });
        await tx.compensationRecord.create({
          data: {
            associateId: p.associateId,
            effectiveFrom,
            payType: p.currentPayType,
            amount: p.proposedAmount,
            reason: 'MERIT',
            notes: p.proposedNotes ?? null,
            actorUserId: req.user!.id,
            meritProposalId: p.id,
          },
        });
        await tx.meritProposal.update({
          where: { id: p.id },
          data: { status: 'APPLIED' },
        });
        applied++;
      }
      await tx.meritCycle.update({
        where: { id: cycleId },
        data: { status: 'APPLIED', appliedAt: new Date() },
      });
    });
    res.json({ applied, stale });
  },
);
