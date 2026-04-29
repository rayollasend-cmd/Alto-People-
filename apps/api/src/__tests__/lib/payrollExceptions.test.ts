// Wave 9 — payroll-exceptions integration tests against the test schema.
//
// computePayrollExceptions reads from the DB, so this exercises the full
// query + classification path: missing W-4, missing payout method,
// terminated-but-still-on-run, OT spike, unsupported state.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, truncateAll } from '../../../test/db.js';
import { computePayrollExceptions } from '../../lib/payrollExceptions.js';

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
});

async function seedClient() {
  return prisma.client.create({ data: { name: 'Acme Tests' } });
}

async function seedAssociate(opts: {
  state?: string | null;
  employmentType?: 'W2_EMPLOYEE' | 'CONTRACTOR_1099_INDIVIDUAL';
  deletedAt?: Date | null;
  withW4?: boolean;
  withPayoutMethod?: 'BRANCH_CARD' | 'BANK_ACCOUNT' | null;
} = {}) {
  const a = await prisma.associate.create({
    data: {
      firstName: 'Test',
      lastName: 'User',
      email: `t-${Math.random().toString(36).slice(2, 9)}@example.com`,
      state: opts.state ?? 'CA',
      employmentType: opts.employmentType ?? 'W2_EMPLOYEE',
      deletedAt: opts.deletedAt ?? null,
    },
  });
  if (opts.withW4) {
    await prisma.w4Submission.create({
      data: {
        associateId: a.id,
        filingStatus: 'SINGLE',
        multipleJobs: false,
        dependentsAmount: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
      },
    });
  }
  if (opts.withPayoutMethod === 'BRANCH_CARD') {
    await prisma.payoutMethod.create({
      data: {
        associateId: a.id,
        type: 'BRANCH_CARD',
        branchCardId: 'BC-1',
        isPrimary: true,
      },
    });
  } else if (opts.withPayoutMethod === 'BANK_ACCOUNT') {
    await prisma.payoutMethod.create({
      data: {
        associateId: a.id,
        type: 'BANK_ACCOUNT',
        accountNumberEnc: Buffer.from([0x01, 0x02, 0x03]),
        routingNumberEnc: Buffer.from([0x01, 0x02, 0x03]),
        isPrimary: true,
      },
    });
  }
  return a;
}

async function seedHours(
  associateId: string,
  clientId: string,
  hours: number,
  startISO = '2026-04-06T13:00:00Z'
) {
  const start = new Date(startISO);
  await prisma.timeEntry.create({
    data: {
      associateId,
      clientId,
      clockInAt: start,
      clockOutAt: new Date(start.getTime() + hours * 60 * 60 * 1000),
      status: 'APPROVED',
      approvedAt: new Date(),
    },
  });
}

const periodStart = new Date('2026-04-06T00:00:00Z');
const periodEndExclusive = new Date('2026-04-20T00:00:00Z');

describe('computePayrollExceptions', () => {
  it('returns empty when no associates have hours', async () => {
    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    expect(r.exceptions).toEqual([]);
    expect(r.counts).toEqual({ blocking: 0, warning: 0, info: 0 });
  });

  it('flags W2 employee with no W-4 as BLOCKING', async () => {
    const c = await seedClient();
    const a = await seedAssociate({ state: 'CA', withW4: false, withPayoutMethod: 'BRANCH_CARD' });
    await seedHours(a.id, c.id, 8);
    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    const w4 = r.exceptions.find((e) => e.kind === 'MISSING_W4');
    expect(w4?.severity).toBe('BLOCKING');
    expect(r.counts.blocking).toBe(1);
  });

  it('does NOT flag missing W-4 for 1099 contractors', async () => {
    const c = await seedClient();
    const a = await seedAssociate({
      state: 'CA',
      withW4: false,
      withPayoutMethod: 'BRANCH_CARD',
      employmentType: 'CONTRACTOR_1099_INDIVIDUAL',
    });
    await seedHours(a.id, c.id, 8);
    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    expect(r.exceptions.find((e) => e.kind === 'MISSING_W4')).toBeUndefined();
  });

  it('flags missing payout method as WARNING', async () => {
    const c = await seedClient();
    const a = await seedAssociate({ withW4: true, withPayoutMethod: null });
    await seedHours(a.id, c.id, 8);
    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    const pm = r.exceptions.find((e) => e.kind === 'MISSING_BANK_ACCOUNT');
    expect(pm?.severity).toBe('WARNING');
    expect(r.counts.warning).toBe(1);
  });

  it('flags terminated-in-period as WARNING', async () => {
    const c = await seedClient();
    const a = await seedAssociate({
      withW4: true,
      withPayoutMethod: 'BRANCH_CARD',
      deletedAt: new Date('2026-04-10T00:00:00Z'),
    });
    await seedHours(a.id, c.id, 8);
    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    const term = r.exceptions.find((e) => e.kind === 'TERMINATED_IN_RUN');
    expect(term?.severity).toBe('WARNING');
  });

  it('flags > 20 OT hours as INFO (OT_SPIKE)', async () => {
    const c = await seedClient();
    const a = await seedAssociate({ withW4: true, withPayoutMethod: 'BRANCH_CARD' });
    // Mon Apr 6 → 60h in one workweek = 20 OT exactly (boundary).
    // 65h forces 25 OT → spike.
    await seedHours(a.id, c.id, 13, '2026-04-06T08:00:00Z');
    await seedHours(a.id, c.id, 13, '2026-04-07T08:00:00Z');
    await seedHours(a.id, c.id, 13, '2026-04-08T08:00:00Z');
    await seedHours(a.id, c.id, 13, '2026-04-09T08:00:00Z');
    await seedHours(a.id, c.id, 13, '2026-04-10T08:00:00Z');
    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    expect(r.exceptions.find((e) => e.kind === 'OT_SPIKE')?.severity).toBe('INFO');
  });

  it('flags unsupported state as INFO for W2 only', async () => {
    const c = await seedClient();
    const a = await seedAssociate({
      state: 'AR', // not bracketed, not flat-rate, not NO_SIT → fallback
      withW4: true,
      withPayoutMethod: 'BRANCH_CARD',
    });
    await seedHours(a.id, c.id, 8);
    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    const ust = r.exceptions.find((e) => e.kind === 'UNSUPPORTED_STATE');
    expect(ust?.severity).toBe('INFO');
  });

  it('does NOT flag unsupported state for fully-supported states', async () => {
    const c = await seedClient();
    const a = await seedAssociate({
      state: 'NY',
      withW4: true,
      withPayoutMethod: 'BRANCH_CARD',
    });
    await seedHours(a.id, c.id, 8);
    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    expect(
      r.exceptions.find((e) => e.kind === 'UNSUPPORTED_STATE')
    ).toBeUndefined();
  });

  it('orders blocking → warning → info, then by name', async () => {
    const c = await seedClient();
    const aBlock = await seedAssociate({
      withW4: false, // blocking
      withPayoutMethod: 'BRANCH_CARD',
      state: 'CA',
    });
    await prisma.associate.update({ where: { id: aBlock.id }, data: { firstName: 'Zara' } });
    await seedHours(aBlock.id, c.id, 8);

    const aWarn = await seedAssociate({
      withW4: true,
      withPayoutMethod: null, // warning
      state: 'CA',
    });
    await prisma.associate.update({ where: { id: aWarn.id }, data: { firstName: 'Anna' } });
    await seedHours(aWarn.id, c.id, 8);

    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    // Blocking first even though Zara > Anna alphabetically.
    expect(r.exceptions[0].severity).toBe('BLOCKING');
    expect(r.exceptions[1].severity).toBe('WARNING');
  });

  it('counts severities correctly', async () => {
    const c = await seedClient();
    // Three issues on one associate: missing W4 (block), missing payout (warn),
    // unsupported state (info).
    const a = await seedAssociate({
      state: 'AR',
      withW4: false,
      withPayoutMethod: null,
    });
    await seedHours(a.id, c.id, 8);
    const r = await computePayrollExceptions(prisma, {
      periodStart,
      periodEndExclusive,
      clientId: null,
    });
    expect(r.counts.blocking).toBe(1);
    expect(r.counts.warning).toBe(1);
    expect(r.counts.info).toBe(1);
  });
});
