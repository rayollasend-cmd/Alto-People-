import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  AGENT_CAPABILITIES,
  capabilityDef,
  type AgentCapabilityDef,
  type AgentCapabilitySummary,
  type AgentProposalInput,
  type AgentProposalStatus,
  type AgentProposalSummary,
  type AgentScenarioAnswer,
  type AgentTenantControlState,
  type CapabilityScenarioFixture,
  type CapabilityScorecard,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { notifyUser } from './notify.js';
import { ALTO_TENANT_ID, runWithTenant } from './tenant.js';
import { loadTenantProfile, moduleOn } from './tenantProfile.js';
import { createApprovalRequest, logAgentAction, type AgentContext } from './agents.js';
import { AGENT_KILL_CATEGORY, evaluateScenario } from './agentControls.js';

/**
 * Agent families step 0 (docs/agent-families-investigation.md §8).
 *
 *   The tenant's kill switch — beside the AgentControl singleton, which
 *   stays the platform's. An agent is stopped when either is set.
 *
 *   Capabilities — the unit of governance: a row per (agent, capability)
 *   with its own switch, suspension (the owner alone resumes it) and drift
 *   threshold, and a scorecard read from the proposals it made.
 *
 *   Proposals — what a capability puts forward. A gated one files an
 *   approval request and waits; its status follows the approval (decided,
 *   expired, carried out) so the scorecard reads outcomes, not guesses.
 *
 *   The fixture runner — a capability's certification scenario seeds a
 *   small world into a throwaway tenant, runs the capability once with
 *   `now` fixed, compares, and removes the world.
 *
 * No capability's behaviour lives here: the sweeps move under their
 * capabilities in step 1.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const PERSON_SELECT = { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } as const;
async function userRef(db: Db, id: string | null): Promise<{ id: string; name: string } | null> {
  if (!id) return null;
  const u = await db.user.findUnique({ where: { id }, select: PERSON_SELECT });
  return u ? { id: u.id, name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email } : null;
}

const DAY = 24 * 3_600_000;

// ---------------------------------------------------------------------------
// The tenant's switch
// ---------------------------------------------------------------------------

export async function tenantControlState(db: Db, tenantId: string): Promise<AgentTenantControlState> {
  const row = await db.agentTenantControl.findUnique({ where: { tenantId } });
  return { allSuspendedAt: row?.allSuspendedAt?.toISOString() ?? null, suspendedBy: await userRef(db, row?.suspendedById ?? null), reason: row?.reason ?? null };
}

export async function tenantAgentsSuspended(db: Db, tenantId: string): Promise<boolean> {
  const row = await db.agentTenantControl.findUnique({ where: { tenantId }, select: { allSuspendedAt: true } });
  return row?.allSuspendedAt != null;
}

/** This organization's agents stop: their credentials are revoked now and the switch is read on every call. */
export async function suspendTenantAgents(db: Db, tenantId: string, actorUserId: string, reason: string, now: Date = new Date()): Promise<{ revoked: number; agents: number }> {
  await db.agentTenantControl.upsert({
    where: { tenantId },
    create: { tenantId, allSuspendedAt: now, suspendedById: actorUserId, reason },
    update: { allSuspendedAt: now, suspendedById: actorUserId, reason },
  });
  const revoked = await db.agentCredential.updateMany({
    where: { agent: { tenantId }, expiresAt: { gt: now }, OR: [{ revokedAt: null }, { revokedAt: { gt: now } }] },
    data: { revokedAt: now, revokedReason: 'all agents suspended' },
  });
  const owners = await db.worker.findMany({ where: { type: 'AGENT', status: 'ACTIVE', tenantId }, select: { id: true, ownerUserId: true } });
  enqueueAudit({ actorUserId, clientId: null, action: 'agent.tenant_suspended', entityType: 'AgentTenantControl', entityId: tenantId, metadata: { reason, revoked: revoked.count, agents: owners.length } }, 'agentCapabilities');
  for (const ownerId of new Set(owners.map((o) => o.ownerUserId))) {
    await notifyUser(ownerId, { subject: 'All AI agents were suspended', body: `${reason} Every agent credential was revoked; agents resume when an admin lifts the switch and issues new credentials.`, category: AGENT_KILL_CATEGORY, linkUrl: '/agents' });
  }
  return { revoked: revoked.count, agents: owners.length };
}

export async function resumeTenantAgents(db: Db, tenantId: string, actorUserId: string, now: Date = new Date()): Promise<void> {
  const row = await db.agentTenantControl.findUnique({ where: { tenantId } });
  if (!row?.allSuspendedAt) throw new HttpError(409, 'agents_not_suspended', 'Agents are not suspended.');
  await db.agentTenantControl.update({ where: { tenantId }, data: { allSuspendedAt: null, suspendedById: null, reason: null } });
  enqueueAudit({ actorUserId, clientId: null, action: 'agent.tenant_resumed', entityType: 'AgentTenantControl', entityId: tenantId, metadata: { suspendedAt: row.allSuspendedAt.toISOString(), at: now.toISOString() } }, 'agentCapabilities');
}

// ---------------------------------------------------------------------------
// Capabilities on an agent
// ---------------------------------------------------------------------------

type CapRow = Prisma.AgentCapabilityGetPayload<Record<string, never>>;

async function capabilitySummary(db: Db, def: AgentCapabilityDef, row: CapRow, offered: boolean): Promise<AgentCapabilitySummary> {
  return {
    key: def.key,
    label: def.label,
    family: def.family,
    gate: def.gate,
    requiresModule: [...def.requiresModule],
    offered,
    enabled: row.enabled,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    suspendedBy: await userRef(db, row.suspendedById),
    suspendReason: row.suspendReason,
    driftErrorRatePct: row.driftErrorRatePct,
  };
}

/** The agent's capabilities, each with whether its tenant offers it (every required module on). */
export async function listAgentCapabilities(db: Db, workerId: string, tenantId: string): Promise<AgentCapabilitySummary[]> {
  const rows = await db.agentCapability.findMany({ where: { workerId, tenantId }, orderBy: { key: 'asc' } });
  const profile = await loadTenantProfile(tenantId);
  const out: AgentCapabilitySummary[] = [];
  for (const r of rows) {
    const def = capabilityDef(r.key);
    if (!def) continue;
    out.push(await capabilitySummary(db, def, r, def.requiresModule.every((m) => profile.modules[m])));
  }
  return out;
}

/** Give an agent a capability (the family agents in step 1; tests now). Idempotent. */
export async function grantCapability(db: Db, workerId: string, key: string, tenantId: string): Promise<CapRow> {
  if (!capabilityDef(key)) throw new HttpError(400, 'capability_unknown', `No capability ${key} in the catalog.`);
  const existing = await db.agentCapability.findUnique({ where: { workerId_key: { workerId, key } } });
  if (existing) return existing;
  return db.agentCapability.create({ data: { workerId, key, tenantId } });
}

async function ownCapability(db: Db, workerId: string, key: string, tenantId: string): Promise<CapRow> {
  const row = await db.agentCapability.findFirst({ where: { workerId, key, tenantId } });
  if (!row) throw new HttpError(404, 'capability_not_found', 'This agent does not hold that capability.');
  return row;
}

export async function suspendCapability(db: Db, workerId: string, key: string, tenantId: string, actorUserId: string, reason: string, now: Date = new Date()): Promise<AgentCapabilitySummary> {
  const row = await ownCapability(db, workerId, key, tenantId);
  const updated = await db.agentCapability.update({ where: { id: row.id }, data: { suspendedAt: now, suspendedById: actorUserId, suspendReason: reason } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'agent.capability_suspended', entityType: 'AgentCapability', entityId: row.id, metadata: { key, reason } }, 'agentCapabilities');
  const owner = await db.worker.findUnique({ where: { id: workerId }, select: { ownerUserId: true, name: true } });
  if (owner && owner.ownerUserId !== actorUserId) {
    await notifyUser(owner.ownerUserId, { subject: `${owner.name}: ${capabilityDef(key)!.label} was suspended`, body: `${reason} Only you can resume it.`, category: AGENT_KILL_CATEGORY, linkUrl: `/agents?agent=${workerId}` });
  }
  return capabilitySummary(db, capabilityDef(key)!, updated, true);
}

/** The accountable owner brings a capability back, as with the agent itself. */
export async function resumeCapability(db: Db, workerId: string, key: string, tenantId: string, actorUserId: string, now: Date = new Date()): Promise<AgentCapabilitySummary> {
  const row = await ownCapability(db, workerId, key, tenantId);
  const owner = await db.worker.findUnique({ where: { id: workerId }, select: { ownerUserId: true } });
  if (owner?.ownerUserId !== actorUserId) throw new HttpError(403, 'owner_only', 'Only the accountable owner can resume this capability.');
  if (!row.suspendedAt) throw new HttpError(409, 'capability_not_suspended', 'This capability is not suspended.');
  const updated = await db.agentCapability.update({ where: { id: row.id }, data: { suspendedAt: null, suspendedById: null, suspendReason: null } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'agent.capability_resumed', entityType: 'AgentCapability', entityId: row.id, metadata: { key, suspendedAt: row.suspendedAt.toISOString(), at: now.toISOString() } }, 'agentCapabilities');
  return capabilitySummary(db, capabilityDef(key)!, updated, true);
}

/** Per-capability counts over the trailing days, from the proposals it made. */
export async function capabilityScorecard(db: Db, workerId: string, key: string, days = 7, now: Date = new Date()): Promise<CapabilityScorecard> {
  const since = new Date(now.getTime() - days * DAY);
  const grouped = await db.agentProposal.groupBy({ by: ['status'], where: { workerId, capabilityKey: key, createdAt: { gte: since } }, _count: { _all: true } });
  const n = (s: AgentProposalStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const proposed = grouped.reduce((sum, g) => sum + g._count._all, 0);
  const executed = n('EXECUTED');
  const failed = n('FAILED');
  const rejected = n('REJECTED');
  const expired = n('EXPIRED');
  const decided = executed + failed + rejected + expired;
  return {
    key,
    days,
    proposed,
    // Approved = everything a person said yes to, whether or not it ran yet.
    approved: n('APPROVED') + executed + failed,
    rejected,
    expired,
    executed,
    failed,
    superseded: n('SUPERSEDED'),
    outcomeRatePct: decided > 0 ? Math.round((executed * 100) / decided) : null,
  };
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

type ProposalRow = Prisma.AgentProposalGetPayload<Record<string, never>>;

function proposalSummary(p: ProposalRow): AgentProposalSummary {
  return {
    id: p.id,
    workerId: p.workerId,
    capabilityKey: p.capabilityKey,
    subjectType: p.subjectType,
    subjectId: p.subjectId,
    payload: (p.payload as Record<string, unknown>) ?? {},
    approvalId: p.approvalId,
    status: p.status,
    statusAt: p.statusAt.toISOString(),
    outcome: (p.outcome as Record<string, unknown> | null) ?? null,
    outcomeAt: p.outcomeAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function listProposals(db: Db, tenantId: string, f: { capability?: string; status?: AgentProposalStatus; workerId?: string } = {}, limit = 200): Promise<AgentProposalSummary[]> {
  const rows = await db.agentProposal.findMany({
    where: { tenantId, ...(f.capability ? { capabilityKey: f.capability } : {}), ...(f.status ? { status: f.status } : {}), ...(f.workerId ? { workerId: f.workerId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map(proposalSummary);
}

/**
 * An agent puts something forward under one of its capabilities. Refused
 * when the tenant has a required module off (404: the capability is not
 * offered), when the agent does not hold it or it is suspended or off,
 * or when the agent lacks a scope the capability needs. A gated capability
 * files an approval request and the proposal waits on it.
 */
export async function createProposal(db: Db, agent: AgentContext, input: AgentProposalInput, now: Date = new Date()): Promise<{ proposal: AgentProposalSummary; approvalId: string | null; created: boolean }> {
  const def = capabilityDef(input.capability);
  if (!def) throw new HttpError(400, 'capability_unknown', `No capability ${input.capability} in the catalog.`);
  const tenantId = agent.tenantId ?? ALTO_TENANT_ID;
  for (const m of def.requiresModule) {
    if (!(await moduleOn(m, tenantId))) throw new HttpError(404, 'capability_not_offered', 'That capability is not offered here.');
  }
  const cap = await db.agentCapability.findFirst({ where: { workerId: agent.workerId, key: def.key, tenantId } });
  if (!cap) throw new HttpError(403, 'capability_not_granted', `This agent does not hold ${def.key}.`);
  if (!cap.enabled || cap.suspendedAt) throw new HttpError(403, 'capability_suspended', `${def.label} is suspended for this agent.`);
  const missing = def.scopes.find((s) => !agent.scopes.includes(s));
  if (missing) throw new HttpError(403, 'agent_scope_missing', `This agent was not granted ${missing}.`);

  let approvalId: string | null = null;
  let created = true;
  if (def.gate) {
    if (!input.summary) throw new HttpError(400, 'summary_required', 'A gated proposal needs a summary a person can approve.');
    const payload = { capability: def.key, subjectType: input.subjectType, subjectId: input.subjectId ?? null, ...input.payload };
    const r = await createApprovalRequest(db, agent, { action: def.gate, summary: input.summary, payload }, now);
    approvalId = r.approval.id;
    created = r.created;
    // Asking twice is the same proposal, as it is the same approval.
    const existing = await db.agentProposal.findUnique({ where: { approvalId } });
    if (existing) return { proposal: proposalSummary(existing), approvalId, created: false };
  }
  const row = await db.agentProposal.create({
    data: {
      workerId: agent.workerId,
      capabilityKey: def.key,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      payload: input.payload as Prisma.InputJsonObject,
      approvalId,
      tenantId,
      statusAt: now,
      createdAt: now,
    },
  });
  logAgentAction(agent, { action: 'agent.proposal_created', entityType: 'AgentProposal', entityId: row.id, scopes: [...def.scopes], approvalId, metadata: { capability: def.key, subjectType: input.subjectType, subjectId: input.subjectId ?? null } });
  return { proposal: proposalSummary(row), approvalId, created };
}

/** The proposal follows its approval: decided, expired, or carried out. */
export async function syncProposalWithApproval(db: Db, approvalId: string, status: AgentProposalStatus, now: Date = new Date(), outcome?: Record<string, unknown>): Promise<void> {
  await db.agentProposal.updateMany({
    where: { approvalId },
    data: { status, statusAt: now, ...(outcome ? { outcome: outcome as Prisma.InputJsonObject, outcomeAt: now } : {}) },
  });
}

// ---------------------------------------------------------------------------
// The desk's share of the approval queue (handoff spine: the right desk decides)
// ---------------------------------------------------------------------------

/** A desk account's own bounds: a client-bound or site-bound supervisor decides only for its shifts. */
export interface DeskBounds {
  clientId?: string | null;
  locationId?: string | null;
}

async function pendingDeskApprovalIds(db: Db, tenantId: string, action: 'SHIFT_ASSIGN' | 'CASE_OPEN', bounds: DeskBounds): Promise<string[]> {
  const pending = await db.agentApprovalRequest.findMany({ where: { status: 'PENDING', action, agent: { tenantId } }, select: { id: true, payload: true } });
  if (!pending.length) return [];
  if (action !== 'SHIFT_ASSIGN' || (!bounds.clientId && !bounds.locationId)) return pending.map((p) => p.id);
  // Bounded: only the requests whose shift sits inside the account's client or site.
  const shiftOf = new Map(pending.map((p) => [p.id, ((p.payload as Record<string, unknown>)?.subjectId as string | undefined) ?? null]));
  const shiftIds = [...new Set([...shiftOf.values()].filter((v): v is string => typeof v === 'string'))];
  if (!shiftIds.length) return [];
  const inside = await db.shift.findMany({
    where: { id: { in: shiftIds }, tenantId, ...(bounds.clientId ? { clientId: bounds.clientId } : {}), ...(bounds.locationId ? { locationId: bounds.locationId } : {}) },
    select: { id: true },
  });
  const ok = new Set(inside.map((s) => s.id));
  return pending.filter((p) => ok.has(shiftOf.get(p.id) ?? '')).map((p) => p.id);
}

/** How many of the desk's agent requests are waiting (the decision item's count). */
export async function pendingDeskApprovals(db: Db, tenantId: string, action: 'SHIFT_ASSIGN' | 'CASE_OPEN', bounds: DeskBounds = {}): Promise<number> {
  return (await pendingDeskApprovalIds(db, tenantId, action, bounds)).length;
}

/** May this desk account decide that request? (Org admins always may; the route checks that first.) */
export async function deskMayDecide(db: Db, tenantId: string, approvalId: string, action: 'SHIFT_ASSIGN' | 'CASE_OPEN', bounds: DeskBounds): Promise<boolean> {
  const row = await db.agentApprovalRequest.findFirst({ where: { id: approvalId, action, agent: { tenantId } }, select: { status: true, payload: true } });
  if (!row) return false;
  if (action !== 'SHIFT_ASSIGN' || (!bounds.clientId && !bounds.locationId)) return true;
  const shiftId = (row.payload as Record<string, unknown>)?.subjectId;
  if (typeof shiftId !== 'string') return false;
  const shift = await db.shift.findFirst({
    where: { id: shiftId, tenantId, ...(bounds.clientId ? { clientId: bounds.clientId } : {}), ...(bounds.locationId ? { locationId: bounds.locationId } : {}) },
    select: { id: true },
  });
  return !!shift;
}

// ---------------------------------------------------------------------------
// The fixture scenario runner
// ---------------------------------------------------------------------------

/** What a capability runner sees: the fixture's world, by its refs, in a throwaway tenant. */
export interface CapabilityFixtureContext {
  db: PrismaClient;
  tenantId: string;
  now: Date;
  refs: Record<string, string>;
  input: Record<string, unknown>;
}

export type CapabilityRunner = (ctx: CapabilityFixtureContext) => Promise<AgentScenarioAnswer>;

/** The capabilities the API can run itself. Step 0 registers none; step 1 adds shift.fill. */
const RUNNERS = new Map<string, CapabilityRunner>();

export function registerCapabilityRunner(key: string, runner: CapabilityRunner): void {
  if (!capabilityDef(key)) throw new Error(`No capability ${key} in the catalog.`);
  RUNNERS.set(key, runner);
}

export function unregisterCapabilityRunnerForTests(key: string): void {
  RUNNERS.delete(key);
}

export function capabilityRunnable(key: string): boolean {
  return RUNNERS.has(key);
}

/**
 * Load the fixture's world into a throwaway tenant, run the capability once
 * with `now` fixed, compare against the fixture's expectation, and remove
 * the world and the tenant whatever happened.
 */
export async function runCapabilityFixture(
  key: string,
  fixture: CapabilityScenarioFixture,
  now: Date,
  db: PrismaClient = defaultPrisma,
): Promise<{ passed: boolean; reason: string | null; answer: AgentScenarioAnswer | null }> {
  const runner = RUNNERS.get(key);
  if (!runner) throw new HttpError(409, 'capability_not_runnable', `The API cannot run ${key} itself yet.`);
  const tenantId = randomUUID();
  const created: { shifts: string[]; assignments: string[]; associates: string[]; sites: string[] } = { shifts: [], assignments: [], associates: [], sites: [] };
  await db.tenant.create({ data: { id: tenantId, slug: `fixture-${tenantId.slice(0, 8)}`, name: `Fixture ${fixture.name.slice(0, 60)}` } });
  try {
    return await runWithTenant(tenantId, 'job', async () => {
      const refs: Record<string, string> = {};
      for (const s of fixture.world.sites ?? []) {
        const row = await db.site.create({ data: { name: s.name, clientId: null, tenantId, ...(s.timezone ? { timezone: s.timezone } : {}) }, select: { id: true } });
        refs[s.ref] = row.id;
        created.sites.push(row.id);
      }
      for (const p of fixture.world.people ?? []) {
        const row = await db.associate.create({ data: { firstName: p.firstName, lastName: p.lastName, email: `${p.ref}.${tenantId.slice(0, 8)}@fixture.invalid`, tenantId }, select: { id: true } });
        refs[p.ref] = row.id;
        created.associates.push(row.id);
        if (p.placedAt) {
          const a = await db.associateAssignment.create({ data: { associateId: row.id, locationId: refs[p.placedAt]!, startedAt: new Date(now.getTime() - 30 * DAY), tenantId }, select: { id: true } });
          created.assignments.push(a.id);
        }
      }
      for (const sh of fixture.world.shifts ?? []) {
        const startsAt = new Date(now.getTime() + sh.startsInMinutes * 60_000);
        const row = await db.shift.create({
          data: {
            clientId: null,
            locationId: refs[sh.siteRef]!,
            position: sh.position,
            startsAt,
            endsAt: new Date(startsAt.getTime() + sh.hours * 3_600_000),
            status: sh.assigneeRef ? 'ASSIGNED' : 'OPEN',
            assignedAssociateId: sh.assigneeRef ? refs[sh.assigneeRef]! : null,
            publishedAt: now,
            tenantId,
          },
          select: { id: true },
        });
        refs[sh.ref] = row.id;
        created.shifts.push(row.id);
      }
      const answer = await runner({ db, tenantId, now, refs, input: fixture.input });
      // An expected output names refs; compare in refs, not ids.
      const byId = new Map(Object.entries(refs).map(([ref, id]) => [id, ref]));
      const output = answer.output ? Object.fromEntries(Object.entries(answer.output).map(([k, v]) => [k, typeof v === 'string' && byId.has(v) ? byId.get(v)! : v])) : undefined;
      const verdict = evaluateScenario(fixture.expected, { ...answer, ...(output ? { output } : {}) });
      return { ...verdict, answer };
    });
  } finally {
    await db.shift.deleteMany({ where: { id: { in: created.shifts } } });
    await db.associateAssignment.deleteMany({ where: { id: { in: created.assignments } } });
    await db.worker.deleteMany({ where: { associateId: { in: created.associates } } });
    await db.associate.deleteMany({ where: { id: { in: created.associates } } });
    await db.site.deleteMany({ where: { id: { in: created.sites } } });
    await db.tenant.deleteMany({ where: { id: tenantId } });
  }
}

/** The catalog keys, for the boot sweep and the Agents page. */
export const CAPABILITY_KEYS: readonly string[] = AGENT_CAPABILITIES.map((c) => c.key);
