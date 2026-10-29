import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { ExecFinancials, ExecKpi, ExecOverview } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { lastCompleteWeeks } from '../../lib/execPeriods.js';
import { execRates } from '../../lib/execFinance.js';
import { loadExecContext } from '../../lib/execFinanceContext.js';
import { computeExecOverview } from '../../lib/execOverview.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { postEntry } from '../../lib/books/ledger.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The chairman's overview and financials (routes/executive, 2026-10-27):
 * the shape, the numbers on a seeded world (revenue and margin are the
 * executive summary's to the cent), the plan prorated and judged, a
 * comparison with nothing in it said so, who may read and who may set the
 * plan, and that a tenant reads only its own.
 */

const H = 3_600_000;
const DAY = 24 * H;
const T2 = '00000000-0000-4000-8000-0000000000a2';
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

/** A placed associate at a client's store, in a tenant. */
async function placed(tenantId: string = ALTO_TENANT_ID, name = 'Ana') {
  const client = tenantId === ALTO_TENANT_ID ? await createClient(`${name} Resort`) : await prisma.client.create({ data: { name: `${name} Resort`, industry: 'hospitality', status: 'ACTIVE', tenantId, locations: { create: { name: `${name} Resort`, tenantId } } } });
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const a = await createAssociate({ firstName: name, lastName: 'Worker', email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@example.com` });
  // Hired in January: on the books for every window the tests read.
  await prisma.associate.update({ where: { id: a.id }, data: { hireDate: new Date('2026-01-05'), ...(tenantId !== ALTO_TENANT_ID ? { tenantId } : {}) } });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-01-01'), tenantId } });
  return { client, site, associate: a };
}

/** Approved punches: `hours` each, on the given days (instants of the day's 13:00 UTC = 9 AM Eastern). */
async function punches(p: Awaited<ReturnType<typeof placed>>, days: Date[], hours: number, tenantId: string = ALTO_TENANT_ID) {
  for (const d of days) {
    await prisma.timeEntry.create({
      data: { tenantId, associateId: p.associate.id, clientId: p.client.id, locationId: p.site.id, clockInAt: d, clockOutAt: new Date(d.getTime() + hours * H), status: 'APPROVED' },
    });
  }
}

/** Five weekdays of a company week (its Monday to Friday, 9 AM Eastern). */
const weekdaysOf = (weekStart: Date) => [2, 3, 4, 5, 6].map((i) => new Date(weekStart.getTime() + i * DAY + 13 * H));
const byId = (o: { scorecard?: ExecKpi[]; kpis?: ExecKpi[] }, id: string) => (o.scorecard ?? o.kpis)!.find((k) => k.id === id)!;

describe('GET /executive/overview', () => {
  it('answers the eight measures in order, and the week’s revenue and margin are the executive summary’s', async () => {
    const now = pinMidweekNoon();
    const p = await placed();
    const [prior, last] = lastCompleteWeeks(now, 2) as [Date, Date];
    await punches(p, weekdaysOf(last), 9); // 45 hours: 5 of overtime
    await punches(p, weekdaysOf(prior), 8);
    const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const exec = await loginAs(user.email);

    const res = await exec.get('/executive/overview?period=week&compare=prior');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const o = res.body as ExecOverview;
    expect(o.scorecard.map((k) => k.id)).toEqual(['revenue', 'marginPct', 'workforce', 'fillRate', 'turnover', 'overtimePct', 'dso', 'cash']);
    expect(o.period.key).toBe('week');
    expect(o.comparison).toMatchObject({ key: 'prior', available: true });
    for (const k of o.scorecard) {
      expect(k.trend).toHaveLength(13);
      expect(k.definition.length).toBeGreaterThan(20);
      expect(k.href.startsWith('/executive/')).toBe(true);
      expect(k.statusLabel).toBeTruthy();
    }
    expect(o.changes.length).toBeGreaterThanOrEqual(3);
    expect(o.changes.length).toBeLessThanOrEqual(5);
    expect(o.notes.join(' ')).toMatch(/Weeks run Saturday to Friday, Eastern time\./);

    const summary = (await exec.get('/executive/summary')).body as { lastWeek: { estBilled: number; estMargin: number; workedHours: number; otHours: number } };
    expect(summary.lastWeek.workedHours).toBe(45);
    expect(byId(o, 'revenue').value).toBeCloseTo(summary.lastWeek.estBilled, 1);
    expect(byId(o, 'marginPct').value).toBeCloseTo((summary.lastWeek.estMargin / summary.lastWeek.estBilled) * 100, 1);
    expect(byId(o, 'overtimePct').value).toBeCloseTo((5 / 45) * 100, 1);
    expect(byId(o, 'revenue').sub).toBe('45 paid hours');
    // Against the week before: 40 straight hours.
    const r = execRates();
    expect(byId(o, 'revenue').compare).toBeCloseTo(40 * r.billRate, 1);
    expect(byId(o, 'revenue').delta).toBeGreaterThan(0);
    expect(byId(o, 'workforce').value).toBe(1);
    expect(byId(o, 'workforce').sub).toBe('of 1 on the books');
  });

  it('cash reads "overdrawn" when a bank account is below zero, though the total is positive (MONEY-18)', async () => {
    // Operating up $20,000; payroll checking paid out $3,908.97 with nothing transferred in.
    await postEntry(prisma, { date: '2026-09-02', source: 'MANUAL', lines: [{ account: 'CASH_OPERATING', debit: 20000 }, { account: 'OWNER_EQUITY', credit: 20000 }] });
    await postEntry(prisma, { date: '2026-10-09', source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 3908.97 }, { account: 'CASH_PAYROLL', credit: 3908.97 }] });
    const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const exec = await loginAs(user.email);
    const res = await exec.get('/executive/overview');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cash = (res.body as ExecOverview).scorecard.find((k) => k.id === 'cash')!;
    expect(cash.status).toBe('bad');
    expect(JSON.stringify(cash)).toMatch(/overdrawn/);
    expect(JSON.stringify(cash)).not.toMatch(/Positive for 13 weeks/);
  });

  it('the chairman reads it; an office role without view:executive is refused; the period and comparison fall back to the defaults', async () => {
    pinMidweekNoon();
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const a = await loginAs(exec.email);
    const ok = await a.get('/executive/overview?period=decade&compare=vibes');
    expect(ok.status).toBe(200);
    expect(ok.body.period.key).toBe('quarter');
    expect(ok.body.comparison.key).toBe('prior');
    const b = await loginAs(wfm.email);
    expect((await b.get('/executive/overview')).status).toBe(403);
    expect((await b.get('/executive/financials')).status).toBe(403);
    expect((await b.get('/executive/board-pack.pdf')).status).toBe(403);
  });

  it('reads one tenant: another tenant’s hours never reach the scorecard', async () => {
    const now = pinMidweekNoon();
    await prisma.tenant.create({ data: { id: T2, slug: 'exec-two', name: 'Exec Two' } });
    const [last] = lastCompleteWeeks(now, 1) as [Date];
    await punches(await placed(ALTO_TENANT_ID, 'Ana'), weekdaysOf(last), 8);
    await punches(await placed(T2, 'Tess'), weekdaysOf(last), 6, T2);
    const { user: altoExec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN', email: 'chair@alto.example' });
    const { user: twoExec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN', email: 'chair@two.example' });
    await prisma.user.update({ where: { id: twoExec.id }, data: { tenantId: T2 } });
    const r = execRates();

    const alto = (await (await loginAs(altoExec.email)).get('/executive/overview?period=week')).body as ExecOverview;
    expect(byId(alto, 'revenue').value).toBeCloseTo(40 * r.billRate, 1);
    expect(byId(alto, 'workforce').value).toBe(1);
    const two = (await (await loginAs(twoExec.email)).get('/executive/overview?period=week')).body as ExecOverview;
    expect(byId(two, 'revenue').value).toBeCloseTo(30 * r.billRate, 1);
    expect(byId(two, 'workforce').value).toBe(1);
  });
});

describe('the overview’s frame (lib/execOverview at a fixed clock)', () => {
  // Tuesday 2026-10-27, noon in New York: Q4 is 26.5 days old.
  const NOW = new Date('2026-10-27T16:00:00.000Z');

  it('prorates the quarter’s plan to the day and judges each measure against it', async () => {
    const p = await placed();
    // Two full weeks in October, 40 straight hours each.
    await punches(p, weekdaysOf(new Date('2026-10-03T04:00:00.000Z')), 8);
    await punches(p, weekdaysOf(new Date('2026-10-10T04:00:00.000Z')), 8);
    await prisma.execTarget.create({ data: { quarter: '2026-Q4', revenueTarget: 100_000, marginTarget: 20_000, headcountTarget: 5, turnoverPctTarget: 30, fillRatePctTarget: 95 } });

    const ctx = await loadExecContext(prisma, { tenantId: ALTO_TENANT_ID, now: NOW, period: 'quarter', compare: 'plan' });
    const { overview: o } = await computeExecOverview(prisma, ctx);
    expect(o.plan).toEqual({ quarter: '2026-Q4', set: true });
    expect(o.comparison).toMatchObject({ key: 'plan', available: true, reason: null });

    // Oct 1 00:00 EDT → Oct 27 12:00 EDT is 636 hours of the quarter's 2,209 (DST adds one).
    const revenue = byId(o, 'revenue');
    expect(revenue.target).toBeCloseTo((100_000 * 636) / 2209, 0);
    expect(revenue.compare).toBe(revenue.target);
    expect(revenue.value).toBeCloseTo(80 * execRates().billRate, 1);
    expect(revenue.delta).toBeCloseTo(revenue.value! - revenue.target!, 1);
    expect(revenue).toMatchObject({ status: 'bad', statusLabel: 'Off plan' });
    expect(revenue.targetLabel).toBe('Q4 plan $100k, prorated to Oct 27');

    // 20k margin on 100k revenue is a 20% plan; the standard rates make 20.8%.
    const margin = byId(o, 'marginPct');
    expect(margin.target).toBeCloseTo(20, 2);
    expect(margin).toMatchObject({ status: 'good', statusLabel: 'On plan' });
    // One active person against a plan of five.
    expect(byId(o, 'workforce')).toMatchObject({ value: 1, target: 5, status: 'bad' });
    // No published shifts: nothing to judge the fill rate by yet.
    expect(byId(o, 'fillRate')).toMatchObject({ value: null, target: 95, status: 'none', statusLabel: 'No data yet' });
    // Turnover: none, against a ceiling of 30%.
    expect(byId(o, 'turnover')).toMatchObject({ value: 0, target: 30, status: 'good' });
    // The plan is off for revenue and headcount: the board hears it first.
    expect(o.changes[0]!.tone).toBe('bad');
    expect(o.changes.map((c) => c.text).join(' ')).toMatch(/short of plan/);
  });

  it('says why when there is nothing to compare against', async () => {
    const p = await placed();
    // Only the last complete week (Oct 17–23) has work; the week before is empty.
    await punches(p, weekdaysOf(new Date('2026-10-17T04:00:00.000Z')), 8);
    const ctx = await loadExecContext(prisma, { tenantId: ALTO_TENANT_ID, now: NOW, period: 'week', compare: 'prior' });
    const { overview: o } = await computeExecOverview(prisma, ctx);
    expect(o.period).toMatchObject({ start: '2026-10-17', end: '2026-10-23', label: 'Week of Oct 17' });
    expect(o.comparison).toMatchObject({ key: 'prior', available: false, start: '2026-10-10', end: '2026-10-16' });
    expect(o.comparison.reason).toBe('There is no recorded work for Oct 10 – 16 to compare against.');
    for (const k of o.scorecard) expect(k.delta).toBeNull();
    // With nothing to compare, the facts carry "what changed".
    expect(o.changes.length).toBeGreaterThanOrEqual(3);
    expect(o.changes.every((c) => c.tone === 'neutral')).toBe(true);
    expect(o.changes[0]!.text).toMatch(/^Revenue for the week of Oct 17 is \$/);

    const plan = await loadExecContext(prisma, { tenantId: ALTO_TENANT_ID, now: NOW, period: 'quarter', compare: 'plan' });
    const { overview: noPlan } = await computeExecOverview(prisma, plan);
    expect(noPlan.comparison).toMatchObject({ available: false, reason: 'No plan is set for Q4 2026.' });
    expect(noPlan.plan.set).toBe(false);
  });
});

describe('GET /executive/financials', () => {
  it('walks billed to margin exactly, with 13 weeks, cash and receivables', async () => {
    const now = pinMidweekNoon();
    const p = await placed();
    const [last] = lastCompleteWeeks(now, 1) as [Date];
    await punches(p, weekdaysOf(last), 10); // 50 hours: 10 of overtime
    const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const res = await (await loginAs(user.email)).get('/executive/financials?period=week&compare=prior');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const f = res.body as ExecFinancials;

    expect(f.kpis.map((k) => k.id)).toEqual(['revenue', 'grossMargin', 'marginPct', 'overtimePct', 'cash', 'dso']);
    expect(f.waterfall.map((s) => s.key)).toEqual(['billed', 'basePay', 'overtimePremium', 'burden', 'overhead', 'margin']);
    const [billed, base, ot, burden, overhead, margin] = f.waterfall.map((s) => s.amount) as [number, number, number, number, number, number];
    expect(billed - base - ot - burden - overhead).toBeCloseTo(margin, 2);
    const r = execRates();
    expect(base).toBeCloseTo(50 * r.payRate, 2);
    expect(ot).toBeCloseTo(10 * r.payRate * 0.5, 2);
    expect(burden).toBeCloseTo((50 * r.payRate + ot) * (r.burdenPct / 100), 2);
    expect(margin).toBeCloseTo(byId(f, 'grossMargin').value!, 1);
    expect(billed).toBeCloseTo(byId(f, 'revenue').value!, 1);

    expect(f.weeks).toHaveLength(13);
    expect(f.weeks[12]).toMatchObject({ hours: 50, otHours: 10 });
    expect(f.weeks[12]!.billed).toBeCloseTo(billed, 2);
    expect(f.receivables).toMatchObject({ total: 0, open: [] });
    expect(f.receivables.dsoByMonth).toHaveLength(6);
    expect(f.rates).toEqual({ billRate: r.billRate, payRate: r.payRate, burdenPct: r.burdenPct, overheadPerHour: r.overheadPerHour });
  });
});

describe('PUT /executive/targets — the board sets the plan', () => {
  it('the chairman can set it (audited); an associate cannot', async () => {
    pinMidweekNoon();
    const { user: chair } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(chair.email);
    const put = await a.put('/executive/targets').send({ quarter: '2026-Q4', revenueTarget: 250000, fillRatePctTarget: 96 });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const row = await prisma.execTarget.findFirstOrThrow({ where: { tenantId: ALTO_TENANT_ID, quarter: '2026-Q4' } });
    expect(Number(row.revenueTarget)).toBe(250000);
    expect(Number(row.fillRatePctTarget)).toBe(96);
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'executive.targets_set', entityId: row.id } });
    expect(audit?.actorUserId).toBe(chair.id);

    const b = await loginAs(assoc.email);
    expect((await b.put('/executive/targets').send({ quarter: '2026-Q4', revenueTarget: 1 })).status).toBe(403);
    expect(Number((await prisma.execTarget.findFirstOrThrow({ where: { id: row.id } })).revenueTarget)).toBe(250000);
  });
});
