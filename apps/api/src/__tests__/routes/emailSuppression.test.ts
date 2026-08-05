import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { send } from '../../lib/notifications.js';
import { notifyUser, flushPendingNotifications } from '../../lib/notify.js';
import { mintUnsubscribeToken } from '../../lib/emailUnsubscribe.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { prisma, truncateAll, createUser } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
  (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = undefined;
  (env as { RESEND_FROM?: string }).RESEND_FROM = undefined;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Swap in a fetch mock that answers like Resend's send endpoint. */
function mockResendFetch(id = 'msg_mocked_1') {
  const mock = vi.fn(
    async () =>
      new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Turn on "real send" mode (against the mocked fetch). */
function enableRealSendMode() {
  (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 're_test_key';
  (env as { RESEND_FROM?: string }).RESEND_FROM = 'Alto HR <hr@altohr.com>';
}

function lastFetchPayload(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was never called');
  const init = call[1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('suppression short-circuits the send path', () => {
  it('a suppressed address yields a SUPPRESSED notification row and no provider call', async () => {
    const mock = mockResendFetch();
    enableRealSendMode();
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.emailSuppression.create({
      data: { email: user.email.toLowerCase(), reason: 'BOUNCED' },
    });

    await notifyUser(user.id, {
      subject: 'Hi',
      body: 'This must not go out.',
      category: 'documents',
    });
    await flushPendingNotifications();

    const emailRow = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: user.id, channel: 'EMAIL' },
    });
    expect(emailRow.status).toBe('SUPPRESSED');
    expect(emailRow.failureReason).toContain('suppression list');
    expect(mock).not.toHaveBeenCalled();

    // The bell copy still lands — suppression only blocks email.
    const inApp = await prisma.notification.findFirst({
      where: { recipientUserId: user.id, channel: 'IN_APP' },
    });
    expect(inApp).not.toBeNull();
  });

  it('complaint-suppressed addresses short-circuit the same way (stub mode too)', async () => {
    // No RESEND creds here — the check must fire before the stub branch.
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.emailSuppression.create({
      data: { email: user.email.toLowerCase(), reason: 'COMPLAINED' },
    });
    await notifyUser(user.id, { subject: 'Hi', body: 'Nope.', category: 'documents' });
    await flushPendingNotifications();
    const emailRow = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: user.id, channel: 'EMAIL' },
    });
    expect(emailRow.status).toBe('SUPPRESSED');
  });

  it('an unsuppressed address still sends and stores providerMessageId', async () => {
    const mock = mockResendFetch('msg_stored_42');
    enableRealSendMode();
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await notifyUser(user.id, { subject: 'Hi', body: 'Goes out.', category: 'documents' });
    await flushPendingNotifications();
    const emailRow = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: user.id, channel: 'EMAIL' },
    });
    expect(emailRow.status).toBe('SENT');
    expect(emailRow.providerMessageId).toBe('msg_stored_42');
    expect(emailRow.externalRef).toBe('msg_stored_42');
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('List-Unsubscribe headers', () => {
  it('broadcast-category email carries one-click unsubscribe headers', async () => {
    const mock = mockResendFetch();
    enableRealSendMode();
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await notifyUser(user.id, {
      subject: 'Company update',
      body: 'Announcement text',
      category: 'broadcast',
    });
    await flushPendingNotifications();

    const payload = lastFetchPayload(mock);
    const headers = payload.headers as Record<string, string>;
    expect(headers).toBeDefined();
    expect(headers['List-Unsubscribe']).toContain('/communications/unsubscribe/');
    expect(headers['List-Unsubscribe']).toContain('<mailto:');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('transactional email carries NO unsubscribe headers', async () => {
    const mock = mockResendFetch();
    enableRealSendMode();
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await notifyUser(user.id, {
      subject: 'Your document was approved',
      body: 'Transactional text',
      category: 'documents',
    });
    await flushPendingNotifications();

    const payload = lastFetchPayload(mock);
    expect(payload.headers).toBeUndefined();
  });

  it('direct send() without includeUnsubscribe carries no headers; with it, it does', async () => {
    const mock = mockResendFetch();
    enableRealSendMode();

    await send({
      channel: 'EMAIL',
      recipient: { userId: null, phone: null, email: 'plain@example.com' },
      subject: 'Invite',
      body: 'Transactional',
    });
    expect(lastFetchPayload(mock).headers).toBeUndefined();

    await send({
      channel: 'EMAIL',
      recipient: { userId: null, phone: null, email: 'broadcast@example.com' },
      subject: 'News',
      body: 'Broadcast',
      includeUnsubscribe: true,
    });
    const headers = lastFetchPayload(mock).headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toContain('/communications/unsubscribe/');
  });
});

describe('POST /communications/unsubscribe/:token', () => {
  it('one-click POST (no session) mutes the broadcast email bucket', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const token = mintUnsubscribeToken(user.email);
    const res = await request(app())
      .post(`/communications/unsubscribe/${token}`)
      // Mailbox providers send the RFC 8058 form body; we ignore it.
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);

    const pref = await prisma.notificationPreference.findUnique({
      where: { userId_category: { userId: user.id, category: 'broadcast' } },
    });
    expect(pref?.emailEnabled).toBe(false);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'email.unsubscribed', entityId: user.id },
    });
    expect(audit).not.toBeNull();
  });

  it('after unsubscribing, broadcast email is skipped but the bell copy still lands', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const token = mintUnsubscribeToken(user.email);
    await request(app()).post(`/communications/unsubscribe/${token}`);

    await notifyUser(user.id, {
      subject: 'Company update',
      body: 'Announcement',
      category: 'broadcast',
    });
    await flushPendingNotifications();

    const emailRows = await prisma.notification.count({
      where: { recipientUserId: user.id, channel: 'EMAIL' },
    });
    expect(emailRows).toBe(0);
    const inApp = await prisma.notification.count({
      where: { recipientUserId: user.id, channel: 'IN_APP' },
    });
    expect(inApp).toBe(1);
  });

  it('rejects a tampered token with 400 and writes nothing', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const token = mintUnsubscribeToken(user.email);
    const tampered = `${token.slice(0, -4)}AAAA`;
    const res = await request(app()).post(`/communications/unsubscribe/${tampered}`);
    expect(res.status).toBe(400);
    expect(await prisma.notificationPreference.count()).toBe(0);
  });

  it('returns 200 for a valid token with no matching account (no address oracle)', async () => {
    const token = mintUnsubscribeToken('ghost@example.com');
    const res = await request(app()).post(`/communications/unsubscribe/${token}`);
    expect(res.status).toBe(200);
  });
});

describe('suppression admin endpoints', () => {
  it('lists and deletes (un-suppresses, audited) under manage:communications', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    await prisma.emailSuppression.create({
      data: { email: 'dead@example.com', reason: 'BOUNCED', notes: '550 user unknown' },
    });

    const list = await a.get('/communications/admin/suppressions');
    expect(list.status).toBe(200);
    expect(list.body.suppressions).toHaveLength(1);
    expect(list.body.suppressions[0]).toMatchObject({
      email: 'dead@example.com',
      reason: 'BOUNCED',
      notes: '550 user unknown',
    });

    const del = await a.delete(
      `/communications/admin/suppressions/${encodeURIComponent('dead@example.com')}`,
    );
    expect(del.status).toBe(204);
    expect(await prisma.emailSuppression.count()).toBe(0);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'email.unsuppressed', entityId: 'dead@example.com' },
    });
    expect(audit?.actorUserId).toBe(hr.id);

    const delAgain = await a.delete(
      '/communications/admin/suppressions/dead%40example.com',
    );
    expect(delAgain.status).toBe(404);
  });

  it('associates cannot list or delete suppressions', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), user.email);
    await prisma.emailSuppression.create({
      data: { email: 'dead@example.com', reason: 'MANUAL' },
    });
    expect((await a.get('/communications/admin/suppressions')).status).toBe(403);
    expect(
      (await a.delete('/communications/admin/suppressions/dead%40example.com')).status,
    ).toBe(403);
  });
});
