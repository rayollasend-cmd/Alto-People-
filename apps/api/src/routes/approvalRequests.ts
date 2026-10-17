import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApprovalDecideInputSchema, ApprovalDelegationInputSchema, ApprovalRequestKindSchema, type ApprovalDelegation } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import {
  cancelApprovalRequest,
  countDecidable,
  decideApprovalRequest,
  listApprovalRequests,
  mayReadRecord,
  recordPeople,
  shapeRequest,
  type Decider,
} from '../lib/approvalRequests.js';
import { listPayChanges } from '../lib/payChanges.js';
// Registers the apply step for every kind before the first decision.
import '../lib/approvalApply.js';

/**
 * The approval engine's HTTP surface, under /approvals:
 *
 *   GET  /requests?scope=decide|mine|all&status=   the queue (decide = what I may decide, oldest first)
 *   GET  /requests/count                            the badge
 *   GET  /requests/:id
 *   POST /requests/:id/decide { decision, reason? } approve applies the change under my name
 *   POST /requests/:id/cancel                       the requester withdraws
 *   GET  /pay-changes?associateId&clientId          Finance's view of every pay and bill-rate change
 *   GET  /delegations/mine, POST /delegations, DELETE /delegations/:id
 *                                                   "decide my approvals while I'm out"
 */
export const approvalRequestsRouter = Router();

type SessionUser = NonNullable<Request['user']>;

export function deciderFrom(user: SessionUser): Decider {
  const u = user as SessionUser & { capabilities?: Decider['capabilities'] };
  return { id: u.id, role: u.role, capabilities: u.capabilities ?? null };
}

const ListQuery = z.object({
  scope: z.enum(['decide', 'mine', 'all']).default('decide'),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  // The full record's filters (scope=all).
  kind: ApprovalRequestKindSchema.optional(),
  requesterUserId: z.string().uuid().optional(),
  approverUserId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

approvalRequestsRouter.get('/requests', requireAuth, async (req, res, next) => {
  try {
    const q = ListQuery.parse(req.query);
    const user = req.user!;
    // "all" is the record: for the audit desk, administrators and Finance.
    if (q.scope === 'all' && !mayReadRecord(deciderFrom(user))) {
      throw new HttpError(403, 'forbidden', 'The full approval record is for the audit desk, administrators and Finance.');
    }
    res.json({
      requests: await listApprovalRequests(prisma, deciderFrom(user), {
        scope: q.scope,
        status: q.status ?? null,
        limit: q.scope === 'all' ? 500 : undefined,
        filters: { kind: q.kind ?? null, requesterUserId: q.requesterUserId ?? null, approverUserId: q.approverUserId ?? null, from: q.from ?? null, to: q.to ?? null },
      }),
    });
  } catch (err) {
    next(err);
  }
});

/** GET /approvals/requests/people — who appears in the record, for its filters. */
approvalRequestsRouter.get('/requests/people', requireAuth, async (req, res, next) => {
  try {
    if (!mayReadRecord(deciderFrom(req.user!))) throw new HttpError(403, 'forbidden', 'The full approval record is for the audit desk, administrators and Finance.');
    res.json(await recordPeople(prisma));
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.get('/requests/count', requireAuth, async (req, res, next) => {
  try {
    res.json({ count: await countDecidable(prisma, deciderFrom(req.user!)) });
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.get('/pay-changes', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const q = z.object({ associateId: z.string().uuid().optional(), clientId: z.string().uuid().optional() }).parse(req.query);
    const allowed = ['FINANCE_ACCOUNTANT', 'HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'EXECUTIVE_CHAIRMAN', 'MANAGER'].includes(user.role);
    if (!allowed) throw new HttpError(403, 'forbidden', 'Pay changes are for Finance and HR.');
    res.json({ changes: await listPayChanges(prisma, q) });
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.get('/requests/:id', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const row = await prisma.approvalRequest.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
    if (!row) throw new HttpError(404, 'not_found', 'Approval request not found.');
    res.json(await shapeRequest(prisma, row, deciderFrom(req.user!)));
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.post('/requests/:id/decide', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = ApprovalDecideInputSchema.parse(req.body);
    const decided = await decideApprovalRequest(prisma, id, deciderFrom(req.user!), input);
    res.json(await shapeRequest(prisma, decided, deciderFrom(req.user!)));
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.post('/requests/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const row = await cancelApprovalRequest(prisma, id, deciderFrom(req.user!));
    res.json(await shapeRequest(prisma, row, deciderFrom(req.user!)));
  } catch (err) {
    next(err);
  }
});

/* ----- Delegation of approval authority ----------------------------------- */

const MAX_DELEGATION_DAYS = 90;
const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const PERSON = { select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } } as const;
type Person = { id: string; email: string; displayName: string | null; associate: { firstName: string; lastName: string } | null };
const nameOf = (u: Person) => u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email);

async function shapeDelegation(d: { id: string; fromUserId: string; toUserId: string; startsOn: Date; endsOn: Date; note: string | null }): Promise<ApprovalDelegation> {
  const [from, to] = await Promise.all([prisma.user.findUnique({ where: { id: d.fromUserId }, ...PERSON }), prisma.user.findUnique({ where: { id: d.toUserId }, ...PERSON })]);
  return {
    id: d.id,
    startsOn: ymd(d.startsOn),
    endsOn: ymd(d.endsOn),
    note: d.note,
    from: { id: d.fromUserId, name: from ? nameOf(from) : '—' },
    to: { id: d.toUserId, name: to ? nameOf(to) : '—' },
  };
}

/**
 * GET /approvals/delegations/candidates — the staff accounts a person may
 * hand their approvals to (themselves left out), or with ?includeMe=1 every
 * staff account that can decide — the picker a workflow's approval gate uses.
 */
approvalRequestsRouter.get('/delegations/candidates', requireAuth, async (req, res, next) => {
  try {
    const includeMe = req.query.includeMe === '1';
    const rows = await prisma.user.findMany({
      where: { tenantId: tenantIdForWrite(), status: 'ACTIVE', deletedAt: null, ...(includeMe ? {} : { id: { not: req.user!.id } }), role: { notIn: ['ASSOCIATE', 'CLIENT_PORTAL', 'DRIVER', 'LIVE_ASN'] } },
      ...PERSON,
      orderBy: { email: 'asc' },
      take: 200,
    });
    const roles = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, role: true } });
    const roleOf = new Map(roles.map((r) => [r.id, r.role]));
    res.json({ candidates: rows.map((u) => ({ id: u.id, name: nameOf(u), email: u.email, role: roleOf.get(u.id) ?? null })) });
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.get('/delegations/mine', requireAuth, async (req, res, next) => {
  try {
    const today = day(ymd(new Date()));
    const rows = await prisma.approvalDelegation.findMany({
      where: { tenantId: tenantIdForWrite(), endsOn: { gte: today }, OR: [{ fromUserId: req.user!.id }, { toUserId: req.user!.id }] },
      orderBy: { startsOn: 'asc' },
    });
    const shaped = await Promise.all(rows.map(shapeDelegation));
    res.json({ given: shaped.filter((d) => d.from.id === req.user!.id), covering: shaped.filter((d) => d.to.id === req.user!.id) });
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.post('/delegations', requireAuth, async (req, res, next) => {
  try {
    const input = ApprovalDelegationInputSchema.parse(req.body);
    const user = req.user!;
    if (input.toUserId === user.id) throw new HttpError(400, 'self_delegation', 'You cannot delegate your approvals to yourself.');
    const starts = day(input.startsOn);
    const ends = day(input.endsOn);
    if (ends < starts) throw new HttpError(400, 'bad_range', 'The cover ends before it starts.');
    if ((ends.getTime() - starts.getTime()) / 86_400_000 > MAX_DELEGATION_DAYS) throw new HttpError(400, 'too_long', `Cover lasts at most ${MAX_DELEGATION_DAYS} days.`);
    const to = await prisma.user.findFirst({ where: { id: input.toUserId, tenantId: tenantIdForWrite(), status: 'ACTIVE', deletedAt: null }, select: { id: true, role: true } });
    if (!to) throw new HttpError(404, 'not_found', 'That person was not found.');
    if (to.role === 'ASSOCIATE' || to.role === 'CLIENT_PORTAL' || to.role === 'DRIVER') throw new HttpError(400, 'cannot_cover', 'That account cannot decide approvals.');
    const created = await prisma.approvalDelegation.create({
      data: { tenantId: tenantIdForWrite(), fromUserId: user.id, toUserId: input.toUserId, startsOn: starts, endsOn: ends, note: input.note ?? null },
    });
    enqueueAudit({ actorUserId: user.id, action: 'approval.delegated', entityType: 'ApprovalDelegation', entityId: created.id, metadata: { toUserId: input.toUserId, startsOn: input.startsOn, endsOn: input.endsOn } }, 'approvalRequests.delegate');
    res.status(201).json(await shapeDelegation(created));
  } catch (err) {
    next(err);
  }
});

approvalRequestsRouter.delete('/delegations/:id', requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const row = await prisma.approvalDelegation.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
    if (!row) throw new HttpError(404, 'not_found', 'Delegation not found.');
    if (row.fromUserId !== req.user!.id) throw new HttpError(403, 'forbidden', 'Only the person who gave the cover can end it.');
    await prisma.approvalDelegation.delete({ where: { id } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'approval.delegation_ended', entityType: 'ApprovalDelegation', entityId: id, metadata: { toUserId: row.toUserId } }, 'approvalRequests.undelegate');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
