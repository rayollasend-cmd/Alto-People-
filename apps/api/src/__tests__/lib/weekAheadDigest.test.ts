import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runWeekAheadSweep } from '../../lib/weekAheadDigest.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// 2026-07-02 is a Thursday. 23:00 UTC = 7 PM EDT — past the default 17:00
// send hour, with "tomorrow" = Friday (dow 5) in Eastern.
const THU_EVENING = new Date('2026-07-02T23:00:00.000Z');
// 15:00 UTC = 11 AM EDT — before the send hour.
const THU_MORNING = new Date('2026-07-02T15:00:00.000Z');

async function seedAssociateWithUser(email: string) {
  const associate = await prisma.associate.create({
    data: {
      firstName: 'Wen',
      lastName: 'Ahead',
      email,
    },
  });
  const user = await prisma.user.create({
    data: {
      email,
      role: 'ASSOCIATE',
      status: 'ACTIVE',
      associateId: associate.id,
    },
  });
  return { associate, user };
}

async function seedClient(weekStartsOn: number) {
  return prisma.client.create({
    data: {
      name: `Week Mart ${Math.random().toString(36).slice(2, 6)}`,
      weekStartsOn,
    },
  });
}

async function seedShift(opts: {
  clientId: string;
  associateId: string;
  startsAt: Date;
}) {
  return prisma.shift.create({
    data: {
      clientId: opts.clientId,
      position: 'Front End',
      startsAt: opts.startsAt,
      endsAt: new Date(opts.startsAt.getTime() + 8 * 3_600_000),
      status: 'ASSIGNED',
      assignedAssociateId: opts.associateId,
      publishedAt: new Date('2026-06-30T12:00:00.000Z'),
    },
  });
}

describe('runWeekAheadSweep', () => {
  it('sends one digest per associate the evening before their client week', async () => {
    // Friday-start client (dow 5) — tomorrow relative to Thursday evening.
    const client = await seedClient(5);
    const { associate, user } = await seedAssociateWithUser('wen@example.com');
    // Two shifts inside the coming Fri–Thu week (Sat + Tue, 13:00 UTC = 9 AM EDT).
    await seedShift({
      clientId: client.id,
      associateId: associate.id,
      startsAt: new Date('2026-07-04T13:00:00.000Z'),
    });
    await seedShift({
      clientId: client.id,
      associateId: associate.id,
      startsAt: new Date('2026-07-07T13:00:00.000Z'),
    });
    // A shift BEYOND the 7-day window must not appear.
    await seedShift({
      clientId: client.id,
      associateId: associate.id,
      startsAt: new Date('2026-07-15T13:00:00.000Z'),
    });

    const first = await runWeekAheadSweep(prisma, THU_EVENING);
    await flushPendingNotifications();
    expect(first.sent).toBe(1);
    expect(first.shifts).toBe(2);

    const rows = await prisma.notification.findMany({
      where: { category: 'week_ahead', channel: 'IN_APP' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientUserId).toBe(user.id);
    expect(rows[0].subject).toContain('2 shifts');
    expect(rows[0].body).toContain('Front End');
    expect(rows[0].linkUrl).toBe('/scheduling');

    // Second sweep the same evening: claimed, no duplicate.
    const second = await runWeekAheadSweep(
      prisma,
      new Date(THU_EVENING.getTime() + 30 * 60_000),
    );
    expect(second.sent).toBe(0);
    // IN_APP only — the email pipeline records its own EMAIL-channel row
    // with the same category, which is delivery audit, not a duplicate.
    expect(
      await prisma.notification.count({
        where: { category: 'week_ahead', channel: 'IN_APP' },
      }),
    ).toBe(1);
  });

  it('does nothing before the send hour', async () => {
    const client = await seedClient(5);
    const { associate } = await seedAssociateWithUser('early@example.com');
    await seedShift({
      clientId: client.id,
      associateId: associate.id,
      startsAt: new Date('2026-07-04T13:00:00.000Z'),
    });
    const r = await runWeekAheadSweep(prisma, THU_MORNING);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe('before_hour');
  });

  it("ignores clients whose week doesn't start tomorrow", async () => {
    // Sunday-start client (dow 0) — Thursday evening is not their eve.
    const client = await seedClient(0);
    const { associate } = await seedAssociateWithUser('sunday@example.com');
    await seedShift({
      clientId: client.id,
      associateId: associate.id,
      startsAt: new Date('2026-07-04T13:00:00.000Z'),
    });
    const r = await runWeekAheadSweep(prisma, THU_EVENING);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe('no_shifts');
  });
});
