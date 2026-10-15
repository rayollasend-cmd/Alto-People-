import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  AGENT_EXECUTABLE_ACTIONS,
  AGENT_GATED_ACTION_LABELS,
  capabilityDef,
  rolesWithCapability,
  type AgentApprovalSummary,
  type AgentCredentialState,
  type AgentCredentialSummary,
  type AgentDetail,
  type AgentFamily,
  type AgentGatedAction,
  type AgentInput,
  type AgentIssuedCredential,
  type AgentRegistryResponse,
  type AgentScope,
  type AgentSummary,
  type AgentTrailEntry,
  type AgentUpdate,
  type WorkerStatus,
  type WorkerSummary,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { notifyUser } from './notify.js';
import { fanOutMessage, syncStoreChannel } from './messaging.js';
import { createWorker, getWorker, listWorkers, updateWorker } from './workers.js';
import { allAgentsSuspended, certification, controlState, onModelVersionChanged, scorecard } from './agentControls.js';
import { afterProposalApproved, grantCapability, seedCatalogScenarios, syncProposalWithApproval, tenantAgentsSuspended, tenantControlState } from './agentCapabilities.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';
import { emitAgentApproval } from './webhookEvents.js';
import { moduleOn } from './tenantProfile.js';
import { approverMayDecide, gateFor } from './agentGates.js';
import { recordDecisionsForApproval } from './decisionRecord.js';

/** Agent families step 0: the tenant the registry works in — the request's or job's, Alto HR when none. */
function registryTenant(tenantId?: string | null): string {
  return tenantId ?? currentTenantId() ?? ALTO_TENANT_ID;
}

/**
 * The agent registry (Brief 1D-2).
 *
 *   An AI agent is a Worker of type AGENT with an AgentProfile: purpose,
 *   vendor and model, least-privilege scopes drawn from the role catalog,
 *   limits (monthly spend, calls per minute, hours of operation), and
 *   short-lived credentials it calls /agent/v1 with. Everything it does
 *   through that surface lands in AuditLog under its workerId, and the
 *   AuditLog table refuses edits at the database (trigger in migration
 *   20261107090000_agent_registry).
 *
 *   Four actions are gated: an agent may only ask. The request sits in a
 *   queue until a person approves or rejects it; an approved CLIENT_MESSAGE
 *   or DATA_EXPORT the agent then carries out once, citing the approval;
 *   PAY_CHANGE and SEPARATION are done by the approver in the app, the
 *   approval being the record that the agent asked and who said yes.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const AGENT_TOKEN_PREFIX = 'alto_agent_';
const ORG_TZ = 'America/New_York';
/** A rotated credential keeps working this long so an in-flight job finishes. */
export const ROTATION_GRACE_MS = 5 * 60_000;
/** An unanswered request expires after three days. */
export const APPROVAL_TTL_MS = 72 * 3_600_000;
export const AGENT_APPROVAL_CATEGORY = 'agent_approval';

export interface AgentContext {
  workerId: string;
  name: string;
  ownerUserId: string;
  status: WorkerStatus;
  scopes: AgentScope[];
  credentialId: string;
  rateLimitPerMinute: number;
  /** Brief 2-1: the tenant the agent belongs to (its profile row). */
  tenantId: string | null;
}

export type AgentDenial = {
  ok: false;
  status: 401 | 403 | 429;
  code: string;
  message: string;
  workerId: string | null;
  credentialId: string | null;
};
export type AgentAuthResult = { ok: true; agent: AgentContext } | AgentDenial;

// ---------------------------------------------------------------------------
// Tokens, hours, months
// ---------------------------------------------------------------------------

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function mintToken(): { plaintext: string; hash: string; last4: string } {
  const body = randomBytes(32).toString('hex');
  const plaintext = `${AGENT_TOKEN_PREFIX}${body}`;
  return { plaintext, hash: hashToken(plaintext), last4: body.slice(-4) };
}

export function hourInOrgTz(d: Date): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: ORG_TZ, hour: 'numeric', hour12: false }).format(d);
  return Number(h) % 24;
}

/** Both bounds null = any hour. A start after the end is an overnight window. */
export function withinAllowedHours(start: number | null, end: number | null, now: Date): boolean {
  if (start == null || end == null) return true;
  const h = hourInOrgTz(now);
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** The first instant of the org-local calendar month, to the hour. */
export function monthStart(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ORG_TZ, year: 'numeric', month: 'numeric' }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')?.value);
  const m = Number(parts.find((p) => p.type === 'month')?.value);
  return new Date(Date.UTC(y, m - 1, 1, 5));
}

export async function monthSpendCents(db: Db, workerId: string, now: Date): Promise<number> {
  const agg = await db.agentSpend.aggregate({ where: { workerId, occurredAt: { gte: monthStart(now) } }, _sum: { amountCents: true } });
  return agg._sum.amountCents ?? 0;
}

// ---------------------------------------------------------------------------
// The agents Alto already runs
// ---------------------------------------------------------------------------

export const BUILT_IN_AGENTS = [
  {
    key: 'claude-code-deploy',
    name: 'Claude Code deployment workflow',
    family: 'deployment',
    capability: 'Build, test, push and watch the deploy',
    purpose: 'Builds Alto People from the briefs, runs the tests, pushes to main and watches the deploy. Acts through git and CI, not through the API, so it holds no credential.',
    vendor: 'Anthropic',
    model: 'Claude Fable',
    modelVersion: '5.1',
    environment: 'PRODUCTION',
    scopes: [] as AgentScope[],
    capabilities: ['deploy'],
    status: 'ACTIVE',
  },
  {
    key: 'boardroom',
    name: 'Boardroom agents',
    family: 'decision-intelligence',
    capability: 'Read reports and draft recommendations for leadership',
    purpose: 'Advisory agents that read reports and draft recommendations for leadership. Registered from the brief: confirm vendor, model version and owner before issuing a credential.',
    vendor: 'Anthropic',
    model: 'Claude',
    modelVersion: 'unconfirmed',
    environment: 'PRODUCTION',
    scopes: ['view:analytics'] as AgentScope[],
    capabilities: ['report-read'],
    status: 'ONBOARDING',
  },
  {
    key: 'whatsapp-assistant',
    name: 'Hugo on WhatsApp',
    family: 'associate-self-service',
    capability: 'Payday, ride and schedule answers on WhatsApp; supervisor handoff',
    purpose: "Answers payday, ride and schedule questions on WhatsApp from the associate's own records and hands anything else to their supervisor (Brief 1C-4). Runs inside the API; every reply is logged under this record.",
    vendor: 'Alto People',
    model: 'Rule-based assistant (lib/whatsappAssistant)',
    modelVersion: '1',
    environment: 'PRODUCTION',
    scopes: ['view:scheduling', 'view:time', 'view:transport', 'manage:communications'] as AgentScope[],
    capabilities: ['messaging', 'schedule-read'],
    status: 'ACTIVE',
  },
  {
    key: 'workforce-agent',
    name: 'Workforce agent',
    family: 'workforce',
    capability: 'Fill open shifts: propose a named person after the open-shift broadcast goes unanswered; a supervisor approves',
    purpose: 'Proposes one named person for each open shift the open-shift broadcast did not fill (step 1), for each shift approved leave, a separation or an emergency stand-down leaves uncovered, and for a high-risk holder who says no or goes silent past the cut-off when asked the day before (step 2), from the people placed there, free and within the scheduling rules. Nothing is assigned until a supervisor approves; it then assigns through the same rules a supervisor does.',
    vendor: 'Alto People',
    model: 'Rule-based agent (lib/workforceAgent)',
    modelVersion: '1',
    environment: 'PRODUCTION',
    scopes: ['view:scheduling', 'view:org', 'manage:scheduling', 'view:time', 'manage:communications', 'view:analytics'] as AgentScope[],
    capabilities: ['shift.fill', 'schedule.repair', 'attendance.confirm', 'coverage.forecast'],
    grants: ['shift.fill', 'schedule.repair', 'attendance.confirm', 'coverage.forecast'],
    // Agent controls (1D-3): a new agent starts ONBOARDING and goes ACTIVE only by passing
    // its certification scenarios on the Agents page. Deploying never switches it on.
    status: 'ONBOARDING',
  },
  {
    key: 'compliance-agent',
    name: 'Compliance agent',
    family: 'compliance',
    capability: 'Chase expiring documents and keep I-9 Section 2 on time: each person hears in their language; the desk gets a worklist',
    purpose: 'Chases each person whose document or authorization expires within 30 days (in their language, with the upload link; again at 14 and 3 days; to HR at expiry; never a waived item), and keeps the verifier desk on the I-9 Section 2 clock (three business days from the start date) with the E-Verify readiness reason, climbing to HR the day before (agent families step 4). It completes nothing itself: a person uploads, a person verifies.',
    vendor: 'Alto People',
    model: 'Rule-based agent (lib/complianceAgent)',
    modelVersion: '1',
    environment: 'PRODUCTION',
    scopes: ['view:compliance', 'manage:compliance', 'manage:communications', 'view:org', 'open:hr-case'] as AgentScope[],
    capabilities: ['document.chase', 'i9.section2', 'incident.loop', 'coverage.credentials'],
    grants: ['document.chase', 'i9.section2', 'incident.loop', 'coverage.credentials'],
    status: 'ONBOARDING',
  },
] as const satisfies readonly {
  key: string;
  name: string;
  family: AgentFamily;
  capability: string;
  purpose: string;
  vendor: string;
  model: string;
  modelVersion: string;
  environment: 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT';
  scopes: AgentScope[];
  capabilities: readonly string[];
  /** Agent families: the catalog capabilities the built-in holds (AgentCapability rows). */
  grants?: readonly string[];
  status: WorkerStatus;
}[];

export type BuiltInAgentKey = (typeof BUILT_IN_AGENTS)[number]['key'];

/** The oldest active account that can manage the org — who owns a built-in agent until someone claims it. */
export async function defaultOrgOwner(db: Db, tenantId?: string | null): Promise<string | null> {
  const admin = await db.user.findFirst({
    where: { status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:org') }, ...(tenantId ? { tenantId } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return admin?.id ?? null;
}

/**
 * Registers the built-in agents that are missing and gives every AGENT
 * worker without a profile one, so "every agent appears in the registry"
 * holds whichever way a worker was created. Runs at boot and from the page.
 */
export async function ensureBuiltInAgents(db: Db = defaultPrisma, tenantIdArg?: string | null): Promise<{ created: string[]; missing: string[]; profiled: number }> {
  // Agent families step 0 (owner's decision 5): built-ins are per tenant, owned by that tenant's oldest admin.
  const tenantId = registryTenant(tenantIdArg);
  const existing = await db.agentProfile.findMany({ where: { builtInKey: { not: null }, tenantId }, select: { builtInKey: true } });
  const have = new Set(existing.map((e) => e.builtInKey));
  const created: string[] = [];
  const missing: string[] = [];
  for (const b of BUILT_IN_AGENTS) {
    if (have.has(b.key)) continue;
    const owner = await defaultOrgOwner(db, tenantId);
    if (!owner) {
      missing.push(b.key);
      continue;
    }
    await db.worker.create({
      data: {
        tenantId,
        type: 'AGENT',
        name: b.name,
        ownerUserId: owner,
        status: b.status,
        capabilities: [...b.capabilities],
        notes: 'Registered by the boot sweep (Brief 1D-2). Owner defaulted to the first org admin; confirm.',
        agent: {
          create: {
            tenantId,
            purpose: b.purpose,
            vendor: b.vendor,
            model: b.model,
            modelVersion: b.modelVersion,
            environment: b.environment,
            scopes: [...b.scopes],
            builtInKey: b.key,
            family: b.family,
            capability: b.capability,
            // Already running when the registry arrived: certified for this version; the next one recertifies.
            ...(b.status === 'ACTIVE' ? { certifiedAt: new Date(), certifiedModelVersion: b.modelVersion } : {}),
          },
        },
      },
    });
    created.push(b.key);
  }
  // Agent families step 1: a built-in holds its catalog capabilities, and its
  // certification scenarios come from the catalog's fixtures.
  for (const b of BUILT_IN_AGENTS) {
    const grants = 'grants' in b ? (b.grants as readonly string[]) : [];
    if (!grants.length) continue;
    const p = await db.agentProfile.findFirst({ where: { builtInKey: b.key, tenantId }, select: { workerId: true, scopes: true } });
    if (!p) continue;
    const worker = await db.worker.findUnique({ where: { id: p.workerId }, select: { status: true } });
    // A capability the built-in gains brings the scopes it needs (on the trail).
    const needed = (b.scopes as readonly string[]).filter((sc) => !p.scopes.includes(sc));
    if (needed.length) {
      await db.agentProfile.update({ where: { workerId: p.workerId }, data: { scopes: [...p.scopes, ...needed] } });
      enqueueAudit({ actorUserId: null, clientId: null, workerId: p.workerId, action: 'agent.scopes_added', entityType: 'AgentProfile', entityId: p.workerId, metadata: { added: needed, reason: 'a capability granted with the build needs them' } }, 'agents');
    }
    for (const key of grants) {
      const had = await db.agentCapability.findUnique({ where: { workerId_key: { workerId: p.workerId, key } }, select: { id: true } });
      await grantCapability(db, p.workerId, key, tenantId);
      await seedCatalogScenarios(db, p.workerId, key, tenantId);
      // Agent families step 2: a capability added to an agent already certified and
      // running arrives suspended. Its owner runs its scenario, then resumes it.
      if (!had && worker?.status === 'ACTIVE') {
        const reason = 'Added after this agent was certified: run its scenario on the Agents page, then resume it.';
        await db.agentCapability.updateMany({ where: { workerId: p.workerId, key }, data: { suspendedAt: new Date(), suspendReason: reason } });
        enqueueAudit({ actorUserId: null, clientId: null, workerId: p.workerId, action: 'agent.capability_suspended', entityType: 'AgentCapability', entityId: p.workerId, metadata: { key, reason } }, 'agents');
      }
    }
  }
  const bare = await db.worker.findMany({ where: { type: 'AGENT', agent: null, tenantId }, select: { id: true } });
  for (const w of bare) {
    await db.agentProfile.create({
      data: { workerId: w.id, tenantId, purpose: 'Registered through Workers; complete the profile.', vendor: 'unknown', model: 'unknown', modelVersion: 'unknown', scopes: [] },
    });
  }
  return { created, missing, profiled: bare.length };
}

const builtInIds = new Map<string, string>();

export async function builtInAgentId(db: Db, key: BuiltInAgentKey, tenantIdArg?: string | null): Promise<string | null> {
  const tenantId = registryTenant(tenantIdArg);
  const cacheKey = tenantId + ':' + key;
  if (process.env.NODE_ENV !== 'test') {
    const hit = builtInIds.get(cacheKey);
    if (hit) return hit;
  }
  const p = await db.agentProfile.findFirst({ where: { builtInKey: key, tenantId }, select: { workerId: true } });
  if (p && process.env.NODE_ENV !== 'test') builtInIds.set(cacheKey, p.workerId);
  return p?.workerId ?? null;
}

/**
 * Agent families step 1: an agent that runs inside the API (the Workforce
 * agent) acts under its registry record exactly as a credentialed one does.
 * Null when it may not act now: not registered in this tenant, not ACTIVE,
 * suspended on its own, or stopped by the tenant's or the platform's switch.
 */
export async function inProcessAgent(db: Db, key: BuiltInAgentKey, tenantIdArg?: string | null): Promise<AgentContext | null> {
  const tenantId = registryTenant(tenantIdArg);
  const p = await db.agentProfile.findFirst({
    where: { builtInKey: key, tenantId },
    include: { worker: { select: { name: true, status: true, ownerUserId: true } } },
  });
  if (!p || p.worker.status !== 'ACTIVE' || p.suspendedAt) return null;
  if (await allAgentsSuspended(db)) return null;
  if (await tenantAgentsSuspended(db, tenantId)) return null;
  return {
    workerId: p.workerId,
    name: p.worker.name,
    ownerUserId: p.worker.ownerUserId,
    status: p.worker.status,
    scopes: p.scopes as AgentScope[],
    credentialId: 'in-process',
    rateLimitPerMinute: p.rateLimitPerMinute,
    tenantId,
  };
}

/** An in-process agent (the WhatsApp assistant) logs what it did under its registry record. */
export async function logBuiltInAgentAction(
  db: Db,
  key: BuiltInAgentKey,
  entry: { action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> },
): Promise<void> {
  const workerId = await builtInAgentId(db, key);
  if (!workerId) return;
  enqueueAudit({ actorUserId: null, clientId: null, workerId, action: entry.action, entityType: entry.entityType, entityId: entry.entityId, metadata: { builtIn: key, ...(entry.metadata ?? {}) } }, 'agents');
  void db.agentProfile.update({ where: { workerId }, data: { lastActiveAt: new Date() } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type ProfileRow = Prisma.AgentProfileGetPayload<Record<string, never>>;

function profileSummary(p: ProfileRow): AgentSummary['profile'] {
  return {
    purpose: p.purpose,
    vendor: p.vendor,
    model: p.model,
    modelVersion: p.modelVersion,
    environment: p.environment,
    scopes: p.scopes as AgentScope[],
    spendCapCents: p.spendCapCents,
    rateLimitPerMinute: p.rateLimitPerMinute,
    allowedHoursStart: p.allowedHoursStart,
    allowedHoursEnd: p.allowedHoursEnd,
    builtInKey: p.builtInKey,
    lastActiveAt: p.lastActiveAt?.toISOString() ?? null,
    family: (p.family as AgentFamily | null) ?? null,
    capability: p.capability,
  };
}

function liveCredentialWhere(now: Date): Prisma.AgentCredentialWhereInput {
  return { expiresAt: { gt: now }, OR: [{ revokedAt: null }, { revokedAt: { gt: now } }] };
}

async function decorate(db: Db, workers: WorkerSummary[], profiles: ProfileRow[], now: Date): Promise<AgentSummary[]> {
  const ids = workers.map((w) => w.id);
  if (!ids.length) return [];
  const byId = new Map(profiles.map((p) => [p.workerId, p]));
  const [creds, pending, spend] = await Promise.all([
    db.agentCredential.groupBy({ by: ['workerId'], where: { workerId: { in: ids }, ...liveCredentialWhere(now) }, _count: { _all: true } }),
    db.agentApprovalRequest.groupBy({ by: ['workerId'], where: { workerId: { in: ids }, status: 'PENDING' }, _count: { _all: true } }),
    db.agentSpend.groupBy({ by: ['workerId'], where: { workerId: { in: ids }, occurredAt: { gte: monthStart(now) } }, _sum: { amountCents: true } }),
  ]);
  const credBy = new Map(creds.map((c) => [c.workerId, c._count._all]));
  const pendBy = new Map(pending.map((c) => [c.workerId, c._count._all]));
  const spendBy = new Map(spend.map((c) => [c.workerId, c._sum.amountCents ?? 0]));
  const out: AgentSummary[] = [];
  for (const w of workers) {
    const p = byId.get(w.id);
    if (!p) continue;
    const suspendedBy = p.suspendedById ? await db.user.findUnique({ where: { id: p.suspendedById }, select: PERSON_SELECT }) : null;
    out.push({
      ...w,
      profile: profileSummary(p),
      activeCredentials: credBy.get(w.id) ?? 0,
      pendingApprovals: pendBy.get(w.id) ?? 0,
      spendThisMonthCents: spendBy.get(w.id) ?? 0,
      certification: await certification(db, w.id),
      scorecard: await scorecard(db, w.id, 7, now),
      kill: { suspendedAt: p.suspendedAt?.toISOString() ?? null, suspendedBy: personName(suspendedBy), suspendReason: p.suspendReason },
      drift: { driftErrorRatePct: p.driftErrorRatePct, driftCostPerTaskCents: p.driftCostPerTaskCents, lastDriftAlertAt: p.lastDriftAlertAt?.toISOString() ?? null },
    });
  }
  return out;
}

export async function listAgents(db: PrismaClient = defaultPrisma, now: Date = new Date(), tenantIdArg?: string | null): Promise<AgentRegistryResponse> {
  // Agent families step 0: the registry is the caller's tenant's (the 2-6 investigation found it read every tenant).
  const tenantId = registryTenant(tenantIdArg);
  const { workers, counts } = await listWorkers(db, { type: 'AGENT', tenantId }, now);
  const profiles = await db.agentProfile.findMany({ where: { workerId: { in: workers.map((w) => w.id) }, tenantId } });
  const agents = await decorate(db, workers, profiles, now);
  const pendingApprovals = await db.agentApprovalRequest.count({ where: { status: 'PENDING', agent: { tenantId } } });
  const builtInMissing = BUILT_IN_AGENTS.filter((b) => !profiles.some((p) => p.builtInKey === b.key)).map((b) => b.key);
  return { agents, counts: counts.AGENT, pendingApprovals, builtInMissing, control: await tenantControlState(db, tenantId), platformControl: await controlState(db) };
}

/** The agent, if it is this tenant's; 404 otherwise (cross-tenant suite). */
export async function assertTenantAgent(db: Db, workerId: string, tenantIdArg?: string | null): Promise<void> {
  const tenantId = registryTenant(tenantIdArg);
  const w = await db.worker.findFirst({ where: { id: workerId, type: 'AGENT', tenantId }, select: { id: true } });
  if (!w) throw new HttpError(404, 'agent_not_found', 'No such agent.');
}

function personName(u: { id: string; email: string; associate: { firstName: string; lastName: string } | null } | null): { id: string; name: string } | null {
  if (!u) return null;
  return { id: u.id, name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email };
}

const PERSON_SELECT = { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } as const;

function credentialState(c: { expiresAt: Date; revokedAt: Date | null }, now: Date): AgentCredentialState {
  if (c.revokedAt && c.revokedAt <= now) return 'REVOKED';
  if (c.expiresAt <= now) return 'EXPIRED';
  if (c.revokedAt) return 'ROTATING';
  return 'ACTIVE';
}

function credentialSummary(c: Prisma.AgentCredentialGetPayload<{ include: { issuedBy: { select: typeof PERSON_SELECT } } }>, now: Date): AgentCredentialSummary {
  return {
    id: c.id,
    last4: c.last4,
    state: credentialState(c, now),
    issuedAt: c.issuedAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    revokedAt: c.revokedAt?.toISOString() ?? null,
    revokedReason: c.revokedReason,
    issuedBy: personName(c.issuedBy),
    rotatedFromId: c.rotatedFromId,
  };
}

type ApprovalRow = Prisma.AgentApprovalRequestGetPayload<{ include: { decidedBy: { select: typeof PERSON_SELECT }; agent: { include: { worker: { select: { name: true } } } } } }>;
const APPROVAL_INCLUDE = { decidedBy: { select: PERSON_SELECT }, agent: { include: { worker: { select: { name: true } } } } } as const;

function approvalSummary(a: ApprovalRow): AgentApprovalSummary {
  return {
    id: a.id,
    workerId: a.workerId,
    agentName: a.agent.worker.name,
    action: a.action,
    summary: a.summary,
    payload: (a.payload as Record<string, unknown>) ?? {},
    status: a.status,
    requestedAt: a.requestedAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    decidedBy: personName(a.decidedBy),
    decidedAt: a.decidedAt?.toISOString() ?? null,
    decisionNote: a.decisionNote,
    consumedAt: a.consumedAt?.toISOString() ?? null,
  };
}

export async function agentTrail(db: Db, workerId: string, limit = 100): Promise<AgentTrailEntry[]> {
  const rows = await db.auditLog.findMany({ where: { workerId }, orderBy: { createdAt: 'desc' }, take: limit });
  return rows.map((r) => ({ id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId, metadata: (r.metadata as Record<string, unknown> | null) ?? null, createdAt: r.createdAt.toISOString() }));
}

export async function getAgent(db: Db, workerId: string, now: Date = new Date()): Promise<AgentDetail> {
  const worker = await getWorker(db, workerId, now);
  if (worker.type !== 'AGENT') throw new HttpError(404, 'agent_not_found', 'No such agent.');
  const profile = await db.agentProfile.findUnique({ where: { workerId } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'This worker has no agent profile yet; the sweep adds one.');
  const [summary] = await decorate(db, [worker], [profile], now);
  const [credentials, approvals, spend, trail] = await Promise.all([
    db.agentCredential.findMany({ where: { workerId }, orderBy: { issuedAt: 'desc' }, take: 50, include: { issuedBy: { select: PERSON_SELECT } } }),
    db.agentApprovalRequest.findMany({ where: { workerId }, orderBy: { requestedAt: 'desc' }, take: 50, include: APPROVAL_INCLUDE }),
    db.agentSpend.findMany({ where: { workerId }, orderBy: { occurredAt: 'desc' }, take: 50 }),
    agentTrail(db, workerId, 100),
  ]);
  return {
    ...summary!,
    credentials: credentials.map((c) => credentialSummary(c, now)),
    approvals: approvals.map(approvalSummary),
    spend: spend.map((s) => ({ id: s.id, occurredAt: s.occurredAt.toISOString(), amountCents: s.amountCents, taskRef: s.taskRef, note: s.note })),
    trail,
  };
}

export async function createAgent(db: Db, input: AgentInput, actorUserId: string, now: Date = new Date(), catalogCapabilities: readonly string[] = []): Promise<AgentDetail> {
  // Brief 2-6 step 1: each catalog capability must be offered here (its modules on), be of the
  // agent's family, and be covered by the scopes it is granted; checked before anything is written.
  const tenantId = registryTenant();
  for (const key of catalogCapabilities) {
    const def = capabilityDef(key);
    if (!def) throw new HttpError(400, 'capability_unknown', `No capability ${key} in the catalog.`);
    if (input.family && def.family !== input.family) throw new HttpError(400, 'capability_wrong_family', `${def.label} belongs to the ${def.family} family.`);
    for (const m of def.requiresModule) if (!(await moduleOn(m, tenantId))) throw new HttpError(400, 'capability_not_offered', `${def.label} is not offered here.`);
    const missing = def.scopes.find((sc) => !input.scopes.includes(sc));
    if (missing) throw new HttpError(400, 'capability_scope_missing', `${def.label} needs the scope ${missing}.`);
  }
  const worker = await createWorker(db, { type: 'AGENT', name: input.name, ownerUserId: input.ownerUserId, status: input.status, capabilities: input.capabilities, notes: input.notes ?? null, locationId: null }, actorUserId, now);
  await db.agentProfile.create({
    data: {
      workerId: worker.id,
      purpose: input.purpose,
      vendor: input.vendor,
      model: input.model,
      modelVersion: input.modelVersion,
      environment: input.environment,
      scopes: input.scopes,
      spendCapCents: input.spendCapCents,
      rateLimitPerMinute: input.rateLimitPerMinute,
      allowedHoursStart: input.allowedHoursStart,
      allowedHoursEnd: input.allowedHoursEnd,
      family: input.family ?? null,
      capability: input.capability ?? null,
      // Registered as already active = the registering admin attests it runs today;
      // it is certified for this version and recertifies on the next (Brief 1D-3).
      ...(input.status === 'ACTIVE' ? { certifiedAt: now, certifiedModelVersion: input.modelVersion } : {}),
    },
  });
  for (const key of catalogCapabilities) await db.agentCapability.create({ data: { workerId: worker.id, key, tenantId } });
  return getAgent(db, worker.id, now);
}

export async function updateAgent(db: Db, workerId: string, input: AgentUpdate, now: Date = new Date(), actorUserId: string | null = null): Promise<AgentDetail> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, select: { workerId: true, modelVersion: true, certifiedModelVersion: true, worker: { select: { status: true } } } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'No such agent.');
  const { name, ownerUserId, status, capabilities, notes, ...rest } = input;
  const versionAfter = rest.modelVersion ?? profile.modelVersion;
  // Brief 1D-3: nothing leaves onboarding (or comes back from suspension) uncertified for the version it runs.
  if (status === 'ACTIVE' && profile.worker.status !== 'ACTIVE' && profile.certifiedModelVersion !== versionAfter) {
    throw new HttpError(409, 'agent_not_certified', `This agent must pass its scenarios under model version ${versionAfter} before it is active.`);
  }
  if (name !== undefined || ownerUserId !== undefined || status !== undefined || capabilities !== undefined || notes !== undefined) {
    await updateWorker(db, workerId, { name, ownerUserId, status, capabilities, notes }, now);
  }
  if (Object.keys(rest).length) await db.agentProfile.update({ where: { workerId }, data: rest });
  if (rest.modelVersion !== undefined && rest.modelVersion !== profile.modelVersion) await onModelVersionChanged(db, workerId, profile.modelVersion, rest.modelVersion, actorUserId, now);
  // A suspended or offboarded agent holds no working credential.
  if (status === 'SUSPENDED' || status === 'OFFBOARDED') await revokeAllCredentials(db, workerId, status.toLowerCase(), now);
  return getAgent(db, workerId, now);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export async function issueCredential(db: Db, workerId: string, ttlHours: number, issuedById: string | null, now: Date = new Date(), rotatedFromId: string | null = null): Promise<AgentIssuedCredential> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, select: { workerId: true } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'No such agent.');
  const t = mintToken();
  const row = await db.agentCredential.create({
    data: { workerId, tokenHash: t.hash, last4: t.last4, issuedById, rotatedFromId, issuedAt: now, expiresAt: new Date(now.getTime() + ttlHours * 3_600_000) },
    select: { id: true, expiresAt: true },
  });
  return { id: row.id, plaintext: t.plaintext, last4: t.last4, expiresAt: row.expiresAt.toISOString() };
}

export async function revokeCredential(db: Db, workerId: string, credentialId: string, reason: string | null, now: Date = new Date()): Promise<void> {
  const c = await db.agentCredential.findFirst({ where: { id: credentialId, workerId }, select: { revokedAt: true } });
  if (!c) throw new HttpError(404, 'credential_not_found', 'No such credential.');
  if (c.revokedAt && c.revokedAt <= now) throw new HttpError(409, 'credential_already_revoked', 'Already revoked.');
  await db.agentCredential.update({ where: { id: credentialId }, data: { revokedAt: now, revokedReason: reason ?? 'revoked' } });
}

/** Every working credential, revoked now. Returns how many. */
export async function revokeAllCredentials(db: Db, workerId: string, reason: string, now: Date = new Date()): Promise<number> {
  const r = await db.agentCredential.updateMany({ where: { workerId, ...liveCredentialWhere(now) }, data: { revokedAt: now, revokedReason: reason } });
  return r.count;
}

/** The agent trades its credential for a fresh one; the old one keeps working for the grace period. */
export async function rotateCredential(db: Db, agent: AgentContext, now: Date = new Date()): Promise<AgentIssuedCredential> {
  const current = await db.agentCredential.findUniqueOrThrow({ where: { id: agent.credentialId }, select: { issuedAt: true, expiresAt: true, revokedAt: true } });
  if (current.revokedAt) throw new HttpError(409, 'credential_rotating', 'This credential was already rotated; use the new one.');
  const ttlHours = Math.max(1, Math.round((current.expiresAt.getTime() - current.issuedAt.getTime()) / 3_600_000));
  const next = await issueCredential(db, agent.workerId, ttlHours, null, now, agent.credentialId);
  await db.agentCredential.update({ where: { id: agent.credentialId }, data: { revokedAt: new Date(now.getTime() + ROTATION_GRACE_MS), revokedReason: 'rotated' } });
  return next;
}

// ---------------------------------------------------------------------------
// Authentication and limits
// ---------------------------------------------------------------------------

const rateWindows = new Map<string, { startedAt: number; count: number }>();

/** Fixed one-minute window per agent, in process. Returns false when the minute is spent. */
export function takeRateToken(workerId: string, limit: number, now: Date = new Date()): boolean {
  const t = now.getTime();
  const w = rateWindows.get(workerId);
  if (!w || t - w.startedAt >= 60_000) {
    rateWindows.set(workerId, { startedAt: t, count: 1 });
    return true;
  }
  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}

export function resetAgentRateLimits(): void {
  rateWindows.clear();
}

function denial(status: 401 | 403 | 429, code: string, message: string, workerId: string | null = null, credentialId: string | null = null): AgentDenial {
  return { ok: false, status, code, message, workerId, credentialId };
}

/**
 * Who is calling, and may they? Unknown, expired and revoked tokens are
 * refused; so is any agent that is not ACTIVE, is outside its hours or
 * has spent its month. The rate limit is the caller's to take after.
 */
export async function authenticateAgent(db: Db, presented: string, now: Date = new Date(), opts: { allowOnboarding?: boolean } = {}): Promise<AgentAuthResult> {
  if (!presented.startsWith(AGENT_TOKEN_PREFIX) || !/^[0-9a-f]{64}$/.test(presented.slice(AGENT_TOKEN_PREFIX.length))) {
    return denial(401, 'unauthenticated', 'Invalid or missing agent credential.');
  }
  const c = await db.agentCredential.findUnique({
    where: { tokenHash: hashToken(presented) },
    include: { agent: { include: { worker: { select: { name: true, status: true, ownerUserId: true } } } } },
  });
  if (!c) return denial(401, 'unauthenticated', 'Invalid or missing agent credential.');
  const workerId = c.workerId;
  if (c.revokedAt && c.revokedAt <= now) return denial(401, 'credential_revoked', 'This credential was revoked.', workerId, c.id);
  if (c.expiresAt <= now) return denial(401, 'credential_expired', 'This credential expired; ask the owner for a new one.', workerId, c.id);
  // Brief 1D-3: the global switch is read on every call, so it bites at once.
  if (await allAgentsSuspended(db)) return denial(403, 'agents_suspended', 'All agents are suspended.', workerId, c.id);
  // Agent families step 0: the agent's organization has its own switch; either one stops it.
  if (await tenantAgentsSuspended(db, c.agent.tenantId ?? ALTO_TENANT_ID)) {
    return denial(403, 'agents_suspended', 'All of this organization’s agents are suspended.', workerId, c.id);
  }
  const w = c.agent.worker;
  const allowed = w.status === 'ACTIVE' || (opts.allowOnboarding === true && w.status === 'ONBOARDING');
  if (!allowed) return denial(403, 'agent_not_active', `This agent is ${w.status.toLowerCase()}; its owner can restore it.`, workerId, c.id);
  if (!withinAllowedHours(c.agent.allowedHoursStart, c.agent.allowedHoursEnd, now)) {
    return denial(403, 'agent_outside_hours', `This agent may only run between ${c.agent.allowedHoursStart}:00 and ${c.agent.allowedHoursEnd}:00 org time.`, workerId, c.id);
  }
  if (c.agent.spendCapCents != null) {
    const spent = await monthSpendCents(db, workerId, now);
    if (spent >= c.agent.spendCapCents) return denial(429, 'agent_spend_cap', 'This agent has reached its monthly spend cap.', workerId, c.id);
  }
  void Promise.all([
    db.agentCredential.update({ where: { id: c.id }, data: { lastUsedAt: now } }),
    db.agentProfile.update({ where: { workerId }, data: { lastActiveAt: now } }),
  ]).catch(() => {});
  return {
    ok: true,
    agent: { workerId, name: w.name, ownerUserId: w.ownerUserId, status: w.status, scopes: c.agent.scopes as AgentScope[], credentialId: c.id, rateLimitPerMinute: c.agent.rateLimitPerMinute, tenantId: c.agent.tenantId ?? null },
  };
}

export function logAgentAction(
  agent: AgentContext,
  entry: { action: string; entityType: string; entityId: string; scopes?: readonly string[]; approvalId?: string | null; metadata?: Record<string, unknown> },
): void {
  enqueueAudit(
    {
      actorUserId: null,
      clientId: null,
      workerId: agent.workerId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: { credentialId: agent.credentialId, scopes: entry.scopes ?? [], approvalId: entry.approvalId ?? null, ...(entry.metadata ?? {}) },
    },
    'agents',
  );
}

// ---------------------------------------------------------------------------
// Approval gates
// ---------------------------------------------------------------------------

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function payloadHash(action: AgentGatedAction, payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ action, payload: canonical(payload) })).digest('hex');
}

/**
 * The agent asks. An identical open request is returned rather than
 * duplicated, so a retrying agent does not fill the queue. The owner is
 * told; the decision comes back through decideApproval.
 */
export async function createApprovalRequest(
  db: Db,
  agent: AgentContext,
  input: { action: AgentGatedAction; summary: string; payload: Record<string, unknown> },
  now: Date = new Date(),
): Promise<{ approval: AgentApprovalSummary; created: boolean }> {
  const hash = payloadHash(input.action, input.payload);
  const open = await db.agentApprovalRequest.findFirst({ where: { workerId: agent.workerId, payloadHash: hash, status: { in: ['PENDING', 'APPROVED'] }, expiresAt: { gt: now } }, include: APPROVAL_INCLUDE });
  if (open) return { approval: approvalSummary(open), created: false };
  // Brief 2-6 step 2: the customer's gate policy in force names who decides and how long the request lives.
  const profile = await db.agentProfile.findUnique({ where: { workerId: agent.workerId }, select: { family: true } });
  const capabilityKey = typeof input.payload.capability === 'string' ? input.payload.capability : null;
  const gate = await gateFor(db, { workerId: agent.workerId, tenantId: agent.tenantId, family: profile?.family ?? null }, input.action, capabilityKey, now);
  const row = await db.agentApprovalRequest.create({
    data: {
      workerId: agent.workerId,
      action: input.action,
      summary: input.summary,
      payload: input.payload as Prisma.InputJsonObject,
      payloadHash: hash,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + (gate.policyId ? gate.ttlHours * 3_600_000 : APPROVAL_TTL_MS)),
      ...(gate.policyId ? { gatePolicyId: gate.policyId, approverKind: gate.approver, approverRole: gate.approverRole, approverUserId: gate.approverUserId } : {}),
    },
    include: APPROVAL_INCLUDE,
  });
  logAgentAction(agent, { action: 'agent.approval.requested', entityType: 'AgentApprovalRequest', entityId: row.id, metadata: { gated: input.action, summary: input.summary } });
  emitAgentApproval('agent.approval_requested', { id: row.id, action: row.action, status: row.status, summary: row.summary, workerId: row.workerId }, agent.tenantId ?? null);
  // The decided approver gets the notice: a named person, everyone in a role here, else the owner (today's rule).
  const recipients =
    gate.policyId && gate.approver === 'USER' && gate.approverUserId
      ? [gate.approverUserId]
      : gate.policyId && gate.approver === 'ROLE' && gate.approverRole
        ? (await db.user.findMany({ where: { role: gate.approverRole, status: 'ACTIVE', deletedAt: null, tenantId: agent.tenantId ?? ALTO_TENANT_ID }, select: { id: true }, take: 25 })).map((u) => u.id)
        : [agent.ownerUserId];
  for (const to of recipients) {
    await notifyUser(to, {
      subject: `${agent.name} is asking for approval`,
      body: `${AGENT_GATED_ACTION_LABELS[input.action]}: ${input.summary}`,
      category: AGENT_APPROVAL_CATEGORY,
      linkUrl: `/agents?approval=${row.id}`,
    });
  }
  return { approval: approvalSummary(row), created: true };
}

export async function listApprovals(db: Db, f: { status?: AgentApprovalSummary['status']; workerId?: string; tenantId?: string | null } = {}, limit = 200): Promise<AgentApprovalSummary[]> {
  const rows = await db.agentApprovalRequest.findMany({
    where: { agent: { tenantId: registryTenant(f.tenantId) }, ...(f.status ? { status: f.status } : {}), ...(f.workerId ? { workerId: f.workerId } : {}) },
    orderBy: { requestedAt: 'desc' },
    take: limit,
    include: APPROVAL_INCLUDE,
  });
  return rows.map(approvalSummary);
}

export async function getApproval(db: Db, id: string, tenantIdArg?: string | null): Promise<AgentApprovalSummary> {
  const row = await db.agentApprovalRequest.findFirst({ where: { id, agent: { tenantId: registryTenant(tenantIdArg) } }, include: APPROVAL_INCLUDE });
  if (!row) throw new HttpError(404, 'approval_not_found', 'No such request.');
  return approvalSummary(row);
}

/** A person decides. Logged with who, what and the note. */
export async function decideApproval(db: Db, id: string, decision: 'APPROVED' | 'REJECTED', userId: string, note: string | null, now: Date = new Date(), tenantIdArg?: string | null): Promise<AgentApprovalSummary> {
  const row = await db.agentApprovalRequest.findFirst({ where: { id, agent: { tenantId: registryTenant(tenantIdArg) } }, select: { status: true, expiresAt: true, workerId: true, action: true, approverKind: true, approverRole: true, approverUserId: true } });
  if (!row) throw new HttpError(404, 'approval_not_found', 'No such request.');
  // Brief 2-6 step 2: a request filed under a customer's gate is decided by the approver it names.
  if (row.approverKind) {
    const decider = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!decider || !(await approverMayDecide(db, row, decider))) throw new HttpError(403, 'not_the_approver', 'Your organization’s policy names someone else to decide this request.');
  }
  if (row.status !== 'PENDING') throw new HttpError(409, 'approval_decided', `This request is already ${row.status.toLowerCase()}.`);
  if (row.expiresAt <= now) throw new HttpError(409, 'approval_expired', 'This request expired before it was decided.');
  const updated = await db.agentApprovalRequest.update({ where: { id }, data: { status: decision, decidedById: userId, decidedAt: now, decisionNote: note }, include: APPROVAL_INCLUDE });
  enqueueAudit(
    { actorUserId: userId, clientId: null, workerId: row.workerId, action: decision === 'APPROVED' ? 'agent.approval.approved' : 'agent.approval.rejected', entityType: 'AgentApprovalRequest', entityId: id, metadata: { gated: row.action, note } },
    'agents',
  );
  await syncProposalWithApproval(db, id, decision, now);
  // Brief 2-6 step 3: a decision about people goes on the automated-decision record.
  await recordDecisionsForApproval(db, id, decision, userId, now);
  emitAgentApproval('agent.approval_decided', { id, action: row.action, status: decision, summary: updated.summary, workerId: row.workerId }, registryTenant(tenantIdArg));
  // Agent families step 1: an approved proposal of an in-process agent is carried out now.
  if (decision === 'APPROVED') await afterProposalApproved(id, now);
  return approvalSummary(updated);
}

/** The approval's action, for deciding who may decide it (the desk for SHIFT_ASSIGN and CASE_OPEN). */
export async function approvalAction(db: Db, id: string, tenantIdArg?: string | null): Promise<AgentGatedAction | null> {
  const row = await db.agentApprovalRequest.findFirst({ where: { id, agent: { tenantId: registryTenant(tenantIdArg) } }, select: { action: true } });
  return row?.action ?? null;
}

/**
 * The agent carries out an approved action exactly once. The payload it
 * presents must be the one that was approved, byte for byte.
 */
export async function claimApproval(db: Db, agent: AgentContext, approvalId: string, action: AgentGatedAction, payload: Record<string, unknown>, now: Date = new Date()): Promise<AgentApprovalSummary> {
  const row = await db.agentApprovalRequest.findUnique({ where: { id: approvalId }, include: APPROVAL_INCLUDE });
  if (!row || row.workerId !== agent.workerId) throw new HttpError(404, 'approval_not_found', 'No such request for this agent.');
  if (!AGENT_EXECUTABLE_ACTIONS.includes(row.action)) throw new HttpError(409, 'human_only', `${AGENT_GATED_ACTION_LABELS[row.action]} is carried out by the approver, not the agent.`);
  if (row.status === 'PENDING') throw new HttpError(409, 'approval_pending', 'Not approved yet.');
  if (row.status === 'REJECTED') throw new HttpError(409, 'approval_rejected', 'This request was rejected.');
  if (row.status === 'CONSUMED') throw new HttpError(409, 'approval_consumed', 'This approval was already used.');
  if (row.status === 'EXPIRED' || row.expiresAt <= now) throw new HttpError(409, 'approval_expired', 'This approval expired.');
  if (row.action !== action || row.payloadHash !== payloadHash(action, payload)) throw new HttpError(409, 'approval_mismatch', 'This is not what was approved.');
  const updated = await db.agentApprovalRequest.update({ where: { id: approvalId }, data: { status: 'CONSUMED', consumedAt: now }, include: APPROVAL_INCLUDE });
  await syncProposalWithApproval(db, approvalId, 'EXECUTED', now);
  return approvalSummary(updated);
}

export async function expireApprovals(db: Db = defaultPrisma, now: Date = new Date()): Promise<number> {
  const due = await db.agentApprovalRequest.findMany({ where: { status: 'PENDING', expiresAt: { lte: now } }, select: { id: true } });
  if (!due.length) return 0;
  const ids = due.map((d) => d.id);
  const r = await db.agentApprovalRequest.updateMany({ where: { id: { in: ids }, status: 'PENDING' }, data: { status: 'EXPIRED' } });
  // The proposals waiting on them expire with them.
  await db.agentProposal.updateMany({ where: { approvalId: { in: ids }, status: 'PROPOSED' }, data: { status: 'EXPIRED', statusAt: now } });
  return r.count;
}

// ---------------------------------------------------------------------------
// What an agent can do once allowed
// ---------------------------------------------------------------------------

export async function recordSpend(db: Db, workerId: string, input: { amountCents: number; taskRef?: string; note?: string; occurredAt?: string }, recordedById: string | null): Promise<{ id: string; spendThisMonthCents: number }> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, select: { workerId: true } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'No such agent.');
  const row = await db.agentSpend.create({
    data: { workerId, amountCents: input.amountCents, taskRef: input.taskRef ?? null, note: input.note ?? null, recordedById, ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}) },
    select: { id: true, occurredAt: true },
  });
  return { id: row.id, spendThisMonthCents: await monthSpendCents(db, workerId, new Date()) };
}

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/**
 * A message from an agent. A thread that reaches a client (a store
 * channel, or any thread with a portal account in it) is a gated action:
 * without an approval the request is filed and nothing is sent; with one,
 * the approved text goes out once, signed as the agent.
 */
export async function postAgentMessage(
  db: Db,
  agent: AgentContext,
  input: { conversationId: string; body: string; approvalId?: string },
  now: Date = new Date(),
): Promise<{ gated: true; approval: AgentApprovalSummary; created: boolean } | { gated: false; messageId: string; approvalId: string | null }> {
  const conv = await db.conversation.findUnique({
    where: { id: input.conversationId },
    include: { participants: { include: { user: { select: { id: true, role: true } } } } },
  });
  if (!conv) throw new HttpError(404, 'conversation_not_found', 'No such conversation.');
  const reachesClient = conv.clientId != null || conv.participants.some((p) => p.user.role === 'CLIENT_PORTAL');
  const payload = { conversationId: input.conversationId, body: input.body };
  let approvalId: string | null = null;
  if (reachesClient) {
    if (!input.approvalId) {
      const r = await createApprovalRequest(db, agent, { action: 'CLIENT_MESSAGE', summary: `Message to ${conv.title ?? 'a client thread'}: "${clip(input.body, 160)}"`, payload }, now);
      return { gated: true, approval: r.approval, created: r.created };
    }
    approvalId = (await claimApproval(db, agent, input.approvalId, 'CLIENT_MESSAGE', payload, now)).id;
  }
  const body = `${input.body}\n\n— ${agent.name} (AI agent)`;
  const preview = clip(input.body, 160);
  const m = await db.message.create({ data: { conversationId: conv.id, senderId: null, body }, select: { id: true, createdAt: true } });
  await db.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: m.createdAt, lastPreview: clip(`${agent.name}: ${preview}`, 160) } });
  const synced = conv.kind === 'STORE_CHANNEL' ? await syncStoreChannel(conv.id, db as PrismaClient) : null;
  const recipientIds = synced ?? conv.participants.map((p) => p.userId);
  await fanOutMessage({ conversationId: conv.id, title: conv.title ?? agent.name, senderName: agent.name, preview, recipientIds }, db as PrismaClient);
  logAgentAction(agent, { action: 'agent.message.sent', entityType: 'Message', entityId: m.id, scopes: ['manage:communications'], approvalId, metadata: { conversationId: conv.id, reachesClient, recipients: recipientIds.length } });
  return { gated: false, messageId: m.id, approvalId };
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The one export an agent can ask for: a client's schedule as CSV, names included — which is why it is gated. */
export async function scheduleCsv(db: Db, clientId: string, from: Date, to: Date): Promise<{ csv: string; rows: number }> {
  const shifts = await db.shift.findMany({
    where: { clientId, startsAt: { gte: from, lt: to }, status: { not: 'CANCELLED' } },
    orderBy: { startsAt: 'asc' },
    take: 5000,
    select: { id: true, position: true, location: true, startsAt: true, endsAt: true, status: true, assignedAssociate: { select: { firstName: true, lastName: true } }, worker: { select: { name: true, type: true } } },
  });
  const lines = ['shiftId,position,location,startsAt,endsAt,status,assignee,workerType'];
  for (const s of shifts) {
    const assignee = s.assignedAssociate ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}` : (s.worker?.name ?? '');
    lines.push([s.id, s.position, s.location, s.startsAt.toISOString(), s.endsAt.toISOString(), s.status, assignee, s.worker?.type ?? (s.assignedAssociate ? 'PERSON' : '')].map(csvCell).join(','));
  }
  return { csv: `${lines.join('\n')}\n`, rows: shifts.length };
}
