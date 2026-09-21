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

/**
 * The attendance record is a separate judgment from the alert.
 *
 * The 15-minute alert asks a supervisor to walk the floor. The
 * NO_CALL_NO_SHOW event says a person never came, carries 2.0 attendance
 * points and shows up on the client's reliability card — so it waits for
 * the shift to END with no punch anywhere near it, and is withdrawn if
 * the punch record later contradicts it.
 */
async function seedEndedShift(opts: {
  endedMinAgo: number;
  hours?: number;
}): Promise<{ shift: { id: string; startsAt: Date; endsAt: Date }; associateId: string }> {
  const associate = await prisma.associate.create({
    data: {
      firstName: 'Marcus',
      lastName: 'Webb',
      email: `ended-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    },
  });
  const client = await prisma.client.create({
    data: { name: `Ended Mart ${Math.random().toString(36).slice(2, 6)}` },
  });
  const endsAt = new Date(NOW.getTime() - opts.endedMinAgo * 60_000);
  const startsAt = new Date(endsAt.getTime() - (opts.hours ?? 8) * 3_600_000);
  const shift = await prisma.shift.create({
    data: {
      clientId: client.id,
      position: 'Front End',
      startsAt,
      endsAt,
      status: 'ASSIGNED',
      assignedAssociateId: associate.id,
      publishedAt: new Date(startsAt.getTime() - 24 * 3_600_000),
      // Already alerted — this suite is about the record pass.
      noShowNotifiedAt: startsAt,
    },
  });
  return {
    shift: { id: shift.id, startsAt: shift.startsAt, endsAt: shift.endsAt },
    associateId: associate.id,
  };
}

const ncnsCount = () =>
  prisma.attendanceEvent.count({ where: { kind: 'NO_CALL_NO_SHOW' } });

describe('no-call no-show attendance records', () => {
  it('writes nothing while the shift is still running', async () => {
    await seedAdmin();
    await seedShift({ startedMinAgo: 30 }); // 8h shift, hours left to go
    const r = await runShiftReminderSweep(prisma, NOW);
    expect(r.noShows).toBe(1); // supervisor still gets the nudge
    expect(r.noShowsRecorded).toBe(0);
    expect(await ncnsCount()).toBe(0);
  });

  it('records one after the shift ends with no punch at all', async () => {
    await seedAdmin();
    const { shift, associateId } = await seedEndedShift({ endedMinAgo: 60 });

    const first = await runShiftReminderSweep(prisma, NOW);
    expect(first.noShowsRecorded).toBe(1);
    const event = await prisma.attendanceEvent.findFirstOrThrow({
      where: { kind: 'NO_CALL_NO_SHOW' },
    });
    expect(event.associateId).toBe(associateId);
    expect(Number(event.points)).toBe(2);
    const stamped = await prisma.shift.findUnique({ where: { id: shift.id } });
    expect(stamped?.noShowRecordedAt).not.toBeNull();

    // Judged once.
    const second = await runShiftReminderSweep(
      prisma,
      new Date(NOW.getTime() + 20 * 60_000),
    );
    expect(second.noShowsRecorded).toBe(0);
    expect(await ncnsCount()).toBe(1);
  });

  it('never files one against someone who clocked in late', async () => {
    await seedAdmin();
    const { shift, associateId } = await seedEndedShift({ endedMinAgo: 60 });
    // Twenty minutes late — past the old 15-minute trigger, and exactly
    // the case that filled the reliability card with false no-shows.
    await prisma.timeEntry.create({
      data: {
        associateId,
        shiftId: shift.id,
        clockInAt: new Date(shift.startsAt.getTime() + 20 * 60_000),
        clockOutAt: shift.endsAt,
        status: 'COMPLETED',
      },
    });

    const r = await runShiftReminderSweep(prisma, NOW);
    expect(r.noShowsRecorded).toBe(0);
    expect(await ncnsCount()).toBe(0);
  });

  it('never files one when the punch was never linked to the shift', async () => {
    await seedAdmin();
    const { shift, associateId } = await seedEndedShift({ endedMinAgo: 60 });
    // Unlinked entry (kiosk matcher missed it) covering the shift window.
    await prisma.timeEntry.create({
      data: {
        associateId,
        clockInAt: new Date(shift.startsAt.getTime() + 5 * 60_000),
        clockOutAt: shift.endsAt,
        status: 'COMPLETED',
      },
    });

    const r = await runShiftReminderSweep(prisma, NOW);
    expect(r.noShowsRecorded).toBe(0);
    expect(await ncnsCount()).toBe(0);
  });

  it('withdraws an earlier no-show when the timesheet lands afterwards', async () => {
    await seedAdmin();
    const { shift, associateId } = await seedEndedShift({ endedMinAgo: 90 });
    // The sweep already judged it and filed the event.
    const first = await runShiftReminderSweep(prisma, NOW);
    expect(first.noShowsRecorded).toBe(1);
    expect(await ncnsCount()).toBe(1);

    // An admin keys in the timesheet that evening.
    await prisma.timeEntry.create({
      data: {
        associateId,
        shiftId: shift.id,
        clockInAt: shift.startsAt,
        clockOutAt: shift.endsAt,
        status: 'COMPLETED',
      },
    });

    const second = await runShiftReminderSweep(
      prisma,
      new Date(NOW.getTime() + 4 * 3_600_000),
    );
    expect(second.noShowsWithdrawn).toBe(1);
    expect(await ncnsCount()).toBe(0);
  });

  it('leaves a hand-recorded no-show alone', async () => {
    await seedAdmin();
    const { shift, associateId } = await seedEndedShift({ endedMinAgo: 90 });
    // A human recorded this one; a punch turning up is a conversation for
    // people to have, not something the sweep may overturn.
    await prisma.attendanceEvent.create({
      data: {
        associateId,
        shiftId: shift.id,
        kind: 'NO_CALL_NO_SHOW',
        points: 2,
        occurredOn: shift.startsAt,
        source: 'MANUAL',
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId,
        shiftId: shift.id,
        clockInAt: shift.startsAt,
        clockOutAt: shift.endsAt,
        status: 'COMPLETED',
      },
    });

    const r = await runShiftReminderSweep(prisma, NOW);
    expect(r.noShowsWithdrawn).toBe(0);
    expect(await ncnsCount()).toBe(1);
  });
});
