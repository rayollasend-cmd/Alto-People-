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

describe('POST /performance/reviews', () => {
  it('HR creates a DRAFT review with reviewer recorded', async () => {
    const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/performance/reviews').send({
      associateId: associate.id,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      overallRating: 4,
      summary: 'Strong Q1.',
      strengths: 'Reliability.',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.overallRating).toBe(4);
    expect(res.body.reviewerUserId).toBe(hr.id);
    expect(res.body.reviewerEmail).toBe(hr.email);
    expect(res.body.associateName).toBe('Maria Lopez');
  });

  it('rejects ratings outside 1..5 → 400', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const r = await a.post('/performance/reviews').send({
      associateId: associate.id,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      overallRating: 6,
      summary: 'x',
    });
    expect(r.status).toBe(400);
  });

  it('ASSOCIATE cannot create reviews', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);
    const r = await a.post('/performance/reviews').send({
      associateId: associate.id,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      overallRating: 3,
      summary: 'x',
    });
    expect(r.status).toBe(403);
  });
});

describe('Submit + acknowledge lifecycle', () => {
  it('DRAFT → SUBMITTED hides nothing from HR; associate sees it; acknowledge marks ACKNOWLEDGED', async () => {
    const associate = await createAssociate();
    const { user: assoc } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const create = await hrAgent.post('/performance/reviews').send({
      associateId: associate.id,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      overallRating: 5,
      summary: 'Outstanding.',
    });

    // While DRAFT, associate must NOT see it
    const assocAgent = await loginAs(assoc.email);
    const before = await assocAgent.get('/performance/me/reviews');
    expect(before.body.reviews).toHaveLength(0);

    // HR submits
    const sub = await hrAgent.post(`/performance/reviews/${create.body.id}/submit`).send({});
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('SUBMITTED');
    expect(sub.body.submittedAt).not.toBeNull();

    // Associate now sees it
    const after = await assocAgent.get('/performance/me/reviews');
    expect(after.body.reviews).toHaveLength(1);

    // Acknowledge
    const ack = await assocAgent
      .post(`/performance/me/reviews/${create.body.id}/acknowledge`)
      .send({});
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe('ACKNOWLEDGED');
    expect(ack.body.acknowledgedAt).not.toBeNull();
  });

  it('cannot edit a non-DRAFT review → 409', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const create = await a.post('/performance/reviews').send({
      associateId: associate.id,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      overallRating: 4,
      summary: 'x',
    });
    await a.post(`/performance/reviews/${create.body.id}/submit`).send({});
    const r = await a
      .patch(`/performance/reviews/${create.body.id}`)
      .send({ summary: 'edited' });
    expect(r.status).toBe(409);
  });

  it('associate cannot acknowledge another associate\'s review → 404', async () => {
    const a1 = await createAssociate();
    const a2 = await createAssociate();
    await createUser({ role: 'ASSOCIATE', email: a1.email, associateId: a1.id });
    const { user: u2 } = await createUser({
      role: 'ASSOCIATE',
      email: a2.email,
      associateId: a2.id,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const create = await hrAgent.post('/performance/reviews').send({
      associateId: a1.id,
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      overallRating: 4,
      summary: 'x',
    });
    await hrAgent.post(`/performance/reviews/${create.body.id}/submit`).send({});

    const a2Agent = await loginAs(u2.email);
    const r = await a2Agent
      .post(`/performance/me/reviews/${create.body.id}/acknowledge`)
      .send({});
    expect(r.status).toBe(404);
  });
});
