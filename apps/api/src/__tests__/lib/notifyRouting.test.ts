import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushPendingNotifications, notifyAllAdmins, notifyUser } from '../../lib/notify.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Who actually gets told, and who asked not to be.
 *
 * The admin fan-out selected recipients by capability — the six roles
 * holding manage:onboarding — which answers "who may see this" rather
 * than "whose job is this". A marketing manager was told about every OSHA
 * incident, no-show and separation in the company. And muting a category
 * in Settings stopped only the email: the bell row was written regardless,
 * so the switch turned off half of what it said it did.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedAdmins() {
  const roles = [
    'HR_ADMINISTRATOR',
    'OPERATIONS_MANAGER',
    'INTERNAL_RECRUITER',
    'MANAGER',
    'WORKFORCE_MANAGER',
    'MARKETING_MANAGER',
  ] as const;
  const out = new Map<string, string>();
  for (const role of roles) {
    const { user } = await createUser({ role });
    out.set(role, user.id);
  }
  return out;
}

const rolesNotified = async (admins: Map<string, string>) => {
  const rows = await prisma.notification.findMany({
    where: { channel: 'IN_APP' },
    select: { recipientUserId: true },
  });
  const byId = new Map([...admins].map(([role, id]) => [id, role]));
  return new Set(rows.map((r) => byId.get(r.recipientUserId!)).filter(Boolean));
};

describe('the admin fan-out reaches the desk that owns the event', () => {
  it('reaches every admin for a category nobody routed', async () => {
    const admins = await seedAdmins();
    await notifyAllAdmins({
      subject: 'Something new happened',
      body: 'A category added later, with no line in the table.',
      category: 'brand-new-signal',
      emailRoles: [],
    });
    await flushPendingNotifications();
    // Fail open: narrowing happens only where a decision was made, so a
    // category added elsewhere can never silently reach nobody.
    expect((await rolesNotified(admins)).size).toBe(6);
  });

  it('leaves the marketing desk out of a floor alert', async () => {
    const admins = await seedAdmins();
    await notifyAllAdmins({
      subject: 'Cooler out of range',
      body: 'Walk-in cooler at Front Beach 218 read 51°F.',
      category: 'ops.temp_alert',
      emailRoles: [],
    });
    await flushPendingNotifications();

    const told = await rolesNotified(admins);
    expect(told).toEqual(new Set(['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'WORKFORCE_MANAGER']));
    expect(told.has('MARKETING_MANAGER')).toBe(false);
  });

  it('sends hiring to the recruiter, not the operations desk', async () => {
    const admins = await seedAdmins();
    await notifyAllAdmins({
      subject: 'Application ready for review',
      body: 'Marcus Hill finished his checklist.',
      category: 'onboarding',
      emailRoles: [],
    });
    await flushPendingNotifications();

    const told = await rolesNotified(admins);
    expect(told).toEqual(
      new Set(['HR_ADMINISTRATOR', 'INTERNAL_RECRUITER', 'WORKFORCE_MANAGER']),
    );
  });

  it('follows the family line for a dotted category', async () => {
    const admins = await seedAdmins();
    await notifyAllAdmins({
      subject: 'Attestation due',
      body: 'The quarterly attestation window closes Friday.',
      // Genuinely org-wide, and deliberately absent from the table.
      category: 'compliance.attestation.q3',
      emailRoles: [],
    });
    await flushPendingNotifications();
    // 'compliance' routes to HR + OPS; the attestation sweep is the one
    // signal with no client dimension at all, so it follows that line.
    const told = await rolesNotified(admins);
    expect(told).toEqual(new Set(['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER']));
  });
});

describe('muting a category silences the bell, not just the email', () => {
  it('writes no in-app row for someone who turned the bucket off', async () => {
    const admins = await seedAdmins();
    const hrId = admins.get('HR_ADMINISTRATOR')!;
    await prisma.notificationPreference.create({
      data: { userId: hrId, category: 'onboarding', emailEnabled: true, inAppEnabled: false },
    });

    await notifyAllAdmins({
      subject: 'Application ready for review',
      body: 'Marcus Hill finished his checklist.',
      category: 'onboarding',
      emailRoles: [],
    });
    await flushPendingNotifications();

    const told = await rolesNotified(admins);
    expect(told.has('HR_ADMINISTRATOR')).toBe(false);
    // The others are untouched — one person's mute is not a policy.
    expect(told).toEqual(new Set(['INTERNAL_RECRUITER', 'WORKFORCE_MANAGER']));
  });

  it('honours the mute for a direct notification too', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.notificationPreference.create({
      data: { userId: user.id, category: 'scheduling', emailEnabled: true, inAppEnabled: false },
    });
    await notifyUser(user.id, {
      subject: 'Shift moved',
      body: 'Your Tuesday shift starts an hour later.',
      category: 'scheduling',
      quiet: true,
    });
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: user.id } })).toBe(0);
  });

  it('cannot be muted for a category the policy requires', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    // Even with the row set, a mandatory bucket still rings.
    await prisma.notificationPreference.create({
      data: { userId: user.id, category: 'discipline', emailEnabled: false, inAppEnabled: false },
    });
    await notifyUser(user.id, {
      subject: 'Written warning issued',
      body: 'A formal notice was added to your record.',
      category: 'discipline',
      quiet: true,
    });
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: user.id } })).toBe(1);
  });
});
