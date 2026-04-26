import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

describe('POST /communications/admin/send', () => {
  it('IN_APP message → flips to SENT, recipient sees it in /me/inbox', async () => {
    const associate = await createAssociate();
    const { user: assoc } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const send = await hrAgent.post('/communications/admin/send').send({
      channel: 'IN_APP',
      recipientUserId: assoc.id,
      subject: 'Welcome',
      body: 'Welcome to Alto.',
    });
    expect(send.status).toBe(201);
    expect(send.body.status).toBe('SENT');
    expect(send.body.sentAt).not.toBeNull();
    expect(send.body.senderEmail).toBe(hr.email);
    expect(send.body.externalRef).toBeNull(); // IN_APP has no external ref

    const assocAgent = await loginAs(assoc.email);
    const inbox = await assocAgent.get('/communications/me/inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.body.notifications).toHaveLength(1);
    expect(inbox.body.notifications[0].body).toBe('Welcome to Alto.');
    expect(inbox.body.notifications[0].readAt).toBeNull();
  });

  it('SMS to a phone number → SENT with stub externalRef', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/communications/admin/send').send({
      channel: 'SMS',
      recipientPhone: '+1-555-0100',
      body: 'Your shift starts in 30 minutes.',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SENT');
    expect(res.body.externalRef).toMatch(/^STUB-SMS-/);
  });

  it('IN_APP requires recipientUserId → 400', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/communications/admin/send').send({
      channel: 'IN_APP',
      recipientPhone: '+1-555-0100',
      body: 'test',
    });
    expect(res.status).toBe(400);
  });

  it('rejects when no recipient is specified at all → 400', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/communications/admin/send').send({
      channel: 'EMAIL',
      body: 'hello',
    });
    expect(res.status).toBe(400);
  });

  it('ASSOCIATE cannot send (lacks manage:communications)', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);
    const res = await a.post('/communications/admin/send').send({
      channel: 'IN_APP',
      recipientUserId: user.id,
      body: 'test',
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /communications/admin/broadcast', () => {
  it('IN_APP broadcast to ALL_ASSOCIATES creates one notification per active associate', async () => {
    // Two associates with logins, one HR
    const a1 = await createAssociate();
    await createUser({ role: 'ASSOCIATE', email: a1.email, associateId: a1.id });
    const a2 = await createAssociate();
    await createUser({ role: 'ASSOCIATE', email: a2.email, associateId: a2.id });
    await createUser({ role: 'HR_ADMINISTRATOR' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const res = await hrAgent.post('/communications/admin/broadcast').send({
      channel: 'IN_APP',
      audience: 'ALL_ASSOCIATES',
      subject: 'Holiday',
      body: 'Office closed Monday.',
    });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);

    const rows = await prisma.notification.findMany({
      where: { senderUserId: hr.id, body: 'Office closed Monday.' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'SENT')).toBe(true);
  });

  it('SMS broadcast is rejected by Zod (channel.exclude(SMS))', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/communications/admin/broadcast').send({
      channel: 'SMS',
      audience: 'ALL_ASSOCIATES',
      body: 'test',
    });
    expect(res.status).toBe(400);
  });
});

describe('Inbox (/me/inbox)', () => {
  it('mark-read sets status=READ and readAt', async () => {
    const associate = await createAssociate();
    const { user: assoc } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const send = await hrAgent.post('/communications/admin/send').send({
      channel: 'IN_APP',
      recipientUserId: assoc.id,
      body: 'hello',
    });

    const assocAgent = await loginAs(assoc.email);
    const read = await assocAgent.post(`/communications/me/inbox/${send.body.id}/read`).send({});
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('READ');
    expect(read.body.readAt).not.toBeNull();
  });

  it('mark-read against another user\'s notification → 404', async () => {
    const a1 = await createAssociate();
    const { user: u1 } = await createUser({
      role: 'ASSOCIATE',
      email: a1.email,
      associateId: a1.id,
    });
    const a2 = await createAssociate();
    const { user: u2 } = await createUser({
      role: 'ASSOCIATE',
      email: a2.email,
      associateId: a2.id,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const send = await hrAgent.post('/communications/admin/send').send({
      channel: 'IN_APP',
      recipientUserId: u1.id,
      body: 'private',
    });

    const a2Agent = await loginAs(u2.email);
    const res = await a2Agent.post(`/communications/me/inbox/${send.body.id}/read`).send({});
    expect(res.status).toBe(404);
  });
});

describe('CLIENT_PORTAL access', () => {
  it('lacks view:communications → 403 across the router', async () => {
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: null });
    const a = await loginAs(portal.email);
    const inbox = await a.get('/communications/me/inbox');
    expect(inbox.status).toBe(403);
  });
});
