import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Back pay for the evening hours the old UTC cut never paid (the owner's
 * answer to the deep audit), through the API. Chicago; Alto's biweekly
 * periods Sep 26 – Oct 9 and Oct 10 – 23 were paid by runs made under the
 * UTC cut; Oct 24 – Nov 6 is the open run.
 */

const app = () => createApp();
async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function world() {
  const client = await createClient('Lakeshore Suites');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { timezone: 'America/Chicago', state: 'IL' } });
  const schedule = await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-08-29'), payDateOffsetDays: 7, isActive: true } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
  await prisma.associate.update({ where: { id: ana.id }, data: { employmentType: 'W2_EMPLOYEE', state: 'IL' } });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date('2026-08-01') } });
  await prisma.payrollScheduleAssignment.create({ data: { associateId: ana.id, scheduleId: schedule.id, effectiveFrom: new Date('2026-08-01'), source: 'INDIVIDUAL' } });
  await prisma.compensationRecord.create({ data: { associateId: ana.id, payType: 'HOURLY', amount: 20, currency: 'USD', reason: 'HIRE', effectiveFrom: new Date('2026-01-01') } });
  const entry = (startIso: string, hours: number) =>
    prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: new Date(startIso), clockOutAt: new Date(new Date(startIso).getTime() + hours * 3_600_000), status: 'APPROVED', approvedAt: new Date() } });
  const utcRun = async (start: string, end: string, paidOn: string) => {
    const r = await prisma.payrollRun.create({ data: { payrollScheduleId: schedule.id, periodStart: new Date(start), periodEnd: new Date(end), status: 'DISBURSED', disbursedAt: new Date(paidOn), timeCut: 'UTC', totalGross: 800, totalNet: 700 } });
    await prisma.payrollItem.create({ data: { payrollRunId: r.id, associateId: ana.id, hoursWorked: 40, hourlyRate: 20, grossPay: 800, federalWithholding: 0, netPay: 700, status: 'DISBURSED', disbursedAt: new Date(paidOn) } });
    return r;
  };
  // Week Sat Oct 3 – Fri Oct 9: 40 hours paid Mon–Thu; Friday 7:30 PM CDT (00:30 UTC Saturday) was never paid.
  for (const dd of ['05', '06', '07', '08']) await entry(`2026-10-${dd}T14:00:00Z`, 10);
  const missed = await entry('2026-10-10T00:30:00Z', 6);
  // Fri Oct 23, 7:30 PM CDT: the open run's carry-in pays this one.
  const carried = await entry('2026-10-24T00:30:00Z', 5);
  const r1 = await utcRun('2026-09-26', '2026-10-09', '2026-10-16T15:00:00Z');
  const r2 = await utcRun('2026-10-10', '2026-10-23', '2026-10-30T15:00:00Z');
  const open = await prisma.payrollRun.create({ data: { payrollScheduleId: schedule.id, periodStart: new Date('2026-10-24'), periodEnd: new Date('2026-11-06'), status: 'DRAFT' } });
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const a = await loginAs(user.email);
  return { client, site, schedule, ana, missed, carried, r1, r2, open, a, user };
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('back pay: evening hours the old cut missed', () => {
  it('finds the 7:30 PM Friday punch, priced with the overtime the week crossed into — never the carried-in one', async () => {
    const w = await world();
    const r = await w.a.get('/payroll/back-pay');
    expect(r.status).toBe(200);
    expect(r.body.people).toHaveLength(1);
    const p = r.body.people[0];
    expect(p).toMatchObject({ associateId: w.ana.id, name: 'Ana Reyes', hours: 6, rates: [20], overtimeHours: 6, overtimePremium: 60, amount: 180 });
    expect(p.punches.map((x: { timeEntryId: string; workDay: string }) => [x.timeEntryId, x.workDay])).toEqual([[w.missed.id, '2026-10-09']]);
    expect(p.periods).toEqual([{ periodStart: '2026-09-26', periodEnd: '2026-10-09' }]);
    expect(p.target).toEqual({ runId: w.open.id, periodStart: '2026-10-24', periodEnd: '2026-11-06' });
    expect(r.body.total).toBe(180);
    expect(JSON.stringify(r.body)).not.toContain(w.carried.id);
  });

  it('adds it to the next regular run once — as a BACK_PAY line naming the period — and then finds nothing', async () => {
    const w = await world();
    const [x, y] = await Promise.all([
      w.a.post('/payroll/back-pay/add').set('Idempotency-Key', 'tab-1').send({}),
      w.a.post('/payroll/back-pay/add').set('Idempotency-Key', 'tab-2').send({}),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const again = await w.a.post('/payroll/back-pay/add').send({});
    expect(again.status).toBe(409);
    expect(await prisma.payrollRunAddOn.count({ where: { kind: 'BACK_PAY' } })).toBe(1);
    expect(await prisma.backPayClaim.count()).toBe(1);
    const addOn = await prisma.payrollRunAddOn.findFirstOrThrow({ where: { kind: 'BACK_PAY' } });
    expect(addOn).toMatchObject({ payrollRunId: w.open.id, associateId: w.ana.id });
    expect(Number(addOn.amount)).toBe(180);
    expect(addOn.note).toMatch(/Back pay: 6\.00h on Oct 9 .*Sep 26 – Oct 9.*\$60\.00 overtime premium/);
    // The run was re-worked: the paycheck carries the line.
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: w.open.id, associateId: w.ana.id }, include: { earnings: true } });
    expect(item.earnings.find((e) => e.kind === 'BACK_PAY')).toMatchObject({ notes: addOn.note });
    expect((await w.a.get('/payroll/back-pay')).body.people).toEqual([]);
  });

  it('says when there is no open run to add it to', async () => {
    const w = await world();
    await prisma.payrollRun.delete({ where: { id: w.open.id } });
    const r = await w.a.get('/payroll/back-pay');
    // With no open run, the carried-in evening is owed too (nothing will carry it in).
    expect(r.body.people[0].target).toBeNull();
    expect(r.body.waitingForRun).toBe(1);
    const add = await w.a.post('/payroll/back-pay/add').send({});
    expect(add.status).toBe(409);
    expect(add.body.error.code).toBe('no_open_run');
  });

  it('with a second person, it waits for them: 202, then on approval the run carries it', async () => {
    const w = await world();
    const { user: second } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const asked = await w.a.post('/payroll/back-pay/add').send({});
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ pending: true, total: 180 });
    expect(await prisma.payrollRunAddOn.count({ where: { kind: 'BACK_PAY' } })).toBe(0);
    // Held while it waits: not offered twice.
    expect((await w.a.get('/payroll/back-pay')).body.people).toEqual([]);
    const b = await loginAs(second.email);
    const decided = await b.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(decided.status).toBe(200);
    expect(await prisma.payrollRunAddOn.count({ where: { kind: 'BACK_PAY', payrollRunId: w.open.id } })).toBe(1);
    expect(await prisma.backPayClaim.findFirstOrThrow()).toMatchObject({ status: 'ADDED', payrollRunId: w.open.id });
  });

  it('a rejection lets go: the hours are offered again', async () => {
    const w = await world();
    const { user: second } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const asked = await w.a.post('/payroll/back-pay/add').send({});
    const b = await loginAs(second.email);
    const rejected = await b.post(`/approvals/requests/${asked.body.approvalId}/decide`).send({ decision: 'REJECT', reason: 'Check with the store first' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(await prisma.backPayClaim.findMany({ select: { status: true, approvalRequestId: true } })).toEqual([]);
    expect((await w.a.get('/payroll/back-pay')).body.total).toBe(180);
  });

  it('another store’s manager can neither see it nor add it', async () => {
    const w = await world();
    const south = await prisma.site.create({ data: { name: 'South Store', clientId: w.client.id, timezone: 'America/Chicago' } });
    const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [south.id] } });
    const ops = await loginAs(user.email);
    const seen = await ops.get('/payroll/back-pay');
    expect(seen.status).toBe(403);
    expect(JSON.stringify(seen.body)).not.toContain('Ana');
    expect((await ops.post('/payroll/back-pay/add').send({ associateIds: [w.ana.id] })).status).toBe(403);
    expect(await prisma.payrollRunAddOn.count()).toBe(0);
  });
});
