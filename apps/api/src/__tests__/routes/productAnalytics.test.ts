import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';

/**
 * The product-analytics reads: who signs in, what they open, what breaks.
 *
 * The thing worth guarding is not the arithmetic but the blast radius —
 * this is org-wide telemetry, so the capability gate has to hold, and the
 * window has to be bounded by the server rather than by whatever `days`
 * the caller felt like sending.
 */

beforeEach(async () => {
  await truncateAll();
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

const DAY = 24 * 60 * 60 * 1000;
const dayOnly = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

async function seedActivity(userId: string, role: string, daysAgo: number) {
  await prisma.userActivityDay.create({
    data: { userId, role, day: dayOnly(new Date(Date.now() - daysAgo * DAY)) },
  });
}

describe('GET /product-analytics/active-users', () => {
  it('counts a person once a day, however busy they were', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: other } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await seedActivity(hr.id, 'HR_ADMINISTRATOR', 0);
    await seedActivity(other.id, 'OPERATIONS_MANAGER', 0);
    await seedActivity(other.id, 'OPERATIONS_MANAGER', 3);

    const a = await loginAs(hr.email);
    const res = await a.get('/product-analytics/active-users?days=7');
    expect(res.status).toBe(200);
    expect(res.body.dau).toBe(2);
    // Two distinct people across the week, not three activity rows.
    expect(res.body.wau).toBe(2);
    // The series is dense: a day nobody signed in is a zero, not a gap.
    expect(res.body.series).toHaveLength(7);
    // Two of the seven days saw activity (today, and three days back), so
    // the other five are dense zeros rather than gaps.
    expect(res.body.series.filter((p: { activeUsers: number }) => p.activeUsers === 0)).toHaveLength(5);
  });

  it('refuses a caller without the capability', async () => {
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(assoc.email);
    expect((await a.get('/product-analytics/active-users')).status).toBe(403);
    // Workforce analytics is a different question and a different audience:
    // holding view:analytics must not hand over product telemetry.
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(fin.email);
    expect((await f.get('/product-analytics/active-users')).status).toBe(403);
  });

  it('bounds the window itself rather than trusting the caller', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    // An unbounded `days` is how a dashboard becomes an outage.
    const res = await a.get('/product-analytics/active-users?days=100000');
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(365);
    // And nonsense falls back to the default rather than erroring.
    const junk = await a.get('/product-analytics/active-users?days=banana');
    expect(junk.body.series).toHaveLength(30);
  });
});

describe('GET /product-analytics/traffic and /routes', () => {
  beforeEach(async () => {
    const today = dayOnly(new Date());
    await prisma.routeUsageDaily.createMany({
      data: [
        { day: today, method: 'GET', route: '/rides/:id', ok: 90, clientError: 5, serverError: 5, totalMs: BigInt(1000) },
        { day: today, method: 'GET', route: '/scheduling', ok: 300, clientError: 0, serverError: 0, totalMs: BigInt(6000) },
        // Too little traffic for a rate to mean anything.
        { day: today, method: 'POST', route: '/rare', ok: 0, clientError: 0, serverError: 1, totalMs: BigInt(10) },
      ],
    });
  });

  it('reports server errors as the error rate, not every 4xx', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/product-analytics/traffic?days=1');
    expect(res.status).toBe(200);
    const today = res.body.series.at(-1);
    expect(today.requests).toBe(401);
    expect(today.serverError).toBe(6);
    expect(today.clientError).toBe(5);
    expect(today.errorRate).toBeCloseTo(6 / 401, 4);
  });

  it('ranks what is used, and will not shame an endpoint over one call', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/product-analytics/routes?days=1');
    expect(res.status).toBe(200);
    expect(res.body.busiest[0].route).toBe('/scheduling');
    expect(res.body.busiest[0].requests).toBe(300);

    const failing = res.body.failing.map((r: { route: string }) => r.route);
    expect(failing).toContain('/rides/:id');
    // One 500 out of one call is a 100% error rate and tells nobody anything.
    expect(failing).not.toContain('/rare');
  });
});

describe('GET /product-analytics/adoption', () => {
  it('counts the accounts that were invited and never once used', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await createUser({ role: 'ASSOCIATE' });
    const { user: seen } = await createUser({ role: 'ASSOCIATE' });
    await prisma.user.update({ where: { id: seen.id }, data: { lastSeenAt: new Date() } });

    const a = await loginAs(hr.email);
    const res = await a.get('/product-analytics/adoption?days=30');
    expect(res.status).toBe(200);
    // hr signed in to make this call, so its lastSeenAt is set; one
    // associate has been seen, the other never has.
    expect(res.body.neverSignedIn).toBeGreaterThanOrEqual(1);
    expect(res.body.totalActiveAccounts).toBe(3);
  });
});
