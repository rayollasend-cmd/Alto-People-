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

/** The Workforce Manager's field cockpit endpoint. */

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

describe('GET /workforce/overview', () => {
  it('is gated on manage:scheduling', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const res = await (await loginAs(user.email)).get('/workforce/overview');
    expect(res.status).toBe(403);
  });

  it('reports the floor, the pre-shift check, gaps, and dispatch', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    const scheduled = await createAssociate({ firstName: 'Sana', lastName: 'OnShift' });
    const walkOn = await createAssociate({ firstName: 'Walk', lastName: 'On' });

    // A live scheduled shift with a matching punch…
    const liveShift = await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: scheduled.id,
        position: 'Stocker',
        startsAt: new Date(now.getTime() - HOUR),
        endsAt: new Date(now.getTime() + 3 * HOUR),
        status: 'ASSIGNED',
        publishedAt: now,
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: scheduled.id,
        clientId: client.id,
        shiftId: liveShift.id,
        clockInAt: new Date(now.getTime() - HOUR),
        status: 'ACTIVE',
      },
    });
    // …and a punch with NO shift behind it — the pre-shift check catch.
    await prisma.timeEntry.create({
      data: {
        associateId: walkOn.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 30 * 60_000),
        status: 'ACTIVE',
      },
    });
    // An OPEN shift later today (gap) that also lands in the 48h window.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Cashier',
        startsAt: new Date(now.getTime() + 2 * HOUR),
        endsAt: new Date(now.getTime() + 6 * HOUR),
        status: 'OPEN',
        publishedAt: now,
      },
    });

    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const res = await (await loginAs(user.email)).get('/workforce/overview');
    expect(res.status).toBe(200);

    expect(res.body.now.onFloor).toBe(2);
    expect(res.body.now.unscheduledCount).toBe(1);
    expect(res.body.now.unscheduled[0].name).toBe('Walk On');
    expect(res.body.now.unscheduled[0].clientName).toBe('Front Beach 218');

    expect(res.body.today.open).toBeGreaterThanOrEqual(1);
    expect(res.body.today.gaps[0].clientName).toBe('Front Beach 218');
    expect(res.body.dispatch.openNext48h).toBeGreaterThanOrEqual(1);
  });

  it('right-sized role: workforce manager is OUT of payroll', async () => {
    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const agent = await loginAs(user.email);
    // The finance cockpit (process:payroll) must refuse them now.
    const res = await agent.get('/finance/overview');
    expect(res.status).toBe(403);
  });
});
