import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runOnboardingPurgeSweep,
  INVITE_PURGE_AFTER_DAYS,
  IDLE_PURGE_AFTER_DAYS,
} from '../../lib/onboardingPurge.js';
import {
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Onboarding ghost purge: unaccepted invites hard-delete after 3 days
 * (human-caused link resets the clock, sweep-minted reminders don't);
 * accepted-but-abandoned onboardings warn at 8 idle days and delete at 10
 * (warning ≥48h old). Work history of any kind makes a person untouchable.
 */

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** INVITED ghost: associate + DRAFT application + passwordless user + token. */
async function seedInvitedGhost(opts: { tokenAgeDays?: number } = {}) {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Never', lastName: 'Accepted' });
  const user = await prisma.user.create({
    data: {
      email: associate.email,
      passwordHash: null,
      role: 'ASSOCIATE',
      status: 'INVITED',
      associateId: associate.id,
    },
  });
  const app = await prisma.application.create({
    data: {
      associateId: associate.id,
      clientId: client.id,
      onboardingTrack: 'STANDARD',
      status: 'DRAFT',
    },
  });
  await prisma.inviteToken.create({
    data: {
      tokenHash: `hash-${user.id}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * DAY),
      createdAt: new Date(Date.now() - (opts.tokenAgeDays ?? 0) * DAY),
    },
  });
  return { client, associate, user, app };
}

/** ACTIVE ghost: accepted the invite, application still an unsubmitted DRAFT. */
async function seedAcceptedGhost() {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Walked', lastName: 'Away' });
  const { user } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  const app = await prisma.application.create({
    data: {
      associateId: associate.id,
      clientId: client.id,
      onboardingTrack: 'STANDARD',
      status: 'DRAFT',
    },
  });
  return { client, associate, user, app };
}

describe('runOnboardingPurgeSweep — unaccepted invites', () => {
  it('purges a 4-day-old unaccepted invite: rows gone, audit row + admin summary written', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { associate, user, app } = await seedInvitedGhost();

    const result = await runOnboardingPurgeSweep(
      prisma,
      new Date(Date.now() + (INVITE_PURGE_AFTER_DAYS + 1) * DAY),
    );
    expect(result.errors).toEqual([]);
    expect(result.invitesPurged).toBe(1);

    expect(await prisma.associate.findUnique({ where: { id: associate.id } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.application.findUnique({ where: { id: app.id } })).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'onboarding.ghost_purged', entityId: associate.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.metadata).toMatchObject({
      kind: 'invite_expired',
      name: 'Never Accepted',
      email: associate.email,
    });

    const summary = await prisma.notification.findFirst({
      where: { recipientUserId: admin.id, category: 'onboarding' },
    });
    expect(summary).not.toBeNull();
    expect(summary!.body).toContain('Never Accepted');
  });

  it('leaves a fresh invite alone', async () => {
    const { associate } = await seedInvitedGhost();
    const result = await runOnboardingPurgeSweep(
      prisma,
      new Date(Date.now() + 1 * DAY),
    );
    expect(result.invitesPurged).toBe(0);
    expect(await prisma.associate.findUnique({ where: { id: associate.id } })).not.toBeNull();
  });

  it('a manual resend restarts the 3-day clock; a sweep-minted reminder does not', async () => {
    // Manual resend 2 days ago on a 6-day-old invite → safe.
    const manual = await seedInvitedGhost({ tokenAgeDays: 6 });
    await prisma.inviteToken.create({
      data: {
        tokenHash: `manual-${manual.user.id}`,
        userId: manual.user.id,
        expiresAt: new Date(Date.now() + 7 * DAY),
        createdAt: new Date(Date.now() - 2 * DAY),
        mintedBySweep: false,
      },
    });
    // Sweep reminder 2 days ago on a 6-day-old invite → still purged.
    const swept = await seedInvitedGhost({ tokenAgeDays: 6 });
    await prisma.inviteToken.create({
      data: {
        tokenHash: `sweep-${swept.user.id}`,
        userId: swept.user.id,
        expiresAt: new Date(Date.now() + 7 * DAY),
        createdAt: new Date(Date.now() - 2 * DAY),
        reminderSentAt: new Date(Date.now() - 2 * DAY),
        mintedBySweep: true,
      },
    });

    const result = await runOnboardingPurgeSweep(prisma, new Date());
    expect(result.errors).toEqual([]);
    expect(
      await prisma.associate.findUnique({ where: { id: manual.associate.id } }),
    ).not.toBeNull();
    expect(
      await prisma.associate.findUnique({ where: { id: swept.associate.id } }),
    ).toBeNull();
  });
});

describe('runOnboardingPurgeSweep — abandoned onboardings', () => {
  it('warns at 8 idle days, refuses to purge <48h after warning, purges after', async () => {
    const { associate, user } = await seedAcceptedGhost();
    const t0 = Date.now();

    // Day 9: final notice, no deletion.
    const day9 = await runOnboardingPurgeSweep(prisma, new Date(t0 + 9 * DAY));
    expect(day9.errors).toEqual([]);
    expect(day9.warned).toBe(1);
    expect(day9.abandonedPurged).toBe(0);
    const warning = await prisma.notification.findFirst({
      where: { recipientUserId: user.id, category: 'onboarding.purge_warning' },
    });
    expect(warning).not.toBeNull();
    expect(warning!.subject).toContain('Final notice');

    // An hour later: no double-warn, still no purge (warning too fresh).
    const later = await runOnboardingPurgeSweep(
      prisma,
      new Date(t0 + 9 * DAY + 60 * 60 * 1000),
    );
    expect(later.warned).toBe(0);
    expect(later.abandonedPurged).toBe(0);
    expect(await prisma.associate.findUnique({ where: { id: associate.id } })).not.toBeNull();

    // Day 12 (idle ≥ 10d, warning 3 days old): purged, with audit trail.
    const day12 = await runOnboardingPurgeSweep(prisma, new Date(t0 + 12 * DAY));
    expect(day12.errors).toEqual([]);
    expect(day12.abandonedPurged).toBe(1);
    expect(await prisma.associate.findUnique({ where: { id: associate.id } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'onboarding.ghost_purged', entityId: associate.id },
    });
    expect(audit!.metadata).toMatchObject({ kind: 'onboarding_abandoned' });
  });

  it('recent onboarding activity resets the idle clock', async () => {
    const { associate } = await seedAcceptedGhost();
    const t0 = Date.now();
    // A document uploaded on day 5 = activity → idle is 4 days on day 9.
    await prisma.documentRecord.create({
      data: {
        associateId: associate.id,
        kind: 'ID',
        filename: 'id.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        createdAt: new Date(t0 + 5 * DAY),
      },
    });
    const day9 = await runOnboardingPurgeSweep(prisma, new Date(t0 + 9 * DAY));
    expect(day9.warned).toBe(0);
    expect(day9.abandonedPurged).toBe(0);
    expect(await prisma.associate.findUnique({ where: { id: associate.id } })).not.toBeNull();
  });

  it('never touches anyone with work history or an advanced application', async () => {
    const farFuture = new Date(Date.now() + 40 * DAY);

    // Ghost-shaped, but with a time entry.
    const worked = await seedAcceptedGhost();
    await prisma.timeEntry.create({
      data: {
        associateId: worked.associate.id,
        clientId: worked.client.id,
        clockInAt: new Date(),
        status: 'ACTIVE',
      },
    });
    // Ghost-shaped, but the application was submitted (HR's court now).
    const submitted = await seedAcceptedGhost();
    await prisma.application.update({
      where: { id: submitted.app.id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });
    // Deactivated (paused, expected back) — protected by definition.
    const paused = await seedAcceptedGhost();
    await prisma.associate.update({
      where: { id: paused.associate.id },
      data: { deactivatedAt: new Date() },
    });

    // Run twice so warned candidates would have crossed into purge range.
    await runOnboardingPurgeSweep(prisma, farFuture);
    await runOnboardingPurgeSweep(prisma, new Date(farFuture.getTime() + 3 * DAY));

    for (const s of [worked, submitted, paused]) {
      expect(
        await prisma.associate.findUnique({ where: { id: s.associate.id } }),
      ).not.toBeNull();
      expect(await prisma.user.findUnique({ where: { id: s.user.id } })).not.toBeNull();
    }
    expect(IDLE_PURGE_AFTER_DAYS).toBeGreaterThan(0);
  });
});
