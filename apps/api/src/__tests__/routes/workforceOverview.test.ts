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
    // TODAY'S gap: an OPEN shift overlapping NOW — "later today" seeds
    // (now+2h) slid past org-midnight when CI ran late in the ET evening
    // and today.open read 0 (same time-anchor rot as the client-portal
    // fix, 6d1520a). Overlapping now is today at any wall-clock hour.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Cashier',
        startsAt: new Date(now.getTime() - 1 * HOUR),
        endsAt: new Date(now.getTime() + 3 * HOUR),
        status: 'OPEN',
        publishedAt: now,
      },
    });
    // THE DISPATCH row: an upcoming OPEN shift inside the 48h window —
    // that window doesn't care about the midnight boundary.
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

  it('carries the two cross-department batons: ready-to-schedule and the payroll close', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    // HR approved both; only one has a future shift.
    const scheduled = await createAssociate({ firstName: 'Sana', lastName: 'Scheduled' });
    const waiting = await createAssociate({ firstName: 'Ben', lastName: 'Waiting' });
    for (const a of [scheduled, waiting]) {
      await prisma.application.create({
        data: {
          associateId: a.id,
          clientId: client.id,
          onboardingTrack: 'STANDARD',
          status: 'APPROVED',
          approvedAt: now,
        },
      });
    }
    await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: scheduled.id,
        position: 'Stocker',
        startsAt: new Date(now.getTime() + 24 * HOUR),
        endsAt: new Date(now.getTime() + 32 * HOUR),
        status: 'ASSIGNED',
        publishedAt: now,
      },
    });
    // One completed-but-unapproved timesheet — what Finance chases.
    await prisma.timeEntry.create({
      data: {
        associateId: scheduled.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 30 * HOUR),
        clockOutAt: new Date(now.getTime() - 22 * HOUR),
        status: 'COMPLETED',
      },
    });

    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const res = await (await loginAs(user.email)).get('/workforce/overview');
    expect(res.status).toBe(200);

    // The HR → field baton: approved with no upcoming shift.
    expect(res.body.readyToSchedule.count).toBe(1);
    expect(res.body.readyToSchedule.rows[0].name).toBe('Ben Waiting');
    expect(res.body.readyToSchedule.rows[0].clientName).toBe('Front Beach 218');

    // The field → Finance baton: unapproved timesheets on the WFM board.
    expect(res.body.close.pendingApprovals).toBe(1);
  });

  it('offers the internal labor market: short stores beside the bench', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    // A store short in the next days…
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Stocker',
        startsAt: new Date(now.getTime() + 5 * HOUR),
        endsAt: new Date(now.getTime() + 13 * HOUR),
        status: 'OPEN',
        publishedAt: now,
      },
    });
    // …and a recent worker holding no shift — the bench.
    const bench = await createAssociate({ firstName: 'Ben', lastName: 'Available' });
    await prisma.timeEntry.create({
      data: {
        associateId: bench.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 5 * 24 * HOUR),
        clockOutAt: new Date(now.getTime() - 5 * 24 * HOUR + 8 * HOUR),
        status: 'APPROVED',
      },
    });

    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const res = await (await loginAs(user.email)).get('/workforce/overview');
    expect(res.status).toBe(200);
    expect(res.body.rebalance.length).toBeGreaterThanOrEqual(1);
    expect(res.body.rebalance[0].clientName).toBe('Front Beach 218');
    expect(res.body.rebalance[0].open).toBeGreaterThanOrEqual(1);
    expect(res.body.rebalance[0].bench).toBeGreaterThanOrEqual(1);

    // The bench is org-wide data — client-bounded callers get none of it.
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const clamped = await (await loginAs(sup.email)).get('/workforce/overview');
    expect(clamped.status).toBe(200);
    expect(clamped.body.rebalance).toEqual([]);
  });

  it('feeds the WFM filters: operational client directory + locations, no money', async () => {
    const client = await createClient('Front Beach 218');
    const other = await createClient('Destin 4411');
    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const agent = await loginAs(user.email);

    // The operational directory: id/name/week anchor, NEVER bill rates —
    // that's why the WFM doesn't get /clients (view:clients) itself.
    const dir = await agent.get('/scheduling/clients');
    expect(dir.status).toBe(200);
    expect(dir.body.clients.map((c: { name: string }) => c.name).sort()).toEqual([
      'Destin 4411',
      'Front Beach 218',
    ]);
    expect(JSON.stringify(dir.body)).not.toContain('BillRate');
    expect((await agent.get('/clients')).status).toBe(403);

    // The location cascade is open to the WFM org-wide (site pickers on
    // the time board and scheduling grid were empty without it).
    expect((await agent.get(`/clients/${client.id}/locations`)).status).toBe(200);
    expect((await agent.get(`/clients/${other.id}/locations`)).status).toBe(200);

    // A bounded supervisor's directory is clamped to their own store.
    const { user: sup } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const supDir = await (await loginAs(sup.email)).get('/scheduling/clients');
    expect(supDir.status).toBe(200);
    expect(supDir.body.clients.map((c: { name: string }) => c.name)).toEqual([
      'Front Beach 218',
    ]);
  });

  it('an org-wide WFM with an incidental clientId still reads the whole org', async () => {
    const now = new Date();
    const mine = await createClient('Front Beach 218');
    const elsewhere = await createClient('Destin 4411');
    const worker = await createAssociate({ firstName: 'Far', lastName: 'Away' });
    await prisma.timeEntry.create({
      data: {
        associateId: worker.id,
        clientId: elsewhere.id,
        clockInAt: now,
        status: 'ACTIVE',
      },
    });
    // The account carries a clientId (mis-provisioned or re-roled) — the
    // ROLE is org-wide, so nothing may clamp to it.
    const { user } = await createUser({
      role: 'WORKFORCE_MANAGER',
      clientId: mine.id,
    });
    const res = await (await loginAs(user.email)).get('/workforce/overview');
    expect(res.status).toBe(200);
    expect(res.body.now.onFloor).toBe(1);
    expect(JSON.stringify(res.body)).toContain('Far Away');
  });

  it('right-sized role: workforce manager is OUT of payroll', async () => {
    const { user } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const agent = await loginAs(user.email);
    // The finance cockpit (process:payroll) must refuse them now.
    const res = await agent.get('/finance/overview');
    expect(res.status).toBe(403);
  });
});
