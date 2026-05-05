// Item 2 — Payroll readiness dashboard.
//
// Verifies GET /payroll/readiness returns the right green/red flags per
// active associate, the summary counts add up, and the canonical
// "missing X" cases each flip the right flag while leaving the others
// alone. Soft-deleted associates are excluded so the dashboard reflects
// the population HR actually has to act on.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAsHr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = request.agent(app());
  const r = await a
    .post('/auth/login')
    .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
  expect(r.status).toBe(200);
  return a;
}

async function makeSchedule() {
  return prisma.payrollSchedule.create({
    data: {
      name: 'Biweekly',
      frequency: 'BIWEEKLY',
      anchorDate: new Date('2026-01-02'),
      payDateOffsetDays: 5,
      isActive: true,
    },
  });
}

interface SeedOpts {
  withW4?: boolean;
  withTin?: boolean;
  taxState?: string | null;
  withPayoutMethod?: boolean;
  payoutKind?: 'BANK' | 'BRANCH';
  withSchedule?: boolean;
  withUser?: boolean;
  employmentType?: 'W2_EMPLOYEE' | 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS';
}

/** Seeds a fully-ready associate; toggles per opts to flip individual flags off. */
async function seedAssociate(opts: SeedOpts = {}) {
  const o = {
    withW4: opts.withW4 ?? true,
    withTin: opts.withTin ?? false,
    taxState: opts.taxState === undefined ? 'FL' : opts.taxState,
    withPayoutMethod: opts.withPayoutMethod ?? true,
    payoutKind: opts.payoutKind ?? ('BRANCH' as const),
    withSchedule: opts.withSchedule ?? true,
    withUser: opts.withUser ?? true,
    employmentType: opts.employmentType ?? ('W2_EMPLOYEE' as const),
  };

  const schedule = o.withSchedule ? await makeSchedule() : null;
  const associate = await createAssociate();
  await prisma.associate.update({
    where: { id: associate.id },
    data: {
      employmentType: o.employmentType,
      state: o.taxState,
      payrollScheduleId: schedule?.id ?? null,
      tinEncrypted: o.withTin ? encryptString('111223333') : null,
    },
  });

  if (o.withW4 && o.employmentType === 'W2_EMPLOYEE') {
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'SINGLE',
        ssnEncrypted: encryptString('123456789'),
        signedAt: new Date(),
      },
    });
  }

  if (o.withPayoutMethod) {
    await prisma.payoutMethod.create({
      data: {
        associateId: associate.id,
        isPrimary: true,
        ...(o.payoutKind === 'BRANCH'
          ? { type: 'BRANCH_CARD', branchCardId: 'br_test_card_123' }
          : {
              type: 'BANK_ACCOUNT',
              accountNumberEnc: Buffer.from('encrypted-acct'),
              routingNumberEnc: Buffer.from('encrypted-rt'),
              accountType: 'CHECKING',
            }),
      },
    });
  }

  if (o.withUser) {
    await createUser({ role: 'ASSOCIATE', associateId: associate.id });
  }

  return associate;
}

describe('GET /payroll/readiness — Item 2', () => {
  it('returns ready=true when all five flags are green', async () => {
    const a = await seedAssociate();
    const hr = await loginAsHr();
    const r = await hr.get('/payroll/readiness');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.readyCount).toBe(1);
    expect(r.body.missingCount).toBe(0);
    const row = r.body.rows.find((x: { associateId: string }) => x.associateId === a.id);
    expect(row.ready).toBe(true);
    expect(row.flags).toEqual({
      w4OnFile: true,
      taxStateSet: true,
      payoutMethodOnFile: true,
      payScheduleAssigned: true,
      userLinked: true,
    });
  });

  it('flags missing W-4 for a W-2 employee (and ready=false)', async () => {
    const a = await seedAssociate({ withW4: false });
    const hr = await loginAsHr();
    const r = await hr.get('/payroll/readiness');
    const row = r.body.rows.find((x: { associateId: string }) => x.associateId === a.id);
    expect(row.flags.w4OnFile).toBe(false);
    expect(row.ready).toBe(false);
    expect(r.body.missingCount).toBe(1);
  });

  it('1099 contractor: w4OnFile reflects TIN-on-file, not W-4', async () => {
    const withTin = await seedAssociate({
      employmentType: 'CONTRACTOR_1099_INDIVIDUAL',
      withW4: false,
      withTin: true,
    });
    const noTin = await seedAssociate({
      employmentType: 'CONTRACTOR_1099_INDIVIDUAL',
      withW4: false,
      withTin: false,
    });
    const hr = await loginAsHr();
    const r = await hr.get('/payroll/readiness');
    const rowWith = r.body.rows.find((x: { associateId: string }) => x.associateId === withTin.id);
    const rowNo = r.body.rows.find((x: { associateId: string }) => x.associateId === noTin.id);
    expect(rowWith.flags.w4OnFile).toBe(true);
    expect(rowNo.flags.w4OnFile).toBe(false);
  });

  it('flags missing or unsupported taxState', async () => {
    const noState = await seedAssociate({ taxState: null });
    const hr = await loginAsHr();
    const r = await hr.get('/payroll/readiness');
    const row = r.body.rows.find((x: { associateId: string }) => x.associateId === noState.id);
    expect(row.flags.taxStateSet).toBe(false);
    expect(row.ready).toBe(false);
  });

  it('flags missing payout method (no Branch card and no bank account)', async () => {
    const a = await seedAssociate({ withPayoutMethod: false });
    const hr = await loginAsHr();
    const r = await hr.get('/payroll/readiness');
    const row = r.body.rows.find((x: { associateId: string }) => x.associateId === a.id);
    expect(row.flags.payoutMethodOnFile).toBe(false);
    expect(row.ready).toBe(false);
  });

  it('payout method green when bank account is on file (no Branch card)', async () => {
    const a = await seedAssociate({ payoutKind: 'BANK' });
    const hr = await loginAsHr();
    const r = await hr.get('/payroll/readiness');
    const row = r.body.rows.find((x: { associateId: string }) => x.associateId === a.id);
    expect(row.flags.payoutMethodOnFile).toBe(true);
  });

  it('flags missing pay schedule', async () => {
    const a = await seedAssociate({ withSchedule: false });
    const hr = await loginAsHr();
    const r = await hr.get('/payroll/readiness');
    const row = r.body.rows.find((x: { associateId: string }) => x.associateId === a.id);
    expect(row.flags.payScheduleAssigned).toBe(false);
    expect(row.ready).toBe(false);
  });

  it('flags missing user account link', async () => {
    const a = await seedAssociate({ withUser: false });
    const hr = await loginAsHr();
    const r = await hr.get('/payroll/readiness');
    const row = r.body.rows.find((x: { associateId: string }) => x.associateId === a.id);
    expect(row.flags.userLinked).toBe(false);
    expect(row.ready).toBe(false);
  });

  it('excludes soft-deleted associates from the readiness population', async () => {
    const live = await seedAssociate();
    const deleted = await seedAssociate();
    await prisma.associate.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    const hr = await loginAsHr();
    const r = await hr.get('/payroll/readiness');
    expect(r.body.total).toBe(1);
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.rows[0].associateId).toBe(live.id);
  });

  it('refuses unauthenticated requests', async () => {
    const r = await request(app()).get('/payroll/readiness');
    expect(r.status).toBe(401);
  });

  it('refuses ASSOCIATE role (process:payroll capability required)', async () => {
    await seedAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = request.agent(app());
    await a.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    const r = await a.get('/payroll/readiness');
    expect([401, 403]).toContain(r.status);
  });
});
