import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { nextDepositDue, payrollTaxesNeedingYou } from '../../lib/payrollTaxLedger.js';

/**
 * Deep audit 2026-10-29 (builder PAY):
 *   MONEY-28  the next deposit is everything due on the next due date, summed across agencies — the
 *             overview read "Feb 1, 2027 · $384.09 · IRS" and "You're paid up" while Florida's
 *             $1,728.36 was due the same day.
 *   MONEY-16 / CODE-14  the desk's "today" is the company's day, not UTC's: after 8 PM Eastern a
 *             deposit due today read late, and a new-hire report due today read overdue.
 */

const D = (s: string) => new Date(`${s}T00:00:00Z`);

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function payrollAdmin() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: `pay-${Math.random().toString(36).slice(2, 7)}@example.com` });
  return loginAs(agent(), user.email);
}

describe('nextDepositDue', () => {
  it('sums every agency due on the earliest due date that has not passed', () => {
    const lines = [
      { dueDate: '2026-10-20', amount: 50, agency: 'IRS' }, // late, not "next"
      { dueDate: '2027-02-01', amount: 384.09, agency: 'IRS' },
      { dueDate: '2027-02-01', amount: 1728.36, agency: 'Florida Department of Revenue' },
      { dueDate: '2027-02-15', amount: 99, agency: 'IRS' },
    ];
    expect(nextDepositDue(lines, '2026-10-29')).toEqual({ dueDate: '2027-02-01', amount: 2112.45, agencies: ['IRS', 'Florida Department of Revenue'], lines: 2 });
    expect(nextDepositDue(lines.slice(0, 1), '2026-10-29')).toBeNull();
    expect(nextDepositDue([], '2026-10-29')).toBeNull();
    // Due today is next, not late.
    expect(nextDepositDue([{ dueDate: '2026-10-29', amount: 10.1, agency: 'IRS' }, { dueDate: '2026-10-29', amount: 0.2, agency: 'IRS' }], '2026-10-29')).toEqual({ dueDate: '2026-10-29', amount: 10.3, agencies: ['IRS'], lines: 2 });
  });
});

describe('the payroll taxes overview', () => {
  it('names the whole next deposit across agencies (MONEY-28)', async () => {
    const a = await payrollAdmin();
    const due = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    await prisma.taxLiability.createMany({
      data: [
        { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', periodLabel: '2026-Q4', liabilityDate: D('2026-10-23'), dueDate: D(due), amount: 384.09 },
        { kind: 'STATE_UNEMPLOYMENT', jurisdiction: 'FL', periodLabel: '2026-Q4', liabilityDate: D('2026-10-23'), dueDate: D(due), amount: 1728.36 },
      ],
    });
    const ov = await a.get('/payroll-taxes/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.nextDeposit).toMatchObject({ dueDate: due, amount: 2112.45, lines: 2 });
    expect(ov.body.nextDeposit.agencies).toHaveLength(2);
  });

  it('“today” is the company’s day: at 9:30 PM Eastern a deposit due today is due, not late (MONEY-16)', async () => {
    // Thu Oct 29, 2026 01:30 UTC = Wed Oct 28, 9:30 PM in New York.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-29T01:30:00Z') });
    const a = await payrollAdmin();
    await prisma.taxLiability.create({
      data: { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', periodLabel: '2026-Q4', liabilityDate: D('2026-10-23'), dueDate: D('2026-10-28'), amount: 500 },
    });
    const ov = await a.get('/payroll-taxes/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.today).toBe('2026-10-28');
    expect(ov.body.overdue).toHaveLength(0);
    expect(ov.body.dueSoon).toEqual([expect.objectContaining({ dueDate: '2026-10-28', amount: 500 })]);
    expect(ov.body.totals.overdue).toBe(0);
  });
});

describe('a tax payment made on its due date', () => {
  it('is on time when it was paid that evening in the company’s day, late the day after (MONEY-16)', async () => {
    const a = await payrollAdmin();
    const base = { kind: 'FEDERAL_WITHHOLDING' as const, jurisdiction: 'US', periodLabel: '2026-Q3', amount: 100, dueDate: D('2026-10-28'), method: 'EFTPS', status: 'PAID' as const, confirmationNumber: '123' };
    // 9:30 PM Eastern on the due date (already the 29th in UTC).
    const onTime = await prisma.taxPayment.create({ data: { ...base, paidAt: new Date('2026-10-29T01:30:00Z') } });
    const late = await prisma.taxPayment.create({ data: { ...base, paidAt: new Date('2026-10-29T15:00:00Z') } });
    const list = await a.get('/payroll-taxes/payments');
    expect(list.status).toBe(200);
    const byId = new Map((list.body.payments as Array<{ id: string; late: boolean }>).map((p) => [p.id, p.late]));
    expect(byId.get(onTime.id)).toBe(false);
    expect(byId.get(late.id)).toBe(true);
  });
});

describe('what the tax desk needs from someone (the inbox count)', () => {
  it('“due within 7 days” counts from the company’s day, not UTC’s (MONEY-16)', async () => {
    // Wed Oct 28, 9:30 PM in New York is already Thu Oct 29 in UTC.
    const at = new Date('2026-10-29T01:30:00Z');
    await prisma.taxLiability.createMany({
      data: [
        { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', periodLabel: '2026-Q4', liabilityDate: D('2026-10-23'), dueDate: D('2026-11-04'), amount: 100 },
        { kind: 'STATE_UNEMPLOYMENT', jurisdiction: 'FL', periodLabel: '2026-Q4', liabilityDate: D('2026-10-23'), dueDate: D('2026-11-05'), amount: 100 },
      ],
    });
    // Oct 28 + 7 = Nov 4: the Florida deposit on Nov 5 is eight days out.
    expect(await payrollTaxesNeedingYou(prisma, at)).toBe(1);
  });
});

describe('new-hire reports', () => {
  it('a report due today is not overdue after 8 PM Eastern (CODE-14)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-29T01:30:00Z') });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: `nh-${Math.random().toString(36).slice(2, 7)}@example.com` });
    const h = await loginAs(agent(), user.email);
    const person = await prisma.associate.create({ data: { firstName: 'Nia', lastName: 'Hale', email: `nia-${Math.random().toString(36).slice(2, 6)}@example.com`, state: 'FL' } });
    await prisma.newHireReport.create({ data: { associateId: person.id, state: 'FL', hireDate: D('2026-09-28'), dueDate: D('2026-10-28') } });
    const list = await h.get('/pay-compliance/new-hire-reports');
    expect(list.status).toBe(200);
    const row = (list.body.reports as Array<{ associateId: string; overdue: boolean; dueDate: string }>).find((r) => r.associateId === person.id);
    expect(row).toMatchObject({ dueDate: '2026-10-28', overdue: false });
  });
});
