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
    // The board: one triage-sorted tile per store, red for the walk-on punch.
    expect(res.body.today.stores[0].clientName).toBe('Front Beach 218');
    expect(res.body.today.stores[0].unscheduledNow).toBe(1);
    expect(res.body.today.stores[0].status).toBe('red');
    expect(res.body.needsAttention).toBeGreaterThanOrEqual(1);
    // The wire carries the unscheduled punch by name.
    expect(
      res.body.wire.some(
        (w: { type: string; name: string | null }) =>
          w.type === 'unscheduled' && w.name === 'Walk On',
      ),
    ).toBe(true);
    expect(res.body.dispatch.openNext48h).toBeGreaterThanOrEqual(1);
  });

  it('lists the supervisor corps with contact facts from the linked associate', async () => {
    const client = await createClient('Front Beach 218');
    const supAssoc = await createAssociate({ firstName: 'Rae', lastName: 'Lead' });
    await prisma.associate.update({
      where: { id: supAssoc.id },
      data: { phone: '+1 555 010 0200' },
    });
    await createUser({
      role: 'SHIFT_SUPERVISOR',
      email: supAssoc.email,
      associateId: supAssoc.id,
      clientId: client.id,
    });
    await createUser({ role: 'FLOOR_SUPERVISOR', clientId: client.id });

    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const res = await (await loginAs(user.email)).get('/workforce/supervisors');
    expect(res.status).toBe(200);
    expect(res.body.supervisors).toHaveLength(2);
    const shift = res.body.supervisors.find(
      (s: { role: string }) => s.role === 'SHIFT_SUPERVISOR',
    );
    expect(shift.name).toBe('Rae Lead');
    expect(shift.phone).toBe('+1 555 010 0200');
    expect(shift.clientName).toBe('Front Beach 218');
  });

  it('clamps client-bounded supervisors to their own client on every read', async () => {
    const now = new Date();
    const clientA = await createClient('Front Beach 218');
    const clientB = await createClient('Destin 4411');
    const aWorker = await createAssociate({ firstName: 'Ava', lastName: 'MineStore' });
    const bWorker = await createAssociate({ firstName: 'Zed', lastName: 'OtherStore' });
    // Live punches at BOTH clients (no shift → both are pre-shift flags).
    await prisma.timeEntry.create({
      data: { associateId: aWorker.id, clientId: clientA.id, clockInAt: now, status: 'ACTIVE' },
    });
    await prisma.timeEntry.create({
      data: { associateId: bWorker.id, clientId: clientB.id, clockInAt: now, status: 'ACTIVE' },
    });
    // A supervisor account at B (must be invisible to A's supervisor).
    await createUser({ role: 'FLOOR_SUPERVISOR', clientId: clientB.id });

    const { user: supA } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: clientA.id,
    });
    const agent = await loginAs(supA.email);

    const overview = await agent.get('/workforce/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.now.onFloor).toBe(1);
    const raw = JSON.stringify(overview.body);
    expect(raw).toContain('Ava MineStore');
    expect(raw).not.toContain('OtherStore');
    expect(raw).not.toContain('Destin 4411');

    const sups = await agent.get('/workforce/supervisors');
    expect(sups.status).toBe(200);
    // Only their own client's supervisor corps (themselves here).
    expect(
      sups.body.supervisors.every(
        (s: { clientName: string | null }) => s.clientName !== 'Destin 4411',
      ),
    ).toBe(true);
  });

  it('right-sized role: workforce manager is OUT of payroll', async () => {
    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const agent = await loginAs(user.email);
    // The finance cockpit (process:payroll) must refuse them now.
    const res = await agent.get('/finance/overview');
    expect(res.status).toBe(403);
  });
});
