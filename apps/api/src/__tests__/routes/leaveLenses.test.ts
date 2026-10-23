import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * F500 G2 — the leave desk's tiles are its filter: each tile's count in
 * /leave/summary and the rows /leave/cases?status=<lens> returns come from
 * one definition, so the number and the list always agree.
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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const DAY = 86_400_000;
const todayUtc = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const d = (days: number) => new Date(todayUtc().getTime() + days * DAY);

describe('leave desk lenses', () => {
  it('on leave today, notices to send, certifications due and returning: counts match the filtered rows', async () => {
    const mk = async (first: string, data: Record<string, unknown>) => {
      const a = await createAssociate({ firstName: first, lastName: 'Case' });
      return prisma.leaveCase.create({ data: { associateId: a.id, type: 'FMLA', reason: 'OWN_HEALTH', startDate: d(-3), ...data } });
    };
    await mk('OnLeave', { status: 'APPROVED', startDate: d(-3), endDate: d(20), expectedReturnDate: d(21) });
    await mk('Returning', { status: 'APPROVED', startDate: d(-10), endDate: d(3), expectedReturnDate: d(4) }); // on leave AND returning
    await mk('Requested1', { status: 'REQUESTED', startDate: d(5) });
    await mk('Requested2', { status: 'REQUESTED', startDate: d(8) });
    await mk('CertDue', { status: 'PENDING_CERTIFICATION', certificationDueAt: d(2) });
    await mk('CertLater', { status: 'PENDING_CERTIFICATION', certificationDueAt: d(30) }); // not due this week
    await mk('Closed', { status: 'CLOSED', startDate: d(-60), endDate: d(-40) });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const summary = (await agent.get('/leave/summary')).body;
    expect(summary).toMatchObject({ onLeave: 2, noticesOwed: 2, certificationsDueThisWeek: 1, returningThisWeek: 1 });

    const names = async (status: string) =>
      ((await agent.get(`/leave/cases?status=${status}`)).body.cases as Array<{ associateName: string }>).map((c) => c.associateName).sort();
    expect(await names('on-leave')).toEqual(['OnLeave Case', 'Returning Case']);
    expect(await names('notices')).toEqual(['Requested1 Case', 'Requested2 Case']);
    expect(await names('certs-due')).toEqual(['CertDue Case']);
    expect(await names('returning')).toEqual(['Returning Case']);
    expect((await names('open')).length).toBe(6);
    expect((await names('all')).length).toBe(7);
    expect((await agent.get('/leave/cases?status=nonsense')).status).toBe(400);
  });
});
