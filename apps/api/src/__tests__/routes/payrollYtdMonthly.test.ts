import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The YTD report's month-by-month series: each paid run's gross, taxes
 * withheld, other deductions and net, bucketed by the month it paid out.
 * Voided runs and voided paychecks stay out.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function paidRun(clientId: string, associateId: string, disbursedAt: string, gross: number, net: number, status: 'DISBURSED' | 'CANCELLED' = 'DISBURSED') {
  const run = await prisma.payrollRun.create({
    data: { clientId, periodStart: new Date(disbursedAt), periodEnd: new Date(disbursedAt), status, kind: 'REGULAR', totalGross: gross, totalNet: net, disbursedAt: new Date(disbursedAt), ...(status === 'CANCELLED' ? { cancelledAt: new Date(disbursedAt), cancelReason: 'Wrong period' } : {}) },
  });
  await prisma.payrollItem.create({
    data: { payrollRunId: run.id, associateId, hoursWorked: 40, hourlyRate: gross / 40, grossPay: gross, federalWithholding: 50, fica: 40, medicare: 10, stateWithholding: 0, netPay: net, status: 'DISBURSED' },
  });
}

describe('GET /payroll/ytd — monthly', () => {
  it('sums each month by payout date, splitting gross into taxes, deductions and net', async () => {
    const client = await createClient();
    const a = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await paidRun(client.id, a.id, '2026-03-06T15:00:00Z', 800, 650);
    await paidRun(client.id, a.id, '2026-03-20T15:00:00Z', 800, 680);
    await paidRun(client.id, a.id, '2026-04-03T15:00:00Z', 1000, 850);
    await paidRun(client.id, a.id, '2026-04-17T15:00:00Z', 5000, 4000, 'CANCELLED');
    await paidRun(client.id, a.id, '2025-12-19T15:00:00Z', 900, 750);

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = request.agent(createApp());
    expect((await agent.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);

    const res = await agent.get('/payroll/ytd?year=2026');
    expect(res.status).toBe(200);
    expect(res.body.monthly).toHaveLength(12);
    expect(res.body.monthly[2]).toEqual({ month: '2026-03', gross: 1600, tax: 200, deductions: 70, net: 1330, runs: 2 });
    expect(res.body.monthly[3]).toEqual({ month: '2026-04', gross: 1000, tax: 100, deductions: 50, net: 850, runs: 1 });
    expect(res.body.monthly[0]).toMatchObject({ gross: 0, runs: 0 });
    // The month sums match the year's totals.
    const gross = res.body.monthly.reduce((s: number, m: { gross: number }) => s + m.gross, 0);
    expect(gross).toBe(res.body.totals.gross);
  });
});

describe('GET /payroll/ytd — runs not in the report (F500 G3)', () => {
  it('names a paid run whose stored totals have no paychecks, instead of a silent $0', async () => {
    const client = await createClient();
    const a = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await paidRun(client.id, a.id, '2026-03-06T15:00:00Z', 800, 650);
    // Paid, stored totals, and no paychecks behind them.
    const orphan = await prisma.payrollRun.create({
      data: { clientId: client.id, periodStart: new Date('2026-08-29T00:00:00Z'), periodEnd: new Date('2026-09-11T00:00:00Z'), status: 'DISBURSED', kind: 'REGULAR', totalGross: 4054.5, totalNet: 3490.2, disbursedAt: new Date('2026-09-18T15:00:00Z') },
    });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = request.agent(createApp());
    expect((await agent.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);

    const res = await agent.get('/payroll/ytd?year=2026');
    expect(res.status).toBe(200);
    expect(res.body.totals.gross).toBe(800);
    expect(res.body.notInReport).toEqual([{ id: orphan.id, periodStart: '2026-08-29', periodEnd: '2026-09-11', totalGross: 4054.5, totalNet: 3490.2, paychecks: 0 }]);
  });
});
