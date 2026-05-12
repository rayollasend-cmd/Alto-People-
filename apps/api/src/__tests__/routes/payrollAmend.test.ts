import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
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

interface SeedDisbursedRun {
  hrAgent: TestAgent<Test>;
  hrUserId: string;
  runId: string;
  clientId: string;
  associateId: string;
  itemId: string;
  itemNetPay: number;
  itemGross: number;
}

/**
 * Create one DISBURSED run with one associate at a known $25/hr × 40h
 * shift so the deltas in amend tests are predictable.
 */
async function seedDisbursedRun(): Promise<SeedDisbursedRun> {
  const client = await createClient();
  const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const start = new Date('2026-04-01T13:00:00Z');
  await prisma.timeEntry.create({
    data: {
      associateId: associate.id,
      clientId: client.id,
      clockInAt: start,
      clockOutAt: new Date(start.getTime() + 40 * 60 * 60 * 1000),
      status: 'APPROVED',
      approvedAt: new Date(),
    },
  });
  await prisma.w4Submission.create({
    data: {
      associateId: associate.id,
      filingStatus: 'SINGLE',
      multipleJobs: false,
      dependentsAmount: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
  });
  // Wire associate to a User so they can authenticate downstream tests.
  await createUser({ role: 'ASSOCIATE', associateId: associate.id });

  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const hrAgent = await loginAs(hr.email);
  const create = await hrAgent.post('/payroll/runs').send({
    periodStart: '2026-04-01',
    periodEnd: '2026-04-15',
    defaultHourlyRate: 25,
    clientId: client.id,
  });
  if (create.status !== 201) throw new Error(`create failed ${create.status}`);
  const runId = create.body.id as string;
  const itemId = create.body.items[0].id as string;
  const itemNet = Number(create.body.items[0].netPay);
  const itemGross = Number(create.body.items[0].grossPay);

  await hrAgent.post(`/payroll/runs/${runId}/finalize`);
  const disb = await hrAgent.post(`/payroll/runs/${runId}/disburse`);
  if (disb.body.status !== 'DISBURSED') {
    throw new Error(`disburse failed: ${JSON.stringify(disb.body)}`);
  }

  return {
    hrAgent,
    hrUserId: hr.id,
    runId,
    clientId: client.id,
    associateId: associate.id,
    itemId,
    itemNetPay: itemNet,
    itemGross,
  };
}

/** Build an amend body with the given gross + zero taxes (simplifies math). */
function amendCorrection(associateId: string, opts: {
  hoursWorked: number;
  hourlyRate: number;
  grossPay: number;
  fed?: number;
  fica?: number;
  medicare?: number;
}) {
  return {
    associateId,
    hoursWorked: opts.hoursWorked,
    hourlyRate: opts.hourlyRate,
    grossPay: opts.grossPay,
    federalWithholding: opts.fed ?? 0,
    fica: opts.fica ?? 0,
    medicare: opts.medicare ?? 0,
    stateWithholding: 0,
    preTaxDeductions: 0,
    postTaxDeductions: 0,
    employerFica: 0,
    employerMedicare: 0,
    employerFuta: 0,
    employerSuta: 0,
  };
}

describe('POST /payroll/runs/:id/amend — Gap 3', () => {
  it('happy path with positive delta: creates an AMENDMENT run with signed-delta items, kind/amendsRunId/amendmentReason set, audit logged', async () => {
    const { hrAgent, runId, associateId, itemId, itemGross, itemNetPay } = await seedDisbursedRun();

    const reason = 'Hours corrected from 40 to 44 — clock-in records verified with Shift Lead ASN log';
    const correctedGross = itemGross + 100;
    const res = await hrAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason,
      corrections: [
        amendCorrection(associateId, {
          hoursWorked: 44,
          hourlyRate: 25,
          grossPay: correctedGross,
        }),
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('AMENDMENT');
    expect(res.body.amendsRunId).toBe(runId);
    expect(res.body.amendmentReason).toBe(reason);
    expect(res.body.status).toBe('DRAFT');

    const amendmentRun = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { items: true },
    });
    expect(amendmentRun.kind).toBe('AMENDMENT');
    expect(amendmentRun.amendmentReason).toBe(reason);
    expect(amendmentRun.amendsRunId).toBe(runId);
    expect(amendmentRun.items).toHaveLength(1);

    const item = amendmentRun.items[0];
    expect(item.amendsItemId).toBe(itemId);
    // gross delta is +100 (we corrected up by 4 hours × $25/h).
    expect(Number(item.grossPay)).toBeCloseTo(100, 1);
    // Net delta is positive (this is supplemental pay). Exact value
    // depends on how HR set the corrected taxes; we just assert sign.
    expect(Number(item.netPay)).toBeGreaterThan(0);
    // Avoid an unused-binding warning for itemNetPay (kept for symmetry
    // with the seedDisbursedRun return shape).
    void itemNetPay;

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'PayrollRun', entityId: amendmentRun.id, action: 'payroll.run_amended' },
    });
    expect(audit).not.toBeNull();
  });

  it('negative-net amendment creates a PendingPayrollDeduction on disburse and does not call the rail', async () => {
    const { hrAgent, runId, associateId, itemGross } = await seedDisbursedRun();

    const correctedGross = itemGross - 200; // overpayment of $200 gross
    const amend = await hrAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason: 'Two hours subtracted — clock-in punch was a duplicate',
      corrections: [
        amendCorrection(associateId, {
          hoursWorked: 38,
          hourlyRate: 25,
          grossPay: correctedGross,
        }),
      ],
    });
    expect(amend.status).toBe(201);
    const amendId = amend.body.id as string;

    // Finalize then disburse — disburse should NOT call the rail for the
    // negative-net item, and SHOULD create a PendingPayrollDeduction.
    await hrAgent.post(`/payroll/runs/${amendId}/finalize`);
    const disb = await hrAgent.post(`/payroll/runs/${amendId}/disburse`);
    expect(disb.status).toBe(200);

    // Item is DISBURSED (settled in Alto, no rail call needed).
    const itemRow = await prisma.payrollItem.findFirstOrThrow({
      where: { payrollRunId: amendId },
    });
    expect(itemRow.status).toBe('DISBURSED');
    expect(itemRow.disbursedAt).not.toBeNull();
    // Negative net pay is preserved on the item — it's the audit record.
    expect(Number(itemRow.netPay)).toBeLessThan(0);

    // Pending deduction created with magnitude = abs(netPay).
    const pending = await prisma.pendingPayrollDeduction.findMany({
      where: { associateId },
    });
    expect(pending).toHaveLength(1);
    expect(Number(pending[0].amount)).toBeCloseTo(Math.abs(Number(itemRow.netPay)), 1);
    expect(pending[0].appliedRunId).toBeNull();
    expect(pending[0].sourceAmendmentItemId).toBe(itemRow.id);

    // No PayrollDisbursementAttempt was logged for the negative-net item
    // (skipped the rail entirely).
    const attempts = await prisma.payrollDisbursementAttempt.findMany({
      where: { payrollItemId: itemRow.id },
    });
    expect(attempts).toHaveLength(0);
  });

  it('next REGULAR run drains the pending deduction as a postTaxDeductions line', async () => {
    const { hrAgent, runId, associateId, clientId, itemGross } = await seedDisbursedRun();

    // Step 1 — amend the original run down by $200 gross (creates a
    // negative-net item) and disburse so a PendingPayrollDeduction lands.
    const amend = await hrAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason: 'Overpayment — 8h reported but 6h actually worked',
      corrections: [
        amendCorrection(associateId, {
          hoursWorked: 38,
          hourlyRate: 25,
          grossPay: itemGross - 200,
        }),
      ],
    });
    const amendId = amend.body.id as string;
    await hrAgent.post(`/payroll/runs/${amendId}/finalize`);
    await hrAgent.post(`/payroll/runs/${amendId}/disburse`);

    const pendingBefore = await prisma.pendingPayrollDeduction.findFirstOrThrow({
      where: { associateId, appliedRunId: null },
    });
    const pendingAmount = Number(pendingBefore.amount);
    expect(pendingAmount).toBeGreaterThan(0);

    // Step 2 — seed time for the *next* period and create a fresh REGULAR
    // run. The aggregator should drain the pending deduction onto the
    // associate's new paystub.
    const nextStart = new Date('2026-04-15T13:00:00Z');
    await prisma.timeEntry.create({
      data: {
        associateId,
        clientId,
        clockInAt: nextStart,
        clockOutAt: new Date(nextStart.getTime() + 40 * 60 * 60 * 1000),
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
    const nextRun = await hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-15',
      periodEnd: '2026-04-29',
      defaultHourlyRate: 25,
      clientId,
    });
    expect(nextRun.status).toBe(201);
    const newItem = nextRun.body.items[0];

    // The new item's postTaxDeductions should INCLUDE the pending amount.
    expect(Number(newItem.postTaxDeductions)).toBeCloseTo(pendingAmount, 1);

    // Pending row marked applied.
    const pendingAfter = await prisma.pendingPayrollDeduction.findUniqueOrThrow({
      where: { id: pendingBefore.id },
    });
    expect(pendingAfter.appliedRunId).toBe(nextRun.body.id);
    expect(pendingAfter.appliedItemId).toBe(newItem.id);
    expect(pendingAfter.appliedAt).not.toBeNull();
  });

  it('YTD recalc — closes Gap 8: a downward amendment reduces the next run\'s YTD wage figure', async () => {
    const { hrAgent, runId, associateId, clientId, itemGross } = await seedDisbursedRun();

    // Amend down by $200 and disburse.
    const amend = await hrAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason: 'Wage correction — 2h subtracted',
      corrections: [
        amendCorrection(associateId, {
          hoursWorked: 38,
          hourlyRate: 25,
          grossPay: itemGross - 200,
        }),
      ],
    });
    const amendId = amend.body.id as string;
    await hrAgent.post(`/payroll/runs/${amendId}/finalize`);
    await hrAgent.post(`/payroll/runs/${amendId}/disburse`);

    // Next REGULAR run for the same associate; its item.ytdWages should
    // reflect (original $itemGross − $200) NOT the original snapshot.
    const nextStart = new Date('2026-04-15T13:00:00Z');
    await prisma.timeEntry.create({
      data: {
        associateId,
        clientId,
        clockInAt: nextStart,
        clockOutAt: new Date(nextStart.getTime() + 40 * 60 * 60 * 1000),
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
    const nextRun = await hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-15',
      periodEnd: '2026-04-29',
      defaultHourlyRate: 25,
      clientId,
    });
    const newItem = nextRun.body.items[0];
    // YTD on the next paystub = (original gross + amendment delta)
    //                        = (original − 200).
    expect(Number(newItem.ytdWages)).toBeCloseTo(itemGross - 200, 1);
  });

  it('refuses to amend a CANCELLED run', async () => {
    const { hrAgent, runId } = await seedDisbursedRun();
    // Void the original first.
    await hrAgent.post(`/payroll/runs/${runId}/void`).send({
      reason: 'voided for test setup',
    });

    const res = await hrAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason: 'cannot amend a voided run',
      corrections: [],
    });
    // The empty corrections array fails Zod first; pass a real (but
    // semantically irrelevant) correction so the route hits the
    // run_cancelled guard.
    expect([400, 409]).toContain(res.status);
  });

  it('refuses to amend a CANCELLED run (with valid body)', async () => {
    const { hrAgent, runId, associateId, itemGross } = await seedDisbursedRun();
    await hrAgent.post(`/payroll/runs/${runId}/void`).send({
      reason: 'voided for test setup',
    });
    const res = await hrAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason: 'attempt after void',
      corrections: [
        amendCorrection(associateId, {
          hoursWorked: 41,
          hourlyRate: 25,
          grossPay: itemGross + 25,
        }),
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('run_cancelled');
  });

  it('refuses to amend with no reason', async () => {
    const { hrAgent, runId, associateId } = await seedDisbursedRun();
    const res = await hrAgent.post(`/payroll/runs/${runId}/amend`).send({
      corrections: [amendCorrection(associateId, { hoursWorked: 41, hourlyRate: 25, grossPay: 1025 })],
    });
    expect(res.status).toBe(400);
  });

  it('refuses to amend with empty / whitespace reason', async () => {
    const { hrAgent, runId, associateId } = await seedDisbursedRun();
    const res = await hrAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason: '   ',
      corrections: [amendCorrection(associateId, { hoursWorked: 41, hourlyRate: 25, grossPay: 1025 })],
    });
    expect(res.status).toBe(400);
  });

  it('refuses to amend if a correction targets an associate not on the original run', async () => {
    const { hrAgent, runId } = await seedDisbursedRun();
    const stranger = await createAssociate({ firstName: 'Stranger', lastName: 'Danger' });
    const res = await hrAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason: 'attempted with off-run associate',
      corrections: [
        amendCorrection(stranger.id, { hoursWorked: 1, hourlyRate: 25, grossPay: 25 }),
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('unknown_associate');
  });

  it('FINANCE_ACCOUNTANT cannot amend → 403', async () => {
    const { runId, associateId, itemGross } = await seedDisbursedRun();
    const { user: fa } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const faAgent = await loginAs(fa.email);
    const res = await faAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason: 'should not be allowed',
      corrections: [
        amendCorrection(associateId, { hoursWorked: 41, hourlyRate: 25, grossPay: itemGross + 25 }),
      ],
    });
    expect(res.status).toBe(403);
  });

  it('OPERATIONS_MANAGER cannot amend → 403', async () => {
    const { runId, associateId, itemGross } = await seedDisbursedRun();
    const { user: om } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const omAgent = await loginAs(om.email);
    const res = await omAgent.post(`/payroll/runs/${runId}/amend`).send({
      reason: 'should not be allowed',
      corrections: [
        amendCorrection(associateId, { hoursWorked: 41, hourlyRate: 25, grossPay: itemGross + 25 }),
      ],
    });
    expect(res.status).toBe(403);
  });
});
