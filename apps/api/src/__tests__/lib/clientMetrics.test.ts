import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clientMetrics, clientWeeks, healthFor, type HealthSignals } from '../../lib/clientMetrics.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

/**
 * lib/clientMetrics — the account numbers the clients list and a client's
 * overview read. Seeded data, exact values: hours by the client's week on
 * the site's clock, overtime through the labor engine across clients, the
 * fill rate's population, aging net of payments, billed in range, margin
 * on what was billed, the health rules each way, and money omitted
 * without includeMoney.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const H = 3_600_000;
// Thursday 2026-10-22, 14:00 in New York, 13:00 in Chicago.
const NOW = new Date('2026-10-22T18:00:00.000Z');
const OCTOBER = { from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2026-10-22T00:00:00.000Z') };
const at = (iso: string) => new Date(iso);

async function clientWith(name: string, opts: { weekStartsOn?: number; timezone?: string } = {}) {
  const c = await createClient(name);
  await prisma.client.update({ where: { id: c.id }, data: { weekStartsOn: opts.weekStartsOn ?? 6 } });
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
  if (opts.timezone) await prisma.site.update({ where: { id: site.id }, data: { timezone: opts.timezone } });
  return { client: c, site };
}

async function punch(associateId: string, clientId: string, locationId: string, inIso: string, hours: number, opts: { status?: 'APPROVED' | 'COMPLETED' | 'REJECTED' | 'ACTIVE'; breakMinutes?: number } = {}) {
  const clockInAt = at(inIso);
  const open = opts.status === 'ACTIVE';
  const e = await prisma.timeEntry.create({
    data: { associateId, clientId, locationId, clockInAt, clockOutAt: open ? null : new Date(clockInAt.getTime() + hours * H), status: opts.status ?? 'APPROVED' },
  });
  if (opts.breakMinutes) {
    const start = new Date(clockInAt.getTime() + 4 * H);
    await prisma.breakEntry.create({ data: { timeEntryId: e.id, type: 'MEAL', startedAt: start, endedAt: new Date(start.getTime() + opts.breakMinutes * 60_000) } });
  }
  return e;
}

describe('hours by the client’s week, on the site’s clock', () => {
  it('splits a Wednesday-start client’s week at midnight in Chicago, not in UTC or on the company’s Saturday', async () => {
    const { client: z, site } = await clientWith('Zenith Labs', { weekStartsOn: 3, timezone: 'America/Chicago' });
    const a = await createAssociate({ firstName: 'Ana' });
    const b = await createAssociate({ firstName: 'Bo' });
    // Tuesday 23:00 in Chicago (already Wednesday in UTC): last week.
    await punch(a.id, z.id, site.id, '2026-10-21T04:00:00.000Z', 4);
    // Wednesday 01:00 in Chicago: this week.
    await punch(b.id, z.id, site.id, '2026-10-21T06:00:00.000Z', 3);
    // Neither a rejected punch nor one still open counts.
    await punch(b.id, z.id, site.id, '2026-10-21T15:00:00.000Z', 6, { status: 'REJECTED' });
    await punch(a.id, z.id, site.id, '2026-10-22T14:00:00.000Z', 0, { status: 'ACTIVE' });

    const m = (await clientMetrics([z.id], { range: OCTOBER, includeMoney: false, now: NOW })).get(z.id)!;
    expect(m.hoursThisWeek).toBe(3);
    expect(m.hoursLastWeek).toBe(4);
    expect(m.overtimePct).toBe(0);
  });

  it('docks breaks and reads overtime from the engine over each person’s whole week, at every client', async () => {
    const { client: x, site: xs } = await clientWith('Harbor Hotel');
    const { client: y, site: ys } = await clientWith('Yard Market');
    const a = await createAssociate({ firstName: 'Cy' });
    // Last week (Sat 10-10 → Fri 10-16, New York): 5 h at Yard first, then 5 × 9 h at Harbor = 50 h.
    await punch(a.id, y.id, ys.id, '2026-10-10T14:00:00.000Z', 5);
    for (const day of ['11', '12', '13', '14', '15']) await punch(a.id, x.id, xs.id, `2026-10-${day}T13:00:00.000Z`, 9);
    // This week: 8 h with a 30-minute meal.
    await punch(a.id, x.id, xs.id, '2026-10-19T13:00:00.000Z', 8, { breakMinutes: 30 });

    const all = await clientMetrics([x.id, y.id], { range: OCTOBER, includeMoney: false, now: NOW });
    const hx = all.get(x.id)!;
    const hy = all.get(y.id)!;
    expect(hx.hoursLastWeek).toBe(45);
    expect(hx.hoursThisWeek).toBe(7.5);
    // The 10 hours past 40 are the week's latest — all at Harbor: 10 / 45.
    expect(hx.overtimePct).toBe(22.2);
    expect(hy.hoursLastWeek).toBe(5);
    expect(hy.overtimePct).toBe(0);
    expect(hy.hoursThisWeek).toBe(0);
  });

  it('gives null overtime, not 0%, with no hours last week', async () => {
    const { client } = await clientWith('Quiet Co');
    const m = (await clientMetrics([client.id], { range: OCTOBER, includeMoney: false, now: NOW })).get(client.id)!;
    expect(m.hoursThisWeek).toBe(0);
    expect(m.overtimePct).toBeNull();
    expect(m.fillRatePct).toBeNull();
    expect(m.health).toBe('good');
    expect(m.healthReasons).toEqual([]);
  });

  it('reads the same weeks week by week for the Performance tab', async () => {
    const { client: x, site: xs } = await clientWith('Harbor Hotel');
    const { client: y, site: ys } = await clientWith('Yard Market');
    const a = await createAssociate({ firstName: 'Cy' });
    await punch(a.id, y.id, ys.id, '2026-10-10T14:00:00.000Z', 5);
    for (const day of ['11', '12', '13', '14', '15']) await punch(a.id, x.id, xs.id, `2026-10-${day}T13:00:00.000Z`, 9);
    await punch(a.id, x.id, xs.id, '2026-10-05T13:00:00.000Z', 6);
    // Shifts that started in the week before last: 4 published, 3 filled; a draft and a cancelled one don't count.
    const shift = (startIso: string, assigned: boolean, extra: Record<string, unknown> = {}) =>
      prisma.shift.create({ data: { clientId: x.id, locationId: xs.id, position: 'Associate', startsAt: at(startIso), endsAt: new Date(at(startIso).getTime() + 8 * H), status: assigned ? 'ASSIGNED' : 'OPEN', assignedAssociateId: assigned ? a.id : null, publishedAt: at('2026-09-30T12:00:00.000Z'), ...extra } });
    await shift('2026-10-04T13:00:00.000Z', true);
    await shift('2026-10-05T13:00:00.000Z', true);
    await shift('2026-10-06T13:00:00.000Z', true);
    await shift('2026-10-07T13:00:00.000Z', false);
    await shift('2026-10-08T13:00:00.000Z', true, { status: 'DRAFT', publishedAt: null });
    await shift('2026-10-08T13:00:00.000Z', false, { status: 'CANCELLED' });

    const w = (await clientWeeks(x.id, { weeks: 12, now: NOW }))!;
    expect(w.weeks).toHaveLength(12);
    expect(w.weeks[11]!.start).toBe('2026-10-10');
    expect(w.weeks[10]!.start).toBe('2026-10-03');
    expect(w.weeks[0]!.start).toBe('2026-07-25');
    expect(w.weeks[11]).toMatchObject({ hours: 45, overtimeHours: 10, overtimePct: 22.2, shifts: 0, filled: 0, fillRatePct: null });
    expect(w.weeks[10]).toMatchObject({ hours: 6, overtimeHours: 0, overtimePct: 0, shifts: 4, filled: 3, fillRatePct: 75 });
    expect(w.weeks[9]).toMatchObject({ hours: 0, overtimePct: null, shifts: 0, fillRatePct: null });
  });
});

describe('fill rate and health', () => {
  it('counts published, not cancelled shifts starting in the next 7 days; filled = someone assigned', async () => {
    const { client: x, site: xs } = await clientWith('Harbor Hotel');
    const { client: y, site: ys } = await clientWith('Yard Market');
    const { client: z } = await clientWith('Zenith Labs');
    const a = await createAssociate({ firstName: 'Di' });
    const make = (clientId: string, locationId: string, hoursAhead: number, filled: boolean, extra: Record<string, unknown> = {}) =>
      prisma.shift.create({
        data: {
          clientId,
          locationId,
          position: 'Associate',
          startsAt: new Date(NOW.getTime() + hoursAhead * H),
          endsAt: new Date(NOW.getTime() + (hoursAhead + 8) * H),
          status: filled ? 'ASSIGNED' : 'OPEN',
          assignedAssociateId: filled ? a.id : null,
          publishedAt: NOW,
          ...extra,
        },
      });
    for (let i = 0; i < 10; i++) await make(x.id, xs.id, 6 + i * 12, i < 7);
    // None of these count: a draft, a cancelled shift, an unpublished one, one 8 days out, one that already started.
    await make(x.id, xs.id, 10, true, { status: 'DRAFT', publishedAt: null });
    await make(x.id, xs.id, 10, false, { status: 'CANCELLED' });
    await make(x.id, xs.id, 10, false, { publishedAt: null });
    await make(x.id, xs.id, 8 * 24, false);
    await make(x.id, xs.id, -2, false);
    for (let i = 0; i < 20; i++) await make(y.id, ys.id, 6 + i * 6, i < 18);

    const all = await clientMetrics([x.id, y.id, z.id], { range: OCTOBER, includeMoney: false, now: NOW });
    expect(all.get(x.id)).toMatchObject({ shiftsNext7: { total: 10, filled: 7 }, fillRatePct: 70, health: 'risk' });
    expect(all.get(x.id)!.healthReasons).toEqual(['7 of 10 shifts in the next 7 days filled (70%)']);
    expect(all.get(y.id)).toMatchObject({ shiftsNext7: { total: 20, filled: 18 }, fillRatePct: 90, health: 'watch' });
    expect(all.get(z.id)).toMatchObject({ shiftsNext7: { total: 0, filled: 0 }, fillRatePct: null, health: 'good' });
  });

  it('flags a contract that ends within 30 days, and an NPS detractor in the last 90 days', async () => {
    const { client: x } = await clientWith('Harbor Hotel');
    const { client: y } = await clientWith('Yard Market');
    const { client: z } = await clientWith('Zenith Labs');
    await prisma.client.update({ where: { id: x.id }, data: { contractEndDate: new Date('2026-11-11T00:00:00.000Z') } });
    await prisma.client.update({ where: { id: z.id }, data: { contractEndDate: new Date('2026-12-06T00:00:00.000Z') } });
    const wave = await prisma.clientNpsWave.create({ data: { quarter: '2026-Q3', closesAt: at('2026-10-30T00:00:00.000Z') } });
    const invite = (clientId: string, score: number, daysAgo: number, n: number) =>
      prisma.clientNpsInvite.create({ data: { waveId: wave.id, clientId, email: `m${n}@example.com`, tokenHash: `hash-${n}-${clientId}`.slice(0, 64), expiresAt: NOW, respondedAt: new Date(NOW.getTime() - daysAgo * DAY), score } });
    await invite(y.id, 4, 30, 1);
    await invite(y.id, 9, 10, 2);
    await invite(z.id, 2, 100, 3);

    const all = await clientMetrics([x.id, y.id, z.id], { range: OCTOBER, includeMoney: false, now: NOW });
    expect(all.get(x.id)).toMatchObject({ health: 'risk', healthReasons: ['Contract ends in 20 days (Nov 11, 2026)'] });
    expect(all.get(y.id)).toMatchObject({ health: 'risk', healthReasons: ['NPS detractor (scored 4) in the last 90 days'] });
    // 45 days out is a watch; a detractor 100 days ago no longer counts.
    expect(all.get(z.id)).toMatchObject({ health: 'watch', healthReasons: ['Contract ends in 45 days (Dec 6, 2026)'] });
  });

  it('applies each rule both ways', () => {
    const base: HealthSignals = { shiftsNext7: { total: 0, filled: 0 }, fillRatePct: null, contractEndDate: null, detractorScores: [], now: NOW };
    const fill = (total: number, filled: number): Partial<HealthSignals> => ({ shiftsNext7: { total, filled }, fillRatePct: (filled / total) * 100 });
    expect(healthFor(base)).toEqual({ health: 'good', reasons: [] });
    expect(healthFor({ ...base, ...fill(10, 7) }).health).toBe('risk');
    expect(healthFor({ ...base, ...fill(4, 2) }).health).toBe('watch');
    expect(healthFor({ ...base, ...fill(20, 18) }).health).toBe('watch');
    expect(healthFor({ ...base, ...fill(100, 94) }).health).toBe('watch');
    expect(healthFor({ ...base, ...fill(20, 19) }).health).toBe('good');
    expect(healthFor({ ...base, contractEndDate: '2026-10-01' })).toEqual({ health: 'risk', reasons: ['Contract ended Oct 1, 2026'] });
    expect(healthFor({ ...base, contractEndDate: '2026-10-22' })).toEqual({ health: 'risk', reasons: ['Contract ends today'] });
    expect(healthFor({ ...base, contractEndDate: '2026-11-21' }).health).toBe('risk');
    expect(healthFor({ ...base, contractEndDate: '2026-11-22' }).health).toBe('watch');
    expect(healthFor({ ...base, contractEndDate: '2026-12-21' }).health).toBe('watch');
    expect(healthFor({ ...base, contractEndDate: '2026-12-22' }).health).toBe('good');
    expect(healthFor({ ...base, detractorScores: [6, 3] })).toEqual({ health: 'risk', reasons: ['2 NPS detractors in the last 90 days (lowest 3)'] });
    expect(healthFor({ ...base, pastDue: { d1_30: 1200, d31plus: 0, oldestDays: 0, oldestD1_30: 12 } })).toEqual({ health: 'watch', reasons: ['$1,200 is 12 days past due'] });
    expect(healthFor({ ...base, pastDue: { d1_30: 0, d31plus: 5760, oldestDays: 34, oldestD1_30: 0 } })).toEqual({ health: 'risk', reasons: ['$5,760 is 34 days past due'] });
    expect(healthFor({ ...base, pastDue: { d1_30: 0, d31plus: 0, oldestDays: 0, oldestD1_30: 0 } }).health).toBe('good');
  });
});

describe('on assignment', () => {
  it('is the one definition of active, by placement', async () => {
    const { client: x, site: xs } = await clientWith('Harbor Hotel');
    const { client: y, site: ys } = await clientWith('Yard Market');
    const place = (associateId: string, locationId: string) => prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: at('2026-05-01T00:00:00.000Z') } });
    const worked = await createAssociate({ firstName: 'Ed' });
    await place(worked.id, xs.id);
    await punch(worked.id, x.id, xs.id, '2026-10-19T13:00:00.000Z', 8);
    const idle = await createAssociate({ firstName: 'Fay' });
    await place(idle.id, xs.id);
    // Placed at Yard by an approved application, with a shift ahead.
    const applied = await createAssociate({ firstName: 'Gus' });
    await prisma.application.create({ data: { associateId: applied.id, clientId: y.id, locationId: ys.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: at('2026-09-01T00:00:00.000Z') } });
    await prisma.shift.create({ data: { clientId: y.id, locationId: ys.id, position: 'Associate', startsAt: new Date(NOW.getTime() + DAY), endsAt: new Date(NOW.getTime() + DAY + 8 * H), status: 'ASSIGNED', assignedAssociateId: applied.id, publishedAt: NOW } });

    const one = await clientMetrics([x.id], { range: OCTOBER, includeMoney: false, now: NOW });
    expect(one.get(x.id)!.onAssignment).toBe(1);
    // The many-client path (the whole tenant at once) agrees with the few-client path.
    const extra = await Promise.all(Array.from({ length: 5 }, (_, i) => createClient(`Filler ${i}`)));
    const many = await clientMetrics([x.id, y.id, ...extra.map((c) => c.id)], { range: OCTOBER, includeMoney: false, now: NOW });
    expect(many.get(x.id)!.onAssignment).toBe(1);
    expect(many.get(y.id)!.onAssignment).toBe(1);
    expect(many.get(extra[0]!.id)!.onAssignment).toBe(0);
  });
});

describe('money', () => {
  async function seedStatements() {
    const { client: x } = await clientWith('Harbor Hotel');
    const statement = (start: string, end: string, amount: number, extra: Record<string, unknown> = {}) =>
      prisma.clientStatement.create({
        data: { clientId: x.id, periodStart: at(`${start}T00:00:00.000Z`), periodEnd: at(`${end}T00:00:00.000Z`), status: 'FINAL', finalizedAt: at(`${end}T20:00:00.000Z`), snapshot: { totals: { amount, hours: amount / 40 } }, ...extra },
      });
    await statement('2026-09-07', '2026-09-13', 5760, { dueAt: at('2026-09-18T00:00:00.000Z') });
    const partly = await statement('2026-09-28', '2026-10-04', 1000, { dueAt: at('2026-10-12T00:00:00.000Z') });
    await statement('2026-10-05', '2026-10-11', 2000, { dueAt: at('2026-10-30T00:00:00.000Z') });
    await statement('2026-10-12', '2026-10-18', 1500, { dueAt: at('2026-10-25T00:00:00.000Z'), paidAt: at('2026-10-20T00:00:00.000Z') });
    await statement('2026-10-19', '2026-10-25', 999, { status: 'DRAFT', finalizedAt: null });
    const payment = await prisma.clientPayment.create({ data: { clientId: x.id, receivedOn: at('2026-10-15T00:00:00.000Z'), amount: 400, method: 'ACH', depositAccountId: '00000000-0000-4000-8000-0000000000aa' } });
    await prisma.clientPaymentApplication.create({ data: { paymentId: payment.id, statementId: partly.id, amount: 400 } });
    return x;
  }

  it('ages what is open net of payments, bills by period end in the range, and names the late money', async () => {
    const x = await seedStatements();
    const m = (await clientMetrics([x.id], { range: OCTOBER, includeMoney: true, now: NOW })).get(x.id)!;
    expect(m.money).toEqual({
      billedInRange: 4500,
      outstanding: 8360,
      aging: { current: 2000, d1_30: 600, d31_60: 5760, d61_90: 0, d90plus: 0 },
      lastStatementTotal: 1500,
      lastStatementAt: '2026-10-18T20:00:00.000Z',
      marginPct: null,
    });
    expect(m.health).toBe('risk');
    expect(m.healthReasons).toEqual(['$5,760 is 34 days past due', '$600 is 10 days past due']);

    const sept = (await clientMetrics([x.id], { range: { from: at('2026-09-01T00:00:00.000Z'), to: at('2026-09-30T00:00:00.000Z') }, includeMoney: true, now: NOW })).get(x.id)!;
    expect(sept.money!.billedInRange).toBe(5760);
  });

  it('leaves money out entirely — fields and reasons — without includeMoney', async () => {
    const x = await seedStatements();
    const m = (await clientMetrics([x.id], { range: OCTOBER, includeMoney: false, now: NOW })).get(x.id)!;
    expect(m).not.toHaveProperty('money');
    expect(m.health).toBe('good');
    expect(m.healthReasons.join(' ')).not.toContain('$');
  });

  it('computes margin on billed hours against the wages and employer taxes paid for them, and null while any are unpaid', async () => {
    const { client: billed, site: bs } = await clientWith('Margin Inn');
    const { client: other, site: os } = await clientWith('Other Mart');
    const { client: unpaid, site: us } = await clientWith('Unpaid Depot');
    const p1 = await createAssociate({ firstName: 'Hal' });
    const p2 = await createAssociate({ firstName: 'Ivy' });
    // Revenue: the hours part of the statement ($1,000), never its sales tax.
    const snap = { totals: { amount: 1070, hoursAmount: 1000, adjustmentsAmount: 0, subtotal: 1000, salesTax: 70, salesTaxRatePct: 7, hours: 16 } };
    await prisma.clientStatement.create({ data: { clientId: billed.id, periodStart: at('2026-10-12T00:00:00.000Z'), periodEnd: at('2026-10-18T00:00:00.000Z'), status: 'FINAL', finalizedAt: at('2026-10-19T12:00:00.000Z'), snapshot: snap } });
    await prisma.clientStatement.create({ data: { clientId: unpaid.id, periodStart: at('2026-10-12T00:00:00.000Z'), periodEnd: at('2026-10-18T00:00:00.000Z'), status: 'FINAL', finalizedAt: at('2026-10-19T12:00:00.000Z'), snapshot: snap } });
    await punch(p1.id, billed.id, bs.id, '2026-10-13T13:00:00.000Z', 8);
    await punch(p1.id, billed.id, bs.id, '2026-10-14T13:00:00.000Z', 8);
    await punch(p1.id, other.id, os.id, '2026-10-15T13:00:00.000Z', 4);
    await punch(p2.id, unpaid.id, us.id, '2026-10-13T13:00:00.000Z', 8);
    // One check for p1's 20 hours: $400 of wages and $30.60 of employer taxes. p2 is not paid yet.
    const run = await prisma.payrollRun.create({ data: { periodStart: at('2026-10-10T00:00:00.000Z'), periodEnd: at('2026-10-23T00:00:00.000Z'), status: 'FINALIZED' } });
    const item = await prisma.payrollItem.create({
      data: { payrollRunId: run.id, associateId: p1.id, hoursWorked: 20, hourlyRate: 20, grossPay: 400, federalWithholding: 0, netPay: 369.4, employerFica: 24.8, employerMedicare: 5.8 },
    });
    await prisma.payrollItemEarning.create({ data: { payrollItemId: item.id, kind: 'REGULAR', hours: 20, rate: 20, amount: 400 } });

    const all = await clientMetrics([billed.id, unpaid.id], { range: OCTOBER, includeMoney: true, now: NOW });
    // 16 h × $20 × (1 + 30.60 / 400) = $344.48 against $1,000 billed.
    expect(all.get(billed.id)!.money!.marginPct).toBe(65.6);
    expect(all.get(unpaid.id)!.money!.marginPct).toBeNull();
  });
});
