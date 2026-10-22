import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { buildPaystubDataById } from '../../lib/paystubData.js';
import { deriveLegacyDeductionLines } from '../../lib/deductionBackfill.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * A paystub itemizes whether or not scripts/backfill-deduction-lines.ts has
 * run: a check with no PayrollItemDeduction rows gets the same lines the
 * backfill would write, derived in memory from what the check recorded.
 */

const app = () => createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedRun() {
  const client = await createClient();
  const p = await createAssociate({ firstName: 'Pat', lastName: 'Kowalski' });
  await prisma.associate.update({ where: { id: p.id }, data: { state: 'FL', employmentType: 'W2_EMPLOYEE', dob: new Date('1988-05-05') } });
  await prisma.w4Submission.create({ data: { associateId: p.id, filingStatus: 'SINGLE' } });
  await prisma.compensationRecord.create({ data: { associateId: p.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
  for (const day of [13, 14, 15, 16, 17]) {
    await prisma.timeEntry.create({
      data: { associateId: p.id, clientId: client.id, clockInAt: new Date(`2026-04-${day}T13:00:00Z`), clockOutAt: new Date(`2026-04-${day}T21:00:00Z`), status: 'APPROVED' },
    });
  }
  const medical = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'HEALTH_MEDICAL', name: 'Blue PPO' } });
  const k401 = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'RETIREMENT_401K', name: 'Fidelity 401(k)' } });
  const since = new Date('2026-01-01');
  await prisma.benefitsEnrollment.createMany({
    data: [
      { associateId: p.id, planId: medical.id, electedAmountCentsPerPeriod: 5_000, effectiveDate: since },
      { associateId: p.id, planId: k401.id, electedAmountCentsPerPeriod: 10_000, effectiveDate: since },
    ],
  });
  const garn = await prisma.garnishment.create({
    data: { associateId: p.id, kind: 'CHILD_SUPPORT', caseNumber: 'CS9', state: 'FL', amountPerRun: 30, startDate: since, remitTo: 'FL SDU' },
  });
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const a = await loginAs(user.email);
  const created = await a.post('/payroll/runs').send({ periodStart: '2026-04-13', periodEnd: '2026-04-19' });
  expect(created.status).toBe(201);
  const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: created.body.id as string }, include: { deductions: true } });
  return { item, garnId: garn.id };
}

describe('paystub for a check with no itemized lines on file', () => {
  it('itemizes from the recorded deductions, the same lines the backfill would write', async () => {
    const { item, garnId } = await seedRun();
    expect(item.deductions.length).toBeGreaterThan(0);
    // With the lines on file: the itemized stub.
    const withLines = await buildPaystubDataById(prisma, item.id);
    expect(withLines).not.toBeNull();

    // A check from before itemizing: no lines, only the lump columns.
    await prisma.payrollItemDeduction.deleteMany({ where: { payrollItemId: item.id } });
    const bare = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id }, include: { deductions: true } });
    expect(bare.deductions).toHaveLength(0);

    const derived = await deriveLegacyDeductionLines(prisma, { ...bare, associate: { state: 'FL' } });
    expect(derived.find((l) => l.code === 'RET_401K')?.employeeAmount).toBe(100);
    expect(derived.find((l) => l.code === 'GARNISHMENT')).toMatchObject({ sourceType: 'Garnishment', sourceId: garnId, employeeAmount: 30 });
    // The pre-tax lump is the sum of its lines, with the unnamed rest labeled as such.
    const preTax = derived.filter((l) => l.category === 'PRE_TAX').reduce((s, l) => s + l.employeeAmount, 0);
    expect(preTax).toBe(Number(bare.preTaxDeductions));
    expect(derived.some((l) => l.label === 'Health & benefits (before itemizing)')).toBe(true);

    const stub = await buildPaystubDataById(prisma, item.id);
    expect(stub).not.toBeNull();
    const pre = stub!.data.preTaxDeductions;
    const post = stub!.data.postTaxDeductions;
    expect(pre.find((l) => l.label === '401(k)')).toMatchObject({ current: 100, ytd: 100 });
    expect(pre.find((l) => l.label === 'Health & benefits (before itemizing)')).toMatchObject({ current: 50, ytd: 50 });
    expect(post.find((l) => /Child support/.test(l.label))).toMatchObject({ current: 30, ytd: 30 });
    // The same amounts the itemized stub showed, line for line (the plan's
    // own name is the one thing an old check did not record).
    expect(pre.map((l) => l.current)).toEqual(withLines!.data.preTaxDeductions.map((l) => l.current));
    expect(post.map((l) => l.current)).toEqual(withLines!.data.postTaxDeductions.map((l) => l.current));
  });
});
