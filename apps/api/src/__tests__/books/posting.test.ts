import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';
import { accountBalance, accountByKey } from '../../lib/books/ledger.js';
import { trialBalance } from '../../lib/books/reports.js';
import { postPayrollRun, runKey } from '../../lib/books/posting/payroll.js';
import { postStatement } from '../../lib/books/posting/statements.js';
import { postGarnishmentRemittance, postTaxPayment, postWageAdvance } from '../../lib/books/posting/remittances.js';
import { backfillPosting, postingGaps } from '../../lib/books/posting/gaps.js';

/**
 * Automatic posting: a payroll run accrues wages, employer taxes and every
 * deduction to its payable and pays net pay out of payroll checking; a
 * statement is a receivable split by store; tax, garnishment and advance
 * payments leave payroll checking — all balanced, idempotent, and taken off
 * when the source is voided. postingGaps finds what's missing; the backfill
 * posts it once.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const bal = async (key: string, through = '2099-12-31') => (await accountBalance(prisma, (await accountByKey(prisma, key)).id, through)) + 0;

async function seedRun(status: 'FINALIZED' | 'DISBURSED' = 'FINALIZED') {
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const worker = await createAssociate({ firstName: 'Ana', lastName: 'Field' });
  await prisma.associate.update({ where: { id: worker.id }, data: { employmentType: 'W2_EMPLOYEE' } });
  await prisma.associateAssignment.create({ data: { associateId: worker.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
  const staff = await createAssociate({ firstName: 'Sam', lastName: 'Office' });
  await prisma.associate.update({ where: { id: staff.id }, data: { employmentType: 'W2_EMPLOYEE' } });
  const run = await prisma.payrollRun.create({
    data: { periodStart: new Date('2026-09-26'), periodEnd: new Date('2026-10-09'), status, finalizedAt: new Date('2026-10-12'), ...(status === 'DISBURSED' ? { disbursedAt: new Date('2026-10-16T15:00:00Z') } : {}) },
  });
  // Ana: 1,000 gross at a client. 80 FIT, 62 SS, 14.50 Medicare, 30 state, 5 local, 4 state disability;
  // deductions: medical 50 (employer 120), 401(k) 40, garnishment 25, van rides 10; reimbursed 20.
  // net = 1000 + 20 − (80 + 62 + 14.5 + 30 + 5 + 4) − (50 + 40 + 25 + 10) = 699.50
  const ana = await prisma.payrollItem.create({
    data: {
      payrollRunId: run.id, associateId: worker.id, hoursWorked: 50, hourlyRate: 20, grossPay: 1000,
      federalWithholding: 80, fica: 62, medicare: 14.5, stateWithholding: 30, localWithholding: 5,
      employerFica: 62, employerMedicare: 14.5, employerFuta: 6, employerSuta: 27,
      preTaxDeductions: 90, postTaxDeductions: 35, reimbursementsTotal: 20, netPay: 699.5,
      status: status === 'DISBURSED' ? 'DISBURSED' : 'PENDING', ...(status === 'DISBURSED' ? { disbursedAt: new Date('2026-10-16T15:00:00Z') } : {}),
      taxLines: { create: [{ code: 'CA-SDI', kind: 'STATE_PROGRAM', label: 'CA SDI', amount: 4 }, { code: 'PA-LST', kind: 'LOCAL', label: 'Employer head tax', amount: 3, employer: true }] },
      deductions: {
        create: [
          { code: 'MEDICAL', category: 'PRE_TAX', label: 'Medical', employeeAmount: 50 },
          { code: 'ER_HEALTH', category: 'EMPLOYER', label: 'Employer health', employerAmount: 120 },
          { code: 'RET_401K', category: 'PRE_TAX', label: '401(k)', employeeAmount: 40 },
          { code: 'GARNISHMENT', category: 'POST_TAX', label: 'Child support', employeeAmount: 25 },
          { code: 'RIDES', category: 'POST_TAX', label: 'Van rides', employeeAmount: 10 },
        ],
      },
    },
  });
  // Sam: company staff, 500 gross, 40 FIT, 31 SS, 7.25 Medicare, no deductions → 421.75.
  const sam = await prisma.payrollItem.create({
    data: {
      payrollRunId: run.id, associateId: staff.id, hoursWorked: 25, hourlyRate: 20, grossPay: 500,
      federalWithholding: 40, fica: 31, medicare: 7.25, employerFica: 31, employerMedicare: 7.25, netPay: 421.75,
      status: status === 'DISBURSED' ? 'DISBURSED' : 'PENDING', ...(status === 'DISBURSED' ? { disbursedAt: new Date('2026-10-16T15:00:00Z') } : {}),
    },
  });
  return { client, site, run, ana, sam };
}

describe('a payroll run', () => {
  it('accrues wages by client and staff, employer taxes, and every deduction to its payable — balanced, and idempotent', async () => {
    const { client, site, run } = await seedRun();
    const r = await postPayrollRun(prisma, run.id);
    expect(r).toMatchObject({ accrual: 'posted', disbursement: 'skipped', suspenseCents: 0 });
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { sourceKey: runKey(run.id) }, include: { lines: { include: { account: true } } } });
    expect(entry).toMatchObject({ entryDate: new Date('2026-10-09'), source: 'PAYROLL', periodKey: '2026-10' });

    expect(await bal('WAGES_DIRECT')).toBe(1000);
    expect(await bal('WAGES_INTERNAL')).toBe(500);
    // Employer: Ana 62 + 14.5 + 6 + 27 + 3 local; Sam 31 + 7.25.
    expect(await bal('EMPLOYER_TAX_DIRECT')).toBe(112.5);
    expect(await bal('EMPLOYER_TAX_INTERNAL')).toBe(38.25);
    expect(await bal('BENEFITS_DIRECT')).toBe(120);
    expect(await bal('REIMBURSEMENTS')).toBe(20);
    expect(await bal('NET_PAY_PAYABLE')).toBe(1121.25);
    expect(await bal('FIT_PAYABLE')).toBe(120);
    expect(await bal('FICA_PAYABLE')).toBe(62 + 14.5 + 62 + 14.5 + 31 + 7.25 + 31 + 7.25);
    expect(await bal('SIT_PAYABLE')).toBe(30);
    expect(await bal('LOCAL_TAX_PAYABLE')).toBe(8);
    expect(await bal('SUTA_PAYABLE')).toBe(31);
    expect(await bal('FUTA_PAYABLE')).toBe(6);
    expect(await bal('BENEFITS_PAYABLE')).toBe(170);
    expect(await bal('RETIREMENT_PAYABLE')).toBe(40);
    expect(await bal('GARNISHMENTS_PAYABLE')).toBe(25);
    expect(await bal('REVENUE_TRANSPORT')).toBe(10);
    expect(await bal('UNCATEGORIZED_EXPENSE')).toBe(0);

    // Tagged by client and store — never by person.
    const direct = entry.lines.filter((l) => l.account.systemKey === 'WAGES_DIRECT');
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({ clientId: client.id, siteId: site.id });
    expect(entry.lines.find((l) => l.account.systemKey === 'WAGES_INTERNAL')!.clientId).toBeNull();
    expect((await trialBalance(prisma, '2026-12-31')).totals.balanced).toBe(true);

    await postPayrollRun(prisma, run.id);
    expect(await prisma.journalEntry.count()).toBe(1);
  });

  it('pays net pay out of payroll checking once paid, and comes off the books when voided', async () => {
    const { run } = await seedRun('DISBURSED');
    expect(await postPayrollRun(prisma, run.id)).toMatchObject({ accrual: 'posted', disbursement: 'posted' });
    expect(await bal('NET_PAY_PAYABLE')).toBe(0);
    expect(await bal('CASH_PAYROLL')).toBe(-1121.25);
    const paid = await prisma.journalEntry.findFirstOrThrow({ where: { sourceKey: `${runKey(run.id)}:disburse` } });
    expect(paid.entryDate.toISOString().slice(0, 10)).toBe('2026-10-16');

    await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Run in error' } });
    expect(await postPayrollRun(prisma, run.id)).toMatchObject({ accrual: 'voided', disbursement: 'voided' });
    expect(await bal('WAGES_DIRECT')).toBe(0);
    expect(await bal('CASH_PAYROLL')).toBe(0);
  });

  it('a check whose numbers don’t tie posts the difference to Uncategorized expense, named', async () => {
    const { run, sam } = await seedRun();
    await prisma.payrollItem.update({ where: { id: sam.id }, data: { netPay: 420 } });
    const r = await postPayrollRun(prisma, run.id);
    expect(r.suspenseCents).toBe(175);
    expect(await bal('UNCATEGORIZED_EXPENSE')).toBe(-1.75);
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { sourceKey: runKey(run.id) } });
    expect(entry.memo).toMatch(/1\.75 that doesn’t tie/);
  });

  it('a draft posts nothing; a 1099 contractor is a contractor payment', async () => {
    const { run, sam } = await seedRun();
    await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'DRAFT' } });
    expect(await postPayrollRun(prisma, run.id)).toMatchObject({ accrual: 'skipped' });
    await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'FINALIZED' } });
    await prisma.associate.update({ where: { id: sam.associateId }, data: { employmentType: 'CONTRACTOR_1099_INDIVIDUAL' } });
    await postPayrollRun(prisma, run.id);
    expect(await bal('CONTRACTORS_DIRECT')).toBe(500);
    expect(await bal('WAGES_INTERNAL')).toBe(0);
  });
});

describe('a client statement', () => {
  it('is a receivable and revenue split by store, with adjustments apart', async () => {
    const client = await createClient('Seaside Inn');
    const [main] = await prisma.site.findMany({ where: { clientId: client.id } });
    const second = await prisma.site.create({ data: { clientId: client.id, name: 'Seaside North' } });
    const st = await prisma.clientStatement.create({
      data: {
        clientId: client.id, periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINAL', number: 7, finalizedAt: new Date('2026-10-12T14:00:00Z'),
        snapshot: { totals: { amount: 1300, hoursAmount: 1000, adjustmentsAmount: 300, hours: 40 }, stores: [{ locationName: main!.name, hours: 30, amount: 750 }, { locationName: 'Seaside North', hours: 10, amount: 250 }], lines: [] },
      },
    });
    expect(await postStatement(prisma, st.id)).toBe('posted');
    expect(await bal('AR')).toBe(1300);
    expect(await bal('REVENUE_STAFFING')).toBe(1000);
    expect(await bal('REVENUE_ADJUSTMENTS')).toBe(300);
    const lines = await prisma.journalLine.findMany({ where: { account: { systemKey: 'REVENUE_STAFFING' } } });
    expect(lines.map((l) => [l.siteId, Number(l.credit)]).sort()).toEqual([[main!.id, 750], [second.id, 250]].sort());
    // A draft isn't revenue.
    const draft = await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-16'), snapshot: { totals: { amount: 500 } } } });
    expect(await postStatement(prisma, draft.id)).toBe('skipped');
  });
});

describe('money paid out of payroll', () => {
  it('a tax payment pays down the liabilities it covers; the extra is named', async () => {
    const p = await prisma.taxPayment.create({ data: { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', periodLabel: '2026-10', amount: 310, dueDate: new Date('2026-10-20'), method: 'EFTPS', status: 'PAID', paidAt: new Date('2026-10-19T12:00:00Z') } });
    await prisma.taxLiability.create({ data: { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', periodLabel: '2026-10', liabilityDate: new Date('2026-10-16'), dueDate: new Date('2026-10-20'), amount: 300, breakdown: { federalIncomeTax: 120 }, status: 'PAID', paymentId: p.id } });
    expect(await postTaxPayment(prisma, p.id)).toBe('posted');
    expect(await bal('FIT_PAYABLE')).toBe(-120);
    expect(await bal('FICA_PAYABLE')).toBe(-180);
    expect(await bal('UNCATEGORIZED_EXPENSE')).toBe(10);
    expect(await bal('CASH_PAYROLL')).toBe(-310);
  });

  it('a garnishment remittance and a wage advance leave payroll checking', async () => {
    const { run, ana } = await seedRun();
    const rem = await prisma.garnishmentRemittance.create({ data: { payrollRunId: run.id, payeeName: 'State SDU', amount: 25, status: 'SENT', sentAt: new Date('2026-10-17T12:00:00Z') } });
    expect(await postGarnishmentRemittance(prisma, rem.id)).toBe('posted');
    expect(await bal('GARNISHMENTS_PAYABLE')).toBe(-25);
    const adv = await prisma.earnedWageAdvance.create({ data: { associateId: ana.associateId, periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), amountCents: 10000, feeCents: 300, earnedNetCents: 40000, availableCents: 20000, status: 'PAID', paidAt: new Date('2026-10-14T12:00:00Z') } });
    expect(await postWageAdvance(prisma, adv.id)).toBe('posted');
    expect(await bal('EMPLOYEE_ADVANCES')).toBe(103);
    expect(await bal('OTHER_INCOME')).toBe(3);
  });
});

describe('gaps and the backfill', () => {
  it('lists what should have posted, posts it once, and takes a voided run off', async () => {
    const { run } = await seedRun('DISBURSED');
    const client = await createClient('Harbor Grill');
    const st = await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINAL', number: 3, finalizedAt: new Date('2026-10-12T14:00:00Z'), snapshot: { totals: { amount: 800 } } } });
    const gaps = await postingGaps(prisma, '2026-10');
    expect(gaps.map((g) => g.kind).sort()).toEqual(['PAYROLL_DISBURSEMENT', 'PAYROLL_RUN', 'STATEMENT']);
    expect(gaps.find((g) => g.kind === 'STATEMENT')).toMatchObject({ sourceId: st.id, link: `/clients/${client.id}?tab=statements` });

    const first = await backfillPosting(prisma);
    expect(first).toMatchObject({ payrollRuns: 1, statements: 1, failed: [] });
    expect(await postingGaps(prisma, '2026-10')).toEqual([]);
    const again = await backfillPosting(prisma);
    expect(again).toMatchObject({ payrollRuns: 0, statements: 0 });

    await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Run in error' } });
    expect((await backfillPosting(prisma)).payrollRuns).toBe(1);
    expect(await bal('WAGES_DIRECT')).toBe(0);
  });
});
