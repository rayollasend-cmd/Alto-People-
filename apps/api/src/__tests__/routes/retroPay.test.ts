import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { computeRetroPay } from '../../lib/retroPay.js';
import { aggregatePayrollProjection } from '../../lib/payrollAggregator.js';
import { computePayrollExceptions } from '../../lib/payrollExceptions.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Retroactive pay: a rate change dated into a period already paid lands
 * as one RETRO line on the next regular run, exactly once.
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

/** A paid period at $20/h (10h), then a $22 record dated into it. */
async function seedPaidThenRaised() {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Rosa', lastName: 'Diaz' });
  await prisma.associate.update({ where: { id: associate.id }, data: { state: 'FL' } });
  const longAgo = new Date(Date.now() - 200 * DAY);
  const old = await prisma.compensationRecord.create({
    data: { associateId: associate.id, effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: new Date('2026-04-01T00:00:00Z'), payType: 'HOURLY', amount: 20, reason: 'HIRE' },
  });
  await prisma.compensationRecord.update({ where: { id: old.id }, data: { createdAt: longAgo } });
  const run = await prisma.payrollRun.create({
    data: {
      periodStart: new Date('2026-04-13T00:00:00Z'),
      periodEnd: new Date('2026-04-19T00:00:00Z'),
      status: 'DISBURSED',
      kind: 'REGULAR',
      finalizedAt: new Date(Date.now() - 14 * DAY),
      disbursedAt: new Date(Date.now() - 13 * DAY),
      totalGross: 200,
      totalTax: 0,
      totalNet: 200,
    },
  });
  const item = await prisma.payrollItem.create({
    data: {
      payrollRunId: run.id,
      associateId: associate.id,
      hoursWorked: 10,
      hourlyRate: 20,
      grossPay: 200,
      federalWithholding: 0,
      netPay: 200,
      status: 'DISBURSED',
      taxState: 'FL',
      earnings: { create: [{ kind: 'REGULAR', hours: 10, rate: 20, amount: 200 }] },
    },
  });
  // The raise, recorded today, effective from the first of the month: the
  // whole paid period was at the old rate.
  const raise = await prisma.compensationRecord.create({
    data: { associateId: associate.id, effectiveFrom: new Date('2026-04-01T00:00:00Z'), payType: 'HOURLY', amount: 22, reason: 'MERIT' },
  });
  // Hours in the NEXT period, so the person is in the next run.
  await prisma.timeEntry.create({
    data: { associateId: associate.id, clientId: client.id, clockInAt: new Date('2026-04-21T13:00:00Z'), clockOutAt: new Date('2026-04-21T17:00:00Z'), status: 'APPROVED' },
  });
  return { client, associate, run, item, raise };
}

describe('retroactive pay', () => {
  it('finds the delta for hours paid at the old rate since the effective date', async () => {
    const { associate, item, raise } = await seedPaidThenRaised();
    const map = await computeRetroPay(prisma, { associateIds: [associate.id], asOf: new Date('2026-04-27T00:00:00Z') });
    const cands = map.get(associate.id) ?? [];
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ compensationRecordId: raise.id, sourcePayrollItemId: item.id, regularHours: 10, oldRate: 20, newRate: 22, amount: 20 });
  });

  it('ignores a record that was not back-dated, and a rate that went down', async () => {
    const { associate, raise } = await seedPaidThenRaised();
    // Recorded long before it took effect: nothing was paid in between.
    await prisma.compensationRecord.update({ where: { id: raise.id }, data: { createdAt: new Date('2026-03-01T00:00:00Z') } });
    expect((await computeRetroPay(prisma, { associateIds: [associate.id], asOf: new Date('2026-04-27T00:00:00Z') })).size).toBe(0);
    await prisma.compensationRecord.update({ where: { id: raise.id }, data: { createdAt: new Date(), amount: 18 } });
    expect((await computeRetroPay(prisma, { associateIds: [associate.id], asOf: new Date('2026-04-27T00:00:00Z') })).size).toBe(0);
  });

  it('adds one RETRO earning to the next run, flags it as INFO, and never pays it twice', async () => {
    const { associate, raise, item } = await seedPaidThenRaised();
    const periodStart = new Date('2026-04-20T00:00:00Z');
    const periodEndExclusive = new Date('2026-04-27T00:00:00Z');
    const projection = await aggregatePayrollProjection(prisma, { periodStart, periodEndExclusive, clientId: null, defaultRate: 15 });
    const mine = projection.items.find((i) => i.associateId === associate.id)!;
    expect(mine.retroPay).toBe(20);
    expect(mine.earnings.find((e) => e.kind === 'RETRO')).toMatchObject({ amount: 20 });
    // 4h × $22 + $20 retro.
    expect(mine.grossPay).toBe(108);

    const exceptions = await computePayrollExceptions(prisma, { periodStart, periodEndExclusive, clientId: null });
    expect(exceptions.exceptions.find((e) => e.kind === 'RETRO_PAY')).toMatchObject({ severity: 'INFO' });

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = await loginAs(user.email);
    const created = await agent.post('/payroll/runs').send({ periodStart: '2026-04-20', periodEnd: '2026-04-26' });
    expect(created.status).toBe(201);
    const runId = created.body.id as string;
    const adj = await prisma.retroPayAdjustment.findUniqueOrThrow({
      where: { compensationRecordId_sourcePayrollItemId: { compensationRecordId: raise.id, sourcePayrollItemId: item.id } },
    });
    expect(adj.status).toBe('PAID');
    expect(adj.paidRunId).toBe(runId);
    const earning = await prisma.payrollItemEarning.findFirst({ where: { payrollItem: { payrollRunId: runId }, kind: 'RETRO' } });
    expect(Number(earning?.amount)).toBe(20);

    // A different period's preview sees nothing left to settle.
    const again = await aggregatePayrollProjection(prisma, { periodStart: new Date('2026-04-27T00:00:00Z'), periodEndExclusive: new Date('2026-05-04T00:00:00Z'), clientId: null, defaultRate: 15 });
    expect(again.items.find((i) => i.associateId === associate.id)).toBeUndefined();

    // Deleting the draft gives the pair back.
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const del = await (await loginAs(admin.email)).delete(`/payroll/runs/${runId}`);
    expect(del.status).toBe(200);
    const released = await prisma.retroPayAdjustment.findUniqueOrThrow({ where: { id: adj.id } });
    expect(released.status).toBe('PENDING');
    expect(released.paidRunId).toBeNull();
  });
});
