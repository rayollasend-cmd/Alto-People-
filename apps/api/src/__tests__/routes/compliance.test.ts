import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
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

describe('I-9 endpoints', () => {
  it('upserts a section 1 record', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a
      .post(`/compliance/i9/${associate.id}`)
      .send({ section1CompletedAt: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.section1CompletedAt).not.toBeNull();
    expect(res.body.section2CompletedAt).toBeNull();
  });

  it('records section 2 with verifier and document list', async () => {
    const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post(`/compliance/i9/${associate.id}`).send({
      section1CompletedAt: new Date().toISOString(),
      section2CompletedAt: new Date().toISOString(),
      documentList: 'LIST_A',
    });
    expect(res.status).toBe(200);
    expect(res.body.section2CompletedAt).not.toBeNull();
    expect(res.body.documentList).toBe('LIST_A');
    expect(res.body.section2VerifierUserId).toBe(hr.id);
    expect(res.body.section2VerifierEmail).toBe(hr.email);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'compliance.i9_updated', entityId: res.body.id },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects section 2 record without documentList → 400', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a
      .post(`/compliance/i9/${associate.id}`)
      .send({ section2CompletedAt: new Date().toISOString() });
    expect(res.status).toBe(400);
  });

  it('GET /compliance/i9 supports pending/complete filter', async () => {
    const a1 = await createAssociate();
    const a2 = await createAssociate();
    await prisma.i9Verification.create({
      data: { associateId: a1.id, section1CompletedAt: new Date() },
    });
    await prisma.i9Verification.create({
      data: {
        associateId: a2.id,
        section1CompletedAt: new Date(),
        section2CompletedAt: new Date(),
        documentList: 'LIST_A',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const pending = await agent.get('/compliance/i9?status=pending');
    expect(pending.body.i9s.map((r: { associateId: string }) => r.associateId)).toEqual([a1.id]);

    const complete = await agent.get('/compliance/i9?status=complete');
    expect(complete.body.i9s.map((r: { associateId: string }) => r.associateId)).toEqual([a2.id]);

    const all = await agent.get('/compliance/i9');
    expect(all.body.i9s).toHaveLength(2);
  });

  it('ASSOCIATE cannot upsert (no manage:compliance) but can GET', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);

    const get = await a.get('/compliance/i9');
    // ASSOCIATE doesn't have view:compliance either, so this is 403.
    expect(get.status).toBe(403);

    const post = await a
      .post(`/compliance/i9/${associate.id}`)
      .send({ section1CompletedAt: new Date().toISOString() });
    expect(post.status).toBe(403);
  });
});

describe('Background check endpoints', () => {
  it('HR initiates a check (stubbed) and updates status to PASSED', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    // Need an Application so the route can derive clientId.
    await prisma.application.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'DRAFT',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const initiate = await a.post('/compliance/background').send({
      associateId: associate.id,
      provider: 'alto-stub',
    });
    expect(initiate.status).toBe(201);
    expect(initiate.body.status).toBe('INITIATED');
    expect(initiate.body.clientId).toBe(client.id);

    const update = await a
      .post(`/compliance/background/${initiate.body.id}/update`)
      .send({ status: 'PASSED', externalId: 'ext-12345' });
    expect(update.status).toBe(200);
    expect(update.body.status).toBe('PASSED');
    expect(update.body.completedAt).not.toBeNull();
    expect(update.body.externalId).toBe('ext-12345');
  });

  it('initiate with unknown associateId → 404', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/compliance/background').send({
      associateId: '00000000-0000-4000-8000-000000000000',
      provider: 'alto-stub',
    });
    expect(res.status).toBe(404);
  });

  it('non-terminal status updates do not set completedAt', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const initiate = await a.post('/compliance/background').send({
      associateId: associate.id,
      provider: 'alto-stub',
    });
    const update = await a
      .post(`/compliance/background/${initiate.body.id}/update`)
      .send({ status: 'IN_PROGRESS' });
    expect(update.body.status).toBe('IN_PROGRESS');
    expect(update.body.completedAt).toBeNull();
  });
});

describe('J-1 endpoints', () => {
  it('upserts a J-1 profile and flips Associate.j1Status to true', async () => {
    const associate = await createAssociate();
    expect(associate.j1Status).toBe(false);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post(`/compliance/j1/${associate.id}`).send({
      programStartDate: '2026-05-01',
      programEndDate: '2026-09-30',
      ds2019Number: 'N1234567890',
      sponsorAgency: 'Council on International Educational Exchange',
      country: 'Spain',
    });
    expect(res.status).toBe(200);
    expect(res.body.programStartDate).toBe('2026-05-01');
    expect(res.body.programEndDate).toBe('2026-09-30');
    expect(typeof res.body.daysUntilEnd).toBe('number');

    const refreshed = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(refreshed.j1Status).toBe(true);
  });

  it('upsert is idempotent — second call updates in place', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const first = await a.post(`/compliance/j1/${associate.id}`).send({
      programStartDate: '2026-05-01',
      programEndDate: '2026-09-30',
      ds2019Number: 'N1234567890',
      sponsorAgency: 'CIEE',
      country: 'Spain',
    });
    const second = await a.post(`/compliance/j1/${associate.id}`).send({
      programStartDate: '2026-05-01',
      programEndDate: '2026-10-31',
      ds2019Number: 'N1234567890',
      sponsorAgency: 'CIEE',
      country: 'Spain',
    });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.programEndDate).toBe('2026-10-31');
  });

  it('rejects programEndDate before programStartDate → 400', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post(`/compliance/j1/${associate.id}`).send({
      programStartDate: '2026-09-30',
      programEndDate: '2026-05-01',
      ds2019Number: 'X',
      sponsorAgency: 'X',
      country: 'X',
    });
    expect(res.status).toBe(400);
  });

  it('GET /compliance/j1 supports expiringWithin filter', async () => {
    const a1 = await createAssociate();
    const a2 = await createAssociate();
    const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const farLater = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await prisma.j1Profile.create({
      data: {
        associateId: a1.id,
        programStartDate: new Date('2026-01-01'),
        programEndDate: soon,
        ds2019Number: 'A',
        sponsorAgency: 'X',
        country: 'Spain',
      },
    });
    await prisma.j1Profile.create({
      data: {
        associateId: a2.id,
        programStartDate: new Date('2026-01-01'),
        programEndDate: farLater,
        ds2019Number: 'B',
        sponsorAgency: 'X',
        country: 'Brazil',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get('/compliance/j1?expiringWithin=30');
    expect(res.body.profiles.map((p: { associateId: string }) => p.associateId)).toEqual([a1.id]);
  });
});
