import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createApp } from '../../app.js';
import { createApiClient, revokeApiClient, rotateApiClient } from '../../lib/apiClients.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { listRoutes } from '../../lib/routeInventory.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { declaredV1Routes, v1OpenApiDocument } from '../../lib/v1/define.js';
import { deliverPendingDeliveries, setWebhookSenderForTests } from '../../lib/webhookDispatch.js';
import { openWebhookSecret, verifySignatureV2 } from '../../lib/webhookSecrets.js';
import { ensureWorkerForAssociate } from '../../lib/workers.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import type { ApiScope } from '@alto-people/shared';

/**
 * Brief 2-4 — the public API's acceptance, in one file:
 *
 *   tokens (Basic and form, wrong secret, rotation's five-minute overlap,
 *   revocation stopping a token already issued), scopes (403 naming the
 *   missing one), the spec (generated, valid OpenAPI 3.1, and the router
 *   and the spec name the same routes both ways), the excluded fields (no
 *   SSN, coordinates or pay without pay:read), writes audited under the
 *   client and its owner, Idempotency-Key required and replayed, the other
 *   tenant's client sees nothing, and webhooks: sealed secrets, the v2
 *   signature, the events, redelivery.
 */

const app = createApp();
const T2 = '22222222-2222-4222-8222-222222222222';
const HOOK_URL = 'https://203.0.113.10/hook';

let ownerId: string;
let siteId: string;
let workerId: string;
let associateId: string;

async function newClient(scopes: ApiScope[], tenantId = ALTO_TENANT_ID, owner = ownerId) {
  return createApiClient(prisma, tenantId, { name: `Test client ${scopes.length}`, scopes, ownerUserId: owner }, owner);
}

async function tokenFor(issued: { client: { clientId: string }; clientSecret: string }): Promise<string> {
  const res = await request(app).post('/v1/oauth/token').auth(issued.client.clientId, issued.clientSecret).type('form').send({ grant_type: 'client_credentials' });
  expect(res.status).toBe(200);
  return res.body.access_token as string;
}

const ALL: ApiScope[] = ['workers:read', 'workers:write', 'sites:read', 'schedules:read', 'schedules:write', 'time:read', 'documents:read', 'programs:read', 'agents:read', 'webhooks:manage'];

beforeEach(async () => {
  await truncateAll();
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  ownerId = user.id;
  const c = await createClient('API Client Co');
  siteId = (await prisma.site.findFirstOrThrow({ where: { clientId: c.id } })).id;
  const a = await createAssociate({ firstName: 'Ana', lastName: 'Api' });
  associateId = a.id;
  await prisma.associate.update({ where: { id: a.id }, data: { ssnLast4: '4321', dob: new Date('1990-01-01T00:00:00Z') } });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: new Date() } });
  workerId = (await ensureWorkerForAssociate(prisma, a.id, ownerId))!;
});

afterEach(() => {
  setWebhookSenderForTests(null);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('tokens', () => {
  it('trades credentials for a token by Basic auth or form fields, and refuses a wrong secret', async () => {
    const issued = await newClient(['workers:read']);
    const basic = await request(app).post('/v1/oauth/token').auth(issued.client.clientId, issued.clientSecret).send({ grant_type: 'client_credentials' });
    expect(basic.status).toBe(200);
    expect(basic.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'workers:read' });

    const form = await request(app).post('/v1/oauth/token').type('form').send({ grant_type: 'client_credentials', client_id: issued.client.clientId, client_secret: issued.clientSecret });
    expect(form.status).toBe(200);

    const wrong = await request(app).post('/v1/oauth/token').auth(issued.client.clientId, 'nope').send({ grant_type: 'client_credentials' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_client');

    const none = await request(app).get('/v1/workers');
    expect(none.status).toBe(401);
  });

  it('revocation stops a token already issued; rotation keeps the old secret five minutes', async () => {
    const issued = await newClient(['workers:read']);
    const token = await tokenFor(issued);
    expect((await request(app).get('/v1/workers').auth(token, { type: 'bearer' })).status).toBe(200);

    const rotated = await rotateApiClient(prisma, ALTO_TENANT_ID, issued.client.id, ownerId);
    // Both secrets work inside the overlap.
    await tokenFor(issued);
    await tokenFor({ client: issued.client, clientSecret: rotated.clientSecret });

    await revokeApiClient(prisma, ALTO_TENANT_ID, issued.client.id, ownerId);
    const after = await request(app).get('/v1/workers').auth(token, { type: 'bearer' });
    expect(after.status).toBe(401);
    expect((await request(app).post('/v1/oauth/token').auth(issued.client.clientId, rotated.clientSecret).send({ grant_type: 'client_credentials' })).status).toBe(401);
  });

  it('a missing scope is 403 naming it', async () => {
    const token = await tokenFor(await newClient(['workers:read']));
    const res = await request(app).get('/v1/sites').auth(token, { type: 'bearer' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'insufficient_scope' });
    expect(res.body.error.message).toContain('sites:read');
  });
});

describe('the spec', () => {
  it('is valid OpenAPI 3.1 and names exactly the routes the router mounts', async () => {
    const res = await request(app).get('/v1/openapi.json');
    expect(res.status).toBe(200);
    await SwaggerParser.validate(JSON.parse(JSON.stringify(v1OpenApiDocument())));

    const toSpec = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const specOps = new Set<string>();
    for (const [p, ops] of Object.entries((res.body as { paths: Record<string, Record<string, unknown>> }).paths)) {
      for (const m of Object.keys(ops)) specOps.add(`${m.toUpperCase()} ${p}`);
    }
    const mounted = new Set(
      listRoutes(app)
        .filter((r) => r.path.startsWith('/v1/') && r.path !== '/v1/openapi.json' && r.method !== 'HEAD' && r.method !== 'OPTIONS')
        .map((r) => `${r.method} ${toSpec(r.path.replace(/^\/v1/, ''))}`),
    );
    expect([...mounted].sort()).toEqual([...specOps].sort());
    expect(declaredV1Routes.length).toBe(specOps.size);
  });
});

describe('what never leaves', () => {
  it('workers carry no SSN or date of birth, and contact only with workers:contact', async () => {
    const token = await tokenFor(await newClient(['workers:read']));
    const res = await request(app).get(`/v1/workers/${workerId}`).auth(token, { type: 'bearer' });
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/ssn|dob|dateOfBirth|1990-01-01|address|bank/i);
    expect(text).not.toMatch(/"4321"/);
    expect(res.body).not.toHaveProperty('email');

    const contact = await tokenFor(await newClient(['workers:read', 'workers:contact']));
    const withContact = await request(app).get(`/v1/workers/${workerId}`).auth(contact, { type: 'bearer' });
    expect(withContact.body.email).toMatch(/@example\.com$/);
  });

  it('time entries never carry coordinates, and pay only with pay:read', async () => {
    const c = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { clientId: true } });
    await prisma.timeEntry.create({
      data: { associateId, clientId: c.clientId, locationId: siteId, clockInAt: new Date(Date.now() - 5 * 3_600_000), clockOutAt: new Date(Date.now() - 3_600_000), status: 'APPROVED', clockInLat: 27.9506123, clockInLng: -82.4571776, payRate: 15 },
    });
    const token = await tokenFor(await newClient(['time:read']));
    const res = await request(app).get('/v1/time-entries').auth(token, { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/Lat|Lng|27\.95|82\.45/);
    expect(res.body.data[0]).not.toHaveProperty('payRate');

    const pay = await tokenFor(await newClient(['time:read', 'pay:read']));
    const withPay = await request(app).get('/v1/time-entries').auth(pay, { type: 'bearer' });
    expect(withPay.body.data[0].payRate).toBe(15);
  });
});

describe('writes', () => {
  const shiftBody = () => {
    const start = new Date(Date.now() + 20 * 86_400_000);
    start.setUTCHours(14, 0, 0, 0);
    return { siteId, position: 'Housekeeper', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 8 * 3_600_000).toISOString() };
  };

  it('a POST needs an Idempotency-Key, and a repeat replays the first answer', async () => {
    const token = await tokenFor(await newClient(['schedules:write', 'schedules:read']));
    const missing = await request(app).post('/v1/shifts').auth(token, { type: 'bearer' }).send(shiftBody());
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('idempotency_key_required');

    const body = shiftBody();
    const first = await request(app).post('/v1/shifts').auth(token, { type: 'bearer' }).set('Idempotency-Key', 'k-1').send(body);
    expect(first.status).toBe(201);
    const again = await request(app).post('/v1/shifts').auth(token, { type: 'bearer' }).set('Idempotency-Key', 'k-1').send(body);
    expect(again.status).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await prisma.shift.count()).toBe(1);
  });

  it('a shift created, assigned and cancelled through the API is audited under the client and its owner', async () => {
    const issued = await newClient(['schedules:write', 'schedules:read']);
    const token = await tokenFor(issued);
    const created = await request(app).post('/v1/shifts').auth(token, { type: 'bearer' }).set('Idempotency-Key', 'c-1').send(shiftBody());
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('DRAFT');

    const assigned = await request(app).post(`/v1/shifts/${created.body.id}/assign`).auth(token, { type: 'bearer' }).set('Idempotency-Key', 'a-1').send({ workerId });
    expect(assigned.status).toBe(200);
    expect(assigned.body.assignedWorkerId).toBe(workerId);

    const cancelled = await request(app).post(`/v1/shifts/${created.body.id}/cancel`).auth(token, { type: 'bearer' }).set('Idempotency-Key', 'x-1').send({ reason: 'Client closed the floor' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    await flushPendingAudits();
    const rows = await prisma.auditLog.findMany({ where: { apiClientId: issued.client.id }, select: { action: true, actorUserId: true } });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['shift.created', 'shift.assigned']));
    expect(rows.every((r) => r.actorUserId === null)).toBe(true);
  });

  it('deactivating a person needs a reason and releases them', async () => {
    const token = await tokenFor(await newClient(['workers:read', 'workers:write']));
    const noReason = await request(app).patch(`/v1/workers/${workerId}`).auth(token, { type: 'bearer' }).send({ status: 'INACTIVE' });
    expect(noReason.status).toBe(400);
    const res = await request(app).patch(`/v1/workers/${workerId}`).auth(token, { type: 'bearer' }).send({ status: 'INACTIVE', reason: 'Contract ended' });
    expect(res.status).toBe(200);
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: associateId } })).deactivatedAt).not.toBeNull();
  });
});

describe('tenants', () => {
  it('another tenant’s client sees none of this tenant’s records', async () => {
    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'tenant-two', name: 'Tenant Two' }, update: {} });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@tenant-two.example' });
    await prisma.user.update({ where: { id: user.id }, data: { tenantId: T2 } });
    const token = await tokenFor(await newClient(ALL, T2, user.id));

    expect((await request(app).get(`/v1/workers/${workerId}`).auth(token, { type: 'bearer' })).status).toBe(404);
    expect((await request(app).get(`/v1/sites/${siteId}`).auth(token, { type: 'bearer' })).status).toBe(404);
    const list = await request(app).get('/v1/workers').auth(token, { type: 'bearer' });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(workerId);
    const make = await request(app).post('/v1/shifts').auth(token, { type: 'bearer' }).set('Idempotency-Key', 't2-1').send({ siteId, position: 'X', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString() });
    expect(make.status).toBe(404);
  });
});

describe('webhooks', () => {
  it('a subscription made through the API stores its secret sealed, and a shift event arrives signed v2', async () => {
    const token = await tokenFor(await newClient(['webhooks:manage', 'schedules:write']));
    const made = await request(app).post('/v1/webhooks').auth(token, { type: 'bearer' }).set('Idempotency-Key', 'w-1').send({ name: 'Ops', url: HOOK_URL, events: ['shift.created'] });
    expect(made.status).toBe(201);
    const secret = made.body.secret as string;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: made.body.id } });
    expect(row.secret).toBe('');
    expect(row.secretEnc).not.toBeNull();
    expect(openWebhookSecret(row)).toBe(secret);

    const listed = await request(app).get('/v1/webhooks').auth(token, { type: 'bearer' });
    expect(listed.body.data).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(secret);

    const created = await request(app).post('/v1/shifts').auth(token, { type: 'bearer' }).set('Idempotency-Key', 's-1').send({ siteId, position: 'Houseman', startsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 20 * 86_400_000 + 8 * 3_600_000).toISOString() });
    expect(created.status).toBe(201);

    // The emit is fire-and-forget: wait for its delivery row.
    let delivery = null;
    for (let i = 0; i < 50 && !delivery; i += 1) {
      delivery = await prisma.webhookDelivery.findFirst({ where: { webhookId: row.id, eventType: 'shift.created' } });
      if (!delivery) await new Promise((r) => setTimeout(r, 100));
    }
    expect(delivery).not.toBeNull();

    const sent: Array<{ headers: Record<string, string>; body: string }> = [];
    setWebhookSenderForTests(async (_url, init) => {
      sent.push({ headers: init.headers, body: init.body });
      return { status: 200, ok: true, text: async () => 'ok' };
    });
    await deliverPendingDeliveries(prisma);
    expect(sent).toHaveLength(1);
    const { headers, body } = sent[0]!;
    expect(verifySignatureV2(secret, body, headers['Alto-Signature']!)).toBe(true);
    expect(verifySignatureV2('wrong', body, headers['Alto-Signature']!)).toBe(false);
    // A captured delivery replayed ten minutes later is refused.
    expect(verifySignatureV2(secret, body, headers['Alto-Signature']!, new Date(Date.now() + 10 * 60_000))).toBe(false);
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ event: 'shift.created', data: { change: 'created', shift: { id: created.body.id, siteId } } });
    expect(JSON.stringify(payload)).not.toMatch(/billRate|payRate/);

    // Delivery history, then a redelivery as a new row.
    const history = await request(app).get(`/v1/webhooks/${row.id}/deliveries`).auth(token, { type: 'bearer' });
    expect(history.body.data[0]).toMatchObject({ event: 'shift.created', status: 'DELIVERED', attempts: 1 });
    const again = await request(app).post(`/v1/webhooks/${row.id}/deliveries/${delivery!.id}/redeliver`).auth(token, { type: 'bearer' }).set('Idempotency-Key', 'r-1').send({});
    expect(again.status).toBe(202);
    expect(again.body.status).toBe('PENDING');
    expect(await prisma.webhookDelivery.count({ where: { webhookId: row.id } })).toBe(2);
  });

  it('a legacy plain-text secret is sealed on the delivery tick and still signs', async () => {
    const legacy = await prisma.webhook.create({ data: { name: 'Old', url: HOOK_URL, secret: 'legacy-secret', eventTypes: [] } });
    const { sealLegacyWebhookSecrets } = await import('../../lib/webhookSecrets.js');
    expect(await sealLegacyWebhookSecrets(prisma)).toBe(1);
    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(row.secret).toBe('');
    expect(openWebhookSecret(row)).toBe('legacy-secret');
  });

  it('a webhook of another tenant is not found, and a private URL is refused', async () => {
    const token = await tokenFor(await newClient(['webhooks:manage']));
    const privateUrl = await request(app).post('/v1/webhooks').auth(token, { type: 'bearer' }).set('Idempotency-Key', 'p-1').send({ name: 'Inside', url: 'https://10.0.0.5/hook' });
    expect(privateUrl.status).toBe(400);

    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'tenant-two', name: 'Tenant Two' }, update: {} });
    const other = await prisma.webhook.create({ data: { name: 'Theirs', url: HOOK_URL, secret: '', tenantId: T2 } });
    expect((await request(app).patch(`/v1/webhooks/${other.id}`).auth(token, { type: 'bearer' }).send({ active: false })).status).toBe(404);
    expect((await request(app).delete(`/v1/webhooks/${other.id}`).auth(token, { type: 'bearer' })).status).toBe(404);
  });
});
