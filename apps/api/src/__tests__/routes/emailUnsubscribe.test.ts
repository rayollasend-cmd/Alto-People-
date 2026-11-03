import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { send } from '../../lib/notifications.js';
import { manageNotificationsUrl, renderBrandedEmail } from '../../lib/emailLayout.js';
import { genericNotificationTemplate } from '../../lib/emailTemplates.js';
import { mintBucketUnsubscribeToken, mintUnsubscribeToken, readUnsubscribeToken } from '../../lib/emailUnsubscribe.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { prisma, truncateAll, createUser } from '../../../test/db.js';

/**
 * Owner, 2026-11-02: people were bombarded and no email said how to change
 * it. Every email now links to Settings › Notifications, and every notice
 * that can be muted carries "Stop emails like this" plus one-click
 * unsubscribe headers that mute its ONE settings bucket. The link opens a
 * page that only explains; its button does the muting.
 */

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

/** Real-send mode against a fetch that answers like Resend. */
function mockResend() {
  const mock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', mock);
  (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 're_test_key';
  (env as { RESEND_FROM?: string }).RESEND_FROM = 'Alto HR <hr@altohr.com>';
  return () => {
    const call = mock.mock.calls.at(-1) as unknown as [string, { body: string }] | undefined;
    if (!call) throw new Error('fetch was never called');
    return JSON.parse(call[1].body) as { text: string; html?: string; headers?: Record<string, string> };
  };
}

const tokenIn = (header: string) => /\/communications\/unsubscribe\/([^>]+)>/.exec(header)?.[1] ?? '';
const prefs = (userId: string) => prisma.notificationPreference.findMany({ where: { userId }, select: { category: true, emailEnabled: true } });
/** What a browser sends when a person opens a link. */
const navigation = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' };

describe('every email says where to change what arrives', () => {
  it('a notice with a bucket carries one-click headers and a stop link for that bucket only', async () => {
    const last = mockResend();
    const tpl = genericNotificationTemplate({ subject: 'Your shift moved', body: 'Saturday now starts at 9.', linkUrl: '/scheduling' });
    await send({
      channel: 'EMAIL',
      recipient: { userId: null, phone: null, email: 'Maria@Example.com' },
      subject: 'Your shift moved',
      body: tpl.text,
      html: tpl.html,
      unsubscribe: { bucket: 'scheduling' },
    });
    const payload = last();
    expect(payload.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(payload.headers!['List-Unsubscribe']).toContain('<mailto:');
    const token = tokenIn(payload.headers!['List-Unsubscribe']);
    expect(readUnsubscribeToken(token)).toEqual({ email: 'maria@example.com', bucket: 'scheduling', mandatory: false });
    // The same address is the footer's "Stop emails like this", in both parts.
    expect(payload.html).toContain('Manage notifications');
    expect(payload.html).toContain(manageNotificationsUrl());
    expect(payload.html).toContain('Stop emails like this');
    expect(payload.html).toContain(`/communications/unsubscribe/${token}`);
    expect(payload.text).toContain(`Manage notifications: ${manageNotificationsUrl()}`);
    expect(payload.text).toContain(`Stop emails like this: `);
    expect(payload.text).toContain(token);
  });

  it('transactional mail gets the Manage link and nothing else; a required bucket is never offered', async () => {
    const last = mockResend();
    await send({ channel: 'EMAIL', recipient: { userId: null, phone: null, email: 'plain@example.com' }, subject: 'Reset', body: 'Use the link.' });
    let payload = last();
    expect(payload.headers).toBeUndefined();
    expect(payload.text).toContain(`Manage notifications: ${manageNotificationsUrl()}`);
    expect(payload.text).not.toContain('Stop emails like this');

    await send({
      channel: 'EMAIL',
      recipient: { userId: null, phone: null, email: 'plain@example.com' },
      subject: 'New sign-in',
      body: 'Was this you?',
      html: '<html><body><p>Was this you?</p></body></html>',
      unsubscribe: { bucket: 'security' },
    });
    payload = last();
    expect(payload.headers).toBeUndefined();
    expect(payload.html).toContain('Manage notifications');
    expect(payload.html).not.toContain('Stop emails like this');
    expect(payload.html!.indexOf('Manage notifications')).toBeLessThan(payload.html!.indexOf('</body>'));
  });

  it('the branded layout carries its own Manage link, in its language, and gets the stop link beside it — never twice', async () => {
    const drawn = renderBrandedEmail({ lang: 'es', subject: 'Turno', preheader: 'Turno', heading: 'Su turno cambió', paragraphs: ['El sábado empieza a las 9.'] });
    expect(drawn.html).toContain('Administrar notificaciones');
    expect(drawn.text).toContain(`Administrar notificaciones: ${manageNotificationsUrl()}`);
    const last = mockResend();
    await send({
      channel: 'EMAIL',
      recipient: { userId: null, phone: null, email: 'ana@example.com' },
      subject: drawn.subject,
      body: drawn.text,
      html: drawn.html,
      unsubscribe: { bucket: 'scheduling' },
    });
    const payload = last();
    expect(payload.html!.split('Administrar notificaciones').length - 1).toBe(1);
    expect(payload.html).toContain('Dejar de recibir correos como este');
    expect(payload.text.split(manageNotificationsUrl()).length - 1).toBe(1);
    expect(payload.text).toContain('Dejar de recibir correos como este: ');
  });

  it('announcements keep the token they always had', async () => {
    const last = mockResend();
    await send({ channel: 'EMAIL', recipient: { userId: null, phone: null, email: 'news@example.com' }, subject: 'News', body: 'Hello', includeUnsubscribe: true });
    const token = tokenIn(last().headers!['List-Unsubscribe']);
    expect(token).toBe(mintUnsubscribeToken('news@example.com'));
  });
});

describe('the unsubscribe link', () => {
  it('a bucket token mutes that bucket\'s email only, for the account on that address', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const { user: other } = await createUser({ role: 'ASSOCIATE' });
    const res = await request(app())
      .post(`/communications/unsubscribe/${mintBucketUnsubscribeToken(user.email, 'scheduling')}`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(await prefs(user.id)).toEqual([{ category: 'scheduling', emailEnabled: false }]);
    expect(await prefs(other.id)).toEqual([]);
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'email.unsubscribed', entityId: user.id } });
    expect(audit?.metadata).toMatchObject({ category: 'scheduling', via: 'list-unsubscribe' });
  });

  it('opening the link changes nothing: the page explains, and its button does the muting', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const token = mintBucketUnsubscribeToken(user.email, 'scheduling');
    // The address in the email is under /api; a browser opening it is sent
    // to the page itself, which the API draws (not the app shell).
    const hop = await request(app()).get(`/api/communications/unsubscribe/${token}`).set(navigation);
    expect(hop.status).toBe(302);
    expect(hop.headers.location).toBe(`/communications/unsubscribe/${token}`);
    const page = await request(app()).get(`/communications/unsubscribe/${token}`).set(navigation);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.text).toContain('Stop these emails');
    expect(page.text).toContain('Schedule changes');
    expect(page.text).toContain('<form method="post" action="?via=page">');
    expect(page.text).toContain(manageNotificationsUrl());
    expect(page.text).not.toMatch(/<script/i);
    expect(await prefs(user.id)).toEqual([]);

    const done = await request(app()).post(`/communications/unsubscribe/${token}?via=page`).type('form').send('');
    expect(done.status).toBe(200);
    expect(done.headers['content-type']).toMatch(/text\/html/);
    expect(done.text).toContain('these emails have stopped');
    expect(done.text).toContain(manageNotificationsUrl());
    expect(await prefs(user.id)).toEqual([{ category: 'scheduling', emailEnabled: false }]);
  });

  it('speaks the browser\'s language', async () => {
    const token = mintBucketUnsubscribeToken('ana@example.com', 'scheduling');
    const page = await request(app()).get(`/communications/unsubscribe/${token}`).set({ ...navigation, 'accept-language': 'es-US,es;q=0.9,en;q=0.8' });
    expect(page.text).toContain('<html lang="es">');
    expect(page.text).toContain('Dejar de recibir estos correos');
  });

  it('refuses a required bucket — security, safety and formal HR notices always reach people', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const token = mintBucketUnsubscribeToken(user.email, 'security');
    const res = await request(app()).post(`/communications/unsubscribe/${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code ?? res.body.code).toBe('always_on');
    const page = await request(app()).get(`/communications/unsubscribe/${token}`).set(navigation);
    expect(page.status).toBe(200);
    expect(page.text).toContain('can’t be turned off');
    expect(page.text).not.toContain('<form');
    expect(await prisma.notificationPreference.count()).toBe(0);
  });

  it('a token is bound to its bucket: swapping the bucket, or a forged one, is refused', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const [payload, , sig] = mintBucketUnsubscribeToken(user.email, 'scheduling').split('.');
    const swapped = `${payload}.time_pay.${sig}`;
    expect(readUnsubscribeToken(swapped)).toBeNull();
    expect((await request(app()).post(`/communications/unsubscribe/${swapped}`)).status).toBe(400);
    const unknown = mintBucketUnsubscribeToken(user.email, 'not_a_bucket');
    expect((await request(app()).post(`/communications/unsubscribe/${unknown}`)).status).toBe(400);
    const page = await request(app()).get(`/communications/unsubscribe/${swapped}`).set(navigation);
    expect(page.status).toBe(400);
    expect(page.text).toContain('This link doesn’t work');
    expect(await prisma.notificationPreference.count()).toBe(0);
  });

  it('an announcement token from an older email still mutes announcements', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const res = await request(app()).post(`/communications/unsubscribe/${mintUnsubscribeToken(user.email)}`);
    expect(res.status).toBe(200);
    expect(await prefs(user.id)).toEqual([{ category: 'broadcast', emailEnabled: false }]);
    const page = await request(app()).get(`/communications/unsubscribe/${mintUnsubscribeToken(user.email)}`).set(navigation);
    expect(page.text).toContain('Company announcements');
  });
});
