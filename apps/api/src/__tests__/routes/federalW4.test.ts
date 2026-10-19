import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The federal W-4 facts payroll records beside the worker's own W-4: an
 * Exempt claim and its year, nonresident-alien status, a 2019-or-earlier
 * W-4, and an IRS lock-in letter — and how withholding reads them today.
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

describe('federal W-4 facts', () => {
  it('payroll records a lock-in letter and nonresident status; withholding reads the letter from its date', async () => {
    const associate = await createAssociate({ firstName: 'Ana', lastName: 'Silva' });
    await prisma.w4Submission.create({ data: { associateId: associate.id, filingStatus: 'MARRIED_FILING_JOINTLY', dependentsAmount: 4000, deductions: 2000 } });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);

    const put = await a.put(`/payroll/federal-w4/${associate.id}`).send({ nonresidentAlien: true, lockIn: { filingStatus: 'SINGLE', multipleJobs: false, effectiveDate: '2026-01-01' } });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ nonresidentAlien: true, lockIn: { filingStatus: 'SINGLE', effectiveDate: '2026-01-01' } });
    expect(put.body.effective).toMatchObject({ filingStatus: 'SINGLE', dependentsAmount: 0, deductions: 0, nonresidentAlien: true });
    expect(put.body.effective.flags).toContain('LOCK_IN_LETTER');

    const cleared = await a.put(`/payroll/federal-w4/${associate.id}`).send({ lockIn: null });
    expect(cleared.body.lockIn).toBeNull();
    expect(cleared.body.effective.filingStatus).toBe('MARRIED_FILING_JOINTLY');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'payroll.federal_w4_updated' } });
    expect(audit).not.toBeNull();
  });

  it('an Exempt claim records its year; someone without payroll access can’t set any of it', async () => {
    const associate = await createAssociate();
    await prisma.w4Submission.create({ data: { associateId: associate.id, filingStatus: 'SINGLE' } });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const r = await a.put(`/payroll/federal-w4/${associate.id}`).send({ exempt: true, exemptTaxYear: 2026 });
    expect(r.body).toMatchObject({ exempt: true, exemptTaxYear: 2026 });

    const { user: worker } = await createUser({ role: 'ASSOCIATE' });
    const w = await loginAs(worker.email);
    expect((await w.put(`/payroll/federal-w4/${associate.id}`).send({ exempt: false })).status).toBe(403);
    expect((await a.get(`/payroll/federal-w4/00000000-0000-4000-8000-00000000abcd`)).status).toBe(404);
  });
});
