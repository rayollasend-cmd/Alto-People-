import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runAutoClockOutSweep, AUTO_CLOCKOUT_GRACE_MIN } from '../../lib/autoClockOut.js';
import {
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Shift-aware auto clock-out: an ACTIVE entry whose linked shift ended
 * 10+ minutes ago closes AT THE SHIFT'S SCHEDULED END, wears the
 * FORGOT_CLOCKOUT anomaly, notes itself, and tells the associate. Fresh
 * shifts and in-grace entries are untouched.
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('runAutoClockOutSweep', () => {
  it('closes at shift end with the anomaly + note + associate notification', async () => {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'For', lastName: 'Got' });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const now = Date.now();
    const shiftEnd = new Date(now - 30 * 60_000); // ended 30 min ago
    const shift = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'GM Evening Shift',
        startsAt: new Date(now - 8.5 * 3600_000),
        endsAt: shiftEnd,
        status: 'ASSIGNED',
        assignedAssociateId: associate.id,
        publishedAt: new Date(now - 24 * 3600_000),
      },
    });
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        shiftId: shift.id,
        clockInAt: new Date(now - 8.5 * 3600_000),
        status: 'ACTIVE',
      },
    });

    const result = await runAutoClockOutSweep(prisma, new Date(now));
    expect(result.closed).toBe(1);

    const after = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.status).toBe('COMPLETED');
    // Closed at the SHIFT'S scheduled end — not the sweep instant.
    expect(after.clockOutAt!.getTime()).toBe(shiftEnd.getTime());
    expect(after.anomalies).toContain('FORGOT_CLOCKOUT');
    expect(after.notes).toContain('Auto clocked out at shift end');

    const notif = await prisma.notification.findFirst({
      where: { recipientUserId: user.id, category: 'time_entry' },
    });
    expect(notif).not.toBeNull();
    expect(notif!.body).toContain('forgot to punch out');
  });

  it('leaves in-grace and still-running shifts alone', async () => {
    const client = await createClient();
    const a1 = await createAssociate({ firstName: 'In', lastName: 'Grace' });
    const a2 = await createAssociate({ firstName: 'Still', lastName: 'Working' });
    const now = Date.now();
    const graceShift = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'GM',
        startsAt: new Date(now - 8 * 3600_000),
        // Ended INSIDE the grace window — must not close yet.
        endsAt: new Date(now - (AUTO_CLOCKOUT_GRACE_MIN - 2) * 60_000),
        status: 'ASSIGNED',
        assignedAssociateId: a1.id,
        publishedAt: new Date(),
      },
    });
    const liveShift = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'GM',
        startsAt: new Date(now - 2 * 3600_000),
        endsAt: new Date(now + 4 * 3600_000),
        status: 'ASSIGNED',
        assignedAssociateId: a2.id,
        publishedAt: new Date(),
      },
    });
    await prisma.timeEntry.createMany({
      data: [
        {
          associateId: a1.id,
          clientId: client.id,
          shiftId: graceShift.id,
          clockInAt: new Date(now - 8 * 3600_000),
          status: 'ACTIVE',
        },
        {
          associateId: a2.id,
          clientId: client.id,
          shiftId: liveShift.id,
          clockInAt: new Date(now - 2 * 3600_000),
          status: 'ACTIVE',
        },
      ],
    });

    const result = await runAutoClockOutSweep(prisma, new Date(now));
    expect(result.closed).toBe(0);
    expect(await prisma.timeEntry.count({ where: { status: 'ACTIVE' } })).toBe(2);
  });
});
