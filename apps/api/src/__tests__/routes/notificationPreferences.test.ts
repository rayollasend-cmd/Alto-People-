import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
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
    // 5 opt-out-able + 3 mandatory = 8
    expect(entries.length).toBe(8);
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

  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a.get('/auth/me/notification-preferences');
    expect(res.status).toBe(401);
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
