import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeAssociateEarnings } from '../../lib/associateEarnings.js';
import { computeStatementSnapshot } from '../../lib/clientStatement.js';
import { laborSharesForEntries } from '../../lib/entryLaborShares.js';
import { penaltyAmount } from '../../lib/laborRules/hours.js';
import { loadRulePool } from '../../lib/laborRules/store.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { PAYROLL_SHEET_ENTRY_INCLUDE, buildPayrollSheetForPay } from '../../lib/payrollSheet.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

/**
 * Audit 2026-10-21 #11 — the golden week: every view of the same punches
 * splits them the same way. For a week covering California daily overtime,
 * double time and the seventh day, a New York spread-of-hours day, a
 * federal-only state, a minor, a California split shift, and a person
 * working two clients, the PAYCHECK (aggregatePayrollProjection), the
 * PAYROLL SHEET (buildPayrollSheetForPay), the ASSOCIATE'S ESTIMATE
 * (computeAssociateEarnings), the CLIENT STATEMENT (computeStatementSnapshot)
 * and the TIME LISTS' per-entry shares (laborSharesForEntries) must agree on
 * regular, overtime and double-time hours — and the sheet and the estimate
 * on the premiums the check pays.
 *
 * Before the one engine, the sheet ran its own daily rule off the home
 * state's table, the statement and the estimate "40 h at 1.5×", and the
 * statement billed a two-client week's overtime to BOTH clients.
 *
 * California and New York are LIVE (signed); Texas and Florida are not.
 * The week is Saturday 26 September – Friday 2 October 2026 (daylight time).
 */

const H = 3_600_000;
const at = (offset: number) => (ymd: string, h: number) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + (h + offset) * H);
const pt = at(7);
const et = at(4);
const ctz = at(5);
const DAYS = ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'] as const;
const PERIOD_START = new Date('2026-09-26T04:00:00.000Z'); // Saturday 00:00 Eastern
const PERIOD_END = new Date('2026-10-03T07:00:00.000Z'); // after Friday midnight Pacific
const NOW = new Date('2026-10-03T03:30:00.000Z'); // Friday 23:30 Eastern: the week is worked, not over

type Buckets = { regular: number; overtime: number; doubleTime: number };
const r2 = (n: number) => Math.round(n * 100) / 100;
const b = (regular: number, overtime: number, doubleTime: number): Buckets => ({ regular: r2(regular), overtime: r2(overtime), doubleTime: r2(doubleTime) });

interface Person {
  key: string;
  id: string;
  rate: number;
  clientIds: string[];
  expected: Buckets;
  /** Premium hours the check pays (after any minimum-wage offset). */
  premiumHours: number;
}

const people: Person[] = [];

async function siteFor(name: string, state: string, city: string, timezone: string) {
  const client = await createClient(name);
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { state, city, timezone } });
  return { client, site };
}

async function person(key: string, rate: number, opts: { dob?: Date } = {}) {
  const a = await createAssociate({ firstName: key, lastName: 'Golden' });
  if (opts.dob) await prisma.associate.update({ where: { id: a.id }, data: { dob: opts.dob } });
  await prisma.compensationRecord.create({ data: { associateId: a.id, payType: 'HOURLY', amount: rate, currency: 'USD', reason: 'HIRE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  return a;
}

async function work(associateId: string, s: { client: { id: string }; site: { id: string } }, clockInAt: Date, clockOutAt: Date, breaks: Array<{ type: 'MEAL' | 'REST'; startedAt: Date; endedAt: Date }> = []) {
  await prisma.timeEntry.create({
    data: {
      associateId,
      clientId: s.client.id,
      locationId: s.site.id,
      clockInAt,
      clockOutAt,
      status: 'APPROVED',
      approvedAt: new Date(),
      ...(breaks.length ? { breaks: { create: breaks } } : {}),
    },
  });
}

/** A clean California day: a 30-minute meal by hour 5 (and a second by hour 10), a 10-minute rest per four hours. No premiums owed. */
function caBreaks(ymd: string, from: number, hours: number) {
  const out: Array<{ type: 'MEAL' | 'REST'; startedAt: Date; endedAt: Date }> = [];
  for (let h = from + 2; h < from + hours; h += 4) out.push({ type: 'REST', startedAt: pt(ymd, h), endedAt: new Date(pt(ymd, h).getTime() + 10 * 60_000) });
  if (hours > 5) out.push({ type: 'MEAL', startedAt: pt(ymd, from + 4), endedAt: new Date(pt(ymd, from + 4).getTime() + 30 * 60_000) });
  if (hours > 10) out.push({ type: 'MEAL', startedAt: pt(ymd, from + 9), endedAt: new Date(pt(ymd, from + 9).getTime() + 30 * 60_000) });
  return out;
}

beforeAll(async () => {
  await truncateAll();

  const la = await siteFor('Golden Venice Beach', 'CA', 'Los Angeles', 'America/Los_Angeles');
  const sd = await siteFor('Golden Mission Bay', 'CA', 'San Diego', 'America/Los_Angeles');
  const sm = await siteFor('Golden Santa Monica', 'CA', 'Santa Monica', 'America/Los_Angeles');
  const albany = await siteFor('Golden Albany Plaza', 'NY', 'Albany', 'America/New_York');
  const houston = await siteFor('Golden Galleria', 'TX', 'Houston', 'America/Chicago');
  const destin = await siteFor('Golden Destin Store', 'FL', 'Destin', 'America/New_York');
  const pensacola = await siteFor('Golden Pensacola Store', 'FL', 'Pensacola', 'America/Chicago');

  // California and New York paid LIVE: the tenant signed the federal, state and city rows in force.
  const pool = await loadRulePool(prisma, ALTO_TENANT_ID);
  for (const j of ['US-CA', 'US-NY']) {
    await prisma.laborRuleActivation.create({
      data: {
        jurisdiction: j,
        status: 'LIVE',
        signedSetIds: pool.filter((s) => s.jurisdiction === 'FEDERAL' || s.jurisdiction === j || s.jurisdiction.startsWith(`${j}-`)).map((s) => s.id),
        counselName: 'Dana Whit',
        counselFirm: 'Whit & Co LLP',
        counselSignedOn: new Date('2026-09-01T00:00:00Z'),
        attestation: 'signed',
        activatedAt: new Date('2026-09-02T00:00:00Z'),
      },
    });
  }

  // 1. California, seven consecutive days with clean breaks: Sat 10 h, Sun 13 h, Mon–Wed 8 h, Thu 4 h, Fri 9 h (the seventh day).
  //    Daily: Sat 8 + 2 OT; Sun 8 + 4 OT + 1 DT; Mon–Wed 24 (40 regular); Thu 4 OT (past the weekly 40); Fri 8 OT + 1 DT.
  const ana = await person('Ana', 22);
  const anaHours = [10, 13, 8, 8, 8, 4, 9];
  for (const [i, h] of anaHours.entries()) {
    const breaks = caBreaks(DAYS[i]!, 6, h);
    // Rests of 10 minutes are paid; the meals are docked, so clock out later by the meal time.
    const mealMs = breaks.filter((x) => x.type === 'MEAL').length * 30 * 60_000;
    await work(ana.id, la, pt(DAYS[i]!, 6), new Date(pt(DAYS[i]!, 6 + h).getTime() + mealMs), breaks);
  }
  people.push({ key: 'ca-daily-seventh', id: ana.id, rate: 22, clientIds: [la.client.id], expected: b(40, 18, 2), premiumHours: 0 });

  // 2. New York (Albany, live): Monday 08–12 and 17–21 (a 13-hour spread), plus Tue–Sat 8 h: 48 h → 40 + 8 OT.
  //    At New York's minimum wage the spread-of-hours hour is owed in full.
  const ben = await person('Ben', 16);
  await work(ben.id, albany, et('2026-09-28', 8), et('2026-09-28', 12));
  await work(ben.id, albany, et('2026-09-28', 17), et('2026-09-28', 21));
  for (const d of ['2026-09-26', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) await work(ben.id, albany, et(d, 8), et(d, 16));
  people.push({ key: 'ny-spread', id: ben.id, rate: 16, clientIds: [albany.client.id], expected: b(40, 8, 0), premiumHours: 1 });

  // 3. Texas, federal only (no pack, not live): 5 × 9 h → 40 + 5, no daily rule.
  const cal = await person('Cal', 18);
  for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) await work(cal.id, houston, ctz(d, 7), ctz(d, 16));
  people.push({ key: 'tx-federal', id: cal.id, rate: 18, clientIds: [houston.client.id], expected: b(40, 5, 0), premiumHours: 0 });

  // 4. A minor (15) in California (live): a 9-hour Saturday with clean breaks → 8 + 1 daily OT; two 3-hour school days.
  const dee = await person('Dee', 17, { dob: new Date('2011-05-01T00:00:00Z') });
  await work(dee.id, sd, pt('2026-09-26', 8), new Date(pt('2026-09-26', 17).getTime() + 30 * 60_000), caBreaks('2026-09-26', 8, 9));
  for (const d of ['2026-09-29', '2026-10-01']) await work(dee.id, sd, pt(d, 16), pt(d, 19), caBreaks(d, 16, 3));
  people.push({ key: 'ca-minor', id: dee.id, rate: 17, clientIds: [sd.client.id], expected: b(14, 1, 0), premiumHours: 0 });

  // 5. A California split shift at the minimum wage ($16.90): Tuesday 06–10 and 14–18 → the split-shift hour, owed in full.
  const eli = await person('Eli', 16.9);
  await work(eli.id, sm, pt('2026-09-29', 6), pt('2026-09-29', 10), [{ type: 'REST', startedAt: pt('2026-09-29', 8), endedAt: new Date(pt('2026-09-29', 8).getTime() + 10 * 60_000) }]);
  await work(eli.id, sm, pt('2026-09-29', 14), pt('2026-09-29', 18), [{ type: 'REST', startedAt: pt('2026-09-29', 16), endedAt: new Date(pt('2026-09-29', 16).getTime() + 10 * 60_000) }]);
  people.push({ key: 'ca-split-shift', id: eli.id, rate: 16.9, clientIds: [sm.client.id], expected: b(8, 0, 0), premiumHours: 1 });

  // 6. Two clients and two zones in Florida (not live): Destin Sat–Tue 8 h (32), then Pensacola Wed–Thu 8 h → 48 h:
  //    40 + 8 OT, the overtime on the LATEST hours (Pensacola Thursday and half of Wednesday).
  const fay = await person('Fay', 15);
  for (const d of ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']) await work(fay.id, destin, et(d, 8), et(d, 16));
  for (const d of ['2026-09-30', '2026-10-01']) await work(fay.id, pensacola, ctz(d, 8), ctz(d, 16));
  people.push({ key: 'fl-two-clients', id: fay.id, rate: 15, clientIds: [destin.client.id, pensacola.client.id], expected: b(40, 8, 0), premiumHours: 0 });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the golden week: every view splits the same punches the same way', () => {
  it('the paycheck, the sheet, the estimate, the statement and the time lists agree on regular, overtime and double time', async () => {
    const projection = await aggregatePayrollProjection(prisma, { periodStart: PERIOD_START, periodEndExclusive: PERIOD_END, clientId: null, defaultRate: 15 });
    const entries = await prisma.timeEntry.findMany({ where: { status: 'APPROVED', clockInAt: { gte: PERIOD_START, lt: PERIOD_END } }, include: PAYROLL_SHEET_ENTRY_INCLUDE, orderBy: { clockInAt: 'asc' } });
    const sheet = await buildPayrollSheetForPay(prisma, entries);
    const shares = await laborSharesForEntries(prisma, entries, { statuses: ['APPROVED'], now: NOW });
    const statements = new Map<string, Awaited<ReturnType<typeof computeStatementSnapshot>>>();
    for (const clientId of new Set(people.flatMap((p) => p.clientIds))) statements.set(clientId, await computeStatementSnapshot(prisma, clientId, PERIOD_START, PERIOD_END));

    for (const p of people) {
      const item = projection.items.find((i) => i.associateId === p.id)!;
      const paycheck = b(item.regularHours, item.overtimeHours, item.doubleTimeHours);
      expect({ who: p.key, paycheck }).toEqual({ who: p.key, paycheck: p.expected });

      const row = sheet.associates.find((a) => a.associateId === p.id)!;
      expect({ who: p.key, sheet: b(row.regularMinutes / 60, row.overtimeMinutes / 60, row.doubleTimeMinutes / 60) }).toEqual({ who: p.key, sheet: paycheck });

      const estimate = await computeAssociateEarnings(prisma, p.id, NOW);
      expect({ who: p.key, estimate: b(estimate.hours.regular, estimate.hours.overtime, estimate.hours.doubleTime) }).toEqual({ who: p.key, estimate: paycheck });

      // Statements: this person's buckets across their clients' statements (each statement here bills only them).
      const billed = p.clientIds.map((c) => statements.get(c)!.totals);
      expect({ who: p.key, statement: b(billed.reduce((a, t) => a + t.regularHours, 0), billed.reduce((a, t) => a + t.otHours, 0), billed.reduce((a, t) => a + (t.doubleTimeHours ?? 0), 0)) }).toEqual({ who: p.key, statement: paycheck });

      const mine = entries.filter((e) => e.associateId === p.id).map((e) => shares.get(e.id)!);
      expect({ who: p.key, lists: b(mine.reduce((a, s) => a + s.regularMinutes, 0) / 60, mine.reduce((a, s) => a + s.overtimeMinutes, 0) / 60, mine.reduce((a, s) => a + s.doubleTimeMinutes, 0) / 60) }).toEqual({ who: p.key, lists: paycheck });

      // Premiums: the check's PREMIUM lines, the sheet's premiums that are owed at this rate, and the estimate.
      const paidPremium = item.earnings.filter((e) => e.kind === 'PREMIUM').reduce((a, e) => a + (e.hours ?? 0), 0);
      const sheetPremium = row.premiums.filter((x) => penaltyAmount(x, p.rate) >= 0.005).reduce((a, x) => a + x.hours, 0);
      expect({ who: p.key, paidPremium, sheetPremium, estimatePremium: estimate.hours.premium }).toEqual({ who: p.key, paidPremium: p.premiumHours, sheetPremium: p.premiumHours, estimatePremium: p.premiumHours });
    }
  });

  it('a two-client week bills its overtime once — to the client whose hours came last', async () => {
    const fay = people.find((p) => p.key === 'fl-two-clients')!;
    const [destin, pensacola] = await Promise.all(fay.clientIds.map((c) => computeStatementSnapshot(prisma, c, PERIOD_START, PERIOD_END)));
    expect(b(destin!.totals.regularHours, destin!.totals.otHours, 0)).toEqual(b(32, 0, 0));
    expect(b(pensacola!.totals.regularHours, pensacola!.totals.otHours, 0)).toEqual(b(8, 8, 0));
  });

  it('the spread-of-hours and split-shift lines name their rule sets on the check', async () => {
    const projection = await aggregatePayrollProjection(prisma, { periodStart: PERIOD_START, periodEndExclusive: PERIOD_END, clientId: null, defaultRate: 15 });
    const lines = (key: string) => projection.items.find((i) => i.associateId === people.find((p) => p.key === key)!.id)!.earnings.filter((e) => e.kind === 'PREMIUM');
    expect(lines('ny-spread')).toEqual([expect.objectContaining({ hours: 1, rate: 16, amount: 16, note: 'Spread-of-hours pay (US-NY 2026-01-01 v2)' })]);
    expect(lines('ca-split-shift')).toEqual([expect.objectContaining({ hours: 1, rate: 16.9, amount: 16.9, note: 'Split-shift premium (US-CA 2026-01-01 v2)' })]);
  });
});
