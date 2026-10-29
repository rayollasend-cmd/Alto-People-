import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { buildPaystubDataById } from '../../lib/paystubData.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * State programs and the federal W-4 rules reach the paycheck: CA SDI is
 * withheld and comes out of net, NJ TDI stops at its annual cap, a WA
 * employer of 50+ pays its PFML share, and a two-jobs W-4 withholds more.
 */

const app = () => createApp();
const PERIOD = { periodStart: new Date('2026-04-13T00:00:00Z'), periodEndExclusive: new Date('2026-04-20T00:00:00Z'), clientId: null, defaultRate: 20 };

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

/** A W-2 worker in `state`, $20/h, 40 approved hours in the week of Apr 13, 2026. */
async function worker(state: string, w4: Record<string, unknown> = {}, name = 'Pat') {
  const client = await createClient();
  const p = await createAssociate({ firstName: name, lastName: state });
  await prisma.associate.update({ where: { id: p.id }, data: { state, employmentType: 'W2_EMPLOYEE' } });
  await prisma.w4Submission.create({ data: { associateId: p.id, filingStatus: 'SINGLE', ...w4 } });
  await prisma.compensationRecord.create({ data: { associateId: p.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
  for (const day of [13, 14, 15, 16, 17]) {
    await prisma.timeEntry.create({ data: { associateId: p.id, clientId: client.id, clockInAt: new Date(`2026-04-${day}T13:00:00Z`), clockOutAt: new Date(`2026-04-${day}T21:00:00Z`), status: 'APPROVED' } });
  }
  return p;
}

const project = async (id: string) => (await aggregatePayrollProjection(prisma, PERIOD)).items.find((i) => i.associateId === id)!;

describe('state programs on the paycheck', () => {
  it('a California worker has SDI withheld, net reduced, and the line persisted and on the paystub', async () => {
    const p = await worker('CA');
    const item = await project(p.id);
    expect(item.grossPay).toBe(800);
    expect(item.stateProgramTax).toBeCloseTo(800 * 0.013, 2);
    const sdi = item.taxLines.find((l) => l.code === 'CA_SDI')!;
    expect(sdi).toMatchObject({ kind: 'STATE_PROGRAM', employer: false });
    const taxes = item.federalIncomeTax + item.fica + item.medicare + item.stateIncomeTax + item.localIncomeTax + item.stateProgramTax;
    expect(item.netPay).toBeCloseTo(800 - taxes, 2);

    // Through a real run: the line is saved and the paystub names it as a tax.
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const created = await a.post('/payroll/runs').send({ periodStart: '2026-04-13', periodEnd: '2026-04-19' });
    expect(created.status).toBe(201);
    // "Taxes withheld" on the run and each check's taxes include the state program (deep audit MONEY-12),
    // so every Paychecks row adds up: gross − taxes − deductions + reimbursements = net.
    expect(Number(created.body.totalTax)).toBeCloseTo(taxes, 2);
    const dto = created.body.items.find((i: { associateId: string }) => i.associateId === p.id);
    expect(dto.taxesTotal).toBeCloseTo(taxes, 2);
    expect(dto).toMatchObject({ localWithholding: 0, reimbursementsTotal: 0 });
    expect(dto.grossPay - dto.taxesTotal - (dto.preTaxDeductions ?? 0) - dto.postTaxDeductions + dto.reimbursementsTotal).toBeCloseTo(dto.netPay, 2);
    const saved = await prisma.payrollItem.findFirstOrThrow({ where: { associateId: p.id }, include: { taxLines: true } });
    expect(saved.taxLines.find((l) => l.code === 'CA_SDI')).toMatchObject({ kind: 'STATE_PROGRAM', employer: false });
    expect(Number(saved.netPay)).toBeCloseTo(item.netPay, 2);
    const stub = (await buildPaystubDataById(prisma, saved.id))!.data;
    const row = stub.taxes.find((t) => t.label.startsWith('CA SDI'))!;
    expect(row.current).toBeCloseTo(10.4, 2);
    expect(stub.taxesTotal.current).toBeCloseTo(taxes, 2);
  });

  it('a New Jersey worker stops paying TDI at the annual cap, counting this year’s earlier checks', async () => {
    const p = await worker('NJ');
    // Earlier this year: $171,000 of TDI wages already contributed on (cap $171,100).
    const prior = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-03-02'), periodEnd: new Date('2026-03-08'), status: 'DISBURSED', kind: 'REGULAR' } });
    const priorItem = await prisma.payrollItem.create({ data: { payrollRunId: prior.id, associateId: p.id, hoursWorked: 0, hourlyRate: 0, grossPay: 171_000, federalWithholding: 0, netPay: 171_000, status: 'DISBURSED' } });
    await prisma.payrollItemTaxLine.create({ data: { payrollItemId: priorItem.id, code: 'NJ_TDI', kind: 'STATE_PROGRAM', label: 'NJ disability insurance (TDI)', wages: 171_000, amount: 324.9 } });
    const item = await project(p.id);
    const tdi = item.taxLines.find((l) => l.code === 'NJ_TDI')!;
    expect(tdi.wages).toBe(100);
    expect(tdi.amount).toBeCloseTo(0.19, 2);
    // FLI has no prior wages here: the whole check.
    expect(item.taxLines.find((l) => l.code === 'NJ_FLI')!.wages).toBe(800);
  });

  it('a Washington employer of 50 or more pays the PFML employer share; a smaller one does not', async () => {
    const p = await worker('WA');
    const small = await project(p.id);
    expect(small.taxLines.find((l) => l.code === 'WA_PFML_ER')).toBeUndefined();
    expect(small.employerProgramTax).toBe(0);

    await prisma.associate.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ firstName: 'Crew', lastName: `${i}`, email: `crew${i}@example.com`, employmentType: 'W2_EMPLOYEE' as const })) });
    const large = await project(p.id);
    const er = large.taxLines.find((l) => l.code === 'WA_PFML_ER')!;
    expect(er).toMatchObject({ employer: true, kind: 'STATE_PROGRAM' });
    expect(er.amount).toBeCloseTo(800 * 0.0113 * 0.2857, 2);
    expect(large.employerProgramTax).toBeCloseTo(er.amount, 2);
    // The employer's share never comes out of the check.
    expect(large.netPay).toBeCloseTo(small.netPay, 2);
  });
});

describe('federal W-4 rules', () => {
  it('a two-jobs W-4 withholds more federal tax than the same pay without it', async () => {
    const one = await worker('TX', {}, 'One');
    const two = await worker('TX', { multipleJobs: true }, 'Two');
    const items = (await aggregatePayrollProjection(prisma, PERIOD)).items;
    const fitOne = items.find((i) => i.associateId === one.id)!.federalIncomeTax;
    const fitTwo = items.find((i) => i.associateId === two.id)!.federalIncomeTax;
    expect(fitTwo).toBeGreaterThan(fitOne);
  });

  it('an exempt W-4 past February 15 of the next year withholds as Single, and says so', async () => {
    const p = await worker('TX', { exempt: true, exemptTaxYear: 2025 });
    const item = await project(p.id);
    expect(item.federalIncomeTax).toBeGreaterThan(0);
    expect(item.w4Flags).toContain('EXEMPT_EXPIRED');
  });
});
