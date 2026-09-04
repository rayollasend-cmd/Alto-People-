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

describe('overtime-aware earnings (fixed past week — no clock dependence)', () => {
  // computeAssociateEarnings takes `now`, so these tests pin a completed
  // week in the past and are deterministic on any CI run day.
  const REF = new Date('2026-08-26T12:00:00Z'); // a Wednesday

  it('pays hours past 40 at 1.5× in earnedSoFar and flags the unlock', async () => {
    const { computeAssociateEarnings } = await import('../../lib/associateEarnings.js');
    const { startOfWeekUTC } = await import('../../lib/timeAnomalies.js');
    const weekStart = startOfWeekUTC(REF);
    const fixedNow = new Date(weekStart.getTime() + 6 * 24 * 3600_000); // Friday-ish

    const client = await createClient();
    const associate = await createAssociate();
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
    // 45h across the week: 5 × 9h, chronological.
    let cursor = weekStart.getTime();
    for (let i = 0; i < 5; i++) {
      await prisma.timeEntry.create({
        data: {
          associateId: associate.id,
          clientId: client.id,
          clockInAt: new Date(cursor),
          clockOutAt: new Date(cursor + 9 * 3600_000),
          status: 'APPROVED',
        },
      });
      cursor += 24 * 3600_000;
    }

    const e = await computeAssociateEarnings(prisma, associate.id, fixedNow);
    // 40h × $16 + 5h × $24 = 640 + 120.
    expect(e.earnedSoFar).toBeCloseTo(760, 1);
    expect(e.overtime.unlocked).toBe(true);
    expect(e.overtime.otHoursSoFar).toBeCloseTo(5, 1);
    expect(e.currentRatePerHour).toBeCloseTo(24, 2);
    // Day bars: 7 buckets whose worked amounts sum to the OT-aware total.
    expect(e.days).toHaveLength(7);
    const sum = e.days.reduce((s, d) => s + d.workedAmount, 0);
    expect(sum).toBeCloseTo(e.earnedSoFar, 1);
    // The 5th day (first to cross 40h) is worth more than the 1st.
    expect(e.days[4].workedAmount).toBeGreaterThan(e.days[0].workedAmount);
  });

  it('returns last week as the pace to beat (OT-aware, zero-based clock)', async () => {
    const { computeAssociateEarnings } = await import('../../lib/associateEarnings.js');
    const { startOfWeekUTC } = await import('../../lib/timeAnomalies.js');
    const weekStart = startOfWeekUTC(REF);
    const fixedNow = new Date(weekStart.getTime() + 3 * 24 * 3600_000);

    const client = await createClient();
    const associate = await createAssociate();
    // 8h in the PRIOR week at the org default $15 → $120 to beat.
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date(weekStart.getTime() - 3 * 24 * 3600_000),
        clockOutAt: new Date(weekStart.getTime() - 3 * 24 * 3600_000 + 8 * 3600_000),
        status: 'APPROVED',
      },
    });
    // 2h this week.
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date(weekStart.getTime() + 24 * 3600_000),
        clockOutAt: new Date(weekStart.getTime() + 26 * 3600_000),
        status: 'COMPLETED',
      },
    });

    const e = await computeAssociateEarnings(prisma, associate.id, fixedNow);
    expect(e.lastWeekEarned).toBeCloseTo(120, 1);
    expect(e.earnedSoFar).toBeCloseTo(30, 1);
    expect(e.onClock).toBe(false);
  });

  it('clock-out notification includes the 1.5× premium once the week crossed 40h', async () => {
    const { startOfWeekUTC } = await import('../../lib/timeAnomalies.js');
    const weekStart = startOfWeekUTC(REF);

    const client = await createClient();
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    // 40h earlier in the fixed week…
    let cursor = weekStart.getTime();
    for (let i = 0; i < 5; i++) {
      await prisma.timeEntry.create({
        data: {
          associateId: associate.id,
          clientId: client.id,
          clockInAt: new Date(cursor),
          clockOutAt: new Date(cursor + 8 * 3600_000),
          status: 'APPROVED',
        },
      });
      cursor += 24 * 3600_000;
    }
    // …then a 4h entry on day 6: all four hours are overtime. The helper
    // derives the week from the entry's own clockOutAt, so the fixture
    // being in the past is fine.
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date(weekStart.getTime() + 5 * 24 * 3600_000),
        clockOutAt: new Date(weekStart.getTime() + 5 * 24 * 3600_000 + 4 * 3600_000),
        status: 'COMPLETED',
      },
    });
    await notifyClockOutEarnings(prisma, entry.id);
    const notif = await prisma.notification.findFirst({
      where: { recipientUserId: user.id, category: 'earnings' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notif).not.toBeNull();
    // 4h × $15 × 1.5 = $90.00, and the body says why.
    expect(notif!.subject).toContain('$90.00');
    expect(notif!.body).toContain('overtime at 1.5×');
  });
});

describe('open shifts money (live clock — the eligibility rule needs real future)', () => {
  it("prices this week's eligible open shifts on the marketplace rule", async () => {
    const client = await createClient();
    const associate = await createAssociate();
    const { endOfWeekUTC } = await import('../../lib/timeAnomalies.js');
    const weekEnd = endOfWeekUTC(new Date()).getTime();
    const startsAt = new Date(Date.now() + 30 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 4 * 3600_000);
    // In the final hours of an org week the 4h shift won't fit before the
    // boundary — assert the honest zero instead of skipping silently.
    const fits = startsAt.getTime() < weekEnd;
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Stocker',
        startsAt,
        endsAt,
        status: 'OPEN',
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
    if (fits) {
      expect(res.body.openShifts.count).toBe(1);
      // 4h at the org default $15 (no OT in play).
      expect(res.body.openShifts.estAmount).toBeCloseTo(60, 1);
    } else {
      expect(res.body.openShifts.count).toBe(0);
    }
  });
});
