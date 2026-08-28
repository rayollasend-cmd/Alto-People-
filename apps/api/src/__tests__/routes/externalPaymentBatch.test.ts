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

/**
 * Batch external-payment recording: period-prefill computes hours + a
 * suggested gross from approved time (sheet math), and record-period
 * writes the whole run idempotently — re-recording refreshes, never
 * duplicates.
 */

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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

describe('external payment batch recording', () => {
  it('prefills from approved time and records the run idempotently', async () => {
    const client = await createClient();
    const worker = await createAssociate({ firstName: 'Paid', lastName: 'Weekly' });
    await prisma.compensationRecord.create({
      data: {
        associateId: worker.id,
        amount: 16,
        payType: 'HOURLY',
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        reason: 'HIRE',
      },
    });
    const clockInAt = new Date('2026-08-24T09:00:00.000Z');
    await prisma.timeEntry.create({
      data: {
        associateId: worker.id,
        clientId: client.id,
        clockInAt,
        clockOutAt: new Date(clockInAt.getTime() + 8 * 3600_000),
        status: 'APPROVED',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const prefill = await agent.get(
      '/external-payments/period-prefill?from=2026-08-22&to=2026-08-28',
    );
    expect(prefill.status).toBe(200);
    expect(prefill.body.rows).toHaveLength(1);
    expect(prefill.body.rows[0].associateId).toBe(worker.id);
    expect(prefill.body.rows[0].regularHours).toBeCloseTo(8, 1);
    expect(prefill.body.rows[0].suggestedGross).toBeCloseTo(128, 1);
    expect(prefill.body.rows[0].alreadyRecorded).toBe(false);
    // The recorder returns no PII.
    expect(prefill.body.rows[0].ssn).toBeUndefined();
    expect(prefill.body.rows[0].accountNumber).toBeUndefined();

    const first = await agent.post('/external-payments/record-period').send({
      periodStart: '2026-08-22',
      periodEnd: '2026-08-28',
      method: 'DIRECT_DEPOSIT',
      reference: 'run #1',
      rows: [{ associateId: worker.id, grossAmount: 128 }],
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ created: 1, updated: 0, skipped: 0 });

    // Re-record with a corrected amount: refresh, not a duplicate.
    const second = await agent.post('/external-payments/record-period').send({
      periodStart: '2026-08-22',
      periodEnd: '2026-08-28',
      method: 'DIRECT_DEPOSIT',
      reference: 'run #1 corrected',
      rows: [{ associateId: worker.id, grossAmount: 130 }],
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: 0, updated: 1 });

    const rows = await prisma.externalPayment.findMany({
      where: { associateId: worker.id, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].grossAmount)).toBe(130);
    expect(rows[0].reference).toBe('run #1 corrected');

    const again = await agent.get(
      '/external-payments/period-prefill?from=2026-08-22&to=2026-08-28',
    );
    expect(again.body.rows[0].alreadyRecorded).toBe(true);
    expect(again.body.rows[0].recordedGross).toBe(130);
  });
});
