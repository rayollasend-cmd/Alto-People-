import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Which clients a driver picks up for.
 *
 *   - a new driver drives for nobody: no seat requests, no accepting
 *   - they ask for all clients or some; the desk hears; the director
 *     approves or denies, and the driver hears back
 *   - approved, they see that client's seats only — and can only accept,
 *     decline or map those; the director's grant and revoke are direct
 *   - "every driver declined" counts the drivers who could have taken it
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

async function world() {
  const coastal = await createClient('Coastal');
  const harbor = await createClient('Harbor');
  const storeA = await prisma.location.findFirstOrThrow({ where: { clientId: coastal.id } });
  const storeB = await prisma.location.findFirstOrThrow({ where: { clientId: harbor.id } });
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mikeA = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  const { user: mike } = await createUser({ role: 'DRIVER', associateId: mikeA.id });
  // The test helper grants every driver all clients (as the deploy did for
  // the drivers already on the road). Mike is a NEW driver: nothing yet.
  await prisma.driverClientAccess.deleteMany({ where: { driverUserId: mike.id } });
  await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 4, driverUserId: mike.id } });
  const targetAt = new Date(Date.now() + 20 * 3_600_000);
  targetAt.setMinutes(0, 0, 0);
  const rider = async (firstName: string, store: { id: string; timezone: string }) => {
    const a = await createAssociate({ firstName, lastName: 'Rider' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    const ride = await prisma.ride.create({
      data: {
        associateId: a.id,
        direction: 'TO_WORK',
        locationId: store.id,
        address: `${firstName}'s place`,
        lat: 30.25,
        lng: -85.9,
        targetAt,
        serviceDate: dateKeyInZone(targetAt, store.timezone),
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: director.id,
      },
    });
    return { associate: a, user, ride };
  };
  return {
    coastal,
    harbor,
    storeA,
    storeB,
    director,
    directorAgent: await loginAs(director.email),
    mike,
    mikeAgent: await loginAs(mike.email),
    rider,
  };
}

describe('clients a driver drives for', () => {
  it('a new driver sees no seat requests and cannot accept one; asking for a client tells the desk', async () => {
    const w = await world();
    const ann = await w.rider('Ann', w.storeA);

    const empty = await w.mikeAgent.get('/transport/driver/requests');
    expect(empty.status).toBe(200);
    expect(empty.body.requests).toEqual([]);
    expect(empty.body.clients).toEqual({ all: false, approved: 0, pending: 0 });
    const refused = await w.mikeAgent.post(`/transport/driver/requests/${ann.ride.id}/accept`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('client_not_approved');
    expect((await w.mikeAgent.get(`/transport/driver/trip-map?locationId=${w.storeA.id}&direction=TO_WORK&date=${ann.ride.serviceDate}`)).status).toBe(403);

    const mine = await w.mikeAgent.get('/transport/driver/clients');
    expect(mine.body.clients.map((c: { name: string; access: unknown }) => [c.name, c.access])).toEqual([
      ['Coastal', null],
      ['Harbor', null],
    ]);

    const asked = await w.mikeAgent.post('/transport/driver/clients/request').send({ clientIds: [w.coastal.id], note: 'I live near the Coastal stores' });
    expect(asked.status).toBe(201);
    expect(asked.body.pending).toBe(1);
    expect(asked.body.clients[0]).toMatchObject({ name: 'Coastal', access: { status: 'REQUESTED', note: 'I live near the Coastal stores' } });
    // Asking twice is one request.
    expect((await w.mikeAgent.post('/transport/driver/clients/request').send({ clientIds: [w.coastal.id] })).body.pending).toBe(1);
    await flushPendingNotifications();
    const told = await prisma.notification.findFirst({ where: { recipientUserId: w.director.id, channel: 'IN_APP', subject: 'Mike Chen asked to drive for Coastal' } });
    expect(told?.body).toContain('I live near the Coastal stores');
    expect(told?.linkUrl).toBe('/transport?tab=vans');
    // Still nothing to see until the director says so.
    expect((await w.mikeAgent.get('/transport/driver/requests')).body.requests).toEqual([]);
  });

  it('approved, the driver sees that client’s seats only; denied says why; the director grants and revokes directly', async () => {
    const w = await world();
    const ann = await w.rider('Ann', w.storeA);
    const bo = await w.rider('Bo', w.storeB);
    await w.mikeAgent.post('/transport/driver/clients/request').send({ clientIds: [w.coastal.id, w.harbor.id] });

    const desk = await w.directorAgent.get('/transport/driver-access');
    expect(desk.status).toBe(200);
    const pending = desk.body.rows.filter((r: { status: string }) => r.status === 'REQUESTED');
    expect(pending).toHaveLength(2);
    const coastalRow = pending.find((r: { client: { name: string } }) => r.client.name === 'Coastal');
    const harborRow = pending.find((r: { client: { name: string } }) => r.client.name === 'Harbor');
    expect(coastalRow.driver).toMatchObject({ userId: w.mike.id, name: 'Mike Chen' });

    expect((await w.directorAgent.post(`/transport/driver-access/${coastalRow.id}/decide`).send({ decision: 'APPROVED' })).status).toBe(200);
    expect((await w.directorAgent.post(`/transport/driver-access/${harborRow.id}/decide`).send({ decision: 'DENIED', note: 'Harbor has its own vans' })).status).toBe(200);
    await flushPendingNotifications();
    const yes = await prisma.notification.findFirst({ where: { recipientUserId: w.mike.id, channel: 'IN_APP', subject: 'You now drive for Coastal' } });
    expect(yes).not.toBeNull();
    const no = await prisma.notification.findFirst({ where: { recipientUserId: w.mike.id, channel: 'IN_APP', subject: 'Harbor was not approved' } });
    expect(no?.body).toContain('Harbor has its own vans');

    const list = await w.mikeAgent.get('/transport/driver/requests');
    expect(list.body.requests.map((r: { id: string }) => r.id)).toEqual([ann.ride.id]);
    expect(list.body.clients).toEqual({ all: false, approved: 1, pending: 0 });
    expect((await w.mikeAgent.post(`/transport/driver/requests/${bo.ride.id}/accept`)).body.error.code).toBe('client_not_approved');
    expect((await w.mikeAgent.post(`/transport/driver/requests/${bo.ride.id}/decline`).send({})).body.error.code).toBe('client_not_approved');
    expect((await w.mikeAgent.post(`/transport/driver/requests/${ann.ride.id}/accept`)).status).toBe(200);
    const mine = await w.mikeAgent.get('/transport/driver/clients');
    expect(mine.body.clients.find((c: { name: string }) => c.name === 'Harbor').access).toMatchObject({ status: 'DENIED', decisionNote: 'Harbor has its own vans' });

    // The director's word, directly: all clients, then back off it.
    const granted = await w.directorAgent.post('/transport/driver-access/grant').send({ driverUserId: w.mike.id, all: true });
    expect(granted.status).toBe(200);
    const bo2 = await w.rider('Cy', w.storeB);
    expect((await w.mikeAgent.get('/transport/driver/requests')).body.requests.map((r: { id: string }) => r.id)).toEqual([bo.ride.id, bo2.ride.id]);
    expect((await w.mikeAgent.get('/transport/driver/requests')).body.clients).toEqual({ all: true, approved: 2, pending: 0 });
    const allRow = (await w.directorAgent.get('/transport/driver-access')).body.rows.find((r: { client: unknown; status: string }) => r.client === null && r.status === 'APPROVED');
    expect((await w.directorAgent.delete(`/transport/driver-access/${allRow.id}`)).status).toBe(200);
    expect((await w.mikeAgent.get('/transport/driver/requests')).body.requests).toEqual([]);
    await flushPendingNotifications();
    expect(await prisma.notification.findFirst({ where: { recipientUserId: w.mike.id, channel: 'IN_APP', subject: 'You no longer drive for all clients' } })).not.toBeNull();

    // The driver drops a client themselves.
    expect((await w.mikeAgent.delete(`/transport/driver/clients/${w.coastal.id}`)).status).toBe(200);
    expect((await w.mikeAgent.get('/transport/driver/clients')).body.approved).toBe(0);
  });

  it('"every driver declined" counts only the drivers who could have taken the seat', async () => {
    const w = await world();
    const joA = await createAssociate({ firstName: 'Jo', lastName: 'Park' });
    const { user: jo } = await createUser({ role: 'DRIVER', associateId: joA.id }); // all clients, as the helper grants
    await prisma.van.create({ data: { name: 'Van 9', capacity: 8, driverUserId: jo.id } });
    const joAgent = await loginAs(jo.email);
    // Mike: Coastal only.
    await prisma.driverClientAccess.create({ data: { driverUserId: w.mike.id, clientId: w.coastal.id, status: 'APPROVED', decidedAt: new Date() } });
    const bo = await w.rider('Bo', w.storeB);

    expect((await w.mikeAgent.get('/transport/driver/requests')).body.requests).toEqual([]);
    expect((await joAgent.post(`/transport/driver/requests/${bo.ride.id}/decline`).send({ reason: 'Off that day' })).status).toBe(200);
    await flushPendingNotifications();
    // Jo was the only driver approved for Harbor: declining was everyone.
    expect(await prisma.notification.findFirst({ where: { recipientUserId: w.director.id, channel: 'IN_APP', subject: "No driver took Bo's seat" } })).not.toBeNull();
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: bo.ride.id } })).allDeclinedAt).not.toBeNull();
  });

  it('the access desk is the director’s', async () => {
    const w = await world();
    expect((await w.mikeAgent.get('/transport/driver-access')).status).toBe(403);
    expect((await w.mikeAgent.post('/transport/driver-access/grant').send({ driverUserId: w.mike.id, all: true })).status).toBe(403);
    const a = await createAssociate({ firstName: 'Ann', lastName: 'Rider' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    const assoc = await loginAs(user.email);
    expect((await assoc.get('/transport/driver/clients')).status).toBe(403);
  });
});
