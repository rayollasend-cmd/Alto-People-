import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runDormancySweep } from '../../lib/dormancySweep.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Dormancy auto-deactivation: 30 idle days (default env) deactivates,
 * with a standing admin warning required ≥7 days beforehand. Any sign of
 * life — clock-in, worked or upcoming shift, claim, punch, approved
 * leave, recent reactivation — takes the associate out of the sweep, and
 * activity after a warning re-arms a fresh one.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T12:00:00Z');

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Hired long ago, zero activity since — the canonical dormant associate. */
async function seedDormant(opts: { idleDays?: number; firstName?: string } = {}) {
  const idleDays = opts.idleDays ?? 60;
  const associate = await prisma.associate.create({
    data: {
      firstName: opts.firstName ?? 'Gone',
      lastName: 'Quiet',
      email: `dormant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      hireDate: new Date(NOW.getTime() - idleDays * DAY),
      createdAt: new Date(NOW.getTime() - idleDays * DAY),
    },
  });
  const { user } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  return { associate, user };
}

describe('runDormancySweep — two-stage warn then deactivate', () => {
  it('warns first (stamp + admin notice, no deactivation), then deactivates once the warning is a week old', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { associate, user } = await seedDormant({ firstName: 'Gabriela' });

    const first = await runDormancySweep(prisma, NOW);
    expect(first.errors).toEqual([]);
    expect(first.warned).toBe(1);
    expect(first.deactivated).toBe(0);

    let a = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(a.dormancyWarnedAt).not.toBeNull();
    expect(a.deactivatedAt).toBeNull();

    const warning = await prisma.notification.findFirst({
      where: { recipientUserId: admin.id, category: 'dormancy' },
    });
    expect(warning).not.toBeNull();
    expect(warning!.body).toContain('Gabriela Quiet');

    // Same sweep again immediately: warning stands, still too fresh to act.
    const second = await runDormancySweep(prisma, NOW);
    expect(second.warned).toBe(0);
    expect(second.deactivated).toBe(0);

    // Eight days later: warning is old enough, still no activity → deactivate.
    const third = await runDormancySweep(prisma, new Date(NOW.getTime() + 8 * DAY));
    expect(third.errors).toEqual([]);
    expect(third.deactivated).toBe(1);

    a = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(a.deactivatedAt).not.toBeNull();
    expect(a.deactivatedById).toBeNull();
    expect(a.deactivationReason).toContain('Auto-deactivated');

    const login = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(login.status).toBe('DISABLED');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'associate.deactivated', entityId: associate.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.metadata).toMatchObject({ auto: true });

    const summary = await prisma.notification.findFirst({
      where: {
        recipientUserId: admin.id,
        category: 'dormancy',
        subject: { contains: 'Auto-deactivated' },
      },
    });
    expect(summary).not.toBeNull();
    expect(summary!.body).toContain('Gabriela Quiet');
  });

  it('activity after a warning re-arms a fresh warning instead of deactivating', async () => {
    await createUser({ role: 'HR_ADMINISTRATOR' });
    const { associate } = await seedDormant();
    await runDormancySweep(prisma, NOW); // warned

    // They clock in two days later…
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clockInAt: new Date(NOW.getTime() + 2 * DAY),
        clockOutAt: new Date(NOW.getTime() + 2 * DAY + 8 * 3_600_000),
      },
    });

    // …so 40 days after that, the stale warning must NOT authorize a kill:
    // the sweep warns afresh.
    const later = await runDormancySweep(prisma, new Date(NOW.getTime() + 42 * DAY));
    expect(later.deactivated).toBe(0);
    expect(later.warned).toBe(1);
    const a = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(a.deactivatedAt).toBeNull();
  });
});

describe('runDormancySweep — signs of life are exemptions', () => {
  it('an upcoming assigned shift means not dormant, however long since the last one', async () => {
    const client = await createClient();
    const { associate } = await seedDormant();
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Front End',
        startsAt: new Date(NOW.getTime() + 5 * DAY),
        endsAt: new Date(NOW.getTime() + 5 * DAY + 8 * 3_600_000),
        status: 'ASSIGNED',
        assignedAssociateId: associate.id,
      },
    });
    const result = await runDormancySweep(prisma, NOW);
    expect(result.warned).toBe(0);
    expect(result.deactivated).toBe(0);
  });

  it('a recent clock-in resets the clock', async () => {
    const { associate } = await seedDormant();
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clockInAt: new Date(NOW.getTime() - 10 * DAY),
        clockOutAt: new Date(NOW.getTime() - 10 * DAY + 8 * 3_600_000),
      },
    });
    const result = await runDormancySweep(prisma, NOW);
    expect(result.warned).toBe(0);
    expect(result.deactivated).toBe(0);
  });

  it('approved time off covering the window is a planned absence, not dormancy', async () => {
    const { associate } = await seedDormant();
    await prisma.timeOffRequest.create({
      data: {
        associateId: associate.id,
        category: 'OTHER',
        startDate: new Date(NOW.getTime() - 40 * DAY),
        endDate: new Date(NOW.getTime() + 10 * DAY),
        requestedMinutes: 0,
        status: 'APPROVED',
      },
    });
    const result = await runDormancySweep(prisma, NOW);
    expect(result.warned).toBe(0);
    expect(result.deactivated).toBe(0);
  });

  it('a recent reactivation grants a fresh window even with months-old last activity', async () => {
    const { associate } = await seedDormant({ idleDays: 120 });
    await prisma.associate.update({
      where: { id: associate.id },
      data: { reactivatedAt: new Date(NOW.getTime() - 5 * DAY) },
    });
    const result = await runDormancySweep(prisma, NOW);
    expect(result.warned).toBe(0);
    expect(result.deactivated).toBe(0);
  });

  it('an open separation is never preempted by the sweep', async () => {
    const { associate } = await seedDormant();
    await prisma.separation.create({
      data: {
        associateId: associate.id,
        reason: 'VOLUNTARY_PERSONAL',
        status: 'IN_PROGRESS',
        lastDayWorked: new Date(NOW.getTime() - 45 * DAY),
      },
    });
    const result = await runDormancySweep(prisma, NOW);
    expect(result.warned).toBe(0);
    expect(result.deactivated).toBe(0);
  });

  it('never touches the onboarding pipeline (no hireDate)', async () => {
    const associate = await prisma.associate.create({
      data: {
        firstName: 'Still',
        lastName: 'Onboarding',
        email: `onb-${Date.now()}@example.com`,
        createdAt: new Date(NOW.getTime() - 90 * DAY),
      },
    });
    const result = await runDormancySweep(prisma, NOW);
    expect(result.warned).toBe(0);
    expect(result.deactivated).toBe(0);
    const a = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(a.dormancyWarnedAt).toBeNull();
  });
});
