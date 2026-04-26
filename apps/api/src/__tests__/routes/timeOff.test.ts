import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
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

async function seedWorld(state: string | null = 'CA') {
  const associate = await prisma.associate.create({
    data: {
      firstName: 'Sick',
      lastName: 'Leaver',
      email: `sl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      state,
    },
  });
  const { user: assocUser } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { associate, assocUser, hr };
}

describe('POST /time/admin/entries/:id/approve — accrual side-effect', () => {
  it('CA: approving a 30h entry credits SICK balance with 60 min and writes a ledger row', async () => {
    const { associate, hr } = await seedWorld('CA');
    const clockIn = new Date('2026-04-26T13:00:00.000Z');
    const clockOut = new Date(clockIn.getTime() + 30 * 60 * 60 * 1000);
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clockInAt: clockIn,
        clockOutAt: clockOut,
        status: 'COMPLETED',
      },
    });
    const a = await loginAs(hr.email);
    const res = await a.post(`/time/admin/entries/${entry.id}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');

    const bal = await prisma.timeOffBalance.findUnique({
      where: { associateId_category: { associateId: associate.id, category: 'SICK' } },
    });
    expect(bal?.balanceMinutes).toBe(60);

    const ledger = await prisma.timeOffLedgerEntry.findMany({
      where: { associateId: associate.id },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('ACCRUAL');
    expect(ledger[0].sourceTimeEntryId).toBe(entry.id);
  });

  it('TX: 8h entry approved → no SICK accrual (state has no law)', async () => {
    const { associate, hr } = await seedWorld('TX');
    const clockIn = new Date('2026-04-26T13:00:00.000Z');
    const clockOut = new Date(clockIn.getTime() + 8 * 60 * 60 * 1000);
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clockInAt: clockIn,
        clockOutAt: clockOut,
        status: 'COMPLETED',
      },
    });
    const a = await loginAs(hr.email);
    const res = await a.post(`/time/admin/entries/${entry.id}/approve`).send({});
    expect(res.status).toBe(200);

    const ledger = await prisma.timeOffLedgerEntry.count({ where: { associateId: associate.id } });
    expect(ledger).toBe(0);
  });

  it('re-approve is idempotent (no double credit)', async () => {
    const { associate, hr } = await seedWorld('CA');
    const clockIn = new Date('2026-04-26T13:00:00.000Z');
    const clockOut = new Date(clockIn.getTime() + 30 * 60 * 60 * 1000);
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clockInAt: clockIn,
        clockOutAt: clockOut,
        status: 'COMPLETED',
      },
    });
    const a = await loginAs(hr.email);
    await a.post(`/time/admin/entries/${entry.id}/approve`).send({});
    await a.post(`/time/admin/entries/${entry.id}/approve`).send({});

    const ledger = await prisma.timeOffLedgerEntry.count({ where: { associateId: associate.id } });
    expect(ledger).toBe(1);
    const bal = await prisma.timeOffBalance.findUnique({
      where: { associateId_category: { associateId: associate.id, category: 'SICK' } },
    });
    expect(bal?.balanceMinutes).toBe(60);
  });
});

describe('GET /time-off/me/balance', () => {
  it('returns balances + recent ledger for the calling associate', async () => {
    const { associate, assocUser, hr } = await seedWorld('NY');
    const clockIn = new Date('2026-04-26T13:00:00.000Z');
    const clockOut = new Date(clockIn.getTime() + 30 * 60 * 60 * 1000);
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clockInAt: clockIn,
        clockOutAt: clockOut,
        status: 'COMPLETED',
      },
    });
    const hrAgent = await loginAs(hr.email);
    await hrAgent.post(`/time/admin/entries/${entry.id}/approve`).send({});

    const a = await loginAs(assocUser.email);
    const res = await a.get('/time-off/me/balance');
    expect(res.status).toBe(200);
    expect(res.body.balances).toEqual([{ category: 'SICK', balanceMinutes: 60 }]);
    expect(res.body.recentLedger).toHaveLength(1);
    expect(res.body.recentLedger[0].deltaMinutes).toBe(60);
    expect(res.body.recentLedger[0].reason).toBe('ACCRUAL');
  });

  it('non-associate (HR) → 403', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/time-off/me/balance');
    expect(res.status).toBe(403);
  });
});
