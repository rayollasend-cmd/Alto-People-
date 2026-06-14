/**
 * Shift lifecycle actions added 2026-06-14: hard DELETE, per-shift
 * publish / un-publish (DRAFT ↔ OPEN with publishedAt handling), and the
 * guard that blocks editing a COMPLETED/CANCELLED shift.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
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

const future = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000);

function mkShift(clientId: string, status: 'DRAFT' | 'OPEN' | 'COMPLETED' | 'CANCELLED', extra: Record<string, unknown> = {}) {
  return prisma.shift.create({
    data: {
      clientId,
      position: 'Server',
      startsAt: future(60 * 24 * 20), // 20 days out — clear of the 14-day window
      endsAt: future(60 * 24 * 20 + 60 * 8),
      status,
      ...(status !== 'DRAFT' ? { publishedAt: new Date() } : {}),
      ...extra,
    },
  });
}

describe('shift lifecycle — delete / publish / un-publish / edit guard', () => {
  it('hard-deletes a shift', async () => {
    const client = await createClient();
    const shift = await mkShift(client.id, 'DRAFT');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const res = await agent.delete(`/scheduling/shifts/${shift.id}`);
    expect(res.status).toBe(204);
    expect(await prisma.shift.findUnique({ where: { id: shift.id } })).toBeNull();
  });

  it('publishes a DRAFT (stamps publishedAt) and un-publishes back to DRAFT (clears it)', async () => {
    const client = await createClient();
    const shift = await mkShift(client.id, 'DRAFT');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const pub = await agent.patch(`/scheduling/shifts/${shift.id}`).send({ status: 'OPEN' });
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe('OPEN');
    expect(pub.body.publishedAt).toBeTruthy();

    const unpub = await agent.patch(`/scheduling/shifts/${shift.id}`).send({ status: 'DRAFT' });
    expect(unpub.status).toBe(200);
    expect(unpub.body.status).toBe('DRAFT');
    expect(unpub.body.publishedAt).toBeNull();
  });

  it('refuses to edit a COMPLETED or CANCELLED shift', async () => {
    const client = await createClient();
    const completed = await mkShift(client.id, 'COMPLETED');
    const cancelled = await mkShift(client.id, 'CANCELLED');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const a = await agent.patch(`/scheduling/shifts/${completed.id}`).send({ position: 'Cook' });
    expect(a.status).toBe(409);
    expect(a.body.error?.code).toBe('shift_not_editable');

    const b = await agent.patch(`/scheduling/shifts/${cancelled.id}`).send({ status: 'OPEN' });
    expect(b.status).toBe(409);
    expect(b.body.error?.code).toBe('shift_not_editable');
  });
});
