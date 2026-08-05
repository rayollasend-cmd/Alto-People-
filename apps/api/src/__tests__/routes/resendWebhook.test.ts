import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { signResendWebhook } from '../../lib/resendWebhook.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { prisma, truncateAll } from '../../../test/db.js';

const app = () => createApp();

const SECRET = process.env.RESEND_WEBHOOK_SECRET!;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

let svixCounter = 0;

function postWebhook(
  body: object,
  opts: { svixId?: string; timestamp?: string; signature?: string | false } = {},
) {
  const raw = JSON.stringify(body);
  const svixId = opts.svixId ?? `svix_${Date.now()}_${svixCounter++}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'svix-id': svixId,
    'svix-timestamp': timestamp,
  };
  if (opts.signature !== false) {
    headers['svix-signature'] =
      opts.signature ?? signResendWebhook(raw, svixId, timestamp, SECRET);
  }
  return request(app()).post('/resend/webhook').set(headers).send(raw);
}

async function seedEmailNotification(opts: {
  providerMessageId?: string | null;
  externalRef?: string | null;
  recipientEmail?: string;
}) {
  return prisma.notification.create({
    data: {
      channel: 'EMAIL',
      status: 'SENT',
      recipientEmail: opts.recipientEmail ?? 'bouncer@example.com',
      subject: 'Hello',
      body: 'Test body',
      providerMessageId: opts.providerMessageId ?? null,
      externalRef: opts.externalRef ?? null,
      sentAt: new Date(),
    },
  });
}

describe('POST /resend/webhook — gating', () => {
  it('returns 503 when RESEND_WEBHOOK_SECRET is not configured', async () => {
    const saved = env.RESEND_WEBHOOK_SECRET;
    // env is a plain parsed object — mutate and restore around the call.
    (env as { RESEND_WEBHOOK_SECRET?: string }).RESEND_WEBHOOK_SECRET = undefined;
    try {
      const res = await postWebhook({ type: 'email.delivered', data: {} });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('webhook_not_configured');
    } finally {
      (env as { RESEND_WEBHOOK_SECRET?: string }).RESEND_WEBHOOK_SECRET = saved;
    }
  });

  it('returns 401 on a bad signature, no DB write', async () => {
    const n = await seedEmailNotification({ providerMessageId: 'msg_badsig' });
    const res = await postWebhook(
      { type: 'email.bounced', data: { email_id: 'msg_badsig' } },
      { signature: `v1,${Buffer.alloc(32, 1).toString('base64')}` },
    );
    expect(res.status).toBe(401);
    expect(await prisma.resendWebhookEvent.count()).toBe(0);
    const refreshed = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(refreshed.status).toBe('SENT');
  });

  it('returns 401 on a stale timestamp even with a correctly derived signature', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const res = await postWebhook(
      { type: 'email.delivered', data: {} },
      { timestamp: stale },
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /resend/webhook — event handling', () => {
  it('email.bounced flips the notification to BOUNCED and creates a suppression (audited)', async () => {
    const n = await seedEmailNotification({
      providerMessageId: 'msg_bounce_1',
      recipientEmail: 'Bouncer@Example.com',
    });
    const res = await postWebhook({
      type: 'email.bounced',
      data: {
        email_id: 'msg_bounce_1',
        to: ['Bouncer@Example.com'],
        bounce: { type: 'Permanent', message: '550 5.1.1 user unknown' },
      },
    });
    expect(res.status).toBe(200);

    const refreshed = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(refreshed.status).toBe('BOUNCED');
    expect(refreshed.failureReason).toContain('550 5.1.1');

    // Suppression stored lowercased.
    const supp = await prisma.emailSuppression.findUnique({
      where: { email: 'bouncer@example.com' },
    });
    expect(supp?.reason).toBe('BOUNCED');

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'email.suppressed', entityId: 'bouncer@example.com' },
    });
    expect(audit).not.toBeNull();

    const ev = await prisma.resendWebhookEvent.findFirstOrThrow({
      where: { eventType: 'email.bounced' },
    });
    expect(ev.status).toBe('PROCESSED');
    expect(ev.notificationId).toBe(n.id);
  });

  it('a TRANSIENT bounce marks BOUNCED but does NOT suppress', async () => {
    await seedEmailNotification({
      providerMessageId: 'msg_soft',
      recipientEmail: 'full-mailbox@example.com',
    });
    const res = await postWebhook({
      type: 'email.bounced',
      data: {
        email_id: 'msg_soft',
        bounce: { type: 'Transient', message: '452 mailbox full' },
      },
    });
    expect(res.status).toBe(200);
    const n = await prisma.notification.findFirstOrThrow({
      where: { providerMessageId: 'msg_soft' },
    });
    expect(n.status).toBe('BOUNCED');
    expect(await prisma.emailSuppression.count()).toBe(0);
  });

  it('email.complained flips to COMPLAINED and suppresses with reason COMPLAINED', async () => {
    const n = await seedEmailNotification({
      providerMessageId: 'msg_spam',
      recipientEmail: 'annoyed@example.com',
    });
    const res = await postWebhook({
      type: 'email.complained',
      data: { email_id: 'msg_spam', to: ['annoyed@example.com'] },
    });
    expect(res.status).toBe(200);
    const refreshed = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(refreshed.status).toBe('COMPLAINED');
    const supp = await prisma.emailSuppression.findUnique({
      where: { email: 'annoyed@example.com' },
    });
    expect(supp?.reason).toBe('COMPLAINED');
  });

  it('a complaint UPGRADES an existing BOUNCED suppression to COMPLAINED', async () => {
    await prisma.emailSuppression.create({
      data: { email: 'annoyed@example.com', reason: 'BOUNCED' },
    });
    await seedEmailNotification({
      providerMessageId: 'msg_spam_2',
      recipientEmail: 'annoyed@example.com',
    });
    await postWebhook({
      type: 'email.complained',
      data: { email_id: 'msg_spam_2' },
    });
    const supp = await prisma.emailSuppression.findUniqueOrThrow({
      where: { email: 'annoyed@example.com' },
    });
    expect(supp.reason).toBe('COMPLAINED');
  });

  it('email.delivered records the event but leaves the notification status alone', async () => {
    const n = await seedEmailNotification({ providerMessageId: 'msg_ok' });
    const res = await postWebhook({
      type: 'email.delivered',
      data: { email_id: 'msg_ok' },
    });
    expect(res.status).toBe(200);
    const refreshed = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(refreshed.status).toBe('SENT');
    const ev = await prisma.resendWebhookEvent.findFirstOrThrow({
      where: { eventType: 'email.delivered' },
    });
    expect(ev.status).toBe('PROCESSED');
    expect(ev.notificationId).toBe(n.id);
  });

  it('matches legacy rows by externalRef when providerMessageId is null', async () => {
    const n = await seedEmailNotification({
      providerMessageId: null,
      externalRef: 'msg_legacy',
      recipientEmail: 'legacy@example.com',
    });
    const res = await postWebhook({
      type: 'email.bounced',
      data: { email_id: 'msg_legacy', bounce: { type: 'Permanent' } },
    });
    expect(res.status).toBe(200);
    const refreshed = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(refreshed.status).toBe('BOUNCED');
    expect(
      await prisma.emailSuppression.findUnique({ where: { email: 'legacy@example.com' } }),
    ).not.toBeNull();
  });

  it('ignores unhandled event types with 200 (logged IGNORED)', async () => {
    const res = await postWebhook({ type: 'email.opened', data: { email_id: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('unhandled_event_type');
    const ev = await prisma.resendWebhookEvent.findFirstOrThrow({
      where: { eventType: 'email.opened' },
    });
    expect(ev.status).toBe('IGNORED');
  });

  it('ignores unknown message ids with 200 (logged IGNORED)', async () => {
    const res = await postWebhook({
      type: 'email.bounced',
      data: { email_id: 'msg_not_ours', bounce: { type: 'Permanent' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('unknown_message_id');
    const ev = await prisma.resendWebhookEvent.findFirstOrThrow({
      where: { eventType: 'email.bounced' },
    });
    expect(ev.status).toBe('IGNORED');
    expect(ev.notes).toContain('msg_not_ours');
  });

  it('is idempotent by svix-id — duplicate delivery short-circuits', async () => {
    const n = await seedEmailNotification({ providerMessageId: 'msg_dupe' });
    const body = {
      type: 'email.bounced',
      data: { email_id: 'msg_dupe', bounce: { type: 'Permanent' } },
    };
    const r1 = await postWebhook(body, { svixId: 'svix_fixed_dupe' });
    expect(r1.status).toBe(200);
    const r2 = await postWebhook(body, { svixId: 'svix_fixed_dupe' });
    expect(r2.status).toBe(200);
    expect(r2.body.ignored).toBe('duplicate');
    expect(
      await prisma.resendWebhookEvent.count({ where: { svixId: 'svix_fixed_dupe' } }),
    ).toBe(1);
    void n;
  });
});
