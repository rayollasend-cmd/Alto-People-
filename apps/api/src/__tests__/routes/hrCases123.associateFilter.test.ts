import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Role } from '@prisma/client';
import { createApp } from '../../app.js';
import { signSession } from '../../lib/jwt.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

const app = () => createApp();

function cookieFor(user: { id: string; role: Role; tokenVersion: number }) {
  return `alto.session=${signSession({ sub: user.id, role: user.role, ver: user.tokenVersion })}`;
}

/**
 * The person record's Cases tab reads `GET /hr-cases?associateId=` — one
 * person's cases, under the same desk scope as the whole queue.
 */
describe('GET /hr-cases?associateId=', () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function twoPeopleWithCases() {
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Ortiz' });
    await prisma.hrCase.createMany({
      data: [
        { associateId: ana.id, category: 'PAYROLL', subject: 'Ana — missing hours', description: 'x' },
        { associateId: ana.id, category: 'BENEFITS', subject: 'Ana — dental card', description: 'x' },
        { associateId: ben.id, category: 'PAYROLL', subject: 'Ben — wrong rate', description: 'x' },
      ],
    });
    return { ana, ben };
  }

  it('HR sees only that person’s cases, every category', async () => {
    const { ana } = await twoPeopleWithCases();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await request(app()).get(`/hr-cases?associateId=${ana.id}`).set('Cookie', [cookieFor(admin)]);
    expect(res.status).toBe(200);
    const subjects = (res.body.cases as Array<{ subject: string; associateId: string }>).map((c) => c.subject).sort();
    expect(subjects).toEqual(['Ana — dental card', 'Ana — missing hours']);
    expect(res.body.cases.every((c: { associateId: string }) => c.associateId === ana.id)).toBe(true);
  });

  it('Finance sees only that person’s PAYROLL cases — the desk scope still applies', async () => {
    const { ana } = await twoPeopleWithCases();
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const res = await request(app()).get(`/hr-cases?associateId=${ana.id}`).set('Cookie', [cookieFor(finance)]);
    expect(res.status).toBe(200);
    expect((res.body.cases as Array<{ subject: string }>).map((c) => c.subject)).toEqual(['Ana — missing hours']);
  });

  it('without the filter the whole queue still comes back', async () => {
    await twoPeopleWithCases();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await request(app()).get('/hr-cases').set('Cookie', [cookieFor(admin)]);
    expect(res.status).toBe(200);
    expect(res.body.cases).toHaveLength(3);
  });

  it('rejects an associateId that is not a uuid', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await request(app()).get('/hr-cases?associateId=not-an-id').set('Cookie', [cookieFor(admin)]);
    expect(res.status).toBe(400);
  });
});
