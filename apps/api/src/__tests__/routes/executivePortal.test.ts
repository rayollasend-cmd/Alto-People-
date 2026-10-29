import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { ExecClients, ExecPeople, ExecRisks } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { weekStartsEndingWith } from '../../lib/paidHours.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { localDateKey } from '../../lib/timezone.js';
import { companyWorkweek } from '../../lib/timeAnomalies.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The executive portal's drill-downs (routes/executivePortal): the
 * chairman's Clients, People and Risk pages. Shapes, the numbers on a
 * seeded world, who may read them, and that a tenant reads only its own.
 */

const H = 3_600_000;
const DAY = 24 * H;
const T2 = '00000000-0000-4000-8000-0000000000e2';
const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app);
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

async function chairman(): Promise<TestAgent<Test>> {
  const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
  return loginAs(user.email);
}

/** A client with its default store. */
async function clientWithSite(name: string, tenantId = ALTO_TENANT_ID) {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  if (tenantId !== ALTO_TENANT_ID) {
    await prisma.client.update({ where: { id: client.id }, data: { tenantId } });
    await prisma.site.update({ where: { id: site.id }, data: { tenantId } });
  }
  return { client, site };
}

/** Someone placed at a store, hired on a calendar day. */
async function placed(siteId: string, first: string, opts: { hireDate?: string; tenantId?: string } = {}) {
  const a = await createAssociate({ firstName: first, lastName: 'Tester' });
  await prisma.associate.update({ where: { id: a.id }, data: { hireDate: new Date(`${opts.hireDate ?? '2025-01-06'}T00:00:00Z`), tenantId: opts.tenantId ?? ALTO_TENANT_ID } });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: new Date('2025-01-06'), tenantId: opts.tenantId ?? ALTO_TENANT_ID } });
  return a;
}

/** Approved punches of `hours` each, on the first days of the week starting `weekStart`. */
async function worked(associateId: string, clientId: string, siteId: string, weekStart: Date, punches: number[], tenantId = ALTO_TENANT_ID) {
  for (let i = 0; i < punches.length; i++) {
    const clockInAt = new Date(weekStart.getTime() + i * DAY + 13 * H);
    await prisma.timeEntry.create({
      data: { associateId, clientId, locationId: siteId, clockInAt, clockOutAt: new Date(clockInAt.getTime() + punches[i]! * H), status: 'APPROVED', tenantId },
    });
  }
}

/**
 * Two clients last week: Alpha 30 h (three 10-hour days), Beta 10 h, and
 * the internal-hires pseudo-client 5 h (not a client). Alpha published two
 * shifts last week and filled one.
 */
async function twoClients(now: Date) {
  const [lastWeek] = weekStartsEndingWith(now, 2);
  const alpha = await clientWithSite('Alpha Resorts');
  const beta = await clientWithSite('Beta Foods');
  const internal = await clientWithSite('Alto HR — Internal Hires');
  const ann = await placed(alpha.site.id, 'Ann');
  const bob = await placed(beta.site.id, 'Bob');
  const ivy = await placed(internal.site.id, 'Ivy');
  await worked(ann.id, alpha.client.id, alpha.site.id, lastWeek!, [10, 10, 10]);
  await worked(bob.id, beta.client.id, beta.site.id, lastWeek!, [10]);
  await worked(ivy.id, internal.client.id, internal.site.id, lastWeek!, [5]);
  for (const assigned of [ann.id, null]) {
    const startsAt = new Date(lastWeek!.getTime() + 4 * DAY + 13 * H);
    await prisma.shift.create({
      data: { clientId: alpha.client.id, locationId: alpha.site.id, position: 'Housekeeper', startsAt, endsAt: new Date(startsAt.getTime() + 8 * H), status: assigned ? 'COMPLETED' : 'OPEN', assignedAssociateId: assigned, publishedAt: new Date(startsAt.getTime() - 7 * DAY) },
    });
  }
  return { alpha, beta, internal, ann, bob, ivy, lastWeek: lastWeek! };
}

describe('GET /executive/clients', () => {
  it('prices each client’s period, shares that add to 100, the HHI, fill, the pipeline and the league', async () => {
    const now = pinMidweekNoon();
    const w = await twoClients(now);
    await prisma.clientProspect.createMany({
      data: [
        { name: 'Lead Co', stage: 'LEAD', estWeeklyHours: 10, estBillRate: 20, stageChangedAt: new Date(now.getTime() - 3 * DAY) },
        { name: 'Verbal Co', stage: 'VERBAL', estWeeklyHours: 40, estBillRate: 25 },
        { name: 'Unpriced Co', stage: 'CONTACTED', estWeeklyHours: null, estBillRate: null },
        { name: 'Won Co', stage: 'WON', estWeeklyHours: 99, estBillRate: 99 },
        { name: 'Lost Co', stage: 'LOST', estWeeklyHours: 99, estBillRate: 99, lostReason: 'Price' },
      ],
    });
    const agent = await chairman();
    const res = await agent.get('/executive/clients?period=week&compare=prior');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as ExecClients;

    expect(body.period.key).toBe('week');
    expect(body.period.start).toBe(localDateKey(w.lastWeek, companyWorkweek().timezone));
    // The internal-hires pseudo-client is not a client.
    expect(body.clients.map((c) => c.name)).toEqual(['Alpha Resorts', 'Beta Foods']);
    const [alpha, beta] = body.clients;
    expect(alpha!.billed).toBeCloseTo(30 * env.DEFAULT_ASSOCIATE_BILL_RATE, 2);
    expect(beta!.billed).toBeCloseTo(10 * env.DEFAULT_ASSOCIATE_BILL_RATE, 2);
    expect(alpha!.hours).toBe(30);
    expect(alpha!.sharePct + beta!.sharePct).toBe(100);
    expect(alpha!.sharePct).toBe(75);
    expect(alpha!.marginPct).not.toBeNull();
    expect(alpha!.margin).toBeCloseTo(alpha!.billed * (alpha!.marginPct! / 100), 0);
    expect(alpha!.headcount).toBe(1);
    expect(alpha!.fillPct).toBe(50);
    expect(beta!.fillPct).toBeNull();
    expect(['Good', 'Watch', 'At risk']).toContain(alpha!.healthLabel);
    expect(alpha!.href).toBe(`/clients/${w.alpha.client.id}`);
    // Eight complete weeks of billing, oldest first; the last is last week.
    expect(alpha!.trend).toHaveLength(8);
    expect(alpha!.trend[7]).toBe(alpha!.billed);

    expect(body.concentration).toEqual({ topSharePct: 75, topClientName: 'Alpha Resorts', thresholdPct: 50, hhi: 75 ** 2 + 25 ** 2 });

    // The pipeline: open stages only, most advanced first, weighted by the stated chances.
    expect(body.pipeline.stages.map((s) => s.stage)).toEqual(['VERBAL', 'PROPOSAL', 'CONTACTED', 'LEAD']);
    const verbal = body.pipeline.stages[0]!;
    expect(verbal).toMatchObject({ label: 'Verbal yes', count: 1, weeklyValue: 1000, probability: 0.8, weightedAnnual: 1000 * 52 * 0.8 });
    const lead = body.pipeline.stages[3]!;
    expect(lead).toMatchObject({ count: 1, weeklyValue: 200, probability: 0.1, weightedAnnual: 200 * 52 * 0.1 });
    expect(body.pipeline.weightedAnnual).toBe(1000 * 52 * 0.8 + 200 * 52 * 0.1);
    expect(body.pipeline.prospects.map((p) => p.name)).toEqual(['Verbal Co', 'Unpriced Co', 'Lead Co']);
    expect(body.pipeline.prospects.find((p) => p.name === 'Lead Co')).toMatchObject({ stageLabel: 'Lead', weeklyValue: 200, daysInStage: 3 });
    expect(body.pipeline.prospects.find((p) => p.name === 'Unpriced Co')!.weeklyValue).toBeNull();

    // The league: each store, best margin first, internal hires left out.
    expect(body.league.map((l) => l.clientName)).toEqual(['Alpha Resorts', 'Beta Foods']);
    expect(body.league[0]).toMatchObject({ locationId: w.alpha.site.id, hours: 30, otHours: 0 });
  });

  it('agrees with the executive summary: the same hours, priced the same', async () => {
    const now = pinMidweekNoon();
    await twoClients(now);
    const agent = await chairman();
    const [clients, summary] = await Promise.all([agent.get('/executive/clients?period=week'), agent.get('/executive/summary')]);
    const billed = (clients.body as ExecClients).clients.reduce((n, c) => n + c.billed, 0);
    // The summary counts the internal hires' 5 hours too; the client book does not.
    expect(summary.body.lastWeek.workedHours).toBe(45);
    expect(billed + 5 * env.DEFAULT_ASSOCIATE_BILL_RATE).toBeCloseTo(summary.body.lastWeek.estBilled, 2);
  });

  it('is empty, not broken, for a company with no clients', async () => {
    const agent = await chairman();
    const res = await agent.get('/executive/clients');
    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([]);
    expect(res.body.concentration).toEqual({ topSharePct: 0, topClientName: null, thresholdPct: 50, hhi: 0 });
    expect(res.body.pipeline.weightedAnnual).toBe(0);
  });
});

describe('GET /executive/people', () => {
  it('counts exactly what the People directory and Analytics count, and never shows a future start as new', async () => {
    const now = pinMidweekNoon();
    const w = await twoClients(now);
    const tz = companyWorkweek().timezone;
    const today = localDateKey(now, tz);
    const daysFrom = (n: number) => localDateKey(new Date(now.getTime() + n * DAY), tz);
    await placed(w.alpha.site.id, 'Newly', { hireDate: daysFrom(-5) });
    await placed(w.alpha.site.id, 'Future', { hireDate: daysFrom(10) });
    // Someone who left, and someone onboarding.
    const gone = await placed(w.beta.site.id, 'Gone');
    await prisma.associate.update({ where: { id: gone.id }, data: { separatedAt: new Date(now.getTime() - 20 * DAY) } });
    const pending = await createAssociate({ firstName: 'Pending', lastName: 'Tester' });
    await prisma.application.create({ data: { associateId: pending.id, clientId: w.alpha.client.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED' } });

    const agent = await chairman();
    const [people, directory, analytics, summary] = await Promise.all([
      agent.get('/executive/people?period=quarter&compare=prior'),
      agent.get('/people/directory/summary'),
      agent.get('/analytics/dashboard'),
      agent.get('/executive/summary'),
    ]);
    expect(people.status, JSON.stringify(people.body)).toBe(200);
    const body = people.body as ExecPeople;

    expect(body.counts).toEqual({
      active: directory.body.ACTIVE,
      onTheBooks: directory.body.onTheBooks,
      onboarding: directory.body.ONBOARDING,
      deactivated: directory.body.DEACTIVATED,
      placedNotActive: directory.body.PLACED_NOT_ACTIVE,
      notPlaced: directory.body.NOT_PLACED,
    });
    expect(body.counts.active).toBe(analytics.body.activeAssociates);
    expect(body.counts.onTheBooks).toBe(analytics.body.onTheBooks);
    expect(body.counts.onboarding).toBe(1);

    expect(body.kpis.map((k) => k.id)).toEqual(['workforce', 'hires', 'turnover', 'overtimePct']);
    const workforce = body.kpis[0]!;
    expect(workforce.value).toBe(body.counts.active);
    expect(workforce.sub).toBe(`of ${body.counts.onTheBooks} on the books`);
    expect(workforce.trend).toHaveLength(13);

    // Thirteen complete weeks; last week's paid hours are the summary's.
    expect(body.weeks).toHaveLength(13);
    expect(body.weeks[12]!.hours).toBe(summary.body.lastWeek.workedHours);
    expect(body.weeks[12]!.hours).toBe(45);

    // New hires: the arrived start in, the future one out.
    const names = body.newHires.map((h) => h.name);
    expect(names).toContain('Newly Tester');
    expect(names).not.toContain('Future Tester');
    expect(body.newHires.every((h) => h.hireDate <= today)).toBe(true);

    // Tenure bands cover the working people.
    expect(body.tenure.map((t) => t.band)).toEqual(['Under 90 days', '3–12 months', '1–2 years', '2 years or more']);
    expect(body.tenure.reduce((n, t) => n + t.count, 0)).toBe(body.counts.active);

    // The churn bill: one separation in 90 days at the configured cost.
    expect(body.turnover.separations90d).toBe(1);
    expect(body.turnover.estCost90d).toBe(env.EXEC_COST_PER_SEPARATION);

    // The best four weeks: most paid hours, a clean record.
    expect(body.topWorkers[0]).toMatchObject({ name: 'Ann Tester', hours: 30 });
  });

  it('puts unexcused events on the store’s row per 100 assigned shifts, and keeps a flagged person off the top workers', async () => {
    const now = pinMidweekNoon();
    const w = await twoClients(now);
    const shift = await prisma.shift.findFirstOrThrow({ where: { assignedAssociateId: w.ann.id } });
    await prisma.attendanceEvent.create({ data: { associateId: w.ann.id, shiftId: shift.id, clientId: w.alpha.client.id, kind: 'LATE', points: 1, occurredOn: new Date(`${localDateKey(shift.startsAt, companyWorkweek().timezone)}T00:00:00Z`) } });
    const agent = await chairman();
    const res = await agent.get('/executive/people');
    const body = res.body as ExecPeople;
    expect(body.weeks[12]!.unexcused).toBe(1);
    expect(body.attendance.weeks).toHaveLength(8);
    expect(body.attendance.sites[0]).toEqual({ id: w.alpha.site.id, name: 'Alpha Resorts' });
    const cell = body.attendance.cells.find((c) => c.siteId === w.alpha.site.id && c.week === body.attendance.weeks[7]);
    expect(cell).toEqual({ siteId: w.alpha.site.id, week: body.attendance.weeks[7], events: 1, perHundredShifts: 100 });
    expect(body.topWorkers.map((t) => t.name)).not.toContain('Ann Tester');
  });
});

describe('GET /executive/risks', () => {
  it('names the concentration when one client dominates, highest severity first', async () => {
    const now = pinMidweekNoon();
    const w = await twoClients(now);
    const agent = await chairman();
    const res = await agent.get('/executive/risks');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as ExecRisks;
    const conc = body.risks.find((r) => r.id === 'client-concentration');
    expect(conc).toMatchObject({ category: 'client', severity: 'high', owner: 'Clients', title: 'Alpha Resorts is 75% of revenue', href: '/executive/clients' });
    expect(conc!.metric).toBe('75.0% of est. billing, last 4 weeks');
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const ranks = body.risks.map((r) => rank[r.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // No supervisor at either store; no client survey ever sent.
    expect(body.risks.find((r) => r.id === 'site-supervisor')?.title).toBe('2 stores have people placed and no supervisor');
    expect(body.risks.find((r) => r.id === 'client-nps-stale')?.severity).toBe('low');

    // A shift supervisor at Alpha covers Alpha's store; Beta's stays bare.
    await createUser({ role: 'SHIFT_SUPERVISOR', clientId: w.alpha.client.id });
    const again = (await agent.get('/executive/risks')).body as ExecRisks;
    expect(again.risks.find((r) => r.id === 'site-supervisor')?.title).toBe('Beta Foods has 1 person placed and no supervisor');
  });

  it('says nothing about concentration when billing is balanced', async () => {
    const now = pinMidweekNoon();
    const [lastWeek] = weekStartsEndingWith(now, 2);
    for (const name of ['One', 'Two', 'Three']) {
      const { client, site } = await clientWithSite(`${name} Co`);
      const a = await placed(site.id, name);
      await worked(a.id, client.id, site.id, lastWeek!, [8]);
    }
    const agent = await chairman();
    const body = (await agent.get('/executive/risks')).body as ExecRisks;
    expect(body.risks.find((r) => r.id === 'client-concentration')).toBeUndefined();
  });

  it('raises legal deadlines that passed and an I-9 past Section 2', async () => {
    const now = pinMidweekNoon();
    const { client, site } = await clientWithSite('Deadline Co');
    const a = await placed(site.id, 'Late', { hireDate: localDateKey(new Date(now.getTime() - 14 * DAY), companyWorkweek().timezone) });
    await prisma.i9Verification.create({ data: { associateId: a.id, documentsSubmittedAt: new Date(now.getTime() - 14 * DAY) } });
    const dayOnly = (n: number) => new Date(`${localDateKey(new Date(now.getTime() + n * DAY), companyWorkweek().timezone)}T00:00:00Z`);
    await prisma.unemploymentClaim.create({
      data: { associateId: a.id, state: 'FL', status: 'NEW', claimDate: dayOnly(-15), noticeReceivedAt: dayOnly(-12), responseDueAt: dayOnly(-5) },
    });
    // A claim still inside its window is not a risk.
    const b = await placed(site.id, 'Fresh');
    await prisma.unemploymentClaim.create({
      data: { associateId: b.id, state: 'FL', status: 'NEW', claimDate: dayOnly(-2), noticeReceivedAt: dayOnly(-1), responseDueAt: dayOnly(5) },
    });
    void client;
    const agent = await chairman();
    const body = (await agent.get('/executive/risks')).body as ExecRisks;
    expect(body.risks.find((r) => r.id === 'i9-section2')).toMatchObject({ severity: 'high', category: 'compliance', title: '1 I-9 past the Section 2 deadline' });
    expect(body.risks.find((r) => r.id === 'ui-claim-deadlines')).toMatchObject({ severity: 'high', owner: 'HR', title: '1 unemployment claim past the response date', trend: 'new', href: '/executive/risk?open=ui-claim-deadlines' });
  });
});

describe('who may read the executive portal', () => {
  it('the chairman reads all three; a role without view:executive, and a site-bound office account, are refused', async () => {
    const chair = await chairman();
    for (const path of ['/executive/clients', '/executive/people', '/executive/risks']) {
      expect((await chair.get(path)).status, path).toBe(200);
    }
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const workforce = await loginAs(wfm.email);
    const { client } = await clientWithSite('Scoped Co');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [site.id] } });
    const scoped = await loginAs(ops.email);
    for (const path of ['/executive/clients', '/executive/people', '/executive/risks']) {
      expect((await workforce.get(path)).status, path).toBe(403);
      expect((await scoped.get(path)).status, path).toBe(403);
    }
    expect((await request(app).get('/executive/clients')).status).toBe(401);
  });

  it('reads only the caller’s tenant', async () => {
    const now = pinMidweekNoon();
    const [lastWeek] = weekStartsEndingWith(now, 2);
    await twoClients(now);
    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'exec-portal-two', name: 'Tenant Two' }, update: {} });
    const other = await clientWithSite('Other Tenant Co', T2);
    const stranger = await placed(other.site.id, 'Stranger', { tenantId: T2 });
    await worked(stranger.id, other.client.id, other.site.id, lastWeek!, [10, 10, 10, 10, 10], T2);
    await prisma.clientProspect.create({ data: { tenantId: T2, name: 'Their Prospect', stage: 'VERBAL', estWeeklyHours: 10, estBillRate: 10 } });

    const agent = await chairman();
    const [clients, people, risks] = await Promise.all([agent.get('/executive/clients?period=week'), agent.get('/executive/people'), agent.get('/executive/risks')]);
    const text = JSON.stringify([clients.body, people.body, risks.body]);
    expect(text).not.toContain('Other Tenant Co');
    expect(text).not.toContain('Stranger');
    expect(text).not.toContain('Their Prospect');
    expect((clients.body as ExecClients).clients.map((c) => c.name)).toEqual(['Alpha Resorts', 'Beta Foods']);
    expect((people.body as ExecPeople).weeks[12]!.hours).toBe(45);

    // Tenant two's chairman sees tenant two.
    const { user: theirs } = await createUser({ role: 'EXECUTIVE_CHAIRMAN', email: 'chair@tenant-two.example' });
    await prisma.user.update({ where: { id: theirs.id }, data: { tenantId: T2 } });
    const two = await loginAs(theirs.email);
    const twoClientsRes = (await two.get('/executive/clients?period=week')).body as ExecClients;
    expect(twoClientsRes.clients.map((c) => c.name)).toEqual(['Other Tenant Co']);
    expect(twoClientsRes.clients[0]!.sharePct).toBe(100);
  });
});
