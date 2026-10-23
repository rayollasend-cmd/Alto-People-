import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { Test } from 'supertest';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Acknowledging a disciplinary notice is not agreeing with it (F500 G5):
 * the employee writes their side under the notice; HR reads it on the
 * action; only the subject may write, and a rescinded notice takes none.
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
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function seed() {
  const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const other = await createAssociate({ firstName: 'Ben', lastName: 'Ortiz' });
  const { user: mariaUser } = await createUser({ role: 'ASSOCIATE', associateId: maria.id });
  const { user: benUser } = await createUser({ role: 'ASSOCIATE', associateId: other.id });
  const action = await prisma.disciplinaryAction.create({
    data: { associateId: maria.id, kind: 'WRITTEN_WARNING', incidentDate: new Date('2026-10-01'), effectiveDate: new Date('2026-10-02'), description: 'Late three times in a week.' },
  });
  return { maria, mariaUser, benUser, action };
}

describe('POST /disciplinary-actions/:id/response', () => {
  it('stores the employee’s side, returns it on their own list and on HR’s', async () => {
    const { maria, mariaUser, action } = await seed();
    const me = await loginAs(mariaUser.email);
    const res = await me.post(`/disciplinary-actions/${action.id}/response`).send({ text: '  The bus schedule changed that week.  ' });
    expect(res.status).toBe(200);
    expect(res.body.employeeRespondedAt).toEqual(expect.any(String));
    const mine = await me.get('/disciplinary-actions/me');
    expect(mine.body.actions[0]).toMatchObject({ employeeResponse: 'The bus schedule changed that week.', employeeRespondedAt: expect.any(String) });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrList = await (await loginAs(hr.email)).get(`/disciplinary-actions?associateId=${maria.id}`);
    expect(hrList.status).toBe(200);
    expect(hrList.body.actions[0]).toMatchObject({ employeeResponse: 'The bus schedule changed that week.' });
  });

  it('only the subject may write (someone else gets a 404), up to 2,000 characters, and not on a rescinded notice', async () => {
    const { mariaUser, benUser, action } = await seed();
    expect((await (await loginAs(benUser.email)).post(`/disciplinary-actions/${action.id}/response`).send({ text: 'Not mine' })).status).toBe(404);
    const me = await loginAs(mariaUser.email);
    expect((await me.post(`/disciplinary-actions/${action.id}/response`).send({ text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await me.post(`/disciplinary-actions/${action.id}/response`).send({ text: '   ' })).status).toBe(400);
    await prisma.disciplinaryAction.update({ where: { id: action.id }, data: { status: 'RESCINDED', rescindedAt: new Date(), rescindedReason: 'Error' } });
    expect((await me.post(`/disciplinary-actions/${action.id}/response`).send({ text: 'Too late' })).status).toBe(409);
  });
});
