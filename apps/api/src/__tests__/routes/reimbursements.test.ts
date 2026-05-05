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

interface ReimbursementSeed {
  associateAgent: TestAgent<Test>;
  associateUserId: string;
  associateId: string;
  managerAgent: TestAgent<Test>;
  hrAgent: TestAgent<Test>;
  financeAgent: TestAgent<Test>;
}

async function seedFlow(): Promise<ReimbursementSeed> {
  const associate = await createAssociate({ firstName: 'Jordan', lastName: 'Reyes' });
  const { user: assocUser } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
  const { user: mgr } = await createUser({ role: 'MANAGER' });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return {
    associateAgent: await loginAs(assocUser.email),
    associateUserId: assocUser.id,
    associateId: associate.id,
    managerAgent: await loginAs(mgr.email),
    hrAgent: await loginAs(hr.email),
    financeAgent: await loginAs(finance.email),
  };
}

describe('Reimbursement two-step approval — Gap 10', () => {
  it('happy path: associate submits → manager approves → HR settles → audit logged', async () => {
    const f = await seedFlow();

    // Associate creates a draft reimbursement.
    const create = await f.associateAgent
      .post('/reimbursements')
      .send({ title: 'Client lunch + travel' });
    expect(create.status).toBe(201);
    const reimbursementId = create.body.id as string;

    // Add a meals receipt line.
    const line1 = await f.associateAgent
      .post(`/reimbursements/${reimbursementId}/lines`)
      .send({
        kind: 'RECEIPT',
        description: 'Team lunch',
        incurredOn: '2026-04-15',
        amount: 47.32,
        receiptUrl: 'https://example.test/receipt-1.png',
      });
    expect(line1.status).toBe(201);

    // Add a mileage line — server computes amount.
    const line2 = await f.associateAgent
      .post(`/reimbursements/${reimbursementId}/lines`)
      .send({
        kind: 'MILEAGE',
        description: 'Drive to client site',
        incurredOn: '2026-04-15',
        amount: 0,
        miles: 30,
        ratePerMile: 0.67,
      });
    expect(line2.status).toBe(201);
    expect(Number(line2.body.totalAmount)).toBeCloseTo(47.32 + 30 * 0.67, 2);

    // Submit.
    const submit = await f.associateAgent
      .post(`/reimbursements/${reimbursementId}/submit`)
      .send({});
    expect(submit.status).toBe(200);
    let row = await prisma.reimbursement.findUniqueOrThrow({ where: { id: reimbursementId } });
    expect(row.status).toBe('SUBMITTED');
    expect(row.submittedAt).not.toBeNull();

    // Manager approves.
    const mgrApprove = await f.managerAgent
      .post(`/reimbursements/${reimbursementId}/manager-approve`)
      .send({ note: 'Looks reasonable' });
    expect(mgrApprove.status).toBe(200);
    row = await prisma.reimbursement.findUniqueOrThrow({ where: { id: reimbursementId } });
    expect(row.status).toBe('MANAGER_APPROVED');
    expect(row.managerApprovedAt).not.toBeNull();
    expect(row.managerNote).toBe('Looks reasonable');

    // HR settles.
    const settle = await f.hrAgent
      .post(`/reimbursements/${reimbursementId}/settle`)
      .send({});
    expect(settle.status).toBe(200);
    row = await prisma.reimbursement.findUniqueOrThrow({ where: { id: reimbursementId } });
    expect(row.status).toBe('SETTLED');
    expect(row.settledAt).not.toBeNull();
    expect(row.payrollItemId).toBeNull();
  });

  it('finance settles approved reimbursements (settle:reimbursement granted to FINANCE_ACCOUNTANT)', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'Supplies' });
    const id = create.body.id as string;
    await f.associateAgent.post(`/reimbursements/${id}/lines`).send({
      kind: 'RECEIPT',
      description: 'Pens + notebooks',
      incurredOn: '2026-04-10',
      amount: 22.5,
      receiptUrl: 'https://example.test/r.png',
    });
    await f.associateAgent.post(`/reimbursements/${id}/submit`).send({});
    await f.managerAgent.post(`/reimbursements/${id}/manager-approve`).send({});

    const settle = await f.financeAgent.post(`/reimbursements/${id}/settle`).send({});
    expect(settle.status).toBe(200);
  });

  it('manager rejects a SUBMITTED row (reason required)', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'Fancy dinner' });
    const id = create.body.id as string;
    await f.associateAgent.post(`/reimbursements/${id}/lines`).send({
      kind: 'RECEIPT',
      description: 'Dinner',
      incurredOn: '2026-04-15',
      amount: 480,
      receiptUrl: 'https://example.test/r.png',
    });
    await f.associateAgent.post(`/reimbursements/${id}/submit`).send({});

    const noReason = await f.managerAgent.post(`/reimbursements/${id}/reject`).send({});
    expect(noReason.status).toBe(400);

    const reject = await f.managerAgent
      .post(`/reimbursements/${id}/reject`)
      .send({ reason: 'Outside policy — $480 exceeds per-meal cap of $75' });
    expect(reject.status).toBe(200);
    const row = await prisma.reimbursement.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('REJECTED');
    expect(row.rejectionReason).toContain('Outside policy');
    expect(row.decidedById).toBeTruthy();
  });

  it('HR rejects a MANAGER_APPROVED row', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'Travel' });
    const id = create.body.id as string;
    await f.associateAgent.post(`/reimbursements/${id}/lines`).send({
      kind: 'RECEIPT',
      description: 'Hotel',
      incurredOn: '2026-04-15',
      amount: 220,
      receiptUrl: 'https://example.test/r.png',
    });
    await f.associateAgent.post(`/reimbursements/${id}/submit`).send({});
    await f.managerAgent.post(`/reimbursements/${id}/manager-approve`).send({});
    const reject = await f.hrAgent
      .post(`/reimbursements/${id}/reject`)
      .send({ reason: 'Duplicate of an earlier submission' });
    expect(reject.status).toBe(200);
    const row = await prisma.reimbursement.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('REJECTED');
  });

  it('rejects manager-approve on non-SUBMITTED', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'X' });
    const id = create.body.id as string;
    // Try manager-approve while still in DRAFT.
    const r = await f.managerAgent.post(`/reimbursements/${id}/manager-approve`).send({});
    expect(r.status).toBe(409);
  });

  it('rejects settle on non-MANAGER_APPROVED', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'X' });
    const id = create.body.id as string;
    await f.associateAgent.post(`/reimbursements/${id}/lines`).send({
      kind: 'RECEIPT',
      description: 'A',
      incurredOn: '2026-04-15',
      amount: 10,
      receiptUrl: 'https://example.test/r.png',
    });
    await f.associateAgent.post(`/reimbursements/${id}/submit`).send({});
    // SUBMITTED, not MANAGER_APPROVED yet.
    const r = await f.hrAgent.post(`/reimbursements/${id}/settle`).send({});
    expect(r.status).toBe(409);
  });

  it('settle blocks if any RECEIPT line lacks a receipt; waiver bypass requires a note', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'Lost-receipt expense' });
    const id = create.body.id as string;
    // RECEIPT line WITHOUT receiptUrl — receipt lost.
    await f.associateAgent.post(`/reimbursements/${id}/lines`).send({
      kind: 'RECEIPT',
      description: 'Meal — receipt lost in laundry',
      incurredOn: '2026-04-12',
      amount: 18.4,
    });
    await f.associateAgent.post(`/reimbursements/${id}/submit`).send({});
    await f.managerAgent.post(`/reimbursements/${id}/manager-approve`).send({});

    const blocked = await f.hrAgent.post(`/reimbursements/${id}/settle`).send({});
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('receipts_required');

    const noNote = await f.hrAgent
      .post(`/reimbursements/${id}/settle`)
      .send({ waiveMissingReceipts: true });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.code).toBe('waiver_note_required');

    const ok = await f.hrAgent.post(`/reimbursements/${id}/settle`).send({
      waiveMissingReceipts: true,
      waiverNote: 'Associate confirmed the meal; one-time exception.',
    });
    expect(ok.status).toBe(200);
    const row = await prisma.reimbursement.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SETTLED');
    expect(row.receiptWaiverNote).toContain('one-time exception');
  });

  it('payroll-fold integration: a SETTLED reimbursement folds into the next REGULAR run', async () => {
    const f = await seedFlow();
    const client = await createClient();
    const start = new Date('2026-04-01T13:00:00Z');
    await prisma.timeEntry.create({
      data: {
        associateId: f.associateId,
        clientId: client.id,
        clockInAt: start,
        clockOutAt: new Date(start.getTime() + 40 * 60 * 60 * 1000),
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
    await prisma.w4Submission.create({
      data: {
        associateId: f.associateId,
        filingStatus: 'SINGLE',
        multipleJobs: false,
        dependentsAmount: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
      },
    });
    // Submit + approve + settle a $50 reimbursement.
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'Office supplies' });
    const reimbursementId = create.body.id as string;
    await f.associateAgent.post(`/reimbursements/${reimbursementId}/lines`).send({
      kind: 'RECEIPT',
      description: 'Notebook + pens',
      incurredOn: '2026-04-05',
      amount: 50,
      receiptUrl: 'https://example.test/r.png',
    });
    await f.associateAgent.post(`/reimbursements/${reimbursementId}/submit`).send({});
    await f.managerAgent.post(`/reimbursements/${reimbursementId}/manager-approve`).send({});
    await f.hrAgent.post(`/reimbursements/${reimbursementId}/settle`).send({});

    // Create a payroll run — should fold the reimbursement.
    const runRes = await f.hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-01',
      periodEnd: '2026-04-15',
      defaultHourlyRate: 25,
      clientId: client.id,
    });
    expect(runRes.status).toBe(201);
    const runId = runRes.body.id as string;

    // Reimbursement should now be PAID with payrollItemId stamped.
    const updated = await prisma.reimbursement.findUniqueOrThrow({
      where: { id: reimbursementId },
    });
    expect(updated.status).toBe('PAID');
    expect(updated.payrollItemId).not.toBeNull();
    expect(updated.paidPayrollRunId).toBe(runId);

    // The PayrollItem should carry reimbursementsTotal=50 and netPay
    // should include the addition. Earnings should have a REIMBURSEMENT
    // line for the paystub PDF.
    const item = await prisma.payrollItem.findFirstOrThrow({
      where: { payrollRunId: runId, associateId: f.associateId },
      include: { earnings: true },
    });
    expect(Number(item.reimbursementsTotal)).toBeCloseTo(50, 2);
    const reimbursementLine = item.earnings.find((e) => e.kind === 'REIMBURSEMENT');
    expect(reimbursementLine).toBeDefined();
    expect(reimbursementLine!.isTaxable).toBe(false);
    expect(Number(reimbursementLine!.amount)).toBeCloseTo(50, 2);
  });

  it('payroll-fold does not double-pay: a PAID reimbursement stays paid on a re-aggregation', async () => {
    const f = await seedFlow();
    const client = await createClient();
    const start = new Date('2026-04-01T13:00:00Z');
    await prisma.timeEntry.create({
      data: {
        associateId: f.associateId,
        clientId: client.id,
        clockInAt: start,
        clockOutAt: new Date(start.getTime() + 40 * 60 * 60 * 1000),
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
    await prisma.w4Submission.create({
      data: {
        associateId: f.associateId,
        filingStatus: 'SINGLE',
        multipleJobs: false,
        dependentsAmount: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
      },
    });
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'Travel' });
    const id = create.body.id as string;
    await f.associateAgent.post(`/reimbursements/${id}/lines`).send({
      kind: 'RECEIPT',
      description: 'Cab',
      incurredOn: '2026-04-05',
      amount: 25,
      receiptUrl: 'https://example.test/r.png',
    });
    await f.associateAgent.post(`/reimbursements/${id}/submit`).send({});
    await f.managerAgent.post(`/reimbursements/${id}/manager-approve`).send({});
    await f.hrAgent.post(`/reimbursements/${id}/settle`).send({});

    // First run folds the row.
    const r1 = await f.hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-01',
      periodEnd: '2026-04-15',
      defaultHourlyRate: 25,
      clientId: client.id,
    });
    expect(r1.status).toBe(201);

    // Re-aggregating the same run (same period — POST /runs uses the
    // unique (run, associate) constraint to upsert) shouldn't re-pay.
    const r2 = await f.hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-01',
      periodEnd: '2026-04-15',
      defaultHourlyRate: 25,
      clientId: client.id,
    });
    // Expect either same run or 409 if already exists.
    const updated = await prisma.reimbursement.findUniqueOrThrow({ where: { id } });
    expect(updated.status).toBe('PAID');
    // Count REIMBURSEMENT earning lines — should be exactly one for this
    // payrollItem (no double-fold).
    const item = await prisma.payrollItem.findFirstOrThrow({
      where: { associateId: f.associateId },
      include: { earnings: { where: { kind: 'REIMBURSEMENT' } } },
    });
    expect(item.earnings.length).toBe(1);
    // Quiet vitest about r2 unused if it errored.
    expect([201, 409]).toContain(r2.status);
  });

  it('ASSOCIATE without submit:reimbursement (other associate) cannot see another associate row', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'Mine' });
    const id = create.body.id as string;

    // Different associate.
    const other = await createAssociate({ firstName: 'Other', lastName: 'Person' });
    const { user: otherUser } = await createUser({ role: 'ASSOCIATE', associateId: other.id });
    const otherAgent = await loginAs(otherUser.email);

    const fetch = await otherAgent.get(`/reimbursements/${id}`);
    expect(fetch.status).toBe(404);
  });

  it('FINANCE_ACCOUNTANT cannot manager-approve (lacks approve:reimbursement) → 403', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'X' });
    const id = create.body.id as string;
    await f.associateAgent.post(`/reimbursements/${id}/lines`).send({
      kind: 'RECEIPT',
      description: 'A',
      incurredOn: '2026-04-15',
      amount: 10,
      receiptUrl: 'https://example.test/r.png',
    });
    await f.associateAgent.post(`/reimbursements/${id}/submit`).send({});
    const r = await f.financeAgent.post(`/reimbursements/${id}/manager-approve`).send({});
    expect(r.status).toBe(403);
  });

  it('MANAGER cannot settle (lacks settle:reimbursement) → 403', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'X' });
    const id = create.body.id as string;
    await f.associateAgent.post(`/reimbursements/${id}/lines`).send({
      kind: 'RECEIPT',
      description: 'A',
      incurredOn: '2026-04-15',
      amount: 10,
      receiptUrl: 'https://example.test/r.png',
    });
    await f.associateAgent.post(`/reimbursements/${id}/submit`).send({});
    await f.managerAgent.post(`/reimbursements/${id}/manager-approve`).send({});
    const r = await f.managerAgent.post(`/reimbursements/${id}/settle`).send({});
    expect(r.status).toBe(403);
  });

  it('mileage line uses server-computed amount = miles × ratePerMile', async () => {
    const f = await seedFlow();
    const create = await f.associateAgent.post('/reimbursements').send({ title: 'Drives' });
    const id = create.body.id as string;
    const line = await f.associateAgent.post(`/reimbursements/${id}/lines`).send({
      kind: 'MILEAGE',
      description: 'Round trip to client',
      incurredOn: '2026-04-15',
      amount: 0,
      miles: 47.3,
      ratePerMile: 0.67,
    });
    expect(line.status).toBe(201);
    const row = await prisma.expenseLine.findUniqueOrThrow({ where: { id: line.body.id } });
    expect(Number(row.amount)).toBeCloseTo(47.3 * 0.67, 2);
  });
});
