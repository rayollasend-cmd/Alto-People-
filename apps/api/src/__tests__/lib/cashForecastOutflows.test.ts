import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cashForecast, contributionTotal } from '../../lib/cashForecast.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

/**
 * The cash forecast's two missing outflows (finance walk, wave 2):
 * retirement plan contributions withheld and matched but not yet sent to
 * the recordkeeper, and each benefit carrier's monthly premium — and a
 * carrier month already billed is left to the bill.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const NOW = new Date('2026-10-22T15:00:00Z');
const RUN = '00000000-0000-4000-8000-0000000000aa';

describe('retirement and benefit carrier outflows', () => {
  it('adds up what one paycheck sends the plan', () => {
    expect(contributionTotal({ preTax: 50, roth: 10, catchUpPreTax: 5, catchUpRoth: 0, employerMatch: 25, safeHarbor: 0, loanRepayments: [{ loanNumber: 'L1', amount: 12.5 }] })).toBe(102.5);
  });

  it('a contribution not yet sent to the recordkeeper is an outflow; one on a sent file is not', async () => {
    const a = await createAssociate({ firstName: 'Rae', lastName: 'Lund' });
    const plan = await prisma.retirementPlan.create({ data: { name: 'Alto 401(k)', recordkeeper: 'GUIDELINE' } });
    await prisma.retirementContribution.create({ data: { planId: plan.id, associateId: a.id, payrollRunId: RUN, payDate: new Date('2026-10-16'), preTax: 80, employerMatch: 40 } });
    const sent = await prisma.retirementFile.create({ data: { planId: plan.id, kind: 'CONTRIBUTION', format: 'CSV', content: '', status: 'SENT', sentAt: new Date('2026-10-20T00:00:00Z') } });
    await prisma.retirementContribution.create({ data: { planId: plan.id, associateId: a.id, payrollRunId: '00000000-0000-4000-8000-0000000000bb', payDate: new Date('2026-10-20'), preTax: 999, fileId: sent.id } });

    const f = await cashForecast(NOW, { weeks: 4 });
    const ret = f.lines.filter((l) => l.kind === 'RETIREMENT');
    expect(ret).toHaveLength(1);
    // Paid Oct 16, due three days later — so it is past due and expected today.
    expect(ret[0]).toMatchObject({ amount: -120, date: '2026-10-22', confidence: 'overdue', linkUrl: '/payroll/retirement' });
    expect(ret[0]!.label).toContain('Alto 401(k)');
    expect(f.totals.outflow).toBe(120);
  });

  it('each carrier’s monthly premium lands on the 1st; a month already billed is left to the bill', async () => {
    const client = await createClient('Benefits Co');
    const carrier = await prisma.benefitCarrier.create({ data: { name: 'Blue Shield', receiverId: 'BSC', senderId: 'ALTO' } });
    const medical = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'HEALTH_MEDICAL', name: 'PPO', carrierId: carrier.id, employerContributionCentsPerPeriod: 10_000 } });
    const hsa = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'HSA', name: 'HSA', employerContributionCentsPerPeriod: 5_000 } });
    const a = await createAssociate({ firstName: 'Kim', lastName: 'Ode' });
    const b = await createAssociate({ firstName: 'Lu', lastName: 'Tam' });
    await prisma.benefitsEnrollment.create({ data: { associateId: a.id, planId: medical.id, electedAmountCentsPerPeriod: 2_000, effectiveDate: new Date('2026-01-01') } });
    // Ends before November: not in November's premium.
    await prisma.benefitsEnrollment.create({ data: { associateId: b.id, planId: medical.id, electedAmountCentsPerPeriod: 2_000, effectiveDate: new Date('2026-01-01'), terminationDate: new Date('2026-10-31') } });
    // HSA money goes to a custodian, not a carrier.
    await prisma.benefitsEnrollment.create({ data: { associateId: a.id, planId: hsa.id, electedAmountCentsPerPeriod: 3_000, effectiveDate: new Date('2026-01-01') } });
    // December's invoice is already in Books as a bill.
    const vendor = await prisma.vendor.create({ data: { name: 'Blue Shield' } });
    await prisma.bill.create({ data: { vendorId: vendor.id, billNumber: 'BS-12', billDate: new Date('2026-11-20'), dueDate: new Date('2026-12-01'), status: 'APPROVED', total: 260, balance: 260 } });

    const f = await cashForecast(NOW, { weeks: 8 });
    const premiums = f.lines.filter((l) => l.kind === 'BENEFITS');
    // ($20 + $100) a check × 26 checks / 12 months = $260.00, on November 1 only.
    expect(premiums).toEqual([expect.objectContaining({ date: '2026-11-01', amount: -260, confidence: 'estimated', linkUrl: '/benefits/carriers' })]);
    expect(premiums[0]!.label).toBe('Blue Shield premiums — November 2026');
    expect(f.lines.filter((l) => l.kind === 'BILL').map((l) => l.amount)).toEqual([-260]);
    // Every number adds up.
    const sum = (xs: number[]) => Math.round(xs.reduce((x, y) => x + y, 0) * 100) / 100;
    expect(f.totals.net).toBe(sum(f.lines.map((l) => l.amount)));
  });

  it('a forecast payday sends the plan the share of net the last paid run sent', async () => {
    const a = await createAssociate();
    const plan = await prisma.retirementPlan.create({ data: { name: 'Plan', recordkeeper: 'GUIDELINE' } });
    await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-10-10'), payDateOffsetDays: 6 } });
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-09-26'), periodEnd: new Date('2026-10-09'), status: 'DISBURSED', disbursedAt: new Date('2026-10-15T12:00:00Z'), totalNet: 1000, totalGross: 1300 } });
    const sent = await prisma.retirementFile.create({ data: { planId: plan.id, kind: 'CONTRIBUTION', format: 'CSV', content: '', status: 'SENT' } });
    await prisma.retirementContribution.create({ data: { planId: plan.id, associateId: a.id, payrollRunId: run.id, payDate: new Date('2026-10-15'), preTax: 60, employerMatch: 30, fileId: sent.id } });

    const f = await cashForecast(NOW, { weeks: 6 });
    const payroll = f.lines.filter((l) => l.kind === 'PAYROLL');
    const ret = f.lines.filter((l) => l.kind === 'RETIREMENT');
    expect(payroll.length).toBeGreaterThan(0);
    expect(ret.length).toBe(payroll.length);
    // 9% of each payday's net, three days after it.
    for (const r of ret) expect(r).toMatchObject({ confidence: 'estimated', amount: -90 });
  });
});
