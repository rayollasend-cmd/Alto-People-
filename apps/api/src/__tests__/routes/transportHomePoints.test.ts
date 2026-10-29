import { describe, expect, it, vi } from 'vitest';

/**
 * CODE-28 (deep audit 2026-10-29): the trip and plan maps looked up every
 * rider's home one at a time — a Mapbox call per cache miss, in series.
 * homePointsOf runs a few at a time, answers in the riders' order, and
 * riders at one shared stop share one lookup.
 */

const calls = vi.hoisted(() => ({ n: 0, inFlight: 0, max: 0 }));
vi.mock('../../lib/transportLive.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/transportLive.js')>();
  return {
    ...real,
    homePoint: async (r: { id: string }) => {
      calls.n += 1;
      calls.inFlight += 1;
      calls.max = Math.max(calls.max, calls.inFlight);
      await new Promise((res) => setTimeout(res, 5));
      calls.inFlight -= 1;
      return { lat: Number(r.id.replace(/\D/g, '')), lng: 0 };
    },
  };
});

const { homePointsOf } = await import('../../routes/transport.js');

describe('homePointsOf', () => {
  it('looks up at most six at a time, keeps the riders’ order, and shares a stop’s lookup', async () => {
    const rides = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      address: `${i} Main St`,
      lat: null,
      lng: null,
      stop: i >= 15 ? { id: 'stop-1', address: '1 Depot Rd', lat: null, lng: null } : null,
    }));
    const points = await homePointsOf(rides);
    expect(points).toHaveLength(20);
    expect(points.slice(0, 15).map((p) => p?.lat)).toEqual(Array.from({ length: 15 }, (_, i) => i));
    // Riders 15–19 share the stop: one lookup, the first sharer's answer for all of them.
    expect(new Set(points.slice(15).map((p) => p?.lat))).toEqual(new Set([15]));
    expect(calls.n).toBe(16);
    expect(calls.max).toBeGreaterThan(1);
    expect(calls.max).toBeLessThanOrEqual(6);
  });
});
