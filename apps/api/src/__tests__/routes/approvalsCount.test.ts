import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /approvals/count', () => {
  it('sums the manager queues', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const associate = await prisma.associate.create({
      data: {
        firstName: 'Count',
        lastName: 'Case',
        email: `cc-${Date.now()}@example.com`,
      },
    });
    await prisma.timeOffRequest.create({
      data: {
        associateId: associate.id,
        category: 'PTO',
        startDate: new Date('2026-07-10T00:00:00.000Z'),
        endDate: new Date('2026-07-10T00:00:00.000Z'),
        requestedMinutes: 480,
        status: 'PENDING',
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        // Relative to today: the badge counts the last 90 days, and a fixed
        // July date fell out of that window on its own.
        clockInAt: new Date(Date.now() - 7 * 86_400_000),
        clockOutAt: new Date(Date.now() - 7 * 86_400_000 + 8 * 3_600_000),
        status: 'COMPLETED',
      },
    });

    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.get('/approvals/count');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      swaps: 0,
      pickups: 0,
      timeOff: 1,
      timesheets: 1,
      clockIns: 0,
      total: 2,
    });
  });

  it('403s associates', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.get('/approvals/count');
    expect(res.status).toBe(403);
  });
});
