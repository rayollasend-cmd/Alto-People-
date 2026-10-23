import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { env } from '../../config/env.js';
import { setNativeTransportsForTests, type NativeTransports } from '../../lib/nativePush.js';
import { emailUserForCategory, flushPendingNotifications, notifyUser, notifyUserOn } from '../../lib/notify.js';
import { resetDeliveryPrefsCache, runNotificationDigest } from '../../lib/notificationDelivery.js';
import { PushMutedError, send, statusForSendError } from '../../lib/notifications.js';
import { isPushMuted, sendPushToUser } from '../../lib/webPush.js';

/**
 * The Push switch per category (Settings › Notifications, the Push column).
 *
 * Push used to ride the email switch. Now every push passes one gate,
 * isPushMuted, inside sendPushToUser — the funnel web push and the phone
 * apps share — and a muted push is never even held for the digest. Email
 * and the bell keep their own switches; mandatory buckets push regardless.
 *
 * The phones are the observable transport here: APNs is swapped for a
 * recorder, so "a push went out" is a call on it.
 */

let prev: NativeTransports;
let pushes: Array<{ token: string; title: string; body: string }>;

beforeEach(async () => {
  await truncateAll();
  resetDeliveryPrefsCache();
  pushes = [];
  prev = setNativeTransportsForTests({
    force: true,
    apns: async (token, msg) => {
      pushes.push({ token, title: msg.title, body: msg.body });
      return 'sent';
    },
  });
});

afterEach(() => {
  setNativeTransportsForTests({ ...prev, force: false });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** An associate with the app on one iPhone, and the switches given. */
async function personWithPhone(prefs: Array<{ category: string; emailEnabled?: boolean; inAppEnabled?: boolean; pushEnabled?: boolean }> = []) {
  const { user } = await createUser({ role: 'ASSOCIATE' });
  await prisma.nativeDevice.create({ data: { userId: user.id, platform: 'IOS', pushToken: `ios-${user.id}` } });
  for (const p of prefs) await prisma.notificationPreference.create({ data: { userId: user.id, ...p } });
  return user;
}

async function channelsFor(userId: string): Promise<string[]> {
  const rows = await prisma.notification.findMany({ where: { recipientUserId: userId }, select: { channel: true } });
  return rows.map((r) => r.channel).sort();
}

describe('isPushMuted — the one gate', () => {
  it('answers by the settings bucket the raw category falls in', async () => {
    const user = await personWithPhone([{ category: 'scheduling', pushEnabled: false }]);
    expect(await isPushMuted(user.id, 'shift_published')).toBe(true);
    expect(await isPushMuted(user.id, 'scheduling')).toBe(true);
    // Another bucket, an unknown category, or none: push.
    expect(await isPushMuted(user.id, 'documents')).toBe(false);
    expect(await isPushMuted(user.id, 'something_new')).toBe(false);
    expect(await isPushMuted(user.id, null)).toBe(false);
  });

  it('never mutes a mandatory bucket, even with a stale row', async () => {
    const user = await personWithPhone([{ category: 'discipline', pushEnabled: false }]);
    expect(await isPushMuted(user.id, 'discipline')).toBe(false);
  });

  it('sendPushToUser itself refuses a muted category', async () => {
    const user = await personWithPhone([{ category: 'scheduling', pushEnabled: false }]);
    expect(await sendPushToUser(user.id, { title: 'Shift moved', body: 'Now 9:00', category: 'shift_changed' })).toBe('muted');
    expect(pushes).toHaveLength(0);
    expect(await sendPushToUser(user.id, { title: 'Doc approved', body: 'Your I-9 is in.', category: 'documents' })).toBe('sent');
    expect(pushes.map((p) => p.title)).toEqual(['Doc approved']);
  });
});

describe('notifyUser', () => {
  it('a muted Push sends no push, while email and the bell still follow their own switches', async () => {
    const user = await personWithPhone([{ category: 'scheduling', pushEnabled: false }]);
    await notifyUser(user.id, { subject: 'Schedule published', body: 'Next week is out.', category: 'shift_published' });
    await flushPendingNotifications();
    expect(pushes).toHaveLength(0);
    expect(await channelsFor(user.id)).toEqual(['EMAIL', 'IN_APP']);
  });

  it('a muted email no longer silences the push', async () => {
    const user = await personWithPhone([{ category: 'scheduling', emailEnabled: false }]);
    await notifyUser(user.id, { subject: 'Schedule published', body: 'Next week is out.', category: 'shift_published' });
    await flushPendingNotifications();
    expect(pushes.map((p) => p.title)).toEqual(['Schedule published']);
    expect(await channelsFor(user.id)).toEqual(['IN_APP']);
  });

  it('the bell off: email and push still come — each switch silences only its own channel', async () => {
    const user = await personWithPhone([{ category: 'scheduling', inAppEnabled: false }]);
    await notifyUser(user.id, { subject: 'Schedule published', body: 'Next week is out.', category: 'shift_published' });
    await flushPendingNotifications();
    expect(pushes.map((p) => p.title)).toEqual(['Schedule published']);
    expect(await channelsFor(user.id)).toEqual(['EMAIL']);
  });

  it('every switch off: the bell, the email and the push all stay quiet', async () => {
    const user = await personWithPhone([{ category: 'scheduling', emailEnabled: false, inAppEnabled: false, pushEnabled: false }]);
    await notifyUser(user.id, { subject: 'Schedule published', body: 'Next week is out.', category: 'shift_published' });
    await flushPendingNotifications();
    expect(pushes).toHaveLength(0);
    expect(await channelsFor(user.id)).toEqual([]);
  });

  it('a mandatory notice still pushes', async () => {
    const user = await personWithPhone([{ category: 'discipline', pushEnabled: false, emailEnabled: false }]);
    await notifyUser(user.id, { subject: 'Final warning', body: 'You have received a final warning.', category: 'discipline' });
    await flushPendingNotifications();
    expect(pushes.map((p) => p.title)).toEqual(['Final warning']);
    expect(await channelsFor(user.id)).toEqual(['EMAIL', 'IN_APP']);
  });
});

describe('emailUserForCategory', () => {
  it('push muted: the email goes, the push does not', async () => {
    const user = await personWithPhone([{ category: 'scheduling', pushEnabled: false }]);
    await emailUserForCategory(user.id, user.email!, { subject: 'Shift changed', body: 'Now 9:00.', category: 'shift_changed' });
    await flushPendingNotifications();
    expect(pushes).toHaveLength(0);
    expect(await channelsFor(user.id)).toEqual(['EMAIL']);
  });

  it('email muted: the push goes, the email does not', async () => {
    const user = await personWithPhone([{ category: 'scheduling', emailEnabled: false }]);
    await emailUserForCategory(user.id, user.email!, { subject: 'Shift changed', body: 'Now 9:00.', category: 'shift_changed' });
    await flushPendingNotifications();
    expect(pushes.map((p) => p.title)).toEqual(['Shift changed']);
    expect(await channelsFor(user.id)).toEqual([]);
  });
});

describe('with a push transport configured (APNs)', () => {
  const saved = { APNS_KEY_ID: env.APNS_KEY_ID, APNS_TEAM_ID: env.APNS_TEAM_ID, APNS_PRIVATE_KEY: env.APNS_PRIVATE_KEY };
  beforeEach(() => {
    Object.assign(env, { APNS_KEY_ID: 'KEY', APNS_TEAM_ID: 'TEAM', APNS_PRIVATE_KEY: 'pem' });
  });
  afterEach(() => {
    Object.assign(env, saved);
  });

  it('notifyUserOn (a broadcast) answers muted for the push and still emails', async () => {
    const muted = await personWithPhone([{ category: 'broadcast', pushEnabled: false }]);
    const open = await personWithPhone();
    const opts = { subject: 'Holiday hours', body: 'We close at 3 on Friday.', category: 'broadcast' };
    const a = await notifyUserOn(muted.id, opts, ['IN_APP', 'EMAIL', 'PUSH']);
    const b = await notifyUserOn(open.id, opts, ['IN_APP', 'EMAIL', 'PUSH']);
    await flushPendingNotifications();
    expect(a).toEqual({ IN_APP: 'sent', EMAIL: 'sent', PUSH: 'muted' });
    expect(b).toEqual({ IN_APP: 'sent', EMAIL: 'sent', PUSH: 'sent' });
    expect(pushes.map((p) => p.token)).toEqual([`ios-${open.id}`]);
  });

  it('a one-off push from Communications to a muted category is SUPPRESSED, never SENT', async () => {
    const user = await personWithPhone([{ category: 'broadcast', pushEnabled: false }]);
    const recipient = { userId: user.id, phone: null, email: null };
    let err: unknown = null;
    await send({ channel: 'PUSH', recipient, subject: 'Holiday hours', body: 'We close at 3.', category: 'broadcast', audit: false }).catch((e: unknown) => {
      err = e;
    });
    expect(err).toBeInstanceOf(PushMutedError);
    expect(statusForSendError(err)).toBe('SUPPRESSED');
    expect(pushes).toHaveLength(0);
    // Uncategorised, it goes.
    await send({ channel: 'PUSH', recipient, subject: 'Call me', body: 'When you can.', audit: false });
    expect(pushes.map((p) => p.title)).toEqual(['Call me']);
  });
});

describe('the digest', () => {
  it('drops a held push whose category was muted after it was held, and sends the rest', async () => {
    const user = await personWithPhone();
    const due = new Date(Date.now() - 60_000);
    const held = { userId: user.id, channel: 'PUSH' as const, reason: 'DIGEST' as const, dueAt: due };
    await prisma.deferredNotification.createMany({
      data: [
        { ...held, subject: 'Schedule published', body: 'Next week is out.', category: 'shift_published' },
        { ...held, subject: 'Doc approved', body: 'Your I-9 is in.', category: 'documents' },
      ],
    });
    // Muted while the copies waited.
    await prisma.notificationPreference.create({ data: { userId: user.id, category: 'scheduling', pushEnabled: false } });

    expect(await runNotificationDigest(prisma, new Date())).toBe(1);
    // One push, carrying only the live notice (no "and 1 more").
    expect(pushes).toEqual([{ token: `ios-${user.id}`, title: 'Doc approved', body: 'Your I-9 is in.' }]);
    expect(await prisma.deferredNotification.count({ where: { userId: user.id, sentAt: null } })).toBe(0);
  });

  it('every held push muted: nothing is sent and the rows are closed', async () => {
    const user = await personWithPhone([{ category: 'scheduling', pushEnabled: false }]);
    await prisma.deferredNotification.create({
      data: { userId: user.id, channel: 'PUSH', reason: 'DIGEST', dueAt: new Date(Date.now() - 60_000), subject: 'Schedule published', body: 'Next week is out.', category: 'shift_published' },
    });
    expect(await runNotificationDigest(prisma, new Date())).toBe(0);
    expect(pushes).toHaveLength(0);
    expect(await prisma.deferredNotification.count({ where: { userId: user.id, sentAt: null } })).toBe(0);
  });
});

describe('quiet hours', () => {
  it('a muted push is never held for later', async () => {
    const user = await personWithPhone([{ category: 'scheduling', pushEnabled: false }]);
    await prisma.user.update({ where: { id: user.id }, data: { quietHoursStart: 0, quietHoursEnd: 1439, timezone: 'UTC' } });
    resetDeliveryPrefsCache();
    await notifyUser(user.id, { subject: 'Schedule published', body: 'Next week is out.', category: 'shift_published' });
    await flushPendingNotifications();
    const held = (await prisma.deferredNotification.findMany({ where: { userId: user.id }, select: { channel: true } })).map((h) => h.channel);
    // The email waits for the morning; the push was off, so no copy of it waits.
    expect(held).toContain('EMAIL');
    expect(held).not.toContain('PUSH');
    expect(pushes).toHaveLength(0);
  });
});
