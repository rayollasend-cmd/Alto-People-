import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  F1099_NEC_REPORTING_THRESHOLD,
  aggregateF1099NecPayments,
  listF1099NecEligibleAssociates,
} from '../../lib/f1099NecAggregator.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Drops a single disbursed PayrollRun + matching item for the associate
 * inside the given tax year. Mirrors w2.test.ts seedDisbursedItem; we
 * inline a copy here so a future refactor of either suite stays
 * independent.
 */
async function seedDisbursedItem(opts: {
  associateId: string;
  clientId: string;
  disbursedAt: Date;
  grossPay: number;
  federalWithholding?: number;
  stateWithholding?: number;
  taxState?: string | null;
}) {
  const periodStart = new Date(opts.disbursedAt);
  periodStart.setUTCDate(periodStart.getUTCDate() - 14);
  const periodEnd = new Date(opts.disbursedAt);
  periodEnd.setUTCDate(periodEnd.getUTCDate() - 1);

  const fit = opts.federalWithholding ?? 0;
  const stateW = opts.stateWithholding ?? 0;
  const run = await prisma.payrollRun.create({
    data: {
      clientId: opts.clientId,
      periodStart,
      periodEnd,
      status: 'DISBURSED',
      kind: 'REGULAR',
      disbursedAt: opts.disbursedAt,
      finalizedAt: opts.disbursedAt,
      totalGross: new Prisma.Decimal(opts.grossPay),
      totalTax: new Prisma.Decimal(fit + stateW),
      totalNet: new Prisma.Decimal(opts.grossPay - fit - stateW),
    },
  });
  return prisma.payrollItem.create({
    data: {
      payrollRunId: run.id,
      associateId: opts.associateId,
      hoursWorked: 40,
      hourlyRate: new Prisma.Decimal(opts.grossPay / 40),
      grossPay: new Prisma.Decimal(opts.grossPay),
      federalWithholding: new Prisma.Decimal(fit),
      stateWithholding: new Prisma.Decimal(stateW),
      netPay: new Prisma.Decimal(opts.grossPay - fit - stateW),
      taxState: opts.taxState ?? null,
      status: 'DISBURSED',
    },
  });
}

async function makeContractor(kind: 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS' = 'CONTRACTOR_1099_INDIVIDUAL') {
  const a = await createAssociate();
  await prisma.associate.update({
    where: { id: a.id },
    data: { employmentType: kind },
  });
  return a;
}

describe('aggregateF1099NecPayments — Gap 11', () => {
  it('sums grossPay across the year into Box 1 (no withholding case)', async () => {
    const client = await createClient();
    const a = await makeContractor();

    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-02-15T12:00:00Z'),
      grossPay: 1500,
    });
    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-08-15T12:00:00Z'),
      grossPay: 2500,
    });

    const boxes = await aggregateF1099NecPayments(prisma, a.id, 2026);
    expect(boxes.box1NonemployeeCompensation).toBe(4000);
    expect(boxes.box4FitWithheld).toBe(0);
    expect(boxes.box2DirectSales).toBe(false);
    expect(boxes.stateLines).toEqual([]);
    expect(boxes.sourceItemCount).toBe(2);
  });

  it('captures backup withholding in Box 4 + state withholding in stateLines', async () => {
    const client = await createClient();
    const a = await makeContractor('CONTRACTOR_1099_BUSINESS');

    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 1000,
      federalWithholding: 240, // 24% backup withholding (no W-9 on file)
      stateWithholding: 50,
      taxState: 'CA',
    });

    const boxes = await aggregateF1099NecPayments(prisma, a.id, 2026);
    expect(boxes.box1NonemployeeCompensation).toBe(1000);
    expect(boxes.box4FitWithheld).toBe(240);
    expect(boxes.stateLines).toEqual([
      { state: 'CA', stateTaxWithheld: 50, stateIncome: 1000 },
    ]);
  });

  it('IRS pay-date rule: a Dec 31 work period paid Jan 3 lands in NEXT year', async () => {
    const client = await createClient();
    const a = await makeContractor();

    // Period ends Dec 28 2026, paid Jan 3 2027 → counts toward 2027.
    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2027-01-03T12:00:00Z'),
      grossPay: 800,
    });

    const y2026 = await aggregateF1099NecPayments(prisma, a.id, 2026);
    const y2027 = await aggregateF1099NecPayments(prisma, a.id, 2027);
    expect(y2026.box1NonemployeeCompensation).toBe(0);
    expect(y2026.sourceItemCount).toBe(0);
    expect(y2027.box1NonemployeeCompensation).toBe(800);
    expect(y2027.sourceItemCount).toBe(1);
  });

  it('AMENDMENT signed deltas: a clawback amendment reduces Box 1', async () => {
    const client = await createClient();
    const a = await makeContractor();

    const orig = await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-03-15T12:00:00Z'),
      grossPay: 1000,
    });
    // Amendment run that nets -$200 (overpayment clawback).
    const amendRun = await prisma.payrollRun.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-03-01'),
        periodEnd: new Date('2026-03-14'),
        status: 'DISBURSED',
        kind: 'AMENDMENT',
        amendsRunId: orig.payrollRunId,
        amendmentReason: 'Reverse over-billed hours',
        disbursedAt: new Date('2026-04-01T12:00:00Z'),
        totalGross: new Prisma.Decimal(-200),
        totalTax: new Prisma.Decimal(0),
        totalNet: new Prisma.Decimal(-200),
      },
    });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: amendRun.id,
        associateId: a.id,
        amendsItemId: orig.id,
        hoursWorked: -8,
        hourlyRate: new Prisma.Decimal(25),
        grossPay: new Prisma.Decimal(-200),
        federalWithholding: new Prisma.Decimal(0),
        netPay: new Prisma.Decimal(-200),
        status: 'DISBURSED',
      },
    });

    const boxes = await aggregateF1099NecPayments(prisma, a.id, 2026);
    expect(boxes.box1NonemployeeCompensation).toBe(800);
    expect(boxes.sourceItemCount).toBe(2); // original + amendment row
  });

  it('excludes VOIDED items and CANCELLED runs', async () => {
    const client = await createClient();
    const a = await makeContractor();

    // Disbursed (counts).
    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-05-15T12:00:00Z'),
      grossPay: 600,
    });
    // CANCELLED run (excluded — voided run).
    const cxRun = await prisma.payrollRun.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-06-01'),
        periodEnd: new Date('2026-06-14'),
        status: 'CANCELLED',
        kind: 'REGULAR',
        disbursedAt: new Date('2026-06-15T12:00:00Z'),
        cancelledAt: new Date('2026-06-16T12:00:00Z'),
        cancelReason: 'Test cancellation',
        totalGross: new Prisma.Decimal(900),
        totalTax: new Prisma.Decimal(0),
        totalNet: new Prisma.Decimal(900),
      },
    });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: cxRun.id,
        associateId: a.id,
        hoursWorked: 36,
        hourlyRate: new Prisma.Decimal(25),
        grossPay: new Prisma.Decimal(900),
        federalWithholding: new Prisma.Decimal(0),
        netPay: new Prisma.Decimal(900),
        status: 'VOIDED',
      },
    });

    const boxes = await aggregateF1099NecPayments(prisma, a.id, 2026);
    expect(boxes.box1NonemployeeCompensation).toBe(600);
    expect(boxes.sourceItemCount).toBe(1);
  });
});

describe('listF1099NecEligibleAssociates — Gap 11', () => {
  it('skips contractors paid below the $600 threshold (Box 1 floor)', async () => {
    const client = await createClient();
    const aHigh = await makeContractor();
    const aLow = await makeContractor();

    await seedDisbursedItem({
      associateId: aHigh.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: F1099_NEC_REPORTING_THRESHOLD,
    });
    await seedDisbursedItem({
      associateId: aLow.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 599.99, // one cent below threshold
    });

    const eligible = await listF1099NecEligibleAssociates(prisma, 2026, client.id);
    expect(eligible).toEqual([aHigh.id]);
  });

  it('still includes a sub-threshold contractor if backup withholding occurred', async () => {
    const client = await createClient();
    const a = await makeContractor();

    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 100, // below threshold
      federalWithholding: 24, // but had backup withholding → must file
    });

    const eligible = await listF1099NecEligibleAssociates(prisma, 2026, client.id);
    expect(eligible).toEqual([a.id]);
  });

  it('excludes W-2 employees regardless of pay (only contractors get 1099-NEC)', async () => {
    const client = await createClient();
    const w2 = await createAssociate(); // default employmentType = W2_EMPLOYEE
    await seedDisbursedItem({
      associateId: w2.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 50000,
    });

    const eligible = await listF1099NecEligibleAssociates(prisma, 2026, client.id);
    expect(eligible).toEqual([]);
  });
});
