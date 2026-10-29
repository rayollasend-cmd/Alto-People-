import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPayPreview, roundDaysToTotal } from '../../lib/payPreview.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The associate's "check your pay before payday" (ASSOC-1, ASSOC-28): the
 * take-home Maria is asked to confirm is the one the run will pay — ride
 * charges payroll takes from that check come off it — and the days add up
 * to the pay lines' hours, each on the store's calendar day.
 */

const H = 3_600_000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Biweekly Sat→Fri paid the Friday after: Sep 12–25 pays Fri Oct 2. A Chicago store. */
async function seed(rate = 20) {
  const client = await createClient();
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: store.id }, data: { timezone: 'America/Chicago' } });
  const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const schedule = await prisma.payrollSchedule.create({
    data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-01-03T00:00:00Z'), payDateOffsetDays: 7 },
  });
  await prisma.associate.update({ where: { id: associate.id }, data: { state: 'FL', payrollScheduleId: schedule.id } });
  await prisma.compensationRecord.create({
    data: { associateId: associate.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), payType: 'HOURLY', amount: rate, reason: 'HIRE' },
  });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const shift = (clockInAt: string, hours: number) =>
    prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        locationId: store.id,
        clockInAt: new Date(clockInAt),
        clockOutAt: new Date(new Date(clockInAt).getTime() + hours * H),
        status: 'APPROVED',
      },
    });
  const ride = (serviceDate: string, status: 'COMPLETED' | 'NO_SHOW', chargeCents: number, extra: Record<string, unknown> = {}) =>
    prisma.ride.create({
      data: {
        associateId: associate.id,
        direction: 'TO_WORK',
        locationId: store.id,
        address: '12 Oak St',
        targetAt: new Date(`${serviceDate}T13:00:00.000Z`),
        serviceDate,
        status,
        fareCents: 500,
        noShowFeeCents: 100,
        chargeCents,
        authorizedSignatureId: randomUUID(),
        createdById: hr.id,
        ...extra,
      },
    });
  return { client, store, associate, shift, ride };
}

// Wed Sep 30, 10 AM Chicago: the preview for Fri Oct 2 is open.
const OPEN = new Date('2026-09-30T15:00:00Z');

describe('pay before payday — the estimate is the check', () => {
  it('ride charges payroll takes from this check come off the take-home, as their own line', async () => {
    const s = await seed();
    await s.shift('2026-09-14T13:00:00Z', 8);
    await s.ride('2026-09-14', 'COMPLETED', 500);
    await s.ride('2026-09-21', 'NO_SHOW', 100);
    // After the period's end: the payday after. Unsigned: never taken. Waived: never taken.
    await s.ride('2026-09-28', 'COMPLETED', 500);
    await s.ride('2026-09-15', 'COMPLETED', 500, { authorizedSignatureId: null });
    await s.ride('2026-09-16', 'COMPLETED', 500, { waivedAt: new Date(), waiveReason: 'Late van' });

    const p = await buildPayPreview(prisma, s.associate.id, OPEN);
    expect(p).toMatchObject({ available: true, payDate: '2026-10-02', source: 'ESTIMATE', gross: 160 });
    expect(p.deductions).toEqual([{ line: 'deduction:RIDES', kind: 'RIDES', amount: 6 }]);
    expect(p.rides).toMatchObject({ owed: 6, taken: 6, held: 0 });
    const taxes = p.taxes.reduce((n, t) => n + t.amount, 0);
    expect(p.net).toBe(Math.round((160 - taxes - 6) * 100) / 100);
  });

  it('at Florida’s $15 minimum wage the fares wait: nothing taken, and the preview says what is held and why', async () => {
    const s = await seed(15);
    await s.shift('2026-09-14T13:00:00Z', 8);
    await s.ride('2026-09-14', 'COMPLETED', 500);
    await s.ride('2026-09-15', 'COMPLETED', 500);
    const p = await buildPayPreview(prisma, s.associate.id, OPEN);
    expect(p.deductions).toEqual([]);
    expect(p.rides).toEqual({ owed: 10, taken: 0, held: 10, minimumWage: 15, state: 'FL' });
    const taxes = p.taxes.reduce((n, t) => n + t.amount, 0);
    expect(p.net).toBe(Math.round((120 - taxes) * 100) / 100);
  });

  it('no rides owed: no deduction line, the take-home is gross less taxes', async () => {
    const s = await seed();
    await s.shift('2026-09-14T13:00:00Z', 8);
    const p = await buildPayPreview(prisma, s.associate.id, OPEN);
    expect(p.deductions).toEqual([]);
    const taxes = p.taxes.reduce((n, t) => n + t.amount, 0);
    expect(p.net).toBe(Math.round((160 - taxes) * 100) / 100);
  });

  it('an evening shift at a Chicago store is that day, not the UTC tomorrow; the days add up to the pay lines', async () => {
    const s = await seed();
    // 7:00 PM – 11:20 PM CDT Mon Sep 14 = 00:00–04:20 UTC Tue Sep 15.
    await s.shift('2026-09-15T00:00:00Z', 4 + 20 / 60);
    // Three 7h 41m days: 7.6833h each — rounded alone, three days read 23.04h above a 23.05h line.
    await s.shift('2026-09-16T13:00:00Z', 7 + 41 / 60);
    await s.shift('2026-09-17T13:00:00Z', 7 + 41 / 60);
    await s.shift('2026-09-18T13:00:00Z', 7 + 41 / 60);
    const p = await buildPayPreview(prisma, s.associate.id, OPEN);
    expect(p.days.map((d) => d.date)).toEqual(['2026-09-14', '2026-09-16', '2026-09-17', '2026-09-18']);
    const dayTotal = Math.round(p.days.reduce((n, d) => n + d.hours, 0) * 100) / 100;
    const payHours = Math.round(p.earnings.reduce((n, e) => n + (e.hours ?? 0), 0) * 100) / 100;
    expect(dayTotal).toBe(payHours);
  });

  it('benefit deductions and garnishments come off as the run takes them — the estimate is the check', async () => {
    const s = await seed();
    // A full week: enough disposable pay that the federal limit lets a creditor order take its $40.
    for (const d of ['14', '15', '16', '17', '18']) await s.shift(`2026-09-${d}T13:00:00Z`, 8);
    // $25 a period for medical, pre-tax; a $40-a-run creditor garnishment.
    const medical = await prisma.benefitsPlan.create({ data: { clientId: s.client.id, kind: 'HEALTH_MEDICAL', name: 'Medical PPO' } });
    await prisma.benefitsEnrollment.create({ data: { associateId: s.associate.id, planId: medical.id, electedAmountCentsPerPeriod: 2_500, effectiveDate: new Date('2026-01-01') } });
    await prisma.garnishment.create({ data: { associateId: s.associate.id, kind: 'CREDITOR', amountPerRun: 40, startDate: new Date('2026-01-01'), remitTo: 'Acme Collections' } });
    const p = await buildPayPreview(prisma, s.associate.id, OPEN);
    expect(p).toMatchObject({ source: 'ESTIMATE', gross: 800 });
    expect(p.deductions).toEqual([
      { line: 'deduction:PRE_TAX', kind: 'PRE_TAX', amount: 25 },
      { line: 'deduction:POST_TAX', kind: 'POST_TAX', amount: 40 },
    ]);
    const taxes = p.taxes.reduce((n, t) => n + t.amount, 0);
    expect(p.net).toBe(Math.round((800 - taxes - 25 - 40) * 100) / 100);
    // The same figure the run's own projection pays her (everyone projected, then her line).
    const run = await aggregatePayrollProjection(prisma, { periodStart: new Date('2026-09-12T00:00:00Z'), periodEndExclusive: new Date('2026-09-26T00:00:00Z'), clientId: null, defaultRate: 15, payDate: new Date('2026-10-02T00:00:00Z') });
    expect(run.items.find((i) => i.associateId === s.associate.id)!.netPay).toBe(p.net);
  });

  it('opens on the company’s day: a Pacific evening is not yet the opening day in UTC’s place', async () => {
    const s = await seed();
    await s.shift('2026-09-14T13:00:00Z', 8);
    // Tue Sep 29, 6 PM Pacific = Wed Sep 30 01:00 UTC — still Tuesday for the company.
    expect((await buildPayPreview(prisma, s.associate.id, new Date('2026-09-30T01:00:00Z'))).reason).toBe('NOT_YET');
  });
});

describe('roundDaysToTotal', () => {
  it('rounds each day on the running total so the days sum to the total', () => {
    const ms = (h: number) => h * H;
    const days = roundDaysToTotal([{ date: 'a', ms: ms(7.683333) }, { date: 'b', ms: ms(7.683333) }, { date: 'c', ms: ms(7.683333) }]);
    expect(days.map((d) => d.hours)).toEqual([7.68, 7.69, 7.68]);
    expect(Math.round(days.reduce((n, d) => n + d.hours, 0) * 100) / 100).toBe(23.05);
  });
});
