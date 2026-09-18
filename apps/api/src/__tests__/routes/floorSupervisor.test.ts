import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
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

describe('FLOOR_SUPERVISOR — nothing beyond the floor, even by URL', () => {
  // Found by an API sweep of everything this watch-only role can call.
  // Each case also covers SHIFT_SUPERVISOR where the hole was shared.

  it('cannot open, comment on, or re-pin an admin decision room that has history', async () => {
    const client = await createClient('Walmart Destin');
    const waiting = await createAssociate({ firstName: 'Kiosk', lastName: 'Waiter' });
    const walkIn = await prisma.clockInRequest.create({
      data: { associateId: waiting.id, clientId: client.id, requestedAt: new Date() },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const queue = await hrAgent.get('/me/decisions');
    const key = (queue.body.decisions as Array<{ key: string }>).find((d) =>
      d.key.startsWith('walkins:pending'),
    )!.key;
    expect(
      (await hrAgent.post('/me/decisions/comment').send({ key, body: 'On it.' })).status,
    ).toBe(201);
    expect(
      (await hrAgent.post('/me/decisions/next-step').send({ key, text: 'Approve by 9' })).status,
    ).toBe(200);

    // Any trace in the room used to open it to every signed-in account.
    for (const role of ['FLOOR_SUPERVISOR', 'SHIFT_SUPERVISOR'] as const) {
      const { user } = await createUser({ role, clientId: client.id });
      const a = await loginAs(user.email);
      // Their own queue key for the same walk-in is client-scoped; the
      // org-wide admin key is not theirs to open.
      expect((await a.get(`/me/decisions/item?key=${key}`)).status).toBe(404);
      expect(
        (await a.post('/me/decisions/comment').send({ key, body: 'hi' })).status,
      ).toBe(404);
      expect(
        (await a.post('/me/decisions/next-step').send({ key, text: null })).status,
      ).toBe(404);
    }
    expect(await prisma.decisionComment.count({ where: { key } })).toBe(1);
    expect(await prisma.decisionNextStep.count({ where: { key } })).toBe(1);

    // A participant keeps the room after the item resolves.
    await prisma.clockInRequest.delete({ where: { id: walkIn.id } });
    const room = await hrAgent.get(`/me/decisions/item?key=${key}`);
    expect(room.status).toBe(200);
    expect(room.body.thread).toHaveLength(1);
  });

  it('personal decision rooms are per user, not one shared thread', async () => {
    const mkAssociateUser = async (firstName: string) => {
      const assoc = await createAssociate({ firstName, lastName: 'Worker' });
      await prisma.documentRecord.create({
        data: {
          associateId: assoc.id,
          kind: 'ID',
          filename: 'license.png',
          mimeType: 'image/png',
          size: 10,
          expiresAt: new Date(Date.now() + 20 * 86_400_000),
        },
      });
      const { user } = await createUser({ role: 'ASSOCIATE', email: assoc.email, associateId: assoc.id });
      return { user, agent: await loginAs(user.email) };
    };
    const ann = await mkAssociateUser('Ann');
    const ben = await mkAssociateUser('Ben');
    const keyOf = async (agent: TestAgent<Test>) =>
      ((await agent.get('/me/decisions')).body.decisions as Array<{ key: string }>).find((d) =>
        d.key.endsWith(':expiring-docs'),
      )!.key;
    const annKey = await keyOf(ann.agent);
    const benKey = await keyOf(ben.agent);
    expect(annKey).toBe(`me:${ann.user.id}:expiring-docs`);
    expect(benKey).not.toBe(annKey);

    expect(
      (await ann.agent.post('/me/decisions/comment').send({ key: annKey, body: 'my renewal' })).status,
    ).toBe(201);
    expect((await ben.agent.get(`/me/decisions/item?key=${annKey}`)).status).toBe(404);
    const benRoom = await ben.agent.get(`/me/decisions/item?key=${benKey}`);
    expect(benRoom.status).toBe(200);
    expect(benRoom.body.thread).toHaveLength(0);
  });

  it('mentions and next-step owners stay inside the collaboration circle', async () => {
    const client = await createClient();
    const waiting = await createAssociate();
    await prisma.clockInRequest.create({
      data: { associateId: waiting.id, clientId: client.id, requestedAt: new Date() },
    });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: peer } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const outsider = await createAssociate({ firstName: 'Not', lastName: 'Staff' });
    const { user: stranger } = await createUser({
      role: 'ASSOCIATE',
      email: outsider.email,
      associateId: outsider.id,
    });
    const a = await loginAs(sup.email);
    const key = `walkins:pending:${client.id}`;

    const bad = await a
      .post('/me/decisions/comment')
      .send({ key, body: 'look', mentionUserId: stranger.id });
    expect(bad.status).toBe(400);
    const badOwner = await a
      .post('/me/decisions/next-step')
      .send({ key, text: 'yours', ownerUserId: stranger.id });
    expect(badOwner.status).toBe(400);
    expect(await prisma.decisionComment.count({ where: { key } })).toBe(0);

    const ok = await a
      .post('/me/decisions/comment')
      .send({ key, body: 'look', mentionUserId: peer.id });
    expect(ok.status).toBe(201);
  });

  it('an unassigned floor supervisor gets admins as colleagues, never every store', async () => {
    const somewhere = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: somewhere.id });
    const { user } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: null });
    const a = await loginAs(user.email);
    const res = await a.get('/me/colleagues');
    expect(res.status).toBe(200);
    const ids = (res.body.colleagues as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(hr.id);
    expect(ids).not.toContain(sup.id);
  });

  it('onboarding and retention analytics are refused; the home dashboard still loads', async () => {
    const client = await createClient();
    for (const role of ['FLOOR_SUPERVISOR', 'SHIFT_SUPERVISOR'] as const) {
      const { user } = await createUser({ role, clientId: client.id });
      const a = await loginAs(user.email);
      expect((await a.get('/analytics/onboarding')).status).toBe(403);
      expect((await a.get('/analytics/retention')).status).toBe(403);
      expect((await a.get('/analytics/dashboard')).status).toBe(200);
    }
  });

  it("the client portal's onboarding and retention analytics stay on its own client", async () => {
    const mine = await createClient('Mine LLC');
    const other = await createClient('Other Corp');
    const [mineLoc, otherLoc] = await Promise.all([
      prisma.location.findFirstOrThrow({ where: { clientId: mine.id } }),
      prisma.location.findFirstOrThrow({ where: { clientId: other.id } }),
    ]);
    const hereAssoc = await createAssociate({ firstName: 'Here' });
    const thereAssoc = await createAssociate({ firstName: 'There' });
    await createApplicationWithChecklist({ associateId: hereAssoc.id, clientId: mine.id });
    await createApplicationWithChecklist({ associateId: thereAssoc.id, clientId: other.id });
    // Started at the other client, then moved to mine.
    const mover = await createAssociate({ firstName: 'Mover' });
    await prisma.associateAssignment.create({
      data: {
        associateId: mover.id,
        locationId: otherLoc.id,
        startedAt: new Date('2025-01-01'),
        endedAt: new Date('2025-06-01'),
      },
    });
    await prisma.associateAssignment.create({
      data: { associateId: mover.id, locationId: mineLoc.id, startedAt: new Date('2025-06-02') },
    });

    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: mine.id });
    const a = await loginAs(portal.email);
    const onboarding = await a.get('/analytics/onboarding');
    expect(onboarding.status).toBe(200);
    expect(
      (onboarding.body.byClient as Array<{ clientId: string }>).map((c) => c.clientId),
    ).toEqual([mine.id]);
    const total = Object.values(onboarding.body.byStatus as Record<string, number>).reduce(
      (n, v) => n + v,
      0,
    );
    expect(total).toBe(1);

    const retention = await a.get('/analytics/retention');
    expect(retention.status).toBe(200);
    const locationIds = (retention.body.byLocation as Array<{ locationId: string }>).map(
      (l) => l.locationId,
    );
    expect(locationIds).toContain(mineLoc.id);
    expect(locationIds).not.toContain(otherLoc.id);
  });
});
