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

interface SeedDisbursedRun {
  hrAgent: TestAgent<Test>;
  hrUserId: string;
  runId: string;
  clientId: string;
  associateUserIds: string[];
}

/**
 * Seed a fully-DISBURSED run with two associates so the void path has
 * something realistic to operate on. Each associate gets a `User` row so
 * the void notification fan-out has a recipient to write to.
 */
async function seedDisbursedRun(): Promise<SeedDisbursedRun> {
  const client = await createClient();
  const a1 = await createAssociate({ firstName: 'Alice', lastName: 'Anderson' });
  const a2 = await createAssociate({ firstName: 'Bob', lastName: 'Brown' });
  const start = new Date('2026-04-01T13:00:00Z');
  for (const a of [a1, a2]) {
    await prisma.timeEntry.create({
      data: {
        associateId: a.id,
        clientId: client.id,
        clockInAt: start,
        clockOutAt: new Date(start.getTime() + 40 * 60 * 60 * 1000),
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
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
  // Wire each associate to a User so notification fan-out has a target.
  const associateUserIds: string[] = [];
  for (const a of [a1, a2]) {
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    associateUserIds.push(user.id);
  }

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

  const finalize = await hrAgent.post(`/payroll/runs/${runId}/finalize`);
  if (finalize.status !== 200) throw new Error(`finalize failed ${finalize.status}`);

  const disburse = await hrAgent.post(`/payroll/runs/${runId}/disburse`);
  if (disburse.status !== 200) throw new Error(`disburse failed ${disburse.status}`);
  if (disburse.body.status !== 'DISBURSED') {
    throw new Error(`expected DISBURSED, got ${disburse.body.status}`);
  }

  return { hrAgent, hrUserId: hr.id, runId, clientId: client.id, associateUserIds };
}

describe('POST /payroll/runs/:id/void — Gap 3', () => {
  it('happy path: flips run to CANCELLED, items to VOIDED, stamps cancel metadata, fans out IN_APP notifications, logs audit', async () => {
    const { hrAgent, hrUserId, runId, associateUserIds } = await seedDisbursedRun();

    const reason = 'Duplicate run created when wizard double-submitted';
    const res = await hrAgent.post(`/payroll/runs/${runId}/void`).send({ reason });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.cancelReason).toBe(reason);
    expect(res.body.cancelledById).toBe(hrUserId);
    expect(res.body.cancelledAt).toBeTruthy();

    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('CANCELLED');
    expect(run.cancelReason).toBe(reason);
    expect(run.cancelledById).toBe(hrUserId);
    expect(run.cancelledAt).not.toBeNull();

    const items = await prisma.payrollItem.findMany({ where: { payrollRunId: runId } });
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.status).toBe('VOIDED');
      expect(it.voidedAt).not.toBeNull();
    }

    // Each associate user with a row in this run gets one IN_APP notification.
    const notifications = await prisma.notification.findMany({
      where: { recipientUserId: { in: associateUserIds }, category: 'payroll.run_voided' },
    });
    expect(notifications).toHaveLength(associateUserIds.length);
    for (const n of notifications) {
      expect(n.channel).toBe('IN_APP');
      expect(n.status).toBe('SENT');
      expect(n.subject).toContain('voided');
      expect(n.body).toContain(reason);
      expect(n.linkUrl).toBe('/me/paystubs');
    }

    // Audit row at the run scope.
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'PayrollRun', entityId: runId, action: 'payroll.run_voided' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(hrUserId);
  });

  it('stamps voidJournalEntryId from the QBO reversing JE in stub mode', async () => {
    const { hrAgent, runId, clientId } = await seedDisbursedRun();
    // Connect the client to QBO (stub mode) so the void path will post a
    // reversing JE. accessToken/refreshToken values are unused in stub
    // mode but the columns are NOT NULL on the schema; placeholder bytes
    // are fine for this test path (no real Intuit call goes out).
    const placeholder = Buffer.from('stub');
    await prisma.quickbooksConnection.create({
      data: {
        clientId,
        realmId: 'STUB-REALM',
        accessTokenEnc: placeholder,
        refreshTokenEnc: placeholder,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    // Re-disburse path is one-shot; fake the qboJournalEntryId since the
    // forward sync only fires when the connection existed at disburse time.
    await prisma.payrollRun.update({
      where: { id: runId },
      data: { qboJournalEntryId: 'STUB-QBO-original-1', qboSyncedAt: new Date() },
    });
    const res = await hrAgent.post(`/payroll/runs/${runId}/void`).send({
      reason: 'Wrong period — supposed to be the next biweekly window',
    });
    expect(res.status).toBe(200);

    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.voidJournalEntryId).toMatch(/^STUB-QBO-REV-/);
  });

  it('refuses to void a DRAFT run', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date('2026-04-01T13:00:00Z'),
        clockOutAt: new Date('2026-04-01T18:00:00Z'),
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
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const create = await hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-01',
      periodEnd: '2026-04-15',
      defaultHourlyRate: 25,
    });
    const runId = create.body.id as string;

    const res = await hrAgent.post(`/payroll/runs/${runId}/void`).send({ reason: 'oops' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_disbursed');
  });

  it('refuses to void a FINALIZED run', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date('2026-04-01T13:00:00Z'),
        clockOutAt: new Date('2026-04-01T18:00:00Z'),
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
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const create = await hrAgent.post('/payroll/runs').send({
      periodStart: '2026-04-01',
      periodEnd: '2026-04-15',
      defaultHourlyRate: 25,
    });
    const runId = create.body.id as string;
    await hrAgent.post(`/payroll/runs/${runId}/finalize`);

    const res = await hrAgent.post(`/payroll/runs/${runId}/void`).send({ reason: 'oops' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_disbursed');
  });

  it('refuses to void a run disbursed more than 30 days ago', async () => {
    const { hrAgent, runId } = await seedDisbursedRun();
    // Backdate disbursedAt to 31 days ago.
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await prisma.payrollRun.update({
      where: { id: runId },
      data: { disbursedAt: thirtyOneDaysAgo },
    });

    const res = await hrAgent.post(`/payroll/runs/${runId}/void`).send({
      reason: 'Trying to void after the window',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('window_expired');
  });

  it('refuses to void with no reason', async () => {
    const { hrAgent, runId } = await seedDisbursedRun();
    const res = await hrAgent.post(`/payroll/runs/${runId}/void`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('refuses to void with an empty / whitespace-only reason', async () => {
    const { hrAgent, runId } = await seedDisbursedRun();
    const res = await hrAgent.post(`/payroll/runs/${runId}/void`).send({ reason: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_body');
  });

  it('FINANCE_ACCOUNTANT cannot void (process:payroll yes, void:payroll no) → 403', async () => {
    const { runId } = await seedDisbursedRun();
    const { user: fa } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const faAgent = await loginAs(fa.email);
    const res = await faAgent.post(`/payroll/runs/${runId}/void`).send({ reason: 'no' });
    expect(res.status).toBe(403);
  });

  it('OPERATIONS_MANAGER cannot void → 403 (FULL_ADMIN does not include void:payroll)', async () => {
    const { runId } = await seedDisbursedRun();
    const { user: om } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const omAgent = await loginAs(om.email);
    const res = await omAgent.post(`/payroll/runs/${runId}/void`).send({ reason: 'no' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown run id', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent
      .post('/payroll/runs/00000000-0000-0000-0000-000000000000/void')
      .send({ reason: 'any' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('run_not_found');
  });
});
