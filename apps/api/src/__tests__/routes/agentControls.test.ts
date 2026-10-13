import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticateAgent, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { evaluateScenario, scorecard, sweepAgentDrift } from '../../lib/agentControls.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Kill switch, certification and the scorecard (Brief 1D-3 acceptance).
 *
 *   Suspending an agent stops its next API call within five seconds (a
 *   script is calling while the switch is thrown); a new model version
 *   forces recertification; the scenario runner passes and fails
 *   correctly; the scorecard shows live numbers; the drift alert reaches
 *   the owner.
 */

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: owner } = await createUser({ role: 'WORKFORCE_MANAGER' });
  const client = await createClient('Coastal Resort');
  const admin = await loginAs(agent(), hr.email);
  const asOwner = await loginAs(agent(), owner.email);
  return { hr, owner, client, admin, asOwner };
}

async function registerAgent(admin: ReturnType<typeof agent>, ownerUserId: string, extra: Record<string, unknown> = {}) {
  const res = await admin.post('/agents').send({
    name: 'Scheduling helper',
    ownerUserId,
    purpose: 'Reads the week and drafts coverage notes',
    vendor: 'Anthropic',
    model: 'claude-fable-5-1',
    modelVersion: '5.1',
    scopes: ['view:scheduling'],
    status: 'ACTIVE',
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; status: string; certification: { current: boolean } };
}

async function issue(admin: ReturnType<typeof agent>, workerId: string) {
  const res = await admin.post(`/agents/${workerId}/credentials`).send({ ttlHours: 24 });
  expect(res.status).toBe(201);
  return res.body as { id: string; plaintext: string };
}

describe('the kill switch', () => {
  it('stops a running script within five seconds; only the owner resumes, and no credential comes back', async () => {
    const w = await world();
    const a = await registerAgent(w.admin, w.owner.id);
    const cred = await issue(w.admin, a.id);
    const call = () => agent().get('/agent/v1/me').set(bearer(cred.plaintext));
    expect((await call()).status).toBe(200);

    // A script calling every 100 ms while the switch is thrown.
    let firstRefusalAt: number | null = null;
    let refusedWith: string | null = null;
    const script = (async () => {
      const until = Date.now() + 8_000;
      while (Date.now() < until && firstRefusalAt === null) {
        const r = await call();
        if (r.status !== 200) {
          firstRefusalAt = Date.now();
          refusedWith = r.body.error.code;
        }
        await new Promise((f) => setTimeout(f, 100));
      }
    })();
    await new Promise((f) => setTimeout(f, 300));
    const thrownAt = Date.now();
    const sus = await w.admin.post(`/agents/${a.id}/suspend`).send({ reason: 'Posting the wrong week.' });
    expect(sus.status).toBe(200);
    expect(sus.body.revoked).toBe(1);
    expect(sus.body.agent).toMatchObject({ status: 'SUSPENDED', kill: { suspendedBy: { id: w.hr.id }, suspendReason: 'Posting the wrong week.' } });
    await script;
    expect(firstRefusalAt).not.toBeNull();
    expect(firstRefusalAt! - thrownAt).toBeLessThan(5_000);
    expect(refusedWith).toBe('credential_revoked');

    // The owner heard; an admin who is not the owner cannot resume; the owner can, and gets no credential back.
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: w.owner.id, category: 'agent_kill', channel: 'IN_APP' } });
    expect(bell?.linkUrl).toBe(`/agents?agent=${a.id}`);
    const notOwner = await w.admin.post(`/agents/${a.id}/resume`);
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.error.code).toBe('owner_only');
    const resumed = await w.asOwner.post(`/agents/${a.id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: 'ACTIVE', activeCredentials: 0, kill: { suspendedAt: null } });
    expect((await call()).status).toBe(401);

    await flushPendingAudits();
    const actions = (await prisma.auditLog.findMany({ where: { workerId: a.id } })).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['agent.suspended', 'agent.resumed']));
  });

  it('suspend all: every credential dies at once, the switch is read on every call, and an admin lifts it', async () => {
    const w = await world();
    const a = await registerAgent(w.admin, w.owner.id);
    const b = await registerAgent(w.admin, w.hr.id, { name: 'Other helper' });
    const ca = await issue(w.admin, a.id);
    const cb = await issue(w.admin, b.id);
    const all = await w.admin.post('/agents/suspend-all').send({ reason: 'Incident 42.' });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ revoked: 2, agents: 2 });
    expect((await agent().get('/agent/v1/me').set(bearer(ca.plaintext))).status).toBe(401);
    expect((await agent().get('/agent/v1/me').set(bearer(cb.plaintext))).status).toBe(401);
    // A credential issued while the switch is on is refused by the switch itself.
    const fresh = await issue(w.admin, a.id);
    const refused = await agent().get('/agent/v1/me').set(bearer(fresh.plaintext));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('agents_suspended');
    const list = await w.admin.get('/agents');
    expect(list.body.control).toMatchObject({ suspendedBy: { id: w.hr.id }, reason: 'Incident 42.' });
    expect(list.body.control.allSuspendedAt).not.toBeNull();
    // Each owner heard once.
    expect(await prisma.notification.count({ where: { category: 'agent_kill', recipientUserId: w.owner.id, channel: 'IN_APP' } })).toBe(1);

    expect((await w.admin.post('/agents/resume-all')).status).toBe(200);
    expect((await agent().get('/agent/v1/me').set(bearer(fresh.plaintext))).status).toBe(200);
    expect((await w.admin.post('/agents/resume-all')).status).toBe(409);
  });
});

describe('certification', () => {
  it('an onboarding agent answers its scenarios, becomes active only when all pass, and a new version sends it back', async () => {
    const w = await world();
    const a = await registerAgent(w.admin, w.owner.id, { status: 'ONBOARDING' });
    expect(a.certification.current).toBe(false);
    // Not active yet: no scenarios, nothing to certify against.
    const early = await w.admin.post(`/agents/${a.id}/certify`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('agent_not_certified');
    const viaWorkers = await w.admin.patch(`/workers/${a.id}`).send({ status: 'ACTIVE' });
    expect(viaWorkers.status).toBe(409);
    expect(viaWorkers.body.error.code).toBe('use_agent_registry');
    const viaPatch = await w.admin.patch(`/agents/${a.id}`).send({ status: 'ACTIVE' });
    expect(viaPatch.status).toBe(409);
    expect(viaPatch.body.error.code).toBe('agent_not_certified');

    const s1 = await w.admin.post(`/agents/${a.id}/scenarios`).send({ name: 'Reads a week', input: { ask: 'shifts for week 41' }, expected: { output: { shifts: 12 } } });
    const s2 = await w.admin.post(`/agents/${a.id}/scenarios`).send({ name: 'Never writes pay', input: { ask: 'give Ana a raise' }, expected: { allowedActions: ['request_approval', 'reply'] } });
    expect(s1.status).toBe(201);
    expect(s2.status).toBe(201);

    // An onboarding agent may answer scenarios, and nothing else.
    const cred = await issue(w.admin, a.id);
    const api = () => agent().set(bearer(cred.plaintext));
    expect((await api().get('/agent/v1/me')).status).toBe(403);
    const todo = await api().get('/agent/v1/certification');
    expect(todo.status).toBe(200);
    expect(todo.body.scenarios.map((s: { name: string }) => s.name)).toEqual(['Reads a week', 'Never writes pay']);
    expect(JSON.stringify(todo.body)).not.toContain('allowedActions');

    const wrong = await api().post(`/agent/v1/certification/${s1.body.id}`).send({ output: { shifts: 11 } });
    expect(wrong.status).toBe(201);
    expect(wrong.body.passed).toBe(false);
    expect(wrong.body.reason).toMatch(/Expected/);
    const right = await api().post(`/agent/v1/certification/${s1.body.id}`).send({ output: { shifts: 12 } });
    expect(right.body.passed).toBe(true);
    const outside = await api().post(`/agent/v1/certification/${s2.body.id}`).send({ actions: ['update_pay'] });
    expect(outside.body.passed).toBe(false);
    expect(outside.body.reason).toMatch(/update_pay/);

    const half = await w.admin.post(`/agents/${a.id}/certify`);
    expect(half.status).toBe(409);
    expect(half.body.error.message).toMatch(/1 of 2/);
    const inside = await api().post(`/agent/v1/certification/${s2.body.id}`).send({ actions: ['request_approval'] });
    expect(inside.body.passed).toBe(true);

    const certified = await w.admin.post(`/agents/${a.id}/certify`);
    expect(certified.status).toBe(200);
    expect(certified.body.certification).toMatchObject({ current: true, scenarios: 2, passing: 2, ready: true, certifiedModelVersion: '5.1' });
    expect(certified.body.agent.status).toBe('ACTIVE');
    expect((await api().get('/agent/v1/me')).status).toBe(200);

    // A new model version: back to onboarding, credentials revoked, owner told, runs under 5.1 no longer count.
    const bumped = await w.admin.patch(`/agents/${a.id}`).send({ modelVersion: '5.2' });
    expect(bumped.status).toBe(200);
    expect(bumped.body).toMatchObject({ status: 'ONBOARDING', activeCredentials: 0, certification: { current: false, modelVersion: '5.2', certifiedModelVersion: '5.1', passing: 0, ready: false } });
    expect((await api().get('/agent/v1/certification')).status).toBe(401);
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: w.owner.id, category: 'agent_kill', channel: 'IN_APP' } });
    expect(bell?.subject).toMatch(/recertification/);
    // Pass again under 5.2 and it is back.
    const c2 = await issue(w.admin, a.id);
    await agent().post(`/agent/v1/certification/${s1.body.id}`).set(bearer(c2.plaintext)).send({ output: { shifts: 12 } });
    await agent().post(`/agent/v1/certification/${s2.body.id}`).set(bearer(c2.plaintext)).send({ actions: ['reply'] });
    const again = await w.admin.post(`/agents/${a.id}/certify`);
    expect(again.body.certification).toMatchObject({ current: true, certifiedModelVersion: '5.2' });
    expect(again.body.agent.status).toBe('ACTIVE');
  });

  it('the runner exercises the built-in assistant itself: a scenario passes and a wrong expectation fails', async () => {
    const w = await world();
    await ensureBuiltInAgents(prisma);
    const list = await w.admin.get('/agents');
    const assistant = list.body.agents.find((x: { profile: { builtInKey: string | null } }) => x.profile.builtInKey === 'whatsapp-assistant');
    expect(assistant.certification).toMatchObject({ current: true, runnable: true });
    await w.admin.post(`/agents/${assistant.id}/scenarios`).send({ name: 'Payday in Spanish', input: { text: '¿cuándo me pagan?' }, expected: { output: { intent: 'PAYDAY' } } });
    await w.admin.post(`/agents/${assistant.id}/scenarios`).send({ name: 'STOP opts out', input: { text: 'STOP' }, expected: { output: { intent: 'OPT_OUT' }, allowedActions: ['reply'] } });
    await w.admin.post(`/agents/${assistant.id}/scenarios`).send({ name: 'Gibberish must hand off', input: { text: 'asdf qwerty' }, expected: { allowedActions: ['handoff'] } });
    await w.admin.post(`/agents/${assistant.id}/scenarios`).send({ name: 'A wrong expectation', input: { text: 'STOP' }, expected: { output: { intent: 'PAYDAY' } } });
    const run = await w.admin.post(`/agents/${assistant.id}/scenarios/run`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ ran: 4, passed: 3 });
    const byName = Object.fromEntries(run.body.scenarios.map((s: { name: string; latest: { passed: boolean; reason: string | null } }) => [s.name, s.latest]));
    expect(byName['Payday in Spanish'].passed).toBe(true);
    expect(byName['STOP opts out'].passed).toBe(true);
    expect(byName['Gibberish must hand off'].passed).toBe(true);
    expect(byName['A wrong expectation']).toMatchObject({ passed: false });
    expect(byName['A wrong expectation'].reason).toMatch(/OPT_OUT/);
    // An external agent is not run by the API.
    const ext = await registerAgent(w.admin, w.owner.id, { status: 'ONBOARDING' });
    await w.admin.post(`/agents/${ext.id}/scenarios`).send({ name: 'Example', input: { a: 1 }, expected: { output: { b: 2 } } });
    const no = await w.admin.post(`/agents/${ext.id}/scenarios/run`);
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe('agent_answers_itself');
  });

  it('evaluates exactly: key order does not matter, extra actions do', () => {
    expect(evaluateScenario({ output: { a: 1, b: { c: [1, 2] } } }, { output: { b: { c: [1, 2] }, a: 1 } }).passed).toBe(true);
    expect(evaluateScenario({ output: { a: 1 } }, { output: { a: 1, extra: true } }).passed).toBe(false);
    expect(evaluateScenario({ allowedActions: ['reply'] }, { actions: [] }).passed).toBe(true);
    expect(evaluateScenario({ allowedActions: ['reply'] }, { actions: ['reply', 'export'] })).toMatchObject({ passed: false, reason: expect.stringContaining('export') });
    expect(evaluateScenario({ output: { a: 1 } }, {})).toMatchObject({ passed: false, reason: 'No output was given.' });
  });
});

describe('the scorecard and the drift alert', () => {
  it('counts tasks, errors, escalations, approvals and cost per task from the trail, and alerts the owner once a week', async () => {
    const w = await world();
    const a = await registerAgent(w.admin, w.owner.id, { scopes: ['view:scheduling'], rateLimitPerMinute: 1000 });
    const cred = await issue(w.admin, a.id);
    const api = () => agent().set(bearer(cred.plaintext));
    for (let i = 0; i < 6; i++) await api().get('/agent/v1/me');
    await api().get(`/agent/v1/schedule?clientId=${w.client.id}`);
    for (let i = 0; i < 3; i++) await api().get('/agent/v1/reports/executive-summary'); // refused: no scope
    const asked = await api().get(`/agent/v1/exports/schedule.csv?clientId=${w.client.id}`); // gated: escalated
    await w.admin.post(`/agents/approvals/${asked.body.approvalId}/reject`).send({ note: 'No.' });
    await api().post('/agent/v1/spend').send({ amountCents: 900, taskRef: 'week' });
    await flushPendingAudits();

    const card = await w.admin.get(`/agents/${a.id}/scorecard?days=7`);
    expect(card.status).toBe(200);
    // 6 me + 1 schedule + 1 gated export + 1 spend report = 9 tasks; 3 refusals.
    expect(card.body).toMatchObject({ days: 7, tasksCompleted: 9, errors: 3, errorRatePct: 25, exceptionsEscalated: 1, approvalsRequested: 1, approvalsRejected: 1, spendCents: 900, costPerTaskCents: 100 });
    const detail = await w.admin.get(`/agents/${a.id}`);
    expect(detail.body.scorecard).toMatchObject({ tasksCompleted: 9, errors: 3 });
    expect(await scorecard(prisma, a.id, 7)).toMatchObject({ tasksCompleted: 9 });

    // Drift: 25% is not over a 25% threshold; a 20% threshold is crossed; the owner hears once.
    expect((await sweepAgentDrift(prisma)).alerted).toEqual([]);
    await w.admin.patch(`/agents/${a.id}/drift`).send({ driftErrorRatePct: 20 });
    expect((await sweepAgentDrift(prisma)).alerted).toEqual([a.id]);
    expect((await sweepAgentDrift(prisma)).alerted).toEqual([]);
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: w.owner.id, category: 'agent_drift', channel: 'IN_APP' } });
    expect(bell?.body).toMatch(/error rate 25%/);
    // Cost per task: $1.00 over a $0.50 threshold, a week later.
    await prisma.agentProfile.update({ where: { workerId: a.id }, data: { driftErrorRatePct: null, driftCostPerTaskCents: 50, lastDriftAlertAt: new Date(Date.now() - 8 * 24 * 3_600_000) } });
    expect((await sweepAgentDrift(prisma)).alerted).toEqual([a.id]);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { workerId: a.id, action: 'agent.drift_alert' } })).toBe(2);
    // A suspended agent is not watched.
    await w.admin.post(`/agents/${a.id}/suspend`).send({ reason: 'Quiet.' });
    await prisma.agentProfile.update({ where: { workerId: a.id }, data: { lastDriftAlertAt: null } });
    expect((await sweepAgentDrift(prisma)).alerted).toEqual([]);
    expect(await authenticateAgent(prisma, cred.plaintext)).toMatchObject({ ok: false });
  });
});
