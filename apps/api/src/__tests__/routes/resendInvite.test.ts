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

async function inviteAssociate(email: string) {
  const client = await createClient();
  const template = await createStandardTemplate();
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(hr.email);
  const create = await a.post('/onboarding/applications').send({
    associateEmail: email,
    associateFirstName: 'Pat',
    associateLastName: 'Hopeful',
    clientId: client.id,
    templateId: template.id,
  });
  if (create.status !== 201) {
    throw new Error(`invite failed ${create.status} ${JSON.stringify(create.body)}`);
  }
  return { hrAgent: a, applicationId: create.body.id as string, originalUrl: create.body.inviteUrl as string };
}

describe('POST /onboarding/applications/:id/resend-invite', () => {
  it('rotates the token, returns a new link, kills the old one', async () => {
    const { hrAgent, applicationId, originalUrl } = await inviteAssociate('rotate@example.com');
    const originalToken = originalUrl.split('/accept-invite/')[1];

    const res = await hrAgent.post(`/onboarding/applications/${applicationId}/resend-invite`);
    expect(res.status).toBe(200);
    expect(res.body.invitedUserId).toBeTruthy();
    expect(res.body.inviteUrl).toMatch(/\/accept-invite\/[A-Za-z0-9_-]+/);
    const newToken = (res.body.inviteUrl as string).split('/accept-invite/')[1];
    expect(newToken).not.toBe(originalToken);

    // Old token's GET endpoint must now 404 (it was superseded → consumedAt set).
    const lookupOld = await request(app()).get(`/auth/invite/${originalToken}`);
    expect(lookupOld.status).toBe(404);

    // New token's GET endpoint resolves to the same user.
    const lookupNew = await request(app()).get(`/auth/invite/${newToken}`);
    expect(lookupNew.status).toBe(200);
    expect(lookupNew.body.email).toBe('rotate@example.com');

    // Reminder notification persisted.
    const notif = await prisma.notification.findFirstOrThrow({
      where: { recipientEmail: 'rotate@example.com', category: 'onboarding.invite_reminder' },
    });
    expect(notif.status).toBe('SENT');
  });

  it('refuses when the user is already ACTIVE → 409', async () => {
    const { hrAgent, applicationId, originalUrl } = await inviteAssociate('active@example.com');
    const token = originalUrl.split('/accept-invite/')[1];
    // Accept the invite to make the user ACTIVE.
    const accept = await request(app())
      .post('/auth/accept-invite')
      .send({ token, password: 'super-strong-password-123' });
    expect(accept.status).toBe(200);

    const res = await hrAgent.post(`/onboarding/applications/${applicationId}/resend-invite`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('user_already_active');
  });

  it('requires manage:onboarding capability (associates get 403)', async () => {
    const { applicationId } = await inviteAssociate('associate-cant-resend@example.com');
    const { user: assoc } = await createUser({
      role: 'ASSOCIATE',
      email: 'random-assoc@example.com',
    });
    const a = await loginAs(assoc.email);
    const res = await a.post(`/onboarding/applications/${applicationId}/resend-invite`);
    // 403 if scope check passes role but capability fails; 404 if scope hides
    // it. Either is acceptable — what matters is that the rotation didn't run.
    expect([403, 404]).toContain(res.status);
  });
});
