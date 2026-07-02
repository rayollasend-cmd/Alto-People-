import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runShiftReminderSweep } from '../../lib/shiftReminder.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const NOW = new Date('2026-07-02T15:00:00.000Z');

async function seedAdmin() {
  return prisma.user.create({
    data: { email: `admin-${Date.now()}@noshow.test`, role: 'HR_ADMINISTRATOR', status: 'ACTIVE' },
  });
}

async function seedShift(opts: { startedMinAgo: number; linkedEntry?: boolean }) {
  const associate = await prisma.associate.create({
    data: {
      firstName: 'Nadia',
      lastName: 'Ortiz',
      email: `no-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    },
  });
  const client = await prisma.client.create({
    data: { name: `NoShow Mart ${Math.random().toString(36).slice(2, 6)}` },
  });
  const startsAt = new Date(NOW.getTime() - opts.startedMinAgo * 60_000);
  const shift = await prisma.shift.create({
    data: {
      clientId: client.id,
      position: 'Front End',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 8 * 3_600_000),
      status: 'ASSIGNED',
      assignedAssociateId: associate.id,
      publishedAt: new Date(NOW.getTime() - 24 * 3_600_000),
    },
  });
  if (opts.linkedEntry) {
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        shiftId: shift.id,
        clockInAt: startsAt,
        status: 'ACTIVE',
      },
    });
  }
  return { shift, associate };
}

describe('no-show detection in the shift reminder sweep', () => {
  it('alerts admins once for an unlinked shift past the grace window', async () => {
    const admin = await seedAdmin();
    const { shift } = await seedShift({ startedMinAgo: 30 });

    const first = await runShiftReminderSweep(prisma, NOW);
    await flushPendingNotifications();
    expect(first.noShows).toBe(1);

    const rows = await prisma.notification.findMany({
      where: { category: 'shift_no_show', channel: 'IN_APP' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientUserId).toBe(admin.id);
    expect(rows[0].subject).toContain('Nadia Ortiz');
    expect(rows[0].body).toContain("hasn't clocked in");

    const stamped = await prisma.shift.findUnique({ where: { id: shift.id } });
    expect(stamped?.noShowNotifiedAt).not.toBeNull();

    // Second sweep: already claimed, no duplicate alert.
    const second = await runShiftReminderSweep(
      prisma,
      new Date(NOW.getTime() + 15 * 60_000),
    );
    expect(second.noShows).toBe(0);
    const after = await prisma.notification.count({
      where: { category: 'shift_no_show', channel: 'IN_APP' },
    });
    expect(after).toBe(1);
  });

  it('does not alert inside the 15-minute grace window', async () => {
    await seedAdmin();
    await seedShift({ startedMinAgo: 10 });
    const r = await runShiftReminderSweep(prisma, NOW);
    expect(r.noShows).toBe(0);
  });

  it('does not alert when a punch is linked to the shift', async () => {
    await seedAdmin();
    await seedShift({ startedMinAgo: 30, linkedEntry: true });
    const r = await runShiftReminderSweep(prisma, NOW);
    expect(r.noShows).toBe(0);
    expect(
      await prisma.notification.count({ where: { category: 'shift_no_show' } }),
    ).toBe(0);
  });

  it('stamps without alerting when the associate has an unlinked open entry', async () => {
    await seedAdmin();
    const { shift, associate } = await seedShift({ startedMinAgo: 30 });
    // Punched in early enough that the matcher missed the link — they ARE
    // at work, so no alarm, but the shift still gets stamped as resolved.
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clockInAt: new Date(NOW.getTime() - 4 * 3_600_000),
        status: 'ACTIVE',
      },
    });
    const r = await runShiftReminderSweep(prisma, NOW);
    expect(r.noShows).toBe(0);
    expect(
      await prisma.notification.count({ where: { category: 'shift_no_show' } }),
    ).toBe(0);
    const stamped = await prisma.shift.findUnique({ where: { id: shift.id } });
    expect(stamped?.noShowNotifiedAt).not.toBeNull();
  });
});
