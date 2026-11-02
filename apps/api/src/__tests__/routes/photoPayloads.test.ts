/**
 * LEAD-12 / FLOOR-25 / PEOPLE-26 (deep audit 2026-10-29): every avatar asked
 * for /api/associates/:id/photo whether or not a photo existed — 36 404s on
 * one schedule load. The schedule's roster and shift payloads now say:
 * a versioned photoUrl when one is on file, null when there is none (the web
 * then asks for nothing and draws initials).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';

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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

describe('photo-aware payloads', () => {
  it('the schedule roster and its shifts carry photoUrl: versioned when on file, null when not', async () => {
    const client = await createClient('Photo Mart');
    const withPhoto = await createAssociate({ firstName: 'Pia', lastName: 'Photo' });
    const without = await createAssociate({ firstName: 'Nate', lastName: 'None' });
    const stamp = new Date('2026-10-01T12:00:00Z');
    await prisma.associate.update({ where: { id: withPhoto.id }, data: { photoS3Key: 'photos/pia.jpg', photoUpdatedAt: stamp } });
    for (const a of [withPhoto, without]) {
      await createUser({ role: 'ASSOCIATE', email: a.email, associateId: a.id, status: 'ACTIVE' });
      await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    }
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 4 * 3_600_000);
    await prisma.shift.create({ data: { clientId: client.id, position: 'Stocker', startsAt: start, endsAt: end, status: 'ASSIGNED', assignedAssociateId: withPhoto.id } });
    await prisma.shift.create({ data: { clientId: client.id, position: 'Stocker', startsAt: start, endsAt: end, status: 'ASSIGNED', assignedAssociateId: without.id } });
    await prisma.shift.create({ data: { clientId: client.id, position: 'Cashier', startsAt: start, endsAt: end, status: 'OPEN' } });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const roster = await agent.get(`/scheduling/associates?clientId=${client.id}`);
    expect(roster.status).toBe(200);
    const byId = new Map<string, { photoUrl?: string | null }>(roster.body.associates.map((a: { id: string; photoUrl?: string | null }) => [a.id, a]));
    expect(byId.get(withPhoto.id)?.photoUrl).toBe(`/api/associates/${withPhoto.id}/photo?v=${stamp.getTime()}`);
    expect(byId.get(without.id)?.photoUrl).toBeNull();

    const from = new Date(start.getTime() - 3_600_000).toISOString();
    const to = new Date(end.getTime() + 3_600_000).toISOString();
    const shifts = await agent.get(`/scheduling/shifts?clientId=${client.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(shifts.status).toBe(200);
    type Row = { assignedAssociateId: string | null; assignedAssociatePhotoUrl?: string | null };
    const rows: Row[] = shifts.body.shifts;
    expect(rows).toHaveLength(3);
    expect(rows.find((s) => s.assignedAssociateId === withPhoto.id)?.assignedAssociatePhotoUrl).toBe(`/api/associates/${withPhoto.id}/photo?v=${stamp.getTime()}`);
    expect(rows.find((s) => s.assignedAssociateId === without.id)?.assignedAssociatePhotoUrl).toBeNull();
    expect(rows.find((s) => s.assignedAssociateId === null)?.assignedAssociatePhotoUrl).toBeNull();
  });

  it('time-off requests carry the requester photoUrl', async () => {
    const a = await createAssociate({ firstName: 'Tess', lastName: 'Off' });
    await prisma.associate.update({ where: { id: a.id }, data: { photoS3Key: null } });
    await createUser({ role: 'ASSOCIATE', email: a.email, associateId: a.id, status: 'ACTIVE' });
    await prisma.timeOffRequest.create({
      data: { associateId: a.id, category: 'PTO', startDate: new Date('2026-12-01'), endDate: new Date('2026-12-02'), requestedMinutes: 480, status: 'PENDING' },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get('/time-off/admin/requests');
    expect(res.status).toBe(200);
    const row = res.body.requests.find((r: { associateId: string }) => r.associateId === a.id);
    expect(row).toBeTruthy();
    expect(row.associatePhotoUrl).toBeNull();
  });
});

/**
 * The busiest screens built a bare /api/associates/:id/photo from an id —
 * ~1,200 404s in three days for people with no photo. Each payload below
 * now says: the versioned URL when a photo is on file, null when there is
 * none (the web then asks for nothing).
 */
describe('photo-aware payloads — the high-traffic screens', () => {
  const HOUR = 3_600_000;
  const stamp = new Date('2026-10-01T12:00:00Z');
  const versioned = (id: string) => `/api/associates/${id}/photo?v=${stamp.getTime()}`;

  /** Two people: Pia has a photo on file, Nate has none. */
  async function pair() {
    const pia = await createAssociate({ firstName: 'Pia', lastName: 'Photo' });
    const nate = await createAssociate({ firstName: 'Nate', lastName: 'None' });
    await prisma.associate.update({ where: { id: pia.id }, data: { photoS3Key: 'photos/pia.jpg', photoUpdatedAt: stamp } });
    return { pia, nate };
  }

  it('the client portal: the on-floor face pile and the week’s schedule', async () => {
    const client = await createClient('Portal Mart');
    const { pia, nate } = await pair();
    const now = new Date();
    for (const a of [pia, nate]) {
      // Starts exactly now: always inside the store's today and its week.
      const shift = await prisma.shift.create({
        data: { clientId: client.id, assignedAssociateId: a.id, position: 'Stocker', startsAt: now, endsAt: new Date(now.getTime() + 4 * HOUR), status: 'ASSIGNED', publishedAt: now },
      });
      await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, shiftId: shift.id, clockInAt: new Date(now.getTime() - 60_000), status: 'ACTIVE' } });
    }
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const agent = await loginAs(portal.email);

    const overview = await agent.get('/client-portal/overview');
    expect(overview.status).toBe(200);
    const onFloor = new Map<string, { photoUrl?: string | null }>(overview.body.now.onFloor.map((p: { associateId: string }) => [p.associateId, p]));
    expect(onFloor.get(pia.id)?.photoUrl).toBe(versioned(pia.id));
    expect(onFloor.get(nate.id)?.photoUrl).toBeNull();

    const schedule = await agent.get('/client-portal/schedule');
    expect(schedule.status).toBe(200);
    type Row = { associateId: string | null; photoUrl?: string | null };
    const rows: Row[] = schedule.body.days.flatMap((d: { shifts: Row[] }) => d.shifts);
    expect(rows.find((r) => r.associateId === pia.id)?.photoUrl).toBe(versioned(pia.id));
    expect(rows.find((r) => r.associateId === nate.id)?.photoUrl).toBeNull();
    // The payload never carries the storage key itself.
    expect(JSON.stringify(schedule.body) + JSON.stringify(overview.body)).not.toContain('photos/pia.jpg');
  });

  it('the floor team: a shift supervisor’s floor supervisors', async () => {
    const client = await createClient('Floor Mart');
    const { pia } = await pair();
    const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: withFace } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: client.id, associateId: pia.id });
    const { user: noFace } = await createUser({ role: 'FLOOR_SUPERVISOR', clientId: client.id });
    await prisma.user.updateMany({ where: { id: { in: [withFace.id, noFace.id] } }, data: { leadUserId: lead.id } });

    const res = await (await loginAs(lead.email)).get('/me/floor-team');
    expect(res.status).toBe(200);
    const team = new Map<string, { photoUrl?: string | null }>(res.body.team.map((m: { userId: string }) => [m.userId, m]));
    expect(team.get(withFace.id)?.photoUrl).toBe(versioned(pia.id));
    expect(team.get(noFace.id)?.photoUrl).toBeNull();
  });

  it('attendance “not in yet”, and the approvals chase list of unconfirmed shifts', async () => {
    const client = await createClient('Late Mart');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const { pia, nate } = await pair();
    const now = Date.now();
    for (const a of [pia, nate]) {
      // Started 40 minutes ago, no punch: late.
      await prisma.shift.create({
        data: { clientId: client.id, locationId: site.id, assignedAssociateId: a.id, position: 'Stocker', startsAt: new Date(now - 40 * 60_000), endsAt: new Date(now + 7 * HOUR), status: 'ASSIGNED', publishedAt: new Date(now - 24 * HOUR) },
      });
      // Tomorrow, published, not yet confirmed.
      await prisma.shift.create({
        data: { clientId: client.id, locationId: site.id, assignedAssociateId: a.id, position: 'Stocker', startsAt: new Date(now + 20 * HOUR), endsAt: new Date(now + 24 * HOUR), status: 'ASSIGNED', publishedAt: new Date(now - 24 * HOUR) },
      });
    }
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const late = await (await loginAs(sup.email)).get('/attendance/late-now');
    expect(late.status).toBe(200);
    const people = new Map<string, { photoUrl?: string | null }>(late.body.people.map((p: { associateId: string }) => [p.associateId, p]));
    expect(people.get(pia.id)?.photoUrl).toBe(versioned(pia.id));
    expect(people.get(nate.id)?.photoUrl).toBeNull();

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const chase = await (await loginAs(hr.email)).get('/scheduling/unconfirmed');
    expect(chase.status).toBe(200);
    const rows = new Map<string, { associatePhotoUrl?: string | null }>(chase.body.shifts.map((r: { associateId: string }) => [r.associateId, r]));
    expect(rows.get(pia.id)?.associatePhotoUrl).toBe(versioned(pia.id));
    expect(rows.get(nate.id)?.associatePhotoUrl).toBeNull();
  });

  it('the driver app: today’s runs, the seat requests and a rider’s profile', async () => {
    const client = await createClient('Van Mart');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const { pia, nate } = await pair();
    const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
    const { user: mike } = await createUser({ role: 'DRIVER' });
    const van = await prisma.van.create({ data: { name: 'Van 1', capacity: 6, driverUserId: mike.id } });
    const targetAt = new Date(Date.now() + 3 * HOUR);
    const serviceDate = dateKeyInZone(targetAt, store.timezone);
    const ride = (associateId: string, data: Record<string, unknown> = {}) =>
      prisma.ride.create({
        data: { associateId, direction: 'TO_WORK', locationId: store.id, address: '1 Main St', lat: 30.25, lng: -85.9, targetAt, serviceDate, fareCents: 500, noShowFeeCents: 100, createdById: director.id, ...data },
      });
    // Today's run carries both; both also ask for a seat later on.
    const run = await prisma.rideRun.create({
      data: { vanId: van.id, driverUserId: mike.id, direction: 'TO_WORK', serviceDate, departAt: new Date(targetAt.getTime() - HOUR), status: 'PLANNED', createdById: director.id },
    });
    for (const a of [pia, nate]) {
      await ride(a.id, { runId: run.id, status: 'SCHEDULED', pickupOrder: 1, pickupAt: new Date(targetAt.getTime() - 30 * 60_000) });
      await ride(a.id, { direction: 'FROM_WORK', targetAt: new Date(targetAt.getTime() + 8 * HOUR) });
    }
    const agent = await loginAs(mike.email);

    const runs = await agent.get('/transport/driver/runs');
    expect(runs.status).toBe(200);
    type Rider = { associateId: string; photoUrl?: string | null };
    const onRun: Rider[] = runs.body.runs.flatMap((r: { rides: Array<{ rider: Rider }> }) => r.rides.map((x) => x.rider));
    expect(onRun.find((r) => r.associateId === pia.id)?.photoUrl).toBe(versioned(pia.id));
    expect(onRun.find((r) => r.associateId === nate.id)?.photoUrl).toBeNull();

    const requests = await agent.get('/transport/driver/requests');
    expect(requests.status).toBe(200);
    const asking: Rider[] = requests.body.requests.map((r: { rider: Rider }) => r.rider);
    expect(asking.find((r) => r.associateId === pia.id)?.photoUrl).toBe(versioned(pia.id));
    expect(asking.find((r) => r.associateId === nate.id)?.photoUrl).toBeNull();

    expect((await agent.get(`/transport/riders/${pia.id}`)).body.rider.photoUrl).toBe(versioned(pia.id));
    expect((await agent.get(`/transport/riders/${nate.id}`)).body.rider.photoUrl).toBeNull();
  });
});
