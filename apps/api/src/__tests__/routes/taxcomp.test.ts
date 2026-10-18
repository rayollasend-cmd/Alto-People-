import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { hashPassword } from '../../lib/passwords.js';
import { computePayrollExceptions } from '../../lib/payrollExceptions.js';
import { __resetStateAcknowledgmentsForTesting } from '../../lib/payrollTax.js';
import { __resetAcaMemoForTesting } from '../../routes/aca.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * TAXCOMP: the added states block payroll until reviewed; WOTC from the
 * applicant's answers to the filed, certified credit; ACA measurement to the
 * offer and the 1095-C months.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  __resetStateAcknowledgmentsForTesting();
  __resetAcaMemoForTesting();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function shift(associateId: string, clientId: string, at: Date, hours: number) {
  await prisma.timeEntry.create({
    data: { associateId, clientId, clockInAt: at, clockOutAt: new Date(at.getTime() + hours * 3_600_000), status: 'APPROVED', approvedAt: new Date() },
  });
}

describe('state withholding coverage', () => {
  it('an added state blocks payroll until a payroll admin records the review', async () => {
    const client = await createClient('Dover Co');
    const a = await createAssociate({ firstName: 'Del', lastName: 'Ware' });
    await prisma.associate.update({ where: { id: a.id }, data: { state: 'DE', employmentType: 'W2_EMPLOYEE' } });
    await prisma.w4Submission.create({ data: { associateId: a.id, filingStatus: 'SINGLE', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 } });
    const start = new Date('2026-04-06T13:00:00Z');
    await shift(a.id, client.id, start, 8);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const h = await loginAs(hr.email);

    const before = await computePayrollExceptions(prisma, { periodStart: new Date('2026-04-04'), periodEndExclusive: new Date('2026-04-18'), clientId: null });
    const block = before.exceptions.find((e) => e.kind === 'UNSUPPORTED_STATE');
    expect(block?.severity).toBe('BLOCKING');
    expect(block?.message).toMatch(/Delaware withholding \(2025 tables\) hasn’t been reviewed/);

    const cov = await h.get('/payroll/state-tax/coverage');
    expect(cov.status).toBe(200);
    const de = cov.body.states.find((s: { state: string }) => s.state === 'DE');
    expect(de).toMatchObject({ coverage: 'awaiting_review', people: 1, taxYear: 2025 });
    expect(cov.body.states.find((s: { state: string }) => s.state === 'FL').coverage).toBe('verified');

    expect((await h.post('/payroll/state-tax/DE/acknowledge').send({})).status).toBe(400);
    expect((await h.post('/payroll/state-tax/FL/acknowledge').send({ confirm: true })).status).toBe(409);
    const ack = await h.post('/payroll/state-tax/DE/acknowledge').send({ confirm: true, note: 'Checked with our CPA' });
    expect(ack.status).toBe(200);

    const after = await computePayrollExceptions(prisma, { periodStart: new Date('2026-04-04'), periodEndExclusive: new Date('2026-04-18'), clientId: null });
    expect(after.exceptions.find((e) => e.kind === 'UNSUPPORTED_STATE')).toBeUndefined();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'payroll.state_tax_acknowledged' } });
    expect(audit).not.toBeNull();

    const calc = await h.get('/payroll/state-tax/calculate').query({ state: 'DE', wages: 40_000 / 26, frequency: 'BIWEEKLY', allowances: 1 });
    expect(calc.body.perPeriod).toBeCloseTo(1_543.13 / 26, 1);

    expect((await h.delete('/payroll/state-tax/DE/acknowledge')).status).toBe(204);
    const again = await computePayrollExceptions(prisma, { periodStart: new Date('2026-04-04'), periodEndExclusive: new Date('2026-04-18'), clientId: null });
    expect(again.exceptions.some((e) => e.kind === 'UNSUPPORTED_STATE')).toBe(true);
  });

  it('state certificates: HR and the worker save them; Maryland wants a county from the list', async () => {
    const a = await createAssociate({ firstName: 'Mary', lastName: 'Land' });
    await prisma.associate.update({ where: { id: a.id }, data: { state: 'MD' } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { user: me } = await createUser({ role: 'ASSOCIATE', associateId: a.id, email: 'mary@example.com' });
    const h = await loginAs(hr.email);
    expect((await h.put(`/payroll/state-w4/${a.id}`).send({ state: 'MD', filingStatus: 'SINGLE', allowances: 1, county: 'Atlantis' })).status).toBe(400);
    const saved = await h.put(`/payroll/state-w4/${a.id}`).send({ state: 'MD', filingStatus: 'SINGLE', allowances: 1, county: 'Montgomery' });
    expect(saved.body.certificate).toMatchObject({ state: 'MD', form: 'MW507', county: 'MONTGOMERY', allowances: 1 });

    const m = await loginAs(me.email);
    const mine = await m.get('/me/state-w4');
    expect(mine.body).toMatchObject({ workState: 'MD', needed: { state: 'MD', form: 'MW507' } });
    expect((await m.put('/me/state-w4').send({ state: 'MD', filingStatus: 'MARRIED', allowances: 2, county: 'Howard' })).status).toBe(200);
    expect((await m.get(`/payroll/state-w4/${a.id}`)).status).toBe(403);
  });
});

describe('WOTC', () => {
  async function applicant() {
    const client = await createClient('Seaside Co');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const a = await createAssociate({ firstName: 'Val', lastName: 'Vet' });
    await prisma.associate.update({ where: { id: a.id }, data: { dob: new Date('1990-05-01'), zip: '32541', hireDate: new Date('2026-07-01') } });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-07-01') } });
    const appRow = await prisma.application.create({
      data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'DRAFT', position: 'Housekeeper', startDate: new Date('2026-07-01'), checklist: { create: { tasks: { create: [{ kind: 'WOTC_SCREENING', title: 'Tax credit questions', order: 1 }] } } } },
    });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id, email: 'val@example.com' });
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(DEFAULT_TEST_PASSWORD), status: 'ACTIVE' } });
    return { client, site, a, appRow, user };
  }

  it('the applicant answers and signs; the task completes; HR files, records the outcome, and the credit follows the hours', async () => {
    const { a, appRow, user, client } = await applicant();
    const me = await loginAs(user.email);
    const q = await me.get(`/wotc/applications/${appRow.id}`);
    expect(q.status).toBe(200);
    expect(q.body.questions).toContain('veteran');

    const signed = await me.post(`/wotc/applications/${appRow.id}`).send({ declined: false, signedName: 'Val Vet', answers: { veteran: 'yes', vetUnemployed6m: 'yes', snap: 'no' } });
    expect(signed.status).toBe(200);
    expect(signed.body.status).toBe('LIKELY_ELIGIBLE');
    expect((await prisma.onboardingTask.findFirstOrThrow({ where: { kind: 'WOTC_SCREENING' } })).status).toBe('DONE');

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const h = await loginAs(hr.email);
    const list = await h.get('/wotc/screenings');
    expect(list.status).toBe(200);
    const s = list.body.screenings[0];
    expect(s).toMatchObject({ name: 'Val Vet', status: 'LIKELY_ELIGIBLE', deadline: '2026-07-29', employerComplete: false });
    expect(s.targetGroups[0].code).toBe('VET_UNEMPLOYED_6M');

    // Filing needs the employer's section.
    expect((await h.post(`/wotc/screenings/${s.id}/submitted`).send({ reference: 'FL-123' })).status).toBe(409);
    const emp = await h.patch(`/wotc/screenings/${s.id}/employer`).send({ offerDate: '2026-06-20', hireDate: '2026-06-25', startDate: '2026-07-01', startingWage: 16.5, position: 'Housekeeper', filingState: 'fl' });
    expect(emp.body.screening).toMatchObject({ employerComplete: true, filingState: 'FL', signedAfterOffer: true });

    const csv = await h.get('/wotc/export.csv').query({ state: 'FL' });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Vet');
    const pdf = await h.get(`/wotc/screenings/${s.id}/8850.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');

    expect((await h.post(`/wotc/screenings/${s.id}/submitted`).send({ submittedOn: '2026-07-20', reference: 'FL-123' })).status).toBe(200);
    expect((await h.post(`/wotc/screenings/${s.id}/outcome`).send({ outcome: 'CERTIFIED', group: 'VET_UNEMPLOYED_6M' })).status).toBe(200);

    // 400 hours at $15 → 40% of $6,000 wages so far = $2,400.
    for (let i = 0; i < 50; i++) await shift(a.id, client.id, new Date(Date.UTC(2026, 6, 2 + i, 13)), 8);
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-07-01'), periodEnd: new Date('2026-08-31'), status: 'FINALIZED' } });
    await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: a.id, hoursWorked: 400, hourlyRate: 15, grossPay: 6_000, federalWithholding: 0, fica: 0, medicare: 0, stateWithholding: 0, netPay: 6_000 } });
    const summary = await h.get('/wotc/summary');
    expect(summary.body).toMatchObject({ certified: 1, filedOnTime: 1, estimatedCredit: 2_400 });
    expect(summary.body.byPlace[0]).toMatchObject({ clientName: 'Seaside Co', certified: 1 });
  });

  it('declining completes the task without a screening that can be filed; HR on another site sees nothing', async () => {
    const { appRow, user } = await applicant();
    const me = await loginAs(user.email);
    const declined = await me.post(`/wotc/applications/${appRow.id}`).send({ declined: true, signedName: 'Val Vet' });
    expect(declined.body.status).toBe('DECLINED');

    const other = await createClient('Elsewhere');
    const otherSite = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops@example.com' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [otherSite.id] } });
    const o = await loginAs(ops.email);
    const list = await o.get('/wotc/screenings');
    expect(list.status).toBe(200);
    expect(list.body.screenings).toEqual([]);
  });

  it('the settings switch adds the task to new checklists', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const h = await loginAs(hr.email);
    expect((await h.put('/wotc/settings').send({ enabled: true })).body).toEqual({ enabled: true });
    const template = await prisma.onboardingTemplate.create({ data: { clientId: null, track: 'STANDARD', name: 'Basic', tasks: { create: [{ kind: 'PROFILE_INFO', title: 'Profile', order: 1 }] } } });
    const client = await createClient('Hotel Co');
    const created = await h.post('/onboarding/applications').send({ associateEmail: 'new@example.com', associateFirstName: 'New', associateLastName: 'Hire', clientId: client.id, templateId: template.id });
    expect(created.status).toBe(201);
    const kinds = (await prisma.onboardingTask.findMany({ where: { checklist: { applicationId: created.body.id } } })).map((t) => t.kind);
    expect(kinds).toContain('WOTC_SCREENING');
  });
});

describe('ACA hours tracking', () => {
  it('measures, flags the offer due, records the offer, and writes the 1095-C months', async () => {
    const client = await createClient('Big Box');
    const a = await createAssociate({ firstName: 'Fay', lastName: 'Fulltime' });
    await prisma.associate.update({ where: { id: a.id }, data: { employmentType: 'W2_EMPLOYEE', hireDate: new Date('2022-01-03') } });
    const b = await createAssociate({ firstName: 'Pat', lastName: 'Parttime' });
    await prisma.associate.update({ where: { id: b.id }, data: { employmentType: 'W2_EMPLOYEE', hireDate: new Date('2022-01-03') } });
    const now = new Date();
    // Fay: ~35 h a week for the last two years → full-time; Pat: ~15.
    for (let t = now.getTime() - 730 * 86_400_000; t < now.getTime() - 86_400_000; t += 7 * 86_400_000) {
      await shift(a.id, client.id, new Date(t), 35);
      await shift(b.id, client.id, new Date(t), 15);
    }
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const h = await loginAs(hr.email);

    expect((await h.put('/aca/settings').send({ measurementMonths: 12, adminDays: 120, stabilityMonths: 12, initialMeasurementMonths: 12, stabilityStartMonth: 1, stabilityStartDay: 1, fullTimeHoursPerMonth: 130, breakInServiceWeeks: 13, ruleOfParity: true, defaultOfferCode: 'CODE_1E', affordabilitySafeHarbor: '2H', lowestPremiumCents: 9_900 })).status).toBe(400);

    const workers = await h.get('/aca/workers');
    expect(workers.status).toBe(200);
    const fay = workers.body.workers.find((w: { name: string }) => w.name === 'Fay Fulltime');
    const pat = workers.body.workers.find((w: { name: string }) => w.name === 'Pat Parttime');
    expect(fay.measurement.today).toBe('full_time');
    expect(['due', 'overdue']).toContain(fay.offerState);
    expect(pat.measurement.status).toBe('on_track');

    const inbox = await h.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'aca-offers-due')?.count).toBe(1);

    const due = fay.measurement.offerDue;
    expect((await h.post('/aca/offers').send({ associateId: a.id, stabilityStart: due.stabilityStart, stabilityEnd: due.stabilityEnd })).status).toBe(201);
    const after = await h.get('/aca/summary');
    expect(after.body.counts).toMatchObject({ offersDue: 0, offersOverdue: 0 });
    expect(after.body.exposure).toMatchObject({ fullTime: 1, offered: 1, b: 0 });

    const year = now.getUTCFullYear();
    const sync = await h.post('/aca/sync-1095c').send({ year });
    expect(sync.body.people).toBe(2);
    const months = await prisma.acaMonth.findMany({ where: { associateId: a.id, year }, orderBy: { month: 'asc' } });
    expect(months).toHaveLength(12);
    const thisMonth = months[now.getUTCMonth()]!;
    expect(thisMonth).toMatchObject({ isFullTime: true, offerOfCoverage: 'CODE_1E', safeHarbor: '2H' });
    const patMonth = await prisma.acaMonth.findFirstOrThrow({ where: { associateId: b.id, year, month: now.getUTCMonth() + 1 } });
    expect(patMonth).toMatchObject({ isFullTime: false, safeHarbor: '2B' });
  });
});
