import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Marketing's real job: the careers funnel, the employer brand page,
 * referral campaigns — and the bonus that only reaches a paycheck through
 * Finance. And the role itself, narrowed: no payroll, no HR surface.
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

const today = () => new Date().toISOString().slice(0, 10);

describe('the careers funnel', () => {
  it('views by source on the public site become the top of a funnel that ends in hires', async () => {
    await prisma.jobPosting.create({ data: { title: 'Cashier', description: 'x', slug: 'cashier', status: 'OPEN', openedAt: new Date() } });
    for (let i = 0; i < 3; i++) await request(app()).post('/careers/view').send({ slug: 'cashier', source: 'Indeed' });
    await request(app()).post('/careers/view').send({ slug: null, source: null });
    await request(app()).post('/careers/cashier/apply').send({ firstName: 'A', lastName: 'B', email: 'a.b@example.com', source: 'indeed' });

    const { user } = await createUser({ role: 'MARKETING_MANAGER' });
    const m = await loginAs(user.email);
    const r = await m.get(`/marketing/overview?from=${today()}&to=${today()}`);
    expect(r.status).toBe(200);
    expect(r.body.funnel).toMatchObject({ views: 4, applicants: 1 });
    const indeed = r.body.bySource.find((s: { source: string | null }) => s.source === 'indeed');
    expect(indeed).toMatchObject({ views: 3, applicants: 1, viewToApplyPct: 33.3 });
    expect(r.body.byPosting[0]).toMatchObject({ slug: 'cashier', views: 3, applicants: 1 });
  });
});

describe('the employer brand page', () => {
  it('marketing edits it and the public careers site reads it', async () => {
    const { user } = await createUser({ role: 'MARKETING_MANAGER' });
    const m = await loginAs(user.email);
    const put = await m.put('/marketing/brand').send({ headline: 'Paid weekly, home by dinner', perks: ['Weekly pay', 'Rides to work'], values: [{ title: 'Reliable', body: 'We show up.' }] });
    expect(put.status).toBe(200);
    const pub = await request(app()).get('/careers/brand');
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ headline: 'Paid weekly, home by dinner', perks: ['Weekly pay', 'Rides to work'] });
    expect(pub.body.values[0].title).toBe('Reliable');

    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(assoc.email)).put('/marketing/brand').send({ headline: 'x' })).status).toBe(403);
  });
});

describe('referral campaigns and the bonus Finance approves', () => {
  it('a hire under a live campaign proposes the bonus to Finance, who puts it on a draft run as a bonus line', async () => {
    const { user: mkt } = await createUser({ role: 'MARKETING_MANAGER' });
    const m = await loginAs(mkt.email);
    const c = await m.post('/marketing/campaigns').send({ name: 'Holiday referrals', bonusAmount: 250, payAfterDays: 0, startsOn: today() });
    expect(c.status).toBe(201);
    expect((await m.post(`/marketing/campaigns/${c.body.id}/status`).send({ status: 'ACTIVE' })).body.status).toBe('ACTIVE');

    // An associate refers a friend under the campaign.
    const referrerAssoc = await createAssociate({ firstName: 'Rae', lastName: 'Lin' });
    const { user: referrer } = await createUser({ role: 'ASSOCIATE', associateId: referrerAssoc.id });
    const camps = await (await loginAs(referrer.email)).get('/marketing/campaigns');
    expect(camps.body.campaigns.map((x: { id: string }) => x.id)).toEqual([c.body.id]);
    const ref = await (await loginAs(referrer.email)).post('/referrals').send({ candidateName: 'Sam Doe', candidateEmail: 'sam@example.com', campaignId: c.body.id });
    expect(ref.status).toBe(201);

    // The recruiter marks it hired: no waiting period, so the bonus goes to Finance.
    const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
    expect((await (await loginAs(rec.email)).post(`/referrals/${ref.body.id}/status`).send({ status: 'HIRED' })).status).toBe(200);
    const payout = await prisma.referralBonusPayout.findUniqueOrThrow({ where: { referralId: ref.body.id } });
    expect(payout).toMatchObject({ status: 'PROPOSED', associateId: referrerAssoc.id });
    expect(Number(payout.amount)).toBe(250);

    // Marketing cannot approve its own proposal.
    expect((await m.post(`/marketing/bonus-payouts/${payout.id}/decide`).send({ decision: 'APPROVE' })).status).toBe(403);

    // Finance sees it in the Inbox, then approves it onto a draft run.
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(fin.email);
    const inbox = await f.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'referral-bonuses')?.count).toBe(1);
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-16'), status: 'DRAFT', kind: 'OFF_CYCLE' } });
    const list = await f.get('/marketing/bonus-payouts');
    expect(list.body.draftRuns.map((r: { id: string }) => r.id)).toContain(run.id);
    const ok = await f.post(`/marketing/bonus-payouts/${payout.id}/decide`).send({ decision: 'APPROVE', payrollRunId: run.id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', payrollRunId: run.id });
    const line = await prisma.payrollRunAddOn.findFirstOrThrow({ where: { payrollRunId: run.id } });
    expect(line).toMatchObject({ kind: 'BONUS', associateId: referrerAssoc.id });
    expect(Number(line.amount)).toBe(250);
    // Decided once.
    expect((await f.post(`/marketing/bonus-payouts/${payout.id}/decide`).send({ decision: 'DECLINE' })).status).toBe(409);
  });

  it('a campaign with a waiting period waits, unless marketing proposes early', async () => {
    const { user: mkt } = await createUser({ role: 'MARKETING_MANAGER' });
    const m = await loginAs(mkt.email);
    const c = await m.post('/marketing/campaigns').send({ name: 'Q4', bonusAmount: 100, payAfterDays: 30, startsOn: today() });
    await m.post(`/marketing/campaigns/${c.body.id}/status`).send({ status: 'ACTIVE' });
    const ra = await createAssociate();
    const { user: referrer } = await createUser({ role: 'ASSOCIATE', associateId: ra.id });
    const ref = await (await loginAs(referrer.email)).post('/referrals').send({ candidateName: 'Jo Ray', candidateEmail: 'jo@example.com', campaignId: c.body.id });
    const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
    await (await loginAs(rec.email)).post(`/referrals/${ref.body.id}/status`).send({ status: 'HIRED' });
    expect(await prisma.referralBonusPayout.count()).toBe(0);
    expect((await m.post(`/marketing/referrals/${ref.body.id}/propose-bonus`).send({})).status).toBe(409);
    expect((await m.post(`/marketing/referrals/${ref.body.id}/propose-bonus`).send({ force: true })).status).toBe(201);
  });
});

describe('the marketing role, narrowed', () => {
  it('lands on its own surfaces and is refused payroll and HR', async () => {
    const { user } = await createUser({ role: 'MARKETING_MANAGER' });
    const m = await loginAs(user.email);
    expect((await m.get('/marketing/campaigns')).status).toBe(200);
    expect((await m.get('/recruiting/candidates')).status).toBe(200);
    expect((await m.post('/recruiting/candidates').send({ firstName: 'x', lastName: 'y', email: 'x@y.com' })).status).toBe(403);
    expect((await m.get('/payroll/runs')).status).toBe(403);
    expect((await m.get('/admin/users')).status).toBe(403);
  });
});
