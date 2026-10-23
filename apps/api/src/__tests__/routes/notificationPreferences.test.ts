import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { env } from '../../config/env.js';
import { flushPendingNotifications, notifyUser } from '../../lib/notify.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /auth/me/notification-preferences', () => {
  it('returns the full catalog with sensible defaults for a user with no rows', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.get('/auth/me/notification-preferences');
    expect(res.status).toBe(200);
    const entries = res.body.entries as Array<{
      category: string;
      label: string;
      mandatory: boolean;
      emailEnabled: boolean;
    }>;
    // 9 staff opt-out-able + messages + 3 mandatory = 13; the portal
    // buckets are not offered to staff.
    expect(entries.length).toBe(13);
    expect(entries.some((e) => e.category.startsWith('store_'))).toBe(false);
    // Every entry defaults to enabled when no row exists.
    expect(entries.every((e) => e.emailEnabled)).toBe(true);
    // Mandatory ones are flagged.
    const mandatoryKeys = entries.filter((e) => e.mandatory).map((e) => e.category);
    expect(mandatoryKeys.sort()).toEqual(['discipline', 'probation', 'security']);
  });

  it('reflects a stored mute', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.notificationPreference.create({
      data: { userId: user.id, category: 'onboarding', emailEnabled: false },
    });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.get('/auth/me/notification-preferences');
    const entries = res.body.entries as Array<{ category: string; emailEnabled: boolean }>;
    const onboarding = entries.find((e) => e.category === 'onboarding');
    expect(onboarding?.emailEnabled).toBe(false);
  });

  it('offers a portal account its store buckets, not the HR ones', async () => {
    const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: null });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.get('/auth/me/notification-preferences');
    const keys = (res.body.entries as Array<{ category: string }>).map((e) => e.category).sort();
    expect(keys).toEqual(['messages', 'security', 'store_alerts', 'store_daily', 'store_reports', 'store_requests']);
    expect((await a.patch('/auth/me/notification-preferences').send({ category: 'store_alerts', emailEnabled: false })).status).toBe(204);
    expect((await a.patch('/auth/me/notification-preferences').send({ category: 'onboarding', emailEnabled: false })).status).toBe(400);
  });

  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a.get('/auth/me/notification-preferences');
    expect(res.status).toBe(401);
  });

  it('reports the Push switch per category, on by default and on for mandatory ones', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.notificationPreference.createMany({
      data: [
        { userId: user.id, category: 'scheduling', pushEnabled: false },
        // A stale row PATCH would refuse: the mandatory bucket still reads on.
        { userId: user.id, category: 'discipline', pushEnabled: false },
      ],
    });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const entries = (await a.get('/auth/me/notification-preferences')).body.entries as Array<{
      category: string;
      emailEnabled: boolean;
      inAppEnabled: boolean;
      pushEnabled: boolean;
    }>;
    const by = (k: string) => entries.find((e) => e.category === k)!;
    expect(by('scheduling')).toMatchObject({ pushEnabled: false, emailEnabled: true, inAppEnabled: true });
    expect(by('discipline').pushEnabled).toBe(true);
    expect(by('documents').pushEnabled).toBe(true);
  });
});

describe('GET /auth/me/notification-preferences: where a push can reach', () => {
  const saved = {
    VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
    APNS_KEY_ID: env.APNS_KEY_ID,
    APNS_TEAM_ID: env.APNS_TEAM_ID,
    APNS_PRIVATE_KEY: env.APNS_PRIVATE_KEY,
    FCM_PROJECT_ID: env.FCM_PROJECT_ID,
  };
  afterEach(() => {
    Object.assign(env, saved);
  });

  it('says so plainly when the server has no push transport: nothing would carry a push', async () => {
    Object.assign(env, { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, APNS_KEY_ID: undefined, FCM_PROJECT_ID: undefined });
    const { user } = await createUser({ role: 'ASSOCIATE' });
    // Rows exist, but no transport could use them: not counted.
    await prisma.pushSubscription.create({ data: { userId: user.id, endpoint: 'https://push.example/one', p256dh: 'k', auth: 'a' } });
    await prisma.nativeDevice.create({ data: { userId: user.id, platform: 'IOS', pushToken: 'ios-token-reach-0' } });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.get('/auth/me/notification-preferences');
    expect(res.body.push).toEqual({ web: false, native: false, devices: 0 });
  });

  it('counts only this person’s browsers and phones a configured transport reaches', async () => {
    // Web push and APNs set up; FCM not.
    Object.assign(env, {
      VAPID_PUBLIC_KEY: 'test-public',
      VAPID_PRIVATE_KEY: 'test-private',
      APNS_KEY_ID: 'KEY',
      APNS_TEAM_ID: 'TEAM',
      APNS_PRIVATE_KEY: 'pem',
      FCM_PROJECT_ID: undefined,
    });
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const { user: other } = await createUser({ role: 'ASSOCIATE' });
    await prisma.pushSubscription.createMany({
      data: [
        { userId: user.id, endpoint: 'https://push.example/a', p256dh: 'k', auth: 'a' },
        { userId: user.id, endpoint: 'https://push.example/b', p256dh: 'k', auth: 'a' },
        { userId: other.id, endpoint: 'https://push.example/c', p256dh: 'k', auth: 'a' },
      ],
    });
    await prisma.nativeDevice.createMany({
      data: [
        { userId: user.id, platform: 'IOS', pushToken: 'ios-token-reach-1' },
        // Not counted: no token, signed out, a platform with no key, someone else's.
        { userId: user.id, platform: 'IOS', pushToken: null },
        { userId: user.id, platform: 'IOS', pushToken: 'ios-token-reach-2', revokedAt: new Date() },
        { userId: user.id, platform: 'ANDROID', pushToken: 'fcm-token-reach-1' },
        { userId: other.id, platform: 'IOS', pushToken: 'ios-token-reach-3' },
      ],
    });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.get('/auth/me/notification-preferences');
    expect(res.body.push).toEqual({ web: true, native: true, devices: 3 });
  });
});

describe('PATCH /auth/me/notification-preferences', () => {
  it('upserts the row and persists', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .patch('/auth/me/notification-preferences')
      .send({ category: 'documents', emailEnabled: false });
    expect(res.status).toBe(204);

    const stored = await prisma.notificationPreference.findUnique({
      where: { userId_category: { userId: user.id, category: 'documents' } },
    });
    expect(stored?.emailEnabled).toBe(false);

    // Re-enable: same row updated, not a duplicate.
    const res2 = await a
      .patch('/auth/me/notification-preferences')
      .send({ category: 'documents', emailEnabled: true });
    expect(res2.status).toBe(204);
    const all = await prisma.notificationPreference.findMany({
      where: { userId: user.id },
    });
    expect(all.length).toBe(1);
    expect(all[0].emailEnabled).toBe(true);
  });

  it('turns push off for one category and leaves its email and bell alone', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    expect((await a.patch('/auth/me/notification-preferences').send({ category: 'scheduling', pushEnabled: false })).status).toBe(204);
    let row = await prisma.notificationPreference.findUniqueOrThrow({
      where: { userId_category: { userId: user.id, category: 'scheduling' } },
    });
    expect(row).toMatchObject({ pushEnabled: false, emailEnabled: true, inAppEnabled: true });

    // Email off next: push stays as it was.
    expect((await a.patch('/auth/me/notification-preferences').send({ category: 'scheduling', emailEnabled: false })).status).toBe(204);
    row = await prisma.notificationPreference.findUniqueOrThrow({
      where: { userId_category: { userId: user.id, category: 'scheduling' } },
    });
    expect(row).toMatchObject({ pushEnabled: false, emailEnabled: false, inAppEnabled: true });

    expect((await a.patch('/auth/me/notification-preferences').send({ category: 'scheduling', pushEnabled: true })).status).toBe(204);
    row = await prisma.notificationPreference.findUniqueOrThrow({
      where: { userId_category: { userId: user.id, category: 'scheduling' } },
    });
    expect(row).toMatchObject({ pushEnabled: true, emailEnabled: false });
  });

  it('refuses to turn push off for a mandatory category', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.patch('/auth/me/notification-preferences').send({ category: 'security', pushEnabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('mandatory_category');
    expect(await prisma.notificationPreference.count({ where: { userId: user.id } })).toBe(0);
  });

  it('refuses a body with no switch in it', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    expect((await a.patch('/auth/me/notification-preferences').send({ category: 'scheduling' })).status).toBe(400);
  });

  it('refuses to mute mandatory categories', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .patch('/auth/me/notification-preferences')
      .send({ category: 'discipline', emailEnabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('mandatory_category');
  });

  it('rejects unknown categories with 400', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .patch('/auth/me/notification-preferences')
      .send({ category: 'made_up', emailEnabled: false });
    expect(res.status).toBe(400);
  });
});

describe('notify.ts honours stored mute', () => {
  it('skips the EMAIL row when the user has muted the bucket; IN_APP still lands', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.notificationPreference.create({
      data: { userId: user.id, category: 'documents', emailEnabled: false },
    });

    await notifyUser(user.id, {
      subject: 'Doc rejected',
      body: 'Your I-9 doc was rejected.',
      category: 'documents',
    });
    await flushPendingNotifications();

    const rows = await prisma.notification.findMany({
      where: { recipientUserId: user.id },
    });
    // IN_APP always fires; EMAIL is suppressed.
    expect(rows.map((r) => r.channel).sort()).toEqual(['IN_APP']);
  });

  it('still emails for a mandatory category even if a stale row says muted', async () => {
    // Defence-in-depth: PATCH refuses to insert this row, but if one snuck
    // in via direct SQL the runtime still ignores it.
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.notificationPreference.create({
      data: { userId: user.id, category: 'discipline', emailEnabled: false },
    });

    await notifyUser(user.id, {
      subject: 'Final warning',
      body: 'You have received a final warning.',
      category: 'discipline',
    });
    await flushPendingNotifications();

    const rows = await prisma.notification.findMany({
      where: { recipientUserId: user.id },
    });
    expect(rows.map((r) => r.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
  });

  it('still emails when the muted bucket does not match the raw category', async () => {
    // Mute documents; an onboarding event should still email.
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.notificationPreference.create({
      data: { userId: user.id, category: 'documents', emailEnabled: false },
    });

    await notifyUser(user.id, {
      subject: 'Application approved',
      body: 'Your application was approved.',
      category: 'onboarding',
    });
    await flushPendingNotifications();

    const rows = await prisma.notification.findMany({
      where: { recipientUserId: user.id },
    });
    expect(rows.map((r) => r.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
  });
});
