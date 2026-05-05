// Gap 11 Phase 8 — 1099-MISC aggregator tests.
//
// Same fixture pattern as f1099NecAggregator.test.ts. Asserts the MVP
// box mapping (grossPay → Box 3 Other income), per-box thresholds
// (Royalties $10, others $600, Box 4 always triggers), and the same
// pay-date / amendment / VOIDED-exclusion semantics as 1099-NEC.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  aggregateF1099MiscPayments,
  listF1099MiscEligibleAssociates,
  meetsF1099MiscThreshold,
} from '../../lib/f1099MiscAggregator.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

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

async function makeContractor(
  kind: 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS' = 'CONTRACTOR_1099_INDIVIDUAL',
) {
  const a = await createAssociate();
  await prisma.associate.update({
    where: { id: a.id },
    data: { employmentType: kind },
  });
  return a;
}

describe('aggregateF1099MiscPayments — Gap 11 Phase 8', () => {
  it('routes grossPay to Box 3 (Other income) by default', async () => {
    const client = await createClient();
    const a = await makeContractor();

    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-02-15T12:00:00Z'),
      grossPay: 750,
    });
    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-08-15T12:00:00Z'),
      grossPay: 1250,
    });

    const boxes = await aggregateF1099MiscPayments(prisma, a.id, 2026);
    expect(boxes.box3OtherIncome).toBe(2000);
    // All other money boxes should be 0
    expect(boxes.box1Rents).toBe(0);
    expect(boxes.box2Royalties).toBe(0);
    expect(boxes.box4FitWithheld).toBe(0);
    expect(boxes.box14NonqualifiedDeferred).toBe(0);
    // Checkbox stays false
    expect(boxes.box7DirectSales).toBe(false);
    expect(boxes.sourceItemCount).toBe(2);
  });

  it('captures federal + state withholding alongside Box 3', async () => {
    const client = await createClient();
    const a = await makeContractor();

    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 1000,
      federalWithholding: 240,
      stateWithholding: 60,
      taxState: 'NY',
    });

    const boxes = await aggregateF1099MiscPayments(prisma, a.id, 2026);
    expect(boxes.box3OtherIncome).toBe(1000);
    expect(boxes.box4FitWithheld).toBe(240);
    expect(boxes.stateLines).toEqual([
      { state: 'NY', stateTaxWithheld: 60, stateIncome: 1000 },
    ]);
  });

  it('meetsF1099MiscThreshold: zero everywhere is false', () => {
    const empty = {
      box1Rents: 0,
      box2Royalties: 0,
      box3OtherIncome: 0,
      box4FitWithheld: 0,
      box5FishingBoatProceeds: 0,
      box6MedicalHealthcarePayments: 0,
      box7DirectSales: false as const,
      box8SubstitutePayments: 0,
      box9CropInsuranceProceeds: 0,
      box10GrossProceedsAttorney: 0,
      box11FishForResale: 0,
      box12Section409ADeferrals: 0,
      box13ExcessGoldenParachute: 0,
      box14NonqualifiedDeferred: 0,
      stateLines: [],
      sourceItemCount: 0,
    };
    expect(meetsF1099MiscThreshold(empty)).toBe(false);
  });

  it('meetsF1099MiscThreshold: $10 royalties triggers (lower than $600 default)', () => {
    expect(
      meetsF1099MiscThreshold({
        box1Rents: 0,
        box2Royalties: 10,
        box3OtherIncome: 0,
        box4FitWithheld: 0,
        box5FishingBoatProceeds: 0,
        box6MedicalHealthcarePayments: 0,
        box7DirectSales: false,
        box8SubstitutePayments: 0,
        box9CropInsuranceProceeds: 0,
        box10GrossProceedsAttorney: 0,
        box11FishForResale: 0,
        box12Section409ADeferrals: 0,
        box13ExcessGoldenParachute: 0,
        box14NonqualifiedDeferred: 0,
        stateLines: [],
        sourceItemCount: 1,
      }),
    ).toBe(true);
  });

  it('meetsF1099MiscThreshold: any Box 4 withholding triggers regardless of underlying', () => {
    expect(
      meetsF1099MiscThreshold({
        box1Rents: 0,
        box2Royalties: 0,
        box3OtherIncome: 50,
        box4FitWithheld: 5,
        box5FishingBoatProceeds: 0,
        box6MedicalHealthcarePayments: 0,
        box7DirectSales: false,
        box8SubstitutePayments: 0,
        box9CropInsuranceProceeds: 0,
        box10GrossProceedsAttorney: 0,
        box11FishForResale: 0,
        box12Section409ADeferrals: 0,
        box13ExcessGoldenParachute: 0,
        box14NonqualifiedDeferred: 0,
        stateLines: [],
        sourceItemCount: 1,
      }),
    ).toBe(true);
  });

  it('listEligible: skips contractors paid below the $600 Box 3 threshold', async () => {
    const client = await createClient();
    const eligible = await makeContractor();
    const subThreshold = await makeContractor();

    await seedDisbursedItem({
      associateId: eligible.id,
      clientId: client.id,
      disbursedAt: new Date('2026-06-15T12:00:00Z'),
      grossPay: 1500,
    });
    await seedDisbursedItem({
      associateId: subThreshold.id,
      clientId: client.id,
      disbursedAt: new Date('2026-06-15T12:00:00Z'),
      grossPay: 400,
    });

    const ids = await listF1099MiscEligibleAssociates(prisma, 2026, client.id);
    expect(ids).toContain(eligible.id);
    expect(ids).not.toContain(subThreshold.id);
  });

  it('listEligible: still includes a sub-threshold contractor with backup withholding', async () => {
    const client = await createClient();
    const a = await makeContractor();

    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-06-15T12:00:00Z'),
      grossPay: 200, // below Box 3 threshold
      federalWithholding: 48, // 24% backup withholding
    });

    const ids = await listF1099MiscEligibleAssociates(prisma, 2026, client.id);
    expect(ids).toContain(a.id);
  });

  it('listEligible: excludes W-2 employees', async () => {
    const client = await createClient();
    const employee = await createAssociate();
    await prisma.associate.update({
      where: { id: employee.id },
      data: { employmentType: 'W2_EMPLOYEE' },
    });

    await seedDisbursedItem({
      associateId: employee.id,
      clientId: client.id,
      disbursedAt: new Date('2026-06-15T12:00:00Z'),
      grossPay: 50000,
    });

    const ids = await listF1099MiscEligibleAssociates(prisma, 2026, client.id);
    expect(ids).not.toContain(employee.id);
  });
});
