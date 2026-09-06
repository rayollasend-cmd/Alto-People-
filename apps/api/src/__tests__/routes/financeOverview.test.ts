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

/** The Finance cockpit endpoint: capability gate + the operating counts. */

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

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe('GET /finance/overview', () => {
  it('is gated on process:payroll', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const res = await (await loginAs(user.email)).get('/finance/overview');
    expect(res.status).toBe(403);
  });

  it('answers the operating loop: payday, chase, settlements, receivables', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    const a1 = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });

    // Biweekly schedule anchored 10 days back → a computable next payday.
    await prisma.payrollSchedule.create({
      data: {
        name: 'Biweekly — associates',
        frequency: 'BIWEEKLY',
        anchorDate: new Date(now.getTime() - 10 * DAY),
        payDateOffsetDays: 5,
      },
    });

    // One worked-but-unapproved entry (blocks the close): 8h, no breaks.
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 30 * HOUR),
        clockOutAt: new Date(now.getTime() - 22 * HOUR),
        status: 'COMPLETED',
      },
    });
    // An APPROVED entry must NOT count toward the chase.
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 54 * HOUR),
        clockOutAt: new Date(now.getTime() - 46 * HOUR),
        status: 'APPROVED',
      },
    });

    // MANAGER_APPROVED requires the approval stamp (DB check constraint
    // Reimbursement_manager_approved_chk) — mirror the real flow.
    const { user: mgr } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.reimbursement.create({
      data: {
        associateId: a1.id,
        title: 'Steel-toe boots',
        totalAmount: 84.5,
        status: 'MANAGER_APPROVED',
        managerApprovedById: mgr.id,
        managerApprovedAt: now,
      },
    });

    await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date(now.getTime() - 21 * DAY),
        periodEnd: new Date(now.getTime() - 15 * DAY),
        number: 7,
        status: 'FINAL',
        finalizedAt: new Date(now.getTime() - 14 * DAY),
        snapshot: { totals: { amount: 5000, hours: 236, regularHours: 236, otHours: 0 } },
      },
    });

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const res = await (await loginAs(user.email)).get('/finance/overview');
    expect(res.status).toBe(200);

    // Payday computed from the schedule, in the future.
    expect(res.body.payday.next).not.toBeNull();
    expect(new Date(res.body.payday.next.date).getTime()).toBeGreaterThan(now.getTime());
    expect(res.body.payday.next.schedule).toBe('Biweekly — associates');

    // The chase: exactly the unapproved 8h, attributed to the client.
    expect(res.body.close.pendingEntries).toBe(1);
    expect(res.body.close.pendingHours).toBeGreaterThan(6);
    expect(res.body.close.pendingHours).toBeLessThanOrEqual(8);
    expect(res.body.close.byClient[0].clientName).toBe('Front Beach 218');

    // Settlement queue.
    expect(res.body.settlements).toEqual({ count: 1, total: 84.5 });

    // Receivables: the unpaid FINAL statement, aged ~14 days.
    expect(res.body.receivables.outstandingCount).toBe(1);
    expect(res.body.receivables.outstandingTotal).toBe(5000);
    expect(res.body.receivables.oldestDays).toBeGreaterThanOrEqual(13);
  });
});
