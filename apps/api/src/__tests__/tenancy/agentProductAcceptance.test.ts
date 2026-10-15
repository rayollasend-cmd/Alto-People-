import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { resetAgentRateLimits } from '../../lib/agents.js';
import { closeMonthUsage, invoiceMonth, setStripeForTests, snapshotDay } from '../../lib/billing.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';

/**
 * Brief 2-6 step 6 — the acceptance, in one run, for a customer tenant:
 *
 *   it registers its own agent with a catalog capability, sets a gate that
 *   names who decides, the agent's tagged decision about a person is
 *   approved by that person and lands on a record the tenant can see; and a
 *   month of snapshots produces an invoice whose lines equal the distinct
 *   active counts by type (Stripe in test mode, counts and prices only).
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const savedKey = env.STRIPE_SECRET_KEY;

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterEach(() => {
  setStripeForTests(null);
  (env as Record<string, unknown>).STRIPE_SECRET_KEY = savedKey;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('Brief 2-6 acceptance', () => {
  it('a customer registers an agent, gates it, sees its decision record, and is invoiced for what was active', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'acme-hotels', name: 'Acme Hotels', plan: 'standard' } });
    const { user: owner } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: gm } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.updateMany({ where: { id: { in: [owner.id, gm.id] } }, data: { tenantId: T2 } });
    const admin = await loginAs(agent(), owner.email);
    const gmSession = await loginAs(agent(), gm.email);

    // 1. Register its own agent, with a catalog capability.
    const reg = await admin.post('/agents').send({ name: 'Acme fill', ownerUserId: owner.id, purpose: 'Covers open shifts', vendor: 'Anthropic', model: 'claude', modelVersion: '1', status: 'ACTIVE', family: 'workforce', scopes: ['view:scheduling', 'view:org', 'manage:scheduling'], catalogCapabilities: ['shift.fill'] });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const cred = await admin.post(`/agents/${reg.body.id}/credentials`).send({ ttlHours: 24 });

    // 2. A gate: the general manager decides this agent's shift fills, within 12 hours.
    expect((await admin.post('/agents/gates').send({ scope: 'AGENT', scopeKey: reg.body.id, action: 'SHIFT_ASSIGN', requirement: 'REQUIRED', approver: 'USER', approverUserId: gm.id, ttlHours: 12 })).status).toBe(201);

    // 3. The agent proposes a person; only the named approver may decide; the decision is on the record.
    const c = await createClient('Acme Downtown');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
    await prisma.site.update({ where: { id: site.id }, data: { tenantId: T2 } });
    const shift = await prisma.shift.create({ data: { tenantId: T2, clientId: c.id, locationId: site.id, position: 'Houseman', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 86_400_000 + 8 * 3_600_000), status: 'OPEN' } });
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Cover' });
    await prisma.associate.update({ where: { id: maria.id }, data: { tenantId: T2 } });
    const filed = await agent().post('/agent/v1/proposals').set(bearer(cred.body.plaintext)).send({ capability: 'shift.fill', subjectType: 'Shift', subjectId: shift.id, summary: 'Maria covers the Houseman shift', payload: { associateId: maria.id } });
    expect(filed.status).toBe(202);
    expect((await admin.post(`/agents/approvals/${filed.body.approvalId}/approve`).send({})).status).toBe(403);
    expect((await gmSession.post(`/agents/approvals/${filed.body.approvalId}/approve`).send({ note: 'Yes' })).status).toBe(200);
    const record = await admin.get(`/agents/${reg.body.id}/decision-record`);
    expect(record.body.decisions).toEqual([expect.objectContaining({ subject: 'Maria Cover', outcome: 'FAVORABLE', decisionType: 'SCHEDULING' })]);

    // 4. A month of snapshots → an invoice whose lines equal the distinct active counts by type.
    await prisma.auditLog.create({ data: { actorUserId: null, clientId: null, tenantId: T2, workerId: reg.body.id, action: 'agent.me', entityType: 'AgentRequest', entityId: reg.body.id, metadata: {}, createdAt: new Date('2026-09-03T15:00:00Z') } });
    await prisma.auditLog.create({ data: { actorUserId: null, clientId: null, tenantId: T2, workerId: reg.body.id, action: 'agent.me', entityType: 'AgentRequest', entityId: reg.body.id, metadata: {}, createdAt: new Date('2026-09-17T15:00:00Z') } });
    for (const day of ['2026-09-03', '2026-09-10', '2026-09-17']) await snapshotDay(prisma, T2, day, 'America/New_York');
    const counts = await closeMonthUsage(prisma, T2, '2026-09');
    expect(counts.AGENT).toBe(1); // active on two days, counted once

    await prisma.billingPrice.create({ data: { plan: 'standard', type: 'AGENT', unitPriceCents: 4900, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    (env as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_acceptance';
    setStripeForTests(async (_m, path) => (path === '/customers/search' ? { data: [{ id: 'cus_acme' }] } : path.endsWith('/finalize') ? { id: 'in_acme', hosted_invoice_url: 'https://invoice.stripe.test/in_acme' } : { id: path === '/invoices' ? 'in_acme' : 'ii' }));
    expect(await invoiceMonth(prisma, T2, '2026-09')).toMatchObject({ status: 'OPEN' });
    const inv = await prisma.billingInvoice.findUniqueOrThrow({ where: { tenantId_month: { tenantId: T2, month: '2026-09' } } });
    const lines = inv.lines as Array<{ type: string; quantity: number }>;
    for (const l of lines) expect(l.quantity).toBe(counts[l.type as keyof typeof counts]);
    expect(lines.find((l) => l.type === 'AGENT')).toMatchObject({ quantity: 1 });

    // The tenant sees it on its billing page.
    const page = await admin.get('/billing');
    expect(page.body.invoices[0]).toMatchObject({ month: '2026-09', status: 'OPEN', hostedUrl: 'https://invoice.stripe.test/in_acme' });
  });
});
