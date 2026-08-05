import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { signSession } from '../../lib/jwt.js';
import {
  generateDeviceToken,
  hashDeviceToken,
  hmacPin,
} from '../../lib/kioskAuth.js';
import {
  _resetKioskRateLimit,
  enforcePunchRateLimit,
} from '../../lib/kioskRateLimit.js';
import {
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

async function adminCookie(): Promise<string> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const token = signSession({
    sub: user.id,
    role: user.role,
    ver: user.tokenVersion,
  });
  return `alto.session=${token}`;
}

// Fence center + radius shared by fixtures and requests.
const FENCE = { lat: 40.7128, lng: -74.006, radius: 150 };
// ~5.5km north of the fence center — comfortably outside.
const OUTSIDE = { lat: 40.7628, lng: -74.006 };

/**
 * Minimal kiosk fixture: a client (createClient gives it a default
 * Location), one associate with a known employee number, and one paired
 * device. Mirrors what POST /kiosk-devices and POST /kiosk-pins create,
 * without dragging an authed admin session into every test.
 */
async function setupKiosk(opts: { geofence?: boolean } = {}) {
  const client = await createClient();
  const location = await prisma.location.findFirstOrThrow({
    where: { clientId: client.id },
  });
  if (opts.geofence) {
    await prisma.location.update({
      where: { id: location.id },
      data: {
        latitude: FENCE.lat,
        longitude: FENCE.lng,
        geofenceRadiusMeters: FENCE.radius,
      },
    });
  }
  const associate = await createAssociate();
  const pin = '4321';
  await prisma.kioskPin.create({
    data: {
      clientId: client.id,
      associateId: associate.id,
      pinHmac: hmacPin(pin),
    },
  });
  const { plaintext, prefix } = generateDeviceToken();
  await prisma.kioskDevice.create({
    data: {
      clientId: client.id,
      locationId: location.id,
      name: 'Test kiosk',
      tokenHash: hashDeviceToken(plaintext),
      tokenPrefix: prefix,
      tokenExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    },
  });
  return { deviceToken: plaintext, pin, associate };
}

beforeEach(async () => {
  await truncateAll();
  // The throttle store is per-process and would leak stamps across tests.
  _resetKioskRateLimit();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /kiosk/verify-pin', () => {
  it('verifies without coordinates on a geofenced kiosk (advisory fence never blocks the preflight)', async () => {
    // Regression: this used to throw location_required, and the tablet's
    // instant retry then tripped the 1s throttle — "Slow down — one punch
    // per second per kiosk." on every attempt, locking whole sites out.
    const { deviceToken, pin } = await setupKiosk({ geofence: true });

    const res = await request(app())
      .post('/kiosk/verify-pin')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Fresh associate, no open entry → the punch would clock them in.
    expect(res.body.associateFirstName).toBe('Test');
    expect(res.body.predictedAction).toBe('CLOCK_IN');
  });

  it('rejects a break toggle at the keypad when the associate is not clocked in', async () => {
    const { deviceToken, pin } = await setupKiosk();

    const res = await request(app())
      .post('/kiosk/verify-pin')
      .send({ deviceToken, pin, latitude: null, longitude: null, intent: 'BREAK' });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('not_clocked_in');
  });

  // The throttle itself is exercised at the lib level (below) rather than
  // over HTTP: with a remote test DB each request takes seconds, so two
  // sequential supertest calls never actually land inside the 1s window.
  it('throttle: a second hit on the same device+bucket inside 1s throws 429', () => {
    enforcePunchRateLimit('device-1', 'preflight');
    expect(() => enforcePunchRateLimit('device-1', 'preflight')).toThrowError(
      /one punch per second/i,
    );
    // Separate buckets and separate devices are independent.
    expect(() => enforcePunchRateLimit('device-1', 'punch')).not.toThrow();
    expect(() => enforcePunchRateLimit('device-2', 'preflight')).not.toThrow();
  });
});

describe('POST /kiosk/punch — advisory geofence', () => {
  it('accepts an out-of-fence punch and flags it GEOFENCE for review', async () => {
    const { deviceToken, pin } = await setupKiosk({ geofence: true });

    const res = await request(app()).post('/kiosk/punch').send({
      deviceToken,
      pin,
      latitude: OUTSIDE.lat,
      longitude: OUTSIDE.lng,
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('CLOCK_IN');

    const punch = await prisma.kioskPunch.findUniqueOrThrow({
      where: { id: res.body.punchId },
    });
    expect(punch.anomalyKind).toBe('GEOFENCE');
    expect(punch.reviewStatus).toBe('PENDING');
    expect(punch.distanceMeters).toBeGreaterThan(FENCE.radius);
  });

  it('accepts a coordinate-less punch on a geofenced kiosk without flagging it', async () => {
    const { deviceToken, pin } = await setupKiosk({ geofence: true });

    const res = await request(app()).post('/kiosk/punch').send({
      deviceToken,
      pin,
      latitude: null,
      longitude: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('CLOCK_IN');

    const punch = await prisma.kioskPunch.findUniqueOrThrow({
      where: { id: res.body.punchId },
    });
    expect(punch.anomalyKind).toBeNull();
    expect(punch.distanceMeters).toBeNull();
  });

  it('records distance but no anomaly for an in-fence punch', async () => {
    const { deviceToken, pin } = await setupKiosk({ geofence: true });

    const res = await request(app()).post('/kiosk/punch').send({
      deviceToken,
      pin,
      latitude: FENCE.lat,
      longitude: FENCE.lng,
    });
    expect(res.status).toBe(200);

    const punch = await prisma.kioskPunch.findUniqueOrThrow({
      where: { id: res.body.punchId },
    });
    expect(punch.anomalyKind).toBeNull();
    expect(punch.distanceMeters).not.toBeNull();
    expect(Number(punch.distanceMeters)).toBeLessThanOrEqual(FENCE.radius);
  });
});

describe('face consent + first-enrollment review', () => {
  const DESCRIPTOR = Array.from({ length: 128 }, (_, i) => (i % 7) / 10);

  it('asks once, records the decision, and gates descriptor processing on GRANTED', async () => {
    const { deviceToken, pin, associate } = await setupKiosk();

    // Never asked → preflight says so.
    const before = await request(app())
      .post('/kiosk/verify-pin')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(before.body.faceConsent).toBeNull();

    // Punch WITH a descriptor while unasked → biometrics must NOT be
    // processed (no reference enrolled), punch itself succeeds.
    _resetKioskRateLimit();
    const punch1 = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, faceDescriptor: DESCRIPTOR });
    expect(punch1.status).toBe(200);
    expect(
      await prisma.kioskFaceReference.findUnique({
        where: { associateId: associate.id },
      }),
    ).toBeNull();

    // Grant consent.
    const grant = await request(app())
      .post('/kiosk/face-consent')
      .send({ deviceToken, pin, consent: true });
    expect(grant.status).toBe(200);
    expect(grant.body.status).toBe('GRANTED');

    // Now a descriptor punch enrolls — and the enrolling punch lands in
    // the review queue as FACE_ENROLLMENT (trust-on-first-use guard).
    _resetKioskRateLimit();
    const punch2 = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, faceDescriptor: DESCRIPTOR });
    expect(punch2.status).toBe(200);
    expect(
      await prisma.kioskFaceReference.findUnique({
        where: { associateId: associate.id },
      }),
    ).not.toBeNull();
    const enrolled = await prisma.kioskPunch.findUniqueOrThrow({
      where: { id: punch2.body.punchId },
    });
    expect(enrolled.anomalyKind).toBe('FACE_ENROLLMENT');
    expect(enrolled.reviewStatus).toBe('PENDING');

    // Declining later scrubs the stored biometrics immediately.
    const decline = await request(app())
      .post('/kiosk/face-consent')
      .send({ deviceToken, pin, consent: false });
    expect(decline.body.status).toBe('DECLINED');
    expect(
      await prisma.kioskFaceReference.findUnique({
        where: { associateId: associate.id },
      }),
    ).toBeNull();
    const row = await prisma.associate.findUniqueOrThrow({
      where: { id: associate.id },
      select: { faceConsentStatus: true, faceConsentAt: true },
    });
    expect(row.faceConsentStatus).toBe('DECLINED');
    expect(row.faceConsentAt).not.toBeNull();
  });
});

describe('POST /kiosk/punch — inferred break-end', () => {
  it('a toggle-less punch during an open break ends the break instead of clocking out', async () => {
    const { deviceToken, pin } = await setupKiosk();
    const punchOnce = (intent: 'BREAK' | null) => {
      // The 1s/device throttle is real on this device; tests punch
      // back-to-back, so clear it between punches.
      _resetKioskRateLimit();
      return request(app()).post('/kiosk/punch').send({ deviceToken, pin, intent });
    };

    const clockIn = await punchOnce(null);
    expect(clockIn.body.action).toBe('CLOCK_IN');

    const breakStart = await punchOnce('BREAK');
    expect(breakStart.body.action).toBe('BREAK_START');

    // Preflight now predicts the inferred break-end, so the camera
    // screen says "Ending your break" before the punch happens.
    _resetKioskRateLimit();
    const preflight = await request(app())
      .post('/kiosk/verify-pin')
      .send({ deviceToken, pin, latitude: null, longitude: null });
    expect(preflight.body.predictedAction).toBe('BREAK_END');

    // The forgotten-toggle punch: used to silently CLOCK_OUT (rest of
    // the shift unpaid); now reads as "I'm back from break".
    const back = await punchOnce(null);
    expect(back.body.action).toBe('BREAK_END');

    // The entry is still ACTIVE and a further punch clocks out normally.
    const out = await punchOnce(null);
    expect(out.body.action).toBe('CLOCK_OUT');
  });
});

describe('admin face-consent + enrollment-rejection cleanup', () => {
  const DESCRIPTOR = Array.from({ length: 128 }, (_, i) => (i % 7) / 10);

  it('rejecting the enrolling punch deletes the face reference it created', async () => {
    const { deviceToken, pin, associate } = await setupKiosk();
    const cookie = await adminCookie();

    await request(app())
      .post('/kiosk/face-consent')
      .send({ deviceToken, pin, consent: true });

    _resetKioskRateLimit();
    const punch = await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, faceDescriptor: DESCRIPTOR });
    expect(punch.status).toBe(200);
    expect(
      await prisma.kioskFaceReference.findUnique({
        where: { associateId: associate.id },
      }),
    ).not.toBeNull();

    // Admin rejects the FACE_ENROLLMENT punch → template must die with
    // it (the reviewer just said "that selfie isn't this associate").
    const review = await request(app())
      .post(`/kiosk-punches/${punch.body.punchId}/review`)
      .set('Cookie', [cookie])
      .send({ decision: 'REJECTED', notes: 'not the associate' });
    expect(review.status).toBe(200);
    expect(
      await prisma.kioskFaceReference.findUnique({
        where: { associateId: associate.id },
      }),
    ).toBeNull();
  });

  it('admin RESET re-asks at next punch; DECLINE records opt-out and scrubs biometrics', async () => {
    const { deviceToken, pin, associate } = await setupKiosk();
    const cookie = await adminCookie();

    // Associate grants at the kiosk and enrolls.
    await request(app())
      .post('/kiosk/face-consent')
      .send({ deviceToken, pin, consent: true });
    _resetKioskRateLimit();
    await request(app())
      .post('/kiosk/punch')
      .send({ deviceToken, pin, faceDescriptor: DESCRIPTOR });

    // Consent is visible on the pins list.
    const pinRow = await prisma.kioskPin.findFirstOrThrow({
      where: { associateId: associate.id },
      select: { id: true },
    });
    const list = await request(app())
      .get('/kiosk-pins')
      .set('Cookie', [cookie]);
    const listed = (list.body.pins as Array<{ id: string; faceConsentStatus: string | null }>).find(
      (p) => p.id === pinRow.id,
    );
    expect(listed?.faceConsentStatus).toBe('GRANTED');

    // RESET → null, so the kiosk asks again. Biometrics stay (they were
    // collected under a valid grant; only DECLINE revokes).
    const reset = await request(app())
      .post(`/kiosk-pins/${pinRow.id}/face-consent`)
      .set('Cookie', [cookie])
      .send({ action: 'RESET' });
    expect(reset.body.faceConsentStatus).toBeNull();
    expect(
      (
        await prisma.associate.findUniqueOrThrow({
          where: { id: associate.id },
          select: { faceConsentStatus: true },
        })
      ).faceConsentStatus,
    ).toBeNull();

    // DECLINE → recorded + face reference scrubbed.
    const decline = await request(app())
      .post(`/kiosk-pins/${pinRow.id}/face-consent`)
      .set('Cookie', [cookie])
      .send({ action: 'DECLINE' });
    expect(decline.body.faceConsentStatus).toBe('DECLINED');
    expect(
      await prisma.kioskFaceReference.findUnique({
        where: { associateId: associate.id },
      }),
    ).toBeNull();
  });
});

describe('POST /kiosk/punch — out-of-window replays leave a trace', () => {
  // The offline queue treats 4xx as permanent and drops the item, so this
  // REJECTED row is the ONLY record that someone stood at a kiosk and
  // punched. It used to not exist: the validation ran before the device
  // was even resolved, and hours someone worked vanished with no trace on
  // either side for HR to act on.
  it('records a REJECTED punch for a too-old queued replay', async () => {
    const { deviceToken, pin } = await setupKiosk();
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 3600 * 1000,
    ).toISOString();

    const res = await request(app()).post('/kiosk/punch').send({
      deviceToken,
      pin,
      selfie: null,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      clientPunchedAt: eightDaysAgo,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('punch_too_old');

    const rejected = await prisma.kioskPunch.findFirst({
      where: { action: 'REJECTED', rejectReason: 'punch_too_old' },
    });
    expect(rejected).toBeTruthy();
    expect(rejected!.idempotencyKey).toBe(
      '11111111-1111-4111-8111-111111111111',
    );

    // The replay of the same item now short-circuits on the idempotency
    // key as previously_rejected — exactly one rejection row, and the
    // queue can drop the item knowing the server has the record.
    const replay = await request(app()).post('/kiosk/punch').send({
      deviceToken,
      pin,
      selfie: null,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      clientPunchedAt: eightDaysAgo,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('previously_rejected');
    expect(
      await prisma.kioskPunch.count({ where: { action: 'REJECTED' } }),
    ).toBe(1);
  });

  it('records a REJECTED punch for a future-dated clock-skew replay', async () => {
    const { deviceToken, pin } = await setupKiosk();

    const res = await request(app()).post('/kiosk/punch').send({
      deviceToken,
      pin,
      selfie: null,
      clientPunchedAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('clock_skew');
    expect(
      await prisma.kioskPunch.findFirst({
        where: { action: 'REJECTED', rejectReason: 'clock_skew' },
      }),
    ).toBeTruthy();
  });
});

describe('POST /kiosk/punch — selfie storage requires recorded consent', () => {
  // decodeSelfie rejects anything under 500 decoded bytes as junk
  // (selfie_too_small), so the fixture must be a plausible size — a JPEG
  // SOI header padded past the floor. (The first version of this test used
  // a ~50-byte snippet and got 400 before the consent logic ever ran.)
  const JPEG =
    'data:image/jpeg;base64,' +
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(600, 1),
    ]).toString('base64');

  // The gate used to be `DECLINED ? null : selfie`, which stored photos
  // for the never-asked (null) state — reachable offline, where the tablet
  // can't show the consent screen before queueing a selfie. The consent
  // copy promises photos are part of what's consented to, so null must
  // behave like DECLINED.
  it('does NOT store a selfie when consent was never asked', async () => {
    const { deviceToken, pin } = await setupKiosk();

    const res = await request(app()).post('/kiosk/punch').send({
      deviceToken,
      pin,
      selfie: JPEG,
    });
    expect(res.status).toBe(200);

    const punch = await prisma.kioskPunch.findFirst({
      where: { action: 'CLOCK_IN' },
      select: { selfie: true },
    });
    expect(punch!.selfie).toBeNull();
  });

  it('stores the selfie once consent is GRANTED', async () => {
    const { deviceToken, pin, associate } = await setupKiosk();
    await prisma.associate.update({
      where: { id: associate.id },
      data: { faceConsentStatus: 'GRANTED' },
    });

    const res = await request(app()).post('/kiosk/punch').send({
      deviceToken,
      pin,
      selfie: JPEG,
    });
    expect(res.status).toBe(200);

    const punch = await prisma.kioskPunch.findFirst({
      where: { action: 'CLOCK_IN' },
      select: { selfie: true },
    });
    expect(punch!.selfie).not.toBeNull();
  });
});
