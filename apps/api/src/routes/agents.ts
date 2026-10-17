import { Router, type NextFunction, type Request, type Response } from 'express';
// Agent families step 1: the in-process Workforce agent's executor, fixture runner and metrics.
import '../lib/workforceAgent.js';
import { z } from 'zod';
import {
  AgentApprovalStatusSchema,
  AgentCapabilityKeySchema,
  AgentGatedActionSchema,
  AgentCredentialIssueSchema,
  AgentDecideInputSchema,
  AgentDecisionSchema,
  AgentDriftSchema,
  AgentInputSchema,
  AgentProposalStatusSchema,
  AgentRevokeSchema,
  AgentScenarioInputSchema,
  AgentSpendInputSchema,
  AgentSuspendSchema,
  AgentUpdateSchema,
  hasCapability,
  PLATFORM_OPERATOR_TENANT_ID,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { GatePolicyInputSchema, createGatePolicy, endGatePolicy, gateFor } from '../lib/agentGates.js';
import { BiasAuditInputSchema, DECISION_EVENTS, DecisionProfileInputSchema, addBiasAudit, decisionProfileFor, markDecisionEvent, saveDecisionProfile } from '../lib/decisionRecord.js';
import { loadTenantProfile } from '../lib/tenantProfile.js';
import { mcpCatalogFor } from '../lib/mcpCatalog.js';
import { assertTenantAgent, createAgent, decideApproval, ensureBuiltInAgents, getAgent, getApproval, issueCredential, listAgents, listApprovals, recordSpend, revokeCredential, updateAgent } from '../lib/agents.js';
import { addScenario, certifyAgent, controlState, listScenarios, removeScenario, resumeAgent, resumeAllAgents, runScenarios, scorecard, suspendAgent, suspendAllAgents } from '../lib/agentControls.js';
import { capabilityScorecard, listAgentCapabilities, listProposals, resumeCapability, resumeTenantAgents, suspendCapability, suspendTenantAgents, tenantControlState } from '../lib/agentCapabilities.js';
import { decidableIdsAmong, mayDecideApproval } from '../lib/proposalDecisions.js';

/**
 * The agent registry, for people (Brief 1D-2).
 *
 *   GET   /agents                               every agent, counts, the approval queue size   (view:org)
 *   POST  /agents                               register one — owner required                  (manage:org)
 *   POST  /agents/ensure-built-in               register the agents Alto already runs
 *   GET   /agents/approvals?status=             the queue
 *   GET   /agents/approvals/:id
 *   POST  /agents/approvals/:id/approve|reject  the decision, logged
 *   POST  /agents/approvals/:id/decide          { decision: APPROVE | REJECT, reason? } — one decision; a rejection says why
 *   GET   /agents/gates · POST /agents/gates · POST /agents/gates/:gid/end   Brief 2-6: the organization's own gates over the floor
 *   GET   /agents/gates/preview?workerId&action|capability                   what would happen
 *   GET   /agents/:id                           profile, credentials, requests, spend, the trail
 *   PATCH /agents/:id
 *   POST  /agents/:id/credentials               issue a short-lived credential (plaintext shown once)
 *   POST  /agents/:id/credentials/:cid/revoke
 *   POST  /agents/:id/spend                     record spend from an invoice
 *
 * Brief 1D-3:
 *   GET   /agents/control · POST /agents/suspend-all · POST /agents/resume-all
 *   POST  /agents/:id/suspend · POST /agents/:id/resume (owner only)
 *   GET   /agents/:id/scenarios · POST · DELETE /:sid · POST /agents/:id/scenarios/run (built-ins)
 *   POST  /agents/:id/certify                   every scenario passing → certified, onboarding → active
 *   GET   /agents/:id/scorecard?days=
 *   PATCH /agents/:id/drift                     thresholds
 *
 * Agent families step 0 (docs/agent-families-investigation.md §8):
 *   The registry is the caller's tenant's: lists filter by tenant and every
 *   /agents/:id route answers 404 for another tenant's agent.
 *   GET   /agents/control · POST suspend-all · POST resume-all     now this ORGANIZATION's switch
 *   GET   /agents/platform/control · POST …/suspend-all · …/resume-all   the platform switch (operator tenant only)
 *   GET   /agents/proposals?capability=&status=&workerId=
 *   GET   /agents/:id/capabilities
 *   POST  /agents/:id/capabilities/:key/suspend · /resume (owner only)
 *   GET   /agents/:id/capabilities/:key/scorecard?days=
 *   A SHIFT_ASSIGN request may also be decided by the scheduling desk
 *   (manage:scheduling) and a CASE_OPEN request by HR (manage:onboarding).
 */
export const agentsRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');
const Id = z.string().uuid();

/** Every /agents/:id route resolves the agent within the caller's tenant first. */
async function ownAgent(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    await assertTenantAgent(prisma, Id.parse(req.params.id), tenantIdForWrite());
    next();
  } catch (err) {
    next(err);
  }
}

/** The platform switch is the operator tenant's alone; elsewhere it does not exist. */
function operatorOnly(_req: Request, _res: Response, next: NextFunction): void {
  if (tenantIdForWrite() !== PLATFORM_OPERATOR_TENANT_ID) {
    next(new HttpError(404, 'not_found', 'Not found.'));
    return;
  }
  next();
}

/**
 * Who may decide a gated request — lib/proposalDecisions, the one rule every
 * surface reads: an org admin always (a request a customer's gate names an
 * approver for is re-checked by decideApproval, which names the approver in
 * its answer); the named approver; the desk that owns the subject (a bound
 * supervisor for its own shifts); the agent's owner under today's rule.
 */
async function canDecide(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user!;
    if (hasCapability(user.role, 'manage:org')) {
      next();
      return;
    }
    const parsed = Id.safeParse(req.params.id);
    const u = user as { id: string; role: typeof user.role; clientId?: string | null; locationId?: string | null };
    if (parsed.success && (await mayDecideApproval(prisma, tenantIdForWrite(), parsed.data, { id: u.id, role: u.role, clientId: u.clientId ?? null, locationId: u.locationId ?? null }))) {
      next();
      return;
    }
    // Not this desk's to decide, or not found: the same answer the capability gate gives.
    next(new HttpError(403, 'forbidden', 'You cannot decide this request.'));
  } catch (err) {
    next(err);
  }
}

/** The caller's own view of a list: which of these pending requests the server's rule lets them decide. */
async function markDecidable<T extends { id: string; status: string }>(req: Request, rows: T[]): Promise<Array<T & { mayDecide: boolean }>> {
  const u = req.user as { id: string; role: Parameters<typeof hasCapability>[0]; clientId?: string | null; locationId?: string | null };
  const pendingIds = rows.filter((r) => r.status === 'PENDING').map((r) => r.id);
  const ok = await decidableIdsAmong(prisma, tenantIdForWrite(), { id: u.id, role: u.role, clientId: u.clientId ?? null, locationId: u.locationId ?? null }, pendingIds);
  return rows.map((r) => ({ ...r, mayDecide: ok.has(r.id) }));
}

agentsRouter.get('/', VIEW, async (_req, res, next) => {
  try {
    res.json(await listAgents(prisma, new Date(), tenantIdForWrite()));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/ensure-built-in', MANAGE, async (req, res, next) => {
  try {
    const r = await ensureBuiltInAgents(prisma, tenantIdForWrite());
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'agent.built_in_ensured', entityType: 'AgentProfile', entityId: 'sweep', metadata: r }, 'agents');
    res.json(r);
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/approvals', VIEW, async (req, res, next) => {
  try {
    const q = z.object({ status: AgentApprovalStatusSchema.optional(), workerId: Id.optional() }).parse(req.query);
    res.json({ approvals: await markDecidable(req, await listApprovals(prisma, { ...q, tenantId: tenantIdForWrite() })) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/approvals/:id', VIEW, async (req, res, next) => {
  try {
    res.json(await getApproval(prisma, Id.parse(req.params.id), tenantIdForWrite()));
  } catch (err) {
    next(err);
  }
});

for (const decision of ['approve', 'reject'] as const) {
  agentsRouter.post(`/approvals/:id/${decision}`, requireAuth, canDecide, async (req, res, next) => {
    try {
      const { note } = AgentDecisionSchema.parse(req.body ?? {});
      res.json(await decideApproval(prisma, Id.parse(req.params.id), decision === 'approve' ? 'APPROVED' : 'REJECTED', req.user!.id, note ?? null, new Date(), tenantIdForWrite()));
    } catch (err) {
      next(err);
    }
  });
}

/**
 * One decision on a proposal: APPROVE, or REJECT with the reason (required;
 * kept as the decision note, on the proposal's outcome and on the trail).
 * The same people as approve/reject: the rule in canDecide.
 */
agentsRouter.post('/approvals/:id/decide', requireAuth, canDecide, async (req, res, next) => {
  try {
    const { decision, reason } = AgentDecideInputSchema.parse(req.body ?? {});
    const decided = await decideApproval(prisma, Id.parse(req.params.id), decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', req.user!.id, reason ?? null, new Date(), tenantIdForWrite());
    res.json({ ...decided, mayDecide: false });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/proposals', VIEW, async (req, res, next) => {
  try {
    const q = z.object({ capability: AgentCapabilityKeySchema.optional(), status: AgentProposalStatusSchema.optional(), workerId: Id.optional() }).parse(req.query);
    res.json({ proposals: await listProposals(prisma, tenantIdForWrite(), q) });
  } catch (err) {
    next(err);
  }
});

// ---- The decision record across agents (Settings & trust › Agents & gates) ----
// Every automated decision about a person this organization's agents recorded,
// newest first, with the agent named. The per-agent view stays /:id/decision-record.
// Before /:id so the literal wins.
agentsRouter.get('/decision-records', VIEW, async (_req, res, next) => {
  try {
    const tenantId = tenantIdForWrite();
    const rows = await prisma.automatedDecisionRecord.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 500 });
    const [people, agents] = await Promise.all([
      prisma.associate.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.subjectAssociateId).filter((x): x is string => !!x))] } },
        select: { id: true, firstName: true, lastName: true },
      }),
      prisma.worker.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.workerId))] } }, select: { id: true, name: true } }),
    ]);
    const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    res.json({
      total: await prisma.automatedDecisionRecord.count({ where: { tenantId } }),
      decisions: rows.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        agentId: r.workerId,
        agentName: agentName.get(r.workerId) ?? 'An agent',
        capabilityKey: r.capabilityKey,
        decisionType: r.decisionType,
        subject: r.subjectAssociateId ? (nameOf.get(r.subjectAssociateId) ?? 'A person') : r.subjectRef,
        subjectAssociateId: r.subjectAssociateId,
        outcome: r.outcome,
        summary: r.summary,
        humanDecidedAt: r.humanDecidedAt?.toISOString() ?? null,
        noticeGivenAt: r.noticeGivenAt?.toISOString() ?? null,
        explanationSentAt: r.explanationSentAt?.toISOString() ?? null,
        reviewRequestedAt: r.reviewRequestedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---- The organization's switch, and the platform's --------------------------

// ---- The MCP tool catalog, read-only preview (agent families step 6; Brief 2-7) ----
// Generated from the capability catalog for this tenant's modules: what an MCP
// server would expose. Nothing here calls anything. Before /:id so the literal wins.
agentsRouter.get('/mcp-catalog', VIEW, async (_req, res, next) => {
  try {
    const profile = await loadTenantProfile(tenantIdForWrite());
    res.json({ preview: true, tools: mcpCatalogFor(profile.modules) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/control', VIEW, async (_req, res, next) => {
  try {
    res.json(await tenantControlState(prisma, tenantIdForWrite()));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/suspend-all', MANAGE, async (req, res, next) => {
  try {
    const { reason } = AgentSuspendSchema.parse(req.body);
    res.json(await suspendTenantAgents(prisma, tenantIdForWrite(), req.user!.id, reason));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/resume-all', MANAGE, async (req, res, next) => {
  try {
    await resumeTenantAgents(prisma, tenantIdForWrite(), req.user!.id);
    res.json(await tenantControlState(prisma, tenantIdForWrite()));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/platform/control', VIEW, operatorOnly, async (_req, res, next) => {
  try {
    res.json(await controlState(prisma));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/platform/suspend-all', MANAGE, operatorOnly, async (req, res, next) => {
  try {
    const { reason } = AgentSuspendSchema.parse(req.body);
    res.json(await suspendAllAgents(prisma, req.user!.id, reason));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/platform/resume-all', MANAGE, operatorOnly, async (req, res, next) => {
  try {
    await resumeAllAgents(prisma, req.user!.id);
    res.json(await controlState(prisma));
  } catch (err) {
    next(err);
  }
});

// ---- One agent -------------------------------------------------------------

/* Brief 2-6 step 2 — the organization's own gates over the platform floor. */

agentsRouter.get('/gates', VIEW, async (_req, res, next) => {
  try {
    const rows = await prisma.agentGatePolicy.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: [{ effectiveTo: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }], take: 500 });
    const now = Date.now();
    res.json({
      policies: rows.map((p) => ({
        id: p.id,
        scope: p.scope,
        scopeKey: p.scopeKey,
        action: p.action,
        requirement: p.requirement,
        approver: p.approver,
        approverRole: p.approverRole,
        approverUserId: p.approverUserId,
        ttlHours: p.ttlHours,
        effectiveFrom: p.effectiveFrom.toISOString(),
        effectiveTo: p.effectiveTo?.toISOString() ?? null,
        inForce: p.effectiveFrom.getTime() <= now && (!p.effectiveTo || p.effectiveTo.getTime() > now),
      })),
    });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/gates', MANAGE, async (req, res, next) => {
  try {
    const row = await createGatePolicy(prisma, tenantIdForWrite(), GatePolicyInputSchema.parse(req.body), req.user!.id);
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/gates/:gid/end', MANAGE, async (req, res, next) => {
  try {
    await endGatePolicy(prisma, tenantIdForWrite(), Id.parse(req.params.gid), req.user!.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** What would happen: the resolution for an agent and an action or capability, now. */
agentsRouter.get('/gates/preview', VIEW, async (req, res, next) => {
  try {
    const q = z.object({ workerId: Id, action: AgentGatedActionSchema.exclude(['POLICY_GATE']).optional(), capability: z.string().max(120).optional() }).parse(req.query);
    await assertTenantAgent(prisma, q.workerId, tenantIdForWrite());
    const profile = await prisma.agentProfile.findUnique({ where: { workerId: q.workerId }, select: { family: true } });
    res.json(await gateFor(prisma, { workerId: q.workerId, tenantId: tenantIdForWrite(), family: profile?.family ?? null }, q.action ?? null, q.capability ?? null));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/:id', VIEW, ownAgent, async (req, res, next) => {
  try {
    res.json(await getAgent(prisma, Id.parse(req.params.id)));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    // Brief 2-6 step 1: catalog capabilities picked at registration (none = a custom agent acting through its scopes).
    const { catalogCapabilities, ...input } = AgentInputSchema.extend({ catalogCapabilities: z.array(AgentCapabilityKeySchema).max(10).default([]) }).parse(req.body);
    const agent = await createAgent(prisma, input, req.user!.id, new Date(), catalogCapabilities);
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: null, action: 'agent.registered', entityType: 'Worker', entityId: agent.id, workerId: agent.id, metadata: { name: agent.name, ownerUserId: input.ownerUserId, scopes: input.scopes, vendor: input.vendor, model: input.model, modelVersion: input.modelVersion, catalogCapabilities } },
      'agents',
    );
    res.status(201).json(agent);
  } catch (err) {
    next(err);
  }
});

agentsRouter.patch('/:id', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const input = AgentUpdateSchema.parse(req.body);
    const agent = await updateAgent(prisma, id, input, new Date(), req.user!.id);
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'agent.updated', entityType: 'Worker', entityId: id, workerId: id, metadata: { changed: Object.keys(input) } }, 'agents');
    res.json(agent);
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/credentials', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const { ttlHours } = AgentCredentialIssueSchema.parse(req.body ?? {});
    const issued = await issueCredential(prisma, id, ttlHours, req.user!.id);
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'agent.credential.issued', entityType: 'AgentCredential', entityId: issued.id, workerId: id, metadata: { last4: issued.last4, expiresAt: issued.expiresAt, ttlHours } }, 'agents');
    res.status(201).json(issued);
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/credentials/:cid/revoke', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const cid = Id.parse(req.params.cid);
    const { reason } = AgentRevokeSchema.parse(req.body ?? {});
    await revokeCredential(prisma, id, cid, reason ?? null);
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'agent.credential.revoked', entityType: 'AgentCredential', entityId: cid, workerId: id, metadata: { reason: reason ?? null } }, 'agents');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/spend', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const input = AgentSpendInputSchema.parse(req.body);
    const r = await recordSpend(prisma, id, input, req.user!.id);
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'agent.spend.recorded', entityType: 'AgentSpend', entityId: r.id, workerId: id, metadata: { amountCents: input.amountCents, taskRef: input.taskRef ?? null } }, 'agents');
    res.status(201).json(r);
  } catch (err) {
    next(err);
  }
});

// ---- Brief 1D-3 ------------------------------------------------------------

agentsRouter.post('/:id/suspend', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const { reason } = AgentSuspendSchema.parse(req.body);
    const r = await suspendAgent(prisma, id, req.user!.id, reason);
    res.json({ ...r, agent: await getAgent(prisma, id) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/resume', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    await resumeAgent(prisma, id, req.user!.id);
    res.json(await getAgent(prisma, id));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/:id/scenarios', VIEW, ownAgent, async (req, res, next) => {
  try {
    res.json({ scenarios: await listScenarios(prisma, Id.parse(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/scenarios', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const input = AgentScenarioInputSchema.parse(req.body);
    res.status(201).json(await addScenario(prisma, Id.parse(req.params.id), input, req.user!.id));
  } catch (err) {
    next(err);
  }
});

agentsRouter.delete('/:id/scenarios/:sid', MANAGE, ownAgent, async (req, res, next) => {
  try {
    await removeScenario(prisma, Id.parse(req.params.id), Id.parse(req.params.sid), req.user!.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/scenarios/run', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const r = await runScenarios(prisma, id, req.user!.id);
    res.json({ ...r, scenarios: await listScenarios(prisma, id) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/certify', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const c = await certifyAgent(prisma, id, req.user!.id);
    res.json({ certification: c, agent: await getAgent(prisma, id) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/:id/scorecard', VIEW, ownAgent, async (req, res, next) => {
  try {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    res.json(await scorecard(prisma, Id.parse(req.params.id), days));
  } catch (err) {
    next(err);
  }
});

agentsRouter.patch('/:id/drift', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const input = AgentDriftSchema.parse(req.body);
    const exists = await prisma.agentProfile.findUnique({ where: { workerId: id }, select: { workerId: true } });
    if (!exists) throw new HttpError(404, 'agent_not_found', 'No such agent.');
    await prisma.agentProfile.update({ where: { workerId: id }, data: input });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'agent.drift.configured', entityType: 'Worker', entityId: id, workerId: id, metadata: input }, 'agents');
    res.json(await getAgent(prisma, id));
  } catch (err) {
    next(err);
  }
});

// ---- Brief 2-6 step 3: the automated-decision record -------------------------

async function decisionRecordOf(workerId: string) {
  const tenantId = tenantIdForWrite();
  const now = new Date();
  const caps = await prisma.agentCapability.findMany({ where: { workerId, tenantId }, select: { key: true } });
  const saved = await prisma.agentDecisionProfile.findMany({ where: { workerId }, select: { capabilityKey: true } });
  const keys = [...new Set([...caps.map((c) => c.key), ...saved.map((p) => p.capabilityKey)])];
  const profiles = (await Promise.all(keys.map((k) => decisionProfileFor(prisma, workerId, k)))).filter((p) => p !== null);
  const audits = await prisma.agentBiasAudit.findMany({ where: { workerId, tenantId }, orderBy: { conductedAt: 'desc' } });
  const rows = await prisma.automatedDecisionRecord.findMany({ where: { workerId, tenantId }, orderBy: { createdAt: 'desc' }, take: 500 });
  const people = await prisma.associate.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.subjectAssociateId).filter((x): x is string => !!x))] } }, select: { id: true, firstName: true, lastName: true } });
  const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
  const dayMs = 86_400_000;
  return {
    profiles,
    audits: audits.map((a) => ({
      id: a.id,
      auditorName: a.auditorName,
      conductedAt: a.conductedAt.toISOString().slice(0, 10),
      validUntil: a.validUntil.toISOString().slice(0, 10),
      inForce: a.conductedAt <= now && a.validUntil.getTime() + dayMs > now.getTime(),
      expiresSoon: a.validUntil.getTime() + dayMs > now.getTime() && a.validUntil.getTime() - now.getTime() < 30 * dayMs,
      dataKind: a.dataKind,
      summaryUrl: a.summaryUrl,
    })),
    decisions: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      capabilityKey: r.capabilityKey,
      decisionType: r.decisionType,
      subject: r.subjectAssociateId ? (nameOf.get(r.subjectAssociateId) ?? 'A person') : r.subjectRef,
      subjectAssociateId: r.subjectAssociateId,
      outcome: r.outcome,
      summary: r.summary,
      jurisdictionTags: r.jurisdictionTags,
      humanDecidedAt: r.humanDecidedAt?.toISOString() ?? null,
      auditId: r.auditId,
      noticeGivenAt: r.noticeGivenAt?.toISOString() ?? null,
      explanationSentAt: r.explanationSentAt?.toISOString() ?? null,
      reviewRequestedAt: r.reviewRequestedAt?.toISOString() ?? null,
      reviewResolvedAt: r.reviewResolvedAt?.toISOString() ?? null,
      dataRequestAt: r.dataRequestAt?.toISOString() ?? null,
      dataSentAt: r.dataSentAt?.toISOString() ?? null,
    })),
  };
}

agentsRouter.get('/:id/decision-record', VIEW, ownAgent, async (req, res, next) => {
  try {
    res.json(await decisionRecordOf(Id.parse(req.params.id)));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/:id/decision-record.csv', VIEW, ownAgent, async (req, res, next) => {
  try {
    const { decisions } = await decisionRecordOf(Id.parse(req.params.id));
    const cell = (v: unknown) => {
      const t = String(v ?? '');
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const head = ['at', 'capability', 'decisionType', 'subject', 'outcome', 'summary', 'jurisdictions', 'humanDecidedAt', 'biasAuditId', 'noticeGivenAt', 'explanationSentAt', 'reviewRequestedAt', 'reviewResolvedAt', 'dataRequestAt', 'dataSentAt'];
    const lines = decisions.map((d) => [d.at, d.capabilityKey, d.decisionType, d.subject, d.outcome, d.summary, d.jurisdictionTags.join(' '), d.humanDecidedAt, d.auditId, d.noticeGivenAt, d.explanationSentAt, d.reviewRequestedAt, d.reviewResolvedAt, d.dataRequestAt, d.dataSentAt].map(cell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="decision-record-${req.params.id}.csv"`);
    res.send([head.join(','), ...lines].join('\n') + '\n');
  } catch (err) {
    next(err);
  }
});

agentsRouter.put('/:id/decision-profiles/:key', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const key = z.string().min(1).max(80).parse(req.params.key);
    res.json(await saveDecisionProfile(prisma, tenantIdForWrite(), Id.parse(req.params.id), key, DecisionProfileInputSchema.parse(req.body), req.user!.id));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/bias-audits', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const row = await addBiasAudit(prisma, tenantIdForWrite(), Id.parse(req.params.id), BiasAuditInputSchema.parse(req.body), req.user!.id);
    res.status(201).json({ id: row.id, validUntil: row.validUntil.toISOString().slice(0, 10) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/decisions/:did/events', MANAGE, async (req, res, next) => {
  try {
    const { event, channel } = z.object({ event: z.enum(DECISION_EVENTS), channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP', 'PAPER']).optional() }).strict().parse(req.body);
    const row = await markDecisionEvent(prisma, tenantIdForWrite(), Id.parse(req.params.did), event, req.user!.id, { channel });
    res.json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

// ---- Agent families step 0: capabilities ------------------------------------

agentsRouter.get('/:id/capabilities', VIEW, ownAgent, async (req, res, next) => {
  try {
    res.json({ capabilities: await listAgentCapabilities(prisma, Id.parse(req.params.id), tenantIdForWrite()) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/capabilities/:key/suspend', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const { reason } = AgentSuspendSchema.parse(req.body);
    const key = AgentCapabilityKeySchema.parse(req.params.key);
    res.json(await suspendCapability(prisma, Id.parse(req.params.id), key, tenantIdForWrite(), req.user!.id, reason));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/capabilities/:key/resume', MANAGE, ownAgent, async (req, res, next) => {
  try {
    const key = AgentCapabilityKeySchema.parse(req.params.key);
    res.json(await resumeCapability(prisma, Id.parse(req.params.id), key, tenantIdForWrite(), req.user!.id));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/:id/capabilities/:key/scorecard', VIEW, ownAgent, async (req, res, next) => {
  try {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    const id = Id.parse(req.params.id);
    const key = AgentCapabilityKeySchema.parse(req.params.key);
    const held = await prisma.agentCapability.findFirst({ where: { workerId: id, key, tenantId: tenantIdForWrite() }, select: { id: true } });
    if (!held) throw new HttpError(404, 'capability_not_found', 'This agent does not hold that capability.');
    res.json(await capabilityScorecard(prisma, id, key, days));
  } catch (err) {
    next(err);
  }
});
