import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { setGeocoderForTests } from '../../lib/geocode.js';
import { RIDE_AUTHORIZATION_VERSION } from '../../lib/rideAuthorizationContent.js';
import { authorizationCovers, rideRateOn, setRideRate } from '../../lib/rideAuthorization.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingAudits } from '../../lib/audit.js';

/**
 * Brief 1A-3 — ride deduction: keep it, fix it.
 *
 *   An associate is charged for a ride only with a SIGNED written
 *   authorization on file, at a configurable (effective-dated) rate. The
 *   minimum-wage guard lives in transport.test.ts with the payroll run.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  setGeocoderForTests(async () => ({ lat: 30.39, lng: -86.49 }));
  // The pre-trip check has its own suite (transportDriverPack); these are
  // about the charge, so the fleet runs with it switched off.
  await prisma.transportSettings.upsert({ where: { tenantId: '00000000-0000-4000-8000-000000000001' }, create: { preTripRequired: false }, update: { preTripRequired: false } });
});
afterAll(async () => {
  setGeocoderForTests(null);
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function seed() {
  const client = await createClient('Coastal');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const kim = await createAssociate({ firstName: 'Kim', lastName: 'Nguyen' });
  await prisma.application.create({
    data: { associateId: kim.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' },
  });
  const { user: kimUser } = await createUser({ role: 'ASSOCIATE', associateId: kim.id });
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mikeA = await createAssociate({ firstName: 'Mike', lastName: 'Driver' });
  const { user: driver } = await createUser({ role: 'DRIVER', associateId: mikeA.id });
  const van = await prisma.van.create({ data: { name: 'Van 1', plate: 'ALT 101', capacity: 2 } });
  const stop = await prisma.transportStop.create({ data: { name: 'Seaside Housing', address: '100 Gulf Blvd, Destin FL' } });
  return {
    client,
    store,
    kim,
    kimUser,
    kimAgent: await loginAs(kimUser.email),
    director,
    directorAgent: await loginAs(director.email),
    driver,
    driverAgent: await loginAs(driver.email),
    van,
    stop,
  };
}

const sign = (agent: TestAgent<Test>, typedName = 'Kim Nguyen') =>
  agent.post('/transport/me/authorization').send({ typedName });
const book = (agent: TestAgent<Test>, store: { id: string }, stop: { id: string }, hoursAhead = 20) =>
  agent.post('/transport/me/rides').send({ direction: 'TO_WORK', locationId: store.id, stopId: stop.id, targetAt: inHours(hoursAhead).toISOString() });

describe('the signed written authorization', () => {
  it('nothing is booked without it; signing keeps the PDF, its hash, the document and the signature', async () => {
    const s = await seed();
    const before = await s.kimAgent.get('/transport/me');
    expect(before.body.consent).toBeNull();
    expect(before.body.authorization).toMatchObject({ current: false, reason: 'No signed authorization on file.', version: null });
    // The words to sign name the rate in force.
    expect(before.body.authorization.agreement).toMatchObject({ version: RIDE_AUTHORIZATION_VERSION, lang: 'en', fareCents: 500, noShowFeeCents: 100 });
    expect(before.body.authorization.agreement.body).toMatch(/The charge for each ride I board is \$5\.00/);
    expect(before.body.authorization.agreement.body).toMatch(/minimum wage/);

    expect((await book(s.kimAgent, s.store, s.stop)).body.error.code).toBe('authorization_required');
    expect((await sign(s.kimAgent, 'K')).status).toBe(400);

    const signed = await sign(s.kimAgent);
    expect(signed.status).toBe(201);
    expect(signed.body.authorization).toMatchObject({ current: true, signedName: 'Kim Nguyen', version: RIDE_AUTHORIZATION_VERSION, fareCents: 500, noShowFeeCents: 100 });

    const consent = await prisma.rideConsent.findUniqueOrThrow({ where: { associateId: s.kim.id } });
    expect(consent.signatureId).toBeTruthy();
    expect(consent.documentId).toBeTruthy();
    const doc = await prisma.documentRecord.findUniqueOrThrow({ where: { id: consent.documentId! } });
    expect(doc).toMatchObject({ kind: 'SIGNED_AGREEMENT', status: 'VERIFIED', associateId: s.kim.id, mimeType: 'application/pdf' });
    expect(doc.s3Key).toMatch(/^tenants\/00000000-0000-4000-8000-000000000001\/esign\/ride-authorization\//); // Brief 2-1 §9.6: under the tenant
    const sig = await prisma.signature.findUniqueOrThrow({ where: { id: consent.signatureId! } });
    expect(sig).toMatchObject({ documentId: doc.id, typedName: 'Kim Nguyen', signerUserId: s.kimUser.id, associateId: s.kim.id });
    expect(sig.pdfHash).toMatch(/^[0-9a-f]{64}$/);

    const after = await s.kimAgent.get('/transport/me');
    expect(after.body.consent).toEqual({ acceptedAt: consent.acceptedAt.toISOString() });
    expect((await s.kimAgent.get('/transport/me/authorization/document')).body).toEqual({ documentId: doc.id });
    expect((await book(s.kimAgent, s.store, s.stop)).status).toBe(201);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'transport.authorization_signed', entityId: s.kim.id } });
    expect(audit?.metadata).toMatchObject({ version: RIDE_AUTHORIZATION_VERSION, fareCents: 500 });
  });

  it('a legacy one-click consent authorizes nothing', async () => {
    const s = await seed();
    await prisma.rideConsent.create({ data: { associateId: s.kim.id, fareCents: 500, noShowFeeCents: 100 } });
    const me = await s.kimAgent.get('/transport/me');
    expect(me.body.consent).toBeNull();
    expect(me.body.authorization.current).toBe(false);
    expect((await book(s.kimAgent, s.store, s.stop)).body.error.code).toBe('authorization_required');
    const list = await s.directorAgent.get('/transport/authorizations');
    expect(list.body.rows).toEqual([expect.objectContaining({ associateId: s.kim.id, status: 'legacy' })]);
    expect(list.body.version).toBe(RIDE_AUTHORIZATION_VERSION);
  });

  it('withdrawing stops new bookings and new charges; a ride already taken is still owed', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const ride = (await book(s.kimAgent, s.store, s.stop)).body.ride;
    const withdrawn = await s.kimAgent.delete('/transport/me/authorization');
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.authorization).toMatchObject({ current: false, reason: expect.stringMatching(/withdrawn/) });
    expect((await s.kimAgent.delete('/transport/me/authorization')).body.error.code).toBe('already_withdrawn');
    expect((await book(s.kimAgent, s.store, s.stop)).body.error.code).toBe('authorization_required');

    // The ride already booked goes on a run and the driver marks it on
    // board — there is no authorization behind a charge any more, so the
    // fare is HELD: owed, never waived, and not taken until they sign.
    const run = await s.directorAgent.post('/transport/runs').send({
      vanId: s.van.id,
      driverUserId: s.driver.id,
      direction: 'TO_WORK',
      serviceDate: ride.serviceDate,
      departAt: inHours(19).toISOString(),
      rides: [{ rideId: ride.id, pickupAt: inHours(19.5).toISOString() }],
    });
    expect(run.status).toBe(201);
    const boarded = await s.driverAgent.post(`/transport/driver/rides/${ride.id}/board`);
    expect(boarded.status).toBe(200);
    expect(boarded.body.ride).toMatchObject({ status: 'BOARDED', owedCents: 500, authorized: false, waived: false, waiveKind: null, uncollectedCents: 0, heldForSignature: true });
    const report = await s.directorAgent.get(`/transport/charges?from=${ride.serviceDate}&to=${ride.serviceDate}`);
    expect(report.body.totals).toMatchObject({ unauthorizedCents: 500, waivedCents: 0 });
    // They're told, and they're on the list of people who still need to sign.
    const { flushPendingNotifications } = await import('../../lib/notify.js');
    await flushPendingNotifications();
    const note = await prisma.notification.findFirst({ where: { recipientUserId: s.kimUser.id, linkUrl: '/rides?sign=1' } });
    expect(note?.body).toMatch(/\$5\.00 ride today is held until you sign/);
    const missing = await s.directorAgent.get('/transport/authorizations/missing');
    expect(missing.body.people).toEqual([expect.objectContaining({ associateId: s.kim.id, heldCents: 500, heldRides: 1, nextRideAt: null })]);

    const list = await s.directorAgent.get('/transport/authorizations');
    expect(list.body.rows[0]).toMatchObject({ associateId: s.kim.id, status: 'withdrawn' });

    // Signing again releases it to payroll, stamped with the new signature.
    await sign(s.kimAgent);
    const after = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    const consent = await prisma.rideConsent.findUniqueOrThrow({ where: { associateId: s.kim.id } });
    expect(after).toMatchObject({ chargeCents: 500, waivedAt: null, authorizedSignatureId: consent.signatureId });
    expect((await s.directorAgent.get('/transport/authorizations/missing')).body.people).toEqual([]);
  });

  it('a charge taken under a current authorization is stamped with the signature', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const ride = (await book(s.kimAgent, s.store, s.stop)).body.ride;
    await s.directorAgent.post('/transport/runs').send({
      vanId: s.van.id,
      driverUserId: s.driver.id,
      direction: 'TO_WORK',
      serviceDate: ride.serviceDate,
      departAt: inHours(19).toISOString(),
      rides: [{ rideId: ride.id, pickupAt: inHours(19.5).toISOString() }],
    });
    const boarded = await s.driverAgent.post(`/transport/driver/rides/${ride.id}/board`);
    expect(boarded.body.ride).toMatchObject({ status: 'BOARDED', owedCents: 500, authorized: true });
    const consent = await prisma.rideConsent.findUniqueOrThrow({ where: { associateId: s.kim.id } });
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).authorizedSignatureId).toBe(consent.signatureId);
    // Undo clears the stamp and is audited.
    const undone = await s.driverAgent.post(`/transport/driver/rides/${ride.id}/undo`);
    expect(undone.body.ride).toMatchObject({ status: 'SCHEDULED', owedCents: 0, authorized: false });
    await flushPendingAudits();
    expect(await prisma.auditLog.findFirst({ where: { action: 'transport.mark_undone', entityId: ride.id } })).not.toBeNull();
  });
});

describe('the configurable rate', () => {
  it('is effective-dated: a change never reprices a past ride and asks every rider to sign again', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const before = (await book(s.kimAgent, s.store, s.stop)).body.ride;
    expect(before).toMatchObject({ fareCents: 500, noShowFeeCents: 100 });

    const settings = await s.directorAgent.get('/transport/settings');
    expect(settings.body.rates).toHaveLength(1);
    expect(settings.body.rates[0]).toMatchObject({ fareCents: 500, noShowFeeCents: 100, effectiveTo: null });

    const changed = await s.directorAgent
      .put('/transport/settings')
      .send({ fareCents: 600, noShowFeeCents: 150, cutoffHours: 10 });
    expect(changed.status).toBe(200);
    expect(changed.body.settings).toMatchObject({ fareCents: 600, noShowFeeCents: 150 });
    expect(changed.body.rates).toHaveLength(2);
    expect(changed.body.rates[0]).toMatchObject({ fareCents: 600, effectiveFrom: ymd(new Date()), effectiveTo: null });
    expect(changed.body.rates[1]).toMatchObject({ fareCents: 500, effectiveTo: ymd(new Date(Date.now() - 86_400_000)) });
    // The settings row mirrors the rate in force.
    expect(await prisma.transportSettings.findUniqueOrThrow({ where: { tenantId: '00000000-0000-4000-8000-000000000001' } })).toMatchObject({ fareCents: 600, noShowFeeCents: 150 });
    // The ride booked at the old rate keeps it.
    expect(await prisma.ride.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ fareCents: 500, noShowFeeCents: 100 });

    // Kim's signature names $5/$1: not current any more.
    const me = await s.kimAgent.get('/transport/me');
    expect(me.body.authorization).toMatchObject({ current: false, reason: expect.stringMatching(/rate went up/), fareCents: 500 });
    expect(me.body.authorization.agreement).toMatchObject({ fareCents: 600, noShowFeeCents: 150 });
    expect((await book(s.kimAgent, s.store, s.stop)).body.error.code).toBe('authorization_required');
    expect((await s.directorAgent.get('/transport/authorizations')).body.rows[0]).toMatchObject({ status: 'outdated' });

    // Signing again names the new rate; the next ride is priced at it.
    expect((await sign(s.kimAgent)).body.authorization).toMatchObject({ current: true, fareCents: 600, noShowFeeCents: 150 });
    // A different time: the first booking is still open.
    const after = (await book(s.kimAgent, s.store, s.stop, 44)).body.ride;
    expect(after).toMatchObject({ fareCents: 600, noShowFeeCents: 150 });

    // Only an unchanged rate leaves the history alone.
    const same = await s.directorAgent.put('/transport/settings').send({ fareCents: 600, noShowFeeCents: 150, cutoffHours: 12 });
    expect(same.body.rates).toHaveLength(2);
    expect(same.body.settings.cutoffHours).toBe(12);
  });

  it('history is never rewritten: a rate cannot start before the one in force; a future rate waits its day', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const past = await s.directorAgent
      .put('/transport/settings')
      .send({ fareCents: 400, noShowFeeCents: 100, cutoffHours: 10, effectiveFrom: '2020-01-01' });
    expect(past.status).toBe(409);
    expect(past.body.error.code).toBe('rate_history');

    const nextWeek = ymd(new Date(Date.now() + 7 * 86_400_000));
    const future = await s.directorAgent
      .put('/transport/settings')
      .send({ fareCents: 700, noShowFeeCents: 200, cutoffHours: 10, effectiveFrom: nextWeek });
    expect(future.status).toBe(200);
    // Today's rate is still $5/$1, so Kim's signature still holds.
    expect(future.body.settings).toMatchObject({ fareCents: 500, noShowFeeCents: 100 });
    expect((await rideRateOn(prisma))?.fareCents).toBe(500);
    expect((await rideRateOn(prisma, new Date(Date.now() + 8 * 86_400_000)))?.fareCents).toBe(700);
    expect((await s.kimAgent.get('/transport/me')).body.authorization.current).toBe(true);

    // Same-day change replaces that day's rate instead of stacking one.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await setRideRate(prisma, { fareCents: 750, noShowFeeCents: 200, effectiveFrom: nextWeek }, hr.id);
    const rates = await prisma.transportRate.findMany({ orderBy: { effectiveFrom: 'asc' } });
    expect(rates.map((r) => r.fareCents)).toEqual([500, 750]);
  });

  it('authorizationCovers: the signature, the version, the withdrawal, the timing and the rate all have to line up', () => {
    const on = new Date('2026-05-01T12:00:00.000Z');
    const good = {
      signatureId: 'sig',
      withdrawnAt: null,
      version: RIDE_AUTHORIZATION_VERSION,
      fareCents: 500,
      noShowFeeCents: 100,
      acceptedAt: new Date('2026-04-01T00:00:00.000Z'),
    };
    const rate = { fareCents: 500, noShowFeeCents: 100 };
    expect(authorizationCovers(good, rate, on)).toEqual({ ok: true, reason: null });
    expect(authorizationCovers(null, rate, on).ok).toBe(false);
    expect(authorizationCovers({ ...good, signatureId: null }, rate, on).reason).toMatch(/No signed/);
    expect(authorizationCovers({ ...good, withdrawnAt: new Date('2026-04-15T00:00:00.000Z') }, rate, on).reason).toMatch(/withdrawn/);
    expect(authorizationCovers({ ...good, withdrawnAt: new Date('2026-05-02T00:00:00.000Z') }, rate, on).ok).toBe(true);
    expect(authorizationCovers({ ...good, version: RIDE_AUTHORIZATION_VERSION + 1 }, rate, on).reason).toMatch(/wording changed/);
    expect(authorizationCovers({ ...good, acceptedAt: new Date('2026-05-02T00:00:00.000Z') }, rate, on).reason).toMatch(/after/);
    expect(authorizationCovers(good, { fareCents: 600, noShowFeeCents: 100 }, on).reason).toMatch(/rate went up/);
    expect(authorizationCovers(good, { fareCents: 500, noShowFeeCents: 150 }, on).reason).toMatch(/rate went up/);
    // A signature covers any fare up to the one signed for: a lower fare (or a free ride) is still covered.
    expect(authorizationCovers(good, { fareCents: 400, noShowFeeCents: 100 }, on)).toEqual({ ok: true, reason: null });
    expect(authorizationCovers(good, { fareCents: 0, noShowFeeCents: 0 }, on).ok).toBe(true);
    expect(authorizationCovers(good, null, on).reason).toMatch(/No ride rate/);
  });
});

describe('rides that would go uncharged', () => {
  it('a ride is booked at the rate in force on its day, and shows it needs a new signature', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const inTenDays = ymd(new Date(Date.now() + 10 * 86_400_000));
    await s.directorAgent.put('/transport/settings').send({ fareCents: 700, noShowFeeCents: 200, cutoffHours: 10, effectiveFrom: inTenDays });
    // Booked today for a day after the increase: the new fare, which Kim's $5 signature doesn't cover.
    const later = (await book(s.kimAgent, s.store, s.stop, 12 * 24)).body.ride;
    expect(later).toMatchObject({ fareCents: 700, noShowFeeCents: 200 });
    const soon = (await book(s.kimAgent, s.store, s.stop)).body.ride;
    expect(soon).toMatchObject({ fareCents: 500 });
    const rides = (await s.directorAgent.get('/transport/rides')).body.rides as Array<{ id: string; signatureNeeded: string | null }>;
    expect(rides.find((r) => r.id === later.id)?.signatureNeeded).toMatch(/rate went up/);
    expect(rides.find((r) => r.id === soon.id)?.signatureNeeded).toBeNull();
  });

  it('transportation sees who still has to sign, the driver sees it on the manifest, and reminders go once a day', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const ride = (await book(s.kimAgent, s.store, s.stop)).body.ride;
    await s.kimAgent.delete('/transport/me/authorization');
    await s.directorAgent.post('/transport/runs').send({
      vanId: s.van.id,
      driverUserId: s.driver.id,
      direction: 'TO_WORK',
      serviceDate: ride.serviceDate,
      departAt: inHours(19).toISOString(),
      rides: [{ rideId: ride.id, pickupAt: inHours(19.5).toISOString() }],
    });
    const missing = await s.directorAgent.get('/transport/authorizations/missing');
    expect(missing.status).toBe(200);
    expect(missing.body.people).toEqual([expect.objectContaining({ associateId: s.kim.id, rides: 1, atRiskCents: 500, canNotify: true, reason: expect.stringMatching(/withdrawn/) })]);

    const manifest = await s.driverAgent.get('/transport/driver/runs');
    const onRun = manifest.body.runs.flatMap((r: { rides: Array<{ id: string; signatureNeeded: string | null }> }) => r.rides).find((r: { id: string }) => r.id === ride.id);
    expect(onRun.signatureNeeded).toMatch(/withdrawn/);

    expect((await s.directorAgent.post('/transport/authorizations/remind').send({})).body).toEqual({ sent: 1, skipped: 0 });
    // Wait for the reminder to land, then a second ask the same day is skipped.
    const { flushPendingNotifications } = await import('../../lib/notify.js');
    await flushPendingNotifications();
    expect((await s.directorAgent.post('/transport/authorizations/remind').send({})).body).toEqual({ sent: 0, skipped: 1 });
    const note = await prisma.notification.findFirst({ where: { recipientUserId: s.kimUser.id, linkUrl: '/rides?sign=1' } });
    expect(note?.subject).toBe('Sign your ride authorization');

    // A driver can't send reminders.
    expect((await s.driverAgent.post('/transport/authorizations/remind').send({})).status).toBe(403);
  });

  it('a ride taken can’t be waived; a no-show fee can, and the waiver can be undone', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const ride = (await book(s.kimAgent, s.store, s.stop)).body.ride;
    await s.directorAgent.post('/transport/runs').send({
      vanId: s.van.id,
      driverUserId: s.driver.id,
      direction: 'TO_WORK',
      serviceDate: ride.serviceDate,
      departAt: inHours(19).toISOString(),
      rides: [{ rideId: ride.id, pickupAt: inHours(19.5).toISOString() }],
    });
    await s.driverAgent.post(`/transport/driver/rides/${ride.id}/board`);
    const refused = await s.directorAgent.post(`/transport/rides/${ride.id}/waive`).send({ reason: 'The van was 20 minutes late.' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ride_taken');
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).waivedAt).toBeNull();

    // A no-show fee (the rider wasn't there) is the director's to waive.
    const consent = await prisma.rideConsent.findUniqueOrThrow({ where: { associateId: s.kim.id } });
    const missed = (await book(s.kimAgent, s.store, s.stop, 30)).body.ride;
    await prisma.ride.update({ where: { id: missed.id }, data: { status: 'NO_SHOW', noShowAt: new Date(), chargeCents: 100, authorizedSignatureId: consent.signatureId } });
    expect((await s.directorAgent.post(`/transport/rides/${missed.id}/waive`).send({ reason: 'Their shift was cancelled.' })).status).toBe(200);
    expect(await prisma.ride.findUniqueOrThrow({ where: { id: missed.id } })).toMatchObject({ waiveKind: 'MANAGER', uncollectedCents: 0 });
    const report = await s.directorAgent.get(`/transport/charges?from=${missed.serviceDate}&to=${missed.serviceDate}`);
    expect(report.body.totals).toMatchObject({ waivedCents: 100 });

    // Undone: owed again, the rider told; only transportation can do it.
    expect((await s.driverAgent.post(`/transport/rides/${missed.id}/unwaive`).send({ reason: 'Waived by mistake.' })).status).toBe(403);
    const undone = await s.directorAgent.post(`/transport/rides/${missed.id}/unwaive`).send({ reason: 'Waived by mistake.' });
    expect(undone.status).toBe(200);
    expect(undone.body.ride).toMatchObject({ waived: false, waiveKind: null, owedCents: 100, authorized: true, heldForSignature: false });
    expect((await s.directorAgent.post(`/transport/rides/${missed.id}/unwaive`).send({ reason: 'Again.' })).body.error.code).toBe('not_waived');
    const { flushPendingAudits } = await import('../../lib/audit.js');
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'transport.waiver_undone', entityId: missed.id } })).toBe(1);
  });

  it('a taken ride left uncharged under the old rule comes back held when the waiver is undone', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const ride = (await book(s.kimAgent, s.store, s.stop)).body.ride;
    // How the old rule left it: boarded, uncharged, "not authorized".
    await prisma.ride.update({ where: { id: ride.id }, data: { status: 'COMPLETED', boardedAt: new Date(), chargeCents: 0, uncollectedCents: 500, waivedAt: new Date(), waiveKind: 'NOT_AUTHORIZED', waiveReason: 'Not charged: No signed authorization on file.' } });
    const undone = await s.directorAgent.post(`/transport/rides/${ride.id}/unwaive`).send({ reason: 'A ride taken is always owed.' });
    expect(undone.status).toBe(200);
    // Kim's authorization is current, so it covers the fare at once.
    expect(undone.body.ride).toMatchObject({ owedCents: 500, uncollectedCents: 0, waived: false, authorized: true, heldForSignature: false });
  });

  it('…and without a current authorization it waits, held, for the next signature', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const ride = (await book(s.kimAgent, s.store, s.stop)).body.ride;
    await s.kimAgent.delete('/transport/me/authorization');
    await prisma.ride.update({ where: { id: ride.id }, data: { status: 'COMPLETED', boardedAt: new Date(), chargeCents: 0, uncollectedCents: 500, waivedAt: new Date(), waiveKind: 'NOT_AUTHORIZED' } });
    const undone = await s.directorAgent.post(`/transport/rides/${ride.id}/unwaive`).send({ reason: 'A ride taken is always owed.' });
    expect(undone.body.ride).toMatchObject({ owedCents: 500, authorized: false, heldForSignature: true });
    await sign(s.kimAgent);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } })).authorizedSignatureId).not.toBeNull();
  });

  it('an uncharged no-show stays uncharged — a fee is never held', async () => {
    const s = await seed();
    await sign(s.kimAgent);
    const ride = (await book(s.kimAgent, s.store, s.stop)).body.ride;
    await prisma.ride.update({ where: { id: ride.id }, data: { status: 'NO_SHOW', noShowAt: new Date(), chargeCents: 0, uncollectedCents: 100, waivedAt: new Date(), waiveKind: 'NOT_AUTHORIZED' } });
    const res = await s.directorAgent.post(`/transport/rides/${ride.id}/unwaive`).send({ reason: 'Should be charged.' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_show_not_authorized');
  });
});
