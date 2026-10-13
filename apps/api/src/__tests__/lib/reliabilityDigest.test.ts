import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RELIABILITY_DIGEST_CATEGORY,
  RELIABILITY_DIGEST_ROLES,
  reliabilityDigestBody,
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

async function seedUser(role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' | 'OPERATIONS_MANAGER', email: string) {
  return prisma.user.create({ data: { email, role, status: 'ACTIVE' } });
}

describe('runReliabilityDigestSweep', () => {
  it('goes to the roles that hold product analytics, once per week, and snapshots the closed week', async () => {
    const hr = await seedUser('HR_ADMINISTRATOR', 'hr@digest.test');
    const chair = await seedUser('EXECUTIVE_CHAIRMAN', 'chair@digest.test');
    await seedUser('OPERATIONS_MANAGER', 'ops@digest.test');
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
    expect(rows[0]!.subject).toContain('Sentry not connected');
    expect(rows[0]!.body).toContain('GET /time/me — 400 ms (50 calls)');
    expect(rows[0]!.body).toContain('API restarts: 1');
    expect(rows[0]!.body).toContain('Server errors (5xx): 2 of 50 requests');
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
    expect(body).toContain('4 errors in Sentry against a budget of 10 — within budget.');
    expect(body).toContain('3 weeks in a row under budget');
    expect(body).toContain('Kiosk punches: 95% accepted (76 of 80).');
    expect(body).toContain('Rides: 95% completed (38 of 40, 2 no-show).');
    expect(reliabilityDigestBody(facts, 14, 0)).toContain('OVER budget. The streak resets.');
  });

  it('says plainly when Sentry is not connected', () => {
    const body = reliabilityDigestBody(facts, null, null);
    expect(body).toContain('Sentry is not connected');
    expect(body).toContain('SENTRY_AUTH_TOKEN');
  });
});
