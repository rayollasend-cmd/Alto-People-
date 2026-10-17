import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  JobCreateInputSchema,
  JobListResponseSchema,
  JobUpdateInputSchema,
  can,
  type Job,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';
import { assertClientInScope, effectiveClientIdFilter, scopeClients } from '../lib/scope.js';
import { cardOn, loadRateCards, type RateCard } from '../lib/rateCards.js';
import { loadApprovalPolicy, secondPersonExists } from '../lib/approvalPolicy.js';
import { createApprovalRequest, pendingResponse } from '../lib/approvalRequests.js';
import { applyBillRateChange } from '../lib/payChanges.js';

/**
 * Money on a job — the bill rate and the pay rate — is org economics. A
 * store-bound supervisor schedules against the job's NAME; the rates are
 * withheld from their reads (null) and refused on their writes, the same
 * rule the labor-cost reads and the web's useLaborCostVisible apply. Who
 * sees money: anyone who reads payroll or the executive surface.
 */
function seesMoney(user: SessionUser): boolean {
  return can(user, 'view:payroll') || can(user, 'view:executive') || can(user, 'manage:clients');
}

export const jobsRouter = Router();

const MANAGE = requireCapability('manage:scheduling');

/**
 * A Job is a client's: its name, its bill rate and its pay rate. The GET
 * below was already clamped to the caller's client; the three writes were
 * not, and manage:scheduling is held by SHIFT_SUPERVISOR, which is bounded
 * to one client everywhere else in the product.
 *
 * So a supervisor at one store could retitle, re-rate or delete another
 * store's job profiles. Pay is computed from the compensation record rather
 * than from here (see time.ts, which stamps job.payRate onto the entry for
 * reporting), so this is not a way to move money — it is a way to corrupt
 * another client's rate card and their clock-in options.
 *
 * `is` + the client's own scope, so the ownership test is one query with
 * the load rather than a second round trip.
 */
const jobInScope = (user: SessionUser, id: string): Prisma.JobWhereInput => ({
  AND: [{ id, deletedAt: null }, { client: { is: scopeClients(user) } }],
});

type RawJob = Prisma.JobGetPayload<{ include: { client: { select: { name: true } } } }>;

/**
 * Approval engine (2026-10): the rates on a job are READ from the dated
 * rate card for (client, job name) in force today — the job's own columns
 * are the legacy value a card has not replaced yet. A rate write never
 * lands here directly: it becomes a dated card, and a second person
 * approves it where the tenant's switch says so.
 */
function toJob(row: RawJob, money = true, cards: RateCard[] = [], on: Date = new Date()): Job {
  const card = cardOn(cards, row.clientId, row.name, on);
  const billRate = card ? card.billRate : row.billRate ? Number(row.billRate) : null;
  const payRate = card ? card.payRate : row.payRate ? Number(row.payRate) : null;
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    name: row.name,
    billRate: money ? billRate : null,
    payRate: money ? payRate : null,
    isActive: row.isActive,
  };
}

/**
 * Set a job's rates as a dated card (today). Returns the approval when a
 * second person has to decide, or null when the card was written.
 */
async function setJobRates(user: SessionUser, job: RawJob, rates: { billRate?: number | null; payRate?: number | null }) {
  const cards = await loadRateCards(prisma, [job.clientId]);
  const current = cardOn(cards, job.clientId, job.name, new Date());
  const before = current
    ? { payRate: current.payRate, billRate: current.billRate }
    : job.payRate || job.billRate
      ? { payRate: job.payRate ? Number(job.payRate) : 0, billRate: job.billRate ? Number(job.billRate) : null }
      : null;
  const payRate = rates.payRate !== undefined ? (rates.payRate ?? 0) : (before?.payRate ?? 0);
  const billRate = rates.billRate !== undefined ? rates.billRate : (before?.billRate ?? null);
  const billChanged = (before?.billRate ?? null) !== (billRate ?? null);
  const policy = await loadApprovalPolicy(prisma);
  if (billChanged && policy.billRateApproval && (await secondPersonExists(prisma, 'process:payroll', user.id))) {
    const open = await prisma.approvalRequest.findFirst({ where: { kind: 'BILL_RATE_CHANGE', clientId: job.clientId, status: 'PENDING', proposed: { path: ['position'], equals: job.name } }, select: { id: true } });
    if (open) throw new HttpError(409, 'approval_pending', 'A rate change for this job is already waiting on a decision.');
    const fmt = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);
    return createApprovalRequest(prisma, {
      kind: 'BILL_RATE_CHANGE',
      subjectType: 'Job',
      subjectId: job.id,
      title: `${job.client?.name ?? 'Client'} · ${job.name}: bill ${fmt(before?.billRate ?? null)} → ${fmt(billRate)}`,
      summary: `Pay ${fmt(payRate)}/h, bill ${fmt(billRate)}/h, effective today. A dated rate card replaces the one in force.`,
      proposed: { clientId: job.clientId, position: job.name, payRate, billRate },
      before,
      requesterUserId: user.id,
      approver: { capability: 'process:payroll' },
      clientId: job.clientId,
    });
  }
  await applyBillRateChange(prisma, { clientId: job.clientId, position: job.name, payRate, billRate, actorUserId: user.id, note: billChanged && policy.billRateApproval ? 'No second approver was available.' : null }, before);
  return null;
}

/** A caller who may not see money may not set it either. */
function refuseRates(user: SessionUser, input: { billRate?: number | null; payRate?: number | null }): void {
  if (seesMoney(user)) return;
  if (input.billRate !== undefined || input.payRate !== undefined) {
    throw new HttpError(403, 'rates_withheld', 'Rates on a job are set by Finance or HR, not from the floor.');
  }
}

const JOB_INCLUDE = { client: { select: { name: true } } } as const;

jobsRouter.get('/', async (req, res, next) => {
  try {
    // Client-bounded roles only see their own client's job profiles.
    const boundedJobs = effectiveClientIdFilter(
      req.user!,
      req.query.clientId?.toString(),
    );
    const clientId =
      boundedJobs === null ? '00000000-0000-0000-0000-000000000000' : boundedJobs;
    const includeInactive = req.query.includeInactive === 'true';
    const where: Prisma.JobWhereInput = {
      deletedAt: null,
      ...(clientId ? { clientId } : {}),
      ...(includeInactive ? {} : { isActive: true }),
    };
    const rows = await prisma.job.findMany({
      where,
      orderBy: [{ clientId: 'asc' }, { name: 'asc' }],
      take: 200,
      include: JOB_INCLUDE,
    });
    const money = seesMoney(req.user!);
    const cards = money ? await loadRateCards(prisma, [...new Set(rows.map((r) => r.clientId))]) : [];
    res.json(JobListResponseSchema.parse({ jobs: rows.map((r) => toJob(r, money, cards)) }));
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const parsed = JobCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;
    refuseRates(req.user!, i);
    await assertClientInScope(prisma, req.user!, i.clientId);

    try {
      const created = await prisma.job.create({
        data: { clientId: i.clientId, name: i.name },
        include: JOB_INCLUDE,
      });
      if (i.billRate !== undefined || i.payRate !== undefined) {
        const pending = await setJobRates(req.user!, created, { billRate: i.billRate ?? null, payRate: i.payRate ?? null });
        if (pending) {
          res.status(202).json({ ...pendingResponse(pending), job: toJob(created, seesMoney(req.user!)) });
          return;
        }
      }
      res.status(201).json(toJob(created, seesMoney(req.user!), await loadRateCards(prisma, [created.clientId])));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(409, 'job_name_taken', 'A job with this name already exists for this client');
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

jobsRouter.patch('/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = JobUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await prisma.job.findFirst({
      where: jobInScope(req.user!, req.params.id),
      include: JOB_INCLUDE,
    });
    if (!existing) throw new HttpError(404, 'job_not_found', 'Job not found');

    // clientId is deliberately not updatable: moving a job between clients
    // would carry every time entry already pinned to it across with it.
    const i = parsed.data;
    refuseRates(req.user!, i);
    const data: Prisma.JobUpdateInput = {};
    if (i.name !== undefined) data.name = i.name;
    if (i.isActive !== undefined) data.isActive = i.isActive;

    const updated = await prisma.job.update({
      where: { id: existing.id },
      data,
      include: JOB_INCLUDE,
    });
    if (i.billRate !== undefined || i.payRate !== undefined) {
      const pending = await setJobRates(req.user!, updated, { billRate: i.billRate, payRate: i.payRate });
      if (pending) {
        res.status(202).json({ ...pendingResponse(pending), job: toJob(updated, seesMoney(req.user!), await loadRateCards(prisma, [updated.clientId])) });
        return;
      }
    }
    res.json(toJob(updated, seesMoney(req.user!), await loadRateCards(prisma, [updated.clientId])));
  } catch (err) {
    next(err);
  }
});

jobsRouter.delete('/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.job.findFirst({
      where: jobInScope(req.user!, req.params.id),
    });
    if (!existing) throw new HttpError(404, 'job_not_found', 'Job not found');
    await prisma.job.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
