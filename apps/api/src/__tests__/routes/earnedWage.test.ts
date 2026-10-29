import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { getCurrentPeriod } from '../../lib/payrollSchedule.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Earned-wage access: what a person can draw before payday, the draw
 * itself (to a verified account only), Finance's view, and the recovery
 * on the next regular check.
 */

const app = () => createApp();
const DAY = 86_400_000;

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

async function seed(opts: { verified?: boolean } = {}) {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Lena', lastName: 'Osei' });
  await prisma.associate.update({ where: { id: associate.id }, data: { state: 'FL', phone: '850-555-0100' } });
  const schedule = await prisma.payrollSchedule.create({
    data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-01-03T00:00:00Z'), payDateOffsetDays: 7 },
  });
  // On it (F500 SH-4: an advance comes off the check of the schedule she is ON;
  // the company's first schedule is no longer assumed).
  await prisma.associate.update({ where: { id: associate.id }, data: { payrollScheduleId: schedule.id } });
  await prisma.compensationRecord.create({
    data: { associateId: associate.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: 20, reason: 'HIRE' },
  });
  await prisma.payoutMethod.create({
    data: {
      associateId: associate.id,
      type: 'BANK_ACCOUNT',
      accountType: 'CHECKING',
      bankName: 'Chase',
      routingNumberEnc: Buffer.from('062000019', 'utf8'),
      accountNumberEnc: encryptString('555500002222'),
      accountLast4: '2222',
      isPrimary: true,
      verifiedAt: opts.verified === false ? null : new Date(Date.now() - 30 * DAY),
    },
  });
  // Ten approved hours this period, before now.
  const period = getCurrentPeriod(schedule, new Date());
  const start = new Date(`${period.periodStart}T00:00:00Z`);
  const clockIn = new Date(Math.max(start.getTime(), Date.now() - 2 * DAY));
  await prisma.timeEntry.create({
    data: { associateId: associate.id, clientId: client.id, clockInAt: clockIn, clockOutAt: new Date(clockIn.getTime() + 10 * 3_600_000), status: 'APPROVED' },
  });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id, email: associate.email });
  const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return { client, associate, user, finance, period };
}

describe('earned-wage access', () => {
  it('shows what is available: half of the estimated net on the hours so far', async () => {
    const { user } = await seed();
    const r = await (await loginAs(user.email)).get('/me/earned-wage');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.hoursWorked).toBe(10);
    expect(r.body.earnedGross).toBe(200);
    // The take-home estimate the associate's Home shows (lib/takeHome — Social
    // Security and Medicare on $200; no income tax at that pay), 50% cap.
    expect(r.body.earnedNet).toBe(184.7);
    expect(r.body.cap).toBe(92.35);
    expect(r.body.available).toBe(92.35);
    expect(r.body.blocker).toBeNull();
  });

  it('someone on no pay schedule has no advance: no run would write the check it comes off (F500 SH-4)', async () => {
    const { user, associate } = await seed();
    await prisma.associate.update({ where: { id: associate.id }, data: { payrollScheduleId: null } });
    const agent = await loginAs(user.email);
    const avail = await agent.get('/me/earned-wage');
    expect(avail.status).toBe(200);
    expect(avail.body.blocker).toBe('NO_SCHEDULE');
    expect(avail.body.available).toBe(0);
    const r = await agent.post('/me/earned-wage').send({ amount: 20 });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an account Finance has not verified', async () => {
    const { user } = await seed({ verified: false });
    const agent = await loginAs(user.email);
    // A pending change naming the account is what holds it back.
    const pm = await prisma.payoutMethod.findFirstOrThrow({ where: { associateId: user.associateId! } });
    await prisma.financialChange.create({
      data: { associateId: user.associateId!, kind: 'BANK_ACCOUNT', source: 'SELF', status: 'PENDING', newPayoutMethodId: pm.id, newSummary: 'Chase ····2222', riskFlags: [], riskScore: 0, highRisk: false },
    });
    const avail = await agent.get('/me/earned-wage');
    expect(avail.body.blocker).toBe('NO_VERIFIED_ACCOUNT');
    const r = await agent.post('/me/earned-wage').send({ amount: 20 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('no_verified_payout');
  });

  it('pays an advance on the rail, shows it to Finance, and recovers it on the next check', async () => {
    const { user, finance, associate, period } = await seed();
    const agent = await loginAs(user.email);
    const over = await agent.post('/me/earned-wage').send({ amount: 500 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('over_limit');

    const r = await agent.post('/me/earned-wage').send({ amount: 50 });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('PAID');
    expect(r.body.amount).toBe(50);
    await flushPendingNotifications();

    const after = await agent.get('/me/earned-wage');
    expect(after.body.drawn).toBe(50);
    expect(after.body.available).toBe(42.35);
    const history = await agent.get('/me/earned-wage/history');
    expect(history.body.advances).toHaveLength(1);

    const fin = await loginAs(finance.email);
    const desk = await fin.get('/payroll/earned-wage');
    expect(desk.status).toBe(200);
    expect(desk.body.outstanding).toMatchObject({ count: 1, amount: 50 });
    expect(desk.body.advances[0].associate.name).toBe('Lena Osei');
    // The desk's working numbers (F500 G3): drawn on this period, one person, nothing recovered or rolled over yet.
    expect(desk.body.thisPeriod).toEqual({ count: 1, amount: 50 });
    expect(desk.body.people).toBe(1);
    expect(desk.body.lastRecovery).toBeNull();
    expect(desk.body.rolledOver).toEqual({ count: 0, amount: 0 });
    const audit = await prisma.auditLog.findFirst({ where: { action: 'ewa.paid' } });
    expect(audit).not.toBeNull();

    // The regular run for the period takes it back.
    const created = await fin.post('/payroll/runs').send({ periodStart: period.periodStart, periodEnd: period.periodEnd });
    expect(created.status).toBe(201);
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: created.body.id, associateId: associate.id } });
    expect(Number(item.postTaxDeductions)).toBe(50);
    const adv = await prisma.earnedWageAdvance.findFirstOrThrow({ where: { associateId: associate.id } });
    expect(adv.status).toBe('RECOVERED');
    expect(adv.recoveredCents).toBe(5000);
    expect(adv.recoveredItemId).toBe(item.id);
    // What the latest payroll took back.
    const recovered = await fin.get('/payroll/earned-wage');
    expect(recovered.body.lastRecovery).toMatchObject({ runId: created.body.id, amount: 50, advances: 1 });
    expect(recovered.body.outstanding).toMatchObject({ count: 0, amount: 0 });

    // Finance can tune the policy.
    const settings = await fin.patch('/payroll/earned-wage/settings').send({ capPct: 40, fee: 1.5 });
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ capPct: 40, fee: 1.5 });
  });

  it('counts advances whose pay period ended before the check could carry them (F500 G3)', async () => {
    const { associate, finance } = await seed();
    // A paid advance on a period that ended last month, $20 of its $50 (+$1 fee) recovered.
    await prisma.earnedWageAdvance.create({
      data: { associateId: associate.id, periodStart: new Date(Date.now() - 40 * DAY), periodEnd: new Date(Date.now() - 27 * DAY), amountCents: 5000, feeCents: 100, earnedNetCents: 20000, availableCents: 10000, status: 'PAID', recoveredCents: 2000 },
    });
    const fin = await loginAs(finance.email);
    const desk = await fin.get('/payroll/earned-wage');
    expect(desk.body.rolledOver).toEqual({ count: 1, amount: 31 });
    expect(desk.body.thisPeriod).toEqual({ count: 0, amount: 0 });
  });
});
