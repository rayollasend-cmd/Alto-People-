import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { buildPaystubDataById } from '../../lib/paystubData.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Itemized deductions end to end: a payroll run writes one line per plan,
 * order and employer contribution, the lump columns stay their sums, each
 * tax is figured on its own base (FICA keeps the 401(k); Pennsylvania taxes
 * it), employer money never touches net, and the paystub lists every line.
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

async function seed(state: string) {
  const client = await createClient();
  const p = await createAssociate({ firstName: 'Pat', lastName: 'Kowalski' });
  await prisma.associate.update({ where: { id: p.id }, data: { state, employmentType: 'W2_EMPLOYEE', dob: new Date('1988-05-05') } });
  await prisma.w4Submission.create({ data: { associateId: p.id, filingStatus: 'SINGLE' } });
  await prisma.compensationRecord.create({ data: { associateId: p.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
  for (const day of [13, 14, 15, 16, 17]) {
    await prisma.timeEntry.create({
      data: { associateId: p.id, clientId: client.id, clockInAt: new Date(`2026-04-${day}T13:00:00Z`), clockOutAt: new Date(`2026-04-${day}T21:00:00Z`), status: 'APPROVED' },
    });
  }
  const plan = (kind: 'HEALTH_MEDICAL' | 'RETIREMENT_401K' | 'HSA', name: string, employer = 0) =>
    prisma.benefitsPlan.create({ data: { clientId: client.id, kind, name, employerContributionCentsPerPeriod: employer } });
  const medical = await plan('HEALTH_MEDICAL', 'Blue PPO', 20_000);
  const k401 = await plan('RETIREMENT_401K', 'Fidelity 401(k)');
  const hsa = await plan('HSA', 'HSA Bank', 1_000);
  const since = new Date('2026-01-01');
  await prisma.benefitsEnrollment.createMany({
    data: [
      { associateId: p.id, planId: medical.id, electedAmountCentsPerPeriod: 5_000, effectiveDate: since },
      { associateId: p.id, planId: k401.id, electedAmountCentsPerPeriod: 10_000, effectiveDate: since },
      { associateId: p.id, planId: hsa.id, electedAmountCentsPerPeriod: 2_500, effectiveDate: since },
    ],
  });
  const garn = await prisma.garnishment.create({
    data: { associateId: p.id, kind: 'CHILD_SUPPORT', caseNumber: 'CS9', state, amountPerRun: 30, startDate: since, remitTo: `${state} SDU` },
  });
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const a = await loginAs(user.email);
  const created = await a.post('/payroll/runs').send({ periodStart: '2026-04-13', periodEnd: '2026-04-19' });
  expect(created.status).toBe(201);
  return { a, runId: created.body.id as string, associateId: p.id, garnId: garn.id };
}

describe('itemized deductions on a payroll run', () => {
  it('writes one line per plan, order and employer contribution; the lumps are their sums', async () => {
    const { runId, garnId } = await seed('PA');
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: runId }, include: { deductions: true } });
    const by = (code: string) => item.deductions.filter((d) => d.code === code);
    expect(Number(item.grossPay)).toBe(800);

    expect(by('MEDICAL').map((d) => Number(d.employeeAmount))).toEqual([50]);
    expect(by('RET_401K').map((d) => Number(d.employeeAmount))).toEqual([100]);
    expect(by('HSA').map((d) => Number(d.employeeAmount))).toEqual([25]);
    expect(by('ER_HEALTH')[0]).toMatchObject({ category: 'EMPLOYER', w2Box12Code: 'DD' });
    expect(Number(by('ER_HEALTH')[0].employerAmount)).toBe(200);
    expect(Number(by('ER_HSA')[0].employerAmount)).toBe(10);
    const garn = by('GARNISHMENT')[0];
    expect(garn).toMatchObject({ category: 'POST_TAX', sourceType: 'Garnishment', sourceId: garnId, label: 'Child support — case CS9 (PA SDU)' });
    expect(Number(garn.employeeAmount)).toBe(30);

    const sum = (cat: string) => Math.round(item.deductions.filter((d) => d.category === cat).reduce((s, d) => s + Number(d.employeeAmount), 0) * 100) / 100;
    expect(sum('PRE_TAX')).toBe(Number(item.preTaxDeductions));
    expect(sum('POST_TAX')).toBe(Number(item.postTaxDeductions));
    expect(Number(item.preTaxRetirement)).toBe(100);

    // The snapshot of what each line lowered, in Pennsylvania.
    expect(by('RET_401K')[0].exemptFrom).toEqual(['FIT']);
    expect(by('MEDICAL')[0].exemptFrom).toEqual(expect.arrayContaining(['FIT', 'SS', 'MEDICARE', 'FUTA', 'SIT:PA', 'SUI:PA', 'LOCAL']));
  });

  it('each tax on its own base: FICA keeps the 401(k), Pennsylvania taxes it, employer money never touches net', async () => {
    const { runId } = await seed('PA');
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: runId }, include: { taxLines: true } });
    // PA's employee unemployment share is withheld too, on PA UI wages (a state program line).
    const programs = item.taxLines.filter((l) => l.kind === 'STATE_PROGRAM' && !l.employer).reduce((sum, l) => sum + Number(l.amount), 0);
    // FICA base: 800 − medical 50 − HSA 25 = 725 (the 401(k) stays in).
    expect(Number(item.fica)).toBeCloseTo(725 * 0.062, 2);
    expect(Number(item.medicare)).toBeCloseTo(725 * 0.0145, 2);
    // PA income tax base: the same 725 (401(k) deferrals are PA compensation), at 3.07%.
    expect(Number(item.stateWithholding)).toBeCloseTo(725 * 0.0307, 2);
    const taxes = Number(item.federalWithholding) + Number(item.fica) + Number(item.medicare) + Number(item.stateWithholding) + Number(item.localWithholding);
    expect(Number(item.netPay)).toBeCloseTo(800 - taxes - programs - 175 - 30, 2);
  });

  it('a state that follows the federal treatment taxes the federal base', async () => {
    const { runId } = await seed('KY');
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: runId }, include: { deductions: true } });
    expect(item.deductions.find((d) => d.code === 'RET_401K')!.exemptFrom).toEqual(expect.arrayContaining(['FIT', 'SIT:KY']));
  });

  it('the paystub lists every line with its YTD, and what the employer paid on top', async () => {
    const { runId, a } = await seed('PA');
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: runId } });
    const built = await buildPaystubDataById(prisma, item.id);
    const d = built!.data;
    expect(d.preTaxDeductions.map((l) => l.label)).toEqual(['401(k)', 'Medical', 'HSA']);
    expect(d.preTaxDeductions.map((l) => l.current)).toEqual([100, 50, 25]);
    expect(d.postTaxDeductions.map((l) => l.label)).toEqual(['Child support — case CS9 (PA SDU)']);
    expect(d.employerContributions?.map((l) => [l.label, l.current])).toEqual([
      ['Employer health coverage', 200],
      ['Employer HSA contribution', 10],
    ]);

    // The run detail carries the lines for the payroll screen.
    const run = await a.get(`/payroll/runs/${runId}`);
    const ded = run.body.items[0].deductions as Array<{ code: string; category: string; employeeAmount: number }>;
    expect(ded.filter((x) => x.category === 'PRE_TAX').reduce((s, x) => s + x.employeeAmount, 0)).toBe(175);
  });

  it('re-aggregating replaces the lines instead of piling them up', async () => {
    const { a, runId, associateId } = await seed('PA');
    const added = await a.post(`/payroll/runs/${runId}/add-ons`).send({ associateId, kind: 'BONUS', amount: 100 });
    expect(added.status).toBeLessThan(300);
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: runId }, include: { deductions: true } });
    expect(item.deductions.filter((d) => d.code === 'MEDICAL')).toHaveLength(1);
    expect(item.deductions.filter((d) => d.code === 'GARNISHMENT')).toHaveLength(1);
  });
});
