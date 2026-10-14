import type { NextFunction, Request, Response } from 'express';
import { ALTO_TENANT_ID, runWithTenant } from '../lib/tenant.js';
import type { AgentScope } from '@alto-people/shared';
import { prisma } from '../db.js';
import { enqueueAudit } from '../lib/audit.js';
import { markRequestAudited } from '../lib/auditRequestContext.js';
import { AGENT_TOKEN_PREFIX, authenticateAgent, logAgentAction, takeRateToken, type AgentDenial } from '../lib/agents.js';

/**
 * Agent credentials on /agent/v1 (Brief 1D-2).
 *
 *   requireAgent(...scopes) — Bearer alto_agent_…; refuses unknown, expired
 *   and revoked tokens, agents that are not ACTIVE, calls outside the
 *   agent's hours or over its spend cap or rate limit, and any scope the
 *   agent was not granted. Every refusal that can be tied to an agent is
 *   logged under it.
 *
 *   recordAgentCalls — router-level: once a response finishes, the call is
 *   logged under the agent with the scopes it used, the record it touched
 *   (res.locals.agentTarget) and the approval it cited (res.locals
 *   .agentApprovalId). Handlers name the action in res.locals.agentAction.
 */

function deny(req: Request, res: Response, d: AgentDenial, scope?: string): void {
  if (d.workerId) {
    enqueueAudit(
      {
        actorUserId: null,
        clientId: null,
        workerId: d.workerId,
        action: 'agent.denied',
        entityType: 'AgentRequest',
        entityId: d.credentialId ?? 'unknown',
        metadata: { code: d.code, method: req.method, path: req.originalUrl, scopes: res.locals.agentScopes ?? [], scope: scope ?? null },
      },
      'agentAuth',
    );
  }
  res.status(d.status).json({ error: { code: d.code, message: d.message } });
}

export function requireAgent(...scopes: AgentScope[]) {
  return guard(scopes, {});
}

/** The certification endpoints: an onboarding agent may answer its scenarios and nothing else. */
export function requireOnboardingAgent() {
  return guard([], { allowOnboarding: true });
}

function guard(scopes: AgentScope[], opts: { allowOnboarding?: boolean }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.agentScopes = scopes;
      const header = req.header('authorization') ?? '';
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      const presented = m?.[1];
      if (!presented || !presented.startsWith(AGENT_TOKEN_PREFIX)) {
        deny(req, res, { ok: false, status: 401, code: 'unauthenticated', message: 'An agent credential is required.', workerId: null, credentialId: null });
        return;
      }
      const auth = await authenticateAgent(prisma, presented, new Date(), opts);
      if (!auth.ok) {
        deny(req, res, auth);
        return;
      }
      const missing = scopes.find((s) => !auth.agent.scopes.includes(s));
      if (missing) {
        deny(req, res, { ok: false, status: 403, code: 'agent_scope_missing', message: `This agent was not granted ${missing}.`, workerId: auth.agent.workerId, credentialId: auth.agent.credentialId }, missing);
        return;
      }
      if (!takeRateToken(auth.agent.workerId, auth.agent.rateLimitPerMinute)) {
        deny(req, res, { ok: false, status: 429, code: 'rate_limited', message: `This agent is limited to ${auth.agent.rateLimitPerMinute} calls a minute.`, workerId: auth.agent.workerId, credentialId: auth.agent.credentialId });
        return;
      }
      req.agent = auth.agent;
      // Brief 2-1, step two: the agent's tenant is the request's tenant.
      runWithTenant(auth.agent.tenantId ?? ALTO_TENANT_ID, 'agent', () => next());
    } catch (err) {
      next(err);
    }
  };
}

export function recordAgentCalls(req: Request, res: Response, next: NextFunction): void {
  // Every /agent/v1 call is logged under the agent once it finishes, so the
  // audit floor (Brief 2-3) does not add a second row for it.
  markRequestAudited();
  res.on('finish', () => {
    const agent = req.agent;
    if (!agent) return;
    const target = (res.locals.agentTarget as { type: string; id: string } | undefined) ?? { type: 'AgentRequest', id: agent.credentialId };
    logAgentAction(agent, {
      action: (res.locals.agentAction as string | undefined) ?? `agent.${req.method.toLowerCase()}`,
      entityType: target.type,
      entityId: target.id,
      scopes: (res.locals.agentScopes as string[] | undefined) ?? [],
      approvalId: (res.locals.agentApprovalId as string | null | undefined) ?? null,
      metadata: { method: req.method, path: req.originalUrl, status: res.statusCode },
    });
  });
  next();
}
