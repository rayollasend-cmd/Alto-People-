import { Router } from 'express';
import { z } from 'zod';
import { AgentApprovalStatusSchema, AgentCredentialIssueSchema, AgentDecisionSchema, AgentDriftSchema, AgentInputSchema, AgentRevokeSchema, AgentScenarioInputSchema, AgentSpendInputSchema, AgentSuspendSchema, AgentUpdateSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { createAgent, decideApproval, ensureBuiltInAgents, getAgent, getApproval, issueCredential, listAgents, listApprovals, recordSpend, revokeCredential, updateAgent } from '../lib/agents.js';
import { addScenario, certifyAgent, controlState, listScenarios, removeScenario, resumeAgent, resumeAllAgents, runScenarios, scorecard, suspendAgent, suspendAllAgents } from '../lib/agentControls.js';

/**
 * The agent registry, for people (Brief 1D-2).
 *
 *   GET   /agents                               every agent, counts, the approval queue size   (view:org)
 *   POST  /agents                               register one — owner required                  (manage:org)
 *   POST  /agents/ensure-built-in               register the agents Alto already runs
 *   GET   /agents/approvals?status=             the queue
 *   GET   /agents/approvals/:id
 *   POST  /agents/approvals/:id/approve|reject  the decision, logged
 *   GET   /agents/:id                           profile, credentials, requests, spend, the trail
 *   PATCH /agents/:id
 *   POST  /agents/:id/credentials               issue a short-lived credential (plaintext shown once)
 *   POST  /agents/:id/credentials/:cid/revoke
 *   POST  /agents/:id/spend                     record spend from an invoice
 *
 * Brief 1D-3:
 *   GET   /agents/control · POST /agents/suspend-all · POST /agents/resume-all   the global switch
 *   POST  /agents/:id/suspend · POST /agents/:id/resume (owner only)
 *   GET   /agents/:id/scenarios · POST · DELETE /:sid · POST /agents/:id/scenarios/run (built-ins)
 *   POST  /agents/:id/certify                   every scenario passing → certified, onboarding → active
 *   GET   /agents/:id/scorecard?days=
 *   PATCH /agents/:id/drift                     thresholds
 */
export const agentsRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');
const Id = z.string().uuid();

agentsRouter.get('/', VIEW, async (_req, res, next) => {
  try {
    res.json(await listAgents(prisma));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/ensure-built-in', MANAGE, async (req, res, next) => {
  try {
    const r = await ensureBuiltInAgents(prisma);
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'agent.built_in_ensured', entityType: 'AgentProfile', entityId: 'sweep', metadata: r }, 'agents');
    res.json(r);
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/approvals', VIEW, async (req, res, next) => {
  try {
    const q = z.object({ status: AgentApprovalStatusSchema.optional(), workerId: Id.optional() }).parse(req.query);
    res.json({ approvals: await listApprovals(prisma, q) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/approvals/:id', VIEW, async (req, res, next) => {
  try {
    res.json(await getApproval(prisma, Id.parse(req.params.id)));
  } catch (err) {
    next(err);
  }
});

for (const decision of ['approve', 'reject'] as const) {
  agentsRouter.post(`/approvals/:id/${decision}`, MANAGE, async (req, res, next) => {
    try {
      const { note } = AgentDecisionSchema.parse(req.body ?? {});
      res.json(await decideApproval(prisma, Id.parse(req.params.id), decision === 'approve' ? 'APPROVED' : 'REJECTED', req.user!.id, note ?? null));
    } catch (err) {
      next(err);
    }
  });
}

agentsRouter.get('/control', VIEW, async (_req, res, next) => {
  try {
    res.json(await controlState(prisma));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/suspend-all', MANAGE, async (req, res, next) => {
  try {
    const { reason } = AgentSuspendSchema.parse(req.body);
    res.json(await suspendAllAgents(prisma, req.user!.id, reason));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/resume-all', MANAGE, async (req, res, next) => {
  try {
    await resumeAllAgents(prisma, req.user!.id);
    res.json(await controlState(prisma));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/:id', VIEW, async (req, res, next) => {
  try {
    res.json(await getAgent(prisma, Id.parse(req.params.id)));
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const input = AgentInputSchema.parse(req.body);
    const agent = await createAgent(prisma, input, req.user!.id);
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: null, action: 'agent.registered', entityType: 'Worker', entityId: agent.id, workerId: agent.id, metadata: { name: agent.name, ownerUserId: input.ownerUserId, scopes: input.scopes, vendor: input.vendor, model: input.model, modelVersion: input.modelVersion } },
      'agents',
    );
    res.status(201).json(agent);
  } catch (err) {
    next(err);
  }
});

agentsRouter.patch('/:id', MANAGE, async (req, res, next) => {
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

agentsRouter.post('/:id/credentials', MANAGE, async (req, res, next) => {
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

agentsRouter.post('/:id/credentials/:cid/revoke', MANAGE, async (req, res, next) => {
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

agentsRouter.post('/:id/spend', MANAGE, async (req, res, next) => {
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

agentsRouter.post('/:id/suspend', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const { reason } = AgentSuspendSchema.parse(req.body);
    const r = await suspendAgent(prisma, id, req.user!.id, reason);
    res.json({ ...r, agent: await getAgent(prisma, id) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/resume', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    await resumeAgent(prisma, id, req.user!.id);
    res.json(await getAgent(prisma, id));
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/:id/scenarios', VIEW, async (req, res, next) => {
  try {
    res.json({ scenarios: await listScenarios(prisma, Id.parse(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/scenarios', MANAGE, async (req, res, next) => {
  try {
    const input = AgentScenarioInputSchema.parse(req.body);
    res.status(201).json(await addScenario(prisma, Id.parse(req.params.id), input, req.user!.id));
  } catch (err) {
    next(err);
  }
});

agentsRouter.delete('/:id/scenarios/:sid', MANAGE, async (req, res, next) => {
  try {
    await removeScenario(prisma, Id.parse(req.params.id), Id.parse(req.params.sid), req.user!.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/scenarios/run', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const r = await runScenarios(prisma, id, req.user!.id);
    res.json({ ...r, scenarios: await listScenarios(prisma, id) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.post('/:id/certify', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const c = await certifyAgent(prisma, id, req.user!.id);
    res.json({ certification: c, agent: await getAgent(prisma, id) });
  } catch (err) {
    next(err);
  }
});

agentsRouter.get('/:id/scorecard', VIEW, async (req, res, next) => {
  try {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    res.json(await scorecard(prisma, Id.parse(req.params.id), days));
  } catch (err) {
    next(err);
  }
});

agentsRouter.patch('/:id/drift', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const input = AgentDriftSchema.parse(req.body);
    const exists = await prisma.agentProfile.findUnique({ where: { workerId: id }, select: { workerId: true } });
    if (!exists) {
      res.status(404).json({ error: { code: 'agent_not_found', message: 'No such agent.' } });
      return;
    }
    await prisma.agentProfile.update({ where: { workerId: id }, data: input });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'agent.drift.configured', entityType: 'Worker', entityId: id, workerId: id, metadata: input }, 'agents');
    res.json(await getAgent(prisma, id));
  } catch (err) {
    next(err);
  }
});
