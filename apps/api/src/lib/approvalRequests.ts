import { Prisma, type PrismaClient, type ApprovalRequest, type ApprovalRequestKind, type Role } from '@prisma/client';
import { ROLE_CAPABILITIES, can, type Capability } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit, recordCriticalAudit } from './audit.js';
import { notifyUser } from './notify.js';
import { tenantIdForWrite } from './tenant.js';
import { rolesHolding } from './approvalPolicy.js';
import { applyBillRateChange, applyPayRateChange } from './payChanges.js';

/**
 * The approval engine's one record ("maker-checker").
 *
 * A change that needs a second person is kept whole as an ApprovalRequest:
 * what it is, what it replaces, who asked, and the rule that names who may
 * decide it. The decider approves or rejects with a reason; on approval the
 * engine APPLIES the change under the decider's name (never the requester's),
 * so the record always shows two different people.
 *
 * Who may decide (mayDecide): never the requester; the named person (or
 * whoever they delegated their approvals to for today); otherwise anyone
 * holding the named capability, or in the named role.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface Decider {
  id: string;
  role: Role;
  capabilities?: Capability[] | null;
}

export interface ApproverRule {
  capability?: Capability;
  userId?: string;
  role?: Role;
}

export interface CreateApprovalInput {
  kind: ApprovalRequestKind;
  subjectType: string;
  subjectId: string;
  title: string;
  summary?: string | null;
  proposed: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  requesterUserId: string | null;
  approver: ApproverRule;
  clientId?: string | null;
  associateId?: string | null;
  workflowRunId?: string | null;
  workflowStepId?: string | null;
}

export interface ApprovalRequestSummary {
  id: string;
  kind: ApprovalRequestKind;
  status: ApprovalRequest['status'];
  subjectType: string;
  subjectId: string;
  title: string;
  summary: string | null;
  proposed: unknown;
  before: unknown;
  requester: { id: string; name: string } | null;
  approverRule: { capability: string | null; userId: string | null; role: Role | null };
  clientId: string | null;
  associateId: string | null;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  reason: string | null;
  appliedAt: string | null;
  applyError: string | null;
  createdAt: string;
  mayDecide: boolean;
}

const KIND_LINK: Record<ApprovalRequestKind, (r: ApprovalRequest) => string> = {
  PAY_RATE_CHANGE: (r) => `/people/${r.associateId ?? ''}?tab=pay`,
  BILL_RATE_CHANGE: (r) => `/clients/${r.clientId ?? ''}?tab=rates`,
  SEPARATION_COMPLETE: () => '/separations',
  SELF_SERVICE_CHANGE: (r) => `/people/${r.associateId ?? ''}`,
  PROMOTION: (r) => `/people/${r.associateId ?? ''}?tab=pay`,
  REQUISITION: () => '/org?tab=positions',
  ROLE_CHANGE: () => '/admin/users',
  WORKFLOW_GATE: () => '/workflows?tab=runs',
  LABOR_RULES_LIVE: () => '/payroll/labor-rules',
};

/** The link a decider opens to see the subject. */
export function subjectLink(r: ApprovalRequest): string {
  return KIND_LINK[r.kind](r);
}

const dayStart = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

/** The people whose approvals `userId` is covering today. */
export async function delegatedFrom(db: Db, userId: string, now = new Date()): Promise<string[]> {
  const today = dayStart(now);
  const rows = await db.approvalDelegation.findMany({
    where: { toUserId: userId, startsOn: { lte: today }, endsOn: { gte: today } },
    select: { fromUserId: true },
  });
  return rows.map((r) => r.fromUserId);
}

/** The server's one rule for who may decide a request. */
export async function mayDecide(db: Db, row: Pick<ApprovalRequest, 'status' | 'requesterUserId' | 'approverUserId' | 'approverCapability' | 'approverRole'>, user: Decider, now = new Date()): Promise<boolean> {
  if (row.status !== 'PENDING') return false;
  // Maker ≠ checker, always.
  if (row.requesterUserId && row.requesterUserId === user.id) return false;
  if (row.approverUserId) {
    if (row.approverUserId === user.id) return true;
    const covering = await delegatedFrom(db, user.id, now);
    if (covering.includes(row.approverUserId)) return true;
  }
  if (row.approverCapability && can(user, row.approverCapability as Capability)) return true;
  if (row.approverRole && row.approverRole === user.role) return true;
  // A delegation also carries the delegating person's capability-based right.
  if (row.approverCapability || row.approverRole) {
    const covering = await delegatedFrom(db, user.id, now);
    if (covering.length > 0) {
      const froms = await db.user.findMany({ where: { id: { in: covering }, status: 'ACTIVE', deletedAt: null }, select: { id: true, role: true } });
      for (const f of froms) {
        if (f.id === row.requesterUserId) continue;
        if (row.approverCapability && ROLE_CAPABILITIES[f.role as Role].has(row.approverCapability as Capability)) return true;
        if (row.approverRole && row.approverRole === f.role) return true;
      }
    }
  }
  return false;
}

/** A Prisma where for "pending requests this person may decide" — the same rule, as a query, for lists and counts. */
export async function decidableWhere(db: Db, user: Decider, now = new Date()): Promise<Prisma.ApprovalRequestWhereInput> {
  const covering = await delegatedFrom(db, user.id, now);
  const froms = covering.length ? await db.user.findMany({ where: { id: { in: covering }, status: 'ACTIVE', deletedAt: null }, select: { id: true, role: true } }) : [];
  const caps = new Set<string>();
  const roles = new Set<string>([user.role]);
  for (const c of ROLE_CAPABILITIES[user.role]) if (can(user, c)) caps.add(c);
  for (const f of froms) {
    roles.add(f.role);
    for (const c of ROLE_CAPABILITIES[f.role as Role]) caps.add(c);
  }
  const userIds = [user.id, ...covering];
  return {
    tenantId: tenantIdForWrite(),
    status: 'PENDING',
    NOT: { requesterUserId: user.id },
    OR: [
      { approverUserId: { in: userIds } },
      { approverCapability: { in: [...caps] } },
      { approverRole: { in: [...roles] as Role[] } },
    ],
  };
}

export async function countDecidable(db: Db, user: Decider): Promise<number> {
  return db.approvalRequest.count({ where: await decidableWhere(db, user) });
}

async function personName(db: Db, id: string | null): Promise<{ id: string; name: string } | null> {
  if (!id) return null;
  const u = await db.user.findUnique({ where: { id }, select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } });
  if (!u) return null;
  return { id: u.id, name: u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email) };
}

export async function shapeRequest(db: Db, r: ApprovalRequest, user: Decider | null): Promise<ApprovalRequestSummary> {
  const [requester, decidedBy, may] = await Promise.all([personName(db, r.requesterUserId), personName(db, r.decidedById), user ? mayDecide(db, r, user) : Promise.resolve(false)]);
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    title: r.title,
    summary: r.summary,
    proposed: r.proposed,
    before: r.before,
    requester,
    approverRule: { capability: r.approverCapability, userId: r.approverUserId, role: r.approverRole },
    clientId: r.clientId,
    associateId: r.associateId,
    decidedBy,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    reason: r.reason,
    appliedAt: r.appliedAt?.toISOString() ?? null,
    applyError: r.applyError,
    createdAt: r.createdAt.toISOString(),
    mayDecide: may,
  };
}

/** The people a new request should ring: the named person, else active holders of the capability or role (the requester left out, at most 25). */
async function approverUserIds(db: Db, rule: ApproverRule, requesterUserId: string | null): Promise<string[]> {
  if (rule.userId) return rule.userId === requesterUserId ? [] : [rule.userId];
  const roles = rule.capability ? rolesHolding(rule.capability) : rule.role ? [rule.role] : [];
  if (roles.length === 0) return [];
  const rows = await db.user.findMany({
    where: { tenantId: tenantIdForWrite(), status: 'ACTIVE', deletedAt: null, role: { in: roles }, ...(requesterUserId ? { id: { not: requesterUserId } } : {}) },
    select: { id: true },
    take: 25,
  });
  return rows.map((r) => r.id);
}

export async function createApprovalRequest(db: Db, input: CreateApprovalInput): Promise<ApprovalRequest> {
  const row = await db.approvalRequest.create({
    data: {
      tenantId: tenantIdForWrite(),
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      title: input.title,
      summary: input.summary ?? null,
      proposed: input.proposed as Prisma.InputJsonValue,
      before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
      requesterUserId: input.requesterUserId,
      approverCapability: input.approver.capability ?? null,
      approverUserId: input.approver.userId ?? null,
      approverRole: input.approver.role ?? null,
      clientId: input.clientId ?? null,
      associateId: input.associateId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      workflowStepId: input.workflowStepId ?? null,
    },
  });
  enqueueAudit(
    { actorUserId: input.requesterUserId, clientId: input.clientId ?? null, action: 'approval.requested', entityType: 'ApprovalRequest', entityId: row.id, metadata: { kind: row.kind, subjectType: row.subjectType, subjectId: row.subjectId } },
    'approvalRequests.create',
  );
  const ring = await approverUserIds(db, input.approver, input.requesterUserId);
  for (const uid of ring) {
    void notifyUser(uid, {
      subject: `Approval needed: ${input.title}`,
      body: input.summary ?? 'A change is waiting on your decision.',
      category: 'approvals',
      linkUrl: `/approvals?tab=requests&approval=${row.id}`,
    });
  }
  return row;
}

/** The HTTP shape a route answers with when the change went to a second person instead of landing. */
export function pendingResponse(row: ApprovalRequest): { pending: true; approvalId: string; title: string } {
  return { pending: true, approvalId: row.id, title: row.title };
}

export type ApplyHandler = (db: PrismaClient, row: ApprovalRequest, decider: Decider) => Promise<void>;

const APPLY: Partial<Record<ApprovalRequestKind, ApplyHandler>> = {
  PAY_RATE_CHANGE: async (db, row, decider) => {
    const p = row.proposed as { associateId: string; effectiveFrom: string; payType: 'HOURLY' | 'SALARY'; amount: number; reason: string; notes?: string | null };
    await applyPayRateChange(db, {
      associateId: p.associateId,
      effectiveFrom: new Date(p.effectiveFrom),
      payType: p.payType,
      amount: p.amount,
      reason: p.reason as 'HIRE',
      notes: p.notes ?? null,
      actorUserId: decider.id,
      approvalRequestId: row.id,
      requestedByUserId: row.requesterUserId,
    });
  },
  BILL_RATE_CHANGE: async (db, row, decider) => {
    const p = row.proposed as { clientId: string; position: string; payRate: number; billRate: number | null; effectiveFrom?: string };
    const before = (row.before ?? null) as { payRate: number; billRate: number | null } | null;
    await applyBillRateChange(db, { ...p, actorUserId: decider.id, approvalRequestId: row.id, requestedByUserId: row.requesterUserId }, before);
  },
};

const ON_REJECT: Partial<Record<ApprovalRequestKind, ApplyHandler>> = {};

/** Kinds whose apply step lives in another module register it here (keeps the import graph acyclic); `onReject` runs after a rejection. */
export function registerApplyHandler(kind: ApprovalRequestKind, fn: ApplyHandler, onReject?: ApplyHandler): void {
  APPLY[kind] = fn;
  if (onReject) ON_REJECT[kind] = onReject;
}

export interface DecideInput {
  decision: 'APPROVE' | 'REJECT';
  reason?: string | null;
}

/**
 * Decide a request. An approval applies the change at once; if applying
 * fails the decision stands and the failure is on the record (applyError)
 * for a person to resolve — the decider never has to guess what happened.
 */
export async function decideApprovalRequest(db: PrismaClient, id: string, user: Decider, input: DecideInput): Promise<ApprovalRequest> {
  const row = await db.approvalRequest.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!row) throw new HttpError(404, 'not_found', 'Approval request not found.');
  if (row.status !== 'PENDING') throw new HttpError(409, 'approval_decided', 'This request was already decided.');
  if (!(await mayDecide(db, row, user))) {
    if (row.requesterUserId === user.id) throw new HttpError(403, 'maker_checker', 'You asked for this change; a second person has to approve it.');
    throw new HttpError(403, 'not_the_approver', 'This one is not yours to decide.');
  }
  if (input.decision === 'REJECT' && !(input.reason && input.reason.trim().length >= 3)) {
    throw new HttpError(400, 'reason_required', 'Say why you are rejecting it.');
  }
  const now = new Date();
  // Claim the decision: two deciders racing cannot both apply it.
  const claimed = await db.approvalRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedById: user.id, decidedAt: now, reason: input.reason?.trim() || null },
  });
  if (claimed.count === 0) throw new HttpError(409, 'approval_decided', 'This request was already decided.');
  await recordCriticalAudit(
    {
      actorUserId: user.id,
      clientId: row.clientId,
      action: input.decision === 'APPROVE' ? 'approval.approved' : 'approval.rejected',
      entityType: 'ApprovalRequest',
      entityId: row.id,
      metadata: { kind: row.kind, subjectType: row.subjectType, subjectId: row.subjectId, requesterUserId: row.requesterUserId, reason: input.reason ?? null },
    },
    'approvalRequests.decide',
  );
  let decided = await db.approvalRequest.findUniqueOrThrow({ where: { id } });
  if (input.decision === 'APPROVE') {
    const apply = APPLY[row.kind];
    try {
      if (!apply) throw new Error(`No apply step for ${row.kind}`);
      await apply(db, decided, user);
      decided = await db.approvalRequest.update({ where: { id }, data: { appliedAt: new Date(), applyError: null } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      decided = await db.approvalRequest.update({ where: { id }, data: { applyError: message.slice(0, 2000) } });
      enqueueAudit({ actorUserId: user.id, action: 'approval.apply_failed', entityType: 'ApprovalRequest', entityId: id, metadata: { kind: row.kind, error: message } }, 'approvalRequests.apply');
    }
  }
  if (input.decision === 'REJECT') {
    const onReject = ON_REJECT[row.kind];
    if (onReject) {
      try {
        await onReject(db, decided, user);
      } catch (err) {
        enqueueAudit({ actorUserId: user.id, action: 'approval.reject_hook_failed', entityType: 'ApprovalRequest', entityId: id, metadata: { kind: row.kind, error: err instanceof Error ? err.message : String(err) } }, 'approvalRequests.reject');
      }
    }
  }
  if (row.requesterUserId && row.requesterUserId !== user.id) {
    const verb = input.decision === 'APPROVE' ? (decided.applyError ? 'approved, but could not be applied' : 'approved') : 'rejected';
    void notifyUser(row.requesterUserId, {
      subject: `${row.title}: ${verb}`,
      body: decided.applyError ? `Approved, but applying it failed: ${decided.applyError}` : input.reason ? `“${input.reason}”` : `Your request was ${verb}.`,
      category: 'approvals',
      linkUrl: `/approvals?tab=requests&approval=${row.id}`,
    });
  }
  return decided;
}

/** The people who appear in the record, for its requester and approver filters. */
export async function recordPeople(db: PrismaClient): Promise<{ requesters: Array<{ id: string; name: string }>; approvers: Array<{ id: string; name: string }> }> {
  const tenantId = tenantIdForWrite();
  const [req, dec] = await Promise.all([
    db.approvalRequest.findMany({ where: { tenantId, requesterUserId: { not: null } }, distinct: ['requesterUserId'], select: { requesterUserId: true }, take: 500 }),
    db.approvalRequest.findMany({ where: { tenantId, decidedById: { not: null } }, distinct: ['decidedById'], select: { decidedById: true }, take: 500 }),
  ]);
  const named = async (ids: Array<string | null>) =>
    (await Promise.all(ids.filter((x): x is string => !!x).map((id) => personName(db, id)))).filter((p): p is { id: string; name: string } => !!p).sort((a, b) => a.name.localeCompare(b.name));
  return { requesters: await named(req.map((r) => r.requesterUserId)), approvers: await named(dec.map((r) => r.decidedById)) };
}

/** The requester (or an admin) withdraws a pending request. */
export async function cancelApprovalRequest(db: PrismaClient, id: string, user: Decider): Promise<ApprovalRequest> {
  const row = await db.approvalRequest.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!row) throw new HttpError(404, 'not_found', 'Approval request not found.');
  if (row.status !== 'PENDING') throw new HttpError(409, 'approval_decided', 'This request was already decided.');
  if (row.requesterUserId !== user.id && !can(user, 'manage:org')) throw new HttpError(403, 'forbidden', 'Only the person who asked can withdraw this.');
  const updated = await db.approvalRequest.update({ where: { id }, data: { status: 'CANCELLED', decidedById: user.id, decidedAt: new Date() } });
  enqueueAudit({ actorUserId: user.id, clientId: row.clientId, action: 'approval.cancelled', entityType: 'ApprovalRequest', entityId: id, metadata: { kind: row.kind } }, 'approvalRequests.cancel');
  return updated;
}

/** Pending requests this person may decide, oldest first, plus (optionally) the ones they asked for. */
/** The filters the full record ("All requests") takes. */
export interface RecordFilters {
  kind?: ApprovalRequestKind | null;
  requesterUserId?: string | null;
  /** Who decided it, or the person the rule named. */
  approverUserId?: string | null;
  /** createdAt, inclusive, YYYY-MM-DD. */
  from?: string | null;
  to?: string | null;
}

/** May this person read the tenant's full approval record? */
export function mayReadRecord(user: Decider): boolean {
  return can(user, 'view:audit') || can(user, 'manage:org') || can(user, 'process:payroll');
}

export async function listApprovalRequests(db: PrismaClient, user: Decider, opts: { scope: 'decide' | 'mine' | 'all'; status?: ApprovalRequest['status'] | null; limit?: number; filters?: RecordFilters }): Promise<ApprovalRequestSummary[]> {
  const tenantId = tenantIdForWrite();
  let where: Prisma.ApprovalRequestWhereInput;
  if (opts.scope === 'decide') where = await decidableWhere(db, user);
  else if (opts.scope === 'mine') where = { tenantId, requesterUserId: user.id, ...(opts.status ? { status: opts.status } : {}) };
  else {
    const f = opts.filters ?? {};
    where = {
      tenantId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.requesterUserId ? { requesterUserId: f.requesterUserId } : {}),
      ...(f.approverUserId ? { OR: [{ decidedById: f.approverUserId }, { approverUserId: f.approverUserId }] } : {}),
      ...(f.from || f.to
        ? { createdAt: { ...(f.from ? { gte: new Date(`${f.from}T00:00:00.000Z`) } : {}), ...(f.to ? { lt: new Date(new Date(`${f.to}T00:00:00.000Z`).getTime() + 86_400_000) } : {}) } }
        : {}),
    };
  }
  const rows = await db.approvalRequest.findMany({ where, orderBy: opts.scope === 'decide' ? { createdAt: 'asc' } : { createdAt: 'desc' }, take: Math.min(500, opts.limit ?? 200) });
  return Promise.all(rows.map((r) => shapeRequest(db, r, user)));
}
