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

const future = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000).toISOString();

async function makeShift(clientId: string, opts: { startsAt?: string; endsAt?: string } = {}) {
  return prisma.shift.create({
    data: {
      clientId,
      position: 'Server',
      startsAt: new Date(opts.startsAt ?? future(60)),
      endsAt: new Date(opts.endsAt ?? future(60 * 8)),
      status: 'OPEN',
    },
  });
}

describe('GET /scheduling/shifts/:id/conflicts', () => {
  it('returns overlapping shifts for an associate', async () => {
    const client = await createClient();
    const assoc = await createAssociate();
    const a1 = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date(future(60)),
        endsAt: new Date(future(60 * 5)),
        assignedAssociateId: assoc.id,
        status: 'ASSIGNED',
      },
    });
    const target = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date(future(60 * 3)),
        endsAt: new Date(future(60 * 8)),
        status: 'OPEN',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get(
      `/scheduling/shifts/${target.id}/conflicts?associateId=${assoc.id}`
    );
    expect(res.status).toBe(200);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].conflictingShiftId).toBe(a1.id);
  });

  it('no conflicts → empty array', async () => {
    const client = await createClient();
    const assoc = await createAssociate();
    const target = await makeShift(client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get(
      `/scheduling/shifts/${target.id}/conflicts?associateId=${assoc.id}`
    );
    expect(res.body.conflicts).toEqual([]);
  });
});

describe('Auto-fill candidate ranking', () => {
  it('ranks an associate with availability + no conflict highest', async () => {
    const client = await createClient();
    // Target shift: Wed 14:00-22:00 UTC
    const wedNoon = new Date('2026-04-15T14:00:00Z');
    const wedTen = new Date('2026-04-15T22:00:00Z');
    const target = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: wedNoon,
        endsAt: wedTen,
        status: 'OPEN',
      },
    });

    const aGood = await createAssociate({ firstName: 'Available', lastName: 'Free' });
    await prisma.associateAvailability.create({
      data: {
        associateId: aGood.id,
        dayOfWeek: 3,         // Wednesday
        startMinute: 12 * 60, // 12:00
        endMinute: 23 * 60,   // 23:00
      },
    });

    const aBusy = await createAssociate({ firstName: 'Booked', lastName: 'Solid' });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date('2026-04-15T13:00:00Z'),
        endsAt: new Date('2026-04-15T18:00:00Z'),
        assignedAssociateId: aBusy.id,
        status: 'ASSIGNED',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get(`/scheduling/shifts/${target.id}/auto-fill`);
    expect(res.status).toBe(200);
    expect(res.body.candidates.length).toBeGreaterThanOrEqual(2);
    const top = res.body.candidates[0];
    expect(top.associateId).toBe(aGood.id);
    expect(top.matchesAvailability).toBe(true);
    expect(top.noConflict).toBe(true);
    expect(top.score).toBeGreaterThan(0.8);

    const busyEntry = res.body.candidates.find(
      (c: { associateId: string }) => c.associateId === aBusy.id
    );
    expect(busyEntry.noConflict).toBe(false);
  });
});

describe('Associate availability', () => {
  it('PUT /me/availability replaces the whole week', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);

    let res = await a.put('/scheduling/me/availability').send({
      windows: [
        { dayOfWeek: 1, startMinute: 540, endMinute: 1020 },  // Mon 9-17
        { dayOfWeek: 3, startMinute: 540, endMinute: 1020 },  // Wed 9-17
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.windows).toHaveLength(2);

    // Replace
    res = await a.put('/scheduling/me/availability').send({
      windows: [
        { dayOfWeek: 5, startMinute: 720, endMinute: 1320 },  // Fri 12-22
      ],
    });
    expect(res.body.windows).toHaveLength(1);
    expect(res.body.windows[0].dayOfWeek).toBe(5);
  });

  it('rejects window where end <= start', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);
    const res = await a.put('/scheduling/me/availability').send({
      windows: [{ dayOfWeek: 1, startMinute: 800, endMinute: 700 }],
    });
    expect(res.status).toBe(400);
  });
});

describe('Shift swap marketplace', () => {
  it('full happy path: requester → counterparty accept → manager approve → assignment swapped', async () => {
    const client = await createClient();
    const aRequester = await createAssociate({ firstName: 'Req', lastName: 'A' });
    const aCounter = await createAssociate({ firstName: 'Counter', lastName: 'B' });
    const { user: uReq } = await createUser({
      role: 'ASSOCIATE',
      email: aRequester.email,
      associateId: aRequester.id,
    });
    const { user: uCounter } = await createUser({
      role: 'ASSOCIATE',
      email: aCounter.email,
      associateId: aCounter.id,
    });
    const shift = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date(future(60)),
        endsAt: new Date(future(60 * 8)),
        assignedAssociateId: aRequester.id,
        status: 'ASSIGNED',
      },
    });

    const reqAgent = await loginAs(uReq.email);
    const create = await reqAgent.post('/scheduling/swap-requests').send({
      shiftId: shift.id,
      counterpartyAssociateId: aCounter.id,
      note: 'doctor appointment',
    });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('PENDING_PEER');

    const counterAgent = await loginAs(uCounter.email);
    const accept = await counterAgent
      .post(`/scheduling/swap-requests/${create.body.id}/peer-accept`)
      .send({});
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe('PEER_ACCEPTED');

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const approve = await hrAgent
      .post(`/scheduling/swap-requests/${create.body.id}/manager-approve`)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('MANAGER_APPROVED');

    const after = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.assignedAssociateId).toBe(aCounter.id);
  });

  it('counterparty cannot accept a swap they were not invited to', async () => {
    const client = await createClient();
    const aReq = await createAssociate();
    const aCounter = await createAssociate();
    const aOther = await createAssociate();
    const { user: uReq } = await createUser({
      role: 'ASSOCIATE',
      email: aReq.email,
      associateId: aReq.id,
    });
    const { user: uOther } = await createUser({
      role: 'ASSOCIATE',
      email: aOther.email,
      associateId: aOther.id,
    });
    const shift = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date(future(60)),
        endsAt: new Date(future(60 * 8)),
        assignedAssociateId: aReq.id,
        status: 'ASSIGNED',
      },
    });
    const reqAgent = await loginAs(uReq.email);
    const swap = await reqAgent.post('/scheduling/swap-requests').send({
      shiftId: shift.id,
      counterpartyAssociateId: aCounter.id,
    });
    const otherAgent = await loginAs(uOther.email);
    const r = await otherAgent.post(`/scheduling/swap-requests/${swap.body.id}/peer-accept`);
    expect(r.status).toBe(404);
  });

  it('cannot request swap of a shift not assigned to you', async () => {
    const client = await createClient();
    const aA = await createAssociate();
    const aB = await createAssociate();
    const { user: uA } = await createUser({
      role: 'ASSOCIATE',
      email: aA.email,
      associateId: aA.id,
    });
    const shiftForB = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date(future(60)),
        endsAt: new Date(future(60 * 8)),
        assignedAssociateId: aB.id,
        status: 'ASSIGNED',
      },
    });
    const aAgent = await loginAs(uA.email);
    const r = await aAgent.post('/scheduling/swap-requests').send({
      shiftId: shiftForB.id,
      counterpartyAssociateId: aB.id,
    });
    expect(r.status).toBe(403);
  });

  it('manager-approve requires PEER_ACCEPTED status (409 from PENDING_PEER)', async () => {
    const client = await createClient();
    const aReq = await createAssociate();
    const aCounter = await createAssociate();
    const { user: uReq } = await createUser({
      role: 'ASSOCIATE',
      email: aReq.email,
      associateId: aReq.id,
    });
    const shift = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date(future(60)),
        endsAt: new Date(future(60 * 8)),
        assignedAssociateId: aReq.id,
        status: 'ASSIGNED',
      },
    });
    const reqAgent = await loginAs(uReq.email);
    const swap = await reqAgent.post('/scheduling/swap-requests').send({
      shiftId: shift.id,
      counterpartyAssociateId: aCounter.id,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const r = await hrAgent
      .post(`/scheduling/swap-requests/${swap.body.id}/manager-approve`)
      .send({});
    expect(r.status).toBe(409);
  });
});
