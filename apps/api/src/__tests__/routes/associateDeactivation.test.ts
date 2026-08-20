import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  generateDeviceToken,
  hashDeviceToken,
  hmacPin,
} from '../../lib/kioskAuth.js';
import { _resetKioskRateLimit } from '../../lib/kioskRateLimit.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Manual deactivate/reactivate — the temporary pause distinct from a
 * Separation. One transaction takes the associate out of circulation
 * (login DISABLED, future shifts released, claims expired, kiosk
 * clock-ins rejected, out of the schedulable pool, directory INACTIVE);
 * Reactivate restores everything with the record intact. Plus the new
 * audit-packet workforce scopes that keep active and inactive rosters
 * from ever mixing.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  _resetKioskRateLimit();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a
    .post('/auth/login')
    .send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status}`);
  }
  return a;
}

/** Hired associate: APPROVED application + linked ACTIVE login. */
async function mkHired(clientId: string, firstName: string, lastName: string) {
  const associate = await createAssociate({ firstName, lastName });
  await prisma.application.create({
    data: {
      associateId: associate.id,
      clientId,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
      approvedAt: new Date('2026-01-15T00:00:00Z'),
    },
  });
  const { user } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  return { associate, user };
}

const zipParse = (r: request.Response & NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (c: Buffer) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('POST /org/associates/:id/deactivate + reactivate', () => {
  it('pauses everything in one transaction and reactivates cleanly', async () => {
    const client = await createClient();
    const { associate, user } = await mkHired(client.id, 'Paula', 'Pause');
    // A future assigned shift (must be released) and a pending claim on
    // an open shift (must expire).
    const future = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Associate',
        startsAt: new Date(Date.now() + 48 * 3600_000),
        endsAt: new Date(Date.now() + 56 * 3600_000),
        status: 'ASSIGNED',
        assignedAssociateId: associate.id,
      },
    });
    const open = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Associate',
        startsAt: new Date(Date.now() + 72 * 3600_000),
        endsAt: new Date(Date.now() + 80 * 3600_000),
        status: 'OPEN',
      },
    });
    const claim = await prisma.openShiftClaim.create({
      data: { shiftId: open.id, associateId: associate.id },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const res = await hrAgent
      .post(`/org/associates/${associate.id}/deactivate`)
      .send({ reason: 'Personal leave — back in October.' });
    expect(res.status).toBe(200);
    expect(res.body.releasedShifts).toBe(1);
    expect(res.body.expiredClaims).toBe(1);
    expect(res.body.loginDisabled).toBe(true);

    const a1 = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(a1.deactivatedAt).not.toBeNull();
    expect(a1.deactivationReason).toBe('Personal leave — back in October.');
    const u1 = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u1.status).toBe('DISABLED');
    const s1 = await prisma.shift.findUniqueOrThrow({ where: { id: future.id } });
    expect(s1.status).toBe('OPEN');
    expect(s1.assignedAssociateId).toBeNull();
    const c1 = await prisma.openShiftClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(c1.status).toBe('EXPIRED');

    // Login is dead while paused.
    const dead = await request(app())
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(dead.status).toBe(401);

    // Directory: INACTIVE with the pause visible, despite the approved app.
    const dir1 = await hrAgent.get('/people/directory');
    const row1 = dir1.body.associates.find(
      (x: { id: string }) => x.id === associate.id,
    );
    expect(row1.status).toBe('INACTIVE');
    expect(row1.deactivatedAt).not.toBeNull();
    expect(row1.deactivationReason).toBe('Personal leave — back in October.');

    // Out of the schedulable pool.
    const pool1 = await hrAgent.get('/scheduling/associates');
    expect(pool1.status).toBe(200);
    expect(JSON.stringify(pool1.body)).not.toContain(associate.id);

    // Reactivate: one click, everything back, no re-onboarding.
    const back = await hrAgent.post(`/org/associates/${associate.id}/reactivate`);
    expect(back.status).toBe(200);
    const a2 = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(a2.deactivatedAt).toBeNull();
    expect(a2.deactivationReason).toBeNull();
    const u2 = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u2.status).toBe('ACTIVE');

    const alive = await request(app())
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(alive.status).toBe(200);

    const dir2 = await hrAgent.get('/people/directory');
    const row2 = dir2.body.associates.find(
      (x: { id: string }) => x.id === associate.id,
    );
    expect(row2.status).toBe('ACTIVE');
    const pool2 = await hrAgent.get('/scheduling/associates');
    expect(JSON.stringify(pool2.body)).toContain(associate.id);
  });

  it('409s on double-deactivate, reactivating a non-paused associate, and separated associates', async () => {
    const client = await createClient();
    const { associate } = await mkHired(client.id, 'Twice', 'Paused');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const not = await hrAgent.post(`/org/associates/${associate.id}/reactivate`);
    expect(not.status).toBe(409);
    expect(not.body.error.code).toBe('not_deactivated');

    const first = await hrAgent
      .post(`/org/associates/${associate.id}/deactivate`)
      .send({ reason: 'Leave of absence.' });
    expect(first.status).toBe(200);
    const twice = await hrAgent
      .post(`/org/associates/${associate.id}/deactivate`)
      .send({ reason: 'Leave of absence.' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('already_deactivated');

    const { associate: gone } = await mkHired(client.id, 'Sep', 'Arated');
    await prisma.associate.update({
      where: { id: gone.id },
      data: { separatedAt: new Date() },
    });
    const sep = await hrAgent
      .post(`/org/associates/${gone.id}/deactivate`)
      .send({ reason: 'Should not work.' });
    expect(sep.status).toBe(409);
    expect(sep.body.error.code).toBe('already_separated');
  });
});

describe('kiosk employment gate', () => {
  async function setupKiosk() {
    const client = await createClient();
    const location = await prisma.location.findFirstOrThrow({
      where: { clientId: client.id },
    });
    const associate = await createAssociate({ firstName: 'Badge', lastName: 'Holder' });
    const pin = '4455';
    await prisma.kioskPin.create({
      data: { clientId: client.id, associateId: associate.id, pinHmac: hmacPin(pin) },
    });
    const { plaintext, prefix } = generateDeviceToken();
    await prisma.kioskDevice.create({
      data: {
        clientId: client.id,
        locationId: location.id,
        name: 'Gate kiosk',
        tokenHash: hashDeviceToken(plaintext),
        tokenPrefix: prefix,
        tokenExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
      },
    });
    return { client, location, associate, pin, deviceToken: plaintext };
  }

  it('rejects a deactivated associate at both entry points, and separated ones too', async () => {
    const { associate, pin, deviceToken } = await setupKiosk();
    await prisma.associate.update({
      where: { id: associate.id },
      data: { deactivatedAt: new Date(), deactivationReason: 'Paused.' },
    });

    const pre = await request(app())
      .post('/kiosk/verify-pin')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(pre.status).toBe(403);
    expect(pre.body.error.code).toBe('inactive_associate');

    const punch = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(punch.status).toBe(403);
    expect(punch.body.error.code).toBe('inactive_associate');
    expect(
      await prisma.timeEntry.count({ where: { associateId: associate.id } }),
    ).toBe(0);
    const rejected = await prisma.kioskPunch.findMany({
      where: { action: 'REJECTED' },
    });
    expect(rejected.map((r) => r.rejectReason).sort()).toEqual([
      'associate_inactive',
      'associate_inactive_preflight',
    ]);

    // The pre-existing hole: a SEPARATED associate's PIN also stops working.
    // (Reset the one-punch-per-second device throttle first — this is the
    // second /kiosk/punch inside the same test.)
    _resetKioskRateLimit();
    await prisma.associate.update({
      where: { id: associate.id },
      data: { deactivatedAt: null, separatedAt: new Date() },
    });
    const sep = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(sep.status).toBe(403);
    expect(sep.body.error.code).toBe('inactive_associate');
  });

  it('still lets someone deactivated MID-SHIFT clock out', async () => {
    const { client, location, associate, pin, deviceToken } = await setupKiosk();
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        locationId: location.id,
        clockInAt: new Date(Date.now() - 4 * 3600_000),
        status: 'ACTIVE',
      },
    });
    await prisma.associate.update({
      where: { id: associate.id },
      data: { deactivatedAt: new Date(), deactivationReason: 'Paused mid-shift.' },
    });

    const punch = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(punch.status).toBe(200);
    const entry = await prisma.timeEntry.findFirstOrThrow({
      where: { associateId: associate.id },
    });
    expect(entry.clockOutAt).not.toBeNull();
  });
});

describe('audit packet workforce scopes', () => {
  it('ACTIVE_WORKFORCE and INACTIVE_WORKFORCE never mix rosters', async () => {
    const client = await createClient();
    const { associate: active } = await mkHired(client.id, 'Still', 'Here');
    const { associate: paused } = await mkHired(client.id, 'Cur', 'Rently-Out');
    await prisma.associate.update({
      where: { id: paused.id },
      data: { deactivatedAt: new Date(), deactivationReason: 'Seasonal break.' },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const gen = (scope: string) =>
      hrAgent
        .post('/audit-packets/generate')
        .send({
          scope,
          periodStart: '2026-01-01',
          periodEnd: '2026-06-30',
          reason: 'Workforce scope split verification — test run.',
        })
        .buffer(true)
        .parse(zipParse);

    const activeRes = await gen('ACTIVE_WORKFORCE');
    expect(activeRes.status).toBe(200);
    expect(activeRes.headers['content-type']).toContain('application/zip');
    const inactiveRes = await gen('INACTIVE_WORKFORCE');
    expect(inactiveRes.status).toBe(200);

    // The critical audit rows record the exact roster size per scope —
    // one worker each, never both in the same packet.
    const logs = await prisma.auditLog.findMany({
      where: { action: 'compliance.audit_packet_generated_workforce' },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs).toHaveLength(2);
    const meta = logs.map((l) => l.metadata as { scope: string; workerCount: number });
    expect(meta[0]).toMatchObject({ scope: 'ACTIVE_WORKFORCE', workerCount: 1 });
    expect(meta[1]).toMatchObject({ scope: 'INACTIVE_WORKFORCE', workerCount: 1 });
    // Sanity: the active associate is intact, the paused one is what
    // made the inactive roster non-empty.
    expect(active.id).not.toBe(paused.id);
  });

  it('counsel single-PDF packet covers only currently-employed workers', async () => {
    const client = await createClient('Walmart Destin');
    await mkHired(client.id, 'On', 'Roster');
    const { associate: paused } = await mkHired(client.id, 'Off', 'Roster');
    await prisma.associate.update({
      where: { id: paused.id },
      data: { deactivatedAt: new Date(), deactivationReason: 'Seasonal break.' },
    });
    // Never-approved associate with a worked-time tie to the client
    // (migrated punches). Used to leak into the I-9/E-Verify/background
    // sections through the evidence union despite not being ACTIVE.
    const unapproved = await createAssociate({ firstName: 'Not', lastName: 'Approved' });
    await prisma.application.create({
      data: {
        associateId: unapproved.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'SUBMITTED',
      },
    });
    const loc = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.timeEntry.create({
      data: {
        associateId: unapproved.id,
        clientId: client.id,
        locationId: loc.id,
        clockInAt: new Date('2026-02-03T14:00:00Z'),
        clockOutAt: new Date('2026-02-03T22:00:00Z'),
        status: 'COMPLETED',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent
      .post('/audit-packets/generate-counsel')
      .send({
        clientId: client.id,
        periodStart: '2026-01-01',
        periodEnd: '2026-06-30',
        reason: 'Counsel-format vendor audit response — test run.',
      })
      .buffer(true)
      .parse(zipParse);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'compliance.audit_packet_generated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.metadata).toMatchObject({
      scope: 'COUNSEL_CLIENT_PDF',
      workerCount: 1,
    });
  });
});
