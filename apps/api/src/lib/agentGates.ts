import { Role, type AgentGatePolicy, type Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AGENT_GATED_ACTION_LABELS, AgentGatedActionSchema, capabilityDef, type AgentGatedAction } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { recordCriticalAudit } from './audit.js';
import { ALTO_TENANT_ID } from './tenant.js';
import { decisionTypesFor } from './decisionRecord.js';

/**
 * Brief 2-6 step 2 — customer-defined gates (docs/agent-product-billing-investigation.md §4.2).
 *
 *   gateFor(agent, action, capability) reads the most specific policy in
 *   force (AGENT over CAPABILITY over FAMILY over TENANT; a policy naming the
 *   action beats one naming `*` at the same scope) on top of the platform
 *   floor. THE FLOOR CANNOT BE LOWERED (decision 5): a platform-gated action
 *   (pay change, separation, a client message, a data export, a shift
 *   assignment, an HR case) is required whatever a policy says; a policy
 *   can only add a requirement where the platform has none, or name who
 *   decides and how long the request lives. Pay changes and separations
 *   stay human-only by construction: every approver is a person.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type GateApprover = 'OWNER' | 'ROLE' | 'DESK' | 'USER';

export interface GateDecision {
  required: boolean;
  /** Required by the platform itself (a policy cannot remove it). */
  floor: boolean;
  approver: GateApprover;
  approverRole: Role | null;
  approverUserId: string | null;
  ttlHours: number;
  policyId: string | null;
  /** In words, for the preview and the request. */
  reason: string;
}

const SCOPE_RANK: Record<string, number> = { AGENT: 4, CAPABILITY: 3, FAMILY: 2, TENANT: 1 };
export const DEFAULT_TTL_HOURS = 72;

export async function gateFor(
  db: Db,
  agent: { workerId: string; tenantId: string | null; family: string | null },
  action: AgentGatedAction | null,
  capabilityKey: string | null,
  now: Date = new Date(),
): Promise<GateDecision> {
  const tenantId = agent.tenantId ?? ALTO_TENANT_ID;
  // Brief 2-6 step 3 (decision 5): a capability tagged as deciding something about a person's
  // employment always needs a person, like the platform's own gated actions.
  const decides = capabilityKey ? (await decisionTypesFor(db, agent.workerId, capabilityKey)).length > 0 : false;
  const floor = (action !== null && action !== 'POLICY_GATE') || decides;
  const actions = ['*', ...(action && action !== 'POLICY_GATE' ? [action] : []), ...(capabilityKey ? [capabilityKey] : [])];
  const policies = await db.agentGatePolicy.findMany({
    where: {
      tenantId,
      action: { in: actions },
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
  });
  const applies = (p: AgentGatePolicy) =>
    p.scope === 'TENANT' || (p.scope === 'AGENT' && p.scopeKey === agent.workerId) || (p.scope === 'CAPABILITY' && p.scopeKey === capabilityKey) || (p.scope === 'FAMILY' && !!agent.family && p.scopeKey === agent.family);
  const best = policies
    .filter(applies)
    .sort((a, b) => (SCOPE_RANK[b.scope] ?? 0) - (SCOPE_RANK[a.scope] ?? 0) || Number(b.action !== '*') - Number(a.action !== '*') || b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];

  const what = action && action !== 'POLICY_GATE' ? AGENT_GATED_ACTION_LABELS[action] : capabilityKey ? (capabilityDef(capabilityKey)?.label ?? capabilityKey) : 'This action';
  if (!best) {
    return { required: floor, floor, approver: 'OWNER', approverRole: null, approverUserId: null, ttlHours: DEFAULT_TTL_HOURS, policyId: null, reason: floor ? `${what} always needs a person's approval.` : `${what} needs no approval here.` };
  }
  const required = floor || best.requirement === 'REQUIRED';
  const who = best.approver === 'ROLE' ? `anyone in the ${best.approverRole} role` : best.approver === 'USER' ? 'a named person' : best.approver === 'DESK' ? 'the desk the subject belongs to' : "the agent's owner";
  return {
    required,
    floor,
    approver: best.approver as GateApprover,
    approverRole: best.approverRole,
    approverUserId: best.approverUserId,
    ttlHours: best.ttlHours,
    policyId: best.id,
    reason: required
      ? `${what} needs approval by ${who} (${best.scope.toLowerCase()} policy${floor && best.requirement === 'NOT_REQUIRED' ? '; the platform requires it whatever the policy says' : ''}).`
      : `${what} needs no approval here (${best.scope.toLowerCase()} policy).`,
  };
}

/** Whether `decider` may decide a request filed under these approver fields. Null kind: today's rule (the route's gate decides). */
export async function approverMayDecide(
  db: Db,
  row: { approverKind: string | null; approverRole: Role | null; approverUserId: string | null; workerId: string },
  decider: { id: string; role: Role },
): Promise<boolean> {
  switch (row.approverKind) {
    case null:
    case 'DESK':
      return true;
    case 'USER':
      return row.approverUserId === decider.id;
    case 'ROLE':
      return row.approverRole === decider.role;
    case 'OWNER': {
      const w = await db.worker.findUnique({ where: { id: row.workerId }, select: { ownerUserId: true } });
      return w?.ownerUserId === decider.id;
    }
    default:
      return false;
  }
}

/* ---------------------------------------------------------- policies */

const ActionSchema = z.union([z.literal('*'), AgentGatedActionSchema.exclude(['POLICY_GATE']), z.string().regex(/^[a-z][a-z0-9-]*\.[a-z0-9.-]+$/)]);

export const GatePolicyInputSchema = z
  .object({
    scope: z.enum(['TENANT', 'FAMILY', 'CAPABILITY', 'AGENT']),
    scopeKey: z.string().trim().max(120).nullable().optional(),
    action: ActionSchema,
    requirement: z.enum(['REQUIRED', 'NOT_REQUIRED']),
    approver: z.enum(['OWNER', 'ROLE', 'DESK', 'USER']).default('OWNER'),
    approverRole: z.string().nullable().optional(),
    approverUserId: z.string().uuid().nullable().optional(),
    ttlHours: z.number().int().min(1).max(168).default(DEFAULT_TTL_HOURS),
    effectiveTo: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((p) => (p.scope === 'TENANT') === !p.scopeKey, { message: 'A tenant-wide policy names no key; the others name their family, capability or agent.', path: ['scopeKey'] })
  .refine((p) => (p.approver === 'ROLE') === !!p.approverRole, { message: 'A role approver names its role.', path: ['approverRole'] })
  .refine((p) => (p.approver === 'USER') === !!p.approverUserId, { message: 'A named approver names the person.', path: ['approverUserId'] });
export type GatePolicyInput = z.infer<typeof GatePolicyInputSchema>;

export async function createGatePolicy(db: Db, tenantId: string, input: GatePolicyInput, actorUserId: string) {
  if (input.scope === 'AGENT' && !(await db.worker.findFirst({ where: { id: input.scopeKey!, tenantId, type: 'AGENT' }, select: { id: true } }))) {
    throw new HttpError(404, 'agent_not_found', 'No such agent.');
  }
  if (input.approverRole && !(Object.values(Role) as string[]).includes(input.approverRole)) throw new HttpError(400, 'role_unknown', 'No such role.');
  if (input.scope === 'CAPABILITY' && !capabilityDef(input.scopeKey!)) throw new HttpError(400, 'capability_unknown', 'No such capability in the catalog.');
  if (input.approverUserId && !(await db.user.findFirst({ where: { id: input.approverUserId, tenantId, status: 'ACTIVE', deletedAt: null }, select: { id: true } }))) {
    throw new HttpError(400, 'approver_not_found', 'The approver must be an active account of this organization.');
  }
  const row = await db.agentGatePolicy.create({
    data: {
      tenantId,
      scope: input.scope,
      scopeKey: input.scope === 'TENANT' ? null : input.scopeKey!,
      action: input.action,
      requirement: input.requirement,
      approver: input.approver,
      approverRole: (input.approverRole ?? null) as Role | null,
      approverUserId: input.approverUserId ?? null,
      ttlHours: input.ttlHours,
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
      createdById: actorUserId,
    },
  });
  await recordCriticalAudit({ actorUserId, clientId: null, tenantId, action: 'agent.gate_policy_created', entityType: 'AgentGatePolicy', entityId: row.id, metadata: { ...input } as Prisma.InputJsonObject }, 'agentGates');
  return row;
}

/** Ends a policy now (kept, never deleted: the requests filed under it name it). */
export async function endGatePolicy(db: Db, tenantId: string, id: string, actorUserId: string, now: Date = new Date()) {
  const r = await db.agentGatePolicy.updateMany({ where: { id, tenantId, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }, data: { effectiveTo: now } });
  if (!r.count) throw new HttpError(404, 'gate_policy_not_found', 'No such policy in force.');
  await recordCriticalAudit({ actorUserId, clientId: null, tenantId, action: 'agent.gate_policy_ended', entityType: 'AgentGatePolicy', entityId: id, metadata: {} }, 'agentGates');
}
