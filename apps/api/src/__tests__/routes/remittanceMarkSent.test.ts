import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Deep audit 2026-10-29, CODE-18 (the hand path): "Mark sent" on a
 * garnishment remittance claims it — still open, no electronic send in
 * flight — in one conditional update. Two clicks mark it once; a remittance
 * an ACH send holds is never marked sent by hand beside it.
 */

const app = () => createApp();
async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function remittance(extra: Record<string, unknown> = {}) {
  const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), status: 'DISBURSED', disbursedAt: new Date('2026-10-30T12:00:00Z') } });
  return prisma.garnishmentRemittance.create({ data: { payrollRunId: run.id, payeeName: 'FL State Disbursement Unit', amount: 212.5, ...extra } });
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('mark a garnishment remittance sent — once', () => {
  it('two clicks at once: one marks it, the other is refused', async () => {
    const r = await remittance();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const [x, y] = await Promise.all([
      a.post(`/payroll/garnishment-remittances/${r.id}/mark-sent`).send({ reference: 'CHK 1001' }),
      a.post(`/payroll/garnishment-remittances/${r.id}/mark-sent`).send({ reference: 'CHK 1002' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const after = await prisma.garnishmentRemittance.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.status).toBe('SENT');
    expect(['CHK 1001', 'CHK 1002']).toContain(after.reference);
  });

  it('a remittance an electronic send holds is not marked sent by hand', async () => {
    const r = await remittance({ sendingAt: new Date() });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const res = await a.post(`/payroll/garnishment-remittances/${r.id}/mark-sent`).send({ reference: 'by hand' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('remittance_in_flight');
    expect((await prisma.garnishmentRemittance.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('PENDING');
  });
});
