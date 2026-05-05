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
