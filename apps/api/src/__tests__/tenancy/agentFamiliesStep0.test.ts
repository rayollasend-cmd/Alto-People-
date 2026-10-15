import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilitiesFor, capabilityScenarios, defaultTenantProfile, type CapabilityScenarioFixture } from '@alto-people/shared';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { BUILT_IN_AGENTS, builtInAgentId, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { grantCapability, registerCapabilityRunner, runCapabilityFixture, unregisterCapabilityRunnerForTests, type CapabilityFixtureContext } from '../../lib/agentCapabilities.js';
import { runForEachTenant } from '../../lib/tenantJobs.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * Agent families step 0 (docs/agent-families-investigation.md §8.5, tests 2 to 6).
 *
 *   The tenant's kill switch stops its own agents and no one else's; the
 *   platform switch stops everyone's and is the operator tenant's alone.
 *   Built-in agents exist once per tenant, owned there; a duplicate is
 *   refused by the partial index. A capability has its own scorecard and
 *   switch. The fixture runner seeds a world into a throwaway tenant, runs
 *   a capability with `now` fixed and removes the world. Capabilities follow
 *   the tenant's modules.
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

async function tenantTwoAdmin() {
  await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await prisma.user.update({ where: { id: user.id }, data: { tenantId: T2 } });
  return { user, admin: await loginAs(agent(), user.email) };
}

async function registerAgent(admin: ReturnType<typeof agent>, ownerUserId: string, name: string, scopes: string[] = ['view:scheduling']) {
  const res = await admin.post('/agents').send({ name, ownerUserId, purpose: 'Reads the week', vendor: 'Anthropic', model: 'claude', modelVersion: '1', scopes, status: 'ACTIVE' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string };
}

async function issue(admin: ReturnType<typeof agent>, workerId: string) {
  const res = await admin.post(`/agents/${workerId}/credentials`).send({ ttlHours: 24 });
  expect(res.status).toBe(201);
  return res.body as { plaintext: string };
}

const me = (token: string) => agent().get('/agent/v1/me').set(bearer(token));

describe('the kill switch per tenant (test 2)', () => {
  it("a tenant's switch stops its own agents and leaves the other's running; the platform switch stops both and is the operator's alone", async () => {
    const { user: altoHr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const alto = await loginAs(agent(), altoHr.email);
    const two = await tenantTwoAdmin();
    const a = await registerAgent(alto, altoHr.id, 'Alto helper');
    const b = await registerAgent(two.admin, two.user.id, 'Hotel helper');
    expect((await prisma.worker.findUniqueOrThrow({ where: { id: b.id } })).tenantId).toBe(T2);
    const ca = await issue(alto, a.id);
    const cb = await issue(two.admin, b.id);

    const off = await two.admin.post('/agents/suspend-all').send({ reason: 'Hotel incident.' });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ revoked: 1, agents: 1 });
    expect((await me(cb.plaintext)).status).toBe(401);
    expect((await me(ca.plaintext)).status).toBe(200);
    const fresh = await issue(two.admin, b.id);
    const refused = await me(fresh.plaintext);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('agents_suspended');
    // Each organization sees its own switch.
    expect((await alto.get('/agents')).body.control.allSuspendedAt).toBeNull();
    expect((await two.admin.get('/agents')).body.control.reason).toBe('Hotel incident.');
    // Alto's admin cannot lift the hotel's switch: its own is not set.
    expect((await alto.post('/agents/resume-all')).status).toBe(409);
    expect((await two.admin.post('/agents/resume-all')).status).toBe(200);
    expect((await me(fresh.plaintext)).status).toBe(200);

    // The platform switch: the operator's alone.
    expect((await two.admin.post('/agents/platform/suspend-all').send({ reason: 'Not yours.' })).status).toBe(404);
    expect((await alto.post('/agents/platform/suspend-all').send({ reason: 'Platform incident.' })).status).toBe(200);
    const a2 = await issue(alto, a.id);
    const b2 = await issue(two.admin, b.id);
    expect((await me(a2.plaintext)).body.error.code).toBe('agents_suspended');
    expect((await me(b2.plaintext)).body.error.code).toBe('agents_suspended');
    expect((await alto.post('/agents/platform/resume-all')).status).toBe(200);
    expect((await me(a2.plaintext)).status).toBe(200);
    expect((await me(b2.plaintext)).status).toBe(200);
  });

  it('the registry is per tenant: lists, the queue count and every /agents/:id route', async () => {
    const { user: altoHr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const alto = await loginAs(agent(), altoHr.email);
    const two = await tenantTwoAdmin();
    const a = await registerAgent(alto, altoHr.id, 'Alto helper');
    await registerAgent(two.admin, two.user.id, 'Hotel helper');
    const list = await two.admin.get('/agents');
    expect(list.body.agents.map((x: { name: string }) => x.name)).toEqual(['Hotel helper']);
    expect((await two.admin.get(`/agents/${a.id}`)).status).toBe(404);
    expect((await two.admin.get(`/agents/${a.id}/capabilities`)).status).toBe(404);
    expect((await two.admin.post(`/agents/${a.id}/suspend`).send({ reason: 'Not yours.' })).status).toBe(404);
    expect((await prisma.worker.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('ACTIVE');
  });
});

describe('built-in agents per tenant (test 3)', () => {
  it('one of each per tenant, owned by that tenant’s admin; a second run creates none; a duplicate is refused', async () => {
    const { user: altoHr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const two = await tenantTwoAdmin();
    await runForEachTenant('agents', (tenantId) => ensureBuiltInAgents(prisma, tenantId));
    const assistants = await prisma.agentProfile.findMany({ where: { builtInKey: 'whatsapp-assistant' }, include: { worker: { select: { ownerUserId: true, tenantId: true } } } });
    expect(assistants).toHaveLength(2);
    expect(assistants.find((p) => p.tenantId === ALTO_TENANT_ID)?.worker.ownerUserId).toBe(altoHr.id);
    expect(assistants.find((p) => p.tenantId === T2)?.worker).toMatchObject({ ownerUserId: two.user.id, tenantId: T2 });
    const altoId = await builtInAgentId(prisma, 'whatsapp-assistant', ALTO_TENANT_ID);
    const twoId = await builtInAgentId(prisma, 'whatsapp-assistant', T2);
    expect(altoId).toBeTruthy();
    expect(twoId).toBeTruthy();
    expect(twoId).not.toBe(altoId);

    const again = await runForEachTenant('agents', async (tenantId) => {
      const r = await ensureBuiltInAgents(prisma, tenantId);
      expect(r.created).toEqual([]);
    });
    expect(again.failed).toBe(0);
    expect(await prisma.agentProfile.count({ where: { builtInKey: { not: null } } })).toBe(2 * BUILT_IN_AGENTS.length);

    // Risk ruling 3: the partial index refuses a second built-in with the same key in a tenant.
    const w = await prisma.worker.create({ data: { type: 'AGENT', name: 'Impostor', ownerUserId: two.user.id, tenantId: T2 } });
    await expect(
      prisma.agentProfile.create({ data: { workerId: w.id, tenantId: T2, purpose: 'x', vendor: 'x', model: 'x', modelVersion: 'x', builtInKey: 'boardroom' } }),
    ).rejects.toThrow();
  });
});

describe('a capability has its own scorecard and switch (test 4)', () => {
  it('counts its proposals by outcome over the window; suspending it is audited and only the owner resumes it', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: owner } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const admin = await loginAs(agent(), hr.email);
    const asOwner = await loginAs(agent(), owner.email);
    const a = await registerAgent(admin, owner.id, 'Workforce agent', ['view:scheduling', 'view:org', 'manage:scheduling']);
    await grantCapability(prisma, a.id, 'shift.fill', ALTO_TENANT_ID);
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * 24 * 3_600_000);
    const statuses = ['EXECUTED', 'EXECUTED', 'EXECUTED', 'REJECTED', 'EXPIRED', 'PROPOSED', 'APPROVED', 'SUPERSEDED'] as const;
    for (const status of statuses) {
      await prisma.agentProposal.create({ data: { workerId: a.id, capabilityKey: 'shift.fill', subjectType: 'Shift', payload: {}, status, createdAt: at(2) } });
    }
    // Outside the window.
    await prisma.agentProposal.create({ data: { workerId: a.id, capabilityKey: 'shift.fill', subjectType: 'Shift', payload: {}, status: 'FAILED', createdAt: at(30) } });

    const card = await admin.get(`/agents/${a.id}/capabilities/shift.fill/scorecard?days=7`);
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ key: 'shift.fill', proposed: 8, executed: 3, rejected: 1, expired: 1, superseded: 1, failed: 0, approved: 4, outcomeRatePct: 60 });
    // A capability the agent does not hold has no scorecard.
    expect((await admin.get(`/agents/${a.id}/capabilities/schedule.repair/scorecard`)).status).toBe(404);

    expect((await admin.post(`/agents/${a.id}/capabilities/shift.fill/suspend`).send({ reason: 'Proposing the wrong people.' })).status).toBe(200);
    const caps = await admin.get(`/agents/${a.id}/capabilities`);
    expect(caps.body.capabilities).toEqual([expect.objectContaining({ key: 'shift.fill', offered: true, suspendReason: 'Proposing the wrong people.' })]);
    expect(await prisma.notification.count({ where: { recipientUserId: owner.id, category: 'agent_kill', channel: 'IN_APP' } })).toBe(1);
    const notOwner = await admin.post(`/agents/${a.id}/capabilities/shift.fill/resume`).send({});
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.error.code).toBe('owner_only');
    expect((await asOwner.post(`/agents/${a.id}/capabilities/shift.fill/resume`).send({})).status).toBe(200);
    expect((await asOwner.post(`/agents/${a.id}/capabilities/shift.fill/resume`).send({})).status).toBe(409);
  });
});

describe('the fixture scenario runner (test 5)', () => {
  /** A minimal shift.fill for the runner's test: the first person placed at the shift's site with no overlapping shift. */
  async function testShiftFill(ctx: CapabilityFixtureContext) {
    const shift = await ctx.db.shift.findUniqueOrThrow({ where: { id: ctx.refs[ctx.input.shiftRef as string]! } });
    const placed = await ctx.db.associateAssignment.findMany({ where: { locationId: shift.locationId!, endedAt: null, tenantId: ctx.tenantId }, select: { associateId: true } });
    for (const p of placed) {
      const clash = await ctx.db.shift.count({ where: { tenantId: ctx.tenantId, assignedAssociateId: p.associateId, startsAt: { lt: shift.endsAt }, endsAt: { gt: shift.startsAt } } });
      if (clash === 0) return { output: { proposedRef: p.associateId }, actions: ['propose'] };
    }
    return { output: { proposedRef: null }, actions: [] };
  }

  it('loads the fixture into a throwaway tenant, passes the free person, fails the busy one, and leaves nothing behind', async () => {
    const fixture = capabilityScenarios('shift.fill')[0] as CapabilityScenarioFixture;
    registerCapabilityRunner('shift.fill', testShiftFill);
    try {
      const now = new Date('2026-10-14T12:00:00.000Z');
      const pass = await runCapabilityFixture('shift.fill', fixture, now);
      expect(pass, JSON.stringify(pass)).toMatchObject({ passed: true, reason: null });
      const wrong = await runCapabilityFixture('shift.fill', { ...fixture, expected: { output: { proposedRef: 'omar' } } }, now);
      expect(wrong.passed).toBe(false);
      expect(wrong.reason).toMatch(/omar/);
    } finally {
      unregisterCapabilityRunnerForTests('shift.fill');
    }
    expect(await prisma.tenant.count({ where: { slug: { startsWith: 'fixture-' } } })).toBe(0);
    expect(await prisma.site.count({ where: { name: 'The Grand Hotel' } })).toBe(0);
    expect(await prisma.associate.count({ where: { email: { endsWith: '@fixture.invalid' } } })).toBe(0);
  });
});

describe('capabilities follow the tenant’s modules (test 6)', () => {
  it('a hotel with compliance off is offered the Workforce capabilities only, in words it may see', async () => {
    const hotel = { ...defaultTenantProfile('DIRECT_EMPLOYER') };
    const modules = { ...hotel.modules, scheduling: true, time: true, compliance: false };
    const offered = capabilitiesFor(modules);
    expect(new Set(offered.map((c) => c.family))).toEqual(new Set(['workforce']));
    expect(offered.map((c) => c.key).sort()).toEqual(['attendance.confirm', 'coverage.forecast', 'schedule.repair', 'shift.fill']);
    const FORBIDDEN = /\b(clients?|bill rates?|housing|vans?|stores?|associates?|alto)\b/i;
    for (const c of offered) expect(c.label, c.key).not.toMatch(FORBIDDEN);
    expect(capabilitiesFor(null)).toEqual([]);
  });

  it('an agent cannot propose under a capability whose module the tenant turned off, and the page says it is not offered', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    await createClient('Coastal Resort');
    const a = await registerAgent(admin, hr.id, 'Compliance agent', ['view:compliance', 'open:hr-case']);
    await grantCapability(prisma, a.id, 'incident.loop', ALTO_TENANT_ID);
    const cred = await issue(admin, a.id);
    expect((await admin.put('/admin/tenant/profile').send({ modules: { compliance: false } })).status).toBe(200);
    invalidateTenantProfile();
    const res = await agent().post('/agent/v1/proposals').set(bearer(cred.plaintext)).send({ capability: 'incident.loop', subjectType: 'OshaIncident', subjectId: null, summary: 'Open a case', payload: {} });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('capability_not_offered');
    const caps = await admin.get(`/agents/${a.id}/capabilities`);
    expect(caps.body.capabilities).toEqual([expect.objectContaining({ key: 'incident.loop', offered: false })]);
  });
});
