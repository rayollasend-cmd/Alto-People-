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

const TALLY = { lat: 30.4383, lng: -84.2807 };
const FAR_AWAY = { lat: 30.6954, lng: -88.0399 };  // Mobile, AL — ~390 km

// Self-clocker = a non-ASSOCIATE role with an Associate record. Hourly
// ASSOCIATEs are blocked from /me/clock-* and must use the kiosk PIN
// flow, so we use MANAGER to exercise the /me/* code paths.
async function seedSelfClockerAtTally(opts: { withGeofence?: boolean } = {}) {
  const client = await createClient();
  if (opts.withGeofence) {
    await prisma.client.update({
      where: { id: client.id },
      data: {
        latitude: TALLY.lat,
        longitude: TALLY.lng,
        geofenceRadiusMeters: 200,
      },
    });
  }
  const associate = await createAssociate();
  const { user } = await createUser({
    role: 'MANAGER',
    email: associate.email,
    associateId: associate.id,
    clientId: client.id,
  });
  return { client, associate, user };
}

describe('Geofencing on clock-in', () => {
  it('clock-in inside the geofence has no GEOFENCE_VIOLATION_IN', async () => {
    const { user } = await seedSelfClockerAtTally({ withGeofence: true });
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-in').send({ geo: TALLY });
    expect(res.status).toBe(201);
    expect(res.body.anomalies).not.toContain('GEOFENCE_VIOLATION_IN');
    expect(res.body.clockInLat).toBeCloseTo(TALLY.lat, 4);
  });

  it('clock-in outside the geofence flags GEOFENCE_VIOLATION_IN', async () => {
    const { user } = await seedSelfClockerAtTally({ withGeofence: true });
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-in').send({ geo: FAR_AWAY });
    expect(res.status).toBe(201);
    expect(res.body.anomalies).toContain('GEOFENCE_VIOLATION_IN');
  });

  it('clock-in with no geo + geofence enforced flags violation', async () => {
    const { user } = await seedSelfClockerAtTally({ withGeofence: true });
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-in').send({});
    expect(res.status).toBe(201);
    expect(res.body.anomalies).toContain('GEOFENCE_VIOLATION_IN');
  });

  it('client without geofence does not flag', async () => {
    const { user } = await seedSelfClockerAtTally({ withGeofence: false });
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-in').send({ geo: FAR_AWAY });
    expect(res.status).toBe(201);
    expect(res.body.anomalies ?? []).not.toContain('GEOFENCE_VIOLATION_IN');
  });
});

describe('Job-tagged clock-in', () => {
  it('clock-in with jobId snapshots payRate from the Job', async () => {
    const { client, user } = await seedSelfClockerAtTally();
    const job = await prisma.job.create({
      data: {
        clientId: client.id,
        name: 'Front of house',
        billRate: 25,
        payRate: 18.5,
      },
    });
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-in').send({ jobId: job.id, geo: TALLY });
    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe(job.id);
    expect(res.body.payRate).toBe(18.5);
  });

  it('clock-in with unknown jobId → 404', async () => {
    const { user } = await seedSelfClockerAtTally();
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-in').send({
      jobId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(404);
  });

  it('clock-in with inactive job → 404', async () => {
    const { client, user } = await seedSelfClockerAtTally();
    const job = await prisma.job.create({
      data: { clientId: client.id, name: 'Old role', isActive: false },
    });
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-in').send({ jobId: job.id });
    expect(res.status).toBe(404);
  });
});

describe('Break tracking + anomalies on clock-out', () => {
  it('start break → end break → clock-out has no NO_BREAK', async () => {
    const { user } = await seedSelfClockerAtTally();
    const a = await loginAs(user.email);
    const ci = await a.post('/time/me/clock-in').send({});
    expect(ci.status).toBe(201);

    const bs = await a.post('/time/me/break/start').send({ type: 'MEAL' });
    expect(bs.status).toBe(201);
    const be = await a.post('/time/me/break/end').send({});
    expect(be.status).toBe(200);

    const co = await a.post('/time/me/clock-out').send({});
    expect(co.status).toBe(200);
    // Short test, no NO_BREAK expected (worked < 6h)
    expect(co.body.anomalies ?? []).not.toContain('NO_BREAK');
  });

  it('cannot start a second break while one is open', async () => {
    const { user } = await seedSelfClockerAtTally();
    const a = await loginAs(user.email);
    await a.post('/time/me/clock-in').send({});
    await a.post('/time/me/break/start').send({ type: 'REST' });
    const dup = await a.post('/time/me/break/start').send({ type: 'MEAL' });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe('break_in_progress');
  });

  it('clock-out auto-closes an open break', async () => {
    const { user } = await seedSelfClockerAtTally();
    const a = await loginAs(user.email);
    const ci = await a.post('/time/me/clock-in').send({});
    await a.post('/time/me/break/start').send({ type: 'REST' });
    await a.post('/time/me/clock-out').send({});

    const breaks = await prisma.breakEntry.findMany({
      where: { timeEntryId: ci.body.id },
    });
    expect(breaks).toHaveLength(1);
    expect(breaks[0].endedAt).not.toBeNull();
  });
});

describe('Real-time active dashboard', () => {
  it('returns currently clocked-in associates with elapsed minutes', async () => {
    const { user } = await seedSelfClockerAtTally({ withGeofence: true });
    const a = await loginAs(user.email);
    await a.post('/time/me/clock-in').send({ geo: TALLY });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent.get('/time/admin/active');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    const e = res.body.entries[0];
    expect(e.geofenceOk).toBe(true);
    expect(e.onBreak).toBe(false);
    expect(typeof e.minutesElapsed).toBe('number');
  });

  it('shows onBreak=true when an open break exists', async () => {
    const { user } = await seedSelfClockerAtTally();
    const a = await loginAs(user.email);
    await a.post('/time/me/clock-in').send({});
    await a.post('/time/me/break/start').send({ type: 'MEAL' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent.get('/time/admin/active');
    expect(res.body.entries[0].onBreak).toBe(true);
  });

  it('ASSOCIATE cannot access /admin/active', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);
    const res = await a.get('/time/admin/active');
    expect(res.status).toBe(403);
  });
});

describe('Client geofence config', () => {
  it('HR sets + reads the geofence', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const set = await a.put(`/clients/${client.id}/geofence`).send({
      latitude: TALLY.lat,
      longitude: TALLY.lng,
      geofenceRadiusMeters: 150,
    });
    expect(set.status).toBe(200);
    expect(set.body.geofenceRadiusMeters).toBe(150);

    const read = await a.get(`/clients/${client.id}/geofence`);
    expect(read.body.latitude).toBeCloseTo(TALLY.lat, 4);
  });

  it('rejects partial geofence (lat without lng)', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.put(`/clients/${client.id}/geofence`).send({
      latitude: TALLY.lat,
    });
    expect(res.status).toBe(400);
  });
});

describe('Jobs CRUD', () => {
  it('HR creates + lists + soft-deletes a job', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const create = await a.post('/jobs').send({
      clientId: client.id,
      name: 'Server',
      billRate: 25,
      payRate: 18,
    });
    expect(create.status).toBe(201);

    const list = await a.get('/jobs');
    expect(list.body.jobs).toHaveLength(1);

    const dup = await a.post('/jobs').send({ clientId: client.id, name: 'Server' });
    expect(dup.status).toBe(409);

    const del = await a.delete(`/jobs/${create.body.id}`);
    expect(del.status).toBe(204);

    const after = await a.get('/jobs');
    expect(after.body.jobs).toHaveLength(0);
  });
});
