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
  // truncateAll doesn't list TaxForm — drop here so the prior test's
  // forms don't leak. Same workaround the W-2 suite uses.
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

async function makeContractor(opts: {
  firstName?: string;
  lastName?: string;
  kind?: 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS';
  withTin?: boolean;
} = {}) {
  const a = await createAssociate({
    firstName: opts.firstName,
    lastName: opts.lastName,
  });
  await prisma.associate.update({
    where: { id: a.id },
    data: {
      employmentType: opts.kind ?? 'CONTRACTOR_1099_INDIVIDUAL',
      addressLine1: '500 Sample St',
      city: 'Tampa',
      state: 'FL',
      zip: '33601',
      ...(opts.withTin === false ? {} : { tinEncrypted: encryptString('111223333') }),
    },
  });
  return a;
}

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

describe('1099-NEC generation — Gap 11', () => {
  it('generates one 1099-NEC per eligible contractor with the right Box 1 total', async () => {
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

    const eligible = await makeContractor({ firstName: 'Jordan', lastName: 'Reyes' });
    const subThreshold = await makeContractor({ firstName: 'Sub', lastName: 'Threshold' });

    await seedDisbursedItem({
      associateId: eligible.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 800,
    });
    await seedDisbursedItem({
      associateId: subThreshold.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 500, // below the $600 threshold
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const gen = await hrAgent
      .post('/tax-forms/1099-nec/generate')
      .send({ taxYear: 2026, clientId: client.id });
    expect(gen.status).toBe(200);
    expect(gen.body.eligibleAssociateCount).toBe(1);
    expect(gen.body.createdCount).toBe(1);
    expect(gen.body.skippedCount).toBe(0);

    const form = await prisma.taxForm.findUniqueOrThrow({
      where: { id: gen.body.created[0].id },
    });
    expect(form.kind).toBe('F1099_NEC');
    expect(form.taxYear).toBe(2026);
    expect(form.associateId).toBe(eligible.id);
    const amounts = form.amounts as Record<string, unknown>;
    expect(amounts.box1NonemployeeCompensation).toBe(800);
    expect(amounts.box4FitWithheld).toBe(0);
    expect(amounts.sourceItemCount).toBe(1);
  });

  it('renders a PDF and stamps pdfHash on first download', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789' },
    });
    const a = await makeContractor({ firstName: 'Pat', lastName: 'Lee' });

    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-06-15T12:00:00Z'),
      grossPay: 1200,
      federalWithholding: 24, // backup withholding
      stateWithholding: 30,
      taxState: 'CA',
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/1099-nec/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const formId = gen.body.created[0].id as string;

    const pdf = await hrAgent.get(`/tax-forms/${formId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.length).toBeGreaterThan(1000);
    expect(pdf.headers['content-disposition']).toMatch(/1099nec-2026-lee-pat\.pdf/);

    const stamped = await prisma.taxForm.findUniqueOrThrow({ where: { id: formId } });
    expect(stamped.pdfHash).not.toBeNull();
    expect(stamped.pdfHash!.length).toBe(64);
  });

  it('400s the PDF route with missing_tin when contractor has no TIN on file', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789' },
    });
    const a = await makeContractor({ withTin: false });

    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-06-15T12:00:00Z'),
      grossPay: 1500,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/1099-nec/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const formId = gen.body.created[0].id as string;

    const r = await hrAgent.get(`/tax-forms/${formId}/pdf`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('missing_tin');
  });

  it('skips contractors that already have a non-VOIDED 1099-NEC for the year (idempotent)', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789' },
    });
    const a = await makeContractor();
    await seedDisbursedItem({
      associateId: a.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 1000,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const r1 = await hrAgent
      .post('/tax-forms/1099-nec/generate')
      .send({ taxYear: 2026, clientId: client.id });
    expect(r1.body.createdCount).toBe(1);
    expect(r1.body.skippedCount).toBe(0);

    const r2 = await hrAgent
      .post('/tax-forms/1099-nec/generate')
      .send({ taxYear: 2026, clientId: client.id });
    expect(r2.body.createdCount).toBe(0);
    expect(r2.body.skippedCount).toBe(1);
  });

  it('contractor (associate) can download their OWN 1099-NEC; cross-associate is 404', async () => {
    const client = await createClient();
    await prisma.client.update({
      where: { id: client.id },
      data: { legalName: 'Acme', ein: '12-3456789' },
    });
    const me = await makeContractor({ firstName: 'Self', lastName: 'Owner' });
    const them = await makeContractor({ firstName: 'Other', lastName: 'Person' });
    await seedDisbursedItem({
      associateId: me.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 700,
    });
    await seedDisbursedItem({
      associateId: them.id,
      clientId: client.id,
      disbursedAt: new Date('2026-04-15T12:00:00Z'),
      grossPay: 800,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = await hrAgent
      .post('/tax-forms/1099-nec/generate')
      .send({ taxYear: 2026, clientId: client.id });
    const myFormId = (gen.body.created as { id: string; associateId: string }[])
      .find((c) => c.associateId === me.id)!
      .id;
    const theirFormId = (gen.body.created as { id: string; associateId: string }[])
      .find((c) => c.associateId === them.id)!
      .id;

    // The owner of `me` must be linked to a User row for the cookie auth.
    // The FK lives on User.associateId (not the inverse), so update the
    // user row to point at the associate.
    const { user: assocUser } = await createUser({
      role: 'ASSOCIATE',
      email: `me-${me.id.slice(0, 6)}@example.com`,
    });
    await prisma.user.update({
      where: { id: assocUser.id },
      data: { associateId: me.id },
    });
    const meAgent = await loginAs(assocUser.email);

    const own = await meAgent.get(`/tax-forms/${myFormId}/pdf`);
    expect(own.status).toBe(200);

    const cross = await meAgent.get(`/tax-forms/${theirFormId}/pdf`);
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe('not_found');
  });
});
