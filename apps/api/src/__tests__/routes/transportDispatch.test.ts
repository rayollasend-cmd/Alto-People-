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
 * The command center's click-savers: plan a day's waiting bookings onto
 * runs in one go (a proposal — nothing saved), put one run's pickups in the
 * shortest order with times worked back from the arrive-by, and message
 * everyone on a van.
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

const STORE = { lat: 30.1766, lng: -85.8055 };
const FAR = { lat: 30.3, lng: -85.95 };
const MID = { lat: 30.25, lng: -85.9 };
const NEAR = { lat: 30.19, lng: -85.82 };

async function day(vanCapacities: number[] = [12]) {
  const client = await createClient('Coastal');
  const first = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  const store = await prisma.location.update({ where: { id: first.id }, data: { latitude: STORE.lat, longitude: STORE.lng } });
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mike = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  const { user: driver } = await createUser({ role: 'DRIVER', associateId: mike.id });
  await prisma.associate.update({ where: { id: mike.id }, data: { phone: '555-0101' } });
  const vans = [];
  for (const [i, capacity] of vanCapacities.entries()) {
    vans.push(await prisma.van.create({ data: { name: `Van ${i + 1}`, capacity } }));
  }
  const targetAt = new Date(Date.now() + 20 * 3_600_000);
  targetAt.setMinutes(0, 0, 0);
  const serviceDate = dateKeyInZone(targetAt, store.timezone);
  const rider = async (firstName: string, at: { lat: number; lng: number }, opts: { direction?: 'TO_WORK' | 'FROM_WORK'; targetAt?: Date } = {}) => {
    const a = await createAssociate({ firstName, lastName: 'Rider' });
    return prisma.ride.create({
      data: {
        associateId: a.id,
        direction: opts.direction ?? 'TO_WORK',
        locationId: store.id,
        address: `${firstName}'s place`,
        lat: at.lat,
        lng: at.lng,
        targetAt: opts.targetAt ?? targetAt,
        serviceDate,
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: director.id,
      },
    });
  };
  return { client, store, director, directorAgent: await loginAs(director.email), driver, vans, targetAt, serviceDate, rider };
}

describe('POST /transport/plan — the day, planned in one go', () => {
  it('groups by way and time, fills the biggest free van, orders pickups farthest-first, and times them back from the arrive-by', async () => {
    const d = await day([2, 12]);
    const near = await d.rider('Nia', NEAR);
    const far = await d.rider('Fay', FAR);
    const mid = await d.rider('Mo', MID);
    const home = await d.rider('Hal', MID, { direction: 'FROM_WORK', targetAt: new Date(d.targetAt.getTime() + 8 * 3_600_000) });

    const res = await d.directorAgent.post('/transport/plan').send({ date: d.serviceDate });
    expect(res.status).toBe(200);
    const [toWork, fromWork] = res.body.proposals;
    expect(toWork).toMatchObject({ direction: 'TO_WORK', vanId: d.vans[1]!.id, driverUserId: d.driver.id, warnings: [] });
    expect(toWork.rides.map((r: { rideId: string }) => r.rideId)).toEqual([far.id, mid.id, near.id]);
    const times = toWork.rides.map((r: { pickupAt: string }) => Date.parse(r.pickupAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Date.parse(toWork.departAt)).toBeLessThan(times[0]);
    expect(Date.parse(toWork.arriveAt)).toBe(d.targetAt.getTime() - 5 * 60_000);
    expect(fromWork).toMatchObject({ direction: 'FROM_WORK', rides: [expect.objectContaining({ rideId: home.id })] });
    // A proposal — nothing is saved.
    expect(await prisma.rideRun.count()).toBe(0);
  });

  it('splits a group across vans by seats, and says when no van is free', async () => {
    const d = await day([2]);
    await d.rider('Fay', FAR);
    await d.rider('Mo', MID);
    await d.rider('Nia', NEAR);
    const { proposals } = (await d.directorAgent.post('/transport/plan').send({ date: d.serviceDate })).body;
    expect(proposals).toHaveLength(2);
    expect(proposals[0].rides).toHaveLength(2);
    expect(proposals[1]).toMatchObject({ vanId: null, warnings: expect.arrayContaining(['No van is free then — pick one.']) });
  });

  it('is the director’s — an associate or a driver can’t plan', async () => {
    const d = await day();
    const { user } = await createUser({ role: 'DRIVER' });
    expect((await (await loginAs(user.email)).post('/transport/plan').send({ date: d.serviceDate })).status).toBe(403);
  });
});

describe('POST /transport/route — one van, best order', () => {
  it('orders the pickups farthest-first and puts riders at the same stop on the same minute', async () => {
    const d = await day();
    const a = await d.rider('Ann', MID);
    const b = await d.rider('Bo', FAR);
    const c = await d.rider('Cy', MID);
    const res = await d.directorAgent.post('/transport/route').send({ rideIds: [a.id, b.id, c.id] });
    expect(res.status).toBe(200);
    expect(res.body.rides[0].rideId).toBe(b.id);
    const [, second, third] = res.body.rides;
    expect(second.pickupAt).toBe(third.pickupAt);
  });
});

describe('POST /transport/runs/:id/message', () => {
  it('reaches every rider on the van and its driver', async () => {
    const d = await day();
    const r = await d.rider('Ann', MID);
    const run = await d.directorAgent.post('/transport/runs').send({
      vanId: d.vans[0]!.id,
      driverUserId: d.driver.id,
      direction: 'TO_WORK',
      serviceDate: d.serviceDate,
      departAt: new Date(d.targetAt.getTime() - 3_600_000).toISOString(),
      rides: [{ rideId: r.id, pickupAt: new Date(d.targetAt.getTime() - 40 * 60_000).toISOString() }],
    });
    const { user: ann } = await createUser({ role: 'ASSOCIATE', associateId: r.associateId });
    const sent = await d.directorAgent.post(`/transport/runs/${run.body.run.id}/message`).send({ body: 'Running 10 late — sorry!' });
    expect(sent.body).toEqual({ sent: 2 });
    await flushPendingNotifications();
    for (const id of [ann.id, d.driver.id]) {
      const n = await prisma.notification.findFirst({ where: { recipientUserId: id, channel: 'IN_APP', subject: 'Van 1: a message from transportation' } });
      expect(n?.body).toBe('Running 10 late — sorry!');
    }
    // The board carries the driver's phone for "Call Mike".
    const board = await d.directorAgent.get(`/transport/board?date=${d.serviceDate}`);
    expect(board.body.drivers.find((x: { userId: string }) => x.userId === d.driver.id).phone).toBe('555-0101');
  });
});
