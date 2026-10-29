import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { computePayrollExceptions } from '../../lib/payrollExceptions.js';
import { billedNotPaid } from '../../lib/payBillGaps.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Deep audit 2026-10-29, CODE-1 (+ MONEY-1) and CODE-2 through the API.
 *
 * Alto pays biweekly Sat → Fri; periods Oct 10–23 and Oct 24 – Nov 6, 2026.
 * A Chicago clock-in at 7:30 PM CDT on Friday Oct 23 is 00:30 UTC Saturday:
 * the old cut fetched it for neither run (schedule runs) or paid it in the
 * wrong one (legacy runs). It is paid in Oct 10–23, once; the exceptions
 * and the pay-and-bill check see the same cut. A check's tax year is its
 * pay date's: Dec 19 – Jan 1 is paid Jan 8, 2027 and starts 2027's bases.
 */

const app = () => createApp();
async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}
const job = <T>(fn: () => Promise<T>) => runWithTenant(ALTO_TENANT_ID, 'job', fn);
type Item = { associateId: string; hoursWorked: number; ytdWages?: number; fica?: number; grossPay: number };

async function world(tz = 'America/Chicago') {
  const client = await createClient('Lakeshore Suites');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { timezone: tz, state: 'IL' } });
  const schedule = await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-08-29'), payDateOffsetDays: 7, isActive: true } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
  await prisma.associate.update({ where: { id: ana.id }, data: { employmentType: 'W2_EMPLOYEE', state: 'IL' } });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date('2026-08-01') } });
  await prisma.payrollScheduleAssignment.create({ data: { associateId: ana.id, scheduleId: schedule.id, effectiveFrom: new Date('2026-08-01'), source: 'INDIVIDUAL' } });
  await prisma.compensationRecord.create({ data: { associateId: ana.id, payType: 'HOURLY', amount: 20, currency: 'USD', reason: 'HIRE', effectiveFrom: new Date('2026-01-01') } });
  const entry = (startIso: string, hours: number, status: 'APPROVED' | 'COMPLETED' = 'APPROVED', associateId = ana.id) =>
    prisma.timeEntry.create({ data: { associateId, clientId: client.id, locationId: site.id, clockInAt: new Date(startIso), clockOutAt: new Date(new Date(startIso).getTime() + hours * 3_600_000), status, ...(status === 'APPROVED' ? { approvedAt: new Date() } : {}) } });
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const a = await loginAs(user.email);
  return { client, site, schedule, ana, entry, a };
}

const hoursOf = (items: Item[], id: string) => items.filter((i) => i.associateId === id).reduce((s, i) => s + i.hoursWorked, 0);

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('one pay-period cut (CODE-1)', () => {
  it('a schedule run pays a 7:30 PM Friday Chicago clock-in in the period ending that Friday — and the next period does not', async () => {
    const w = await world();
    await w.entry('2026-10-15T14:00:00Z', 8); // an ordinary Thursday
    await w.entry('2026-10-24T00:30:00Z', 8); // Fri Oct 23, 7:30 PM CDT — the last day's evening
    const first = await w.a.post('/payroll/runs/preview').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-10-10', periodEnd: '2026-10-23' });
    expect(first.status).toBe(200);
    expect(hoursOf(first.body.items, w.ana.id)).toBe(16);
    const next = await w.a.post('/payroll/runs/preview').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-10-24', periodEnd: '2026-11-06' });
    expect(next.status).toBe(200);
    expect(hoursOf(next.body.items, w.ana.id)).toBe(0);
  });

  it('a run not on a schedule (legacy) cuts the same way', async () => {
    const w = await world();
    await w.entry('2026-10-24T00:30:00Z', 8);
    const first = await w.a.post('/payroll/runs/preview').send({ periodStart: '2026-10-10', periodEnd: '2026-10-23' });
    expect(hoursOf(first.body.items, w.ana.id)).toBe(8);
    const next = await w.a.post('/payroll/runs/preview').send({ periodStart: '2026-10-24', periodEnd: '2026-11-06' });
    expect(hoursOf(next.body.items, w.ana.id)).toBe(0);
  });

  it('11:59 PM on the last day is the period’s; 12:00 AM is the next one’s (New York)', async () => {
    const w = await world('America/New_York');
    await w.entry('2026-10-24T03:59:00Z', 4); // Fri Oct 23 11:59 PM EDT
    await w.entry('2026-10-24T04:00:00Z', 3); // Sat Oct 24 12:00 AM EDT
    const first = await w.a.post('/payroll/runs/preview').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-10-10', periodEnd: '2026-10-23' });
    const next = await w.a.post('/payroll/runs/preview').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-10-24', periodEnd: '2026-11-06' });
    expect(hoursOf(first.body.items, w.ana.id)).toBe(4);
    expect(hoursOf(next.body.items, w.ana.id)).toBe(3);
  });

  it('the DST weekend: an overnight shift across the Nov 1 fall-back pays its real 9 hours, in its own period', async () => {
    const w = await world('America/New_York');
    // Sat Oct 31 10 PM EDT (02:00Z) to Sun Nov 1 6 AM EST (11:00Z): nine hours on the clock.
    await prisma.timeEntry.create({ data: { associateId: w.ana.id, clientId: w.client.id, locationId: w.site.id, clockInAt: new Date('2026-11-01T02:00:00Z'), clockOutAt: new Date('2026-11-01T11:00:00Z'), status: 'APPROVED', approvedAt: new Date() } });
    const run = await w.a.post('/payroll/runs/preview').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-10-24', periodEnd: '2026-11-06' });
    expect(hoursOf(run.body.items, w.ana.id)).toBe(9);
    const before = await w.a.post('/payroll/runs/preview').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-10-10', periodEnd: '2026-10-23' });
    expect(hoursOf(before.body.items, w.ana.id)).toBe(0);
  });

  it('the exceptions see the same cut: an unapproved 7 PM Friday shift warns on the period it belongs to', async () => {
    const w = await world();
    await w.entry('2026-10-15T14:00:00Z', 8);
    await w.entry('2026-10-24T00:00:00Z', 6, 'COMPLETED'); // Fri Oct 23 7 PM CDT, not yet approved
    const r = await job(() => computePayrollExceptions(prisma, { periodStart: new Date('2026-10-10T00:00:00Z'), periodEndExclusive: new Date('2026-10-24T00:00:00Z'), clientId: null, payrollScheduleId: w.schedule.id }));
    expect(r.exceptions.filter((e) => e.kind === 'UNAPPROVED_TIME').map((e) => e.associateId)).toEqual([w.ana.id]);
    const next = await job(() => computePayrollExceptions(prisma, { periodStart: new Date('2026-10-24T00:00:00Z'), periodEndExclusive: new Date('2026-11-07T00:00:00Z'), clientId: null, payrollScheduleId: w.schedule.id }));
    expect(next.exceptions.filter((e) => e.kind === 'UNAPPROVED_TIME')).toEqual([]);
  });

  it('the deploy transition: after a UTC-cut run, the next run pays the evening it left unpaid — once', async () => {
    const w = await world();
    await w.entry('2026-10-23T20:00:00Z', 2); // Fri Oct 23 3 PM CDT — the UTC-cut run paid this
    await w.entry('2026-10-24T00:30:00Z', 8); // Fri Oct 23 7:30 PM CDT — its UTC range ended at 00:00Z
    await w.entry('2026-10-27T14:00:00Z', 8); // Tue Oct 27
    const old = await prisma.payrollRun.create({
      data: { payrollScheduleId: w.schedule.id, periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), status: 'DISBURSED', disbursedAt: new Date('2026-10-30T12:00:00Z'), timeCut: 'UTC', totalGross: 40, totalNet: 36 },
    });
    await prisma.payrollItem.create({ data: { payrollRunId: old.id, associateId: w.ana.id, hoursWorked: 2, hourlyRate: 20, grossPay: 40, federalWithholding: 0, netPay: 36, status: 'DISBURSED', disbursedAt: new Date('2026-10-30T12:00:00Z') } });
    const next = await w.a.post('/payroll/runs/preview').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-10-24', periodEnd: '2026-11-06' });
    expect(hoursOf(next.body.items, w.ana.id)).toBe(16);
    // Had the earlier run used the site-day cut, it paid that evening itself: nothing to carry.
    await prisma.payrollRun.update({ where: { id: old.id }, data: { timeCut: 'SITE_DAY' } });
    const after = await w.a.post('/payroll/runs/preview').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-10-24', periodEnd: '2026-11-06' });
    expect(hoursOf(after.body.items, w.ana.id)).toBe(8);
  });

  it('re-working a UTC-cut draft: it moves to the site-day cut — unless its next run already carried its evening', async () => {
    const w = await world();
    await w.entry('2026-10-15T14:00:00Z', 8);
    await w.entry('2026-10-24T00:30:00Z', 6); // Fri Oct 23 7:30 PM CDT
    const draft = await prisma.payrollRun.create({ data: { payrollScheduleId: w.schedule.id, periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), status: 'DRAFT', timeCut: 'UTC' } });
    // The next run already exists and carried the evening in.
    const next = await prisma.payrollRun.create({ data: { payrollScheduleId: w.schedule.id, periodStart: new Date('2026-10-24'), periodEnd: new Date('2026-11-06'), status: 'DRAFT' } });
    expect((await w.a.post(`/payroll/runs/${draft.id}/add-ons`).send({ associateId: w.ana.id, kind: 'BONUS', amount: 10 })).status).toBe(201);
    const kept = await prisma.payrollRun.findUniqueOrThrow({ where: { id: draft.id }, include: { items: true } });
    expect(kept.timeCut).toBe('UTC');
    expect(Number(kept.items[0]!.hoursWorked)).toBe(8);
    // With no next run, re-working it moves it to the site-day cut and it pays the evening itself.
    await prisma.payrollRun.delete({ where: { id: next.id } });
    expect((await w.a.post(`/payroll/runs/${draft.id}/add-ons`).send({ associateId: w.ana.id, kind: 'BONUS', amount: 5 })).status).toBe(201);
    const moved = await prisma.payrollRun.findUniqueOrThrow({ where: { id: draft.id }, include: { items: true } });
    expect(moved.timeCut).toBe('SITE_DAY');
    expect(Number(moved.items[0]!.hoursWorked)).toBe(14);
  });

  it('one person’s projection (the associate’s pay preview) is the run’s math for them alone', async () => {
    const w = await world();
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Ode' });
    await w.entry('2026-10-15T14:00:00Z', 8);
    await w.entry('2026-10-15T14:00:00Z', 5, 'APPROVED', ben.id);
    const all = await job(() => aggregatePayrollProjection(prisma, { periodStart: new Date('2026-10-10T00:00:00Z'), periodEndExclusive: new Date('2026-10-24T00:00:00Z'), clientId: null, defaultRate: 20 }));
    const one = await job(() => aggregatePayrollProjection(prisma, { periodStart: new Date('2026-10-10T00:00:00Z'), periodEndExclusive: new Date('2026-10-24T00:00:00Z'), clientId: null, defaultRate: 20, associateIds: [w.ana.id] }));
    expect(all.items.map((i) => i.associateId).sort()).toEqual([w.ana.id, ben.id].sort());
    expect(one.items.map((i) => i.associateId)).toEqual([w.ana.id]);
    expect(one.items[0]!.netPay).toBe(all.items.find((i) => i.associateId === w.ana.id)!.netPay);
  });

  it('a run made now is marked SITE_DAY', async () => {
    const w = await world();
    await w.entry('2026-10-15T14:00:00Z', 8);
    const created = await w.a.post('/payroll/runs').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-10-10', periodEnd: '2026-10-23' });
    expect(created.status).toBe(201);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: created.body.id } })).timeCut).toBe('SITE_DAY');
  });

  it('pay and bill: hours a FINAL statement billed are "paid" only by the check that paid those very hours (MONEY-1)', async () => {
    const w = await world();
    await w.entry('2026-10-15T14:00:00Z', 8);
    await w.entry('2026-10-24T00:30:00Z', 6); // Fri Oct 23 7:30 PM CDT
    await prisma.clientStatement.create({ data: { clientId: w.client.id, periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), status: 'FINAL', snapshot: {} } });
    // A UTC-cut run for the period paid the person — but not the evening shift.
    const old = await prisma.payrollRun.create({
      data: { payrollScheduleId: w.schedule.id, periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), status: 'DISBURSED', disbursedAt: new Date('2026-10-30T12:00:00Z'), timeCut: 'UTC', totalGross: 160, totalNet: 140 },
    });
    await prisma.payrollItem.create({ data: { payrollRunId: old.id, associateId: w.ana.id, hoursWorked: 8, hourlyRate: 20, grossPay: 160, federalWithholding: 0, netPay: 140, status: 'DISBURSED' } });
    const gaps = await job(() => billedNotPaid(prisma, { periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23') }));
    expect(gaps.rows.map((r) => [r.associateId, r.hours, r.weekStart])).toEqual([[w.ana.id, 6, '2026-10-17']]);
    // Under the site-day cut the same run paid both: nothing billed and unpaid.
    await prisma.payrollRun.update({ where: { id: old.id }, data: { timeCut: 'SITE_DAY' } });
    const none = await job(() => billedNotPaid(prisma, { periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23') }));
    expect(none.rows).toEqual([]);
  });
});

describe('the tax year is the pay date’s (CODE-2)', () => {
  async function paidThisYear(w: Awaited<ReturnType<typeof world>>) {
    // $200,000 paid on Dec 11, 2026 — past 2026's Social Security wage base.
    const prior = await prisma.payrollRun.create({
      data: { payrollScheduleId: w.schedule.id, periodStart: new Date('2026-11-21'), periodEnd: new Date('2026-12-04'), status: 'DISBURSED', disbursedAt: new Date('2026-12-11T15:00:00Z'), totalGross: 200_000, totalNet: 150_000 },
    });
    await prisma.payrollItem.create({ data: { payrollRunId: prior.id, associateId: w.ana.id, hoursWorked: 80, hourlyRate: 2500, grossPay: 200_000, federalWithholding: 0, netPay: 150_000, status: 'DISBURSED', disbursedAt: new Date('2026-12-11T15:00:00Z') } });
  }

  it('the Jan 8, 2027 check (Dec 19 – Jan 1) starts 2027’s wage bases: no 2026 wages in its YTD, Social Security withheld', async () => {
    const w = await world();
    await paidThisYear(w);
    await w.entry('2026-12-28T15:00:00Z', 8);
    const created = await w.a.post('/payroll/runs').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-12-19', periodEnd: '2027-01-01' });
    expect(created.status).toBe(201);
    const item = (created.body.items as Item[]).find((i) => i.associateId === w.ana.id)!;
    expect(item.ytdWages).toBe(0);
    expect(item.fica).toBeCloseTo(item.grossPay * 0.062, 2);
  });

  it('the Dec 24, 2026 check (Dec 5 – 18) is a 2026 check: past the base, no Social Security', async () => {
    const w = await world();
    await paidThisYear(w);
    await w.entry('2026-12-08T15:00:00Z', 8);
    const created = await w.a.post('/payroll/runs').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-12-05', periodEnd: '2026-12-18' });
    expect(created.status).toBe(201);
    const item = (created.body.items as Item[]).find((i) => i.associateId === w.ana.id)!;
    expect(item.ytdWages).toBe(200_000);
    expect(item.fica).toBe(0);
  });
});
