import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import {
  _setAdapterForTesting,
  type DisbursementAdapter,
} from '../../lib/disbursement.js';

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => _setAdapterForTesting(null));

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

async function seedRunWithItems() {
  const client = await createClient();
  const a1 = await createAssociate({ firstName: 'Alice', lastName: 'Anderson', email: `a1-${Math.random().toString(36).slice(2, 6)}@example.com` });
  const a2 = await createAssociate({ firstName: 'Bob', lastName: 'Brown', email: `a2-${Math.random().toString(36).slice(2, 6)}@example.com` });
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
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const hrAgent = await loginAs(hr.email);
  const create = await hrAgent.post('/payroll/runs').send({
    periodStart: '2026-04-01',
    periodEnd: '2026-04-15',
    defaultHourlyRate: 25,
  });
  if (create.status !== 201) throw new Error(`create failed ${create.status}`);
  const runId = create.body.id as string;
  const finalize = await hrAgent.post(`/payroll/runs/${runId}/finalize`);
  if (finalize.status !== 200) throw new Error(`finalize failed ${finalize.status}`);
  return { hrAgent, runId, items: create.body.items as { id: string; netPay: number }[] };
}

describe('POST /payroll/runs/:id/disburse — adapter wiring', () => {
  it('writes a SUCCESS PayrollDisbursementAttempt for each item and flips run to DISBURSED', async () => {
    const { hrAgent, runId, items } = await seedRunWithItems();

    const res = await hrAgent.post(`/payroll/runs/${runId}/disburse`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISBURSED');

    const attempts = await prisma.payrollDisbursementAttempt.findMany({
      where: { payrollItemId: { in: items.map((i) => i.id) } },
    });
    expect(attempts).toHaveLength(items.length);
    for (const a of attempts) {
      expect(a.status).toBe('SUCCESS');
      expect(a.provider).toBe('STUB');
      expect(a.externalRef).toMatch(/^STUB-/);
    }

    const updatedItems = await prisma.payrollItem.findMany({
      where: { id: { in: items.map((i) => i.id) } },
    });
    for (const it of updatedItems) {
      expect(it.status).toBe('DISBURSED');
      expect(it.disbursementRef).toMatch(/^STUB-/);
      expect(it.disbursedAt).not.toBeNull();
    }
  });

  it('a FAILED provider response holds the item, leaves the run un-disbursed, but still logs the attempt', async () => {
    const failingAdapter: DisbursementAdapter = {
      provider: 'WISE',
      async disburse() {
        return { provider: 'WISE', externalRef: '', status: 'FAILED', failureReason: 'card_declined' };
      },
    };
    _setAdapterForTesting(failingAdapter);

    const { hrAgent, runId, items } = await seedRunWithItems();
    const res = await hrAgent.post(`/payroll/runs/${runId}/disburse`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FINALIZED'); // not DISBURSED

    const updatedItems = await prisma.payrollItem.findMany({
      where: { id: { in: items.map((i) => i.id) } },
    });
    for (const it of updatedItems) {
      expect(it.status).toBe('HELD');
      expect(it.failureReason).toBe('card_declined');
    }

    const attempts = await prisma.payrollDisbursementAttempt.findMany({
      where: { payrollItemId: { in: items.map((i) => i.id) } },
    });
    expect(attempts.every((a) => a.status === 'FAILED')).toBe(true);
    expect(attempts.every((a) => a.failureReason === 'card_declined')).toBe(true);
  });

  it('refuses to disburse a non-FINALIZED run → 409', async () => {
    const { hrAgent, runId } = await seedRunWithItems();
    // First disburse flips to DISBURSED.
    const first = await hrAgent.post(`/payroll/runs/${runId}/disburse`);
    expect(first.status).toBe(200);
    // Second attempt: run is now DISBURSED, not FINALIZED.
    const second = await hrAgent.post(`/payroll/runs/${runId}/disburse`);
    expect(second.status).toBe(409);
  });
});

describe('GET /payroll/runs/:runId/paystubs.zip', () => {
  it('streams a ZIP of every paystub PDF in the run', async () => {
    const { hrAgent, runId, items } = await seedRunWithItems();
    const res = await hrAgent.get(`/payroll/runs/${runId}/paystubs.zip`).buffer().parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    // ZIP magic number "PK\x03\x04"
    const body = res.body as Buffer;
    expect(body.length).toBeGreaterThan(items.length * 800);
    expect(body[0]).toBe(0x50);
    expect(body[1]).toBe(0x4b);
    expect(body[2]).toBe(0x03);
    expect(body[3]).toBe(0x04);
  });

  it('returns 404 for a run that has no items', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const create = await a.post('/payroll/runs').send({
      periodStart: '2026-05-01',
      periodEnd: '2026-05-15',
    });
    const runId = create.body.id as string;
    const res = await a.get(`/payroll/runs/${runId}/paystubs.zip`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('no_items');
  });
});
