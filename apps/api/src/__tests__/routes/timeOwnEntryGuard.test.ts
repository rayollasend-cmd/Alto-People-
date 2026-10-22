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
 * A supervisor cannot approve their own time (role walk floor 25). Dana's
 * own FORGOT_CLOCKOUT entry sat in her queue with an Approve button; time
 * corrections already refused the same decision (own_correction), and
 * approval is the same decision. Single approve, bulk approve and
 * payroll's clean-time approve all refuse with 403 own_entry; the rest of
 * a bulk proceeds.
 */

const app = () => createApp();
const HOUR = 3_600_000;

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

async function completedEntry(associateId: string, clientId: string, hoursAgo = 9) {
  const clockInAt = new Date(Date.now() - hoursAgo * HOUR);
  return prisma.timeEntry.create({
    data: { associateId, clientId, clockInAt, clockOutAt: new Date(clockInAt.getTime() + 8 * HOUR), status: 'COMPLETED', anomalies: [] },
  });
}

describe('own-entry approval guard', () => {
  it('single approve of your own entry is refused and leaves it pending', async () => {
    const client = await createClient();
    const dana = await createAssociate({ firstName: 'Dana', lastName: 'Lead' });
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: dana.id });
    const own = await completedEntry(dana.id, client.id);
    const a = await loginAs(user.email);
    const res = await a.post(`/time/admin/entries/${own.id}/approve`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('own_entry');
    const after = await prisma.timeEntry.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.status).toBe('COMPLETED');
    expect(after.approvedById).toBeNull();
  });

  it('bulk approve fails the own row with own_entry and approves the rest', async () => {
    const client = await createClient();
    const dana = await createAssociate({ firstName: 'Dana', lastName: 'Lead' });
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: dana.id });
    const own = await completedEntry(dana.id, client.id);
    const theirs = await completedEntry(maria.id, client.id);
    const a = await loginAs(user.email);
    const res = await a.post('/time/admin/bulk-approve').send({ entryIds: [own.id, theirs.id] });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    const rows = res.body.results as Array<{ entryId: string; ok: boolean; errorCode: string | null }>;
    expect(rows.find((r) => r.entryId === own.id)).toMatchObject({ ok: false, errorCode: 'own_entry' });
    expect(rows.find((r) => r.entryId === theirs.id)).toMatchObject({ ok: true });
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: own.id } })).status).toBe('COMPLETED');
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('APPROVED');
  });

  it('an approver with no associate record approves anyone', async () => {
    const client = await createClient();
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const entry = await completedEntry(maria.id, client.id);
    const a = await loginAs(user.email);
    const res = await a.post(`/time/admin/entries/${entry.id}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
  });
});
