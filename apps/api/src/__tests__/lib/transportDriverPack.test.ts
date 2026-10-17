import { afterEach, describe, expect, it } from 'vitest';
import { legDurations, optimizeOrder, routingAvailable, setRoutingForTests } from '../../lib/mapboxRouting.js';
import { planRun } from '../../lib/transportLive.js';
import { DRIFT_M, STALL_MINUTES, judgeTrouble, shareToken, verifyShareToken } from '../../lib/transportSafety.js';
import { PRE_TRIP_ITEMS, driverCredentialStatus, evaluatePreTrip } from '../../lib/transportDrivers.js';

/**
 * The pure parts of the driver pack: the road network's word on a route
 * (when it answers, and when it doesn't), the safety watch's judgement,
 * the pre-trip verdict, the credential check, and the share link.
 */

afterEach(() => setRoutingForTests(undefined));

const A = { lat: 30.2106, lng: -85.865 };
const B = { lat: 30.22, lng: -85.84 };
const STORE = { lat: 30.1766, lng: -85.8055 };

describe('routing', () => {
  it('is off under test unless a fake is injected, and answers null then', async () => {
    expect(routingAvailable()).toBe(false);
    expect(await legDurations([A, B])).toBeNull();
    expect(await optimizeOrder([A, B, STORE], { fixStart: true, fixEnd: true })).toBeNull();
  });

  it('remembers an answer for the same rounded coordinates', async () => {
    let calls = 0;
    setRoutingForTests(async (points) => {
      calls += 1;
      return { seconds: points.slice(1).map(() => 300), metres: points.slice(1).map(() => 2000) };
    });
    expect(routingAvailable()).toBe(true);
    expect((await legDurations([A, B, STORE]))?.seconds).toEqual([300, 300]);
    expect((await legDurations([{ lat: A.lat + 0.00001, lng: A.lng }, B, STORE]))?.seconds).toEqual([300, 300]);
    expect(calls).toBe(1);
  });

  it('the run plan uses road seconds per hop when given, and the estimate otherwise', () => {
    const base = {
      direction: 'TO_WORK' as const,
      van: A,
      now: new Date('2026-06-01T10:00:00Z'),
      rides: [{ id: 'r1', status: 'SCHEDULED', pickupOrder: 1, targetAt: new Date('2026-06-01T11:00:00Z'), locationId: 'l1', home: B }],
      stores: new Map([['l1', STORE]]),
    };
    const estimate = planRun(base);
    const road = planRun({ ...base, legSeconds: [60, 120] });
    const pickupEstimate = estimate.pickupEta.get('r1')!.getTime() - base.now.getTime();
    const pickupRoad = road.pickupEta.get('r1')!.getTime() - base.now.getTime();
    expect(pickupRoad).toBe(60_000);
    expect(pickupEstimate).toBeGreaterThan(60_000);
    // The store ETA: 60s drive + 60s dwell + 120s drive.
    expect(road.storeEta.get('l1')!.getTime() - base.now.getTime()).toBe(240_000);
  });
});

describe('the safety watch', () => {
  const now = new Date('2026-06-01T10:10:00Z');
  const still = (p: { lat: number; lng: number }, minutes: number[]) => minutes.map((m) => ({ ...p, at: new Date(now.getTime() - m * 60_000) }));
  const FAR_FROM_STOPS = { lat: 30.25, lng: -85.9 };

  it('a van still for the stall window away from any stop is stalled', () => {
    const j = judgeTrouble({ now, van: FAR_FROM_STOPS, pings: still(FAR_FROM_STOPS, [0, 2, 4, 6, STALL_MINUTES]), stops: [A, STORE], next: A, minDistToNextM: null });
    expect(j.trouble).toBe('stalled');
  });

  it('a van parked at a stop is not', () => {
    const j = judgeTrouble({ now, van: A, pings: still(A, [0, 2, 4, 6, STALL_MINUTES]), stops: [A, STORE], next: A, minDistToNextM: null });
    expect(j.trouble).toBeNull();
  });

  it('too few pings, or pings that only cover part of the window, say nothing', () => {
    expect(judgeTrouble({ now, van: FAR_FROM_STOPS, pings: still(FAR_FROM_STOPS, [0, 1]), stops: [A], next: A, minDistToNextM: null }).trouble).toBeNull();
    expect(judgeTrouble({ now, van: FAR_FROM_STOPS, pings: still(FAR_FROM_STOPS, [0, 1, 2, 3]), stops: [A], next: A, minDistToNextM: null }).trouble).toBeNull();
  });

  it('drifting far past the closest approach to the next stop is off route', () => {
    const j = judgeTrouble({ now, van: FAR_FROM_STOPS, pings: [], stops: [A], next: A, minDistToNextM: 500 });
    expect(j.distToNextM).toBeGreaterThan(500 + DRIFT_M);
    expect(j.trouble).toBe('off_route');
  });
});

describe('the pre-trip verdict', () => {
  const all = (ok: boolean) => PRE_TRIP_ITEMS.map((i) => ({ key: i.key, ok }));
  it('passes when every item is answered and every safety item is fine', () => {
    expect(evaluatePreTrip(all(true)).passed).toBe(true);
    const dirty = all(true).map((i) => (i.key === 'clean' ? { ...i, ok: false } : i));
    const v = evaluatePreTrip(dirty);
    expect(v.passed).toBe(true);
    expect(v.failed).toEqual(['clean']);
    expect(v.failedSafety).toEqual([]);
  });
  it('fails on a safety item or a missing answer', () => {
    const brakes = all(true).map((i) => (i.key === 'brakes' ? { ...i, ok: false } : i));
    expect(evaluatePreTrip(brakes)).toMatchObject({ passed: false, failedSafety: ['brakes'] });
    expect(evaluatePreTrip(all(true).slice(1))).toMatchObject({ passed: false, missing: ['tires'] });
  });
});

describe('driver credentials', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  it('a profile with no licence date is not current; a lapsed one says so; a near one is due soon', () => {
    expect(driverCredentialStatus(null, now).ok).toBe(false);
    expect(driverCredentialStatus({ licenceExpiresAt: new Date('2026-05-01'), dotMedicalRequired: false, dotMedicalExpiresAt: null }, now)).toMatchObject({ ok: false, problems: [{ key: 'licence', expired: true }] });
    const soon = driverCredentialStatus({ licenceExpiresAt: new Date('2026-06-20'), dotMedicalRequired: true, dotMedicalExpiresAt: new Date('2027-01-01') }, now);
    expect(soon.ok).toBe(true);
    expect(soon.dueSoon.map((d) => d.key)).toEqual(['licence']);
  });
  it('the DOT card counts only when required', () => {
    expect(driverCredentialStatus({ licenceExpiresAt: new Date('2027-01-01'), dotMedicalRequired: true, dotMedicalExpiresAt: null }, now).problems.map((p) => p.key)).toEqual(['dot']);
    expect(driverCredentialStatus({ licenceExpiresAt: new Date('2027-01-01'), dotMedicalRequired: false, dotMedicalExpiresAt: null }, now).ok).toBe(true);
  });
  it('training refuses runs only once a renewal date is on file and has lapsed', () => {
    const base = { licenceExpiresAt: new Date('2027-01-01'), dotMedicalRequired: false, dotMedicalExpiresAt: null };
    expect(driverCredentialStatus({ ...base, trainingExpiresAt: null }, now).ok).toBe(true);
    expect(driverCredentialStatus({ ...base, trainingExpiresAt: new Date('2026-05-15') }, now)).toMatchObject({ ok: false, problems: [{ key: 'training', expired: true }] });
    expect(driverCredentialStatus({ ...base, trainingExpiresAt: new Date('2026-06-15') }, now).dueSoon.map((d) => d.key)).toEqual(['training']);
  });
  it('an MVR over eleven months old is flagged, never blocking', () => {
    const base = { licenceExpiresAt: new Date('2027-01-01'), dotMedicalRequired: false, dotMedicalExpiresAt: null };
    const old = driverCredentialStatus({ ...base, mvrCheckedAt: new Date('2025-06-10') }, now);
    expect(old.ok).toBe(true);
    expect(old.dueSoon.map((d) => d.key)).toEqual(['mvr']);
    expect(driverCredentialStatus({ ...base, mvrCheckedAt: new Date('2026-03-01') }, now).dueSoon).toEqual([]);
  });
});

describe('the share link', () => {
  it('round-trips, expires, and refuses a forged signature', () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const { token, expiresAt } = shareToken(runId, new Date('2026-06-01T10:00:00Z'));
    expect(expiresAt.toISOString()).toBe('2026-06-01T16:00:00.000Z');
    expect(verifyShareToken(token, new Date('2026-06-01T12:00:00Z'))).toBe(runId);
    expect(verifyShareToken(token, new Date('2026-06-01T17:00:00Z'))).toBeNull();
    expect(verifyShareToken(`${token.slice(0, -2)}xx`, new Date('2026-06-01T12:00:00Z'))).toBeNull();
    expect(verifyShareToken('nonsense')).toBeNull();
  });
});
