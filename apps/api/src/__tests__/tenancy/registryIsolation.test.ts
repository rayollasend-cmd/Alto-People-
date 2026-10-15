import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { resetAgentRateLimits } from '../../lib/agents.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * Brief 2-6 step 1 — the registry is the customer's.
 *
 *   A tenant's workers (people, agents, robots) and shifts are invisible to
 *   another tenant on every /workers route, the list included; a worker it
 *   creates is its own, owned by one of its own accounts. Registering an
 *   agent takes catalog capabilities (or none, a custom agent), each one
 *   offered here, of the agent's family and covered by its scopes.
 */

const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

async function adminIn(tenantId: string | null) {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  if (tenantId) await prisma.user.update({ where: { id: user.id }, data: { tenantId } });
  return { user, a: await loginAs(agent(), user.email) };
}

const register = (a: ReturnType<typeof agent>, ownerUserId: string, extra: Record<string, unknown> = {}) =>
  a.post('/agents').send({ name: 'Fill helper', ownerUserId, purpose: 'Proposes cover for open shifts', vendor: 'Anthropic', model: 'claude', modelVersion: '1', scopes: ['view:scheduling', 'view:org', 'manage:scheduling'], ...extra });

describe('workers stay in their tenant', () => {
  it('another tenant’s worker and shift are not found, the list carries none of them, and a new worker is the creator’s tenant’s', async () => {
    const alto = await adminIn(null);
    const made = await alto.a.post('/workers').send({ type: 'ROBOT', name: 'Floor scrubber 1', ownerUserId: alto.user.id, capabilities: [] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);

    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const two = await adminIn(T2);
    expect((await two.a.get(`/workers/${made.body.id}`)).status).toBe(404);
    expect((await two.a.patch(`/workers/${made.body.id}`).send({ name: 'Mine now' })).status).toBe(404);
    expect(JSON.stringify((await two.a.get('/workers')).body)).not.toContain(made.body.id);

    const client = await createClient('Alto Client');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    expect((await two.a.post(`/workers/${made.body.id}/assignments`).send({ locationId: site.id })).status).toBe(404);

    // Tenant two's own robot, owned by its own admin; Alto's admin cannot own it.
    expect((await two.a.post('/workers').send({ type: 'ROBOT', name: 'Theirs', ownerUserId: alto.user.id, capabilities: [] })).status).toBe(400);
    const theirs = await two.a.post('/workers').send({ type: 'ROBOT', name: 'Theirs', ownerUserId: two.user.id, capabilities: [] });
    expect(theirs.status).toBe(201);
    expect((await prisma.worker.findUniqueOrThrow({ where: { id: theirs.body.id } })).tenantId).toBe(T2);
  });
});

describe('registering with catalog capabilities', () => {
  it('grants the capabilities picked, each offered, of the family and within the scopes', async () => {
    const { user, a } = await adminIn(null);
    const ok = await register(a, user.id, { family: 'workforce', catalogCapabilities: ['shift.fill', 'schedule.repair'] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const caps = await prisma.agentCapability.findMany({ where: { workerId: ok.body.id }, select: { key: true, enabled: true } });
    expect(caps.map((c) => c.key).sort()).toEqual(['schedule.repair', 'shift.fill']);

    const scope = await register(a, user.id, { family: 'workforce', catalogCapabilities: ['coverage.forecast'] });
    expect(scope.status).toBe(400);
    expect(scope.body.error.code).toBe('capability_scope_missing');

    const family = await register(a, user.id, { family: 'compliance', catalogCapabilities: ['shift.fill'] });
    expect(family.body.error.code).toBe('capability_wrong_family');

    // A custom agent: no catalog capability, scopes only.
    const custom = await register(a, user.id, { family: null, catalogCapabilities: [] });
    expect(custom.status).toBe(201);
    expect(await prisma.agentCapability.count({ where: { workerId: custom.body.id } })).toBe(0);
    // Nothing half-made from the refused ones.
    expect(await prisma.worker.count({ where: { type: 'AGENT', name: 'Fill helper' } })).toBe(2);
  });

  it('refuses a capability whose module is off here', async () => {
    const { user, a } = await adminIn(null);
    expect((await a.put('/admin/tenant/profile').send({ modules: { compliance: false } })).status).toBe(200);
    invalidateTenantProfile();
    const r = await register(a, user.id, { family: 'compliance', scopes: ['view:compliance', 'manage:compliance', 'manage:communications'], catalogCapabilities: ['document.chase'] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('capability_not_offered');
  });
});
