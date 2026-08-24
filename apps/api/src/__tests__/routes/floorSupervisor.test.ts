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
 * FLOOR_SUPERVISOR — the watch-only step-down from SHIFT_SUPERVISOR.
 * Sees the live clocked-in board for their own client, and can decide
 * NOTHING: no walk-in approvals, no manual entries, no timesheet
 * approval.
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
  const r = await a
    .post('/auth/login')
    .send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

describe('FLOOR_SUPERVISOR', () => {
  it('sees ONLY their own site on the live board', async () => {
    const mine = await createClient('Walmart Destin');
    const other = await createClient('Walmart Pier Park');
    const a1 = await createAssociate({ firstName: 'On', lastName: 'MyFloor' });
    const a2 = await createAssociate({ firstName: 'Other', lastName: 'Site' });
    await prisma.timeEntry.createMany({
      data: [
        { associateId: a1.id, clientId: mine.id, clockInAt: new Date(Date.now() - 3600_000), status: 'ACTIVE' },
        { associateId: a2.id, clientId: other.id, clockInAt: new Date(Date.now() - 3600_000), status: 'ACTIVE' },
      ],
    });

    const { user } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: mine.id });
    const agent = await loginAs(user.email);
    const res = await agent.get('/time/admin/active');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain(a1.id);
    expect(body).not.toContain(a2.id);
  });

  it('cannot approve walk-ins, add entries, or approve time', async () => {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'Wants', lastName: 'In' });
    const walkIn = await prisma.clockInRequest.create({
      data: { associateId: associate.id, clientId: client.id, requestedAt: new Date() },
    });
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: new Date(Date.now() - 8 * 3600_000),
        clockOutAt: new Date(Date.now() - 3600_000),
        status: 'COMPLETED',
      },
    });

    const { user } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: client.id });
    const agent = await loginAs(user.email);

    expect(
      (await agent.post(`/time/admin/clock-in-requests/${walkIn.id}/approve`)).status,
    ).toBe(403);
    expect(
      (
        await agent.post('/time/admin/entries').send({
          associateId: associate.id,
          clockInAt: new Date().toISOString(),
        })
      ).status,
    ).toBe(403);
    expect((await agent.post(`/time/admin/entries/${entry.id}/approve`)).status).toBe(403);
    // Nothing changed underneath.
    expect(
      (await prisma.clockInRequest.findUniqueOrThrow({ where: { id: walkIn.id } })).status,
    ).toBe('PENDING');
    expect(
      (await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).status,
    ).toBe('COMPLETED');
  });
});
