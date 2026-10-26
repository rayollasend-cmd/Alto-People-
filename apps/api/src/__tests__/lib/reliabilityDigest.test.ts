import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RELIABILITY_DIGEST_CATEGORY,
  RELIABILITY_DIGEST_ROLES,
  clearCustomerReliabilityDigests,
  reliabilityDigestBody,
  reliabilityDigestSubject,
  reliabilityWeekLabel,
  runReliabilityDigestSweep,
} from '../../lib/reliabilityDigest.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { startOfWeekUTC } from '../../lib/timeAnomalies.js';
import { emptyLatencyHistogram, latencyBucket } from '../../lib/usageTracker.js';
import { prisma, truncateAll } from '../../../test/db.js';

/**
 * The Saturday reliability summary. It goes to the people who can open
 * the dashboard, once per org week, and it leaves the closed week's
 * numbers behind in ReliabilityWeek so the budget streak is a row count.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

// 2026-07-04 is a Saturday; 15:00 UTC is 11 AM Eastern, past the 8 AM gate.
const SATURDAY = new Date('2026-07-04T15:00:00.000Z');
const SATURDAY_EARLY = new Date('2026-07-04T10:00:00.000Z'); // 6 AM Eastern
const WEDNESDAY = new Date('2026-07-08T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

async function seedUser(role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' | 'OPERATIONS_MANAGER', email: string, tenantId?: string) {
  return prisma.user.create({ data: { email, role, status: 'ACTIVE', ...(tenantId ? { tenantId } : {}) } });
}

const CUSTOMER_TENANT = '33333333-3333-4333-8333-333333333333';

describe('runReliabilityDigestSweep', () => {
  it('goes to the roles that hold product analytics, once per week, and snapshots the closed week', async () => {
    const hr = await seedUser('HR_ADMINISTRATOR', 'hr@digest.test');
    const chair = await seedUser('EXECUTIVE_CHAIRMAN', 'chair@digest.test');
    await seedUser('OPERATIONS_MANAGER', 'ops@digest.test');
    // A customer's HR admin holds the same role — and is never paged about the platform.
    await prisma.tenant.create({ data: { id: CUSTOMER_TENANT, slug: 'acme-digest', name: 'Acme', plan: 'standard' } });
    await seedUser('HR_ADMINISTRATOR', 'hr@acme-digest.test', CUSTOMER_TENANT);
    expect(RELIABILITY_DIGEST_ROLES).toEqual(expect.arrayContaining(['HR_ADMINISTRATOR', 'EXECUTIVE_CHAIRMAN']));
    expect(RELIABILITY_DIGEST_ROLES).not.toContain('OPERATIONS_MANAGER');

    // Last week's traffic: the closed org week before Saturday the 4th.
    const thisWeek = startOfWeekUTC(SATURDAY);
    const lastWeekDay = new Date(thisWeek.getTime() - 3 * DAY);
    const histogram = emptyLatencyHistogram();
    histogram[latencyBucket(400)] = 50;
    await prisma.routeUsageDaily.create({
      data: {
        day: new Date(`${lastWeekDay.toISOString().slice(0, 10)}T00:00:00.000Z`),
        method: 'GET',
        route: '/time/me',
        ok: 48,
        serverError: 2,
        totalMs: BigInt(50 * 400),
        histogram,
      },
    });
    await prisma.apiBoot.create({ data: { version: 'v1', nodeVersion: 'v24', bootAt: lastWeekDay } });

    const first = await runReliabilityDigestSweep(prisma, SATURDAY);
    await flushPendingNotifications();
    expect(first.sent).toBe(2);
    expect(first.weekStart).toBe(startOfWeekUTC(lastWeekDay).toISOString());

    // The bell rows; the email rows ride alongside under the same category.
    const rows = await prisma.notification.findMany({ where: { category: RELIABILITY_DIGEST_CATEGORY, channel: 'IN_APP' } });
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual([hr.id, chair.id].sort());
    expect(rows[0]!.subject).toBe('Weekly reliability: error tracking is not connected');
    expect(rows[0]!.body).toContain('Requests that failed on our side: 2 of 50.');
    // Plain words in a bell: no routes, timings, restart counts or setup variables.
    expect(rows[0]!.body).not.toMatch(/GET \/|ms\b|restarts: |SENTRY_|5xx/);
    expect(rows[0]!.linkUrl).toBe('/reliability');

    const snapshot = await prisma.reliabilityWeek.findUniqueOrThrow({ where: { weekStart: startOfWeekUTC(lastWeekDay) } });
    expect(snapshot).toMatchObject({ sentryErrors: null, serverErrors: 2, requests: 50, restarts: 1, underBudget: false });
    expect(snapshot.p95TopRoutes).toEqual([{ method: 'GET', route: '/time/me', requests: 50, p95Ms: 400 }]);

    // Same Saturday, later: nothing more.
    const again = await runReliabilityDigestSweep(prisma, new Date(SATURDAY.getTime() + 3_600_000));
    expect(again).toEqual({ sent: 0, skipped: 'already_sent' });
  });

  it('waits for Saturday morning', async () => {
    await seedUser('HR_ADMINISTRATOR', 'hr@digest.test');
    expect(await runReliabilityDigestSweep(prisma, WEDNESDAY)).toEqual({ sent: 0, skipped: 'not_saturday' });
    expect(await runReliabilityDigestSweep(prisma, SATURDAY_EARLY)).toEqual({ sent: 0, skipped: 'too_early' });
    expect(await prisma.reliabilityWeek.count()).toBe(0);
  });

  it('has nobody to tell when no one holds the capability', async () => {
    await seedUser('OPERATIONS_MANAGER', 'ops@digest.test');
    expect(await runReliabilityDigestSweep(prisma, SATURDAY)).toEqual({ sent: 0, skipped: 'no_recipients' });
  });

  it("never tells a customer tenant's admins, however their role reads", async () => {
    await prisma.tenant.create({ data: { id: CUSTOMER_TENANT, slug: 'acme-digest', name: 'Acme', plan: 'standard' } });
    await seedUser('HR_ADMINISTRATOR', 'hr@acme-digest.test', CUSTOMER_TENANT);
    expect(await runReliabilityDigestSweep(prisma, SATURDAY)).toEqual({ sent: 0, skipped: 'no_recipients' });
    expect(await prisma.notification.count({ where: { category: RELIABILITY_DIGEST_CATEGORY } })).toBe(0);
  });

  it("takes the digests sent before the fence out of customers' bells, and leaves the operator's", async () => {
    await prisma.tenant.create({ data: { id: CUSTOMER_TENANT, slug: 'acme-digest', name: 'Acme', plan: 'standard' } });
    const theirs = await seedUser('HR_ADMINISTRATOR', 'hr@acme-digest.test', CUSTOMER_TENANT);
    const ours = await seedUser('HR_ADMINISTRATOR', 'hr@digest.test');
    const row = (u: { id: string }, tenantId?: string) => ({
      recipientUserId: u.id,
      channel: 'IN_APP' as const,
      status: 'SENT' as const,
      subject: 'Weekly reliability: Sentry not connected',
      body: 'Set SENTRY_AUTH_TOKEN …',
      category: RELIABILITY_DIGEST_CATEGORY,
      ...(tenantId ? { tenantId } : {}),
    });
    await prisma.notification.create({ data: row(theirs, CUSTOMER_TENANT) });
    await prisma.notification.create({ data: row(ours) });
    expect(await clearCustomerReliabilityDigests(prisma)).toBe(1);
    const left = await prisma.notification.findMany({ where: { category: RELIABILITY_DIGEST_CATEGORY }, select: { recipientUserId: true } });
    expect(left.map((n) => n.recipientUserId)).toEqual([ours.id]);
  });
});

describe('reliabilityDigestBody', () => {
  const facts = {
    weekStart: new Date('2026-06-27T04:00:00.000Z'),
    weekEnd: new Date('2026-07-04T04:00:00.000Z'),
    serverErrors: 1,
    requests: 1200,
    busiest: [{ method: 'GET', route: '/time/me', requests: 300, serverError: 0, avgMs: 90, p95Ms: 200 }],
    punchTotal: 80,
    punchAccepted: 76,
    rideTotal: 40,
    rideCompleted: 38,
    rideNoShow: 2,
    rideUnresolved: 0,
    restarts: 0,
  };

  it('judges the week against the budget and names the streak', () => {
    const body = reliabilityDigestBody(facts, 4, 3);
    expect(body).toContain('Week of Jun 27 – Jul 3: 4 errors against a budget of 10 a week — within budget.');
    expect(body).toContain('3 weeks in a row under budget');
    expect(body).toContain('Requests that failed on our side: 1 of 1,200.');
    expect(body).toContain('Kiosk punches: 95% accepted (76 of 80).');
    expect(body).toContain('Rides: 95% completed (38 of 40, 2 no-shows).');
    expect(reliabilityDigestBody(facts, 14, 0)).toContain('over budget. The streak starts again.');
    expect(reliabilityDigestBody(facts, 1, 1)).toContain('1 error against a budget of 10 a week — within budget. That makes 1 week in a row');
    expect(reliabilityDigestBody({ ...facts, rideNoShow: 1, rideCompleted: 39 }, 1, 1)).toContain('(39 of 40, 1 no-show)');
  });

  it('says plainly when error tracking is not connected — without naming setup variables', () => {
    const body = reliabilityDigestBody(facts, null, null);
    expect(body).toContain('error tracking is not connected');
    expect(body).not.toContain('SENTRY');
    expect(body).not.toContain('Sentry');
    expect(body).not.toMatch(/\d+ ms\b/);
    expect(body).not.toMatch(/restart/i);
  });

  it('names the subject and the week in words', () => {
    expect(reliabilityDigestSubject(null)).toBe('Weekly reliability: error tracking is not connected');
    expect(reliabilityDigestSubject(1)).toBe('Weekly reliability: 1 error, within budget');
    expect(reliabilityDigestSubject(12)).toBe('Weekly reliability: 12 errors, over budget');
    expect(reliabilityWeekLabel(new Date('2026-10-17T04:00:00.000Z'), new Date('2026-10-24T04:00:00.000Z'))).toBe('Oct 17 – 23');
    expect(reliabilityWeekLabel(new Date('2026-09-26T04:00:00.000Z'), new Date('2026-10-03T04:00:00.000Z'))).toBe('Sep 26 – Oct 2');
  });
});
