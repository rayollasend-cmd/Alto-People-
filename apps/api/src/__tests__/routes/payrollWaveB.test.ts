import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { ageAtYearEnd, groupTermLifeImputed, tableIRate } from '../../lib/groupTermLife.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { basesOf, type ItemBasesRow } from '../../lib/wageBases.js';
import { expireEquityGrants } from '../../lib/equityExpiry.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The rest of the payroll wave (audit 2026-10-21 + finance walk): group-term
 * life imputed income, the equity expiry job, expense reports from
 * reimbursements, the pay-change context and the mass pay change, the
 * readiness bulk request, "create the deposit", the disburse dialog's facts,
 * the Pay tab summary, the executive money band, and changes vs last run.
 */

const app = () => createApp();
async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}
const job = <T>(fn: () => Promise<T>) => runWithTenant(ALTO_TENANT_ID, 'job', fn);

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('group-term life over $50,000 (IRS Pub 15-B Table I)', () => {
  it('Table I by age band, age at year end, and the per-period cost', () => {
    expect(tableIRate(24)).toBe(0.05);
    expect(tableIRate(45)).toBe(0.15);
    expect(tableIRate(70)).toBe(2.06);
    expect(ageAtYearEnd(new Date('1981-06-01'), 2026)).toBe(45);
    expect(ageAtYearEnd(new Date('1981-12-31'), 2026)).toBe(45);
    // $150,000 at 45: 100 thousands over × $0.15 × 12 = $180 a year; biweekly = $6.92.
    expect(groupTermLifeImputed({ coverageCents: 15_000_000, dob: new Date('1981-06-01'), taxYear: 2026, periodsPerYear: 26 })).toMatchObject({ imputedIncome: 6.92, annualCost: 180, age: 45, ratePer1000Month: 0.15 });
    // At or under $50,000 nothing; an after-tax employee share comes off.
    expect(groupTermLifeImputed({ coverageCents: 5_000_000, dob: new Date('1981-06-01'), taxYear: 2026, periodsPerYear: 26 }).imputedIncome).toBe(0);
    expect(groupTermLifeImputed({ coverageCents: 15_000_000, dob: new Date('1981-06-01'), taxYear: 2026, periodsPerYear: 26, employeeAfterTaxCents: 200 }).imputedIncome).toBe(4.92);
  });

  it('a paycheck taxes the imputed cost, never pays it out, and the W-2 reports it in Box 12 C', async () => {
    const client = await createClient('TX store');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: site.id }, data: { state: 'TX', city: 'Austin', timezone: 'America/Chicago' } });
    const p = await createAssociate({ firstName: 'Lee', lastName: 'Park' });
    await prisma.associate.update({ where: { id: p.id }, data: { employmentType: 'W2_EMPLOYEE', state: 'TX', dob: new Date('1981-06-01') } });
    await prisma.w4Submission.create({ data: { associateId: p.id, filingStatus: 'SINGLE', ssnEncrypted: encryptString('123456789') } });
    const plan = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'LIFE_INSURANCE', name: 'Group life' } });
    await prisma.benefitsEnrollment.create({ data: { associateId: p.id, planId: plan.id, electedAmountCentsPerPeriod: 0, effectiveDate: new Date('2026-01-01'), lifeCoverageCents: 15_000_000 } });
    const start = new Date('2026-09-14T14:00:00Z');
    await prisma.timeEntry.create({ data: { associateId: p.id, clientId: client.id, locationId: site.id, clockInAt: start, clockOutAt: new Date(start.getTime() + 8 * 3_600_000), status: 'APPROVED', approvedAt: new Date() } });

    const r = await job(() => aggregatePayrollProjection(prisma, { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null, defaultRate: 25 }));
    const it0 = r.items.find((i) => i.associateId === p.id)!;
    const imputed = it0.earnings.find((e) => e.kind === 'IMPUTED_INCOME');
    expect(imputed?.amount).toBe(6.92);
    expect(it0.grossPay).toBe(206.92);
    // Social Security and Medicare are on the imputed cost too; the cash paid is the $200 earned less taxes.
    expect(it0.fica).toBeCloseTo(206.92 * 0.062, 1);
    expect(it0.netPay).toBeCloseTo(200 - it0.federalIncomeTax - it0.fica - it0.medicare - it0.stateIncomeTax, 2);

    const row = {
      grossPay: 206.92, preTaxDeductions: 0, preTaxRetirement: 0, federalWithholding: 0, fica: 12.83, medicare: 3, employerFica: 12.83, employerMedicare: 3, employerFuta: 1.2, employerSuta: 2, stateWithholding: 0, localWithholding: 0, taxState: 'TX',
      qualifiedTips: 0, qualifiedOvertime: 0, tippedOccupationCode: null, deferrals: null, payrollRun: { disbursedAt: new Date(), clientId: null }, deductions: [], taxLines: [],
      earnings: [{ amount: 6.92 }], associate: { state: 'TX' },
    } as unknown as ItemBasesRow;
    expect(basesOf(row).box12).toMatchObject({ C: 6.92 });
  });
});

describe('equity grants expire', () => {
  it('a grant past its expiration date reads EXPIRED; exercised and future grants stay', async () => {
    const p = await createAssociate();
    const mk = (status: 'GRANTED' | 'EXERCISED' | 'PROPOSED', expirationDate: string | null) =>
      prisma.equityGrant.create({ data: { associateId: p.id, grantType: 'ISO', status, totalShares: 100, grantDate: new Date('2020-01-01'), vestingStartDate: new Date('2020-01-01'), expirationDate: expirationDate ? new Date(expirationDate) : null } });
    const old = await mk('GRANTED', '2026-10-01');
    const done = await mk('EXERCISED', '2026-10-01');
    const future = await mk('GRANTED', '2030-01-01');
    const none = await mk('GRANTED', null);
    expect(await job(() => expireEquityGrants(prisma, new Date('2026-10-21T12:00:00Z')))).toEqual({ expired: 1 });
    const status = async (id: string) => (await prisma.equityGrant.findUniqueOrThrow({ where: { id } })).status;
    expect([await status(old.id), await status(done.id), await status(future.id), await status(none.id)]).toEqual(['EXPIRED', 'EXERCISED', 'GRANTED', 'GRANTED']);
    expect(await job(() => expireEquityGrants(prisma, new Date('2026-10-21T12:00:00Z')))).toEqual({ expired: 0 });
  });
});

describe('expense reports read reimbursements', () => {
  it('the report builder runs EXPENSE instead of answering 501', async () => {
    const p = await createAssociate({ firstName: 'Mo', lastName: 'Diaz' });
    await prisma.reimbursement.create({ data: { associateId: p.id, title: 'Mileage', totalAmount: 42.5, status: 'SUBMITTED', submittedAt: new Date() } });
    await prisma.reimbursement.create({ data: { associateId: p.id, title: 'Boots', totalAmount: 80, status: 'DRAFT' } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const rows = await a.post('/reports/preview').send({ name: 'Expenses', entity: 'EXPENSE', spec: { columns: ['title', 'amount', 'status'], sort: [{ column: 'amount', direction: 'asc' }] } });
    expect(rows.status).toBe(200);
    expect(rows.body.rows.map((r: { title: string; totalAmount: unknown }) => [r.title, Number(r.totalAmount)])).toEqual([['Mileage', 42.5], ['Boots', 80]]);
    const grouped = await a.post('/reports/preview').send({ name: 'Expenses', entity: 'EXPENSE', spec: { columns: ['status'], groupBy: ['status'], aggregates: [{ fn: 'sum', column: 'amount' }] } });
    expect(grouped.status).toBe(200);
    expect(grouped.body.rows).toHaveLength(2);
  });
});

/** A hired hourly person at a client with a rate card, on a biweekly schedule, paid through Sep 25. */
async function payWorld() {
  const client = await createClient('Harbor Inn');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { timezone: 'America/New_York', state: 'FL' } });
  const schedule = await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-08-29'), payDateOffsetDays: 7, isActive: true } });
  const people = [];
  for (const [first, rate] of [['Ana', 18], ['Ben', 20]] as const) {
    const p = await createAssociate({ firstName: first, lastName: 'Lane' });
    await prisma.associate.update({ where: { id: p.id }, data: { employmentType: 'W2_EMPLOYEE', state: 'FL' } });
    await prisma.application.create({ data: { associateId: p.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date(), startDate: new Date('2026-08-01'), position: 'Housekeeper' } });
    await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: site.id, startedAt: new Date('2026-08-01') } });
    await prisma.payrollScheduleAssignment.create({ data: { associateId: p.id, scheduleId: schedule.id, effectiveFrom: new Date('2026-08-01'), source: 'INDIVIDUAL' } });
    await prisma.compensationRecord.create({ data: { associateId: p.id, effectiveFrom: new Date('2026-08-01T00:00:00Z'), payType: 'HOURLY', amount: rate, reason: 'HIRE' } });
    people.push(p);
  }
  await prisma.shiftRateDefault.create({ data: { clientId: client.id, position: 'Housekeeper', payRate: 18, billRate: 26, effectiveFrom: new Date('2026-01-01') } });
  await prisma.compBand.create({ data: { clientId: client.id, name: 'Housekeeping', payType: 'HOURLY', minAmount: 16, midAmount: 19, maxAmount: 22 } });
  // Paid through Sep 25: Ana worked 10 hours on Oct 1? no — on Sep 22, inside the paid period.
  const [ana, ben] = people as [typeof people[number], typeof people[number]];
  await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: new Date('2026-09-22T13:00:00Z'), clockOutAt: new Date('2026-09-22T23:00:00Z'), status: 'APPROVED', approvedAt: new Date() } });
  const run = await prisma.payrollRun.create({ data: { payrollScheduleId: schedule.id, periodStart: new Date('2026-09-12'), periodEnd: new Date('2026-09-25'), status: 'DISBURSED', disbursedAt: new Date('2026-10-02T12:00:00Z'), kind: 'REGULAR' } });
  await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: ana.id, hoursWorked: 10, hourlyRate: 18, grossPay: 180, federalWithholding: 10, fica: 11.16, medicare: 2.61, employerFica: 11.16, employerMedicare: 2.61, netPay: 156.23, status: 'DISBURSED', disbursedAt: new Date('2026-10-02T12:00:00Z') } });
  await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: ben.id, hoursWorked: 8, hourlyRate: 20, grossPay: 160, federalWithholding: 8, fica: 9.92, medicare: 2.32, employerFica: 9.92, employerMedicare: 2.32, netPay: 139.76, status: 'DISBURSED', disbursedAt: new Date('2026-10-02T12:00:00Z') } });
  return { client, site, schedule, ana, ben, run };
}

describe('a pay change with its context, and a mass pay change', () => {
  it('shows the band, the bill rate, the margin before and after, where it lands and the back pay', async () => {
    const w = await payWorld();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const r = await a.get(`/comp/associates/${w.ana.id}/pay-change-context?payType=HOURLY&amount=19.5&effectiveFrom=2026-09-20`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      current: { payType: 'HOURLY', amount: 18 },
      deltaPct: 8.3,
      billRate: 26,
      client: { name: 'Harbor Inn' },
      position: 'Housekeeper',
      band: { name: 'Housekeeping', min: 16, max: 22, currentPct: 33.3, proposedPct: 58.3 },
      // The first period from Sep 20 nobody paid: Sep 26 – Oct 9, paid Oct 16.
      landsIn: { scheduleName: 'Biweekly', periodStart: '2026-09-26', periodEnd: '2026-10-09', payDate: '2026-10-16' },
      // Sep 22's 10 hours were paid at $18: $1.50 × 10 back pay.
      backPay: { from: '2026-09-20', through: '2026-09-25', hours: 10, amount: 15 },
    });
    // Margin per hour: 26 − pay × (1 + burden).
    const burden = 1 + r.body.burdenPct / 100;
    expect(r.body.marginBefore).toBeCloseTo(26 - 18 * burden, 2);
    expect(r.body.marginAfter).toBeCloseTo(26 - 19.5 * burden, 2);
  });

  it('a mass pay change previews each person and goes to a second person as ONE approval', async () => {
    const w = await payWorld();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: second } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const body = { filter: { clientIds: [w.client.id] }, mode: 'ADD', value: 1, effectiveFrom: '2026-10-24', reason: 'MARKET_ADJUSTMENT' };
    const preview = await a.post('/comp/batch/preview').send(body);
    expect(preview.status).toBe(200);
    expect(preview.body.willChange).toBe(2);
    expect(preview.body.rows.map((r: { name: string; from: number; to: number }) => [r.name, r.from, r.to]).sort()).toEqual([['Ana Lane', 18, 19], ['Ben Lane', 20, 21]]);

    const sent = await a.post('/comp/batch').send(body);
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ pending: true, people: 2 });
    // Nothing changed yet.
    expect((await prisma.compensationRecord.findFirstOrThrow({ where: { associateId: w.ana.id, effectiveTo: null } })).amount.toString()).toBe('18');
    const b = await loginAs(second.email);
    const ok = await b.post(`/approvals/requests/${sent.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(ok.status).toBe(200);
    expect(Number((await prisma.compensationRecord.findFirstOrThrow({ where: { associateId: w.ana.id, effectiveTo: null } })).amount)).toBe(19);
    expect(Number((await prisma.compensationRecord.findFirstOrThrow({ where: { associateId: w.ben.id, effectiveTo: null } })).amount)).toBe(21);
  });
});

describe('payroll desks', () => {
  it('readiness: ask everyone at once, and the grid says when', async () => {
    const p = await createAssociate({ firstName: 'Ray', lastName: 'Shaw' });
    await prisma.associate.update({ where: { id: p.id }, data: { employmentType: 'W2_EMPLOYEE' } });
    const { user: personUser } = await createUser({ role: 'ASSOCIATE', associateId: p.id });
    const noLogin = await createAssociate({ firstName: 'No', lastName: 'Login' });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const r = await a.post('/payroll/readiness/request').send({ associateIds: [p.id, noLogin.id], items: ['w4', 'payout'] });
    expect(r.status).toBe(200);
    expect(r.body.requested).toBe(1);
    expect(r.body.skipped).toEqual([{ associateId: noLogin.id, reason: 'No sign-in yet — invite them first.' }]);
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: personUser.id, channel: 'IN_APP' } });
    expect(bell?.body).toMatch(/your W-4.*and where to send your pay/);
    const grid = await a.get('/payroll/readiness');
    const row = grid.body.rows.find((x: { associateId: string }) => x.associateId === p.id);
    expect(row.requested).toMatchObject({ items: ['w4', 'payout'] });
  });

  it('a paid run with withholding and no deposit: create the deposit, then it is there', async () => {
    const w = await payWorld();
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const close = await a.get(`/payroll/runs/${w.run.id}/close`);
    expect(close.body.deposit).toBeNull();
    const made = await a.post(`/payroll/runs/${w.run.id}/tax-deposit`).send({});
    expect(made.status).toBe(201);
    // FIT 18 + SS 21.08×2 + Medicare 4.93×2.
    expect(made.body).toMatchObject({ created: true, deposit: { status: 'PENDING', amount: 70.02 } });
    expect(made.body.deposit.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const again = await a.post(`/payroll/runs/${w.run.id}/tax-deposit`).send({});
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    const paid = await a.post(`/payroll/tax-deposits/${made.body.deposit.id}/mark-paid`).send({ confirmationNumber: '270012345678901' });
    expect(paid.status).toBe(200);
  });

  it('the disburse dialog reads the provider, the split by method and the next step; an erroring provider blocks', async () => {
    const w = await payWorld();
    const run = await prisma.payrollRun.create({ data: { payrollScheduleId: w.schedule.id, periodStart: new Date('2026-09-26'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED', kind: 'REGULAR' } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: w.ana.id, hoursWorked: 8, hourlyRate: 18, grossPay: 144, federalWithholding: 0, netPay: 130 } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: w.ben.id, hoursWorked: 8, hourlyRate: 20, grossPay: 160, federalWithholding: 0, netPay: 150 } });
    await prisma.payoutMethod.create({ data: { associateId: w.ana.id, type: 'BANK_ACCOUNT', accountNumberEnc: encryptString('123456789'), routingNumberEnc: Buffer.from('011000015'), isPrimary: true, verifiedAt: new Date() } });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const r = await a.get(`/payroll/runs/${run.id}/disburse-preview`);
    expect(r.status).toBe(200);
    expect(r.body.split).toEqual([
      { method: 'DIRECT_DEPOSIT', count: 1, amount: 130 },
      { method: 'NONE', count: 1, amount: 150 },
    ]);
    expect(r.body.provider.blocked).toBe(false);
    expect(r.body.nextStep).toBeTruthy();

    await prisma.providerConnection.create({
      data: { kind: 'PAYOUT', provider: 'WISE', name: 'Wise', environment: 'PRODUCTION', active: true, credentialsEnc: encryptString(JSON.stringify({ apiKey: 'k' })), settings: {}, lastSuccessAt: new Date('2026-10-10T00:00:00Z'), lastErrorAt: new Date('2026-10-17T00:00:00Z'), lastError: '401 Unauthorized' },
    });
    const bad = await a.get(`/payroll/runs/${run.id}/disburse-preview`);
    expect(bad.body.provider).toMatchObject({ health: 'erroring', blocked: true });
    expect(bad.body.provider.detail).toMatch(/401 Unauthorized/);
  });

  it('the Pay tab for in-house payroll: schedule, pay account, last paystubs and year to date', async () => {
    const w = await payWorld();
    await prisma.externalPayment.create({ data: { associateId: w.ana.id, periodStart: new Date('2026-07-01'), periodEnd: new Date('2026-07-14'), grossAmount: 300 } });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const r = await a.get(`/payroll/associates/${w.ana.id}/pay-summary`);
    expect(r.status).toBe(200);
    expect(r.body.paystubs).toHaveLength(1);
    expect(r.body.paystubs[0]).toMatchObject({ periodStart: '2026-09-12', gross: 180, net: 156.23 });
    expect(r.body.ytd).toMatchObject({ paystubs: 1, gross: 180, net: 156.23, federalWithholding: 10 });
    expect(r.body.payAccount).toMatchObject({ rail: 'NONE' });
    expect(r.body.externalPayments).toBe(1);
    expect(r.body.schedule?.current?.name).toBe('Biweekly');
  });

  it('the executive money band reads the payroll record, not estimates', async () => {
    const w = await payWorld();
    const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const a = await loginAs(user.email);
    const r = await a.get('/executive/money');
    expect(r.status).toBe(200);
    expect(r.body.payrollRuns).toEqual([
      expect.objectContaining({ runId: w.run.id, people: 2, gross: 340, employerTaxes: 26.01, cost: 366.01, costPerPerson: 183.01 }),
    ]);
    expect(r.body.dso).toHaveLength(6);
    expect(r.body).toHaveProperty('cash');
    expect(r.body).toHaveProperty('lowPoint');
  });

  it('the run preview compares against the last regular run before the run exists', async () => {
    const w = await payWorld();
    // Ana works 30 hours in the next period; Ben does not work; Cy is new.
    const cy = await createAssociate({ firstName: 'Cy', lastName: 'New' });
    await prisma.associate.update({ where: { id: cy.id }, data: { employmentType: 'W2_EMPLOYEE', state: 'FL' } });
    await prisma.payrollScheduleAssignment.create({ data: { associateId: cy.id, scheduleId: w.schedule.id, effectiveFrom: new Date('2026-09-01'), source: 'INDIVIDUAL' } });
    for (const [id, hours] of [[w.ana.id, 30], [cy.id, 4]] as const) {
      await prisma.timeEntry.create({ data: { associateId: id, clientId: w.client.id, locationId: w.site.id, clockInAt: new Date('2026-09-29T12:00:00Z'), clockOutAt: new Date(new Date('2026-09-29T12:00:00Z').getTime() + hours * 3_600_000), status: 'APPROVED', approvedAt: new Date() } });
    }
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const r = await a.post('/payroll/runs/preview').send({ payrollScheduleId: w.schedule.id, periodStart: '2026-09-26', periodEnd: '2026-10-09' });
    expect(r.status).toBe(200);
    expect(r.body.previous).toMatchObject({ runId: w.run.id, people: 2, gross: 340 });
    expect(r.body.previous.missing.map((m: { associateName: string }) => m.associateName)).toEqual(['Ben Lane']);
    expect(r.body.previous.newPeople.map((m: { associateName: string }) => m.associateName)).toEqual(['Cy New']);
    expect(r.body.previous.moved.map((m: { associateName: string }) => m.associateName)).toEqual(['Ana Lane']);
  });
});

describe('pay and bill: billed, not paid', () => {
  it('names hours a final statement billed that no paystub paid, by person and week', async () => {
    const w = await payWorld();
    // Ben worked Oct 1 (in Sep 26 – Oct 9, no run yet); the client was billed for it.
    await prisma.timeEntry.create({ data: { associateId: w.ben.id, clientId: w.client.id, locationId: w.site.id, clockInAt: new Date('2026-10-01T13:00:00Z'), clockOutAt: new Date('2026-10-01T21:00:00Z'), status: 'APPROVED', approvedAt: new Date() } });
    await prisma.clientStatement.create({ data: { clientId: w.client.id, periodStart: new Date('2026-09-20'), periodEnd: new Date('2026-10-03'), status: 'FINAL', finalizedAt: new Date('2026-10-04T12:00:00Z'), number: 7, snapshot: { totals: { hours: 18, amount: 468 } } } });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(user.email);
    const r = await a.get('/pay-bill/reconciliation?periodStart=2026-09-12&periodEnd=2026-10-09');
    expect(r.status).toBe(200);
    // Ana's Sep 22 hours were paid; Ben's Oct 1 hours were billed and not paid.
    expect(r.body.billedNotPaid).toEqual([expect.objectContaining({ associateId: w.ben.id, clientName: 'Harbor Inn', hours: 8, statementNumber: 7 })]);
    expect(r.body.billedNotPaidHours).toBe(8);
  });
});
