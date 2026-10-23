import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import type { SessionUser } from '../../types/express.js';
import { timeExceptions } from '../../lib/timeExceptions.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Time & attendance's exception tiles (F500 G2): missed punches, late
 * today and overtime risk this week, counted from seeded punches and
 * shifts — exact numbers, the caller's reach, and the client filter.
 */

const app = () => createApp();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

async function seedTodayAndMissed() {
  const now = Date.now();
  const clientA = await createClient('Client A');
  const clientB = await createClient('Client B');
  const person = (firstName: string) => createAssociate({ firstName, lastName: 'Test' });
  const [ann, ben, fay, gus, walk, dan, eve] = await Promise.all(
    ['Ann', 'Ben', 'Fay', 'Gus', 'Walk', 'Dan', 'Eve'].map(person),
  );
  const shiftAt = (clientId: string, associateId: string, startsAt: number) =>
    prisma.shift.create({
      data: { clientId, position: 'Server', startsAt: new Date(startsAt), endsAt: new Date(startsAt + 8 * HOUR), status: 'ASSIGNED', assignedAssociateId: associateId, publishedAt: new Date() },
    });
  const punch = (data: {
    associateId: string;
    clientId: string;
    clockInAt: number;
    clockOutAt?: number | null;
    status: 'ACTIVE' | 'COMPLETED' | 'APPROVED' | 'REJECTED';
    shiftId?: string;
    anomalies?: string[];
  }) =>
    prisma.timeEntry.create({
      data: {
        associateId: data.associateId,
        clientId: data.clientId,
        clockInAt: new Date(data.clockInAt),
        clockOutAt: data.clockOutAt ? new Date(data.clockOutAt) : null,
        status: data.status,
        shiftId: data.shiftId ?? null,
        anomalies: data.anomalies ?? [],
      },
    });

  // Late today (the window is the reader's day: now ± 10h here).
  const s1 = await shiftAt(clientA.id, ann.id, now - 4 * HOUR);
  await punch({ associateId: ann.id, clientId: clientA.id, clockInAt: now - 4 * HOUR + 10 * MIN, status: 'ACTIVE', shiftId: s1.id }); // 10 min late
  const s2 = await shiftAt(clientA.id, ben.id, now - 4 * HOUR);
  await punch({ associateId: ben.id, clientId: clientA.id, clockInAt: now - 4 * HOUR + 2 * MIN, status: 'ACTIVE', shiftId: s2.id }); // inside the grace
  const s3 = await shiftAt(clientA.id, fay.id, now - 5 * HOUR);
  await punch({ associateId: fay.id, clientId: clientA.id, clockInAt: now - 5 * HOUR + 20 * MIN, clockOutAt: now - HOUR, status: 'REJECTED', shiftId: s3.id }); // late, but rejected
  const s4 = await shiftAt(clientA.id, gus.id, now - 16 * HOUR);
  await punch({ associateId: gus.id, clientId: clientA.id, clockInAt: now - 16 * HOUR + 30 * MIN, clockOutAt: now - 9 * HOUR, status: 'COMPLETED', shiftId: s4.id }); // late, another day
  await punch({ associateId: walk.id, clientId: clientA.id, clockInAt: now - 3 * HOUR, status: 'ACTIVE' }); // no shift
  const s5 = await shiftAt(clientB.id, eve.id, now - 2 * HOUR);
  await punch({ associateId: eve.id, clientId: clientB.id, clockInAt: now - 2 * HOUR + 15 * MIN, status: 'ACTIVE', shiftId: s5.id }); // late at B

  // Missed punches: pending review + FORGOT_CLOCKOUT.
  const danMissed = now - 2 * DAY;
  await punch({ associateId: dan.id, clientId: clientA.id, clockInAt: danMissed, clockOutAt: danMissed + 12 * HOUR, status: 'COMPLETED', anomalies: ['FORGOT_CLOCKOUT', 'NO_BREAK'] });
  await punch({ associateId: dan.id, clientId: clientA.id, clockInAt: now - 4 * DAY, clockOutAt: now - 4 * DAY + 12 * HOUR, status: 'APPROVED', anomalies: ['FORGOT_CLOCKOUT'] }); // already approved
  await punch({ associateId: dan.id, clientId: clientA.id, clockInAt: now - 5 * DAY, clockOutAt: now - 5 * DAY + 8 * HOUR, status: 'COMPLETED', anomalies: ['NO_BREAK'] }); // another flag
  const eveMissed = now - 3 * DAY;
  await punch({ associateId: eve.id, clientId: clientB.id, clockInAt: eveMissed, clockOutAt: eveMissed + 12 * HOUR, status: 'COMPLETED', anomalies: ['FORGOT_CLOCKOUT'] });
  await punch({ associateId: eve.id, clientId: clientB.id, clockInAt: now - 120 * DAY, clockOutAt: now - 120 * DAY + 12 * HOUR, status: 'COMPLETED', anomalies: ['FORGOT_CLOCKOUT'] }); // outside the 90-day queue

  return { now, clientA, clientB, danMissed, eveMissed };
}

describe('GET /time/admin/exceptions', () => {
  it('counts missed punches and late arrivals exactly, in the caller’s reach', async () => {
    const { now, clientA, danMissed, eveMissed } = await seedTodayAndMissed();
    const day = `dayFrom=${new Date(now - 10 * HOUR).toISOString()}&dayTo=${new Date(now + 10 * HOUR).toISOString()}`;

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const all = await a.get(`/time/admin/exceptions?${day}`);
    expect(all.status).toBe(200);
    expect(all.body.missedPunches).toEqual({ count: 2, oldestAt: new Date(eveMissed).toISOString() });
    expect(all.body.lateToday.count).toBe(2);
    expect(all.body.overtimeRisk.thresholdHours).toBe(36);

    // The page's client filter narrows every number.
    const onlyA = await a.get(`/time/admin/exceptions?${day}&clientId=${clientA.id}`);
    expect(onlyA.body.missedPunches).toEqual({ count: 1, oldestAt: new Date(danMissed).toISOString() });
    expect(onlyA.body.lateToday.count).toBe(1);

    // A store-bound supervisor never counts another client's people, even
    // when the request names that client.
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: clientA.id });
    const s = await loginAs(sup.email);
    const bounded = await s.get(`/time/admin/exceptions?${day}`);
    expect(bounded.status).toBe(200);
    expect(bounded.body.missedPunches.count).toBe(1);
    expect(bounded.body.lateToday.count).toBe(1);
  });

  it('refuses a "day" longer than a day, and callers without manage:time', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const now = Date.now();
    const bad = await a.get(`/time/admin/exceptions?dayFrom=${new Date(now - 3 * DAY).toISOString()}&dayTo=${new Date(now).toISOString()}`);
    expect(bad.status).toBe(400);

    const worker = await createAssociate({ firstName: 'Ann', lastName: 'Assoc' });
    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: worker.id });
    const b = await loginAs(assoc.email);
    expect((await b.get('/time/admin/exceptions')).status).toBe(403);
  });
});

describe('timeExceptions — overtime risk this week', () => {
  it('worked this week plus the rest of the assigned schedule, at 36h', async () => {
    // Wednesday Jun 24 2026, 2 PM Eastern; the org week began Sat Jun 20.
    const now = new Date('2026-06-24T18:00:00.000Z');
    const at = (iso: string) => new Date(iso);
    const client = await createClient('Hotel');
    const [cara, ben, ivy] = await Promise.all(['Cara', 'Ben', 'Ivy'].map((f) => createAssociate({ firstName: f, lastName: 'Week' })));
    const other = await createClient('Elsewhere');
    const eve = await createAssociate({ firstName: 'Eve', lastName: 'Week' });
    const entry = (associateId: string, clientId: string, startIso: string, hours: number, status: 'COMPLETED' | 'APPROVED' | 'REJECTED' = 'COMPLETED') =>
      prisma.timeEntry.create({
        data: { associateId, clientId, clockInAt: at(startIso), clockOutAt: new Date(at(startIso).getTime() + hours * HOUR), status, anomalies: [] },
      });
    const shift = (associateId: string, startIso: string, hours: number, status: 'ASSIGNED' | 'CANCELLED' = 'ASSIGNED') =>
      prisma.shift.create({
        data: { clientId: client.id, position: 'Server', startsAt: at(startIso), endsAt: new Date(at(startIso).getTime() + hours * HOUR), status, assignedAssociateId: associateId, publishedAt: new Date() },
      });

    // Cara: 4 × 8h worked + an 8h shift Thursday (7h paid) = 39h.
    for (const d of ['2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23']) await entry(cara.id, client.id, `${d}T13:00:00.000Z`, 8);
    await shift(cara.id, '2026-06-25T13:00:00.000Z', 8);
    // Ben: 2 × 8h + an 8h shift = 23h; a cancelled 20h shift and a rejected 20h punch don't count.
    await entry(ben.id, client.id, '2026-06-20T13:00:00.000Z', 8);
    await entry(ben.id, client.id, '2026-06-21T13:00:00.000Z', 8, 'APPROVED');
    await entry(ben.id, client.id, '2026-06-22T00:00:00.000Z', 20, 'REJECTED');
    await shift(ben.id, '2026-06-25T13:00:00.000Z', 8);
    await shift(ben.id, '2026-06-26T00:00:00.000Z', 20, 'CANCELLED');
    // Ivy: 37h worked by Tuesday (last week's hours don't count).
    for (const d of ['2026-06-20', '2026-06-21', '2026-06-22']) await entry(ivy.id, client.id, `${d}T12:00:00.000Z`, 10);
    await entry(ivy.id, client.id, '2026-06-23T12:00:00.000Z', 7);
    await entry(ivy.id, client.id, '2026-06-18T12:00:00.000Z', 10);
    // Eve works at another client: 40h.
    for (const d of ['2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23']) await entry(eve.id, other.id, `${d}T12:00:00.000Z`, 10);

    const hr = await createUser({ role: 'HR_ADMINISTRATOR' });
    const session = {
      ...hr.user,
      primaryRole: hr.user.role,
      availableRoles: [hr.user.role],
      locationId: null,
      regionId: null,
      tokenVersion: 0,
      firstName: null,
      lastName: null,
      photoUrl: null,
      timezone: null,
      mfaEnabled: false,
    } as unknown as SessionUser;

    const res = await timeExceptions(prisma, session, { now });
    expect(res.overtimeRisk.weekStart).toBe('2026-06-20');
    expect(res.overtimeRisk.weekEnd).toBe('2026-06-26');
    expect(res.overtimeRisk.count).toBe(3);
    expect(res.overtimeRisk.people.map((p) => [p.name, p.workedMinutes, p.scheduledMinutes, p.projectedMinutes])).toEqual([
      ['Eve Week', 40 * 60, 0, 40 * 60],
      ['Cara Week', 32 * 60, 7 * 60, 39 * 60],
      ['Ivy Week', 37 * 60, 0, 37 * 60],
    ]);

    // The client filter narrows to that client's punches and shifts.
    const onlyHotel = await timeExceptions(prisma, session, { now, clientId: client.id });
    expect(onlyHotel.overtimeRisk.people.map((p) => p.name)).toEqual(['Cara Week', 'Ivy Week']);
  });
});

describe('time lists carry the photo the API knows about', () => {
  it('photoUrl is the real headshot URL, or null when none is on file', async () => {
    const client = await createClient('Photos');
    const withPhoto = await createAssociate({ firstName: 'Pia', lastName: 'Photo' });
    const stamp = new Date('2026-09-01T12:00:00.000Z');
    await prisma.associate.update({ where: { id: withPhoto.id }, data: { photoS3Key: 'profile-photos/pia.jpg', photoUpdatedAt: stamp } });
    const noPhoto = await createAssociate({ firstName: 'Nia', lastName: 'None' });
    const now = Date.now();
    for (const a of [withPhoto, noPhoto]) {
      await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, clockInAt: new Date(now - 3 * HOUR), clockOutAt: new Date(now - HOUR), status: 'COMPLETED', anomalies: [] } });
      await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, clockInAt: new Date(now - 30 * MIN), status: 'ACTIVE', anomalies: [] } });
    }
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const list = await a.get('/time/admin/entries?status=COMPLETED');
    expect(list.status).toBe(200);
    const byName = new Map((list.body.entries as Array<{ associateName: string; photoUrl: string | null }>).map((e) => [e.associateName, e.photoUrl]));
    expect(byName.get('Pia Photo')).toBe(`/api/associates/${withPhoto.id}/photo?v=${stamp.getTime()}`);
    expect(byName.get('Nia None')).toBeNull();

    const live = await a.get('/time/admin/active');
    expect(live.status).toBe(200);
    const liveByName = new Map((live.body.entries as Array<{ associateName: string; photoUrl: string | null }>).map((e) => [e.associateName, e.photoUrl]));
    expect(liveByName.get('Pia Photo')).toBe(`/api/associates/${withPhoto.id}/photo?v=${stamp.getTime()}`);
    expect(liveByName.get('Nia None')).toBeNull();
  });
});
