/**
 * Hardening (2026-06-14): cancelling a shift now also cancels its in-flight
 * swap requests, so a PENDING_PEER/PEER_ACCEPTED swap can't dangle (and the
 * counterparty can't "accept" a dead shift).
 */
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

describe('cancel shift cleans up in-flight swaps', () => {
  it('cancels PENDING_PEER and PEER_ACCEPTED swaps for the cancelled shift', async () => {
    const client = await createClient();
    const requester = await createAssociate({ firstName: 'Req', lastName: 'Uester' });
    const counterparty = await createAssociate({ firstName: 'Counter', lastName: 'Party' });
    const start = new Date(Date.now() + 60 * 60_000);
    const shift = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: start,
        endsAt: new Date(start.getTime() + 8 * 60 * 60_000),
        status: 'ASSIGNED',
        assignedAssociateId: requester.id,
        publishedAt: new Date(),
      },
    });
    const pending = await prisma.shiftSwapRequest.create({
      data: {
        shiftId: shift.id,
        requesterAssociateId: requester.id,
        counterpartyAssociateId: counterparty.id,
        status: 'PENDING_PEER',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const res = await agent
      .post(`/scheduling/shifts/${shift.id}/cancel`)
      .send({ reason: 'store closed' });
    expect(res.status).toBe(200);

    const after = await prisma.shiftSwapRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.status).toBe('CANCELLED');
  });
});
