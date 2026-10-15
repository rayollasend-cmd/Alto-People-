import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { resetAgentRateLimits } from '../../lib/agents.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * Brief 2-6 step 2 — customer-defined gates.
 *
 *   The floor cannot be lowered: a NOT_REQUIRED policy on a platform-gated
 *   action changes nothing. A policy can gate a capability the platform
 *   does not (its proposal waits, as POLICY_GATE) and name who decides; the
 *   most specific policy wins; another approver is refused; one tenant's
 *   policy never reaches another's agents.
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const admin = await loginAs(agent(), hr.email);
  const reg = await admin.post('/agents').send({
    name: 'Ops helper',
    ownerUserId: hr.id,
    purpose: 'Forecasts and fills',
    vendor: 'Anthropic',
    model: 'claude',
    modelVersion: '1',
    status: 'ACTIVE',
    family: 'workforce',
    scopes: ['view:scheduling', 'view:org', 'manage:scheduling', 'view:analytics'],
    catalogCapabilities: ['shift.fill', 'coverage.forecast'],
  });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const cred = await admin.post(`/agents/${reg.body.id}/credentials`).send({ ttlHours: 24 });
  const c = await createClient('Gate Hotel');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
  const shift = await prisma.shift.create({ data: { clientId: c.id, locationId: site.id, position: 'Houseman', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 86_400_000 + 8 * 3_600_000), status: 'OPEN' } });
  return { hr, admin, workerId: reg.body.id as string, token: cred.body.plaintext as string, shift };
}

const propose = (token: string, body: Record<string, unknown>) => agent().post('/agent/v1/proposals').set(bearer(token)).send(body);

describe('the floor', () => {
  it('a NOT_REQUIRED policy on a platform-gated action changes nothing', async () => {
    const { admin, workerId, token, shift } = await world();
    expect((await admin.post('/agents/gates').send({ scope: 'TENANT', action: 'SHIFT_ASSIGN', requirement: 'NOT_REQUIRED' })).status).toBe(201);
    const preview = await admin.get('/agents/gates/preview').query({ workerId, action: 'SHIFT_ASSIGN' });
    expect(preview.body).toMatchObject({ required: true, floor: true });
    const r = await propose(token, { capability: 'shift.fill', subjectType: 'Shift', subjectId: shift.id, summary: 'Cover it', payload: {} });
    expect(r.status).toBe(202);
    expect(r.body.approvalId).toBeTruthy();
  });
});

describe('the customer adds and narrows', () => {
  it('gates a capability the platform does not, names a role to decide, and the most specific policy wins', async () => {
    const { admin, workerId, token } = await world();
    // Ungated by the platform: the forecast is recorded with no approval.
    const before = await propose(token, { capability: 'coverage.forecast', subjectType: 'Run', payload: {} });
    expect(before.status).toBe(201);
    expect(before.body.approvalId).toBeNull();

    expect((await admin.post('/agents/gates').send({ scope: 'FAMILY', scopeKey: 'workforce', action: '*', requirement: 'REQUIRED', approver: 'ROLE', approverRole: 'OPERATIONS_MANAGER', ttlHours: 24 })).status).toBe(201);
    const gated = await propose(token, { capability: 'coverage.forecast', subjectType: 'Week', payload: { week: '2026-10-17' } });
    expect(gated.status).toBe(202);
    const approval = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: gated.body.approvalId } });
    expect(approval).toMatchObject({ action: 'POLICY_GATE', approverKind: 'ROLE', approverRole: 'OPERATIONS_MANAGER' });
    expect(approval.expiresAt.getTime() - approval.requestedAt.getTime()).toBe(24 * 3_600_000);

    // The HR admin is not the approver this policy names.
    const refused = await admin.post(`/agents/approvals/${gated.body.approvalId}/approve`).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('not_the_approver');
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const opsAgent = await loginAs(agent(), ops.email);
    expect((await opsAgent.post(`/agents/approvals/${gated.body.approvalId}/approve`).send({})).status).toBe(200);

    // A more specific AGENT policy wins over the FAMILY one: owner decides, 2 hours.
    await admin.post('/agents/gates').send({ scope: 'AGENT', scopeKey: workerId, action: 'coverage.forecast', requirement: 'REQUIRED', approver: 'OWNER', ttlHours: 2 });
    const preview = await admin.get('/agents/gates/preview').query({ workerId, capability: 'coverage.forecast' });
    expect(preview.body).toMatchObject({ required: true, floor: false, approver: 'OWNER', ttlHours: 2 });
    const again = await propose(token, { capability: 'coverage.forecast', subjectType: 'Week', payload: { week: '2026-10-24' } });
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: again.body.approvalId } })).approverKind).toBe('OWNER');
    // The HR admin registered it and owns it.
    expect((await admin.post(`/agents/approvals/${again.body.approvalId}/approve`).send({})).status).toBe(200);
  });

  it('a policy can be ended, never deleted; a policy needs its keys', async () => {
    const { admin } = await world();
    expect((await admin.post('/agents/gates').send({ scope: 'TENANT', scopeKey: 'x', action: '*', requirement: 'REQUIRED' })).status).toBe(400);
    expect((await admin.post('/agents/gates').send({ scope: 'TENANT', action: '*', requirement: 'REQUIRED', approver: 'ROLE' })).status).toBe(400);
    expect((await admin.post('/agents/gates').send({ scope: 'CAPABILITY', scopeKey: 'no.such', action: '*', requirement: 'REQUIRED' })).status).toBe(400);
    const made = await admin.post('/agents/gates').send({ scope: 'TENANT', action: '*', requirement: 'REQUIRED' });
    expect((await admin.post(`/agents/gates/${made.body.id}/end`).send({})).status).toBe(200);
    const list = await admin.get('/agents/gates');
    expect(list.body.policies).toEqual([expect.objectContaining({ id: made.body.id, inForce: false })]);
    expect(await prisma.agentGatePolicy.count()).toBe(1);
  });
});

describe('tenants', () => {
  it('one tenant’s policy never reaches another tenant’s agents', async () => {
    const { workerId, token } = await world();
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: user.id }, data: { tenantId: T2 } });
    const two = await loginAs(agent(), user.email);
    expect((await two.post('/agents/gates').send({ scope: 'AGENT', scopeKey: workerId, action: '*', requirement: 'REQUIRED' })).status).toBe(404);
    expect((await two.post('/agents/gates').send({ scope: 'TENANT', action: '*', requirement: 'REQUIRED' })).status).toBe(201);
    const r = await propose(token, { capability: 'coverage.forecast', subjectType: 'Run', payload: {} });
    expect(r.body.approvalId).toBeNull();
    expect((await two.get('/agents/gates/preview').query({ workerId, capability: 'coverage.forecast' })).status).toBe(404);
  });
});
