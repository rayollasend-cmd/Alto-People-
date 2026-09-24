import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';
import {
  bucketIndex,
  emptyHistogram,
  flushVitalsForTests,
  p75FromHistogram,
  rate,
  resetVitalsForTests,
  routeKey,
} from '../../lib/webVitals.js';

/**
 * Web vitals: the browser reports, the server rolls up, the dashboard
 * reads p75. What matters is that the route key can never carry an id,
 * that anonymous callers can't feed the table, and that the percentile
 * arithmetic over the histogram is right.
 */

beforeEach(async () => {
  await truncateAll();
  resetVitalsForTests();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

describe('routeKey', () => {
  it('reduces ids to :id and refuses non-paths', () => {
    expect(routeKey('/clients/9f2e8c1a-1b2c-4d5e-8f90-1234567890ab/statements')).toBe('/clients/:id/statements');
    expect(routeKey('/onboarding/applications/123456?tab=docs')).toBe('/onboarding/applications/:id');
    expect(routeKey('/people')).toBe('/people');
    expect(routeKey('people')).toBeNull();
    expect(routeKey('/' + 'a/'.repeat(20))).toBeNull();
  });
});

describe('the histogram', () => {
  it('rates against the published thresholds', () => {
    expect(rate('LCP', 2500)).toBe('good');
    expect(rate('LCP', 2501)).toBe('needs-improvement');
    expect(rate('LCP', 4001)).toBe('poor');
    expect(rate('CLS', 0.05)).toBe('good');
    expect(rate('INP', 600)).toBe('poor');
  });

  it('reads the 75th percentile off the buckets', () => {
    const h = emptyHistogram('LCP');
    // 8 fast paints, 2 slow ones: p75 sits inside the fast group.
    for (let i = 0; i < 8; i++) h[bucketIndex('LCP', 900)]! += 1;
    for (let i = 0; i < 2; i++) h[bucketIndex('LCP', 6000)]! += 1;
    expect(p75FromHistogram('LCP', h)).toBe(1000);
    expect(p75FromHistogram('LCP', emptyHistogram('LCP'))).toBeNull();
  });
});

describe('POST /telemetry/web-vitals', () => {
  it('refuses anonymous reports', async () => {
    const res = await request(createApp())
      .post('/telemetry/web-vitals')
      .send({ samples: [{ route: '/people', metric: 'LCP', value: 1200 }] });
    expect(res.status).toBe(401);
  });

  it('rolls samples up per route and day, ids stripped', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(user.email);
    const res = await a.post('/telemetry/web-vitals').send({
      samples: [
        { route: '/clients/9f2e8c1a-1b2c-4d5e-8f90-1234567890ab', metric: 'LCP', value: 1800 },
        { route: '/clients/0000aaaa-1b2c-4d5e-8f90-1234567890ab', metric: 'LCP', value: 5200 },
        { route: '/clients/:id', metric: 'CLS', value: 0.02 },
        { route: 'not-a-path', metric: 'INP', value: 100 },
      ],
    });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(3);

    await flushVitalsForTests();
    const rows = await prisma.webVitalDaily.findMany({ orderBy: { metric: 'asc' } });
    expect(rows.map((r) => [r.route, r.metric, r.count, r.good, r.poor])).toEqual([
      ['/clients/:id', 'CLS', 1, 1, 0],
      ['/clients/:id', 'LCP', 2, 1, 1],
    ]);
  });

  it('rejects garbage', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(user.email);
    expect((await a.post('/telemetry/web-vitals').send({ samples: [] })).status).toBe(400);
    expect((await a.post('/telemetry/web-vitals').send({ samples: [{ route: '/x', metric: 'FPS', value: 1 }] })).status).toBe(400);
    expect((await a.post('/telemetry/web-vitals').send({ samples: [{ route: '/x', metric: 'LCP', value: -1 }] })).status).toBe(400);
  });
});

describe('GET /product-analytics/web-vitals', () => {
  it('is gated on view:product-analytics', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(user.email);
    expect((await a.get('/product-analytics/web-vitals')).status).toBe(403);
  });

  it('reports p75 per metric and per route from the rollup', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const reporter = await loginAs((await createUser({ role: 'ASSOCIATE' })).user.email);
    const samples = [
      ...Array.from({ length: 6 }, () => ({ route: '/people', metric: 'LCP' as const, value: 1400 })),
      ...Array.from({ length: 2 }, () => ({ route: '/people', metric: 'LCP' as const, value: 4800 })),
      { route: '/scheduling', metric: 'INP' as const, value: 90 },
      { route: '/scheduling', metric: 'INP' as const, value: 700 },
    ];
    expect((await reporter.post('/telemetry/web-vitals').send({ samples })).status).toBe(202);
    await flushVitalsForTests();

    const res = await a.get('/product-analytics/web-vitals?days=7');
    expect(res.status).toBe(200);
    const lcp = res.body.metrics.find((m: { metric: string }) => m.metric === 'LCP');
    expect(lcp.samples).toBe(8);
    expect(lcp.p75).toBe(1500);
    expect(lcp.rating).toBe('good');
    expect(lcp.poor).toBe(2);
    const inp = res.body.metrics.find((m: { metric: string }) => m.metric === 'INP');
    expect(inp.p75).toBe(700);
    expect(inp.rating).toBe('poor');
    // Routes come busiest first, each with its own percentiles.
    expect(res.body.routes.map((r: { route: string }) => r.route)).toEqual(['/people', '/scheduling']);
    expect(res.body.routes[0].lcpP75).toBe(1500);
    expect(res.body.routes[0].inpP75).toBeNull();
    expect(res.body.routes[1].inpP75).toBe(700);
  });
});
