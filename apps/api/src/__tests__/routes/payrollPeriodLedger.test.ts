import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { ledgerForSchedules } from '../../lib/payrollPeriodLedger.js';
import { computePayrollExceptions } from '../../lib/payrollExceptions.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * System audit 2026-10-21, Tier 1 #5 / finance walk 1: paydays that passed
 * with no run. The period ledger names every scheduled period with its run
 * or none; approved time in a period nobody paid shows up as hours owed, as
 * a LATE_APPROVED_TIME exception on the next run and as an inbox count; and
 * "Pay these hours now" makes an off-cycle run that pays only those hours.
 */

const app = () => createApp();
async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}
const job = <T>(fn: () => Promise<T>) => runWithTenant(ALTO_TENANT_ID, 'job', fn);

/** Biweekly Saturday→Friday, paid the Friday after (Alto's pattern). Periods: Aug 29–Sep 11 (Sep 18), Sep 12–25 (Oct 2), Sep 26–Oct 9 (Oct 16), Oct 10–23 (Oct 30). */
async function world() {
  const client = await createClient('Harbor Inn');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { timezone: 'America/New_York', state: 'FL' } });
  const schedule = await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-08-29'), payDateOffsetDays: 7, isActive: true } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
  const ben = await createAssociate({ firstName: 'Ben', lastName: 'Ode' });
  for (const p of [ana, ben]) {
    await prisma.associate.update({ where: { id: p.id }, data: { employmentType: 'W2_EMPLOYEE', state: 'FL' } });
    await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: site.id, startedAt: new Date('2026-08-01') } });
    await prisma.payrollScheduleAssignment.create({ data: { associateId: p.id, scheduleId: schedule.id, effectiveFrom: new Date('2026-08-01'), source: 'INDIVIDUAL' } });
  }
  const entry = (associateId: string, startIso: string, hours: number) =>
    prisma.timeEntry.create({ data: { associateId, clientId: client.id, locationId: site.id, clockInAt: new Date(startIso), clockOutAt: new Date(new Date(startIso).getTime() + hours * 3_600_000), status: 'APPROVED', approvedAt: new Date() } });
  // Paid: the first period's run carries both people.
  await entry(ben.id, '2026-09-03T13:00:00Z', 8);
  const paidRun = await prisma.payrollRun.create({
    data: { payrollScheduleId: schedule.id, periodStart: new Date('2026-08-29'), periodEnd: new Date('2026-09-11'), status: 'DISBURSED', disbursedAt: new Date('2026-09-18T12:00:00Z'), totalGross: 400, totalNet: 340 },
  });
  for (const p of [ana, ben]) {
    await prisma.payrollItem.create({ data: { payrollRunId: paidRun.id, associateId: p.id, hoursWorked: 8, hourlyRate: 25, grossPay: 200, federalWithholding: 0, netPay: 170, status: 'DISBURSED' } });
  }
  // Unpaid: Ana's 6 hours on Sep 18, in a period whose payday (Oct 2) passed with no run.
  await entry(ana.id, '2026-09-18T13:00:00Z', 6);
  return { client, site, schedule, ana, ben, paidRun };
}

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the payroll period ledger', () => {
  it('names each period PAID / MISSED / DUE with the approved hours nobody paid', async () => {
    const w = await world();
    const s = await prisma.payrollSchedule.findUniqueOrThrow({ where: { id: w.schedule.id }, include: { versions: true } });
    const ledger = await job(() => ledgerForSchedules(prisma, [s], { today: '2026-10-21' }));
    const periods = ledger.schedules[0]!.periods.map((p) => ({ start: p.periodStart, pay: p.payDate, status: p.status, hours: p.unpaidHours, people: p.unpaidPeople }));
    expect(periods).toEqual([
      { start: '2026-08-29', pay: '2026-09-18', status: 'PAID', hours: 0, people: 0 },
      { start: '2026-09-12', pay: '2026-10-02', status: 'MISSED', hours: 6, people: 1 },
      { start: '2026-09-26', pay: '2026-10-16', status: 'MISSED', hours: 0, people: 0 },
      { start: '2026-10-10', pay: '2026-10-30', status: 'DUE', hours: 0, people: 0 },
    ]);
    expect(ledger.missed).toEqual({ periods: 2, hours: 6, people: 1 });
    expect(ledger.unpaid).toEqual([{ associateId: w.ana.id, name: 'Ana Reyes', scheduleId: w.schedule.id, periodStart: '2026-09-12', periodEnd: '2026-09-25', payDate: '2026-10-02', hours: 6 }]);
  });

  it('the next run carries LATE_APPROVED_TIME for those hours', async () => {
    const w = await world();
    const r = await job(() => computePayrollExceptions(prisma, { periodStart: new Date('2026-10-10T00:00:00Z'), periodEndExclusive: new Date('2026-10-24T00:00:00Z'), clientId: null, payrollScheduleId: w.schedule.id }));
    const late = r.exceptions.filter((e) => e.kind === 'LATE_APPROVED_TIME');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ associateId: w.ana.id, severity: 'WARNING', detail: { hours: 6 } });
    expect(late[0]!.message).toMatch(/6\.0h approved for 2026-09-12/);
  });

  it('GET /payroll/period-ledger, the inbox count, and "Pay these hours now" paying only the unpaid hours, once', async () => {
    const w = await world();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);

    const res = await a.get(`/payroll/period-ledger?scheduleId=${w.schedule.id}`);
    expect(res.status).toBe(200);
    expect(res.body.missed).toMatchObject({ periods: 2, hours: 6, people: 1 });

    const inbox = await a.get('/me/inbox');
    const src = (inbox.body.sources as Array<{ key: string; count: number; description: string; path: string }>).find((x) => x.key === 'payroll-missed-paydays');
    expect(src).toMatchObject({ count: 2, path: '/payroll?ledger=missed' });
    expect(src!.description).toMatch(/6h approved and unpaid for 1 person/);
    // Which paydays, not "2 paydays passed with no run" under a title that says so (F500 G5).
    expect(src!.description).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} and [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2} \(.+\) · 6h/);
    expect((src as unknown as { dueDate: string }).dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Without a schedule the off-cycle "pay the hours" run is refused: it decides whose time it is.
    const noSchedule = await a.post('/payroll/runs').send({ kind: 'OFF_CYCLE', includesApprovedTime: true, periodStart: '2026-09-12', periodEnd: '2026-09-25' });
    expect(noSchedule.status).toBe(400);

    const body = { kind: 'OFF_CYCLE', includesApprovedTime: true, payrollScheduleId: w.schedule.id, periodStart: '2026-09-12', periodEnd: '2026-09-25' };
    const preview = await a.post('/payroll/runs/preview').send(body);
    expect(preview.status).toBe(200);
    expect(preview.body.items.map((i: { associateId: string; hoursWorked: number }) => [i.associateId, i.hoursWorked])).toEqual([[w.ana.id, 6]]);

    const created = await a.post('/payroll/runs').send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'OFF_CYCLE', includesApprovedTime: true, status: 'DRAFT' });
    expect(created.body.items.map((i: { associateId: string; hoursWorked: number }) => [i.associateId, i.hoursWorked])).toEqual([[w.ana.id, 6]]);

    // The ledger now reads the period as paid off-cycle, and the hours are on a paystub once it locks.
    await prisma.payrollRun.update({ where: { id: created.body.id }, data: { status: 'FINALIZED' } });
    const after = await a.get(`/payroll/period-ledger?scheduleId=${w.schedule.id}`);
    const sep12 = after.body.schedules[0].periods.find((p: { periodStart: string }) => p.periodStart === '2026-09-12');
    expect(sep12).toMatchObject({ status: 'OFF_CYCLE', runId: created.body.id, unpaidHours: 0 });
    expect(after.body.missed).toMatchObject({ periods: 1, hours: 0 });

    // A second try finds nothing left to pay — never twice.
    const again = await a.post('/payroll/runs/preview').send(body);
    expect(again.body.items).toEqual([]);
  });

  it('the run list says what each run waits on next, and the home names the people on no schedule', async () => {
    const w = await world();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const draft = await prisma.payrollRun.create({ data: { payrollScheduleId: w.schedule.id, periodStart: new Date('2026-10-10'), periodEnd: new Date('2026-10-23'), status: 'DRAFT' } });
    const list = await a.get('/payroll/runs?status=OPEN');
    expect(list.status).toBe(200);
    expect(list.body.runs.map((r: { id: string }) => r.id)).toEqual([draft.id]);
    expect(list.body.runs[0]).toMatchObject({ payDate: '2026-10-30', nextStep: { key: 'finalize', label: 'Finalize' } });
    const all = await a.get('/payroll/runs');
    const paid = all.body.runs.find((r: { id: string }) => r.id === w.paidRun.id);
    // Paid with withholding but no deposit on record: the next step is to create it.
    expect(paid.nextStep).toMatchObject({ key: 'deposit', label: 'Create the tax deposit' });

    const cy = await createAssociate({ firstName: 'Cy', lastName: 'Unscheduled' });
    await prisma.associateAssignment.create({ data: { associateId: cy.id, locationId: w.site.id, startedAt: new Date('2026-10-01') } });
    const up = await a.get('/payroll/upcoming');
    expect(up.status).toBe(200);
    expect(up.body.peopleOnNoSchedule).toBeGreaterThanOrEqual(1);
    // One source per figure: the last run's paystub count and net come from the same paychecks.
    expect(up.body.lastRun).toMatchObject({ id: w.paidRun.id, itemCount: 2, totalNet: 340 });
  });
});

describe('payroll dollars stay with whole-company accounts', () => {
  it('a site-bound payroll account is refused runs, paychecks, paystubs and tax forms, and keeps the no-money desks', async () => {
    const w = await world();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [w.site.id] } });
    const a = await loginAs(user.email);
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: w.paidRun.id } });

    for (const path of ['/payroll/runs', `/payroll/runs/${w.paidRun.id}`, `/payroll/runs/${w.paidRun.id}/review`, `/payroll/items/${item.id}/paystub.pdf`, `/payroll/runs/${w.paidRun.id}/paystubs.zip`, '/payroll/ytd', '/payroll/upcoming', '/payroll/tax-deposits', '/tax-forms']) {
      const r = await a.get(path);
      expect([path, r.status]).toEqual([path, 403]);
      expect(r.body.error.code).toBe('whole_company_only');
    }
    const preview = await a.post('/payroll/runs/preview').send({ periodStart: '2026-09-12', periodEnd: '2026-09-25' });
    expect(preview.status).toBe(403);
    for (const path of ['/payroll/readiness', '/payroll/schedules', `/payroll/period-ledger?scheduleId=${w.schedule.id}`, '/payroll/local-tax-rules']) {
      expect([path, (await a.get(path)).status]).toEqual([path, 200]);
    }

    // The same role without a site limit reads the money.
    const { user: whole } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const b = await loginAs(whole.email);
    expect((await b.get('/payroll/runs')).status).toBe(200);
    expect((await b.get(`/payroll/runs/${w.paidRun.id}`)).body.totalNet).toBe(340);
  });
});
