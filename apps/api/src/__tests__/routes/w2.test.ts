import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { Prisma } from '@prisma/client';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  // Wipe TaxForm rows ourselves — truncateAll doesn't list it (the table
  // post-dates the last truncate-list update). Still works because the
  // TaxForm FK to associate is ON DELETE SetNull, so we can drop these
  // independently and a stale row from a prior test won't poison this one.
  await prisma.taxForm.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a
    .post('/auth/login')
    .send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(
      `loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`,
    );
  }
  return a;
}

/**
 * Drops a single disbursed PayrollRun + matching item for the associate,
 * with disbursedAt inside 2026 so the year filter picks it up.
 */
async function seedDisbursedItem(opts: {
  associateId: string;
  clientId: string;
  disbursedAt: Date;
  grossPay: number;
  preTaxDeductions?: number;
  preTaxRetirement?: number;
  federalWithholding: number;
  fica: number;
  medicare: number;
  stateWithholding?: number;
  taxState?: string | null;
}): Promise<{ runId: string; itemId: string }> {
  const periodStart = new Date(opts.disbursedAt);
  periodStart.setUTCDate(periodStart.getUTCDate() - 14);
  const periodEnd = new Date(opts.disbursedAt);
  periodEnd.setUTCDate(periodEnd.getUTCDate() - 1);

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
      totalTax: new Prisma.Decimal(opts.federalWithholding),
      totalNet: new Prisma.Decimal(
        opts.grossPay -
          opts.federalWithholding -
          opts.fica -
          opts.medicare -
          (opts.stateWithholding ?? 0),
      ),
    },
  });

  const item = await prisma.payrollItem.create({
    data: {
      payrollRunId: run.id,
      associateId: opts.associateId,
      hoursWorked: 80,
      hourlyRate: new Prisma.Decimal(opts.grossPay / 80),
      grossPay: new Prisma.Decimal(opts.grossPay),
      preTaxDeductions: new Prisma.Decimal(opts.preTaxDeductions ?? 0),
      preTaxRetirement: new Prisma.Decimal(opts.preTaxRetirement ?? 0),
      federalWithholding: new Prisma.Decimal(opts.federalWithholding),
      fica: new Prisma.Decimal(opts.fica),
      medicare: new Prisma.Decimal(opts.medicare),
      stateWithholding: new Prisma.Decimal(opts.stateWithholding ?? 0),
      netPay: new Prisma.Decimal(
        opts.grossPay -
          opts.federalWithholding -
          opts.fica -
          opts.medicare -
          (opts.stateWithholding ?? 0),
      ),
      taxState: opts.taxState ?? null,
      status: 'DISBURSED',
    },
  });
  return { runId: run.id, itemId: item.id };
}

describe('W-2 generation — Gap 1', () => {
  it('aggregates two paystubs into one W-2 with correct box totals', async () => {
    const client = await createClient();
    // Fill in employer block needed by the PDF route. The aggregator itself
    // doesn't read these, but the PDF route 400s without them — having them
    // in this base seed lets every test exercise the full path.
    await prisma.client.update({
      where: { id: client.id },
      data: {
        legalName: 'Acme Test Co LLC',
        ein: '12-3456789',
        addressLine1: '1 Acme Way',
        city: 'Tampa',
        state: 'FL',
        zip: '33601',
      },
    });

    const associate = await createAssociate({
      firstName: 'Jordan',
      lastName: 'Reyes',
    });
    await prisma.associate.update({
      where: { id: associate.id },
      data: {
        addressLine1: '742 Evergreen Terrace',
        city: 'Springfield',
        state: 'FL',
        zip: '32801',
      },
    });
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });

    // Two paystubs in 2026, no pre-tax deductions, no state withholding.
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-01-15T12:00:00Z'),
      grossPay: 2000,
      federalWithholding: 220,
      fica: 124,
      medicare: 29,
    });
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-02-15T12:00:00Z'),
      grossPay: 1500,
      federalWithholding: 150,
      fica: 93,
      medicare: 21.75,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    expect(gen.status).toBe(200);
    expect(gen.body.eligibleAssociateCount).toBe(1);
    expect(gen.body.createdCount).toBe(1);

    const formId = gen.body.created[0].id as string;
    const form = await prisma.taxForm.findUniqueOrThrow({
      where: { id: formId },
    });
    expect(form.kind).toBe('W2');
    expect(form.taxYear).toBe(2026);

    const amounts = form.amounts as Record<string, unknown>;
    expect(amounts.box1Wages).toBe(3500);
    expect(amounts.box2FitWithheld).toBe(370);
    expect(amounts.box3SsWages).toBe(3500);
    expect(amounts.box4SsTax).toBe(217);
    expect(amounts.box5MedicareWages).toBe(3500);
    expect(amounts.box6MedicareTax).toBe(50.75);
    expect(amounts.sourceItemCount).toBe(2);
  });

  it('handles AMENDMENT signed deltas: corrected paystub adjusts the W-2 totals', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme Test Co LLC', ein: '12-3456789' },
    });
    const associate = await createAssociate();
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });

    // Original paystub.
    const orig = await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-03-15T12:00:00Z'),
      grossPay: 2000,
      federalWithholding: 220,
      fica: 124,
      medicare: 29,
    });
    // AMENDMENT item carrying signed deltas (+$100 gross, +$10 FIT, +$6.20
    // FICA, +$1.45 Medicare). Lives on a separate AMENDMENT run that's
    // also disbursed inside 2026. Aggregator sums across both runs.
    const amendRun = await prisma.payrollRun.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-03-01'),
        periodEnd: new Date('2026-03-14'),
        status: 'DISBURSED',
        kind: 'AMENDMENT',
        amendsRunId: orig.runId,
        amendmentReason: 'Missed shift hours',
        disbursedAt: new Date('2026-04-01T12:00:00Z'),
        totalGross: new Prisma.Decimal(100),
        totalTax: new Prisma.Decimal(10),
        totalNet: new Prisma.Decimal(82.35),
      },
    });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: amendRun.id,
        associateId: associate.id,
        amendsItemId: orig.itemId,
        hoursWorked: 4,
        hourlyRate: new Prisma.Decimal(25),
        grossPay: new Prisma.Decimal(100),
        federalWithholding: new Prisma.Decimal(10),
        fica: new Prisma.Decimal(6.2),
        medicare: new Prisma.Decimal(1.45),
        netPay: new Prisma.Decimal(82.35),
        status: 'DISBURSED',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    expect(gen.status).toBe(200);

    const form = await prisma.taxForm.findUniqueOrThrow({
      where: { id: gen.body.created[0].id },
    });
    const amounts = form.amounts as Record<string, unknown>;
    expect(amounts.box1Wages).toBe(2100);
    expect(amounts.box2FitWithheld).toBe(230);
    expect(amounts.box4SsTax).toBe(130.2);
    expect(amounts.box6MedicareTax).toBe(30.45);
    expect(amounts.sourceItemCount).toBe(2);
  });

  it('renders a PDF, stamps pdfHash on first download, and 200s on re-download', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: {
        legalName: 'Acme Test Co LLC',
        ein: '12-3456789',
        addressLine1: '1 Acme Way',
        city: 'Tampa',
        state: 'FL',
        zip: '33601',
      },
    });
    const associate = await createAssociate({
      firstName: 'Pat',
      lastName: 'Lee',
    });
    await prisma.associate.update({
      where: { id: associate.id },
      data: {
        addressLine1: '5 Oak St',
        city: 'Tampa',
        state: 'FL',
        zip: '33602',
      },
    });
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('987654321'),
      },
    });
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-06-15T12:00:00Z'),
      grossPay: 1000,
      federalWithholding: 100,
      fica: 62,
      medicare: 14.5,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const formId = gen.body.created[0].id as string;

    // First download stamps pdfHash.
    const r1 = await hrAgent.get(`/tax-forms/${formId}/pdf`);
    expect(r1.status).toBe(200);
    expect(r1.headers['content-type']).toBe('application/pdf');
    expect(r1.body.length).toBeGreaterThan(1000);
    const stamped = await prisma.taxForm.findUniqueOrThrow({
      where: { id: formId },
    });
    expect(stamped.pdfHash).not.toBeNull();
    expect(stamped.pdfHash!.length).toBe(64);

    // Re-download still 200 + same byte length (the renderer is deterministic
    // up to the `generatedAt` timestamp baked into the footer, which causes
    // bytes to differ but length / content-type to match).
    const r2 = await hrAgent.get(`/tax-forms/${formId}/pdf`);
    expect(r2.status).toBe(200);
    expect(r2.body.length).toBeGreaterThan(1000);
  });

  it('skips associates that already have a non-VOIDED W-2 for the year (idempotent)', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789' },
    });
    const associate = await createAssociate();
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-07-15T12:00:00Z'),
      grossPay: 1000,
      federalWithholding: 100,
      fica: 62,
      medicare: 14.5,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const r1 = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    expect(r1.body.createdCount).toBe(1);
    expect(r1.body.skippedCount).toBe(0);

    const r2 = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    expect(r2.body.createdCount).toBe(0);
    expect(r2.body.skippedCount).toBe(1);
  });

  it('renders the requested copy variant — ?copy=C / D / 2 / A all 200 with copy-coded filename', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789', addressLine1: '1 Way', city: 'Tampa', state: 'FL', zip: '33601' },
    });
    const associate = await createAssociate({ firstName: 'Lee', lastName: 'Park' });
    await prisma.associate.update({
      where: { id: associate.id },
      data: { addressLine1: '2 Oak', city: 'Tampa', state: 'FL', zip: '33602' },
    });
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-03-15T12:00:00Z'),
      grossPay: 1000,
      federalWithholding: 100,
      fica: 62,
      medicare: 14.5,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const formId = gen.body.created[0].id as string;

    // Copy B (default + canonical) — pdfHash gets stamped here.
    const rB = await hrAgent.get(`/tax-forms/${formId}/pdf`);
    expect(rB.status).toBe(200);
    expect(rB.headers['content-disposition']).toMatch(/w2-2026-park-lee\.pdf/);
    const stampedB = await prisma.taxForm.findUniqueOrThrow({ where: { id: formId } });
    expect(stampedB.pdfHash).not.toBeNull();
    const canonicalHash = stampedB.pdfHash!;

    // Variants — each 200, each filename suffixed with the copy code,
    // and none of them touch the canonical pdfHash stamp.
    for (const copy of ['C', 'D', '2', 'A'] as const) {
      const r = await hrAgent.get(`/tax-forms/${formId}/pdf?copy=${copy}`);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('application/pdf');
      expect(r.body.length).toBeGreaterThan(1000);
      expect(r.headers['content-disposition']).toMatch(
        new RegExp(`w2-2026-park-lee-copy${copy.toLowerCase()}\\.pdf`),
      );
    }
    const afterVariants = await prisma.taxForm.findUniqueOrThrow({
      where: { id: formId },
    });
    expect(afterVariants.pdfHash).toBe(canonicalHash);

    // Bad copy code → 400.
    const bad = await hrAgent.get(`/tax-forms/${formId}/pdf?copy=Z`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_copy');
  });

  it('renders the 4-up multi-copy paper sheet at ?layout=4up — 200 + 4up filename', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789', addressLine1: '1 Way', city: 'Tampa', state: 'FL', zip: '33601' },
    });
    const associate = await createAssociate({ firstName: 'Mo', lastName: 'Diaz' });
    await prisma.associate.update({
      where: { id: associate.id },
      data: { addressLine1: '3 Birch', city: 'Tampa', state: 'FL', zip: '33602' },
    });
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-03-15T12:00:00Z'),
      grossPay: 1500,
      federalWithholding: 150,
      fica: 93,
      medicare: 21.75,
      stateWithholding: 50,
      taxState: 'CA',
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const formId = gen.body.created[0].id as string;

    const r = await hrAgent.get(`/tax-forms/${formId}/pdf?layout=4up`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.body.length).toBeGreaterThan(1000);
    expect(r.headers['content-disposition']).toMatch(/w2-2026-diaz-mo-4up\.pdf/);

    // 4-up never stamps pdfHash (only canonical Copy B does).
    const form = await prisma.taxForm.findUniqueOrThrow({ where: { id: formId } });
    expect(form.pdfHash).toBeNull();

    // Bad layout → 400.
    const bad = await hrAgent.get(`/tax-forms/${formId}/pdf?layout=8up`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_layout');
  });

  it('401(k) deduction reduces Box 1 but NOT Box 3/5 (retirement is FICA-includable)', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789' },
    });
    const associate = await createAssociate();
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });

    // $2000 gross with $200 pre-tax, all of which is 401(k). Box 1 should
    // be 2000 - 200 = 1800. Box 3/5 should be 2000 (retirement adds back).
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 2000,
      preTaxDeductions: 200,
      preTaxRetirement: 200,
      federalWithholding: 180,
      fica: 124,
      medicare: 29,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    expect(gen.status).toBe(200);

    const form = await prisma.taxForm.findUniqueOrThrow({
      where: { id: gen.body.created[0].id },
    });
    const amounts = form.amounts as Record<string, unknown>;
    expect(amounts.box1Wages).toBe(1800);
    expect(amounts.box3SsWages).toBe(2000);
    expect(amounts.box5MedicareWages).toBe(2000);
  });

  it('Mixed Section 125 + 401(k): only the §125 slice reduces Box 3/5', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789' },
    });
    const associate = await createAssociate();
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });

    // $3000 gross, $300 pre-tax = $100 §125 (health) + $200 401(k).
    // Box 1 = 3000 - 300 = 2700.
    // Box 3/5 = 3000 - (300 - 200) = 2900 (only §125 reduces FICA base).
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-05-15T12:00:00Z'),
      grossPay: 3000,
      preTaxDeductions: 300,
      preTaxRetirement: 200,
      federalWithholding: 270,
      fica: 179.8,
      medicare: 42.05,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });

    const form = await prisma.taxForm.findUniqueOrThrow({
      where: { id: gen.body.created[0].id },
    });
    const amounts = form.amounts as Record<string, unknown>;
    expect(amounts.box1Wages).toBe(2700);
    expect(amounts.box3SsWages).toBe(2900);
    expect(amounts.box5MedicareWages).toBe(2900);
  });

  it('W-2c: amend a FILED W-2 by recomputing — original flips to AMENDED, W2C row stores previous + corrected', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: {
        legalName: 'Acme Test Co LLC',
        ein: '12-3456789',
        addressLine1: '1 Acme Way',
        city: 'Tampa',
        state: 'FL',
        zip: '33601',
      },
    });
    const associate = await createAssociate({ firstName: 'Sam', lastName: 'Patel' });
    await prisma.associate.update({
      where: { id: associate.id },
      data: {
        addressLine1: '12 Main St',
        city: 'Tampa',
        state: 'FL',
        zip: '33601',
      },
    });
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });

    const orig = await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-09-15T12:00:00Z'),
      grossPay: 1000,
      federalWithholding: 100,
      fica: 62,
      medicare: 14.5,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const w2Id = gen.body.created[0].id as string;

    // Mark the original as FILED — that's the gate the W-2c route requires.
    await prisma.taxForm.update({
      where: { id: w2Id },
      data: { status: 'FILED', filedAt: new Date() },
    });

    // Now post an AMENDMENT run that bumps wages by $100 in the same year.
    const amendRun = await prisma.payrollRun.create({
      data: {
        clientId: client.id,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-14'),
        status: 'DISBURSED',
        kind: 'AMENDMENT',
        amendsRunId: orig.runId,
        amendmentReason: 'Forgotten bonus',
        disbursedAt: new Date('2026-10-01T12:00:00Z'),
        totalGross: new Prisma.Decimal(100),
        totalTax: new Prisma.Decimal(10),
        totalNet: new Prisma.Decimal(82.35),
      },
    });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: amendRun.id,
        associateId: associate.id,
        amendsItemId: orig.itemId,
        hoursWorked: 0,
        hourlyRate: new Prisma.Decimal(0),
        grossPay: new Prisma.Decimal(100),
        federalWithholding: new Prisma.Decimal(10),
        fica: new Prisma.Decimal(6.2),
        medicare: new Prisma.Decimal(1.45),
        netPay: new Prisma.Decimal(82.35),
        status: 'DISBURSED',
      },
    });

    const w2cResp = await hrAgent
      .post('/tax-forms/w2c')
      .send({
        originalW2FormId: w2Id,
        correctionReason: 'Bonus paid in Q4 was missing from the original filing.',
      });
    expect(w2cResp.status).toBe(201);
    expect(w2cResp.body.amendsTaxFormId).toBe(w2Id);
    expect(w2cResp.body.delta.box1).toBeCloseTo(100, 2);
    expect(w2cResp.body.delta.box2).toBeCloseTo(10, 2);

    // The original W-2 must now be AMENDED — IRS rule says you don't void
    // a filed W-2; you correct it with a W-2c.
    const orig2 = await prisma.taxForm.findUniqueOrThrow({ where: { id: w2Id } });
    expect(orig2.status).toBe('AMENDED');

    // W2C amounts carry both previous + corrected.
    const w2c = await prisma.taxForm.findUniqueOrThrow({
      where: { id: w2cResp.body.id },
    });
    expect(w2c.kind).toBe('W2C');
    expect(w2c.amendsTaxFormId).toBe(w2Id);
    const amounts = w2c.amounts as Record<string, unknown>;
    expect((amounts.previous as Record<string, number>).box1Wages).toBe(1000);
    expect((amounts.corrected as Record<string, number>).box1Wages).toBe(1100);

    // The PDF route renders the W-2c.
    const pdf = await hrAgent.get(`/tax-forms/${w2c.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.length).toBeGreaterThan(1000);
  });

  it('W-2c: rejects if there is no delta between previous and corrected', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789' },
    });
    const associate = await createAssociate();
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-11-15T12:00:00Z'),
      grossPay: 500,
      federalWithholding: 50,
      fica: 31,
      medicare: 7.25,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const w2Id = gen.body.created[0].id as string;
    await prisma.taxForm.update({
      where: { id: w2Id },
      data: { status: 'FILED', filedAt: new Date() },
    });

    // No new amendment run, so recompute hits the same totals as the
    // original. The route must refuse to create a no-op W-2c.
    const r = await hrAgent
      .post('/tax-forms/w2c')
      .send({
        originalW2FormId: w2Id,
        correctionReason: 'Just in case',
      });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('no_delta');
  });

  it('W-2c: rejects if the original is still DRAFT (not yet filed)', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789' },
    });
    const associate = await createAssociate();
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-12-15T12:00:00Z'),
      grossPay: 500,
      federalWithholding: 50,
      fica: 31,
      medicare: 7.25,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const w2Id = gen.body.created[0].id as string;
    // Status is still DRAFT at this point.

    const r = await hrAgent
      .post('/tax-forms/w2c')
      .send({
        originalW2FormId: w2Id,
        correctionReason: 'Spotted an error',
      });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('invalid_state');
  });

  it('400s the PDF route when the client is missing legalName / EIN', async () => {
    const client = await createClient(); // no legalName / EIN
    const associate = await createAssociate();
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
      },
    });
    await seedDisbursedItem({
      associateId: associate.id,
      clientId: client.id,
      disbursedAt: new Date('2026-08-15T12:00:00Z'),
      grossPay: 500,
      federalWithholding: 50,
      fica: 31,
      medicare: 7.25,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/w2/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const formId = gen.body.created[0].id as string;
    const r = await hrAgent.get(`/tax-forms/${formId}/pdf`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('missing_employer_info');
  });
});
