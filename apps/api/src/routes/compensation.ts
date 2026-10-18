import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { hasCapability, toDateOnly } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { assertSameTenant } from '../lib/sameTenant.js';
import { assertInTenant } from '../lib/sameTenant.js';
import { loadApprovalPolicy, payChangeNeedsApproval, secondPersonExists } from '../lib/approvalPolicy.js';
import { createApprovalRequest, pendingResponse } from '../lib/approvalRequests.js';
import { applyPayRateChange, currentComp, listPayChanges } from '../lib/payChanges.js';
import { coveringManagerIds } from '../lib/delegations.js';
import { assertAssociateInScope, scopeActiveAssociates } from '../lib/scope.js';

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
    effectiveFrom: toDateOnly(r.effectiveFrom),
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
    effectiveFrom: toDateOnly(b.effectiveFrom),
    effectiveTo: b.effectiveTo?.toISOString() ?? null,
  };
}

// ----- /comp/associates/:id/records --------------------------------------

// effectiveFrom accepts either a date-only `YYYY-MM-DD` (what the
// People → Compensation → Set new rate dialog sends, via <input type="date">)
// or a full ISO-8601 datetime (for programmatic callers). The handler
// normalises both into a Date instance below.
const RecordCreateSchema = z.object({
  effectiveFrom: z
    .union([z.string().date(), z.string().datetime()])
    .optional(),
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
    await assertSameTenant('associate', String(req.params.id));
    // Pay is only readable for people in the caller's reach.
    await assertAssociateInScope(prisma, req.user!, String(req.params.id));
    const associateId = req.params.id;
    const rows = await prisma.compensationRecord.findMany({
      take: 500,
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
    await assertSameTenant('associate', String(req.params.id));
    await assertAssociateInScope(prisma, req.user!, String(req.params.id));
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
    await assertSameTenant('associate', String(req.params.id));
    // A pay change is only for someone active in the caller's reach.
    await assertAssociateInScope(prisma, req.user!, String(req.params.id), { former: false });
    const associateId = req.params.id;
    const input = RecordCreateSchema.parse(req.body);
    const associate = await prisma.associate.findUnique({ where: { id: associateId } });
    if (!associate || associate.deletedAt) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    // Approval engine: a change past the tenant's threshold (or every change,
    // when the switch says so) goes to a second manage:comp holder; the
    // record then carries the decider's name, not the requester's.
    const policy = await loadApprovalPolicy(prisma);
    const current = await currentComp(prisma, associateId);
    const sameType = !current || current.payType === input.payType;
    // A switch between hourly and salary is always a second person's call.
    const needs = current && !sameType ? true : payChangeNeedsApproval(policy, current?.amount ?? null, input.amount);
    const who = `${associate.firstName} ${associate.lastName}`;
    if (needs && (await secondPersonExists(prisma, 'manage:comp', req.user!.id))) {
      const open = await prisma.approvalRequest.findFirst({ where: { kind: 'PAY_RATE_CHANGE', associateId, status: 'PENDING' }, select: { id: true } });
      if (open) throw new HttpError(409, 'approval_pending', 'A pay change for this person is already waiting on a decision.');
      const fmt = (n: number) => `$${n.toFixed(2)}`;
      const request = await createApprovalRequest(prisma, {
        kind: 'PAY_RATE_CHANGE',
        subjectType: 'Associate',
        subjectId: associateId,
        title: `${who}: ${current ? `${fmt(current.amount)} → ` : ''}${fmt(input.amount)} ${input.payType === 'SALARY' ? 'per year' : 'per hour'}`,
        summary: `${input.reason.replace(/_/g, ' ').toLowerCase()}, effective ${effectiveFrom.toISOString().slice(0, 10)}${input.notes ? ` — ${input.notes}` : ''}`,
        proposed: { associateId, effectiveFrom: effectiveFrom.toISOString(), payType: input.payType, amount: input.amount, reason: input.reason, notes: input.notes ?? null },
        before: current ? { payType: current.payType, amount: current.amount } : null,
        requesterUserId: req.user!.id,
        approver: { capability: 'manage:comp' },
        associateId,
      });
      res.status(202).json(pendingResponse(request));
      return;
    }
    await applyPayRateChange(prisma, {
      associateId,
      effectiveFrom,
      payType: input.payType,
      amount: input.amount,
      reason: input.reason,
      notes: input.notes ?? null,
      actorUserId: req.user!.id,
      note: needs ? 'No second approver was available.' : null,
    });
    res.status(201).json({ ok: true });
  },
);

/** GET /comp/changes — every pay and bill-rate change, newest first (Finance's audit of pay). */
compensationRouter.get(
  '/changes',
  requireCapability('view:comp'),
  async (req, res) => {
    const q = z.object({ associateId: z.string().uuid().optional(), clientId: z.string().uuid().optional() }).parse(req.query);
    res.json({ changes: await listPayChanges(prisma, q) });
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
      take: 1000,
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
      take: 500,
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
    await assertInTenant('meritCycle', String(req.params.id), 'Cycle not found.');
    const cycleId = req.params.id;
    // Every proposal for the people in the caller's reach — up to the cap, said so past it.
    const CAP = 5000;
    const found = await prisma.meritProposal.findMany({
      take: CAP + 1,
      where: { cycleId, associate: { is: scopeActiveAssociates(req.user!, { former: true }) } },
      include: {
        associate: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ status: 'asc' }, { associate: { lastName: 'asc' } }],
    });
    const rows = found.slice(0, CAP);
    res.json({
      truncated: found.length > CAP,
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
      take: 1000,
      where: {
        deletedAt: null,
        compRecords: { some: { effectiveTo: null } },
      },
      select: { id: true },
    });
    const existing = await prisma.meritProposal.findMany({
      take: 500,
      where: { cycleId },
      select: { associateId: true },
    });
    const existingIds = new Set(existing.map((p) => p.associateId));

    // One query for every associate's current comp record instead of a
    // findFirst per associate. Keep the first row seen per associate,
    // mirroring the old unordered findFirst.
    const seedIds = associates.map((a) => a.id).filter((id) => !existingIds.has(id));
    const currentRecords = await prisma.compensationRecord.findMany({
      where: { associateId: { in: seedIds }, effectiveTo: null },
    });
    const currentByAssociate = new Map<string, (typeof currentRecords)[number]>();
    for (const cur of currentRecords) {
      if (!currentByAssociate.has(cur.associateId)) {
        currentByAssociate.set(cur.associateId, cur);
      }
    }

    const proposalData: Prisma.MeritProposalCreateManyInput[] = [];
    for (const id of seedIds) {
      const cur = currentByAssociate.get(id);
      if (!cur) continue;
      proposalData.push({
        cycleId,
        associateId: id,
        currentAmount: cur.amount,
        currentPayType: cur.payType,
        proposedAmount: cur.amount, // default = no change; reviewer edits up
        proposedById: req.user!.id,
      });
    }
    const created =
      proposalData.length === 0
        ? 0
        : (await prisma.meritProposal.createMany({ data: proposalData })).count;

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
      take: 500,
      where: { cycleId, status: 'APPROVED' },
    });
    const effectiveFrom = cycle.effectiveDate;

    // Pre-load every current comp record in one query (was a findFirst per
    // proposal inside an interactive transaction). Keep the first row per
    // associate, mirroring the old unordered findFirst.
    const currentRecords = await prisma.compensationRecord.findMany({
      where: {
        associateId: { in: approved.map((p) => p.associateId) },
        effectiveTo: null,
      },
    });
    const currentByAssociate = new Map<string, (typeof currentRecords)[number]>();
    for (const cur of currentRecords) {
      if (!currentByAssociate.has(cur.associateId)) {
        currentByAssociate.set(cur.associateId, cur);
      }
    }

    const staleProposalIds: string[] = [];
    const applyProposals: typeof approved = [];
    for (const p of approved) {
      const cur = currentByAssociate.get(p.associateId);
      if (!cur || !cur.amount.equals(p.currentAmount) || cur.payType !== p.currentPayType) {
        // Snapshot diverged — bounce back for re-review.
        staleProposalIds.push(p.id);
      } else {
        applyProposals.push(p);
      }
    }

    // Short batched transaction: identical-payload writes consolidated into
    // updateMany/createMany, everything pipelined in one round of statements.
    await prisma.$transaction([
      ...(staleProposalIds.length > 0
        ? [
            prisma.meritProposal.updateMany({
              where: { id: { in: staleProposalIds } },
              data: { status: 'DRAFT', decisionNote: 'Stale snapshot; re-review required.' },
            }),
          ]
        : []),
      ...(applyProposals.length > 0
        ? [
            prisma.compensationRecord.updateMany({
              where: {
                associateId: { in: applyProposals.map((p) => p.associateId) },
                effectiveTo: null,
              },
              data: { effectiveTo: effectiveFrom },
            }),
            prisma.compensationRecord.createMany({
              data: applyProposals.map((p) => ({
                associateId: p.associateId,
                effectiveFrom,
                payType: p.currentPayType,
                amount: p.proposedAmount,
                reason: 'MERIT' as const,
                notes: p.proposedNotes ?? null,
                actorUserId: req.user!.id,
                meritProposalId: p.id,
              })),
            }),
            prisma.meritProposal.updateMany({
              where: { id: { in: applyProposals.map((p) => p.id) } },
              data: { status: 'APPLIED' },
            }),
          ]
        : []),
      prisma.meritCycle.update({
        where: { id: cycleId },
        data: { status: 'APPLIED', appliedAt: new Date() },
      }),
    ]);
    res.json({ applied: applyProposals.length, stale: staleProposalIds.length });
  },
);

// ----- Compensation planning (HR pack 2026-10) --------------------------------
//
// The manager's worksheet: their own reports' proposals in one cycle, each
// beside the person's band position, with the slice of the cycle's budget
// that is theirs (pro rata to their reports' current pay). HR's calibration
// view: the distribution of proposed increases, by manager, with the
// outliers — so the cycle is decided on one screen, not a spreadsheet.

function bandPosition(amount: number, band: { minAmount: Prisma.Decimal; maxAmount: Prisma.Decimal } | null): number | null {
  if (!band) return null;
  const min = Number(band.minAmount);
  const max = Number(band.maxAmount);
  if (max <= min) return null;
  return Math.round(((amount - min) / (max - min)) * 1000) / 10;
}

async function cycleWorksheet(cycleId: string, managerIds: string[] | null) {
  const cycle = await prisma.meritCycle.findUnique({ where: { id: cycleId } });
  if (!cycle) throw new HttpError(404, 'not_found', 'Cycle not found.');
  const proposals = await prisma.meritProposal.findMany({
    take: 2000,
    where: { cycleId, ...(managerIds ? { associate: { managerId: { in: managerIds } } } : {}) },
    include: {
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          managerId: true,
          jobProfileId: true,
          manager: { select: { firstName: true, lastName: true } },
          jobProfile: { select: { title: true } },
          performanceReviews: { orderBy: { periodEnd: 'desc' }, take: 1, select: { overallRating: true, periodEnd: true } },
        },
      },
    },
    orderBy: [{ associate: { lastName: 'asc' } }],
  });
  const bands = await prisma.compBand.findMany({ where: { clientId: cycle.clientId, effectiveTo: null }, select: { jobProfileId: true, payType: true, minAmount: true, midAmount: true, maxAmount: true, name: true } });
  const bandFor = (jobProfileId: string | null, payType: string) => bands.find((b) => b.jobProfileId === jobProfileId && b.payType === payType) ?? bands.find((b) => b.jobProfileId === null && b.payType === payType) ?? null;
  const totalCurrent = proposals.reduce((sum, p) => sum + Number(p.currentAmount), 0);
  const rows = proposals.map((p) => {
    const band = bandFor(p.associate.jobProfileId, p.currentPayType);
    const current = Number(p.currentAmount);
    const proposed = Number(p.proposedAmount);
    const review = p.associate.performanceReviews[0] ?? null;
    return {
      id: p.id,
      associateId: p.associateId,
      associateName: `${p.associate.firstName} ${p.associate.lastName}`.trim(),
      jobTitle: p.associate.jobProfile?.title ?? null,
      managerId: p.associate.managerId,
      managerName: p.associate.manager ? `${p.associate.manager.firstName} ${p.associate.manager.lastName}`.trim() : null,
      payType: p.currentPayType,
      currentAmount: current.toFixed(2),
      proposedAmount: proposed.toFixed(2),
      increasePct: current > 0 ? Math.round(((proposed - current) / current) * 1000) / 10 : null,
      status: p.status,
      proposedNotes: p.proposedNotes,
      decisionNote: p.decisionNote,
      band: band ? { name: band.name, min: Number(band.minAmount).toFixed(2), mid: Number(band.midAmount).toFixed(2), max: Number(band.maxAmount).toFixed(2) } : null,
      bandPositionNow: bandPosition(current, band),
      bandPositionProposed: bandPosition(proposed, band),
      lastRating: review?.overallRating ?? null,
      lastReviewEnd: review?.periodEnd.toISOString().slice(0, 10) ?? null,
    };
  });
  return { cycle, rows, totalCurrent };
}

/** Pay increases are annualized so hourly and salaried people add up in one budget. */
const annual = (amount: number, payType: string) => (payType === 'HOURLY' ? amount * 2080 : amount);

compensationRouter.get('/cycles/:id/worksheet', requireCapability('view:comp'), async (req, res) => {
  await assertInTenant('meritCycle', String(req.params.id), 'Cycle not found.');
  // A manager sees their reports; HR (manage:comp) may ask for any manager's sheet or everyone's.
  // A line manager (the MANAGER role) sees their own reports even though the
  // role carries manage:comp; HR and the owner roles see everyone.
  const hr = hasCapability(req.user!.role, 'manage:comp') && req.user!.role !== 'MANAGER';
  const managerParam = z.string().uuid().optional().parse(req.query.managerId);
  let managerIds: string[] | null;
  if (hr) managerIds = managerParam ? [managerParam] : null;
  else {
    managerIds = await coveringManagerIds(req.user!);
    if (managerIds.length === 0) throw new HttpError(403, 'no_team', 'Your account is not linked to a team.');
  }
  const { cycle, rows } = await cycleWorksheet(String(req.params.id), managerIds);
  // This manager's share of the budget: pro rata to their reports' current annual pay.
  const all = managerIds ? await prisma.meritProposal.findMany({ where: { cycleId: cycle.id }, select: { currentAmount: true, currentPayType: true } }) : [];
  const cycleCurrent = managerIds ? all.reduce((sum, p) => sum + annual(Number(p.currentAmount), p.currentPayType), 0) : rows.reduce((sum, r) => sum + annual(Number(r.currentAmount), r.payType), 0);
  const mineCurrent = rows.reduce((sum, r) => sum + annual(Number(r.currentAmount), r.payType), 0);
  const budget = cycle.budget ? Number(cycle.budget) : null;
  const share = budget === null ? null : cycleCurrent > 0 ? Math.round(budget * (mineCurrent / cycleCurrent) * 100) / 100 : budget;
  const spent = rows.filter((r) => r.status !== 'REJECTED').reduce((sum, r) => sum + annual(Number(r.proposedAmount) - Number(r.currentAmount), r.payType), 0);
  res.json({
    cycle: { id: cycle.id, name: cycle.name, status: cycle.status, effectiveDate: cycle.effectiveDate.toISOString().slice(0, 10), budget: budget?.toFixed(2) ?? null },
    budget: { share: share?.toFixed(2) ?? null, spent: Math.round(spent * 100) / 100, remaining: share === null ? null : Math.round((share - spent) * 100) / 100 },
    rows,
    editable: cycle.status === 'DRAFT' || cycle.status === 'OPEN',
  });
});

compensationRouter.get('/cycles/:id/calibration', requireCapability('manage:comp'), async (req, res) => {
  await assertInTenant('meritCycle', String(req.params.id), 'Cycle not found.');
  const { cycle, rows } = await cycleWorksheet(String(req.params.id), null);
  const pcts = rows.map((r) => r.increasePct).filter((x): x is number => x !== null);
  const sorted = [...pcts].sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
  const mean = sorted.length ? Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10 : null;
  const buckets = [
    { label: '0%', min: -Infinity, max: 0 },
    { label: '0–2%', min: 0, max: 2 },
    { label: '2–4%', min: 2, max: 4 },
    { label: '4–6%', min: 4, max: 6 },
    { label: '6–10%', min: 6, max: 10 },
    { label: '10%+', min: 10, max: Infinity },
  ].map((b) => ({ label: b.label, count: pcts.filter((p) => (b.min === -Infinity ? p <= 0 : p > b.min) && p <= b.max).length }));
  const byManager = new Map<string, { managerId: string | null; managerName: string; people: number; avgPct: number; spent: number; pending: number }>();
  for (const r of rows) {
    const key = r.managerId ?? 'none';
    const m = byManager.get(key) ?? { managerId: r.managerId, managerName: r.managerName ?? 'No manager', people: 0, avgPct: 0, spent: 0, pending: 0 };
    m.people += 1;
    m.avgPct += r.increasePct ?? 0;
    m.spent += annual(Number(r.proposedAmount) - Number(r.currentAmount), r.payType);
    if (r.status === 'DRAFT' || r.status === 'SUBMITTED') m.pending += 1;
    byManager.set(key, m);
  }
  const managers = [...byManager.values()].map((m) => ({ ...m, avgPct: m.people ? Math.round((m.avgPct / m.people) * 10) / 10 : 0, spent: Math.round(m.spent * 100) / 100 }));
  // Outliers: an increase far from the pack, or one that leaves the band.
  const p25 = q(0.25) ?? 0;
  const p75 = q(0.75) ?? 0;
  const fence = (p75 - p25) * 1.5;
  const outliers = rows.filter((r) => (r.increasePct !== null && (r.increasePct > p75 + fence || r.increasePct < p25 - fence)) || (r.bandPositionProposed !== null && (r.bandPositionProposed > 100 || r.bandPositionProposed < 0)) || (r.lastRating !== null && r.lastRating <= 2 && (r.increasePct ?? 0) > 0))
    .map((r) => ({ ...r, reason: r.bandPositionProposed !== null && r.bandPositionProposed > 100 ? 'Above the band' : r.bandPositionProposed !== null && r.bandPositionProposed < 0 ? 'Below the band' : r.lastRating !== null && r.lastRating <= 2 && (r.increasePct ?? 0) > 0 ? 'Raise with a low rating' : 'Far from the pack' }));
  const spent = rows.filter((r) => r.status !== 'REJECTED').reduce((sum, r) => sum + annual(Number(r.proposedAmount) - Number(r.currentAmount), r.payType), 0);
  const budget = cycle.budget ? Number(cycle.budget) : null;
  res.json({
    cycle: { id: cycle.id, name: cycle.name, status: cycle.status, budget: budget?.toFixed(2) ?? null, effectiveDate: cycle.effectiveDate.toISOString().slice(0, 10) },
    totals: { people: rows.length, spent: Math.round(spent * 100) / 100, remaining: budget === null ? null : Math.round((budget - spent) * 100) / 100, meanPct: mean, medianPct: q(0.5), p25, p75, pending: rows.filter((r) => r.status === 'DRAFT' || r.status === 'SUBMITTED').length },
    distribution: buckets,
    managers,
    outliers,
    rows,
  });
});
