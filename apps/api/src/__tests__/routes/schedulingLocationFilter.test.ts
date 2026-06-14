/**
 * Full-schedule cascading filter: GET /scheduling/shifts?clientId&locationId
 * narrows the org-wide schedule to one client, then to one work-site. Also
 * locks in that each shift carries its locationId / locationName / timezone
 * so the calendar can render + group by site. Reported 2026-06-13.
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

const future = (offsetMin: number) =>
  new Date(Date.now() + offsetMin * 60_000);

describe('GET /scheduling/shifts — full-schedule cascading filter', () => {
  it('filters to one client and then one location, and surfaces location/timezone on each shift', async () => {
    const clientA = await createClient('Walmart Front Beach');
    const clientB = await createClient('Target Pier Park');

    // clientA's default Location (created by createClient) + a second one.
    const locA1 = await prisma.location.findFirstOrThrow({ where: { clientId: clientA.id } });
    const locA2 = await prisma.location.create({
      data: { clientId: clientA.id, name: 'Garden Center', timezone: 'America/Chicago' },
    });
    const locB1 = await prisma.location.findFirstOrThrow({ where: { clientId: clientB.id } });

    const mkShift = (clientId: string, locationId: string, position: string) =>
      prisma.shift.create({
        data: {
          clientId,
          locationId,
          position,
          startsAt: future(60),
          endsAt: future(60 * 9),
          status: 'OPEN',
          publishedAt: new Date(),
        },
      });

    await mkShift(clientA.id, locA1.id, 'Front Cashier');
    await mkShift(clientA.id, locA2.id, 'Garden Associate');
    await mkShift(clientB.id, locB1.id, 'Stocker');

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    // No filter → the FULL schedule: every client's shifts.
    const all = await agent.get('/scheduling/shifts?status=OPEN');
    expect(all.status).toBe(200);
    expect(all.body.shifts).toHaveLength(3);

    // Narrow to clientA → both of A's shifts, none of B's.
    const byClient = await agent.get(`/scheduling/shifts?status=OPEN&clientId=${clientA.id}`);
    expect(byClient.body.shifts).toHaveLength(2);
    expect(
      byClient.body.shifts.every((s: { clientId: string }) => s.clientId === clientA.id),
    ).toBe(true);

    // Narrow to clientA + locA2 → just the Garden Center shift.
    const byLocation = await agent.get(
      `/scheduling/shifts?status=OPEN&clientId=${clientA.id}&locationId=${locA2.id}`,
    );
    expect(byLocation.body.shifts).toHaveLength(1);
    const shift = byLocation.body.shifts[0];
    expect(shift.position).toBe('Garden Associate');
    expect(shift.locationId).toBe(locA2.id);
    expect(shift.locationName).toBe('Garden Center');
    // The per-location timezone flows through (this location is Central).
    expect(shift.timezone).toBe('America/Chicago');
  });

  it('defaults a shift to the deployment timezone when its location has none set explicitly', async () => {
    const client = await createClient('Acme');
    const loc = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: loc.id,
        position: 'Server',
        startsAt: future(60),
        endsAt: future(60 * 8),
        status: 'OPEN',
        publishedAt: new Date(),
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get('/scheduling/shifts?status=OPEN');
    expect(res.status).toBe(200);
    // createClient's default Location inherits the schema default (Eastern).
    expect(res.body.shifts[0].timezone).toBe('America/New_York');
  });
});
