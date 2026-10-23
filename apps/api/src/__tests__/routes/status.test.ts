import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { computePublicStatus } from '../../lib/statusPage.js';

/**
 * The public status page: anyone can read it, it leaks nothing, a missing
 * measure is honest, an incident the operator posts shows on it and makes
 * its component look worse (never better), and only the operator posts.
 */

const T2 = '00000000-0000-4000-8000-000000000002';

async function operator() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the public status page', () => {
  it('needs no account, is cached a minute, and says UNMEASURED where it has nothing to grade', async () => {
    const res = await request(createApp()).get('/status/public');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=60');
    expect(res.body.product).toBe('Alto People');
    expect(res.body.components).toHaveLength(6);
    const by = Object.fromEntries(res.body.components.map((c: { key: string; state: string; uptime90d: number | null }) => [c.key, c]));
    // The API answered this request; the rollup is empty, so no rate is invented.
    expect(by.API.state).toBe('OPERATIONAL');
    expect(by.API.uptime90d).toBeNull();
    expect(by.KIOSK.state).toBe('UNMEASURED');
    expect(by.EMAIL.state).toBe('UNMEASURED');
    expect(by.MESSAGING.state).toBe('UNMEASURED');
    // STUB provider in tests: not connected, never "operational".
    expect(by.PAYROLL_WEBHOOK.state).toBe('UNMEASURED');
    expect(res.body.overall).toBe('OPERATIONAL');
    expect(res.body.incidents).toEqual([]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('tenantId');
    expect(text).not.toContain('@');
  });

  it('grades the API from its own rollup and counts a bad day against 90-day uptime', async () => {
    const now = new Date('2026-10-15T12:00:00Z');
    const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
    await prisma.routeUsageDaily.createMany({
      data: [
        { day: day('2026-10-14'), method: 'GET', route: '/people', ok: 950, clientError: 0, serverError: 50 },
        { day: day('2026-10-15'), method: 'GET', route: '/people', ok: 200, clientError: 0, serverError: 0 },
        { day: day('2026-10-01'), method: 'GET', route: '/people', ok: 1000, clientError: 0, serverError: 0 },
      ],
    });
    const s = await computePublicStatus(prisma, now);
    const api = s.components.find((c) => c.key === 'API')!;
    // 50 of 1,200 over two days = 4.2%: degraded, not an outage.
    expect(api.state).toBe('DEGRADED');
    expect(api.uptime90d).toBe(66.7);
    expect(s.components.find((c) => c.key === 'WEB')!.state).toBe('DEGRADED');
    expect(s.overall).toBe('DEGRADED');
    // F500 G5: the same days as 90 cells, oldest first — a bad day (≥5% errors) an outage.
    expect(api.days).toHaveLength(90);
    expect(api.days![0]!.date).toBe('2026-07-18');
    expect(api.days![89]).toEqual({ date: '2026-10-15', state: 'OPERATIONAL', pct: 100 });
    expect(api.days!.find((d) => d.date === '2026-10-14')).toEqual({ date: '2026-10-14', state: 'OUTAGE', pct: 95 });
    expect(api.days!.find((d) => d.date === '2026-10-01')).toEqual({ date: '2026-10-01', state: 'OPERATIONAL', pct: 100 });
    expect(api.days!.filter((d) => d.state === 'UNMEASURED')).toHaveLength(87);
    expect(s.components.find((c) => c.key === 'KIOSK')!.days!.every((d) => d.state === 'UNMEASURED')).toBe(true);
  });

  it('an open incident shows publicly and makes its component at least as bad as its impact', async () => {
    const a = await operator();
    const posted = await a.post('/status/incidents').send({ title: 'WhatsApp deliveries delayed', component: 'MESSAGING', impact: 'DEGRADED', note: 'Meta is queueing our template sends.' });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(posted.body.state).toBe('INVESTIGATING');
    expect(posted.body.updates).toHaveLength(1);

    const pub = await request(createApp()).get('/status/public');
    expect(pub.body.overall).toBe('DEGRADED');
    const messaging = pub.body.components.find((c: { key: string }) => c.key === 'MESSAGING');
    expect(messaging.state).toBe('DEGRADED');
    // Today's cell carries the incident even with no measure of its own.
    expect(messaging.days.at(-1).state).toBe('DEGRADED');
    expect(messaging.label).toBe('Text and WhatsApp messages');
    expect(pub.body.incidents).toHaveLength(1);
    expect(pub.body.incidents[0]).toMatchObject({ title: 'WhatsApp deliveries delayed', state: 'INVESTIGATING', resolvedAt: null });
    // The public shape never carries who posted.
    expect(JSON.stringify(pub.body.incidents[0])).not.toContain('UserId');

    const resolved = await a.post(`/status/incidents/${posted.body.id}/updates`).send({ state: 'RESOLVED', note: 'Queue drained; deliveries are current.' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolvedAt).toEqual(expect.any(String));
    expect(resolved.body.updates).toHaveLength(2);
    expect((await a.post(`/status/incidents/${posted.body.id}/updates`).send({ state: 'MONITORING', note: 'Reopening by mistake.' })).status).toBe(409);

    const after = await request(createApp()).get('/status/public');
    expect(after.body.overall).toBe('OPERATIONAL');
    expect(after.body.incidents[0].state).toBe('RESOLVED');

    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'StatusIncident' } });
    expect(audits.map((r) => r.action).sort()).toEqual(['status.incident.posted', 'status.incident.updated']);
  });

  it('only an org manager of the platform operator posts', async () => {
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(agent(), assoc.email)).post('/status/incidents').send({ title: 'x', component: 'API', impact: 'OUTAGE', note: 'nope' })).status).toBe(403);
    expect((await agent().get('/status/incidents')).status).toBe(401);

    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: other.id }, data: { tenantId: T2 } });
    const theirs = await loginAs(agent(), other.email);
    expect((await theirs.post('/status/incidents').send({ title: 'Their outage', component: 'API', impact: 'OUTAGE', note: 'not theirs to post' })).status).toBe(403);
    expect((await theirs.get('/status/incidents')).status).toBe(403);

    const ours = await operator();
    expect((await ours.get('/status/incidents')).status).toBe(200);
    expect(ALTO_TENANT_ID).toBe('00000000-0000-4000-8000-000000000001');
  });
});
