import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { setNativeTransportsForTests, type NativeTransports } from '../../lib/nativePush.js';
import { flushPendingNotifications, notifyAllAdmins, notifyUser } from '../../lib/notify.js';
import {
  DAILY_EMAIL_CAP,
  effectiveDeliveryPrefs,
  planOutside,
  resetDeliveryPrefsCache,
  runNotificationDigest,
  type DeliveryPrefs,
} from '../../lib/notificationDelivery.js';
import { runNotificationRetention } from '../../lib/notificationRetention.js';

/**
 * Calm notifications (owner, 2026-11-02). Production, 30 days: 27,059
 * emails and ~38,800 bell rows for 250 people; 99% of the emails repeated a
 * bell row word for word; HR admins got a median 33 emails a day; one
 * person in 250 had ever set quiet hours. The owner chose: quiet 9 PM–7 AM
 * for everyone, the office a 7 AM summary instead of an email per alert,
 * and only what needs them for the floor — urgent notices excepted.
 */

const ET = 'America/New_York';
const day = new Date('2026-11-03T15:00:00Z'); // 10:00 in New York
const night = new Date('2026-11-04T07:00:00Z'); // 02:00
const sevenAm = new Date('2026-11-04T12:00:00Z');

const office: DeliveryPrefs = { quietHoursStart: 21 * 60, quietHoursEnd: 7 * 60, deliveryEmail: 'DAILY', deliveryPush: 'REALTIME', deliverySms: 'REALTIME', timezone: ET };
const floor: DeliveryPrefs = { ...office, deliveryEmail: 'IMPORTANT' };

afterAll(async () => {
  await prisma.$disconnect();
});

describe('which channels a notice earns', () => {
  it('a critical notice goes everywhere at once, quiet hours or not', () => {
    for (const ch of ['EMAIL', 'PUSH', 'WHATSAPP'] as const) expect(planOutside(office, ch, 'critical', {}, night)).toEqual({ send: 'now' });
  });

  it('the office: an alert is pushed now and emailed in the 7 AM summary', () => {
    expect(planOutside(office, 'PUSH', 'action', {}, day)).toEqual({ send: 'now' });
    expect(planOutside(office, 'EMAIL', 'action', {}, day)).toEqual({ send: 'later', reason: 'SUMMARY', dueAt: sevenAm });
  });

  it('the floor: emailed only when nothing else reaches them — at once, or after four unseen hours', () => {
    expect(planOutside(floor, 'EMAIL', 'action', { reachable: false }, day)).toEqual({ send: 'now' });
    expect(planOutside(floor, 'EMAIL', 'action', { reachable: true }, day)).toEqual({ send: 'later', reason: 'UNSEEN', dueAt: new Date('2026-11-03T19:00:00Z') });
    // Four hours after 6 PM falls in quiet hours: it waits for the morning.
    expect(planOutside(floor, 'EMAIL', 'action', { reachable: true }, new Date('2026-11-03T23:00:00Z'))).toEqual({ send: 'later', reason: 'UNSEEN', dueAt: sevenAm });
  });

  it('information stays in the bell: no push, and no email of its own', () => {
    expect(planOutside(floor, 'PUSH', 'info', {}, day)).toEqual({ send: 'never' });
    expect(planOutside(floor, 'EMAIL', 'info', {}, day)).toEqual({ send: 'never' });
    expect(planOutside(office, 'EMAIL', 'info', {}, day)).toMatchObject({ send: 'later', reason: 'SUMMARY' });
    // Someone who asked for every update still gets it.
    expect(planOutside({ ...floor, deliveryEmail: 'REALTIME' }, 'EMAIL', 'info', {}, day)).toEqual({ send: 'now' });
  });

  it('a scheduled digest is its own email, held only by quiet hours, and never pushed', () => {
    expect(planOutside(office, 'EMAIL', 'digest', {}, day)).toEqual({ send: 'now' });
    expect(planOutside(office, 'EMAIL', 'digest', {}, night)).toEqual({ send: 'later', reason: 'QUIET_HOURS', dueAt: sevenAm });
    expect(planOutside(office, 'PUSH', 'digest', {}, day)).toEqual({ send: 'never' });
  });

  it('quiet hours hold a push until 7; "only urgent" sends nothing else', () => {
    expect(planOutside(floor, 'PUSH', 'action', {}, night)).toEqual({ send: 'later', reason: 'QUIET_HOURS', dueAt: sevenAm });
    const off: DeliveryPrefs = { ...office, deliveryEmail: 'OFF' };
    expect(planOutside(off, 'EMAIL', 'action', {}, day)).toEqual({ send: 'never' });
    expect(planOutside(off, 'EMAIL', 'digest', {}, day)).toEqual({ send: 'never' });
    expect(planOutside(off, 'EMAIL', 'critical', {}, night)).toEqual({ send: 'now' });
  });
});

describe('the defaults for someone who never chose', () => {
  const never = { quietHoursStart: null, quietHoursEnd: null, deliveryEmail: 'REALTIME' as const, deliveryPush: 'REALTIME' as const, deliverySms: 'REALTIME' as const, timezone: null, deliveryPrefsSetAt: null };
  beforeEach(() => {
    env.NOTIFY_ROLE_DEFAULTS = true;
  });
  afterEach(() => {
    env.NOTIFY_ROLE_DEFAULTS = false;
  });

  it('the office gets the morning summary, the floor only what needs them; both quiet 9 PM–7 AM on the company clock', () => {
    expect(effectiveDeliveryPrefs({ role: 'HR_ADMINISTRATOR', ...never })).toEqual({
      quietHoursStart: 21 * 60,
      quietHoursEnd: 7 * 60,
      deliveryEmail: 'DAILY',
      deliveryPush: 'REALTIME',
      deliverySms: 'REALTIME',
      timezone: ET,
      isDefault: true,
    });
    expect(effectiveDeliveryPrefs({ role: 'ASSOCIATE', ...never }).deliveryEmail).toBe('IMPORTANT');
    expect(effectiveDeliveryPrefs({ role: 'SHIFT_SUPERVISOR', ...never }).deliveryEmail).toBe('IMPORTANT');
  });

  it('what someone chose stands', () => {
    expect(effectiveDeliveryPrefs({ role: 'HR_ADMINISTRATOR', ...never, deliveryPrefsSetAt: new Date() })).toMatchObject({ quietHoursStart: null, deliveryEmail: 'REALTIME', isDefault: false });
  });
});

describe('calm notifications, end to end', () => {
  let prev: NativeTransports;
  let pushes: string[];
  const apns = { APNS_KEY_ID: env.APNS_KEY_ID, APNS_TEAM_ID: env.APNS_TEAM_ID, APNS_PRIVATE_KEY: env.APNS_PRIVATE_KEY };

  beforeEach(async () => {
    await truncateAll();
    resetDeliveryPrefsCache();
    env.NOTIFY_ROLE_DEFAULTS = true;
    // A phone counts as reachable only when APNs is set up; the recorder below is the phone.
    Object.assign(env, { APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: 'p' });
    pushes = [];
    prev = setNativeTransportsForTests({
      force: true,
      apns: async (token) => {
        pushes.push(token);
        return 'sent';
      },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    env.NOTIFY_ROLE_DEFAULTS = false;
    Object.assign(env, apns);
    setNativeTransportsForTests({ ...prev, force: false });
  });

  const emails = (userId: string) => prisma.notification.count({ where: { recipientUserId: userId, channel: 'EMAIL' } });
  const withPhone = async (userId: string) => prisma.nativeDevice.create({ data: { userId, platform: 'IOS', pushToken: `ios-${userId}` } });

  it('an office alert waits for the 7 AM summary, which leaves out what was already seen', async () => {
    vi.setSystemTime(day);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await notifyUser(hr.id, { subject: 'Possible no-show', body: 'Dee has not clocked in.', category: 'shift_no_show' });
    await notifyUser(hr.id, { subject: 'Overtime ahead', body: 'Alan is at 38 hours.', category: 'ot_radar' });
    await notifyUser(hr.id, { subject: 'Temperature alert', body: 'Walk-in cooler at 44°F.', category: 'ops.temp_alert' });
    await flushPendingNotifications();
    expect(await emails(hr.id)).toBe(0);
    const held = await prisma.deferredNotification.findMany({ where: { userId: hr.id, channel: 'EMAIL' } });
    expect(held.map((h) => h.reason)).toEqual(['SUMMARY', 'SUMMARY', 'SUMMARY']);
    expect(held.every((h) => h.dueAt.getTime() === sevenAm.getTime() && h.notificationId)).toBe(true);

    // One of them was seen in the bell before morning.
    const seen = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: hr.id, channel: 'IN_APP', category: 'ot_radar' } });
    await prisma.notification.update({ where: { id: seen.id }, data: { seenAt: new Date() } });
    expect(await runNotificationDigest(prisma, new Date(sevenAm.getTime() - 60_000))).toBe(0);
    expect(await runNotificationDigest(prisma, sevenAm)).toBe(1);
    const mail = await prisma.notification.findMany({ where: { recipientUserId: hr.id, channel: 'EMAIL' } });
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('Your morning summary: 2 updates');
    expect(mail[0]!.body).toContain('Possible no-show');
    expect(mail[0]!.body).toContain('Temperature alert');
    expect(mail[0]!.body).not.toContain('Overtime ahead');
    expect(await prisma.deferredNotification.count({ where: { userId: hr.id, sentAt: null } })).toBe(0);
  });

  it('an associate with no phone is emailed at once; with the app on a phone, only if the bell copy goes unseen', async () => {
    vi.setSystemTime(day);
    const { user: noPhone } = await createUser({ role: 'ASSOCIATE' });
    await notifyUser(noPhone.id, { subject: 'Please confirm your shift', body: 'Tomorrow at 7 AM.', category: 'shift_confirm' });
    await flushPendingNotifications();
    expect(await emails(noPhone.id)).toBe(1);

    const { user: phone } = await createUser({ role: 'ASSOCIATE' });
    await withPhone(phone.id);
    await notifyUser(phone.id, { subject: 'Please confirm your shift', body: 'Tomorrow at 7 AM.', category: 'shift_confirm' });
    await flushPendingNotifications();
    expect(pushes).toEqual([`ios-${phone.id}`]);
    expect(await emails(phone.id)).toBe(0);
    const held = await prisma.deferredNotification.findFirstOrThrow({ where: { userId: phone.id, channel: 'EMAIL' } });
    expect(held.reason).toBe('UNSEEN');
    expect(held.dueAt.toISOString()).toBe('2026-11-03T19:00:00.000Z');
    expect(held.html).toContain('Please confirm your shift');

    // Still unseen four hours on: the email goes out as it would have.
    expect(await runNotificationDigest(prisma, held.dueAt)).toBe(1);
    expect((await prisma.notification.findFirstOrThrow({ where: { recipientUserId: phone.id, channel: 'EMAIL' } })).subject).toBe('Please confirm your shift');
  });

  it('a held email whose bell copy was opened in the meantime is dropped', async () => {
    vi.setSystemTime(day);
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await withPhone(user.id);
    await notifyUser(user.id, { subject: 'Shift moved', body: 'Now at 9 AM.', category: 'shift_changed' });
    await flushPendingNotifications();
    const bell = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: user.id, channel: 'IN_APP' } });
    await prisma.notification.update({ where: { id: bell.id }, data: { readAt: new Date() } });
    expect(await runNotificationDigest(prisma, new Date(day.getTime() + 5 * 3_600_000))).toBe(0);
    expect(await emails(user.id)).toBe(0);
  });

  it('information stays in the bell: no push, no email', async () => {
    vi.setSystemTime(day);
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await withPhone(user.id);
    await notifyUser(user.id, { subject: 'You just added ~$96.00 to your week', body: 'Nice work.', category: 'earnings' });
    await notifyUser(user.id, { subject: 'Hours approved', body: 'Monday, 8.0 hours.', category: 'time_entry', tier: 'info' });
    await flushPendingNotifications();
    expect(pushes).toEqual([]);
    expect(await emails(user.id)).toBe(0);
    expect(await prisma.deferredNotification.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { recipientUserId: user.id, channel: 'IN_APP' } })).toBe(2);
  });

  it('at night nothing routine goes out until 7 — a security notice still does', async () => {
    vi.setSystemTime(night);
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await notifyUser(user.id, { subject: 'Shift moved', body: 'Now at 9 AM.', category: 'shift_changed' });
    await notifyUser(user.id, { subject: 'New sign-in', body: 'From a new device.', category: 'security' });
    await flushPendingNotifications();
    const mail = await prisma.notification.findMany({ where: { recipientUserId: user.id, channel: 'EMAIL' }, select: { subject: true } });
    expect(mail.map((m) => m.subject)).toEqual(['New sign-in']);
    expect(await prisma.deferredNotification.findFirstOrThrow({ where: { userId: user.id, channel: 'EMAIL' } })).toMatchObject({ reason: 'QUIET_HOURS', dueAt: sevenAm });
  });

  it('past five routine emails in a day, the rest wait for the morning summary', async () => {
    vi.setSystemTime(day);
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.notification.createMany({
      data: Array.from({ length: DAILY_EMAIL_CAP }, (_, i) => ({ channel: 'EMAIL' as const, status: 'SENT' as const, recipientUserId: user.id, subject: `Earlier ${i}`, body: 'x', createdAt: day })),
    });
    await notifyUser(user.id, { subject: 'Shift moved', body: 'Now at 9 AM.', category: 'shift_changed' });
    await flushPendingNotifications();
    expect(await emails(user.id)).toBe(DAILY_EMAIL_CAP);
    expect(await prisma.deferredNotification.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ reason: 'SUMMARY', dueAt: sevenAm });
  });

  it("an alert to the whole office follows each person's rules — it used to email everyone at once, any hour", async () => {
    vi.setSystemTime(night);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await notifyAllAdmins({ subject: 'Possible no-show', body: 'Dee has not clocked in.', category: 'shift_no_show' });
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: hr.id, channel: 'IN_APP' } })).toBe(1);
    expect(await emails(hr.id)).toBe(0);
    expect(await prisma.deferredNotification.findFirstOrThrow({ where: { userId: hr.id, channel: 'EMAIL' } })).toMatchObject({ reason: 'SUMMARY', dueAt: sevenAm });
  });
});

describe('Settings › when things reach you', () => {
  beforeEach(async () => {
    await truncateAll();
    resetDeliveryPrefsCache();
    env.NOTIFY_ROLE_DEFAULTS = true;
  });
  afterEach(() => {
    env.NOTIFY_ROLE_DEFAULTS = false;
  });

  async function loginAs(email: string): Promise<TestAgent<Test>> {
    const a = request.agent(createApp());
    const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
    if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
    return a;
  }

  it('shows the role defaults until the person chooses, then keeps the whole set as theirs', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const first = await a.get('/auth/me/notification-delivery');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ quietHoursStart: 21 * 60, quietHoursEnd: 7 * 60, deliveryEmail: 'DAILY', isDefault: true, defaults: { deliveryEmail: 'DAILY' } });

    // Turning quiet hours off keeps the summary they were getting.
    const saved = await a.patch('/auth/me/notification-delivery').send({ quietHoursStart: null, quietHoursEnd: null });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ quietHoursStart: null, quietHoursEnd: null, deliveryEmail: 'DAILY', isDefault: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deliveryPrefsSetAt).not.toBeNull();

    const important = await a.patch('/auth/me/notification-delivery').send({ deliveryEmail: 'IMPORTANT' });
    expect(important.body).toMatchObject({ deliveryEmail: 'IMPORTANT', quietHoursStart: null });
  });
});

describe('the bell tidies what only informed', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('archives information-only rows two weeks old; anything that asked for action stays unread', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const old = new Date(Date.now() - 15 * 86_400_000);
    const recent = new Date(Date.now() - 10 * 86_400_000);
    const row = (body: string, category: string, createdAt: Date) => ({ channel: 'IN_APP' as const, status: 'SENT' as const, recipientUserId: user.id, body, category, createdAt });
    await prisma.notification.createMany({
      data: [row('earned', 'earnings', old), row('week', 'week_ahead', old), row('confirm', 'shift_confirm', old), row('earned lately', 'earnings', recent)],
    });
    const r = await runNotificationRetention();
    expect(r.infoArchived).toBe(2);
    const unread = await prisma.notification.findMany({ where: { recipientUserId: user.id, readAt: null }, select: { body: true } });
    expect(unread.map((u) => u.body).sort()).toEqual(['confirm', 'earned lately']);
  });
});
