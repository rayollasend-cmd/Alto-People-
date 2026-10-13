import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticateAgent, ensureBuiltInAgents, resetAgentRateLimits, ROTATION_GRACE_MS } from '../../lib/agents.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The agent registry (Brief 1D-2 acceptance).
 *
 *   Every existing agent appears in the registry with an owner and scopes;
 *   an unregistered credential cannot call the API; an agent attempting a
 *   gated action creates an approval request and does nothing until it is
 *   approved; the audit log holds a complete trail for a scripted session
 *   and cannot be edited.
 */

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const HOUR = 3_600_000;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const client = await createClient('Coastal Resort');
  const admin = await loginAs(agent(), hr.email);
  return { hr, client, admin };
}

async function registerAgent(admin: ReturnType<typeof agent>, ownerUserId: string, extra: Record<string, unknown> = {}) {
  const res = await admin.post('/agents').send({
    name: 'Scheduling helper',
    ownerUserId,
    purpose: 'Reads the week and drafts coverage notes',
    vendor: 'Anthropic',
    model: 'claude-fable-5-1',
    modelVersion: '5.1',
    scopes: ['view:scheduling', 'manage:communications'],
    status: 'ACTIVE',
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; profile: { scopes: string[] } };
}

async function issue(admin: ReturnType<typeof agent>, workerId: string, ttlHours = 24) {
  const res = await admin.post(`/agents/${workerId}/credentials`).send({ ttlHours });
  expect(res.status).toBe(201);
  expect(res.body.plaintext).toMatch(/^alto_agent_[0-9a-f]{64}$/);
  return res.body as { id: string; plaintext: string; last4: string; expiresAt: string };
}

describe('the registry', () => {
  it('registers the agents Alto already runs with an owner and scopes, and profiles any AGENT worker', async () => {
    const w = await world();
    const sweep = await ensureBuiltInAgents(prisma);
    expect(sweep.created.sort()).toEqual(['boardroom', 'claude-code-deploy', 'whatsapp-assistant']);
    expect(sweep.missing).toEqual([]);

    // An agent made through Workers (1D-1) shows up too, once profiled.
    const bare = await w.admin.post('/workers').send({ type: 'AGENT', name: 'Nightly digest bot', ownerUserId: w.hr.id });
    expect(bare.status).toBe(201);
    const again = await w.admin.post('/agents/ensure-built-in');
    expect(again.body).toMatchObject({ created: [], missing: [], profiled: 1 });

    const list = await w.admin.get('/agents');
    expect(list.status).toBe(200);
    expect(list.body.agents).toHaveLength(4);
    for (const a of list.body.agents) {
      expect(a.type).toBe('AGENT');
      expect(a.owner).toMatchObject({ id: w.hr.id });
      expect(Array.isArray(a.profile.scopes)).toBe(true);
    }
    const assistant = list.body.agents.find((a: { profile: { builtInKey: string | null } }) => a.profile.builtInKey === 'whatsapp-assistant');
    expect(assistant).toMatchObject({ status: 'ACTIVE', profile: { scopes: expect.arrayContaining(['manage:communications']) } });
    expect(list.body.builtInMissing).toEqual([]);

    // Scopes come from the catalog; anything else is refused.
    const bad = await w.admin.post('/agents').send({ name: 'Rogue', ownerUserId: w.hr.id, purpose: 'x y z', vendor: 'v', model: 'm', modelVersion: '1', scopes: ['manage:org'] });
    expect(bad.status).toBe(400);
    // And no agent without an owner.
    const unowned = await w.admin.post('/agents').send({ name: 'Nobody', purpose: 'x y z', vendor: 'v', model: 'm', modelVersion: '1' });
    expect(unowned.status).toBe(400);
  });

  it('is for people who manage the org', async () => {
    const w = await world();
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const me = await loginAs(agent(), assoc.email);
    expect((await me.get('/agents')).status).toBe(403);
    expect((await me.post('/agents').send({})).status).toBe(403);
    // Finance reads the registry (view:org) but does not manage the org.
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const viewer = await loginAs(agent(), fin.email);
    expect((await viewer.get('/agents')).status).toBe(200);
    expect((await viewer.post('/agents').send({})).status).toBe(403);
    expect((await w.admin.get('/agents/approvals')).status).toBe(200);
  });
});

describe('credentials', () => {
  it('an unregistered credential cannot call the API; a registered one can, until it is revoked, expired or its agent suspended', async () => {
    const w = await world();
    const a = await registerAgent(w.admin, w.hr.id);

    expect((await agent().get('/agent/v1/me')).status).toBe(401);
    const forged = `alto_agent_${'ab'.repeat(32)}`;
    expect((await agent().get('/agent/v1/me').set(bearer(forged))).status).toBe(401);
    // A session cookie is not an agent credential.
    expect((await w.admin.get('/agent/v1/me')).status).toBe(401);

    const cred = await issue(w.admin, a.id);
    const me = await agent().get('/agent/v1/me').set(bearer(cred.plaintext));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ workerId: a.id, name: 'Scheduling helper', scopes: ['view:scheduling', 'manage:communications'], credential: { id: cred.id } });
    // The plaintext is never stored.
    const stored = await prisma.agentCredential.findUniqueOrThrow({ where: { id: cred.id } });
    expect(stored.tokenHash).not.toContain(cred.plaintext.slice(11, 40));
    expect(stored.last4).toBe(cred.plaintext.slice(-4));

    // Expired: same token, two days on.
    const later = await authenticateAgent(prisma, cred.plaintext, new Date(Date.now() + 48 * HOUR));
    expect(later).toMatchObject({ ok: false, code: 'credential_expired' });

    // Suspended agent: the token is intact, the agent is not.
    await w.admin.patch(`/agents/${a.id}`).send({ status: 'SUSPENDED' });
    const suspended = await agent().get('/agent/v1/me').set(bearer(cred.plaintext));
    expect(suspended.status).toBe(401);
    expect(suspended.body.error.code).toBe('credential_revoked');
    const fresh = await authenticateAgent(prisma, (await (async () => {
      await w.admin.patch(`/agents/${a.id}`).send({ status: 'ACTIVE' });
      const c2 = await issue(w.admin, a.id);
      await w.admin.patch(`/agents/${a.id}`).send({ status: 'SUSPENDED' });
      await prisma.agentCredential.update({ where: { id: c2.id }, data: { revokedAt: null, revokedReason: null } });
      return c2;
    })()).plaintext);
    expect(fresh).toMatchObject({ ok: false, code: 'agent_not_active' });

    // Revoked by hand.
    await w.admin.patch(`/agents/${a.id}`).send({ status: 'ACTIVE' });
    const c3 = await issue(w.admin, a.id);
    expect((await agent().get('/agent/v1/me').set(bearer(c3.plaintext))).status).toBe(200);
    const revoke = await w.admin.post(`/agents/${a.id}/credentials/${c3.id}/revoke`).send({ reason: 'laptop lost' });
    expect(revoke.status).toBe(200);
    const after = await agent().get('/agent/v1/me').set(bearer(c3.plaintext));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('credential_revoked');

    await flushPendingAudits();
    const denied = await prisma.auditLog.findMany({ where: { workerId: a.id, action: 'agent.denied' } });
    expect(denied.map((d) => (d.metadata as { code: string }).code)).toEqual(expect.arrayContaining(['credential_revoked']));
  });

  it('rotates: the new credential works at once, the old one for five more minutes', async () => {
    const w = await world();
    const a = await registerAgent(w.admin, w.hr.id);
    const cred = await issue(w.admin, a.id, 12);
    const rotated = await agent().post('/agent/v1/credentials/rotate').set(bearer(cred.plaintext));
    expect(rotated.status).toBe(201);
    expect(rotated.body.plaintext).toMatch(/^alto_agent_/);
    expect(rotated.body.plaintext).not.toBe(cred.plaintext);
    expect((await agent().get('/agent/v1/me').set(bearer(rotated.body.plaintext))).status).toBe(200);
    expect((await agent().get('/agent/v1/me').set(bearer(cred.plaintext))).status).toBe(200);
    const past = await authenticateAgent(prisma, cred.plaintext, new Date(Date.now() + ROTATION_GRACE_MS + 60_000));
    expect(past).toMatchObject({ ok: false, code: 'credential_revoked' });
    const twice = await agent().post('/agent/v1/credentials/rotate').set(bearer(cred.plaintext));
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('credential_rotating');
    const row = await prisma.agentCredential.findUniqueOrThrow({ where: { id: rotated.body.id } });
    expect(row.rotatedFromId).toBe(cred.id);
    expect(row.issuedById).toBeNull();
    expect(row.expiresAt.getTime() - row.issuedAt.getTime()).toBe(12 * HOUR);
  });

  it('holds the agent to its scopes, hours, spend cap and rate limit', async () => {
    const w = await world();
    const a = await registerAgent(w.admin, w.hr.id, { scopes: [], rateLimitPerMinute: 1, spendCapCents: 500 });
    const cred = await issue(w.admin, a.id);

    const noScope = await agent().get(`/agent/v1/schedule?clientId=${w.client.id}`).set(bearer(cred.plaintext));
    expect(noScope.status).toBe(403);
    expect(noScope.body.error.code).toBe('agent_scope_missing');
    await w.admin.patch(`/agents/${a.id}`).send({ scopes: ['view:scheduling'] });
    const read = await agent().get(`/agent/v1/schedule?clientId=${w.client.id}`).set(bearer(cred.plaintext));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ clientId: w.client.id, count: 0 });

    // One call a minute: the schedule read was it (a refused call takes no token).
    const limited = await agent().get('/agent/v1/me').set(bearer(cred.plaintext));
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    resetAgentRateLimits();

    // Spend: the cap closes the door.
    const spent = await agent().post('/agent/v1/spend').set(bearer(cred.plaintext)).send({ amountCents: 500, taskRef: 'week-41-notes' });
    expect(spent.status).toBe(201);
    expect(spent.body.spendThisMonthCents).toBe(500);
    const capped = await agent().get('/agent/v1/me').set(bearer(cred.plaintext));
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe('agent_spend_cap');
    await w.admin.patch(`/agents/${a.id}`).send({ spendCapCents: null, allowedHoursStart: 9, allowedHoursEnd: 17 });

    // Hours: three in the morning, org time, is outside 9–17.
    const threeAm = new Date();
    threeAm.setUTCHours(8, 0, 0, 0); // 03:00 or 04:00 in Florida, either way before nine
    const night = await authenticateAgent(prisma, cred.plaintext, threeAm);
    expect(night).toMatchObject({ ok: false, code: 'agent_outside_hours' });
    const noon = new Date();
    noon.setUTCHours(17, 0, 0, 0); // 12:00 or 13:00 in Florida
    expect((await authenticateAgent(prisma, cred.plaintext, noon)).ok).toBe(true);
  });
});

describe('approval gates', () => {
  async function threads(w: Awaited<ReturnType<typeof world>>) {
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: w.client.id });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const store = await prisma.conversation.create({
      data: { kind: 'GROUP', clientId: w.client.id, title: 'Coastal Resort', participants: { create: [{ userId: portal.id }, { userId: w.hr.id }] } },
    });
    const internal = await prisma.conversation.create({
      data: { kind: 'DIRECT', participants: { create: [{ userId: wfm.id }, { userId: w.hr.id }] } },
    });
    return { portal, wfm, store, internal };
  }

  it('a message to a client is requested, waits, is approved by a person, then goes out exactly once', async () => {
    const w = await world();
    const t = await threads(w);
    const a = await registerAgent(w.admin, w.hr.id);
    const cred = await issue(w.admin, a.id);
    const api = () => agent().set(bearer(cred.plaintext));

    // Internal thread: no gate.
    const internal = await agent().post('/agent/v1/messages').set(bearer(cred.plaintext)).send({ conversationId: t.internal.id, body: 'Coverage notes for Saturday are ready.' });
    expect(internal.status).toBe(201);
    expect(internal.body.approvalId).toBeNull();

    // Client thread: gated.
    const body = 'Tomorrow 14 associates are scheduled for the 6am unload.';
    const asked = await api().post('/agent/v1/messages').send({ conversationId: t.store.id, body });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING', created: true });
    const approvalId = asked.body.approvalId as string;
    expect(await prisma.message.count({ where: { conversationId: t.store.id } })).toBe(0);
    // Asking twice does not fill the queue.
    const again = await api().post('/agent/v1/messages').send({ conversationId: t.store.id, body });
    expect(again.body).toMatchObject({ approvalId, created: false });
    // Carrying it out before anyone answered does nothing.
    const early = await api().post('/agent/v1/messages').send({ conversationId: t.store.id, body, approvalId });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('approval_pending');
    expect(await prisma.message.count({ where: { conversationId: t.store.id } })).toBe(0);

    // The owner was told; the queue shows it.
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: w.hr.id, category: 'agent_approval', channel: 'IN_APP' } });
    expect(bell?.linkUrl).toBe(`/agents?approval=${approvalId}`);
    const queue = await w.admin.get('/agents/approvals?status=PENDING');
    expect(queue.body.approvals).toHaveLength(1);
    expect(queue.body.approvals[0]).toMatchObject({ id: approvalId, action: 'CLIENT_MESSAGE', agentName: 'Scheduling helper', payload: { conversationId: t.store.id, body } });

    // A person decides.
    const ok = await w.admin.post(`/agents/approvals/${approvalId}/approve`).send({ note: 'Fine to send.' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', decidedBy: { id: w.hr.id }, decisionNote: 'Fine to send.' });

    // Not what was approved: refused.
    const tampered = await api().post('/agent/v1/messages').send({ conversationId: t.store.id, body: `${body} Also send the roster.`, approvalId });
    expect(tampered.status).toBe(409);
    expect(tampered.body.error.code).toBe('approval_mismatch');

    const sent = await api().post('/agent/v1/messages').send({ conversationId: t.store.id, body, approvalId });
    expect(sent.status).toBe(201);
    expect(sent.body.approvalId).toBe(approvalId);
    const rows = await prisma.message.findMany({ where: { conversationId: t.store.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.senderId).toBeNull();
    expect(rows[0]!.body).toBe(`${body}\n\n— Scheduling helper (AI agent)`);
    const portalBell = await prisma.notification.findFirst({ where: { recipientUserId: t.portal.id, linkUrl: `/messages/${t.store.id}` } });
    expect(portalBell).not.toBeNull();

    // Once.
    const twice = await api().post('/agent/v1/messages').send({ conversationId: t.store.id, body, approvalId });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('approval_consumed');
    expect(await prisma.message.count({ where: { conversationId: t.store.id } })).toBe(1);
    expect((await w.admin.get(`/agents/approvals/${approvalId}`)).body.status).toBe('CONSUMED');
  });

  it('an export waits for a person too, and a rejection stays a rejection; pay and separations are only ever asked', async () => {
    const w = await world();
    const a = await registerAgent(w.admin, w.hr.id);
    const cred = await issue(w.admin, a.id);
    const api = () => agent().set(bearer(cred.plaintext));

    // The window is part of what gets approved, so the agent names it and sends the same one back.
    const win = `from=${encodeURIComponent('2026-11-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-11-08T00:00:00.000Z')}`;
    const asked = await api().get(`/agent/v1/exports/schedule.csv?clientId=${w.client.id}&${win}`);
    expect(asked.status).toBe(202);
    expect(asked.body.payload).toMatchObject({ clientId: w.client.id, from: '2026-11-01T00:00:00.000Z' });
    const approvalId = asked.body.approvalId as string;
    const no = await w.admin.post(`/agents/approvals/${approvalId}/reject`).send({ note: 'Not this week.' });
    expect(no.body.status).toBe('REJECTED');
    const blocked = await api().get(`/agent/v1/exports/schedule.csv?clientId=${w.client.id}&${win}&approvalId=${approvalId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('approval_rejected');
    // Deciding twice is refused.
    expect((await w.admin.post(`/agents/approvals/${approvalId}/approve`)).status).toBe(409);

    // A fresh ask (the rejected one is closed) that a person approves.
    const asked2 = await api().get(`/agent/v1/exports/schedule.csv?clientId=${w.client.id}&${win}`);
    expect(asked2.status).toBe(202);
    expect(asked2.body.approvalId).not.toBe(approvalId);
    await w.admin.post(`/agents/approvals/${asked2.body.approvalId}/approve`);
    const csv = await api().get(`/agent/v1/exports/schedule.csv?clientId=${w.client.id}&${win}&approvalId=${asked2.body.approvalId}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toBe('shiftId,position,location,startsAt,endsAt,status,assignee,workerType');

    const pay = await api().post('/agent/v1/requests').send({ action: 'PAY_CHANGE', summary: 'Raise Ana Lopez to $16/hr from Nov 1', payload: { associateId: 'n/a', rate: 16 } });
    expect(pay.status).toBe(202);
    expect(pay.body.executable).toBe(false);
    await w.admin.post(`/agents/approvals/${pay.body.approvalId}/approve`).send({ note: 'Done in Comp.' });
    const status = await api().get(`/agent/v1/requests/${pay.body.approvalId}`);
    expect(status.body).toMatchObject({ status: 'APPROVED', decisionNote: 'Done in Comp.' });
    // Another agent cannot see it.
    const b = await registerAgent(w.admin, w.hr.id, { name: 'Other helper' });
    const other = await issue(w.admin, b.id);
    expect((await agent().get(`/agent/v1/requests/${pay.body.approvalId}`).set(bearer(other.plaintext))).status).toBe(404);
  });
});

describe('the trail', () => {
  it('holds every call of a scripted session, with scope, target and approval, and cannot be edited', async () => {
    const w = await world();
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: w.client.id });
    const store = await prisma.conversation.create({ data: { kind: 'GROUP', clientId: w.client.id, title: 'Coastal Resort', participants: { create: [{ userId: portal.id }] } } });
    const a = await registerAgent(w.admin, w.hr.id);
    const cred = await issue(w.admin, a.id);
    const api = () => agent().set(bearer(cred.plaintext));

    // The script.
    await api().get('/agent/v1/me');
    await api().get(`/agent/v1/schedule?clientId=${w.client.id}`);
    const body = 'Heads-up: the 6am unload is fully staffed.';
    const asked = await api().post('/agent/v1/messages').send({ conversationId: store.id, body });
    const approvalId = asked.body.approvalId as string;
    await w.admin.post(`/agents/approvals/${approvalId}/approve`);
    await api().post('/agent/v1/messages').send({ conversationId: store.id, body, approvalId });
    await api().get('/agent/v1/reports/executive-summary'); // no scope: refused, and that is on the trail too
    await flushPendingAudits();

    const trail = await prisma.auditLog.findMany({ where: { workerId: a.id }, orderBy: { createdAt: 'asc' } });
    const actions = trail.map((t) => t.action);
    expect(actions).toEqual(
      expect.arrayContaining(['agent.registered', 'agent.credential.issued', 'agent.me', 'agent.schedule.read', 'agent.approval.requested', 'agent.message.gated', 'agent.approval.approved', 'agent.message.sent', 'agent.denied']),
    );
    const read = trail.find((t) => t.action === 'agent.schedule.read')!;
    expect(read.metadata).toMatchObject({ scopes: ['view:scheduling'], status: 200, credentialId: cred.id });
    expect(read.entityType).toBe('Client');
    expect(read.entityId).toBe(w.client.id);
    const sent = trail.find((t) => t.action === 'agent.message.sent')!;
    expect(sent.metadata).toMatchObject({ approvalId });
    expect(sent.entityType).toBe('Message');
    const approved = trail.find((t) => t.action === 'agent.approval.approved')!;
    expect(approved.actorUserId).toBe(w.hr.id);
    const denied = trail.find((t) => t.action === 'agent.denied')!;
    expect(denied.metadata).toMatchObject({ code: 'agent_scope_missing', scope: 'view:analytics' });

    // The page shows it.
    const detail = await w.admin.get(`/agents/${a.id}`);
    expect(detail.body.trail.map((t: { action: string }) => t.action)).toEqual(expect.arrayContaining(['agent.message.sent', 'agent.approval.approved']));
    expect(detail.body.approvals[0]).toMatchObject({ id: approvalId, status: 'CONSUMED' });

    // And nobody can change it — not through the client, not with raw SQL.
    await expect(prisma.auditLog.update({ where: { id: sent.id }, data: { action: 'agent.nothing' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.update({ where: { id: sent.id }, data: { metadata: {} } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: sent.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE "AuditLog" SET "workerId" = NULL WHERE "id" = ${sent.id}::uuid`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "workerId" = ${a.id}::uuid`).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { workerId: a.id } })).toBe(trail.length);
    // The one permitted change: the actor reference clearing when the account goes (ON DELETE SET NULL).
    await expect(prisma.auditLog.update({ where: { id: approved.id }, data: { actorUserId: null } })).resolves.toBeTruthy();
  });

  it('the WhatsApp assistant logs its replies under its registry record', async () => {
    await createUser({ role: 'HR_ADMINISTRATOR' });
    await ensureBuiltInAgents(prisma);
    const { logBuiltInAgentAction, builtInAgentId } = await import('../../lib/agents.js');
    await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.whatsapp.reply', entityType: 'WhatsAppMessage', entityId: 'm1', metadata: { intent: 'PAYDAY' } });
    await flushPendingAudits();
    const id = await builtInAgentId(prisma, 'whatsapp-assistant');
    const rows = await prisma.auditLog.findMany({ where: { workerId: id! } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ builtIn: 'whatsapp-assistant', intent: 'PAYDAY' });
  });
});
