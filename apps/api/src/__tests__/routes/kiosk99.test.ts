import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
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
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

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
