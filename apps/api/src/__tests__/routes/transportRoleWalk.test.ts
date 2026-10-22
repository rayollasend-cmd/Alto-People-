import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { dateKeyInZone } from '../../lib/timeAnomalies.js';
import { closeStuckRuns, isRunStuck } from '../../lib/transportStuckRuns.js';
import { setSmsTransportForTests } from '../../lib/sms.js';
import { hugoAudienceOf, intentsFor } from '../../lib/hugo.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The transport role walk (2026-10-20) and audit Tier 1 #8, on the server:
 *
 *   1  a van and a driver take one run at a time (409 van_busy / driver_busy)
 *   2  once the desk keeps driver records, no record is no licence: refused
 *   3  Plan runs tops up a run that already exists before opening a van
 *   4  a run left open hours past its last stop is closed by the sweep;
 *      riders never marked stay SCHEDULED, nobody is charged a guess
 *   7  the desk's rider record
 *   8  "Unsigned" on a run's rows
 *   9  the driver logs fuel; the fleet says when service is due by miles
 *  10  batch dispatch is all-or-nothing
 *  floor 16  Report a problem takes a van off the road and moves its runs
 *  floor 17  Arrived and No-show carry where the phone was
 *  floor 18  "I'm here" is honest when SMS isn't connected; board-all
 *  floor 19  the driver's own assistant audience
 *  floor 5   a replayed tap that already landed is a success, not a refusal
 */

beforeEach(async () => {
  await truncateAll();
  await prisma.transportSettings.upsert({ where: { id: 'default' }, create: { id: 'default', preTripRequired: false }, update: { preTripRequired: false } });
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
const NEAR = { lat: 30.19, lng: -85.82 };
const MID = { lat: 30.25, lng: -85.9 };
const H = 3_600_000;

async function day(vanCapacities: number[] = [12], opts: { hoursAhead?: number } = {}) {
  const client = await createClient('Coastal');
  const first = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const store = await prisma.site.update({ where: { id: first.id }, data: { latitude: STORE.lat, longitude: STORE.lng } });
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mike = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  const { user: driver } = await createUser({ role: 'DRIVER', associateId: mike.id });
  const tasha = await createAssociate({ firstName: 'Tasha', lastName: 'Grant' });
  const { user: driver2 } = await createUser({ role: 'DRIVER', associateId: tasha.id });
  const vans: Array<Awaited<ReturnType<typeof prisma.van.create>>> = [];
  for (const [i, capacity] of vanCapacities.entries()) {
    vans.push(await prisma.van.create({ data: { name: `Van ${i + 1}`, capacity, plate: `ALT ${i + 1}` } }));
  }
  const targetAt = new Date(Date.now() + (opts.hoursAhead ?? 20) * H);
  targetAt.setMinutes(0, 0, 0);
  const serviceDate = dateKeyInZone(targetAt, store.timezone);
  const rider = async (firstName: string, at: { lat: number; lng: number }, o: { direction?: 'TO_WORK' | 'FROM_WORK'; targetAt?: Date; phone?: string } = {}) => {
    const a = await createAssociate({ firstName, lastName: 'Rider' });
    if (o.phone) await prisma.associate.update({ where: { id: a.id }, data: { phone: o.phone } });
    const ride = await prisma.ride.create({
      data: {
        associateId: a.id,
        direction: o.direction ?? 'TO_WORK',
        locationId: store.id,
        address: `${firstName}'s place`,
        lat: at.lat,
        lng: at.lng,
        targetAt: o.targetAt ?? targetAt,
        serviceDate,
        fareCents: 500,
        noShowFeeCents: 100,
        createdById: director.id,
      },
    });
    return { ride, associate: a };
  };
  const runBody = (rideIds: string[], over: Record<string, unknown> = {}) => ({
    vanId: vans[0]!.id,
    driverUserId: driver.id,
    direction: 'TO_WORK',
    serviceDate,
    departAt: new Date(targetAt.getTime() - H).toISOString(),
    rides: rideIds.map((rideId, i) => ({ rideId, pickupAt: new Date(targetAt.getTime() - 50 * 60_000 + i * 5 * 60_000).toISOString() })),
    ...over,
  });
  return {
    client,
    store,
    director,
    directorAgent: await loginAs(director.email),
    driver,
    driverAgent: await loginAs(driver.email),
    driver2,
    mike,
    vans,
    targetAt,
    serviceDate,
    rider,
    runBody,
  };
}

describe('transport walk 1 — one run at a time per van and per driver', () => {
  it('refuses a second run that overlaps the same van, then the same driver; a later one goes', async () => {
    const d = await day([12, 12]);
    const a = await d.rider('Ann', NEAR);
    const b = await d.rider('Bo', MID);
    const c = await d.rider('Cy', MID);
    expect((await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id]))).status).toBe(201);
    // Same van, three minutes later: no.
    const sameVan = await d.directorAgent.post('/transport/runs').send(d.runBody([b.ride.id], { driverUserId: d.driver2.id, departAt: new Date(d.targetAt.getTime() - H + 3 * 60_000).toISOString() }));
    expect(sameVan.status).toBe(409);
    expect(sameVan.body.error.code).toBe('van_busy');
    // Another van, the same driver: no.
    const sameDriver = await d.directorAgent.post('/transport/runs').send(d.runBody([b.ride.id], { vanId: d.vans[1]!.id }));
    expect(sameDriver.status).toBe(409);
    expect(sameDriver.body.error.code).toBe('driver_busy');
    // Another van and driver at the same time: fine.
    expect((await d.directorAgent.post('/transport/runs').send(d.runBody([b.ride.id], { vanId: d.vans[1]!.id, driverUserId: d.driver2.id }))).status).toBe(201);
    // The same van three hours later: the first run is long over.
    const later = await d.directorAgent.post('/transport/runs').send(d.runBody([c.ride.id], { departAt: new Date(d.targetAt.getTime() + 2 * H).toISOString(), rides: [{ rideId: c.ride.id, pickupAt: new Date(d.targetAt.getTime() + 2 * H).toISOString() }] }));
    expect(later.status).toBe(201);
  });

  it('editing a run onto a busy van is refused too; the run itself is never its own conflict', async () => {
    const d = await day([12, 12]);
    const a = await d.rider('Ann', NEAR);
    const b = await d.rider('Bo', MID);
    const r1 = (await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id]))).body.run;
    const r2 = (await d.directorAgent.post('/transport/runs').send(d.runBody([b.ride.id], { vanId: d.vans[1]!.id, driverUserId: d.driver2.id }))).body.run;
    const clash = await d.directorAgent.patch(`/transport/runs/${r2.id}`).send({ vanId: d.vans[0]!.id });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('van_busy');
    // Re-saving a run with its own van and time is not a clash with itself.
    expect((await d.directorAgent.patch(`/transport/runs/${r1.id}`).send({ departAt: r1.departAt, notes: 'gas card in the glovebox' })).status).toBe(200);
  });
});

describe('transport walk 2 — no licence on file refuses dispatch once records are kept', () => {
  it('passes while no driver has a record; refuses the driver with none once another has one', async () => {
    const d = await day();
    const a = await d.rider('Ann', NEAR);
    const b = await d.rider('Bo', MID);
    // No records anywhere: a fleet that doesn't track licences isn't stopped.
    expect((await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id]))).status).toBe(201);
    // Tasha has a licence on file. Mike has no record at all → no licence.
    await prisma.driverProfile.create({ data: { userId: d.driver2.id, licenceExpiresAt: new Date(Date.now() + 365 * 86_400_000) } });
    const refused = await d.directorAgent.post('/transport/runs').send(d.runBody([b.ride.id], { departAt: new Date(d.targetAt.getTime() + 3 * H).toISOString(), rides: [{ rideId: b.ride.id, pickupAt: new Date(d.targetAt.getTime() + 3 * H).toISOString() }] }));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('driver_credentials');
    expect(refused.body.error.message).toMatch(/licence not on file/);
    // The board says so before anyone tries.
    const board = (await d.directorAgent.get(`/transport/board?date=${d.serviceDate}`)).body;
    expect(board.credentialsEnforced).toBe(true);
    const mike = board.drivers.find((x: { userId: string }) => x.userId === d.driver.id);
    expect(mike).toMatchObject({ licenceOnFile: false, canDrive: false, credentialProblem: 'No licence on file' });
    expect(board.drivers.find((x: { userId: string }) => x.userId === d.driver2.id)).toMatchObject({ licenceOnFile: true, canDrive: true });
    // The planner never proposes Mike for a new van; Bo tops up Mike's existing
    // run (it keeps its driver) and the proposal says Mike can't drive it.
    const plan = (await d.directorAgent.post('/transport/plan').send({ date: d.serviceDate })).body;
    for (const p of plan.proposals.filter((x: { kind: string }) => x.kind === 'new')) expect(p.driverUserId).not.toBe(d.driver.id);
    const topUp = plan.proposals.find((x: { kind: string }) => x.kind === 'topUp');
    expect(topUp.warnings.join(' ')).toMatch(/can't drive it now/);
  });
});

describe('transport walk 3 — Plan runs tops up a run that already exists', () => {
  it('proposes adding the waiting riders to the planned run with seats free, not a second van', async () => {
    const d = await day([12, 12]);
    const a = await d.rider('Ann', NEAR);
    const run = (await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id]))).body.run;
    const b = await d.rider('Bo', MID);
    const c = await d.rider('Cy', NEAR);
    const plan = (await d.directorAgent.post('/transport/plan').send({ date: d.serviceDate })).body;
    expect(plan.proposals).toHaveLength(1);
    const p = plan.proposals[0];
    expect(p).toMatchObject({ kind: 'topUp', runId: run.id, vanId: d.vans[0]!.id, driverUserId: d.driver.id, seats: { taken: 3, capacity: 12, added: 2 } });
    expect(p.store.point).toEqual(STORE);
    const ids = p.rides.map((r: { rideId: string }) => r.rideId).sort();
    expect(ids).toEqual([a.ride.id, b.ride.id, c.ride.id].sort());
    expect(p.rides.find((r: { rideId: string }) => r.rideId === a.ride.id).existing).toBe(true);
    expect(p.rides.find((r: { rideId: string }) => r.rideId === b.ride.id).existing).toBe(false);
  });

  it('a full run is left alone — a new van opens for the rest', async () => {
    const d = await day([1, 12]);
    const a = await d.rider('Ann', NEAR);
    await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id]));
    await d.rider('Bo', MID);
    const plan = (await d.directorAgent.post('/transport/plan').send({ date: d.serviceDate })).body;
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]).toMatchObject({ kind: 'new', vanId: d.vans[1]!.id });
  });
});

describe('transport walk 10 — batch dispatch, all or nothing', () => {
  it('one proposal that can’t go refuses the whole batch and writes nothing', async () => {
    const d = await day([12, 12]);
    const a = await d.rider('Ann', NEAR);
    const b = await d.rider('Bo', MID);
    const res = await d.directorAgent.post('/transport/runs/batch').send({
      runs: [
        { key: 'one', ...d.runBody([a.ride.id]) },
        // The same van at the same time, inside the batch.
        { key: 'two', ...d.runBody([b.ride.id], { driverUserId: d.driver2.id }) },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('batch_refused');
    expect(res.body.error.details.errors).toEqual([expect.objectContaining({ key: 'two', code: 'van_busy' })]);
    expect(await prisma.rideRun.count()).toBe(0);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: a.ride.id } })).status).toBe('REQUESTED');
  });

  it('a clean batch creates every run and tops up an existing one in one go; riders hear it', async () => {
    const d = await day([12, 12]);
    const a = await d.rider('Ann', NEAR);
    const existing = (await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id]))).body.run;
    const b = await d.rider('Bo', MID);
    const c = await d.rider('Cy', NEAR, { direction: 'FROM_WORK', targetAt: new Date(d.targetAt.getTime() + 8 * H) });
    const res = await d.directorAgent.post('/transport/runs/batch').send({
      runs: [{ key: 'home', ...d.runBody([c.ride.id], { direction: 'FROM_WORK', vanId: d.vans[1]!.id, driverUserId: d.driver2.id, departAt: new Date(d.targetAt.getTime() + 8 * H).toISOString(), rides: [{ rideId: c.ride.id, pickupAt: new Date(d.targetAt.getTime() + 8 * H).toISOString() }] }) }],
      topUps: [{ key: 'topUp|x', runId: existing.id, rides: [{ rideId: a.ride.id, pickupAt: new Date(d.targetAt.getTime() - 50 * 60_000).toISOString() }, { rideId: b.ride.id, pickupAt: new Date(d.targetAt.getTime() - 45 * 60_000).toISOString() }] }],
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toEqual([{ key: 'home', runId: expect.any(String) }]);
    expect(res.body.updated).toEqual([{ key: 'topUp|x', runId: existing.id }]);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: b.ride.id } })).runId).toBe(existing.id);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: c.ride.id } })).status).toBe('SCHEDULED');
    await flushPendingNotifications();
    const bo = await prisma.user.findFirst({ where: { associateId: b.associate.id } });
    // Bo has no login — nothing to notify; the run's driver was told.
    expect(bo).toBeNull();
    expect(await prisma.notification.count({ where: { recipientUserId: d.driver.id, subject: { startsWith: 'Run: Van 1' } } })).toBeGreaterThan(0);
  });
});

describe('transport walk 4 — the stuck-run sweep', () => {
  it('closes a run left open past its last stop, completes who boarded, leaves the unmarked for review, and the live map drops it', async () => {
    const d = await day([12], { hoursAhead: -6 });
    const a = await d.rider('Ann', NEAR);
    const b = await d.rider('Bo', MID);
    const run = await prisma.rideRun.create({
      data: { vanId: d.vans[0]!.id, driverUserId: d.driver.id, direction: 'TO_WORK', serviceDate: d.serviceDate, departAt: new Date(d.targetAt.getTime() - H), status: 'ACTIVE', startedAt: new Date(d.targetAt.getTime() - H), createdById: d.director.id },
    });
    await prisma.ride.update({ where: { id: a.ride.id }, data: { runId: run.id, status: 'BOARDED', boardedAt: new Date(d.targetAt.getTime() - 50 * 60_000), chargeCents: 500, pickupOrder: 1 } });
    await prisma.ride.update({ where: { id: b.ride.id }, data: { runId: run.id, status: 'SCHEDULED', pickupOrder: 2 } });
    const live = (await d.directorAgent.get('/transport/live')).body;
    expect(live.runs.find((r: { runId: string }) => r.runId === run.id)).toMatchObject({ stuck: true });
    expect(isRunStuck({ status: 'ACTIVE', departAt: new Date(Date.now() - 2 * H), rides: [] })).toBe(false);

    const swept = await closeStuckRuns();
    expect(swept).toMatchObject({ closed: 1, unmarked: 1, runIds: [run.id] });
    const after = await prisma.rideRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('COMPLETED');
    expect(after.autoClosedAt).not.toBeNull();
    expect(after.notes).toMatch(/Closed automatically .* 1 rider never marked/);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: a.ride.id } })).status).toBe('COMPLETED');
    // Never marked: still SCHEDULED, nothing charged — not a no-show, not a fare.
    const bo = await prisma.ride.findUniqueOrThrow({ where: { id: b.ride.id } });
    expect(bo.status).toBe('SCHEDULED');
    expect(bo.chargeCents).toBe(0);
    // Gone from the live map; on the board with the stamp; the planner no longer counts the van busy.
    expect((await d.directorAgent.get('/transport/live')).body.runs.some((r: { runId: string }) => r.runId === run.id)).toBe(false);
    const board = (await d.directorAgent.get(`/transport/board?date=${d.serviceDate}`)).body;
    expect(board.runs.find((r: { id: string }) => r.id === run.id)).toMatchObject({ status: 'COMPLETED', autoClosedAt: expect.any(String) });
    // A second sweep finds nothing.
    expect((await closeStuckRuns()).closed).toBe(0);
    await flushPendingNotifications();
    const told = await prisma.notification.findMany({ where: { recipientUserId: d.director.id, channel: 'IN_APP', subject: { contains: 'never marked' } } });
    expect(told).toHaveLength(1);
    // The link opens the board on that day — ?date= is what /transport reads.
    expect(told[0]!.linkUrl).toBe(`/transport?date=${d.serviceDate}`);
  });
});

describe('transport walk 7 and 8 — the rider record and the unsigned chip', () => {
  it('the desk reads the last rides, the no-show rate, what is owed and held, the signature, open issues; a run’s rows say who hasn’t signed', async () => {
    const d = await day();
    const a = await d.rider('Ann', NEAR, { phone: '555-0100' });
    await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id]));
    const board = (await d.directorAgent.get(`/transport/board?date=${d.serviceDate}`)).body;
    expect(board.runs[0].rides[0].signatureNeeded).toMatch(/authorization|sign/i);
    // Two earlier rides: one taken (held — never signed), one no-show.
    await prisma.ride.create({ data: { associateId: a.associate.id, direction: 'TO_WORK', locationId: d.store.id, address: 'x', targetAt: new Date(Date.now() - 3 * 86_400_000), serviceDate: '2026-01-01', status: 'COMPLETED', fareCents: 500, noShowFeeCents: 100, chargeCents: 500, createdById: d.director.id } });
    await prisma.ride.create({ data: { associateId: a.associate.id, direction: 'TO_WORK', locationId: d.store.id, address: 'x', targetAt: new Date(Date.now() - 2 * 86_400_000), serviceDate: '2026-01-02', status: 'NO_SHOW', fareCents: 500, noShowFeeCents: 100, chargeCents: 0, uncollectedCents: 100, waiveKind: 'NOT_AUTHORIZED', waivedAt: new Date(), createdById: d.director.id } });
    const rec = await d.directorAgent.get(`/transport/riders/${a.associate.id}`);
    expect(rec.status).toBe(200);
    expect(rec.body.rider).toMatchObject({ name: 'Ann Rider', phone: '555-0100', rides: 1, noShows: 1, noShowRate: 50, heldCents: 500, notAuthorizedCents: 100, owedCents: 0, openIssues: 0, authorization: { current: false } });
    expect(rec.body.recent).toHaveLength(3);
    // The driver's view stays the short one.
    const mine = await d.driverAgent.get(`/transport/riders/${a.associate.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.recent).toBeUndefined();
  });
});

describe('floor walk 17, 18 and 5 — the driver’s taps', () => {
  async function onTheRoad() {
    const d = await day([12], { hoursAhead: 1 });
    const a = await d.rider('Ann', NEAR, { phone: '(850) 555-0101' });
    const b = await d.rider('Bo', NEAR);
    const run = (await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id, b.ride.id]))).body.run;
    return { ...d, a, b, run };
  }

  it('Arrived and No-show keep where the phone was and how far from the stop; far away is flagged, never refused', async () => {
    const f = await onTheRoad();
    // Arrived from across town: kept, flagged far.
    const arrived = await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/arrived`).send({ rideIds: [f.a.ride.id, f.b.ride.id], lat: STORE.lat, lng: STORE.lng, accuracy: 12 });
    expect(arrived.status).toBe(200);
    expect(arrived.body.evidence.far).toBe(true);
    expect(arrived.body.evidence.distanceM).toBeGreaterThan(150);
    const ann = await prisma.ride.findUniqueOrThrow({ where: { id: f.a.ride.id } });
    expect(Number(ann.arrivedLat)).toBeCloseTo(STORE.lat, 4);
    expect(ann.arrivedAccuracyM).toBe(12);
    expect(ann.arrivedDistanceM).toBe(arrived.body.evidence.distanceM);
    await prisma.ride.updateMany({ where: { runId: f.run.id }, data: { vanArrivedAt: new Date(Date.now() - 4 * 60_000) } });
    // No-show from the kerb: close, with the evidence on the ride.
    const noShow = await f.driverAgent.post(`/transport/driver/rides/${f.b.ride.id}/no-show`).send({ lat: NEAR.lat + 0.0003, lng: NEAR.lng, accuracy: 8 });
    expect(noShow.status).toBe(200);
    expect(noShow.body.evidence.far).toBe(false);
    const bo = await prisma.ride.findUniqueOrThrow({ where: { id: f.b.ride.id } });
    expect(bo.noShowDistanceM).toBeLessThan(150);
    expect(bo.noShowAccuracyM).toBe(8);
    // A tap with no position still works — a phone with no fix never stops a mark.
    expect((await f.driverAgent.post(`/transport/driver/rides/${f.a.ride.id}/board`).send({})).status).toBe(200);
  });

  it('a replayed tap that already landed answers 200, not a refusal that would drop it from the queue', async () => {
    const f = await onTheRoad();
    expect((await f.driverAgent.post(`/transport/driver/rides/${f.a.ride.id}/board`).send({ idempotencyKey: 'k1' })).status).toBe(200);
    const again = await f.driverAgent.post(`/transport/driver/rides/${f.a.ride.id}/board`).send({ idempotencyKey: 'k1', replay: true });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.ride.status).toBe('BOARDED');
    // Without the replay flag, a double tap is still refused (the server has spoken).
    expect((await f.driverAgent.post(`/transport/driver/rides/${f.a.ride.id}/board`).send({})).status).toBe(409);
    // Charged once.
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: f.a.ride.id } })).chargeCents).toBe(500);
  });

  it('All on board is one request, offered for one rider too; everyone boards and the ones already on are listed', async () => {
    const f = await onTheRoad();
    await f.driverAgent.post(`/transport/driver/rides/${f.a.ride.id}/board`).send({});
    const all = await f.driverAgent.post(`/transport/driver/runs/${f.run.id}/board-all`).send({ rideIds: [f.a.ride.id, f.b.ride.id], replay: true });
    expect(all.status).toBe(200);
    expect(all.body.boarded).toEqual([f.b.ride.id]);
    expect(all.body.already).toEqual([f.a.ride.id]);
    expect(all.body.run.rides.every((r: { status: string }) => r.status === 'BOARDED')).toBe(true);
  });

  it('"I’m here" says SMS isn’t connected (nothing recorded as sent) and hands back the words and an sms: link; no phone, no link', async () => {
    const f = await onTheRoad();
    const res = await f.driverAgent.post(`/transport/driver/rides/${f.a.ride.id}/text-here`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: false, reason: 'sms_not_configured' });
    expect(res.body.body).toMatch(/Mike is outside with Van 1 at Ann's place\. The van waits 3 minutes\./);
    expect(res.body.smsHref).toMatch(/^sms:8505550101\?&body=/);
    expect(await prisma.notification.count({ where: { channel: 'SMS' } })).toBe(0);
    const noPhone = await f.driverAgent.post(`/transport/driver/rides/${f.b.ride.id}/text-here`);
    expect(noPhone.body).toMatchObject({ sent: false, reason: 'no_phone', smsHref: null });
    // Not the driver's run: not found.
    const other = await loginAs(f.driver2.email);
    expect((await other.post(`/transport/driver/rides/${f.a.ride.id}/text-here`)).status).toBe(404);
  });

  it('"I’m here" goes out through the notifications SMS channel when it is connected, and is recorded as sent', async () => {
    const f = await onTheRoad();
    const sent: Array<{ to: string; body: string }> = [];
    setSmsTransportForTests(async (m) => {
      sent.push(m);
      return { sid: 'SM123', status: 'queued' };
    });
    try {
      const res = await f.driverAgent.post(`/transport/driver/rides/${f.a.ride.id}/text-here`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sent: true, reason: null });
      expect(sent).toEqual([{ to: '+18505550101', body: expect.stringMatching(/Mike is outside with Van 1/) }]);
      expect(await prisma.notification.count({ where: { channel: 'SMS', status: 'SENT', externalRef: 'SM123' } })).toBe(1);
    } finally {
      setSmsTransportForTests(null);
    }
  });
});

describe('floor walk 16 — Report a problem takes the van off the road', () => {
  it('parks the van, opens the incident and the issue with the photos and the spot, moves the planned run to a free van and flags the one on the road', async () => {
    const d = await day([12, 12], { hoursAhead: 1 });
    const a = await d.rider('Ann', NEAR);
    const b = await d.rider('Bo', MID, { targetAt: new Date(d.targetAt.getTime() + 4 * H) });
    const now = (await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id]))).body.run;
    const later = (await d.directorAgent.post('/transport/runs').send(d.runBody([b.ride.id], { departAt: new Date(d.targetAt.getTime() + 3 * H).toISOString(), rides: [{ rideId: b.ride.id, pickupAt: new Date(d.targetAt.getTime() + 3 * H).toISOString() }] }))).body.run;
    await d.driverAgent.post(`/transport/driver/runs/${now.id}/start`);
    const res = await d.driverAgent.post('/transport/issues').send({
      category: 'VEHICLE',
      body: 'Brakes grinding hard, pedal goes to the floor.',
      runId: now.id,
      photoKeys: ['photos/brake.jpg'],
      lat: NEAR.lat,
      lng: NEAR.lng,
      vanOutOfService: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.vanParked).toBe(true);
    expect(res.body.runs).toEqual({ moved: [later.id], flagged: [now.id] });
    const van = await prisma.van.findUniqueOrThrow({ where: { id: d.vans[0]!.id } });
    expect(van.outOfServiceAt).not.toBeNull();
    expect(van.outOfServiceReason).toMatch(/vehicle reported by Mike Chen/);
    const issue = await prisma.transportIssue.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(issue).toMatchObject({ vanParked: true, vanId: d.vans[0]!.id, photoKeys: ['photos/brake.jpg'] });
    expect(Number(issue.lat)).toBeCloseTo(NEAR.lat, 4);
    expect(await prisma.transportIncident.count({ where: { vanId: d.vans[0]!.id, vanParked: true, kind: 'BREAKDOWN' } })).toBe(1);
    // The later run moved to Van 2; the one on the road is flagged on its note.
    expect((await prisma.rideRun.findUniqueOrThrow({ where: { id: later.id } })).vanId).toBe(d.vans[1]!.id);
    expect((await prisma.rideRun.findUniqueOrThrow({ where: { id: now.id } })).notes).toMatch(/Van 1 is out of service/);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: d.director.id, channel: 'IN_APP', subject: { contains: 'taken off the road' } } })).toBe(1);
  });

  it('a rider can report, but never park a van', async () => {
    const d = await day();
    const a = await d.rider('Ann', NEAR);
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.associate.id });
    const rider = await loginAs(user.email);
    const res = await rider.post('/transport/issues').send({ category: 'VEHICLE', body: 'The van smelled of gas.', rideId: a.ride.id, vanOutOfService: true, vanId: d.vans[0]!.id });
    expect(res.status).toBe(403);
    expect((await prisma.van.findUniqueOrThrow({ where: { id: d.vans[0]!.id } })).outOfServiceAt).toBeNull();
  });
});

describe('transport walk 9 — fuel from the pump, service due by miles', () => {
  it('the driver logs fuel on their van (one tap); the log carries who; another driver’s van is refused; the fleet says service is due', async () => {
    const d = await day([12, 12]);
    await prisma.van.update({ where: { id: d.vans[0]!.id }, data: { driverUserId: d.driver.id, odometerMiles: 40_000 } });
    await prisma.vanServiceEntry.create({ data: { vanId: d.vans[0]!.id, kind: 'OIL_CHANGE', occurredAt: new Date('2026-09-01T00:00:00Z'), odometerMiles: 35_300, costCents: 8_000 } });
    const res = await d.driverAgent.post(`/transport/driver/vans/${d.vans[0]!.id}/fuel`).send({ gallons: 18.4, costCents: 6_212, odometerMiles: 40_120, photoKey: 'photos/receipt.jpg' });
    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({ kind: 'FUEL', costCents: 6_212, odometerMiles: 40_120 });
    const entry = await prisma.vanServiceEntry.findUniqueOrThrow({ where: { id: res.body.entry.id } });
    expect(entry.createdById).toBe(d.driver.id);
    expect(entry.notes).toBe('18.4 gal · receipt photo: photos/receipt.jpg');
    expect((await prisma.van.findUniqueOrThrow({ where: { id: d.vans[0]!.id } })).odometerMiles).toBe(40_120);
    // Not theirs, never driven: no.
    const other = await loginAs(d.driver2.email);
    expect((await other.post(`/transport/driver/vans/${d.vans[0]!.id}/fuel`).send({ costCents: 100 })).status).toBe(403);
    // The desk's fleet card: 5,000 miles after the last oil change, 180 left → due.
    const fleet = (await d.directorAgent.get('/transport/fleet')).body;
    const van1 = fleet.vans.find((v: { id: string }) => v.id === d.vans[0]!.id);
    expect(van1.serviceDue).toEqual({ atMiles: 40_300, milesLeft: 180, overdue: false, due: true });
    expect(fleet.vans.find((v: { id: string }) => v.id === d.vans[1]!.id).serviceDue).toBeNull();
    // The director sees the fuel line in the van's record.
    const record = (await d.directorAgent.get(`/transport/vans/${d.vans[0]!.id}/record`)).body;
    expect(record.serviceLog.some((e: { kind: string; costCents: number }) => e.kind === 'FUEL' && e.costCents === 6_212)).toBe(true);
  });
});

describe('transport walk 5 — the desk’s plan map', () => {
  it('groups the day’s open seats by store and way into stops with the store pin; a driver can’t read it', async () => {
    const d = await day();
    await d.rider('Ann', NEAR);
    await d.rider('Bo', NEAR);
    await d.rider('Hal', MID, { direction: 'FROM_WORK', targetAt: new Date(d.targetAt.getTime() + 8 * H) });
    const res = await d.directorAgent.get(`/transport/plan-map?date=${d.serviceDate}`);
    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(2);
    const toWork = res.body.trips.find((t: { direction: string }) => t.direction === 'TO_WORK');
    expect(toWork.store.point).toEqual(STORE);
    expect(toWork.riders).toBe(2);
    expect(toWork.clusters).toHaveLength(1); // two neighbours, one stop
    expect((await d.driverAgent.get(`/transport/plan-map?date=${d.serviceDate}`)).status).toBe(403);
  });
});

describe('floor walk 19 — the driver’s assistant', () => {
  it('a driver is the driver audience: their runs, not a rider’s ride', async () => {
    expect(hugoAudienceOf({ role: 'DRIVER', associateId: 'x' })).toBe('driver');
    expect(hugoAudienceOf({ role: 'DRIVER', associateId: null })).toBe('driver');
    expect(hugoAudienceOf({ role: 'TRANSPORTATION_DIRECTOR', associateId: null })).not.toBe('driver');
    expect(hugoAudienceOf({ role: 'ASSOCIATE', associateId: 'x' })).toBe('associate');
    const keys = intentsFor({ channel: 'app', audience: 'driver', moduleOn: () => true, capabilityOn: () => true }).map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['DRIVER_NEXT_RUN', 'DRIVER_RUN_RIDERS', 'DRIVER_VAN_ISSUE', 'HELP']));
    expect(keys).not.toContain('RIDE');
    expect(keys).not.toContain('PAYDAY');
  });

  it('the chips are the driver’s three and each answers from the run board', async () => {
    const d = await day([12], { hoursAhead: 3 });
    // The built-in assistant is owned by the tenant's first admin.
    await createUser({ role: 'HR_ADMINISTRATOR' });
    await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
    const a = await d.rider('Ann', NEAR);
    await d.directorAgent.post('/transport/runs').send(d.runBody([a.ride.id]));
    const me = await d.driverAgent.get('/hugo');
    expect(me.status).toBe(200);
    expect(me.body.audience).toBe('driver');
    const keys = me.body.can.map((c: { key: string }) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['DRIVER_NEXT_RUN', 'DRIVER_RUN_RIDERS', 'DRIVER_VAN_ISSUE']));
    expect(keys).not.toContain('RIDE');
    const next = await d.driverAgent.post('/hugo/ask').send({ text: 'When is my next run?' });
    expect(next.body.intent).toBe('DRIVER_NEXT_RUN');
    expect(next.body.reply).toMatch(/Your next run leaves .* in Van 1: 1 rider, to Coastal/);
    const who = await d.driverAgent.post('/hugo/ask').send({ text: "Who's on this run?" });
    expect(who.body.intent).toBe('DRIVER_RUN_RIDERS');
    expect(who.body.reply).toMatch(/1 on Van 1:\n• Ann Rider — Ann's place/);
    const issue = await d.driverAgent.post('/hugo/ask').send({ text: 'The van broke down' });
    expect(issue.body.intent).toBe('DRIVER_VAN_ISSUE');
    expect(issue.body.reply).toMatch(/Report a problem/);
  });
});
