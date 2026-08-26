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

/**
 * The scheduling grid's location filter must include the client's SITE-LESS
 * shifts (locationId null): a strict match made them vanish from every
 * filtered view while still blocking the overlap check — an invisible
 * conflict ("the day is empty but it says there's an overlapping shift").
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

describe('GET /scheduling/shifts with locationId', () => {
  it('returns that site AND site-less shifts, but not other sites', async () => {
    const client = await createClient();
    const locA = await prisma.location.findFirstOrThrow({
      where: { clientId: client.id },
    });
    const locB = await prisma.location.create({
      data: { clientId: client.id, name: 'Second site' },
    });

    const base = {
      clientId: client.id,
      startsAt: new Date('2026-08-28T22:00:00Z'),
      endsAt: new Date('2026-08-29T07:00:00Z'),
      status: 'OPEN' as const,
    };
    const atA = await prisma.shift.create({
      data: { ...base, position: 'At site A', locationId: locA.id },
    });
    const atB = await prisma.shift.create({
      data: { ...base, position: 'At site B', locationId: locB.id },
    });
    const siteless = await prisma.shift.create({
      data: { ...base, position: 'F&D Overnight Shift', locationId: null },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const res = await agent.get(
      `/scheduling/shifts?clientId=${client.id}&locationId=${locA.id}`,
    );
    expect(res.status).toBe(200);
    const ids = res.body.shifts.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual([atA.id, siteless.id].sort());
    expect(ids).not.toContain(atB.id);
  });
});
