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

/* -------------------------------------------------------------------------- *
 *  Phase 30 — Time-off request + approval workflow
 * -------------------------------------------------------------------------- */

async function seedAssociateWithBalance(opts: {
  category?: 'SICK' | 'VACATION';
  balanceMinutes?: number;
  state?: string | null;
} = {}) {
  const associate = await prisma.associate.create({
    data: {
      firstName: 'Vac',
      lastName: 'Taker',
      email: `vac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      state: opts.state ?? 'CA',
    },
  });
  const { user: assocUser } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  if (opts.balanceMinutes && opts.balanceMinutes > 0) {
    await prisma.timeOffBalance.create({
      data: {
        associateId: associate.id,
        category: opts.category ?? 'VACATION',
        balanceMinutes: opts.balanceMinutes,
      },
    });
    await prisma.timeOffLedgerEntry.create({
      data: {
        associateId: associate.id,
        category: opts.category ?? 'VACATION',
        reason: 'ADJUSTMENT',
        deltaMinutes: opts.balanceMinutes,
        notes: 'test seed',
      },
    });
  }
  return { associate, assocUser, hr };
}

describe('POST /time-off/me/requests', () => {
  it('associate submits a request → returns the row in PENDING', async () => {
    const { assocUser } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const a = await loginAs(assocUser.email);
    const res = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-05',
      hours: 8,
      reason: 'Long weekend',
    });
    expect(res.status).toBe(201);
    expect(res.body.request.status).toBe('PENDING');
    expect(res.body.request.requestedMinutes).toBe(480);
    expect(res.body.request.startDate).toBe('2026-05-04');
    expect(res.body.request.endDate).toBe('2026-05-05');
    expect(res.body.request.reason).toBe('Long weekend');
  });

  it('rejects endDate before startDate', async () => {
    const { assocUser } = await seedAssociateWithBalance({ balanceMinutes: 0 });
    const a = await loginAs(assocUser.email);
    const res = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-05',
      endDate: '2026-05-04',
      hours: 8,
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-associate caller (HR) → 403', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /time-off/me/requests', () => {
  it('returns only the calling associate\'s requests, newest first', async () => {
    const { assocUser } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const otherAssoc = await prisma.associate.create({
      data: {
        firstName: 'Other',
        lastName: 'Person',
        email: `other-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      },
    });
    await prisma.timeOffRequest.create({
      data: {
        associateId: otherAssoc.id,
        category: 'VACATION',
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        endDate: new Date('2026-06-01T00:00:00.000Z'),
        requestedMinutes: 240,
      },
    });

    const a = await loginAs(assocUser.email);
    await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-05',
      endDate: '2026-05-05',
      hours: 4,
    });

    const res = await a.get('/time-off/me/requests');
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(2);
    expect(res.body.requests[0].requestedMinutes).toBe(240);
    expect(res.body.requests[1].requestedMinutes).toBe(480);
  });
});

describe('POST /time-off/me/requests/:id/cancel', () => {
  it('PENDING → CANCELLED for the owning associate', async () => {
    const { assocUser } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const a = await loginAs(assocUser.email);
    const create = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    const id = create.body.request.id;

    const res = await a.post(`/time-off/me/requests/${id}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('CANCELLED');
    expect(res.body.request.cancelledAt).toBeTruthy();
  });

  it('cross-associate cancel → 404 (existence-oracle discipline)', async () => {
    const { assocUser } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const otherAssoc = await prisma.associate.create({
      data: {
        firstName: 'Other',
        lastName: 'Person',
        email: `o2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      },
    });
    await createUser({ role: 'ASSOCIATE', email: otherAssoc.email, associateId: otherAssoc.id });
    const otherReq = await prisma.timeOffRequest.create({
      data: {
        associateId: otherAssoc.id,
        category: 'VACATION',
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        endDate: new Date('2026-06-01T00:00:00.000Z'),
        requestedMinutes: 240,
      },
    });

    const a = await loginAs(assocUser.email);
    const res = await a.post(`/time-off/me/requests/${otherReq.id}/cancel`).send({});
    expect(res.status).toBe(404);
  });

  it('cancel an already-APPROVED request → 409', async () => {
    const { assocUser, hr } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const a = await loginAs(assocUser.email);
    const create = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    const id = create.body.request.id;
    const hrAgent = await loginAs(hr.email);
    const approve = await hrAgent.post(`/time-off/admin/requests/${id}/approve`).send({});
    expect(approve.status).toBe(200);

    const res = await a.post(`/time-off/me/requests/${id}/cancel`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('illegal_state');
  });
});

describe('POST /time-off/admin/requests/:id/approve — atomic ledger debit', () => {
  it('happy path: approves, writes USE ledger row, debits balance', async () => {
    const { associate, assocUser, hr } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const a = await loginAs(assocUser.email);
    const create = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    const id = create.body.request.id;

    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent.post(`/time-off/admin/requests/${id}/approve`).send({
      note: 'Have fun',
    });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('APPROVED');
    expect(res.body.request.reviewerNote).toBe('Have fun');
    expect(res.body.request.reviewerEmail).toBe(hr.email);

    const bal = await prisma.timeOffBalance.findUnique({
      where: { associateId_category: { associateId: associate.id, category: 'VACATION' } },
    });
    expect(bal?.balanceMinutes).toBe(0);

    const useLedger = await prisma.timeOffLedgerEntry.findFirst({
      where: { associateId: associate.id, reason: 'USE' },
    });
    expect(useLedger).toBeTruthy();
    expect(useLedger?.deltaMinutes).toBe(-480);
    expect(useLedger?.sourceRequestId).toBe(id);
  });

  it('insufficient balance → 409 with currentMinutes/requestedMinutes details', async () => {
    const { assocUser, hr } = await seedAssociateWithBalance({ balanceMinutes: 60 });
    const a = await loginAs(assocUser.email);
    const create = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    const id = create.body.request.id;

    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent.post(`/time-off/admin/requests/${id}/approve`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('insufficient_balance');
    expect(res.body.error.details).toEqual({
      currentMinutes: 60,
      requestedMinutes: 480,
    });
  });

  it('double-approve → 409 (no double-debit)', async () => {
    const { associate, assocUser, hr } = await seedAssociateWithBalance({ balanceMinutes: 960 });
    const a = await loginAs(assocUser.email);
    const create = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    const id = create.body.request.id;

    const hrAgent = await loginAs(hr.email);
    const first = await hrAgent.post(`/time-off/admin/requests/${id}/approve`).send({});
    expect(first.status).toBe(200);
    const second = await hrAgent.post(`/time-off/admin/requests/${id}/approve`).send({});
    expect(second.status).toBe(409);

    const bal = await prisma.timeOffBalance.findUnique({
      where: { associateId_category: { associateId: associate.id, category: 'VACATION' } },
    });
    expect(bal?.balanceMinutes).toBe(480); // 960 - 480 only once
  });

  it('non-HR caller → 403', async () => {
    const { assocUser } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const a = await loginAs(assocUser.email);
    const create = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    const id = create.body.request.id;

    const res = await a.post(`/time-off/admin/requests/${id}/approve`).send({});
    expect(res.status).toBe(403);
  });
});

describe('POST /time-off/admin/requests/:id/deny', () => {
  it('happy path with required note', async () => {
    const { associate, assocUser, hr } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const a = await loginAs(assocUser.email);
    const create = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    const id = create.body.request.id;

    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent.post(`/time-off/admin/requests/${id}/deny`).send({
      note: 'Coverage gap that week',
    });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('DENIED');
    expect(res.body.request.reviewerNote).toBe('Coverage gap that week');

    // Balance untouched.
    const bal = await prisma.timeOffBalance.findUnique({
      where: { associateId_category: { associateId: associate.id, category: 'VACATION' } },
    });
    expect(bal?.balanceMinutes).toBe(480);
  });

  it('rejects deny without a note', async () => {
    const { assocUser, hr } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const a = await loginAs(assocUser.email);
    const create = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    const id = create.body.request.id;
    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent.post(`/time-off/admin/requests/${id}/deny`).send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /time-off/admin/requests', () => {
  it('default returns all requests, status filter narrows', async () => {
    const { assocUser, hr } = await seedAssociateWithBalance({ balanceMinutes: 480 });
    const a = await loginAs(assocUser.email);
    const c1 = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-04',
      endDate: '2026-05-04',
      hours: 8,
    });
    const c2 = await a.post('/time-off/me/requests').send({
      category: 'VACATION',
      startDate: '2026-05-05',
      endDate: '2026-05-05',
      hours: 4,
    });
    const hrAgent = await loginAs(hr.email);
    await hrAgent.post(`/time-off/admin/requests/${c1.body.request.id}/deny`).send({
      note: 'no',
    });

    const all = await hrAgent.get('/time-off/admin/requests');
    expect(all.status).toBe(200);
    expect(all.body.requests).toHaveLength(2);

    const pending = await hrAgent.get('/time-off/admin/requests?status=PENDING');
    expect(pending.body.requests).toHaveLength(1);
    expect(pending.body.requests[0].id).toBe(c2.body.request.id);

    const denied = await hrAgent.get('/time-off/admin/requests?status=DENIED');
    expect(denied.body.requests).toHaveLength(1);
    expect(denied.body.requests[0].id).toBe(c1.body.request.id);
  });
});
