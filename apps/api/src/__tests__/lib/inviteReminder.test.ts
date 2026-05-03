import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAssociate,
  createClient,
  createStandardTemplate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { generateInviteToken } from '../../lib/inviteToken.js';
import {
  INVITE_REMINDER_AFTER_HOURS,
  runInviteReminderSweep,
  sendReminderForUser,
} from '../../lib/inviteReminder.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedInvitedUser(opts: {
  email?: string;
  firstName?: string;
  clientName?: string;
  withApplication?: boolean;
} = {}) {
  const associate = await createAssociate({
    firstName: opts.firstName ?? 'Stale',
    lastName: 'Hire',
    email: opts.email ?? `stale-${Math.random().toString(36).slice(2, 8)}@example.com`,
  });
  const { user } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    status: 'INVITED',
    associateId: associate.id,
  });
  // INVITED users shouldn't have a password hash; createUser sets one.
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: null } });

  if (opts.withApplication) {
    const client = await createClient(opts.clientName);
    const template = await createStandardTemplate();
    await prisma.application.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        onboardingTrack: template.track,
        status: 'DRAFT',
      },
    });
  }

  return { user, associate };
}

async function insertToken(opts: {
  userId: string;
  createdAtAgoHours: number;
  expiresAtFromNowHours?: number;
  consumedAt?: Date | null;
  reminderSentAt?: Date | null;
}) {
  const t = generateInviteToken();
  return prisma.inviteToken.create({
    data: {
      tokenHash: t.hash,
      userId: opts.userId,
      createdAt: new Date(Date.now() - opts.createdAtAgoHours * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + (opts.expiresAtFromNowHours ?? 168) * 60 * 60 * 1000),
      consumedAt: opts.consumedAt ?? null,
      reminderSentAt: opts.reminderSentAt ?? null,
    },
  });
}

describe('runInviteReminderSweep', () => {
  it('reminds INVITED users with tokens older than 48h and rotates the token', async () => {
    const { user } = await seedInvitedUser({
      firstName: 'Riley',
      clientName: 'Sunset Resort',
      withApplication: true,
    });
    const old = await insertToken({ userId: user.id, createdAtAgoHours: 49 });

    const result = await runInviteReminderSweep();
    expect(result.scanned).toBe(1);
    expect(result.reminded).toBe(1);
    expect(result.errors).toEqual([]);

    // Old token should have been superseded.
    const oldAfter = await prisma.inviteToken.findUniqueOrThrow({ where: { id: old.id } });
    expect(oldAfter.consumedAt).not.toBeNull();

    // A brand-new token should exist for this user, with reminderSentAt set.
    const fresh = await prisma.inviteToken.findFirstOrThrow({
      where: { userId: user.id, consumedAt: null },
    });
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.reminderSentAt).not.toBeNull();

    // Notification persisted with reminder category and the new link in body.
    const notif = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: user.id, category: 'onboarding.invite_reminder' },
    });
    expect(notif.status).toBe('SENT');
    expect(notif.body).toContain('Sunset Resort');
    expect(notif.body).toContain('/accept-invite/');
    // Template addresses the recipient by first name (just "Riley," in the
    // greeting line, no "Hi" prefix per the polished template).
    expect(notif.body).toMatch(/^Riley,/m);
  });

  it('skips tokens younger than the 48h threshold', async () => {
    const { user } = await seedInvitedUser();
    await insertToken({ userId: user.id, createdAtAgoHours: 24 });

    const result = await runInviteReminderSweep();
    expect(result.scanned).toBe(0);
    expect(result.reminded).toBe(0);
  });

  it('skips tokens already reminded (idempotent across runs)', async () => {
    const { user } = await seedInvitedUser({ withApplication: true });
    await insertToken({ userId: user.id, createdAtAgoHours: 60 });

    const first = await runInviteReminderSweep();
    expect(first.reminded).toBe(1);

    const second = await runInviteReminderSweep();
    expect(second.scanned).toBe(0);
    expect(second.reminded).toBe(0);

    const notifs = await prisma.notification.count({
      where: { recipientUserId: user.id, category: 'onboarding.invite_reminder' },
    });
    expect(notifs).toBe(1);
  });

  it('skips tokens that are consumed', async () => {
    const { user } = await seedInvitedUser();
    await insertToken({
      userId: user.id,
      createdAtAgoHours: 72,
      consumedAt: new Date(),
    });

    const result = await runInviteReminderSweep();
    expect(result.scanned).toBe(0);
  });

  it('skips tokens that are expired', async () => {
    const { user } = await seedInvitedUser();
    await insertToken({
      userId: user.id,
      createdAtAgoHours: 240,
      expiresAtFromNowHours: -1,
    });

    const result = await runInviteReminderSweep();
    expect(result.scanned).toBe(0);
  });

  it('skips tokens whose user has already become ACTIVE', async () => {
    const { user } = await seedInvitedUser();
    await insertToken({ userId: user.id, createdAtAgoHours: 72 });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', passwordHash: 'argon-fake-hash' },
    });

    const result = await runInviteReminderSweep();
    expect(result.scanned).toBe(0);
  });

  it('threshold is exactly 48h', () => {
    expect(INVITE_REMINDER_AFTER_HOURS).toBe(48);
  });
});

describe('sendReminderForUser (manual mode)', () => {
  it('rotates the token, sends a fresh link, marks new token reminded', async () => {
    const { user } = await seedInvitedUser({ withApplication: true });
    const original = await insertToken({ userId: user.id, createdAtAgoHours: 1 });

    const result = await sendReminderForUser(prisma, user.id, { reason: 'manual' });
    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.tokenId).not.toBe(original.id);

    const originalAfter = await prisma.inviteToken.findUniqueOrThrow({ where: { id: original.id } });
    expect(originalAfter.consumedAt).not.toBeNull();

    const fresh = await prisma.inviteToken.findUniqueOrThrow({ where: { id: result.tokenId } });
    expect(fresh.consumedAt).toBeNull();
    expect(fresh.reminderSentAt).not.toBeNull();

    const notif = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: user.id, category: 'onboarding.invite_reminder' },
    });
    // Manual resends use the standard invite template so the subject is
    // the same "[Action Required] Complete your onboarding…" copy a brand
    // new invitee receives — not a "reminder" subject.
    expect(notif.subject).toMatch(/\[Action Required\] Complete your onboarding/);
    expect(notif.body).toContain(result.rawToken);
  });

  it('throws if the user is already ACTIVE', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await expect(sendReminderForUser(prisma, hr.id, { reason: 'manual' })).rejects.toThrow(
      'user_not_invitable'
    );
  });
});
