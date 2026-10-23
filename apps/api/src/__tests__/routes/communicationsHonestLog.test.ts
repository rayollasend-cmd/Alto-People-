import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { inAppBody } from '../../lib/notifications.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * F500 G4 · Notifications: the log tells the truth and the inbox reads clean.
 *
 *  - an email written to the server log (no provider) is "loggedOnly", and
 *    filters with "Not sent", never with Sent;
 *  - the in-app body drops the app link the Open button already carries;
 *  - the channel list says who connects a channel, with the setting names
 *    only in the developer note;
 *  - "Send test email" says nothing went out when nothing could;
 *  - the sent log carries each recipient's photo, or null — no guessed URL.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
  return a;
}

describe('inAppBody', () => {
  it('drops the link and its lead-in when the row carries the link, keeps it when it does not', () => {
    const body = 'Maria is idle 33 days. Sign the agreement. Open it: http://localhost:5173/onboarding/applications/b619';
    expect(inAppBody(body, '/onboarding/applications/b619')).toBe('Maria is idle 33 days. Sign the agreement.');
    expect(inAppBody(body, null)).toBe(body);
    const own = 'Overdue.\n\nOpen the scorecard to record it.\n\nhttp://localhost:5173/compliance?tab=scorecard';
    expect(inAppBody(own, '/compliance?tab=scorecard')).toBe('Overdue.\n\nOpen the scorecard to record it.');
    // A link inside a sentence is part of the sentence; a body that is only a link stays a link.
    expect(inAppBody('See https://example.com/x for details.', '/x')).toBe('See https://example.com/x for details.');
    expect(inAppBody('https://example.com/x', '/x')).toBe('https://example.com/x');
  });
});

describe('the inbox and the sent log', () => {
  it('the inbox shows the words without the link; the log marks a logged-only email and filters it as not sent', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    await prisma.notification.create({
      data: {
        channel: 'IN_APP',
        status: 'SENT',
        recipientUserId: hr.id,
        subject: 'Onboarding stalled',
        body: 'Maria is idle. Open it: http://localhost:5173/onboarding/applications/x1',
        linkUrl: '/onboarding/applications/x1',
      },
    });
    const inbox = await a.get('/communications/me/inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.body.notifications[0].body).toBe('Maria is idle.');

    // Three emails: one logged only (no provider in tests), one the provider
    // took, one older real send with no provider reference.
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const sent = await a.post('/communications/admin/send').send({ channel: 'EMAIL', recipientEmail: ana.email, subject: 'Hello', body: 'Hi.' });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ status: 'SENT', loggedOnly: true });
    await prisma.notification.create({ data: { channel: 'EMAIL', status: 'SENT', recipientEmail: 'real@example.com', subject: 'Real', body: 'x', externalRef: 're_123' } });
    await prisma.notification.create({ data: { channel: 'EMAIL', status: 'SENT', recipientEmail: 'old@example.com', subject: 'Old', body: 'x', externalRef: null } });

    const all = await a.get('/communications/admin?channel=EMAIL');
    expect(all.body.total).toBe(3);
    const bySubject = (rows: Array<{ subject: string; loggedOnly?: boolean }>) => Object.fromEntries(rows.map((r) => [r.subject, r.loggedOnly ?? false]));
    expect(bySubject(all.body.notifications)).toEqual({ Hello: true, Real: false, Old: false });

    const sentOnly = await a.get('/communications/admin?channel=EMAIL&status=SENT');
    expect(sentOnly.body.notifications.map((n: { subject: string }) => n.subject).sort()).toEqual(['Old', 'Real']);
    expect(sentOnly.body.total).toBe(2);
    const notSent = await a.get('/communications/admin?status=NOT_CONFIGURED');
    expect(notSent.body.notifications.map((n: { subject: string }) => n.subject)).toEqual(['Hello']);
  });

  it('names each recipient with their photo, or null when none is on file', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const withPhoto = await createAssociate({ firstName: 'Pia', lastName: 'Photo' });
    await prisma.associate.update({ where: { id: withPhoto.id }, data: { photoS3Key: 'k/pia.jpg', photoUpdatedAt: new Date('2026-10-01T00:00:00Z') } });
    const { user: pia } = await createUser({ role: 'ASSOCIATE', associateId: withPhoto.id, email: withPhoto.email });
    const plain = await createAssociate({ firstName: 'Ned', lastName: 'Plain' });
    const { user: ned } = await createUser({ role: 'ASSOCIATE', associateId: plain.id, email: plain.email });
    await a.post('/communications/admin/send').send({ channel: 'IN_APP', recipientAssociateId: withPhoto.id, subject: 'A', body: 'x' });
    await a.post('/communications/admin/send').send({ channel: 'IN_APP', recipientAssociateId: plain.id, subject: 'B', body: 'x' });
    const log = await a.get('/communications/admin');
    const row = (id: string) => log.body.notifications.find((n: { recipientUserId: string }) => n.recipientUserId === id);
    expect(row(pia.id)).toMatchObject({ recipientName: 'Pia Photo', recipientPhotoUrl: `/api/associates/${withPhoto.id}/photo?v=${new Date('2026-10-01T00:00:00Z').getTime()}` });
    expect(row(ned.id)).toMatchObject({ recipientName: 'Ned Plain', recipientPhotoUrl: null });
  });
});

describe('Settings › Communications', () => {
  it('says who connects email, keeps the setting names in the developer note, and a test email says nothing went out', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr-test@example.com' });
    const a = await loginAs(hr.email);
    const ch = await a.get('/communications/admin/channels');
    const email = ch.body.channels.find((c: { channel: string }) => c.channel === 'EMAIL');
    expect(email).toMatchObject({ available: false, reason: 'Not connected for this organization yet. Alto People support connects it.' });
    expect(email.developerNote).toMatch(/RESEND_API_KEY/);
    expect(email.reason).not.toMatch(/Settings › Communications/);
    const push = ch.body.channels.find((c: { channel: string }) => c.channel === 'PUSH');
    expect(push.reason).not.toMatch(/VAPID/);
    expect(push.developerNote).toMatch(/VAPID/);

    const test = await a.post('/communications/admin/test-email').send({});
    expect(test.status).toBe(201);
    expect(test.body).toMatchObject({ delivered: false, to: 'hr-test@example.com' });
    expect(test.body.notification).toMatchObject({ channel: 'EMAIL', loggedOnly: true, category: 'communications.test', recipientEmail: 'hr-test@example.com' });
    expect(await prisma.notification.count({ where: { category: 'communications.test', recipientUserId: hr.id } })).toBe(1);

    // Only people who manage communications can send one.
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const b = await loginAs(assoc.email);
    expect((await b.post('/communications/admin/test-email').send({})).status).toBe(403);
  });
});
