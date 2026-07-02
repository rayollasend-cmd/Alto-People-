import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runScheduleDigestSweep } from '../../lib/scheduleDigest.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// 15:00 UTC = 10/11 AM Eastern — safely past the default 6 AM digest hour
// in both EST and EDT, and mid-local-day so "today" is unambiguous.
const NOW = new Date('2026-07-02T15:00:00.000Z');
// 03:00 UTC = 10/11 PM Eastern THE PREVIOUS local day... actually 2026-07-02
// 03:00 UTC is 23:00 on 07-01 Eastern — before any digest hour that local day.
const BEFORE_HOUR = new Date('2026-07-02T09:00:00.000Z'); // 5 AM EDT

async function seedAdmin(email = 'admin@digest.test') {
  return prisma.user.create({
    data: { email, role: 'HR_ADMINISTRATOR', status: 'ACTIVE' },
  });
}

async function seedShiftToday(opts: {
  status?: 'ASSIGNED' | 'OPEN';
  acknowledged?: boolean;
  associateName?: string;
}) {
  const client = await prisma.client.create({
    data: { name: `Digest Mart ${Math.random().toString(36).slice(2, 6)}` },
  });
  let associateId: string | null = null;
  if (opts.status !== 'OPEN') {
    const a = await prisma.associate.create({
      data: {
        firstName: opts.associateName?.split(' ')[0] ?? 'Dana',
        lastName: opts.associateName?.split(' ')[1] ?? 'Diaz',
        email: `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      },
    });
    associateId = a.id;
  }
  return prisma.shift.create({
    data: {
      clientId: client.id,
      position: 'Front End',
      // 13:00–21:00 UTC on 2026-07-02 = 9 AM–5 PM EDT, same local day as NOW.
      startsAt: new Date('2026-07-02T13:00:00.000Z'),
      endsAt: new Date('2026-07-02T21:00:00.000Z'),
      status: opts.status ?? 'ASSIGNED',
      assignedAssociateId: associateId,
      publishedAt: new Date('2026-07-01T12:00:00.000Z'),
      acknowledgedAt: opts.acknowledged ? new Date('2026-07-01T13:00:00.000Z') : null,
    },
  });
}

describe('runScheduleDigestSweep', () => {
  it('sends one digest per admin with roster + counts, then dedupes', async () => {
    const admin = await seedAdmin();
    await seedShiftToday({ associateName: 'Dana Diaz', acknowledged: true });
    await seedShiftToday({ status: 'OPEN' });

    const first = await runScheduleDigestSweep(prisma, NOW);
    await flushPendingNotifications();
    expect(first.sent).toBe(true);
    expect(first.recipients).toBe(1);
    expect(first.shifts).toBe(2);

    const rows = await prisma.notification.findMany({
      where: { category: 'schedule_digest', channel: 'IN_APP' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientUserId).toBe(admin.id);
    expect(rows[0].linkUrl).toBe('/scheduling');
    expect(rows[0].subject).toContain('2 shifts');
    expect(rows[0].subject).toContain('1 filled');
    expect(rows[0].subject).toContain('1 open');
    expect(rows[0].body).toContain('Dana Diaz');
    expect(rows[0].body).toContain('OPEN — needs someone');

    // Same day, later sweep → no second digest.
    const second = await runScheduleDigestSweep(
      prisma,
      new Date(NOW.getTime() + 3_600_000),
    );
    expect(second.sent).toBe(false);
    expect(second.skipped).toBe('already_sent');
    const after = await prisma.notification.count({
      where: { category: 'schedule_digest', channel: 'IN_APP' },
    });
    expect(after).toBe(1);
  });

  it('flags published-but-unconfirmed shifts', async () => {
    await seedAdmin();
    await seedShiftToday({ associateName: 'Sam Cruz', acknowledged: false });
    const r = await runScheduleDigestSweep(prisma, NOW);
    await flushPendingNotifications();
    expect(r.sent).toBe(true);
    const row = await prisma.notification.findFirst({
      where: { category: 'schedule_digest', channel: 'IN_APP' },
    });
    expect(row?.subject).toContain('1 unconfirmed');
    expect(row?.body).toContain('Sam Cruz (unconfirmed)');
  });

  it('waits for the digest hour', async () => {
    await seedAdmin();
    await seedShiftToday({});
    const r = await runScheduleDigestSweep(prisma, BEFORE_HOUR);
    expect(r.sent).toBe(false);
    expect(r.skipped).toBe('disabled_hour');
  });

  it('sends nothing (and claims nothing) on a day with no shifts', async () => {
    await seedAdmin();
    const r = await runScheduleDigestSweep(prisma, NOW);
    expect(r.sent).toBe(false);
    expect(r.skipped).toBe('no_shifts');

    // A schedule published later the same morning still gets its digest.
    await seedShiftToday({});
    const later = await runScheduleDigestSweep(
      prisma,
      new Date(NOW.getTime() + 3_600_000),
    );
    await flushPendingNotifications();
    expect(later.sent).toBe(true);
  });

  it('excludes yesterday and tomorrow from today\'s digest', async () => {
    await seedAdmin();
    const client = await prisma.client.create({ data: { name: 'Window Mart' } });
    // 2026-07-03 13:00 UTC = tomorrow Eastern; 2026-07-01 13:00 = yesterday.
    for (const day of ['2026-07-01', '2026-07-03']) {
      await prisma.shift.create({
        data: {
          clientId: client.id,
          position: 'Front End',
          startsAt: new Date(`${day}T13:00:00.000Z`),
          endsAt: new Date(`${day}T21:00:00.000Z`),
          status: 'OPEN',
          publishedAt: new Date('2026-06-30T12:00:00.000Z'),
        },
      });
    }
    const r = await runScheduleDigestSweep(prisma, NOW);
    expect(r.sent).toBe(false);
    expect(r.skipped).toBe('no_shifts');
  });
});
