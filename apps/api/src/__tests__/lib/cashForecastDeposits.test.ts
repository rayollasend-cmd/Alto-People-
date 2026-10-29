import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cashForecast, quarterWords } from '../../lib/cashForecast.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { scheduleFilterFor } from '../../lib/payScheduleMembership.js';
import { runCutFor } from '../../lib/payrollRunCut.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';
import { postEntry } from '../../lib/books/ledger.js';

/**
 * Deep audit 2026-10-29:
 *
 *   MONEY-6   The forecast dates the federal deposit on the IRS agency
 *             account's schedule — the tax desk's — not the submitter
 *             profile's: the Oct 30 payday's deposit is due Wed Nov 4 on a
 *             semiweekly schedule (it read Nov 16), and the Nov 13 payday's
 *             (due Nov 18) is in the four-week window. The desk's open
 *             liabilities (state included) are lines too, never twice.
 *   MONEY-14  The open period is projected for the schedule's members only —
 *             the same projection as Payroll's next run — not everyone with
 *             time.
 *
 *   Today is Thursday Oct 29, 2026; the schedule is biweekly Sat→Fri, paid
 *   the Friday after (period Oct 10–23 pays Oct 30; Oct 24–Nov 6 pays Nov 13).
 */

const NOW = new Date('2026-10-29T16:00:00Z');

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function schedule() {
  return prisma.payrollSchedule.create({ data: { name: 'Biweekly · Sat–Fri', frequency: 'BIWEEKLY', anchorDate: new Date('2026-10-10'), payDateOffsetDays: 7, isDefault: true } });
}

async function paidRun() {
  // Last run paid: $1,000 net with $300 of federal tax (FIT + both halves of FICA) — 30% of net.
  const a = await createAssociate({ firstName: 'Lee', lastName: 'Paid' });
  const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-09-26'), periodEnd: new Date('2026-10-09'), status: 'DISBURSED', disbursedAt: new Date('2026-10-16T15:00:00Z'), totalNet: 1000, totalGross: 1300 } });
  await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: a.id, hoursWorked: 65, hourlyRate: 20, grossPay: 1300, federalWithholding: 100, fica: 80, medicare: 20, employerFica: 80, employerMedicare: 20, netPay: 1000, status: 'DISBURSED' } });
  return run;
}

describe('MONEY-6: federal deposits on the tax desk’s schedule', () => {
  it('a semiweekly IRS account dates the Oct 30 payday’s deposit Wed Nov 4, and the Nov 13 payday’s Nov 18', async () => {
    const s = await schedule();
    await paidRun();
    await prisma.taxAgencyAccount.create({ data: { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', agencyName: 'Internal Revenue Service', depositFrequency: 'SEMIWEEKLY' } });
    // The Oct 10–23 run, finalized: its own federal tax.
    const a = await createAssociate({ firstName: 'Mo', lastName: 'Next' });
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), status: 'FINALIZED', finalizedAt: new Date('2026-10-27T15:00:00Z'), totalNet: 2000, totalGross: 2600, payrollScheduleId: s.id } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: a.id, hoursWorked: 130, hourlyRate: 20, grossPay: 2600, federalWithholding: 200, fica: 161.2, medicare: 37.7, employerFica: 161.2, employerMedicare: 37.7, netPay: 2000 } });

    const f = await cashForecast(NOW, { weeks: 4 });
    const deposits = f.lines.filter((l) => l.kind === 'TAX_DEPOSIT');
    expect(deposits.find((l) => l.label === 'Federal deposit for the Oct 30 payday')).toMatchObject({ date: '2026-11-04', amount: -597.8 });
    // The next payday's deposit is in the window now (Nov 18), at the last paid run's share of net.
    expect(deposits.find((l) => l.label === 'Federal deposit for the Nov 13 payday')).toMatchObject({ date: '2026-11-18', amount: -300 });
  });

  it('the tax desk’s open liabilities are lines on their due dates — a run the desk itemized is never counted twice', async () => {
    await schedule();
    const run = await paidRun();
    await prisma.taxLiability.create({ data: { payrollRunId: run.id, kind: 'STATE_UNEMPLOYMENT', jurisdiction: 'FL', periodLabel: '2026-Q4', liabilityDate: new Date('2026-10-16'), dueDate: new Date('2026-11-20'), amount: 864.58, breakdown: { unemployment: 864.58 } } });
    await prisma.taxLiability.create({ data: { payrollRunId: run.id, kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', periodLabel: '2026-Q4', liabilityDate: new Date('2026-10-16'), dueDate: new Date('2026-10-21'), amount: 300, breakdown: { federalIncomeTax: 100 }, status: 'PAID' } });
    // The older per-run deposit for the same run: the desk itemized it, so it is not a second outflow.
    await prisma.taxDeposit.create({ data: { kind: 'FED_941', scheduleUsed: 'MONTHLY', periodLabel: 'Oct 16 payday', payrollRunId: run.id, liabilityDate: new Date('2026-10-16'), dueDate: new Date('2026-11-15'), amount: 300, breakdown: {} } });

    const f = await cashForecast(NOW, { weeks: 4 });
    const tax = f.lines.filter((l) => l.kind === 'TAX_DEPOSIT' && !l.label.startsWith('Federal deposit for'));
    expect(tax).toEqual([expect.objectContaining({ date: '2026-11-20', amount: -864.58, confidence: 'scheduled', label: 'Florida unemployment insurance — Oct–Dec 2026' })]);
  });

  it('a quarter reads as months', () => {
    expect(quarterWords('2026-Q4')).toBe('Oct–Dec 2026');
    expect(quarterWords('2026-10')).toBe('2026-10');
  });
});

describe('MONEY-18: an overdrawn bank account is named, not netted away', () => {
  it('the opening position lists bank accounts below zero', async () => {
    await postEntry(prisma, { date: '2026-10-01', source: 'MANUAL', lines: [{ account: 'CASH_OPERATING', debit: 20000 }, { account: 'OWNER_EQUITY', credit: 20000 }] });
    await postEntry(prisma, { date: '2026-10-16', source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 3908.97 }, { account: 'CASH_PAYROLL', credit: 3908.97 }] });
    const f = await cashForecast(NOW, { weeks: 4 });
    expect(f.opening).toMatchObject({ balance: 16091.03, overdrawn: [{ name: 'Payroll checking', balance: -3908.97 }] });
  });
});

describe('MONEY-14: the open period is the schedule’s people, as Payroll projects it', () => {
  it('projects only the schedule’s members — the same figure as the next run', async () => {
    const s = await schedule();
    const client = await createClient('Front Beach');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: site.id }, data: { state: 'FL', timezone: 'America/New_York' } });
    const member = await createAssociate({ firstName: 'Ana', lastName: 'Member' });
    const outsider = await createAssociate({ firstName: 'Bo', lastName: 'Elsewhere' });
    for (const a of [member, outsider]) {
      await prisma.associate.update({ where: { id: a.id }, data: { state: 'FL' } });
      for (const day of ['2026-10-13', '2026-10-14']) {
        await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, locationId: site.id, clockInAt: new Date(`${day}T13:00:00Z`), clockOutAt: new Date(`${day}T21:00:00Z`), status: 'APPROVED', approvedAt: new Date('2026-10-15T12:00:00Z') } });
      }
    }
    await prisma.payrollScheduleAssignment.create({ data: { scheduleId: s.id, associateId: member.id, effectiveFrom: new Date('2026-01-01'), source: 'INDIVIDUAL' } });

    const f = await cashForecast(NOW, { weeks: 4 });
    const line = f.lines.find((l) => l.kind === 'PAYROLL' && l.date === '2026-10-30')!;
    expect(line.label).toBe('Payroll Oct 10 – 23 (projected)');

    // Payroll's own projection of the next run (routes/payroll /upcoming): the schedule's members only.
    const ps = new Date('2026-10-10T00:00:00Z');
    const filter = await scheduleFilterFor(prisma, s.id, ps, new Date('2026-10-23T00:00:00Z'));
    const { cut, payDate } = await runCutFor(prisma, { kind: 'REGULAR', payrollScheduleId: s.id, clientId: null, periodStart: '2026-10-10', periodEnd: '2026-10-23', windows: filter.windows });
    const proj = await aggregatePayrollProjection(prisma, { periodStart: ps, periodEndExclusive: new Date('2026-10-24T00:00:00Z'), clientId: null, defaultRate: 15, scheduleFilter: filter, payDate, prevUtcCut: cut.prevUtc });
    expect(proj.items.map((i) => i.associateId)).toEqual([member.id]);
    expect(line.amount).toBe(-Math.round(proj.totals.totalNet * 100) / 100);
    // Everyone-with-time would have been about twice that.
    const everyone = await aggregatePayrollProjection(prisma, { periodStart: ps, periodEndExclusive: new Date('2026-10-24T00:00:00Z'), clientId: null, defaultRate: 15 });
    expect(everyone.totals.totalNet).toBeGreaterThan(proj.totals.totalNet * 1.5);
  });
});
