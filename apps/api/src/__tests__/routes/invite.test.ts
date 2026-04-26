import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createStandardTemplate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { generateInviteToken } from '../../lib/inviteToken.js';

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

describe('POST /onboarding/applications creates User + InviteToken + EMAIL', () => {
  it('a fresh email creates an INVITED user, a hashed invite, and a SENT email notification', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/onboarding/applications').send({
      associateEmail: 'new.hire@example.com',
      associateFirstName: 'Demo',
      associateLastName: 'Hire',
      clientId: client.id,
      templateId: template.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.invitedUserId).toBeTruthy();
    expect(res.body.inviteUrl).toMatch(/\/accept-invite\/[A-Za-z0-9_-]+/);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'new.hire@example.com' } });
    expect(user.status).toBe('INVITED');
    expect(user.passwordHash).toBeNull();
    expect(user.role).toBe('ASSOCIATE');

    const invite = await prisma.inviteToken.findFirstOrThrow({
      where: { userId: user.id, consumedAt: null },
    });
    expect(invite.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const notif = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: user.id, channel: 'EMAIL', category: 'onboarding.invite' },
    });
    expect(notif.status).toBe('SENT'); // Resend is unset → stub returns SENT
    expect(notif.body).toContain('/accept-invite/');
  });

  it('refuses to invite an already-active user (409)', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    await createUser({ role: 'ASSOCIATE', email: 'taken@example.com' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/onboarding/applications').send({
      associateEmail: 'taken@example.com',
      associateFirstName: 'Taken',
      associateLastName: 'User',
      clientId: client.id,
      templateId: template.id,
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('user_already_active');
  });
});

describe('GET /auth/invite/:token', () => {
  it('returns invite summary for a valid token', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const create = await a.post('/onboarding/applications').send({
      associateEmail: 'pat@example.com',
      associateFirstName: 'Pat',
      associateLastName: 'Hopeful',
      clientId: client.id,
      templateId: template.id,
    });
    const url: string = create.body.inviteUrl;
    const token = url.split('/accept-invite/')[1];

    const res = await request(app()).get(`/auth/invite/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('pat@example.com');
    expect(res.body.firstName).toBe('Pat');
    expect(res.body.lastName).toBe('Hopeful');
    expect(typeof res.body.expiresAt).toBe('string');
  });

  it('returns 404 for an unknown token', async () => {
    const fake = generateInviteToken().raw;
    const res = await request(app()).get(`/auth/invite/${fake}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an expired token', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE', email: 'expired@example.com' });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'INVITED', passwordHash: null },
    });
    const t = generateInviteToken();
    await prisma.inviteToken.create({
      data: {
        tokenHash: t.hash,
        userId: user.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const res = await request(app()).get(`/auth/invite/${t.raw}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /auth/accept-invite', () => {
  it('happy path: consumes token, sets password, ACTIVE, issues session cookie', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const create = await a.post('/onboarding/applications').send({
      associateEmail: 'pat@example.com',
      associateFirstName: 'Pat',
      associateLastName: 'Hopeful',
      clientId: client.id,
      templateId: template.id,
    });
    const token = (create.body.inviteUrl as string).split('/accept-invite/')[1];

    const res = await request(app())
      .post('/auth/accept-invite')
      .send({ token, password: 'a-strong-password-123' });

    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe('pat@example.com');
    // Phase 32: response carries a nextPath pointing at this associate's
    // newly-created onboarding checklist so the web client can land them
    // there instead of the dashboard.
    expect(res.body.nextPath).toMatch(/^\/onboarding\/me\/[0-9a-f-]{36}$/i);
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie ?? '');
    expect(cookieStr).toMatch(/alto\.session=/);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'pat@example.com' } });
    expect(user.status).toBe('ACTIVE');
    expect(user.passwordHash).not.toBeNull();

    const invite = await prisma.inviteToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(invite.consumedAt).not.toBeNull();

    // The nextPath should reference the very application created above.
    const application = await prisma.application.findFirstOrThrow({
      where: { associateId: user.associateId! },
    });
    expect(res.body.nextPath).toBe(`/onboarding/me/${application.id}`);
  });

  it('rejects a 2nd attempt with the same token (consumed) → 404', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const create = await a.post('/onboarding/applications').send({
      associateEmail: 'pat2@example.com',
      associateFirstName: 'Pat',
      associateLastName: 'Two',
      clientId: client.id,
      templateId: template.id,
    });
    const token = (create.body.inviteUrl as string).split('/accept-invite/')[1];

    const first = await request(app())
      .post('/auth/accept-invite')
      .send({ token, password: 'first-password-1234' });
    expect(first.status).toBe(200);

    const second = await request(app())
      .post('/auth/accept-invite')
      .send({ token, password: 'second-password-1234' });
    expect(second.status).toBe(404);
  });

  it('rejects passwords < 12 chars → 400', async () => {
    const fake = generateInviteToken().raw;
    const res = await request(app())
      .post('/auth/accept-invite')
      .send({ token: fake, password: 'short' });
    expect(res.status).toBe(400);
  });

  it('issued cookie immediately authenticates the new associate', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const create = await a.post('/onboarding/applications').send({
      associateEmail: 'pat3@example.com',
      associateFirstName: 'Pat',
      associateLastName: 'Three',
      clientId: client.id,
      templateId: template.id,
    });
    const token = (create.body.inviteUrl as string).split('/accept-invite/')[1];

    const agent = request.agent(app());
    const accept = await agent
      .post('/auth/accept-invite')
      .send({ token, password: 'fresh-password-12345' });
    expect(accept.status).toBe(200);

    const me = await agent.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user?.email).toBe('pat3@example.com');
    expect(me.body.user?.role).toBe('ASSOCIATE');
  });

  it('refuses to consume invite for an already-ACTIVE user → 409', async () => {
    // Edge case: existing ACTIVE user somehow has a valid invite token (e.g.
    // HR re-invited then admin manually flipped status). Don't let a stale
    // link overwrite their password.
    const { user } = await createUser({ role: 'ASSOCIATE', email: 'active@example.com' });
    const t = generateInviteToken();
    await prisma.inviteToken.create({
      data: {
        tokenHash: t.hash,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const res = await request(app())
      .post('/auth/accept-invite')
      .send({ token: t.raw, password: 'attempted-overwrite-12345' });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('already_active');
  });
});
