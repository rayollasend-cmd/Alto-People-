import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { runTotalsCheck } from '../../lib/payrollRunTotals.js';

/**
 * One source for a run's money (F500 SH-4).
 *
 * The dev tenant's Aug 29 – Sep 11 run stores $4,054.50 gross / $3,490.20
 * net and has no paychecks. The payroll home said "Net paid $0.00" (it
 * summed paychecks) beside the grid's $3,490.20 (stored). Now every surface
 * shows the stored totals and the same `totalsAgree` check; the web shows
 * <RunTotalsMismatch> wherever it is false.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function finance() {
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return loginAs(agent(), user.email);
}

async function brokenRun() {
  return prisma.payrollRun.create({
    data: {
      periodStart: new Date('2026-08-29'),
      periodEnd: new Date('2026-09-11'),
      status: 'DISBURSED',
      totalGross: 4054.5,
      totalTax: 564.3,
      totalNet: 3490.2,
      finalizedAt: new Date('2026-09-14T15:00:00Z'),
      disbursedAt: new Date('2026-09-18T15:00:00Z'),
    },
  });
}

async function soundRun() {
  const run = await prisma.payrollRun.create({
    data: {
      periodStart: new Date('2026-09-12'),
      periodEnd: new Date('2026-09-25'),
      status: 'FINALIZED',
      totalGross: 1500,
      totalTax: 230.55,
      totalNet: 1269.45,
      finalizedAt: new Date('2026-09-28T15:00:00Z'),
    },
  });
  const a = await createAssociate({ firstName: 'Ana', lastName: 'Paid' });
  const b = await createAssociate({ firstName: 'Bo', lastName: 'Paid' });
  await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: a.id, hoursWorked: 40, hourlyRate: 15, grossPay: 600, federalWithholding: 40, netPay: 514.1 } });
  await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: b.id, hoursWorked: 60, hourlyRate: 15, grossPay: 900, federalWithholding: 75, netPay: 755.35 } });
  return run;
}

describe('run totals: one source and a check that it holds', () => {
  it('the payroll home, the runs grid, the close page and the review read the same stored totals and the same mismatch', async () => {
    const run = await brokenRun();
    const a = await finance();

    const upcoming = await a.get('/payroll/upcoming');
    expect(upcoming.status).toBe(200);
    expect(upcoming.body.lastRun).toMatchObject({ id: run.id, totalNet: 3490.2, totalGross: 4054.5, itemsNet: 0, itemsGross: 0, itemCount: 0, totalsAgree: false });

    const list = await a.get('/payroll/runs');
    const row = list.body.runs.find((r: { id: string }) => r.id === run.id);
    expect(row).toMatchObject({ totalNet: 3490.2, totalGross: 4054.5, itemsNet: 0, paychecks: 0, totalsAgree: false });

    const detail = await a.get(`/payroll/runs/${run.id}`);
    expect(detail.body).toMatchObject({ totalNet: 3490.2, totalsAgree: false });

    const close = await a.get(`/payroll/runs/${run.id}/close`);
    expect(close.status).toBe(200);
    expect(close.body.run).toMatchObject({ totalNet: 3490.2, totalGross: 4054.5, itemsGross: 0, paychecks: 0, totalsAgree: false });

    const review = await a.get(`/payroll/runs/${run.id}/review`);
    expect(review.status).toBe(200);
    expect(review.body.report.run).toMatchObject({ storedGross: 4054.5, storedNet: 3490.2, totalsAgree: false });
  });

  it('a sound run agrees to the cent everywhere', async () => {
    const run = await soundRun();
    const a = await finance();
    const upcoming = await a.get('/payroll/upcoming');
    expect(upcoming.body.lastRun).toMatchObject({ id: run.id, totalNet: 1269.45, itemsNet: 1269.45, itemCount: 2, totalsAgree: true });
    const list = await a.get('/payroll/runs');
    expect(list.body.runs.find((r: { id: string }) => r.id === run.id)).toMatchObject({ totalNet: 1269.45, itemsNet: 1269.45, itemsGross: 1500, paychecks: 2, totalsAgree: true });
    const close = await a.get(`/payroll/runs/${run.id}/close`);
    expect(close.body.run.totalsAgree).toBe(true);
  });

  it('the check: a cent off disagrees, voided paychecks don’t count, a cancelled run is exempt', () => {
    const items = [
      { status: 'DISBURSED', grossPay: '600.00', netPay: '514.10' },
      { status: 'DISBURSED', grossPay: '900.00', netPay: '755.35' },
      { status: 'VOIDED', grossPay: '100.00', netPay: '90.00' },
    ];
    expect(runTotalsCheck({ status: 'DISBURSED', totalGross: '1500.00', totalNet: '1269.45' }, items)).toEqual({ totalGross: 1500, totalNet: 1269.45, itemsGross: 1500, itemsNet: 1269.45, paychecks: 2, totalsAgree: true });
    expect(runTotalsCheck({ status: 'DISBURSED', totalGross: '1500.00', totalNet: '1269.46' }, items).totalsAgree).toBe(false);
    expect(runTotalsCheck({ status: 'CANCELLED', totalGross: '1500.00', totalNet: '1269.45' }, items.map((i) => ({ ...i, status: 'VOIDED' }))).totalsAgree).toBe(true);
  });
});
