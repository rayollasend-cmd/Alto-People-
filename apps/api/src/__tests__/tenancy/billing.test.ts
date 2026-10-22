import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { activeWorkersBetween } from '../../lib/activeDefinition.js';
import { closeMonthUsage, invoiceMonth, setStripeForTests, snapshotDay, stripeMode } from '../../lib/billing.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Brief 2-6 step 4 — usage and invoices (acceptance: "a month of snapshots
 * produces an invoice whose lines equal the distinct-active counts by type").
 *
 *   An agent counts on a day it acted; a robot on a day it was at a site;
 *   snapshots are idempotent; a month's count is the distinct workers active
 *   on at least one day. An invoice waits as a draft without prices or
 *   Stripe; with both (test mode) it sends counts and prices only. A live
 *   key is refused without the owner's approval. Stripe's events are
 *   signature-checked. The internal plan is never invoiced.
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const saved = { key: env.STRIPE_SECRET_KEY, hook: env.STRIPE_WEBHOOK_SECRET, live: env.STRIPE_LIVE_APPROVED };
const setEnv = (k: 'STRIPE_SECRET_KEY' | 'STRIPE_WEBHOOK_SECRET' | 'STRIPE_LIVE_APPROVED', v: string | undefined) => {
  (env as Record<string, unknown>)[k] = v;
};

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => {
  setStripeForTests(null);
  setEnv('STRIPE_SECRET_KEY', saved.key);
  setEnv('STRIPE_WEBHOOK_SECRET', saved.hook);
  setEnv('STRIPE_LIVE_APPROVED', saved.live);
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function hotelTenant() {
  await prisma.tenant.create({ data: { id: T2, slug: 'acme-hotels', name: 'Acme Hotels', plan: 'standard' } });
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await prisma.user.update({ where: { id: user.id }, data: { tenantId: T2 } });
  const c = await createClient('Acme Downtown');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
  await prisma.site.update({ where: { id: site.id }, data: { tenantId: T2 } });
  const agentW = await prisma.worker.create({ data: { tenantId: T2, type: 'AGENT', name: 'Acme fill', ownerUserId: user.id, status: 'ACTIVE' } });
  const robot = await prisma.worker.create({ data: { tenantId: T2, type: 'ROBOT', name: 'Scrubber', ownerUserId: user.id, status: 'ACTIVE', assignments: { create: { tenantId: T2, locationId: site.id, startedAt: new Date('2026-09-01T00:00:00Z') } } } });
  return { user, agentW, robot };
}

describe('the active rule by type', () => {
  it('an agent counts on a day it acted; a robot on a day it was at a site', async () => {
    const { agentW, robot } = await hotelTenant();
    const day = { from: new Date('2026-09-10T04:00:00Z'), to: new Date('2026-09-11T04:00:00Z') };
    expect((await activeWorkersBetween(T2, day.from, day.to)).AGENT).toEqual([]);
    await prisma.auditLog.create({ data: { actorUserId: null, clientId: null, tenantId: T2, workerId: agentW.id, action: 'agent.me', entityType: 'AgentRequest', entityId: agentW.id, metadata: {}, createdAt: new Date('2026-09-10T15:00:00Z') } });
    const active = await activeWorkersBetween(T2, day.from, day.to);
    expect(active.AGENT).toEqual([agentW.id]);
    expect(active.ROBOT).toEqual([robot.id]);
    // Another tenant's workers are not this tenant's usage.
    expect((await activeWorkersBetween(ALTO_TENANT_ID, day.from, day.to)).ROBOT).toEqual([]);
  });
});

describe('snapshots and the month', () => {
  it('a day is written once; the month counts distinct workers active on at least one day', async () => {
    const { agentW } = await hotelTenant();
    await prisma.auditLog.create({ data: { actorUserId: null, clientId: null, tenantId: T2, workerId: agentW.id, action: 'agent.me', entityType: 'AgentRequest', entityId: agentW.id, metadata: {}, createdAt: new Date('2026-09-10T15:00:00Z') } });
    expect(await snapshotDay(prisma, T2, '2026-09-10', 'America/New_York')).toBe(3);
    expect(await snapshotDay(prisma, T2, '2026-09-10', 'America/New_York')).toBe(0);
    await snapshotDay(prisma, T2, '2026-09-11', 'America/New_York');
    const counts = await closeMonthUsage(prisma, T2, '2026-09');
    expect(counts).toEqual({ PERSON: 0, AGENT: 1, ROBOT: 1 });
    const rec = await prisma.usageRecord.findUniqueOrThrow({ where: { tenantId_month_type: { tenantId: T2, month: '2026-09', type: 'ROBOT' } } });
    expect(rec.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('invoices', () => {
  it('waits for prices, then for Stripe; in test mode it sends counts and prices only', async () => {
    const { agentW, robot } = await hotelTenant();
    for (const day of ['2026-09-10', '2026-09-11']) await snapshotDay(prisma, T2, day, 'America/New_York');

    setEnv('STRIPE_SECRET_KEY', undefined);
    expect(await invoiceMonth(prisma, T2, '2026-09')).toMatchObject({ status: 'DRAFT', holdReason: 'prices_missing' });

    const { user: altoAdmin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const alto = await loginAs(agent(), altoAdmin.email);
    expect((await alto.put('/billing/prices').send({ plan: 'standard', type: 'ROBOT', unitPriceCents: 9900, effectiveFrom: '2026-01-01' })).status).toBe(200);
    expect(await invoiceMonth(prisma, T2, '2026-09')).toMatchObject({ status: 'DRAFT', holdReason: 'stripe_not_configured' });

    setEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
    const calls: Array<{ path: string; params: Record<string, string | number> }> = [];
    setStripeForTests(async (_m, path, params) => {
      calls.push({ path, params });
      if (path === '/customers/search') return { data: [] };
      if (path === '/customers') return { id: 'cus_1' };
      if (path === '/invoices') return { id: 'in_1' };
      if (path === '/invoices/in_1/finalize') return { id: 'in_1', hosted_invoice_url: 'https://invoice.stripe.test/in_1' };
      return { id: 'ii_1' };
    });
    const sent = await invoiceMonth(prisma, T2, '2026-09');
    expect(sent).toMatchObject({ status: 'OPEN', holdReason: null });
    const inv = await prisma.billingInvoice.findUniqueOrThrow({ where: { tenantId_month: { tenantId: T2, month: '2026-09' } } });
    expect(inv).toMatchObject({ stripeInvoiceId: 'in_1', hostedUrl: 'https://invoice.stripe.test/in_1', totalCents: 9900 });
    expect(inv.lines).toEqual([{ type: 'ROBOT', quantity: 1, unitPriceCents: 9900, amountCents: 9900 }]);
    // Counts and prices only: no worker's id or name reaches Stripe.
    const wire = JSON.stringify(calls);
    expect(wire).not.toContain(robot.id);
    expect(wire).not.toContain(agentW.id);
    expect(wire).not.toContain('Scrubber');
    // An open invoice is never rebuilt.
    expect(await invoiceMonth(prisma, T2, '2026-09')).toMatchObject({ status: 'OPEN' });
  });

  it('the internal plan is never invoiced; a live key is refused without the owner’s approval', async () => {
    expect(await invoiceMonth(prisma, ALTO_TENANT_ID, '2026-09')).toBeNull();
    setEnv('STRIPE_SECRET_KEY', 'sk_live_x');
    setEnv('STRIPE_LIVE_APPROVED', undefined);
    expect(stripeMode()).toBeNull();
    setEnv('STRIPE_LIVE_APPROVED', 'yes');
    expect(stripeMode()).toBe('live');
  });

  it('Stripe’s events are signature-checked and move the invoice', async () => {
    await hotelTenant();
    const inv = await prisma.billingInvoice.create({ data: { tenantId: T2, month: '2026-09', plan: 'standard', lines: [], totalCents: 100, status: 'OPEN', stripeInvoiceId: 'in_9' } });
    setEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    const payload = JSON.stringify({ type: 'invoice.paid', data: { object: { id: 'in_9', metadata: { altoInvoiceId: inv.id } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
    const app = createApp();
    const bad = await request(app).post('/billing/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', `t=${t},v1=${'0'.repeat(64)}`).send(payload);
    expect(bad.status).toBe(400);
    const ok = await request(app).post('/billing/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', `t=${t},v1=${sig}`).send(payload);
    expect(ok.status).toBe(200);
    expect((await prisma.billingInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PAID');
  });
});

describe('the billing page', () => {
  it('shows a tenant its own plan, running counts and invoices; Finance reads; only the operator sets prices', async () => {
    const { user } = await hotelTenant();
    await snapshotDay(prisma, T2, new Date().toISOString().slice(0, 10), 'America/New_York');
    const admin = await loginAs(agent(), user.email);
    const page = await admin.get('/billing');
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ plan: 'standard', invoiced: true });
    expect(page.body.running.ROBOT).toBe(1);
    expect((await admin.put('/billing/prices').send({ plan: 'standard', type: 'ROBOT', unitPriceCents: 1, effectiveFrom: '2026-01-01' })).status).toBe(404);

    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(agent(), fin.email);
    expect((await f.get('/billing')).body.plan).toBe('internal');
  });
});

describe('the Stripe customer and the billing contact (audit 2026-10-21, Tier 3)', () => {
  it('stores the Stripe customer once made and never searches for it again', async () => {
    await hotelTenant();
    const { user: altoAdmin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const alto = await loginAs(agent(), altoAdmin.email);
    await alto.put('/billing/prices').send({ plan: 'standard', type: 'ROBOT', unitPriceCents: 9900, effectiveFrom: '2026-01-01' });
    for (const day of ['2026-09-10', '2026-10-10']) await snapshotDay(prisma, T2, day, 'America/New_York');
    await prisma.tenant.update({ where: { id: T2 }, data: { billingName: 'Acme Hotels LLC', billingEmail: 'ap@acme.test' } });
    setEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
    const calls: Array<{ path: string; params: Record<string, string | number> }> = [];
    setStripeForTests(async (_m, path, params) => {
      calls.push({ path, params });
      if (path === '/customers/search') return { data: [] };
      if (path === '/customers') return { id: 'cus_7' };
      if (path === '/invoices') return { id: `in_${calls.length}` };
      if (path.endsWith('/finalize')) return { id: 'x', hosted_invoice_url: null };
      return { id: 'ii' };
    });
    await invoiceMonth(prisma, T2, '2026-09');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: T2 } })).stripeCustomerId).toBe('cus_7');
    // The new customer carries the billing contact.
    expect(calls.find((c) => c.path === '/customers')!.params).toMatchObject({ name: 'Acme Hotels LLC', email: 'ap@acme.test' });
    calls.length = 0;
    await invoiceMonth(prisma, T2, '2026-10');
    expect(calls.some((c) => c.path === '/customers/search' || c.path === '/customers')).toBe(false);
    expect(calls.find((c) => c.path === '/invoices')!.params.customer).toBe('cus_7');
  });

  it('the billing page shows the contact and the payment method on file; saving the contact updates Stripe too', async () => {
    const { user } = await hotelTenant();
    const admin = await loginAs(agent(), user.email);
    setEnv('STRIPE_SECRET_KEY', undefined);
    const off = await admin.get('/billing');
    expect(off.body.contact).toMatchObject({ name: null, email: null, paymentMethod: null, paymentMethodNote: 'stripe_off' });

    expect((await admin.put('/billing/contact').send({ name: 'Acme Hotels LLC', email: 'not an email' })).status).toBe(400);
    const saved = await admin.put('/billing/contact').send({ name: 'Acme Hotels LLC', email: 'ap@acme.test' });
    expect(saved.status).toBe(200);
    expect(saved.body.stripeUpdated).toBe(false);

    setEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
    expect((await admin.get('/billing')).body.contact.paymentMethodNote).toBe('no_customer');
    await prisma.tenant.update({ where: { id: T2 }, data: { stripeCustomerId: 'cus_9' } });
    const calls: Array<{ method: string; path: string; params: Record<string, string | number> }> = [];
    setStripeForTests(async (method, path, params) => {
      calls.push({ method, path, params });
      return { id: 'cus_9', invoice_settings: { default_payment_method: { type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2028 } } } };
    });
    const on = await admin.get('/billing');
    expect(on.body.contact).toMatchObject({ name: 'Acme Hotels LLC', email: 'ap@acme.test', paymentMethod: { kind: 'card', label: 'Visa ending 4242, expires 4/2028' }, paymentMethodNote: null });
    const again = await admin.put('/billing/contact').send({ name: 'Acme Hotels', email: 'billing@acme.test' });
    expect(again.body.stripeUpdated).toBe(true);
    expect(calls.find((c) => c.method === 'POST' && c.path === '/customers/cus_9')!.params).toMatchObject({ name: 'Acme Hotels', email: 'billing@acme.test' });

    // Finance reads the page; only manage:org saves the contact.
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(agent(), fin.email);
    expect((await f.put('/billing/contact').send({ name: 'x', email: null })).status).toBe(403);
  });
});
