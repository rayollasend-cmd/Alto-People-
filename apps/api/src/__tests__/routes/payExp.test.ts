import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { runDailyPay } from '../../lib/dailyPay.js';
import { buildPayPreview, confirmPayPreview, flagPayPreview } from '../../lib/payPreview.js';
import { computeYtdWages } from '../../lib/payrollYtd.js';
import { aggregateW2Wages } from '../../lib/w2Aggregator.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * PAYEXP end to end: daily pay settles each night and the regular run
 * trues up without paying anything twice; the bonus gross-up lands the
 * exact take-home on a real run; manual checks and insurer sick pay reach
 * YTD, the ledger and the W-2; the pay preview's flags route to the lead or
 * payroll and block the guided close; the W-4 estimator.
 */

const app = () => createApp();
const H = 3_600_000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

/** Biweekly Sat→Fri, paid the Friday after: Sep 12–25 pays Oct 2. */
async function seedWorker(opts: { firstName?: string; rate?: number } = {}) {
  const client = await createClient();
  const associate = await createAssociate({ firstName: opts.firstName ?? 'Lena', lastName: 'Osei' });
  const schedule = await prisma.payrollSchedule.create({
    data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-01-03T00:00:00Z'), payDateOffsetDays: 7 },
  });
  await prisma.associate.update({ where: { id: associate.id }, data: { state: 'FL', payrollScheduleId: schedule.id } });
  await prisma.compensationRecord.create({
    data: { associateId: associate.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: opts.rate ?? 20, reason: 'HIRE' },
  });
  await prisma.payoutMethod.create({
    data: {
      associateId: associate.id,
      type: 'BRANCH_CARD',
      branchCardId: `card-${associate.id.slice(0, 8)}`,
      isPrimary: true,
      verifiedAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id, email: associate.email });
  return { client, associate, schedule, user };
}

/** Five 9-hour days, Mon Sep 14 – Fri Sep 18: 45 hours, 5 of them weekly overtime. */
async function fiveLongDays(associateId: string, clientId: string) {
  const ids: string[] = [];
  for (let d = 14; d <= 18; d++) {
    const clockInAt = new Date(`2026-09-${d}T08:00:00Z`);
    const e = await prisma.timeEntry.create({ data: { associateId, clientId, clockInAt, clockOutAt: new Date(clockInAt.getTime() + 9 * H), status: 'APPROVED' } });
    ids.push(e.id);
  }
  return ids;
}

async function activeDailyPay(approverId: string) {
  await prisma.dailyPayPolicy.create({ data: { status: 'ACTIVE', timing: 'NEXT_DAY', eligibility: 'ENROLLED', feeCents: 0, dailyCapCents: 50_000, approvedById: approverId, approvedAt: new Date() } });
}

const sum = (xs: Array<{ toString(): string } | number>) => Math.round(xs.reduce<number>((s, x) => s + Number(x), 0) * 100) / 100;

describe('daily pay', () => {
  it('turning it on waits for a second person; turning it off does not', async () => {
    const { user: f1 } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: f2 } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a1 = await loginAs(f1.email);
    const on = await a1.put('/payroll/daily-pay/policy').send({ enable: true, timing: 'NEXT_DAY', dailyCapCents: 30_000 });
    expect(on.status).toBe(202);
    expect(on.body.policy.status).toBe('PENDING');
    // The requester can't approve their own change.
    const self = await a1.post(`/approvals/requests/${on.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(self.status).toBeGreaterThanOrEqual(400);
    const a2 = await loginAs(f2.email);
    const ok = await a2.post(`/approvals/requests/${on.body.approvalId}/decide`).send({ decision: 'APPROVE' });
    expect(ok.status).toBe(200);
    const after = await a1.get('/payroll/daily-pay');
    expect(after.body.policy.status).toBe('ACTIVE');
    expect(after.body.policy.dailyCapCents).toBe(30_000);
    const off = await a1.put('/payroll/daily-pay/policy').send({ enable: false });
    expect(off.status).toBe(200);
    expect(off.body.policy.status).toBe('OFF');
  });

  it('pays each day at night, and the regular run pays only what is left — nothing twice', async () => {
    const { client, associate } = await seedWorker();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await activeDailyPay(hr.id);
    await prisma.dailyPayEnrollment.create({ data: { associateId: associate.id } });
    await fiveLongDays(associate.id, client.id);

    const night = await runDailyPay({ now: new Date('2026-09-19T10:00:00Z') });
    expect(night.ran).toBe(true);
    expect(night.paid).toHaveLength(5);
    expect(night.paid.every((p) => p.status === 'DISBURSED' && p.gross === 180)).toBe(true);
    const dailyRuns = await prisma.payrollRun.findMany({ where: { kind: 'DAILY' }, include: { items: true } });
    expect(dailyRuns).toHaveLength(5);
    expect(dailyRuns.every((r) => r.status === 'DISBURSED')).toBe(true);
    expect(await prisma.dailyPaidTimeEntry.count()).toBe(5);

    // The same night again settles nothing new.
    const again = await runDailyPay({ now: new Date('2026-09-19T11:00:00Z') });
    expect(again.paid).toHaveLength(0);
    expect(await prisma.payrollRun.count({ where: { kind: 'DAILY' } })).toBe(5);

    const a = await loginAs(hr.email);
    const created = await a.post('/payroll/runs').send({ periodStart: '2026-09-12', periodEnd: '2026-09-25' });
    expect(created.status).toBe(201);
    const regular = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: created.body.id, associateId: associate.id }, include: { earnings: true } });
    // 40 × $20 + 5 × $30 = $950 for the period; $900 went out daily.
    expect(Number(regular.grossPay)).toBe(50);
    expect(regular.earnings.find((e) => e.kind === 'DAILY_SETTLED')?.amount.toString()).toBe('-900');
    expect(sum(regular.earnings.map((e) => e.amount))).toBe(50);

    // Across every check for the period: the whole period's pay and FICA, once.
    const all = await prisma.payrollItem.findMany({ where: { associateId: associate.id, status: { in: ['DISBURSED', 'PENDING'] } } });
    expect(sum(all.map((i) => i.grossPay))).toBe(950);
    expect(sum(all.map((i) => i.fica))).toBe(58.9);
    expect(sum(all.map((i) => i.medicare))).toBe(13.78);
    const links = await prisma.dailyPaidTimeEntry.findMany();
    expect(links.every((l) => l.reconciledRunId === created.body.id)).toBe(true);

    // Re-aggregating (an add-on and its removal) keeps the same answer.
    const add = await a.post(`/payroll/runs/${created.body.id}/add-ons`).send({ associateId: associate.id, kind: 'BONUS', amount: 10 });
    expect(add.status).toBe(201);
    await a.delete(`/payroll/runs/${created.body.id}/add-ons/${add.body.addOnId}`);
    const re = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: created.body.id, associateId: associate.id } });
    expect(Number(re.grossPay)).toBe(50);

    // Deleting the run gives the settlements back for its replacement.
    const del = await a.delete(`/payroll/runs/${created.body.id}`);
    expect(del.status).toBeLessThan(300);
    expect((await prisma.dailyPaidTimeEntry.findMany()).every((l) => l.reconciledRunId === null)).toBe(true);
  });

  it('a daily check that never left is voided and the regular check pays those hours in full', async () => {
    const { client, associate } = await seedWorker();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await activeDailyPay(hr.id);
    await prisma.dailyPayEnrollment.create({ data: { associateId: associate.id } });
    await fiveLongDays(associate.id, client.id);
    const night = await runDailyPay({ now: new Date('2026-09-19T10:00:00Z') });
    const stuck = night.paid[0]!;
    await prisma.payrollItem.update({ where: { id: stuck.itemId }, data: { status: 'HELD', failureReason: 'test hold' } });

    const a = await loginAs(hr.email);
    const created = await a.post('/payroll/runs').send({ periodStart: '2026-09-12', periodEnd: '2026-09-25' });
    const regular = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: created.body.id, associateId: associate.id } });
    expect(Number(regular.grossPay)).toBe(950 - 4 * 180);
    expect((await prisma.payrollItem.findUniqueOrThrow({ where: { id: stuck.itemId } })).status).toBe('VOIDED');
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: stuck.runId } })).status).toBe('CANCELLED');
    expect(await prisma.dailyPaidTimeEntry.count()).toBe(4);
  });

  it('pays nobody when off, and never pays past the daily cap', async () => {
    const { client, associate } = await seedWorker();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.dailyPayEnrollment.create({ data: { associateId: associate.id } });
    await fiveLongDays(associate.id, client.id);
    expect((await runDailyPay({ now: new Date('2026-09-19T10:00:00Z') })).reason).toBe('OFF');
    await prisma.dailyPayPolicy.create({ data: { status: 'ACTIVE', dailyCapCents: 10_000, approvedById: hr.id } });
    const night = await runDailyPay({ now: new Date('2026-09-19T10:00:00Z') });
    expect(night.paid).toHaveLength(0);
    expect(night.skipped.some((s) => s.reason === 'OVER_DAILY_CAP')).toBe(true);
  });
});

describe('bonus gross-up on a run', () => {
  it('a $1,000 take-home bonus on an off-cycle run adds exactly $1,000 to the check, with the breakdown', async () => {
    const { associate } = await seedWorker();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const quote = await a.post('/payroll/gross-up/quote').send({ associateId: associate.id, targetNet: 1000 });
    expect(quote.status).toBe(200);
    expect(quote.body.breakdown.gross).toBe(1421.46);
    const run = await a.post('/payroll/runs').send({ periodStart: '2026-10-03', periodEnd: '2026-10-03', kind: 'OFF_CYCLE' });
    expect(run.status).toBe(201);
    const add = await a.post(`/payroll/runs/${run.body.id}/add-ons`).send({ associateId: associate.id, kind: 'BONUS', targetNet: 1000 });
    expect(add.status).toBe(201);
    expect(add.body.grossUp.net).toBeGreaterThanOrEqual(1000);
    expect(add.body.grossUp.net).toBeLessThan(1000.02);
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: run.body.id, associateId: associate.id } });
    expect(Number(item.netPay)).toBeGreaterThanOrEqual(1000);
    expect(Number(item.netPay)).toBeLessThan(1000.02);
    const listed = await a.get(`/payroll/runs/${run.body.id}/add-ons`);
    expect(listed.body.addOns[0].targetNet).toBe(1000);
    expect(listed.body.addOns[0].grossUp.federal).toBeGreaterThan(0);
    // Amount or take-home, never both.
    expect((await a.post(`/payroll/runs/${run.body.id}/add-ons`).send({ associateId: associate.id, kind: 'BONUS', amount: 5, targetNet: 5 })).status).toBe(400);
  });
});

describe('manual checks and third-party sick pay', () => {
  it('a manual check reaches YTD and the tax ledger; void takes it back out; replace links the new one', async () => {
    const { associate } = await seedWorker();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const body = { associateId: associate.id, checkNumber: '1042', payDate: '2026-09-30', gross: 500, federal: 40, socialSecurity: 31, medicare: 7.25, state: 0, net: 421.75 };
    expect((await a.post('/payroll/manual-checks').send({ ...body, net: 400 })).status).toBe(400);
    const rec = await a.post('/payroll/manual-checks').send(body);
    expect(rec.status).toBe(201);
    expect((await a.post('/payroll/manual-checks').send(body)).status).toBe(409);
    const yearStart = new Date('2026-01-01T00:00:00Z');
    expect(await computeYtdWages(prisma, associate.id, yearStart, new Date('2026-10-01T00:00:00Z'))).toBe(500);
    const fed = await prisma.taxLiability.findFirst({ where: { payrollRunId: rec.body.runId, kind: 'FEDERAL_WITHHOLDING' } });
    expect(Number(fed?.amount)).toBe(116.5); // 40 FIT + 31 + 7.25 employee + 31 + 7.25 employer
    const listed = await a.get('/payroll/manual-checks');
    expect(listed.body.checks[0]).toMatchObject({ checkNumber: '1042', gross: 500, net: 421.75, status: 'RECORDED' });

    const replaced = await a.post('/payroll/manual-checks').send({ ...body, checkNumber: '1043', replacesItemId: rec.body.itemId });
    expect(replaced.status).toBe(201);
    expect((await prisma.payrollItem.findUniqueOrThrow({ where: { id: rec.body.itemId } })).status).toBe('VOIDED');
    expect((await prisma.payrollItem.findUniqueOrThrow({ where: { id: replaced.body.itemId } })).amendsItemId).toBe(rec.body.itemId);
    expect(await prisma.taxLiability.count({ where: { payrollRunId: rec.body.runId } })).toBe(0);
    expect(await computeYtdWages(prisma, associate.id, yearStart, new Date('2026-10-01T00:00:00Z'))).toBe(500);

    const v = await a.post(`/payroll/manual-checks/${replaced.body.runId}/void`).send({ reason: 'Check lost in the mail' });
    expect(v.status).toBe(200);
    expect(await computeYtdWages(prisma, associate.id, yearStart, new Date('2026-10-01T00:00:00Z'))).toBe(0);
  });

  it('insurer sick pay lands on the W-2 (Box 1/3/5, 12 J, 13) and posts the employer share when passed back', async () => {
    const { associate } = await seedWorker();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const r = await a.post('/payroll/sick-pay').send({
      associateId: associate.id,
      payerName: 'Lincoln Financial',
      payDate: '2026-08-14',
      grossAmount: 1000,
      nontaxableAmount: 200,
      federalWithheld: 100,
      socialSecurityWithheld: 49.6,
      medicareWithheld: 11.6,
      employerTaxesBy: 'EMPLOYER',
      w2ReportedBy: 'EMPLOYER',
    });
    expect(r.status).toBe(201);
    expect(r.body.employerTaxes.fica).toBe(49.6);
    const w2 = await aggregateW2Wages(prisma, associate.id, 2026);
    expect(w2.box1Wages).toBe(800);
    expect(w2.box2FitWithheld).toBe(100);
    expect(w2.box3SsWages).toBe(800);
    expect(w2.box4SsTax).toBe(49.6);
    expect(w2.box12).toContainEqual({ code: 'J', amount: 200 });
    expect(w2.box13ThirdPartySickPay).toBe(true);
    const liab = await prisma.taxLiability.findMany({ where: { payrollRunId: null } });
    expect(liab.some((l) => l.kind === 'FEDERAL_WITHHOLDING' && Number(l.amount) === Math.round((49.6 + 11.6) * 100) / 100)).toBe(true);
    // Voided: off the W-2 and the ledger.
    await a.post(`/payroll/sick-pay/${r.body.id}/void`).send({});
    expect((await aggregateW2Wages(prisma, associate.id, 2026)).box13ThirdPartySickPay).toBe(false);
    expect(await prisma.taxLiability.count({ where: { payrollRunId: null } })).toBe(0);
  });
});

describe('check my pay before payday', () => {
  it('opens two days before payday, confirms, and routes flags to the lead or payroll; open flags block the close', async () => {
    const { client, associate, user } = await seedWorker();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const entry = await prisma.timeEntry.create({
      data: { associateId: associate.id, clientId: client.id, clockInAt: new Date('2026-09-14T13:00:00Z'), clockOutAt: new Date('2026-09-14T21:00:00Z'), status: 'APPROVED' },
    });
    // Monday Sep 28: payday Fri Oct 2 is four days off.
    expect((await buildPayPreview(prisma, associate.id, new Date('2026-09-28T15:00:00Z'))).reason).toBe('NOT_YET');
    const now = new Date('2026-09-30T15:00:00Z');
    const p = await buildPayPreview(prisma, associate.id, now);
    expect(p).toMatchObject({ available: true, payDate: '2026-10-02', periodStart: '2026-09-12', periodEnd: '2026-09-25', source: 'ESTIMATE', gross: 160 });
    expect(p.days).toHaveLength(1);
    expect(p.taxes.find((t) => t.kind === 'SOCIAL_SECURITY')?.amount).toBe(9.92);

    const confirmed = await confirmPayPreview(prisma, associate.id, user.id, now);
    expect(confirmed.check?.status).toBe('CONFIRMED');

    const hours = await flagPayPreview(
      prisma,
      { associateId: associate.id, userId: user.id },
      { line: 'day:2026-09-14', kind: 'HOURS', note: 'I stayed until 6pm', timeEntryId: entry.id, proposedClockOut: '2026-09-14T22:00:00.000Z' },
      now,
    );
    expect(hours.routedTo).toBe('LEAD');
    expect(await prisma.timeCorrectionRequest.count({ where: { id: hours.correctionId! } })).toBe(1);
    const rate = await flagPayPreview(prisma, { associateId: associate.id, userId: user.id }, { line: 'earning:REGULAR:0', kind: 'RATE', note: 'My raise to $22 is missing' }, now);
    expect(rate.routedTo).toBe('PAYROLL');
    expect((await prisma.hrCase.findUniqueOrThrow({ where: { id: rate.caseId! } })).category).toBe('PAYROLL');
    expect(rate.preview.check?.status).toBe('FLAGGED');
    expect(rate.preview.check?.flags).toHaveLength(2);

    // Payroll: the run for that period shows two open flags as a blocker.
    const a = await loginAs(hr.email);
    const run = await a.post('/payroll/runs').send({ periodStart: '2026-09-12', periodEnd: '2026-09-25' });
    const close = await a.get(`/payroll/runs/${run.body.id}/close`);
    const step = close.body.steps.find((s: { key: string }) => s.key === 'payPreview');
    expect(step).toMatchObject({ state: 'blocked', blockers: 2 });
    const checks = await a.get(`/payroll/pay-checks?run=${run.body.id}`);
    expect(checks.body).toMatchObject({ people: 1, flagged: 1, openFlags: 2 });
    await a.post('/payroll/pay-checks/resolve').send({ runId: run.body.id, associateId: associate.id });
    expect((await a.get(`/payroll/pay-checks?run=${run.body.id}`)).body.openFlags).toBe(0);

    // The worker's own door answers for them only.
    const me = await loginAs(user.email);
    expect((await me.get('/me/pay-preview')).status).toBe(200);
    expect((await me.get('/payroll/pay-checks?run=' + run.body.id)).status).toBe(403);
  });
});

describe('W-4 estimator', () => {
  it('starts from the person’s own numbers and estimates; the suggestion goes through the W-4 flow', async () => {
    const { associate, user } = await seedWorker();
    await prisma.w4Submission.create({ data: { associateId: associate.id, filingStatus: 'SINGLE' } });
    const me = await loginAs(user.email);
    const ctx = await me.get('/me/w4-estimator');
    expect(ctx.status).toBe(200);
    expect(ctx.body.current.filingStatus).toBe('SINGLE');
    expect(ctx.body.payFrequency).toBe('BIWEEKLY');
    const est = await me.post('/me/w4-estimator').send({ filingStatus: 'SINGLE', payFrequency: 'BIWEEKLY', payPerPeriod: 2000, periodsRemaining: 6, ytdWages: 40_000, ytdFederalWithheld: 2000, childrenUnder17: 1 });
    expect(est.status).toBe(200);
    expect(est.body.suggested.dependentsAmount).toBe(2200);
    expect(est.body.asIs).not.toBeNull();
    const submit = await me.post('/self/me/w4').send({ filingStatus: est.body.suggested.filingStatus, dependentsAmount: est.body.suggested.dependentsAmount, extraWithholding: est.body.suggested.extraWithholding });
    expect(submit.status).toBe(200);
    expect(Number((await prisma.w4Submission.findUniqueOrThrow({ where: { associateId: associate.id } })).dependentsAmount)).toBe(2200);
  });
});

void encryptString;
