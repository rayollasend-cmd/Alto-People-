import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { aggregateW2Wages } from '../../lib/w2Aggregator.js';
import { computePayrollExceptions } from '../../lib/payrollExceptions.js';
import { buildPaystubDataById } from '../../lib/paystubData.js';
import { registerNewHireProvider, unregisterNewHireProvider, type NewHireRecord } from '../../lib/newHireReporting.js';
import { encryptString } from '../../lib/crypto.js';
import { ATTESTATION_TEXT } from '../../lib/laborRules/live.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * 2026 payroll compliance against the database: the W-2's TP / TT / TA and
 * box 14b from the pay calculation through the W-2, the SECURE 2.0 Roth
 * catch-up in a real check, state pay notices signed by the worker, new-hire
 * reports per state, and the CA paystub check before a run.
 */

const app = () => createApp();

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

async function personAt(state: string, opts: { first?: string; dob?: Date; hourly?: number } = {}) {
  const client = await createClient(`${state} store`);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { state, city: 'Town', timezone: 'America/Chicago' } });
  const a = await createAssociate({ firstName: opts.first ?? 'Ana', lastName: 'Ruiz' });
  await prisma.associate.update({ where: { id: a.id }, data: { state, dob: opts.dob ?? null } });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-01-02') } });
  if (opts.hourly) {
    await prisma.compensationRecord.create({ data: { associateId: a.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: opts.hourly, reason: 'HIRE' } });
  }
  return { client, site, a };
}

const day = (d: string, startH: number, hours: number) => ({ clockInAt: new Date(`${d}T${String(startH).padStart(2, '0')}:00:00Z`), clockOutAt: new Date(new Date(`${d}T${String(startH).padStart(2, '0')}:00:00Z`).getTime() + hours * 3_600_000) });

describe('W-2 2026: qualified overtime (TT) and tips (TP) per check', () => {
  it('TT is half the rate on FLSA weekly overtime only; tips are TP with the job’s occupation code', async () => {
    const { client, site, a } = await personAt('TX');
    const jp = await prisma.jobProfile.create({ data: { clientId: client.id, code: 'BAR', title: 'Bartender', tippedOccupationCode: '101' } });
    await prisma.associate.update({ where: { id: a.id }, data: { jobProfileId: jp.id } });
    // Mon–Fri 9 hours: 45 in the week, 5 over 40.
    for (const d of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) {
      await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, locationId: site.id, ...day(d, 14, 9), status: 'APPROVED', approvedAt: new Date() } });
    }
    const pool = await prisma.tipPool.create({ data: { clientId: client.id, name: 'Bar', shiftDate: new Date('2026-09-15'), totalAmount: 240, status: 'CLOSED', closedAt: new Date() } });
    await prisma.tipPoolAllocation.create({ data: { tipPoolId: pool.id, associateId: a.id, amount: 240 } });

    const r = await aggregatePayrollProjection(prisma, { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null, defaultRate: 20 });
    const it0 = r.items.find((i) => i.associateId === a.id)!;
    expect(it0.overtimeHours).toBe(5);
    expect(it0.qualifiedOvertime).toBe(50); // 0.5 × $20 × 5
    expect(it0.qualifiedTips).toBe(240);
    expect(it0.tippedOccupationCode).toBe('101');
  });

  it('California’s daily overtime is not qualified overtime: a 10-hour day pays 2 OT hours and TT stays 0', async () => {
    const { client, site, a } = await personAt('CA');
    await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, locationId: site.id, clockInAt: new Date('2026-09-14T15:00:00Z'), clockOutAt: new Date('2026-09-15T01:00:00Z'), status: 'APPROVED', approvedAt: new Date() } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(hr.email);
    const live = await h.post('/labor-rules/activations').send({ jurisdiction: 'US-CA', counselName: 'Dana Whit', counselFirm: 'Whit & Co LLP', counselSignedOn: '2026-10-01', attestation: ATTESTATION_TEXT });
    expect(live.status).toBe(201);
    const r = await aggregatePayrollProjection(prisma, { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null, defaultRate: 20 });
    const it0 = r.items.find((i) => i.associateId === a.id)!;
    expect(it0.overtimeHours).toBe(2);
    expect(it0.qualifiedOvertime).toBe(0);
  });
});

describe('SECURE 2.0 Roth catch-up in a real check', () => {
  it('a 55-year-old with $200k last year near the 402(g) limit gets the catch-up as Roth, after tax', async () => {
    const { client, site, a } = await personAt('TX', { dob: new Date('1971-03-01T00:00:00Z') });
    // Last year's wages: one disbursed 2025 check of $200,000.
    const lastYear = await prisma.payrollRun.create({ data: { periodStart: new Date('2025-12-01'), periodEnd: new Date('2025-12-14'), status: 'DISBURSED', disbursedAt: new Date('2025-12-19T12:00:00Z') } });
    await prisma.payrollItem.create({ data: { payrollRunId: lastYear.id, associateId: a.id, hoursWorked: 0, hourlyRate: 0, grossPay: 200_000, federalWithholding: 0, netPay: 200_000, status: 'DISBURSED' } });
    // This year: $24,000 already deferred.
    const earlier = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-14'), status: 'DISBURSED', disbursedAt: new Date('2026-08-21T12:00:00Z') } });
    await prisma.payrollItem.create({ data: { payrollRunId: earlier.id, associateId: a.id, hoursWorked: 0, hourlyRate: 0, grossPay: 30_000, federalWithholding: 0, netPay: 6_000, preTaxDeductions: 24_000, preTaxRetirement: 24_000, status: 'DISBURSED' } });
    const plan = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'RETIREMENT_401K', name: 'Fidelity 401(k)' } });
    await prisma.benefitsEnrollment.create({ data: { associateId: a.id, planId: plan.id, electedAmountCentsPerPeriod: 100_000, effectiveDate: new Date('2026-01-01') } });
    await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, locationId: site.id, ...day('2026-09-14', 14, 8), status: 'APPROVED', approvedAt: new Date() } });

    const r = await aggregatePayrollProjection(prisma, { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null, defaultRate: 200 });
    const it0 = r.items.find((i) => i.associateId === a.id)!;
    expect(it0.deferrals).toMatchObject({ pre401k: 500, roth401k: 500, catchUp: 500, catchUpRoth: 500, highEarner: true });
    expect(it0.rothDeferral).toBe(500);
    expect(it0.preTaxRetirement).toBe(500);

    // The compliance page says the same.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(hr.email);
    const roth = await h.get('/pay-compliance/roth-catch-up?year=2026');
    expect(roth.status).toBe(200);
    expect(roth.body.people[0]).toMatchObject({ associateId: a.id, status: 'ROTH_DEEMED', higherEarner: true, priorYearFicaWages: 200_000 });
    const person = await h.get(`/pay-compliance/people/${a.id}/roth-catch-up`);
    expect(person.body.plans[0].status).toBe('ROTH_DEEMED');

    // A plan with no deemed Roth stops it, and the pre-run check says so.
    await prisma.benefitsPlan.update({ where: { id: plan.id }, data: { allowsDeemedRoth: false } });
    const ex = await computePayrollExceptions(prisma, { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null });
    expect(ex.exceptions.find((e) => e.kind === 'ROTH_CATCH_UP')).toMatchObject({ associateId: a.id, severity: 'WARNING' });
  });
});

describe('the W-2 carries boxes 7, 10, 12 and 14b', () => {
  it('splits tips into box 7, lists the codes in order and the occupation code', async () => {
    const { a } = await personAt('TX');
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-03-01'), periodEnd: new Date('2026-03-14'), status: 'DISBURSED', disbursedAt: new Date('2026-03-20T12:00:00Z') } });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: run.id,
        associateId: a.id,
        hoursWorked: 80,
        hourlyRate: 20,
        grossPay: 2_000,
        federalWithholding: 100,
        netPay: 1_500,
        preTaxDeductions: 300,
        preTaxRetirement: 200,
        qualifiedTips: 400,
        qualifiedOvertime: 60,
        tippedOccupationCode: '101',
        deferrals: { pre401k: 200, hsa: 50, dcap: 50, roth401k: 75, trumpAccountEmployer: 25 },
        status: 'DISBURSED',
      },
    });
    const b = await aggregateW2Wages(prisma, a.id, 2026);
    expect(b.box1Wages).toBe(1_700);
    expect(b.box3SsWages).toBe(1_500); // 2,000 − 100 §125 − 400 tips
    expect(b.box7SsTips).toBe(400);
    expect(b.box10DependentCare).toBe(50);
    expect(b.box12).toEqual([
      { code: 'D', amount: 200 },
      { code: 'W', amount: 50 },
      { code: 'AA', amount: 75 },
      { code: 'TA', amount: 25 },
      { code: 'TP', amount: 400 },
      { code: 'TT', amount: 60 },
    ]);
    expect(b.box14bTippedOccupationCodes).toEqual(['101']);
  });
});

describe('the paystub', () => {
  it('shows deferral lines, the TP/TT amounts for the record, total hours and the sick balance', async () => {
    const { a } = await personAt('CA');
    await prisma.timeOffBalance.create({ data: { associateId: a.id, category: 'SICK', balanceMinutes: 750 } });
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-03-01'), periodEnd: new Date('2026-03-14'), status: 'DISBURSED', disbursedAt: new Date('2026-03-20T12:00:00Z') } });
    const item = await prisma.payrollItem.create({
      data: { payrollRunId: run.id, associateId: a.id, hoursWorked: 82, hourlyRate: 20, grossPay: 1_700, federalWithholding: 100, netPay: 1_200, preTaxDeductions: 150, preTaxRetirement: 100, postTaxDeductions: 50, qualifiedTips: 0, qualifiedOvertime: 20, deferrals: { pre401k: 100, roth401k: 50, catchUpRoth: 50, highEarner: true }, status: 'DISBURSED' },
    });
    const built = await buildPaystubDataById(prisma, item.id);
    const d = built!.data;
    expect(d.preTaxDeductions.map((l) => l.label)).toEqual(['401(k)', 'Health & benefits']);
    expect(d.postTaxDeductions.map((l) => [l.label, l.current])).toEqual([['Roth 401(k)', 50]]);
    expect(d.informational).toEqual([{ label: 'Qualified overtime premium (W-2 box 12 TT)', current: 20, ytd: 20 }]);
    expect(d.hoursTotal).toBe(82);
    expect(d.sickLeave).toEqual({ availableHours: 12.5 });
    expect(d.notes?.[0]).toMatch(/taken as Roth/);
  });
});

describe('pay notices (NY Labor Law §195)', () => {
  it('HR issues an LS 54 in the worker’s language; the worker signs; the hash is kept; Inbox counts clear', async () => {
    const { a } = await personAt('NY', { hourly: 18 });
    const { user: worker } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    await prisma.user.update({ where: { id: worker.id }, data: { language: 'es' } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(hr.email);

    const issued = await h.post('/pay-compliance/pay-notices').send({ associateId: a.id });
    expect(issued.status).toBe(201);
    expect(issued.body.notice).toMatchObject({ form: 'NY_LS54', language: 'es', state: 'NY', status: 'SENT' });
    expect(issued.body.notice.missing).toContain('Employer phone');

    const w = await loginAs(worker.email);
    const inbox = await w.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'my-pay-notices')?.count).toBe(1);
    const mine = await w.get(`/me/pay-notices/${issued.body.notice.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.sections.map((s: { language: string }) => s.language)).toEqual(['es', 'en']);
    expect(mine.body.sections[0].lines.find((l: { label: string }) => l.label === 'Tarifa de pago').value).toBe('$18.00 por hora');
    expect((await w.post(`/me/pay-notices/${issued.body.notice.id}/acknowledge`).send({ signedName: 'A' })).status).toBe(400);
    const signed = await w.post(`/me/pay-notices/${issued.body.notice.id}/acknowledge`).send({ signedName: 'Ana Ruiz' });
    expect(signed.status).toBe(200);
    expect(signed.body.notice.status).toBe('ACKNOWLEDGED');
    const row = await prisma.wagePayNotice.findUniqueOrThrow({ where: { id: issued.body.notice.id } });
    expect(row.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.signedName).toBe('Ana Ruiz');
    expect((await w.get(`/me/pay-notices/${issued.body.notice.id}/pdf`)).headers['content-type']).toMatch(/pdf/);
    // Someone else's notice is not theirs to read.
    const other = await createAssociate();
    const { user: otherUser } = await createUser({ role: 'ASSOCIATE', associateId: other.id });
    expect((await (await loginAs(otherUser.email)).get(`/me/pay-notices/${issued.body.notice.id}`)).status).toBe(404);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'pay_notice.acknowledged' } })).toBe(1);
  });

  it('a rate change in New York issues a notice by itself; Texas has no rule', async () => {
    const { a } = await personAt('NY', { hourly: 18 });
    const tx = await personAt('TX', { first: 'Tex', hourly: 15 });
    const { applyPayRateChange } = await import('../../lib/payChanges.js');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await applyPayRateChange(prisma, { associateId: a.id, effectiveFrom: new Date('2026-10-01T00:00:00Z'), payType: 'HOURLY', amount: 19.5, reason: 'MERIT', actorUserId: hr.id });
    await applyPayRateChange(prisma, { associateId: tx.a.id, effectiveFrom: new Date('2026-10-01T00:00:00Z'), payType: 'HOURLY', amount: 16, reason: 'MERIT', actorUserId: hr.id });
    await new Promise((r) => setTimeout(r, 300));
    const ny = await prisma.wagePayNotice.findMany({ where: { associateId: a.id } });
    expect(ny).toHaveLength(1);
    expect(ny[0]).toMatchObject({ trigger: 'RATE_CHANGE', form: 'NY_LS54' });
    expect((ny[0]!.facts as { rate: number }).rate).toBe(19.5);
    expect(await prisma.wagePayNotice.count({ where: { associateId: tx.a.id } })).toBe(0);
  });
});

describe('new-hire reporting per state', () => {
  it('opens a report per hire with the state’s deadline, files through a service or by download, and marks the person', async () => {
    const { a } = await personAt('ME');
    await prisma.associate.update({ where: { id: a.id }, data: { hireDate: new Date(Date.now() - 3 * 86_400_000), addressLine1: '2 Elm', city: 'Portland', zip: '04101' } });
    await prisma.w4Submission.create({ data: { associateId: a.id, filingStatus: 'SINGLE', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, ssnEncrypted: encryptString('123-45-6789') } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(hr.email);

    let list = await h.get('/pay-compliance/new-hire-reports');
    expect(list.status).toBe(200);
    expect(list.body.reports).toHaveLength(1);
    expect(list.body.reports[0]).toMatchObject({ state: 'ME', deadlineDays: 7, confirmDeadlineWithState: true, status: 'DUE' });
    // The employer has no EIN or address yet.
    expect(list.body.reports[0].blockedBy).toEqual(expect.arrayContaining(['Employer EIN missing']));
    await prisma.employerOrganization.updateMany({ data: { ein: '12-3456789', addressLine1: '1 Main', city: 'Portland', state: 'ME', zip: '04101' } });

    const inbox = await h.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'new-hire-reports')?.count).toBe(1);

    const csv = await h.get('/pay-compliance/new-hire-reports/file.csv?state=ME');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('123456789,Ana,Ruiz');
    const ids = String(csv.headers['x-report-ids']).split(',');
    expect(ids).toHaveLength(1);

    // A filing service for Maine files it instead.
    const filed: NewHireRecord[] = [];
    registerNewHireProvider({ key: 'mock', label: 'Mock filer', states: ['ME'], submit: async (_s, recs) => { filed.push(...recs); return { confirmation: 'ME-0001' }; } });
    try {
      const f = await h.post('/pay-compliance/new-hire-reports/file').send({ state: 'ME' });
      expect(f.status).toBe(200);
      expect(f.body).toMatchObject({ filed: 1, confirmation: 'ME-0001' });
      expect(filed[0]!.ssn).toBe('123456789');
    } finally {
      unregisterNewHireProvider('mock');
    }
    list = await h.get('/pay-compliance/new-hire-reports');
    expect(list.body.reports[0]).toMatchObject({ status: 'SUBMITTED', method: 'PROVIDER', confirmation: 'ME-0001' });
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: a.id } })).newHireReportedAt).not.toBeNull();
  });

  it('a multistate employer reports everyone to one state; only payroll PII exporters download SSNs', async () => {
    const { a } = await personAt('NY');
    await prisma.associate.update({ where: { id: a.id }, data: { hireDate: new Date() } });
    await prisma.orgSetting.create({ data: {} }).catch(() => undefined);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(hr.email);
    expect((await h.put('/pay-compliance/new-hire-settings').send({ multistateState: 'fl' })).body).toEqual({ multistateState: 'FL' });
    const list = await h.get('/pay-compliance/new-hire-reports');
    expect(list.body.reports[0].state).toBe('FL');
    const submit = await h.post('/pay-compliance/new-hire-reports/submit').send({ reportIds: [list.body.reports[0].id], confirmation: 'FL-77' });
    expect(submit.body.marked).toBe(1);

    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    expect((await (await loginAs(ops.email)).get('/pay-compliance/new-hire-reports/file.csv?state=FL')).status).toBe(403);
  });
});

describe('the CA paystub check before a run', () => {
  it('warns when the employer address or the sick leave balance is missing', async () => {
    const { client, site, a } = await personAt('CA', { hourly: 20 });
    await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, locationId: site.id, ...day('2026-09-14', 15, 6), status: 'APPROVED', approvedAt: new Date() } });
    const period = { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null };
    let ex = await computePayrollExceptions(prisma, period);
    const w = ex.exceptions.find((e) => e.kind === 'WAGE_STATEMENT_INCOMPLETE')!;
    expect(w.severity).toBe('WARNING');
    expect(w.detail).toMatchObject({ state: 'CA', missing: ['EMPLOYER_ADDRESS', 'SICK_LEAVE_BALANCE'] });

    await prisma.employerOrganization.updateMany({ data: { addressLine1: '1 Main', city: 'Oakland', state: 'CA', zip: '94601' } });
    await prisma.timeOffBalance.create({ data: { associateId: a.id, category: 'SICK', balanceMinutes: 0 } });
    ex = await computePayrollExceptions(prisma, period);
    expect(ex.exceptions.some((e) => e.kind === 'WAGE_STATEMENT_INCOMPLETE')).toBe(false);
  });
});
