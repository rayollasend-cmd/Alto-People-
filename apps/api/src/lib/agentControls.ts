import type { Prisma, PrismaClient } from '@prisma/client';
import { tenantJob } from './tenantJobs.js';
import type { AgentCertification, AgentControlState, AgentScenarioAnswer, AgentScenarioInput, AgentScenarioSummary, AgentScorecard, AgentScenarioRunSummary } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { notifyUser } from './notify.js';
import { revokeAllCredentials, type BuiltInAgentKey } from './agents.js';
import { detectIntent } from './whatsappAssistant.js';
import { updateWorker } from './workers.js';

/**
 * Agent controls (Brief 1D-3).
 *
 *   Kill switch — suspend one agent or all of them: credentials are revoked
 *   in the same transaction and authenticateAgent reads the switch on every
 *   call, so the next call fails at once. Resuming one agent is its owner's
 *   to do; resuming all is any org admin's.
 *
 *   Certification — scenarios per agent; the API runs them itself for the
 *   built-in assistant and takes answers from an external agent through
 *   /agent/v1/certification. An agent leaves ONBOARDING only when every
 *   scenario passes under its current model version; a new version sends
 *   it back.
 *
 *   Scorecard — from the trail (AuditLog by workerId), the approval queue
 *   and the spend records. Drift — a daily look at the trailing week.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const AGENT_DRIFT_CATEGORY = 'agent_drift';
export const AGENT_KILL_CATEGORY = 'agent_kill';
const DAY = 24 * 3_600_000;

const PERSON_SELECT = { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } as const;
type Person = { id: string; email: string; associate: { firstName: string; lastName: string } | null } | null;
function personName(u: Person): { id: string; name: string } | null {
  return u ? { id: u.id, name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email } : null;
}

async function userRef(db: Db, id: string | null): Promise<{ id: string; name: string } | null> {
  if (!id) return null;
  return personName(await db.user.findUnique({ where: { id }, select: PERSON_SELECT }));
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

export async function controlState(db: Db): Promise<AgentControlState> {
  const row = await db.agentControl.findUnique({ where: { id: 'singleton' } });
  return { allSuspendedAt: row?.allSuspendedAt?.toISOString() ?? null, suspendedBy: await userRef(db, row?.suspendedById ?? null), reason: row?.reason ?? null };
}

export async function allAgentsSuspended(db: Db): Promise<boolean> {
  const row = await db.agentControl.findUnique({ where: { id: 'singleton' }, select: { allSuspendedAt: true } });
  return row?.allSuspendedAt != null;
}

export async function suspendAgent(db: Db, workerId: string, actorUserId: string, reason: string, now: Date = new Date()): Promise<{ revoked: number }> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, include: { worker: { select: { name: true, status: true, ownerUserId: true } } } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'No such agent.');
  if (profile.worker.status === 'OFFBOARDED') throw new HttpError(409, 'agent_offboarded', 'An offboarded agent cannot be suspended.');
  const revoked = await revokeAllCredentials(db, workerId, 'suspended', now);
  await db.worker.update({ where: { id: workerId }, data: { status: 'SUSPENDED' } });
  await db.agentProfile.update({ where: { workerId }, data: { suspendedAt: now, suspendedById: actorUserId, suspendReason: reason } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'agent.suspended', entityType: 'Worker', entityId: workerId, metadata: { reason, revoked } }, 'agentControls');
  if (profile.worker.ownerUserId !== actorUserId) {
    await notifyUser(profile.worker.ownerUserId, { subject: `${profile.worker.name} was suspended`, body: `${reason} Its credentials were revoked. Only you can resume it.`, category: AGENT_KILL_CATEGORY, linkUrl: `/agents?agent=${workerId}` });
  }
  return { revoked };
}

/** The owner brings it back; certification must be current. No credential is restored. */
export async function resumeAgent(db: Db, workerId: string, actorUserId: string, now: Date = new Date()): Promise<void> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, include: { worker: { select: { status: true, ownerUserId: true } } } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'No such agent.');
  if (profile.worker.ownerUserId !== actorUserId) throw new HttpError(403, 'owner_only', 'Only the accountable owner can resume this agent.');
  if (profile.worker.status !== 'SUSPENDED') throw new HttpError(409, 'agent_not_suspended', `This agent is ${profile.worker.status.toLowerCase()}.`);
  if (profile.certifiedModelVersion !== profile.modelVersion) throw new HttpError(409, 'agent_not_certified', 'This agent must pass its scenarios for the current model version first.');
  await db.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  await db.agentProfile.update({ where: { workerId }, data: { suspendedAt: null, suspendedById: null, suspendReason: null } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'agent.resumed', entityType: 'Worker', entityId: workerId, metadata: { suspendedAt: profile.suspendedAt?.toISOString() ?? null, at: now.toISOString() } }, 'agentControls');
}

export async function suspendAllAgents(db: Db, actorUserId: string, reason: string, now: Date = new Date()): Promise<{ revoked: number; agents: number }> {
  await db.agentControl.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', allSuspendedAt: now, suspendedById: actorUserId, reason }, update: { allSuspendedAt: now, suspendedById: actorUserId, reason } });
  const revoked = await db.agentCredential.updateMany({ where: { expiresAt: { gt: now }, OR: [{ revokedAt: null }, { revokedAt: { gt: now } }] }, data: { revokedAt: now, revokedReason: 'all agents suspended' } });
  const owners = await db.worker.findMany({ where: { type: 'AGENT', status: 'ACTIVE' }, select: { id: true, ownerUserId: true } });
  enqueueAudit({ actorUserId, clientId: null, action: 'agent.all_suspended', entityType: 'AgentControl', entityId: 'singleton', metadata: { reason, revoked: revoked.count, agents: owners.length } }, 'agentControls');
  for (const ownerId of new Set(owners.map((o) => o.ownerUserId))) {
    await notifyUser(ownerId, { subject: 'All AI agents were suspended', body: `${reason} Every agent credential was revoked; agents resume when an admin lifts the switch and issues new credentials.`, category: AGENT_KILL_CATEGORY, linkUrl: '/agents' });
  }
  return { revoked: revoked.count, agents: owners.length };
}

export async function resumeAllAgents(db: Db, actorUserId: string, now: Date = new Date()): Promise<void> {
  const row = await db.agentControl.findUnique({ where: { id: 'singleton' } });
  if (!row?.allSuspendedAt) throw new HttpError(409, 'agents_not_suspended', 'Agents are not suspended.');
  await db.agentControl.update({ where: { id: 'singleton' }, data: { allSuspendedAt: null, suspendedById: null, reason: null } });
  enqueueAudit({ actorUserId, clientId: null, action: 'agent.all_resumed', entityType: 'AgentControl', entityId: 'singleton', metadata: { suspendedAt: row.allSuspendedAt.toISOString(), at: now.toISOString() } }, 'agentControls');
}

// ---------------------------------------------------------------------------
// Certification
// ---------------------------------------------------------------------------

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

type Expected = { output?: Record<string, unknown>; allowedActions?: string[] };

/** Pass or fail, with the reason in words. */
export function evaluateScenario(expected: Expected, answer: AgentScenarioAnswer): { passed: boolean; reason: string | null } {
  if (expected.allowedActions) {
    const taken = answer.actions ?? [];
    const outside = taken.filter((a) => !expected.allowedActions!.includes(a));
    if (outside.length) return { passed: false, reason: `Took an action outside the allowed set: ${outside.join(', ')}.` };
  }
  if (expected.output !== undefined) {
    if (answer.output === undefined) return { passed: false, reason: 'No output was given.' };
    if (!same(expected.output, answer.output)) return { passed: false, reason: `Expected ${JSON.stringify(canonical(expected.output))}, got ${JSON.stringify(canonical(answer.output))}.` };
  }
  return { passed: true, reason: null };
}

/** The API can exercise its own built-in agents. */
export function runBuiltIn(key: BuiltInAgentKey | null, input: Record<string, unknown>): AgentScenarioAnswer | null {
  if (key === 'whatsapp-assistant') {
    const text = typeof input.text === 'string' ? input.text : '';
    const r = detectIntent(text);
    return { output: { intent: r.intent, ...(r.lang ? { lang: r.lang } : {}) }, actions: [r.intent === 'HANDOFF' ? 'handoff' : 'reply'] };
  }
  return null;
}

type ScenarioRow = Prisma.AgentScenarioGetPayload<{ include: { runs: true } }>;

function runSummary(r: { id: string; modelVersion: string; passed: boolean; actual: Prisma.JsonValue | null; reason: string | null; ranById: string | null; ranAt: Date }, ranBy: { id: string; name: string } | null): AgentScenarioRunSummary {
  return { id: r.id, modelVersion: r.modelVersion, passed: r.passed, actual: (r.actual as Record<string, unknown> | null) ?? null, reason: r.reason, ranBy, ranAt: r.ranAt.toISOString() };
}

export async function listScenarios(db: Db, workerId: string): Promise<AgentScenarioSummary[]> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, select: { modelVersion: true } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'No such agent.');
  const rows: ScenarioRow[] = await db.agentScenario.findMany({ where: { workerId }, orderBy: { createdAt: 'asc' }, include: { runs: { where: { modelVersion: profile.modelVersion }, orderBy: { ranAt: 'desc' }, take: 1 } } });
  const out: AgentScenarioSummary[] = [];
  for (const s of rows) {
    const latest = s.runs[0] ?? null;
    out.push({
      id: s.id,
      name: s.name,
      input: (s.input as Record<string, unknown>) ?? {},
      expected: (s.expected as Expected) ?? {},
      latest: latest ? runSummary(latest, await userRef(db, latest.ranById)) : null,
      createdAt: s.createdAt.toISOString(),
    });
  }
  return out;
}

export async function addScenario(db: Db, workerId: string, input: AgentScenarioInput, createdById: string): Promise<AgentScenarioSummary> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, select: { workerId: true } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'No such agent.');
  const row = await db.agentScenario.create({ data: { workerId, name: input.name, input: input.input as Prisma.InputJsonObject, expected: input.expected as Prisma.InputJsonObject, createdById } });
  enqueueAudit({ actorUserId: createdById, clientId: null, workerId, action: 'agent.scenario.added', entityType: 'AgentScenario', entityId: row.id, metadata: { name: input.name } }, 'agentControls');
  return { id: row.id, name: row.name, input: input.input, expected: input.expected, latest: null, createdAt: row.createdAt.toISOString() };
}

export async function removeScenario(db: Db, workerId: string, scenarioId: string, actorUserId: string): Promise<void> {
  const r = await db.agentScenario.deleteMany({ where: { id: scenarioId, workerId } });
  if (!r.count) throw new HttpError(404, 'scenario_not_found', 'No such scenario.');
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'agent.scenario.removed', entityType: 'AgentScenario', entityId: scenarioId, metadata: {} }, 'agentControls');
}

/** Record an answer for one scenario, from the agent itself or from the in-process runner. */
export async function recordScenarioAnswer(db: Db, workerId: string, scenarioId: string, answer: AgentScenarioAnswer, ranById: string | null, now: Date = new Date()): Promise<AgentScenarioRunSummary> {
  const [scenario, profile] = await Promise.all([
    db.agentScenario.findFirst({ where: { id: scenarioId, workerId } }),
    db.agentProfile.findUnique({ where: { workerId }, select: { modelVersion: true } }),
  ]);
  if (!scenario || !profile) throw new HttpError(404, 'scenario_not_found', 'No such scenario for this agent.');
  const verdict = evaluateScenario((scenario.expected as Expected) ?? {}, answer);
  const run = await db.agentScenarioRun.create({
    data: { scenarioId, workerId, modelVersion: profile.modelVersion, passed: verdict.passed, actual: answer as Prisma.InputJsonObject, reason: verdict.reason, ranById, ranAt: now },
  });
  enqueueAudit({ actorUserId: ranById, clientId: null, workerId, action: verdict.passed ? 'agent.scenario.passed' : 'agent.scenario.failed', entityType: 'AgentScenario', entityId: scenarioId, metadata: { modelVersion: profile.modelVersion, reason: verdict.reason } }, 'agentControls');
  return runSummary(run, await userRef(db, ranById));
}

/** Runs every scenario of a built-in agent in process. */
export async function runScenarios(db: Db, workerId: string, ranById: string, now: Date = new Date()): Promise<{ ran: number; passed: number }> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, select: { builtInKey: true } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'No such agent.');
  if (runBuiltIn(profile.builtInKey as BuiltInAgentKey | null, {}) === null) {
    throw new HttpError(409, 'agent_answers_itself', 'This agent answers its scenarios through /agent/v1/certification; the API cannot run it.');
  }
  const scenarios = await db.agentScenario.findMany({ where: { workerId }, select: { id: true, input: true } });
  let passed = 0;
  for (const s of scenarios) {
    const answer = runBuiltIn(profile.builtInKey as BuiltInAgentKey | null, (s.input as Record<string, unknown>) ?? {});
    if (!answer) throw new HttpError(409, 'agent_answers_itself', 'This agent answers its scenarios through /agent/v1/certification; the API cannot run it.');
    const run = await recordScenarioAnswer(db, workerId, s.id, answer, ranById, now);
    if (run.passed) passed += 1;
  }
  return { ran: scenarios.length, passed };
}

export async function certification(db: Db, workerId: string): Promise<AgentCertification> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, select: { modelVersion: true, certifiedAt: true, certifiedModelVersion: true, builtInKey: true } });
  if (!profile) throw new HttpError(404, 'agent_not_found', 'No such agent.');
  const scenarios = await listScenarios(db, workerId);
  const passing = scenarios.filter((s) => s.latest?.passed).length;
  return {
    modelVersion: profile.modelVersion,
    certifiedAt: profile.certifiedAt?.toISOString() ?? null,
    certifiedModelVersion: profile.certifiedModelVersion,
    current: profile.certifiedModelVersion === profile.modelVersion,
    scenarios: scenarios.length,
    passing,
    ready: scenarios.length > 0 && passing === scenarios.length,
    runnable: runBuiltIn(profile.builtInKey as BuiltInAgentKey | null, {}) !== null,
  };
}

/** Every scenario passing under the current version: the agent is certified and, if onboarding, becomes active. */
export async function certifyAgent(db: Db, workerId: string, actorUserId: string, now: Date = new Date()): Promise<AgentCertification> {
  const c = await certification(db, workerId);
  if (!c.ready) throw new HttpError(409, 'agent_not_certified', c.scenarios === 0 ? 'Add at least one scenario first.' : `${c.scenarios - c.passing} of ${c.scenarios} scenarios are not passing under version ${c.modelVersion}.`);
  await db.agentProfile.update({ where: { workerId }, data: { certifiedAt: now, certifiedModelVersion: c.modelVersion } });
  const worker = await db.worker.findUniqueOrThrow({ where: { id: workerId }, select: { status: true } });
  if (worker.status === 'ONBOARDING') await updateWorker(db, workerId, { status: 'ACTIVE' }, now);
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'agent.certified', entityType: 'Worker', entityId: workerId, metadata: { modelVersion: c.modelVersion, scenarios: c.scenarios, activated: worker.status === 'ONBOARDING' } }, 'agentControls');
  return certification(db, workerId);
}

/** A new model version: back to onboarding, credentials revoked, owner told. Called by updateAgent. */
export async function onModelVersionChanged(db: Db, workerId: string, from: string, to: string, actorUserId: string | null, now: Date = new Date()): Promise<void> {
  const profile = await db.agentProfile.findUnique({ where: { workerId }, include: { worker: { select: { name: true, status: true, ownerUserId: true } } } });
  if (!profile || profile.certifiedModelVersion === to) return;
  const revoked = await revokeAllCredentials(db, workerId, 'model version changed', now);
  if (profile.worker.status === 'ACTIVE') await db.worker.update({ where: { id: workerId }, data: { status: 'ONBOARDING' } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'agent.recertification_required', entityType: 'Worker', entityId: workerId, metadata: { from, to, revoked } }, 'agentControls');
  await notifyUser(profile.worker.ownerUserId, { subject: `${profile.worker.name} needs recertification`, body: `Model version ${from} → ${to}. The agent is back in onboarding until its scenarios pass under ${to}.`, category: AGENT_KILL_CATEGORY, linkUrl: `/agents?agent=${workerId}` });
}

// ---------------------------------------------------------------------------
// Scorecard and drift
// ---------------------------------------------------------------------------

const HUMAN_ACTIONS = new Set(['agent.approval.approved', 'agent.approval.rejected', 'agent.registered', 'agent.updated', 'agent.credential.issued', 'agent.credential.revoked', 'agent.spend.recorded', 'agent.suspended', 'agent.resumed', 'agent.scenario.added', 'agent.scenario.removed', 'agent.certified', 'agent.recertification_required', 'agent.drift_alert']);
const ESCALATIONS = new Set(['agent.request.filed', 'agent.message.gated', 'agent.export.gated']);
// Logged beside the call that filed it; counting both would double the task.
const NOT_TASKS = new Set(['agent.approval.requested']);

export async function scorecard(db: Db, workerId: string, days = 7, now: Date = new Date()): Promise<AgentScorecard> {
  const since = new Date(now.getTime() - days * DAY);
  const rows = await db.auditLog.findMany({ where: { workerId, createdAt: { gte: since } }, select: { action: true, actorUserId: true, metadata: true }, take: 20_000 });
  let tasks = 0;
  let errors = 0;
  let escalated = 0;
  for (const r of rows) {
    if (HUMAN_ACTIONS.has(r.action) || r.actorUserId) continue;
    if (r.action.startsWith('agent.scenario.') || NOT_TASKS.has(r.action)) continue;
    const meta = (r.metadata as Record<string, unknown> | null) ?? {};
    if (r.action === 'agent.denied' || (typeof meta.status === 'number' && meta.status >= 400)) {
      errors += 1;
      continue;
    }
    tasks += 1;
    if (ESCALATIONS.has(r.action) || meta.kind === 'HANDOFF') escalated += 1;
  }
  const [requested, rejected, spend] = await Promise.all([
    db.agentApprovalRequest.count({ where: { workerId, requestedAt: { gte: since } } }),
    db.agentApprovalRequest.count({ where: { workerId, status: 'REJECTED', decidedAt: { gte: since } } }),
    db.agentSpend.aggregate({ where: { workerId, occurredAt: { gte: since } }, _sum: { amountCents: true } }),
  ]);
  const spendCents = spend._sum.amountCents ?? 0;
  return {
    days,
    tasksCompleted: tasks,
    errors,
    errorRatePct: tasks + errors > 0 ? Math.round((errors * 100) / (tasks + errors)) : null,
    exceptionsEscalated: escalated,
    approvalsRequested: requested,
    approvalsRejected: rejected,
    spendCents,
    costPerTaskCents: tasks > 0 ? Math.round(spendCents / tasks) : null,
  };
}

/** At least this many calls before a rate means anything. */
const DRIFT_MIN_CALLS = 5;

/** One look at every active agent's week; the owner hears once a week at most. */
export async function sweepAgentDrift(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<{ alerted: string[] }> {
  const agents = await db.agentProfile.findMany({ where: { worker: { status: 'ACTIVE' } }, include: { worker: { select: { name: true, ownerUserId: true } } } });
  const alerted: string[] = [];
  for (const a of agents) {
    if (a.driftErrorRatePct == null && a.driftCostPerTaskCents == null) continue;
    if (a.lastDriftAlertAt && now.getTime() - a.lastDriftAlertAt.getTime() < 7 * DAY) continue;
    const s = await scorecard(db, a.workerId, 7, now);
    const reasons: string[] = [];
    if (a.driftErrorRatePct != null && s.errorRatePct != null && s.tasksCompleted + s.errors >= DRIFT_MIN_CALLS && s.errorRatePct > a.driftErrorRatePct) {
      reasons.push(`error rate ${s.errorRatePct}% over the ${a.driftErrorRatePct}% threshold`);
    }
    if (a.driftCostPerTaskCents != null && s.costPerTaskCents != null && s.tasksCompleted >= DRIFT_MIN_CALLS && s.costPerTaskCents > a.driftCostPerTaskCents) {
      reasons.push(`cost per task $${(s.costPerTaskCents / 100).toFixed(2)} over the $${(a.driftCostPerTaskCents / 100).toFixed(2)} threshold`);
    }
    if (!reasons.length) continue;
    await db.agentProfile.update({ where: { workerId: a.workerId }, data: { lastDriftAlertAt: now } });
    enqueueAudit({ actorUserId: null, clientId: null, workerId: a.workerId, action: 'agent.drift_alert', entityType: 'Worker', entityId: a.workerId, metadata: { reasons, scorecard: s as unknown as Prisma.InputJsonObject } }, 'agentControls');
    await notifyUser(a.worker.ownerUserId, { subject: `${a.worker.name} is drifting`, body: `Over the last seven days: ${reasons.join('; ')}. Review its trail and scorecard.`, category: AGENT_DRIFT_CATEGORY, linkUrl: `/agents?agent=${a.workerId}` });
    alerted.push(a.workerId);
  }
  return { alerted };
}

let driftTimer: NodeJS.Timeout | null = null;
const DRIFT_SWEEP_MS = 6 * 3_600_000;

export function startAgentDriftCron(): void {
  if (driftTimer) return;
  const run = () => tenantJob('agentControls', sweepAgentDrift)().catch((err) => console.error('[alto-people/api] agent drift sweep failed:', err));
  void run();
  driftTimer = setInterval(run, DRIFT_SWEEP_MS);
  driftTimer.unref();
}

export function stopAgentDriftCron(): void {
  if (driftTimer) clearInterval(driftTimer);
  driftTimer = null;
}
