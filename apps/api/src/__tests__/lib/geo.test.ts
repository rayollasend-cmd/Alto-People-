import { describe, expect, it } from 'vitest';
import { checkGeofence, haversineMeters } from '../../lib/geo.js';

describe('haversineMeters', () => {
  it('returns 0 for the same point', () => {
    expect(haversineMeters({ lat: 30.4383, lng: -84.2807 }, { lat: 30.4383, lng: -84.2807 })).toBeCloseTo(0, 1);
  });

  it('roughly matches a known distance (Tallahassee FL → Mobile AL ≈ 391 km)', () => {
    const tally = { lat: 30.4383, lng: -84.2807 };
    const mobile = { lat: 30.6954, lng: -88.0399 };
    const meters = haversineMeters(tally, mobile);
    // Allow ±10 km — 391 km ± 1.5 % is generous given great-circle approx.
    expect(meters / 1000).toBeGreaterThan(360);
    expect(meters / 1000).toBeLessThan(420);
  });

  it('handles 1° latitude ≈ 111 km', () => {
    const meters = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(meters / 1000).toBeGreaterThan(110);
    expect(meters / 1000).toBeLessThan(112);
  });
});

describe('checkGeofence', () => {
  const center = { lat: 30.4383, lng: -84.2807 };

  it('returns inside=null when no geofence configured', () => {
    const r = checkGeofence(
      { latitude: null, longitude: null, radiusMeters: null },
      center
    );
    expect(r.inside).toBeNull();
    expect(r.distanceMeters).toBeNull();
  });

  it('returns inside=true when point matches the center', () => {
    const r = checkGeofence(
      { latitude: center.lat, longitude: center.lng, radiusMeters: 100 },
      center
    );
    expect(r.inside).toBe(true);
    expect(r.distanceMeters).toBeLessThan(1);
  });

  it('returns inside=false when point is outside the radius', () => {
    const farPoint = { lat: center.lat + 0.01, lng: center.lng };  // ~1.1 km away
    const r = checkGeofence(
      { latitude: center.lat, longitude: center.lng, radiusMeters: 100 },
      farPoint
    );
    expect(r.inside).toBe(false);
    expect(r.distanceMeters).toBeGreaterThan(900);
  });

  it('returns inside=false when geofence enforced but no point provided', () => {
    const r = checkGeofence(
      { latitude: center.lat, longitude: center.lng, radiusMeters: 100 },
      null
    );
    expect(r.inside).toBe(false);
    expect(r.distanceMeters).toBeNull();
  });
});
