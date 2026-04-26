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

describe('POST /recruiting/candidates', () => {
  it('creates an APPLIED candidate', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/recruiting/candidates').send({
      firstName: 'Pat',
      lastName: 'Hopeful',
      email: 'pat@example.com',
      position: 'Server',
      source: 'careers-page',
    });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe('APPLIED');
    expect(res.body.email).toBe('pat@example.com');
  });

  it('lower-cases email + rejects duplicates → 409', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    await a.post('/recruiting/candidates').send({
      firstName: 'Pat', lastName: 'X', email: 'PAT@example.com',
    });
    const dup = await a.post('/recruiting/candidates').send({
      firstName: 'Pat', lastName: 'Y', email: 'pat@example.com',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe('candidate_email_exists');
  });

  it('ASSOCIATE cannot create', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(user.email);
    const res = await a.post('/recruiting/candidates').send({
      firstName: 'X', lastName: 'Y', email: 'x@example.com',
    });
    // ASSOCIATE doesn't have view:recruiting either
    expect(res.status).toBe(403);
  });
});

describe('Pipeline transitions', () => {
  it('advances APPLIED → SCREENING → INTERVIEW → OFFER → HIRED via /hire', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const c = await a.post('/recruiting/candidates').send({
      firstName: 'Pat', lastName: 'Hopeful', email: 'pat@example.com',
    });

    let r = await a.post(`/recruiting/candidates/${c.body.id}/advance`).send({ stage: 'SCREENING' });
    expect(r.body.stage).toBe('SCREENING');
    r = await a.post(`/recruiting/candidates/${c.body.id}/advance`).send({ stage: 'INTERVIEW' });
    expect(r.body.stage).toBe('INTERVIEW');
    r = await a.post(`/recruiting/candidates/${c.body.id}/advance`).send({ stage: 'OFFER' });
    expect(r.body.stage).toBe('OFFER');

    // Reject the /advance route's own attempt to set HIRED
    const directHire = await a.post(`/recruiting/candidates/${c.body.id}/advance`).send({ stage: 'HIRED' });
    expect(directHire.status).toBe(400);

    // Use /hire instead
    const hire = await a.post(`/recruiting/candidates/${c.body.id}/hire`).send({});
    expect(hire.status).toBe(200);
    expect(hire.body.stage).toBe('HIRED');
    expect(hire.body.hiredAssociateId).not.toBeNull();
    expect(hire.body.applicationId).toBeNull();

    // The new associate exists
    const associate = await prisma.associate.findUnique({
      where: { id: hire.body.hiredAssociateId },
    });
    expect(associate).not.toBeNull();
    expect(associate!.email).toBe('pat@example.com');
  });

  it('REJECT requires a reason', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const c = await a.post('/recruiting/candidates').send({
      firstName: 'Pat', lastName: 'X', email: 'pat@example.com',
    });
    const r = await a.post(`/recruiting/candidates/${c.body.id}/advance`).send({ stage: 'REJECTED' });
    expect(r.status).toBe(400);

    const ok = await a
      .post(`/recruiting/candidates/${c.body.id}/advance`)
      .send({ stage: 'REJECTED', rejectedReason: 'no relevant experience' });
    expect(ok.status).toBe(200);
    expect(ok.body.stage).toBe('REJECTED');
    expect(ok.body.rejectedReason).toBe('no relevant experience');
  });

  it('cannot advance a HIRED candidate → 409', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const c = await a.post('/recruiting/candidates').send({
      firstName: 'Pat', lastName: 'X', email: 'pat@example.com',
    });
    await a.post(`/recruiting/candidates/${c.body.id}/hire`).send({});
    const r = await a.post(`/recruiting/candidates/${c.body.id}/advance`).send({ stage: 'INTERVIEW' });
    expect(r.status).toBe(409);
  });
});

describe('Hire → Application handoff', () => {
  it('with clientId+templateId, /hire creates an Application + checklist', async () => {
    const client = await createClient();
    const template = await createStandardTemplate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const c = await a.post('/recruiting/candidates').send({
      firstName: 'Pat', lastName: 'X', email: 'pat@example.com',
    });
    const hire = await a.post(`/recruiting/candidates/${c.body.id}/hire`).send({
      clientId: client.id,
      templateId: template.id,
    });
    expect(hire.status).toBe(200);
    expect(hire.body.applicationId).not.toBeNull();

    const app = await prisma.application.findUniqueOrThrow({
      where: { id: hire.body.applicationId },
      include: { checklist: { include: { tasks: true } } },
    });
    expect(app.associateId).toBe(hire.body.hiredAssociateId);
    expect(app.checklist?.tasks.length).toBeGreaterThan(0);
  });

  it('/hire with unknown clientId → 404', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const c = await a.post('/recruiting/candidates').send({
      firstName: 'Pat', lastName: 'X', email: 'pat@example.com',
    });
    const r = await a.post(`/recruiting/candidates/${c.body.id}/hire`).send({
      clientId: '00000000-0000-4000-8000-000000000000',
      templateId: '00000000-0000-4000-8000-000000000001',
    });
    expect(r.status).toBe(404);
  });
});

describe('Soft delete', () => {
  it('DELETE soft-deletes; subsequent GET returns 404', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const c = await a.post('/recruiting/candidates').send({
      firstName: 'Pat', lastName: 'X', email: 'pat@example.com',
    });
    const del = await a.delete(`/recruiting/candidates/${c.body.id}`);
    expect(del.status).toBe(204);
    const get = await a.get(`/recruiting/candidates/${c.body.id}`);
    expect(get.status).toBe(404);
  });

  it('cannot delete a HIRED candidate → 409', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const c = await a.post('/recruiting/candidates').send({
      firstName: 'Pat', lastName: 'X', email: 'pat@example.com',
    });
    await a.post(`/recruiting/candidates/${c.body.id}/hire`).send({});
    const del = await a.delete(`/recruiting/candidates/${c.body.id}`);
    expect(del.status).toBe(409);
  });
});
