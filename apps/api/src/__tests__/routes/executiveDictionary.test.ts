import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import {
  METRICS,
  ROLE_CAPABILITIES,
  daysToCollectOf,
  marginPctOf,
  type Capability,
  type ExecFinancials,
  type ExecKpi,
  type ExecOverview,
  type ExecPeople,
  type ExecRisks,
  type Role,
} from '@alto-people/shared';
import { createApp } from '../../app.js';
import { execRates } from '../../lib/execFinance.js';
import { lastCompleteWeeks } from '../../lib/execPeriods.js';
import { peopleStandings, turnoverBetween } from '../../lib/peopleStatus.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { companyWorkweek } from '../../lib/timeAnomalies.js';
import { localDateKey } from '../../lib/timezone.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The executive portal reads the metric dictionary (packages/shared
 * metrics.ts, deep audit 2026-10-29): every scorecard label and definition
 * is the dictionary's, gross margin % is (revenue − pay, burden, overhead)
 * ÷ revenue, days to collect is open AR over the 90 days' billing per day,
 * the Workforce turnover card's 90-day rate reads the trailing 90 days, and
 * no risk sends a view:executive reader to a desk they cannot open
 * (LEAD-5, LEAD-6, LEAD-7, MONEY-8).
 */

const H = 3_600_000;
const DAY = 24 * H;
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

async function clientWithSite(name: string) {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  return { client, site };
}

async function placed(siteId: string, first: string, opts: { hireDate?: string; separatedAt?: Date } = {}) {
  const a = await createAssociate({ firstName: first, lastName: 'Tester' });
  await prisma.associate.update({
    where: { id: a.id },
    data: { hireDate: new Date(`${opts.hireDate ?? '2025-01-06'}T00:00:00Z`), tenantId: ALTO_TENANT_ID, ...(opts.separatedAt ? { separatedAt: opts.separatedAt } : {}) },
  });
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: new Date('2025-01-06'), tenantId: ALTO_TENANT_ID } });
  return a;
}

const byId = (list: ExecKpi[], id: string) => list.find((k) => k.id === id)!;

describe('the scorecard reads the dictionary', () => {
  it('names and defines every measure the dictionary holds, and computes gross margin % by its formula', async () => {
    const now = pinMidweekNoon();
    const { client, site } = await clientWithSite('Dictionary Resort');
    const a = await placed(site.id, 'Ana');
    const [last] = lastCompleteWeeks(now, 1) as [Date];
    // Five 8-hour days: 40 straight-time hours, no overtime.
    for (const i of [2, 3, 4, 5, 6]) {
      const clockInAt = new Date(last.getTime() + i * DAY + 13 * H);
      await prisma.timeEntry.create({ data: { tenantId: ALTO_TENANT_ID, associateId: a.id, clientId: client.id, locationId: site.id, clockInAt, clockOutAt: new Date(clockInAt.getTime() + 8 * H), status: 'APPROVED' } });
    }
    const agent = await chairman();
    const o = (await agent.get('/executive/overview?period=week&compare=prior')).body as ExecOverview;

    const named: Array<[string, keyof typeof METRICS]> = [
      ['revenue', 'revenue'],
      ['marginPct', 'grossMarginPct'],
      ['workforce', 'working'],
      ['fillRate', 'fillRate'],
      ['turnover', 'turnover'],
      ['overtimePct', 'overtimeShare'],
      ['dso', 'daysToCollect'],
    ];
    for (const [kpi, metric] of named) {
      const k = byId(o.scorecard, kpi);
      expect(k.label, kpi).toBe(METRICS[metric].label);
      expect(k.definition.startsWith(METRICS[metric].definition), kpi).toBe(true);
    }
    // One population, one name: the scorecard says Working, as the directory and Analytics do.
    expect(byId(o.scorecard, 'workforce').label).toBe('Working');

    // Gross margin %: (revenue − pay − employer burden − overhead) ÷ revenue, at the standard rates.
    const r = execRates();
    const billed = 40 * r.billRate;
    const pay = 40 * r.payRate;
    const cost = pay + pay * (r.burdenPct / 100) + 40 * r.overheadPerHour;
    expect(byId(o.scorecard, 'revenue').value).toBeCloseTo(billed, 1);
    expect(byId(o.scorecard, 'marginPct').value).toBeCloseTo(marginPctOf(billed, cost)!, 1);

    // Financials' gross margin $ and the dictionary's name for it.
    const f = (await agent.get('/executive/financials?period=week&compare=prior')).body as ExecFinancials;
    const gm = byId(f.kpis, 'grossMargin');
    expect(gm.label).toBe(METRICS.grossMargin.label);
    expect(gm.value).toBeCloseTo(billed - cost, 1);
    expect(f.weeks.at(-1)!.marginPct).toBeCloseTo(marginPctOf(billed, cost)!, 1);
  });

  it('days to collect is open receivables over the last 90 days’ billing per day — not days from finalized to paid', async () => {
    const now = pinMidweekNoon();
    const { client } = await clientWithSite('Owing Co');
    const stmt = (n: number, amount: number, finalizedDaysAgo: number, paidDaysAgo: number | null) =>
      prisma.clientStatement.create({
        data: {
          clientId: client.id,
          periodStart: new Date(now.getTime() - (finalizedDaysAgo + 7) * DAY),
          periodEnd: new Date(now.getTime() - (finalizedDaysAgo + 1) * DAY),
          status: 'FINAL',
          number: n,
          finalizedAt: new Date(now.getTime() - finalizedDaysAgo * DAY),
          paidAt: paidDaysAgo === null ? null : new Date(now.getTime() - paidDaysAgo * DAY),
          snapshot: { totals: { amount } },
        },
      });
    // $9,000 billed in the 90 days: $3,000 paid two days after it was finalized, $6,000 still open.
    await stmt(1, 3000, 40, 38);
    await stmt(2, 6000, 10, null);
    // Older than 90 days: not billing in the window (and paid, so not open either).
    await stmt(3, 50_000, 120, 100);

    const agent = await chairman();
    const o = (await agent.get('/executive/overview')).body as ExecOverview;
    const dso = byId(o.scorecard, 'dso');
    expect(dso.label).toBe('Days to collect');
    expect(dso.value).toBeCloseTo(daysToCollectOf(6000, 9000)!, 1); // 60 days
    // Books' measure (finalized → paid, 2 days here) is a different number with a different name.
    expect(dso.value).not.toBeCloseTo(2, 0);
    expect(METRICS.averageDaysToPay.label).not.toBe(dso.label);
  });
});

describe('turnover, last 90 days (LEAD-7)', () => {
  it('rates the trailing 90 days beside the same span’s separations and cost', async () => {
    const now = pinMidweekNoon();
    const { site } = await clientWithSite('Turnover Co');
    for (const name of ['Ann', 'Bea', 'Cal', 'Dee']) await placed(site.id, name);
    // One left 30 days ago; one left 200 days ago (outside the 90 days).
    await placed(site.id, 'Eve', { separatedAt: new Date(now.getTime() - 30 * DAY) });
    await placed(site.id, 'Fay', { separatedAt: new Date(now.getTime() - 200 * DAY) });

    const agent = await chairman();
    const p = (await agent.get('/executive/people?period=week')).body as ExecPeople;
    expect(p.turnover.separations90d).toBe(1);
    const expected = turnoverBetween(await peopleStandings({ tenantId: ALTO_TENANT_ID }, now), new Date(now.getTime() - 90 * DAY), now);
    expect(expected.separations).toBe(1);
    expect(p.turnover.annualizedPct90d).toBe(expected.annualizedPct);
    expect(p.turnover.annualizedPct90d).toBeGreaterThan(0);
  });
});

describe('every risk opens somewhere its reader can go (LEAD-6)', () => {
  /** The pages a risk may open, and the capability their route needs (App.tsx RequireCapability). */
  const GATE: Array<[RegExp, Capability]> = [
    [/^\/executive\//, 'view:executive'],
    [/^\/compliance(\/osha)?(\?|$)/, 'view:compliance'],
    [/^\/expirations(\?|$)/, 'view:org'],
    [/^\/call-outs(\?|$)/, 'view:scheduling'],
    [/^\/clients\/nps(\?|$)/, 'view:executive'],
  ];
  const execRoles = (Object.keys(ROLE_CAPABILITIES) as Role[]).filter((r) => ROLE_CAPABILITIES[r].has('view:executive'));

  it('sends no view:executive role to a desk it cannot open, nor the chairman to her own leave page; the desk rides along with its capability', async () => {
    const now = pinMidweekNoon();
    const tz = companyWorkweek().timezone;
    const dayOnly = (n: number) => new Date(`${localDateKey(new Date(now.getTime() + n * DAY), tz)}T00:00:00Z`);
    // A store with someone placed and no supervisor; a leave notice owed for two weeks; a late
    // unemployment response; a late workers' comp first report.
    const { site } = await clientWithSite('Bare Store Co');
    const a = await placed(site.id, 'Lee');
    await prisma.leaveCase.create({ data: { tenantId: ALTO_TENANT_ID, associateId: a.id, type: 'FMLA', reason: 'OWN_HEALTH', startDate: dayOnly(5), status: 'REQUESTED', createdAt: new Date(now.getTime() - 14 * DAY) } });
    await prisma.unemploymentClaim.create({ data: { associateId: a.id, state: 'FL', status: 'NEW', claimDate: dayOnly(-15), noticeReceivedAt: dayOnly(-12), responseDueAt: dayOnly(-5) } });
    await prisma.wcClaim.create({ data: { tenantId: ALTO_TENANT_ID, associateId: a.id, jurisdiction: 'FL', injuryDate: new Date(now.getTime() - 20 * DAY), reportedToEmployerAt: dayOnly(-19), froiDueAt: dayOnly(-10) } });

    const agent = await chairman();
    const body = (await agent.get('/executive/risks')).body as ExecRisks;
    expect(body.timezone).toBe(tz);
    const ids = body.risks.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['site-supervisor', 'leave-deadlines', 'ui-claim-deadlines', 'wc-report-deadlines']));

    for (const r of body.risks) {
      const gate = GATE.find(([re]) => re.test(r.href));
      expect(gate, `${r.id} → ${r.href}`).toBeDefined();
      for (const role of execRoles) expect(ROLE_CAPABILITIES[role].has(gate![1]), `${role} cannot open ${r.href}`).toBe(true);
      expect(r.href.startsWith('/leave'), r.id).toBe(false);
      if (r.desk) {
        expect(Object.values(ROLE_CAPABILITIES).some((caps) => caps.has(r.desk!.requires)), r.id).toBe(true);
        expect(r.desk.label.length).toBeGreaterThan(5);
      }
    }

    const leave = body.risks.find((r) => r.id === 'leave-deadlines')!;
    expect(leave.href).toBe('/executive/risk?open=leave-deadlines');
    expect(leave.desk).toMatchObject({ requires: 'manage:leave', href: '/leave?status=notices' });
    expect(leave.items).toHaveLength(1);
    expect(leave.items![0]!.label).toBe('Eligibility and rights notice');
    expect(leave.items![0]!.sub).toMatch(/^Due [A-Z][a-z]{2} \d{1,2} · \d+ days? late$/);
    // The register lists what is owed, never who or why: leave carries medical facts.
    expect(JSON.stringify(leave)).not.toMatch(/Lee|FMLA|OWN_HEALTH|health/i);

    const ui = body.risks.find((r) => r.id === 'ui-claim-deadlines')!;
    expect(ui.desk).toMatchObject({ requires: 'manage:claims', href: '/claims/unemployment' });
    expect(ui.items![0]!.label).toBe('Response to the state');
    expect(body.risks.find((r) => r.id === 'wc-report-deadlines')!.desk).toMatchObject({ requires: 'manage:claims', href: '/claims/workers-comp' });

    const sup = body.risks.find((r) => r.id === 'site-supervisor')!;
    expect(sup.desk).toMatchObject({ requires: 'manage:org', href: '/scheduling/supervisors' });
    expect(sup.items!.map((i) => i.label)).toContain('Bare Store Co');
  });
});
