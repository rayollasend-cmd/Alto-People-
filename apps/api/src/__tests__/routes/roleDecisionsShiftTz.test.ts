import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * One shift, one time (ops walk 2): the decision room's facts read each
 * shift on its own store's clock and name the store — never a hard-coded
 * zone, never "Housekeeper —" for the company's own shift.
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
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

describe('decision room facts for open shifts', () => {
  it('lists the shift at the store’s wall-clock time with the store’s name', async () => {
    const client = await createClient('Pacific Hotels');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: store.id }, data: { timezone: 'America/Los_Angeles', name: 'Santa Monica' } });
    // Starts in 2 hours, on the hour.
    const startsAt = new Date(Math.ceil((Date.now() + 2 * 3_600_000) / 3_600_000) * 3_600_000);
    await prisma.shift.create({
      data: { clientId: client.id, locationId: store.id, position: 'Housekeeper', startsAt, endsAt: new Date(startsAt.getTime() + 4 * 3_600_000), status: 'OPEN', publishedAt: new Date() },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const room = await a.get('/me/decisions/item?key=shifts:open-24h');
    expect(room.status).toBe(200);
    const laTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).format(startsAt);
    const line = (room.body.factList as string[]).find((l) => l.includes('Housekeeper'));
    expect(line).toBe(`${laTime} Housekeeper — Santa Monica`);
  });
});
