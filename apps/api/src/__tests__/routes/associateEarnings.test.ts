import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { notifyClockOutEarnings } from '../../lib/associateEarnings.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Earnings motivation: GET /time/me/earnings turns the associate's week
 * into money (their comp rate, live + completed minutes, remaining
 * schedule), and the kiosk clock-out fires a private "you just added
 * ~$X" notification.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a
    .post('/auth/login')
    .send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

describe('associate earnings', () => {
  it('computes earned-so-far at the comp rate and projects the remaining schedule', async () => {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'Earning', lastName: 'Along' });
    await prisma.compensationRecord.create({
      data: {
        associateId: associate.id,
        payType: 'HOURLY',
        amount: 16,
        currency: 'USD',
        reason: 'HIRE',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const now = Date.now();
    // 2h completed today (in the current org week by construction).
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date(now - 2 * 3600_000),
        clockOutAt: new Date(now),
        status: 'COMPLETED',
      },
    });
    // A 4h shift starting in an hour — today's shift + remaining money.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'GM Afternoon Shift',
        startsAt: new Date(now + 3600_000),
        endsAt: new Date(now + 5 * 3600_000),
        status: 'ASSIGNED',
        assignedAssociateId: associate.id,
        publishedAt: new Date(),
      },
    });

    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const res = await (await loginAs(user.email)).get('/time/me/earnings');
    expect(res.status).toBe(200);
    expect(res.body.hourlyRate).toBe(16);
    expect(res.body.rateSource).toBe('comp');
    expect(res.body.earnedSoFar).toBeCloseTo(32, 1); // 2h × $16
    expect(res.body.todayShift).not.toBeNull();
    expect(res.body.todayShift.inProgress).toBe(false);
    // Projection = earned + remaining schedule (the shift may straddle
    // the week boundary on a Friday-evening run, so bound it instead of
    // pinning: never less than earned, never more than earned + 4h.
    expect(res.body.projectedWeek).toBeGreaterThanOrEqual(res.body.earnedSoFar);
    expect(res.body.projectedWeek).toBeLessThanOrEqual(32 + 4 * 16 + 0.5);
  });

  it("clock-out fires the private 'you just added' notification at the associate's rate", async () => {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'Just', lastName: 'Finished' });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date(Date.now() - 5 * 3600_000),
        clockOutAt: new Date(),
        status: 'COMPLETED',
      },
    });
    await notifyClockOutEarnings(prisma, entry.id);
    const notif = await prisma.notification.findFirst({
      where: { recipientUserId: user.id, category: 'earnings' },
    });
    expect(notif).not.toBeNull();
    // 5h at the org default $15 = $75.00.
    expect(notif!.subject).toContain('$75.00');
    expect(notif!.body).toContain('before taxes');
  });
});
