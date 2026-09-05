import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Associate-app polish batch (server side):
 *   - /self/me/profile exposes manager CONTACT (phone/email), not just a name
 *   - /learning/me: auth-only my-training view, hard-scoped to the caller
 *   - reimbursement lines accept in-app document-vault receipt paths
 */

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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

describe('manager contact on the self profile', () => {
  it('returns the manager phone and email alongside the name', async () => {
    const manager = await createAssociate({ firstName: 'Morgan', lastName: 'Boss' });
    await prisma.associate.update({
      where: { id: manager.id },
      data: { phone: '+1 555 010 0100' },
    });
    const associate = await createAssociate();
    await prisma.associate.update({
      where: { id: associate.id },
      data: { managerId: manager.id },
    });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });

    const res = await (await loginAs(user.email)).get('/self/me/profile');
    expect(res.status).toBe(200);
    expect(res.body.managerName).toBe('Morgan Boss');
    expect(res.body.managerPhone).toBe('+1 555 010 0100');
    expect(res.body.managerEmail).toBe(manager.email);
  });
});

describe('GET /learning/me', () => {
  it('returns only MY enrollments, without any compliance capability', async () => {
    const me = await createAssociate();
    const other = await createAssociate();
    const course = await prisma.course.create({
      data: { title: 'Safety basics', status: 'PUBLISHED', isRequired: true },
    });
    await prisma.courseEnrollment.create({
      data: { courseId: course.id, associateId: me.id },
    });
    await prisma.courseEnrollment.create({
      data: { courseId: course.id, associateId: other.id },
    });
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });

    const res = await (await loginAs(user.email)).get('/learning/me');
    expect(res.status).toBe(200);
    expect(res.body.enrollments).toHaveLength(1);
    expect(res.body.enrollments[0].courseTitle).toBe('Safety basics');
    expect(res.body.enrollments[0].isRequired).toBe(true);
    expect(res.body.enrollments[0].status).toBe('ASSIGNED');
  });

  it('403s for accounts with no associate record', async () => {
    const { user: hrLike } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const res = await (await loginAs(hrLike.email)).get('/learning/me');
    expect(res.status).toBe(403);
  });
});

describe('reimbursement receipt paths', () => {
  it('accepts an in-app document download path as receiptUrl', async () => {
    const client = await createClient();
    void client;
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);

    const draft = await a
      .post('/reimbursements')
      .send({ title: 'Work boots', description: null });
    expect(draft.status).toBe(201);

    const goodPath = await a
      .post(`/reimbursements/${draft.body.id}/lines`)
      .send({
        kind: 'RECEIPT',
        description: 'Steel-toe boots',
        incurredOn: '2026-09-01',
        amount: 45.5,
        receiptUrl: '/api/documents/123e4567-e89b-12d3-a456-426614174000/download',
      });
    expect(goodPath.status).toBe(201);

    const badPath = await a
      .post(`/reimbursements/${draft.body.id}/lines`)
      .send({
        kind: 'RECEIPT',
        description: 'Gloves',
        incurredOn: '2026-09-01',
        amount: 12,
        receiptUrl: '/etc/passwd',
      });
    expect(badPath.status).toBe(400);
  });
});
