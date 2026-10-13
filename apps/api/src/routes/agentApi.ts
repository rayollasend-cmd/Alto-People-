import { Router } from 'express';
import { z } from 'zod';
import { AGENT_EXECUTABLE_ACTIONS, AgentMessageInputSchema, AgentRequestInputSchema, AgentScenarioAnswerSchema, AgentSpendInputSchema, type AgentSelf } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { recordAgentCalls, requireAgent, requireOnboardingAgent } from '../middleware/agentAuth.js';
import { claimApproval, createApprovalRequest, getApproval, monthSpendCents, postAgentMessage, recordSpend, rotateCredential, scheduleCsv } from '../lib/agents.js';
import { computeExecutiveSummary } from '../lib/executiveSummary.js';
import { recordScenarioAnswer } from '../lib/agentControls.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * What an agent can call (Brief 1D-2). Bearer alto_agent_… on every route;
 * every call is logged under the agent.
 *
 *   GET  /agent/v1/me                          who am I, my scopes, limits and spend
 *   POST /agent/v1/credentials/rotate          a fresh credential; the old one works five more minutes
 *   POST /agent/v1/spend                       self-reported cost of a task
 *   GET  /agent/v1/schedule                    view:scheduling — a client's shifts in a window
 *   GET  /agent/v1/reports/executive-summary   view:analytics
 *   POST /agent/v1/messages                    manage:communications — a thread that reaches a client is gated
 *   GET  /agent/v1/exports/schedule.csv        gated (DATA_EXPORT): names leave the system
 *   POST /agent/v1/requests                    ask for any gated action; PAY_CHANGE and SEPARATION are only ever asked
 *   GET  /agent/v1/requests/:id                where it stands
 *   GET  /agent/v1/certification               the scenarios to answer (inputs only) — open to an onboarding agent
 *   POST /agent/v1/certification/:scenarioId   the answer; pass or fail is recorded under the current model version
 */
export const agentApiRouter = Router();

agentApiRouter.use(recordAgentCalls);

const Id = z.string().uuid();

agentApiRouter.get('/me', requireAgent(), async (req, res, next) => {
  try {
    const agent = req.agent!;
    const [profile, cred] = await Promise.all([
      prisma.agentProfile.findUniqueOrThrow({ where: { workerId: agent.workerId } }),
      prisma.agentCredential.findUniqueOrThrow({ where: { id: agent.credentialId }, select: { id: true, expiresAt: true } }),
    ]);
    res.locals.agentAction = 'agent.me';
    const body: AgentSelf = {
      workerId: agent.workerId,
      name: agent.name,
      status: agent.status,
      scopes: agent.scopes,
      limits: { spendCapCents: profile.spendCapCents, rateLimitPerMinute: profile.rateLimitPerMinute, allowedHoursStart: profile.allowedHoursStart, allowedHoursEnd: profile.allowedHoursEnd },
      spendThisMonthCents: await monthSpendCents(prisma, agent.workerId, new Date()),
      credential: { id: cred.id, expiresAt: cred.expiresAt.toISOString() },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

agentApiRouter.post('/credentials/rotate', requireAgent(), async (req, res, next) => {
  try {
    const issued = await rotateCredential(prisma, req.agent!);
    res.locals.agentAction = 'agent.credential.rotated';
    res.locals.agentTarget = { type: 'AgentCredential', id: issued.id };
    res.status(201).json(issued);
  } catch (err) {
    next(err);
  }
});

agentApiRouter.post('/spend', requireAgent(), async (req, res, next) => {
  try {
    const input = AgentSpendInputSchema.parse(req.body);
    const r = await recordSpend(prisma, req.agent!.workerId, input, null);
    res.locals.agentAction = 'agent.spend.reported';
    res.locals.agentTarget = { type: 'AgentSpend', id: r.id };
    res.status(201).json(r);
  } catch (err) {
    next(err);
  }
});

const WindowQuery = z.object({
  clientId: Id,
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function timeWindow(q: z.infer<typeof WindowQuery>): { from: Date; to: Date } {
  // Rounded to the hour so a request repeated within the hour is the same request (approvals hash the window).
  const from = q.from ? new Date(q.from) : new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 24 * 3_600_000);
  const to = q.to ? new Date(q.to) : new Date(from.getTime() + 7 * 24 * 3_600_000);
  if (to <= from || to.getTime() - from.getTime() > 35 * 24 * 3_600_000) throw new HttpError(400, 'bad_window', 'The window must be between one hour and five weeks.');
  return { from, to };
}

agentApiRouter.get('/schedule', requireAgent('view:scheduling'), async (req, res, next) => {
  try {
    const q = WindowQuery.parse(req.query);
    const { from, to } = timeWindow(q);
    const shifts = await prisma.shift.findMany({
      where: { clientId: q.clientId, startsAt: { gte: from, lt: to }, status: { not: 'CANCELLED' } },
      orderBy: { startsAt: 'asc' },
      take: 1000,
      select: { id: true, position: true, location: true, startsAt: true, endsAt: true, status: true, workerId: true, assignedAssociateId: true },
    });
    res.locals.agentAction = 'agent.schedule.read';
    res.locals.agentTarget = { type: 'Client', id: q.clientId };
    res.json({
      clientId: q.clientId,
      from: from.toISOString(),
      to: to.toISOString(),
      count: shifts.length,
      // Ids only: a name is a data export, and that is gated.
      shifts: shifts.map((s) => ({ id: s.id, position: s.position, location: s.location, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), status: s.status, workerId: s.workerId, assigned: s.assignedAssociateId != null || s.workerId != null })),
    });
  } catch (err) {
    next(err);
  }
});

agentApiRouter.get('/reports/executive-summary', requireAgent('view:analytics'), async (_req, res, next) => {
  try {
    res.locals.agentAction = 'agent.report.read';
    res.locals.agentTarget = { type: 'Report', id: 'executive-summary' };
    // Brief 2-1: the agent's request runs as its tenant; the summary reads that tenant only.
    res.json(await computeExecutiveSummary(prisma, new Date(), { tenantId: tenantIdForWrite() }));
  } catch (err) {
    next(err);
  }
});

agentApiRouter.post('/messages', requireAgent('manage:communications'), async (req, res, next) => {
  try {
    const input = AgentMessageInputSchema.parse(req.body);
    const r = await postAgentMessage(prisma, req.agent!, input);
    if (r.gated) {
      res.locals.agentAction = 'agent.message.gated';
      res.locals.agentTarget = { type: 'AgentApprovalRequest', id: r.approval.id };
      res.status(202).json({ status: r.approval.status, approvalId: r.approval.id, created: r.created, message: 'This thread reaches a client. The request is in the approval queue; send again with approvalId once it is approved.' });
      return;
    }
    res.locals.agentAction = 'agent.message.sent';
    res.locals.agentTarget = { type: 'Message', id: r.messageId };
    res.locals.agentApprovalId = r.approvalId;
    res.status(201).json({ messageId: r.messageId, approvalId: r.approvalId });
  } catch (err) {
    next(err);
  }
});

agentApiRouter.get('/exports/schedule.csv', requireAgent('view:scheduling'), async (req, res, next) => {
  try {
    const q = WindowQuery.extend({ approvalId: Id.optional() }).parse(req.query);
    const { from, to } = timeWindow(q);
    const payload = { clientId: q.clientId, from: from.toISOString(), to: to.toISOString() };
    if (!q.approvalId) {
      const r = await createApprovalRequest(prisma, req.agent!, { action: 'DATA_EXPORT', summary: `Schedule export for client ${q.clientId}, ${payload.from.slice(0, 10)} to ${payload.to.slice(0, 10)}`, payload });
      res.locals.agentAction = 'agent.export.gated';
      res.locals.agentTarget = { type: 'AgentApprovalRequest', id: r.approval.id };
      res.status(202).json({ status: r.approval.status, approvalId: r.approval.id, created: r.created, payload, message: 'Exports are approved by a person. Ask again with the same clientId, from and to plus approvalId once it is approved.' });
      return;
    }
    const approval = await claimApproval(prisma, req.agent!, q.approvalId, 'DATA_EXPORT', payload);
    const { csv, rows } = await scheduleCsv(prisma, q.clientId, from, to);
    res.locals.agentAction = 'agent.export.schedule';
    res.locals.agentTarget = { type: 'Client', id: q.clientId };
    res.locals.agentApprovalId = approval.id;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Row-Count', String(rows));
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

agentApiRouter.post('/requests', requireAgent(), async (req, res, next) => {
  try {
    const input = AgentRequestInputSchema.parse(req.body);
    const r = await createApprovalRequest(prisma, req.agent!, input);
    res.locals.agentAction = 'agent.request.filed';
    res.locals.agentTarget = { type: 'AgentApprovalRequest', id: r.approval.id };
    res.status(202).json({
      approvalId: r.approval.id,
      status: r.approval.status,
      created: r.created,
      executable: AGENT_EXECUTABLE_ACTIONS.includes(input.action),
      message: AGENT_EXECUTABLE_ACTIONS.includes(input.action) ? 'Waiting for a person. Carry it out with the approvalId once approved.' : 'Waiting for a person, who carries it out in the app if they approve. Nothing happens until then.',
    });
  } catch (err) {
    next(err);
  }
});

agentApiRouter.get('/requests/:id', requireAgent(), async (req, res, next) => {
  try {
    const a = await getApproval(prisma, Id.parse(req.params.id));
    if (a.workerId !== req.agent!.workerId) throw new HttpError(404, 'approval_not_found', 'No such request for this agent.');
    res.locals.agentAction = 'agent.request.read';
    res.locals.agentTarget = { type: 'AgentApprovalRequest', id: a.id };
    res.json({ id: a.id, action: a.action, status: a.status, requestedAt: a.requestedAt, expiresAt: a.expiresAt, decidedAt: a.decidedAt, decisionNote: a.decisionNote, consumedAt: a.consumedAt });
  } catch (err) {
    next(err);
  }
});

// ---- Brief 1D-3: certification ----------------------------------------------

agentApiRouter.get('/certification', requireOnboardingAgent(), async (req, res, next) => {
  try {
    const rows = await prisma.agentScenario.findMany({ where: { workerId: req.agent!.workerId }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, input: true } });
    res.locals.agentAction = 'agent.certification.read';
    res.json({ scenarios: rows.map((s) => ({ id: s.id, name: s.name, input: s.input })) });
  } catch (err) {
    next(err);
  }
});

agentApiRouter.post('/certification/:scenarioId', requireOnboardingAgent(), async (req, res, next) => {
  try {
    const scenarioId = Id.parse(req.params.scenarioId);
    const answer = AgentScenarioAnswerSchema.parse(req.body);
    const run = await recordScenarioAnswer(prisma, req.agent!.workerId, scenarioId, answer, null);
    res.locals.agentAction = 'agent.scenario.answered';
    res.locals.agentTarget = { type: 'AgentScenario', id: scenarioId };
    res.status(201).json({ passed: run.passed, reason: run.reason, modelVersion: run.modelVersion });
  } catch (err) {
    next(err);
  }
});
