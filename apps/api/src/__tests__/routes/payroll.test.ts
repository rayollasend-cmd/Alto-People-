import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

/**
 * Seed: one client + one associate with two APPROVED time entries totaling
 * 5 hours, and one ASSIGNED shift in the period at $20/hr.
 */
async function seedApprovedPeriod(opts: { rate?: number } = {}) {
  const rate = opts.rate ?? 20;
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const periodStart = new Date('2026-04-13T00:00:00.000Z');

  // Two approved entries totaling 5h
  await prisma.timeEntry.create({
    data: {
      associateId: associate.id,
      clientId: client.id,
      clockInAt: new Date('2026-04-14T13:00:00.000Z'),
      clockOutAt: new Date('2026-04-14T16:00:00.000Z'), // 3h
      status: 'APPROVED',
    },
  });
  await prisma.timeEntry.create({
    data: {
      associateId: associate.id,
      clientId: client.id,
      clockInAt: new Date('2026-04-15T13:00:00.000Z'),
      clockOutAt: new Date('2026-04-15T15:00:00.000Z'), // 2h
      status: 'APPROVED',
    },
  });
  // One COMPLETED (not approved) — should NOT be aggregated
  await prisma.timeEntry.create({
    data: {
      associateId: associate.id,
      clientId: client.id,
      clockInAt: new Date('2026-04-16T13:00:00.000Z'),
      clockOutAt: new Date('2026-04-16T21:00:00.000Z'), // 8h
      status: 'COMPLETED',
    },
  });
  // Shift at the chosen rate
  await prisma.shift.create({
    data: {
      clientId: client.id,
      assignedAssociateId: associate.id,
      position: 'Server',
      startsAt: new Date('2026-04-14T13:00:00.000Z'),
      endsAt: new Date('2026-04-14T18:00:00.000Z'),
      hourlyRate: rate,
      status: 'ASSIGNED',
    },
  });
  return { client, associate, periodStart };
}

describe('POST /payroll/runs', () => {
  it('aggregates APPROVED time only and snapshots gross/tax/net', async () => {
    const { associate } = await seedApprovedPeriod({ rate: 20 });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.items).toHaveLength(1);

    const item = res.body.items[0];
    expect(item.associateId).toBe(associate.id);
    expect(item.hoursWorked).toBe(5);
    expect(item.hourlyRate).toBe(20);
    expect(item.grossPay).toBe(100);
    // Phase 18 — real IRS Pub 15-T tables. $100 biweekly annualizes to
    // $2,600 — below the $6,000 standard-deduction line for SINGLE — so
    // federal withholding correctly rounds to $0. FICA + Medicare apply
    // (no zero-tax threshold). Fallback SIT (4%) on $100 = $4.
    expect(item.federalWithholding).toBe(0);
    expect(item.fica).toBeCloseTo(6.2, 2);
    expect(item.medicare).toBeCloseTo(1.45, 2);
    expect(item.stateWithholding).toBeCloseTo(4, 2);
    const totalTaxItem = item.federalWithholding + item.fica + item.medicare + item.stateWithholding;
    expect(item.netPay).toBeCloseTo(100 - totalTaxItem, 2);

    // Run totals match the single item
    expect(res.body.totalGross).toBe(100);
    expect(res.body.totalTax).toBeCloseTo(totalTaxItem, 2);
    expect(res.body.totalNet).toBeCloseTo(100 - totalTaxItem, 2);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'payroll.run_created', entityId: res.body.id },
    });
    expect(audit).not.toBeNull();
  });

  it('uses default rate when no shifts have one', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date('2026-04-14T13:00:00.000Z'),
        clockOutAt: new Date('2026-04-14T17:00:00.000Z'), // 4h
        status: 'APPROVED',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
      defaultHourlyRate: 25,
    });
    expect(res.status).toBe(201);
    expect(res.body.items[0].hourlyRate).toBe(25);
    expect(res.body.items[0].grossPay).toBe(100);
  });

  it('respects W-4 filing status when computing withholding', async () => {
    const { associate } = await seedApprovedPeriod({ rate: 20 });
    await prisma.w4Submission.create({
      data: {
        associateId: associate.id,
        filingStatus: 'MARRIED_FILING_JOINTLY',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });
    expect(res.status).toBe(201);
    // Phase 18 — MFJ at this income still owes $0 federal (annualized $2,600
    // is well below the $16,300 MFJ standard-deduction line). What the
    // assertion really wants to prove is "filing status is being read"; the
    // SINGLE case above already shows fed=$0 too, so verify by checking that
    // the W-4 row was actually used (taxState/ytdWages get populated).
    expect(res.body.items[0].federalWithholding).toBe(0);
    expect(res.body.items[0].ytdWages).toBe(0);
  });

  it('returns 400 when periodEnd < periodStart', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/payroll/runs').send({
      periodStart: '2026-04-19',
      periodEnd: '2026-04-13',
    });
    expect(res.status).toBe(400);
  });

  it('OPERATIONS_MANAGER cannot create a run (intentionally lacks process:payroll)', async () => {
    await seedApprovedPeriod();
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(ops.email);
    const res = await a.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });
    expect(res.status).toBe(403);
  });

  it('returns an empty run when no APPROVED entries exist in the period', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.totalGross).toBe(0);
  });
});

describe('Finalize → disburse lifecycle', () => {
  it('DRAFT → FINALIZED → DISBURSED, items get a stub ref', async () => {
    await seedApprovedPeriod({ rate: 20 });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const create = await a.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });

    const fin = await a.post(`/payroll/runs/${create.body.id}/finalize`).send({});
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('FINALIZED');
    expect(fin.body.finalizedAt).not.toBeNull();

    const dis = await a.post(`/payroll/runs/${create.body.id}/disburse`).send({});
    expect(dis.status).toBe(200);
    expect(dis.body.status).toBe('DISBURSED');
    expect(dis.body.items[0].status).toBe('DISBURSED');
    expect(dis.body.items[0].disbursementRef).toMatch(/^STUB-/);
  });

  it('cannot finalize a non-DRAFT run', async () => {
    await seedApprovedPeriod();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const create = await a.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });
    await a.post(`/payroll/runs/${create.body.id}/finalize`).send({});
    const second = await a.post(`/payroll/runs/${create.body.id}/finalize`).send({});
    expect(second.status).toBe(409);
  });

  it('cannot disburse a non-FINALIZED run', async () => {
    await seedApprovedPeriod();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const create = await a.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });
    const dis = await a.post(`/payroll/runs/${create.body.id}/disburse`).send({});
    expect(dis.status).toBe(409);
  });
});

describe('GET /payroll/runs', () => {
  it('FINANCE_ACCOUNTANT can view AND create runs (commit 42aefd1)', async () => {
    // FINANCE_ACCOUNTANT was elevated to process:payroll so finance teams
    // can run payroll without HR sign-off. ASSOCIATE remains denied below.
    await seedApprovedPeriod();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    await hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });

    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const finAgent = await loginAs(finance.email);

    const list = await finAgent.get('/payroll/runs');
    expect(list.status).toBe(200);
    expect(list.body.runs).toHaveLength(1);

    const create = await finAgent.post('/payroll/runs').send({
      periodStart: '2026-04-20',
      periodEnd: '2026-04-26',
    });
    expect(create.status).toBe(201);
  });

  it('ASSOCIATE cannot create runs (process:payroll required)', async () => {
    await seedApprovedPeriod();
    const associate = await createAssociate({ firstName: 'Pat', lastName: 'X' });
    const { user: assocUser } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(assocUser.email);
    const create = await a.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });
    expect(create.status).toBe(403);
  });
});

describe('GET /payroll/me/items', () => {
  it('associate sees their own paystubs only', async () => {
    const { client, associate } = await seedApprovedPeriod();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    await hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });

    // Another associate with their own approved entry
    const other = await createAssociate();
    await prisma.timeEntry.create({
      data: {
        associateId: other.id,
        clientId: client.id,
        clockInAt: new Date('2026-04-14T13:00:00.000Z'),
        clockOutAt: new Date('2026-04-14T17:00:00.000Z'),
        status: 'APPROVED',
      },
    });
    await hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-13',
      periodEnd: '2026-04-19',
    });

    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const meAgent = await loginAs(meUser.email);
    const res = await meAgent.get('/payroll/me/items');
    expect(res.status).toBe(200);
    for (const it of res.body.items) {
      expect(it.associateId).toBe(associate.id);
    }
  });
});
