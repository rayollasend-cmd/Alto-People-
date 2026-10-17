import type { Prisma, PrismaClient } from '@prisma/client';
import { hasCapability, type AgentApprovalSummary, type AgentGatedAction, type Role } from '@alto-people/shared';
import { approverMayDecide } from './agentGates.js';
import { listApprovalsByIds } from './agents.js';

/**
 * Who may decide an agent's proposal — the one rule, read by every surface
 * that shows a decision (the Approvals page, the inbox count, the phone
 * badge, the Agents page, the decide route):
 *
 *   - a request filed under a customer's gate that names an approver
 *     (owner, a role, a person) is that approver's alone;
 *   - otherwise an org admin (manage:org) may decide anything;
 *   - the desk the action belongs to decides its own: the scheduling desk a
 *     shift assignment (a client- or site-bound supervisor only for its own
 *     shifts), HR an HR case;
 *   - the agent's accountable owner may decide a request filed under today's
 *     rule (no gate policy), as the owner is who the request notifies.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface Decider {
  id: string;
  role: Role;
  clientId?: string | null;
  locationId?: string | null;
}

const DESK_DECIDERS: Partial<Record<AgentGatedAction, Parameters<typeof hasCapability>[1]>> = {
  SHIFT_ASSIGN: 'manage:scheduling',
  CASE_OPEN: 'manage:onboarding',
};

const PENDING_SELECT = {
  id: true,
  action: true,
  approverKind: true,
  approverRole: true,
  approverUserId: true,
  workerId: true,
  payload: true,
  requestedAt: true,
  agent: { select: { worker: { select: { ownerUserId: true } } } },
} as const;
type PendingRow = Prisma.AgentApprovalRequestGetPayload<{ select: typeof PENDING_SELECT }>;

function shiftIdOf(row: PendingRow): string | null {
  const v = (row.payload as Record<string, unknown> | null)?.subjectId;
  return typeof v === 'string' ? v : null;
}

async function keepDecidable(db: Db, tenantId: string, rows: PendingRow[], user: Decider): Promise<PendingRow[]> {
  if (!rows.length) return [];
  const orgAdmin = hasCapability(user.role, 'manage:org');
  const bounded = !!(user.clientId || user.locationId);
  // A bounded supervisor decides only for shifts inside its client or site: one query for all of them.
  let inside: Set<string> | null = null;
  if (bounded) {
    const shiftIds = [...new Set(rows.filter((r) => r.action === 'SHIFT_ASSIGN').map(shiftIdOf).filter((v): v is string => !!v))];
    inside = new Set(
      shiftIds.length
        ? (
            await db.shift.findMany({
              where: { id: { in: shiftIds }, tenantId, ...(user.clientId ? { clientId: user.clientId } : {}), ...(user.locationId ? { locationId: user.locationId } : {}) },
              select: { id: true },
            })
          ).map((s) => s.id)
        : [],
    );
  }
  const out: PendingRow[] = [];
  for (const r of rows) {
    // Brief 2-6 step 2: a named approver's request is theirs alone (decideApproval enforces it for every path).
    if (r.approverKind && r.approverKind !== 'DESK') {
      if (await approverMayDecide(db, r, { id: user.id, role: user.role })) out.push(r);
      continue;
    }
    if (orgAdmin) {
      out.push(r);
      continue;
    }
    const desk = DESK_DECIDERS[r.action];
    if (desk && hasCapability(user.role, desk)) {
      if (r.action === 'SHIFT_ASSIGN' && inside) {
        const sid = shiftIdOf(r);
        if (sid && inside.has(sid)) out.push(r);
        continue;
      }
      out.push(r);
      continue;
    }
    // Today's rule (no gate policy): the owner the request notified decides it.
    if (!r.approverKind && r.agent.worker.ownerUserId === user.id) out.push(r);
  }
  return out;
}

/** The pending requests this person may decide, oldest first. */
export async function decidableApprovals(db: Db, tenantId: string, user: Decider, limit = 500): Promise<PendingRow[]> {
  const rows = await db.agentApprovalRequest.findMany({
    where: { status: 'PENDING', expiresAt: { gt: new Date() }, agent: { tenantId } },
    select: PENDING_SELECT,
    orderBy: { requestedAt: 'asc' },
    take: limit,
  });
  return keepDecidable(db, tenantId, rows, user);
}

/** How many proposals wait on this person (the inbox source, the Approvals badge). */
export async function countDecidableApprovals(db: Db, tenantId: string, user: Decider): Promise<number> {
  return (await decidableApprovals(db, tenantId, user)).length;
}

/** The decidable ones among these ids (to mark `mayDecide` on a list the caller already has). */
export async function decidableIdsAmong(db: Db, tenantId: string, user: Decider, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.agentApprovalRequest.findMany({ where: { id: { in: [...ids] }, status: 'PENDING', agent: { tenantId } }, select: PENDING_SELECT });
  return new Set((await keepDecidable(db, tenantId, rows, user)).map((r) => r.id));
}

/**
 * May this person decide that one request? The rule alone, whatever the
 * request's state: a decided or expired one answers 409 from decideApproval,
 * which says so, rather than a 403 that would read as "not yours".
 */
export async function mayDecideApproval(db: Db, tenantId: string, approvalId: string, user: Decider): Promise<boolean> {
  const row = await db.agentApprovalRequest.findFirst({ where: { id: approvalId, agent: { tenantId } }, select: PENDING_SELECT });
  if (!row) return false;
  return (await keepDecidable(db, tenantId, [row], user)).length === 1;
}

/** The proposals waiting on this person, as the rows the Approvals page shows, each marked decidable. */
export async function listDecidableApprovals(db: Db, tenantId: string, user: Decider): Promise<AgentApprovalSummary[]> {
  const rows = await decidableApprovals(db, tenantId, user);
  const summaries = await listApprovalsByIds(db, rows.map((r) => r.id), tenantId);
  return summaries.map((a) => ({ ...a, mayDecide: true }));
}
