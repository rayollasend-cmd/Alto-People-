import { describe, expect, it } from 'vitest';
import { arc, tripGeometry, tripStage } from '@/pages/transport/TripMap';
import type { MyLiveRide, Ride } from '@/lib/transportApi';

/** What the rider's map draws at each stage of the trip. */

const HOME = { lat: 30.21, lng: -85.86 };
const STORE = { lat: 30.17, lng: -85.8 };
const VAN = { lat: 30.3, lng: -85.95, heading: 90, speedMps: 11, at: new Date().toISOString() };

function live(over: Partial<MyLiveRide> = {}): MyLiveRide {
  return {
    rideId: 'r1',
    direction: 'TO_WORK',
    status: 'SCHEDULED',
    runStatus: 'ACTIVE',
    timezone: 'America/Chicago',
    departAt: null,
    van: { name: 'Van 1', plate: null },
    driver: 'Mike',
    position: VAN,
    stale: false,
    pickup: { label: 'Home', point: HOME, scheduledAt: null, etaAt: null },
    destination: { label: 'Store', point: STORE, dueAt: null, etaAt: null },
    stopsBefore: 0,
    lateMinutes: 0,
    vanArrivedAt: null,
    riderSignal: null,
    ...over,
  };
}

const ids = (g: ReturnType<typeof tripGeometry>) => g.markers.map((m) => m.id);

describe('the rider’s trip on the map', () => {
  it('names the stage from the ride and the live feed', () => {
    const r = { status: 'REQUESTED', run: null, vanArrivedAt: null } as unknown as Ride;
    expect(tripStage(r, null)).toBe('FINDING');
    expect(tripStage({ ...r, status: 'SCHEDULED', run: { status: 'PLANNED' } } as unknown as Ride, null)).toBe('CONFIRMED');
    expect(tripStage({ ...r, status: 'SCHEDULED', run: { status: 'ACTIVE' } } as unknown as Ride, null)).toBe('ON_THE_WAY');
    expect(tripStage({ ...r, status: 'SCHEDULED', vanArrivedAt: 'x' } as unknown as Ride, null)).toBe('HERE');
    expect(tripStage({ ...r, status: 'BOARDED' } as unknown as Ride, null)).toBe('ON_BOARD');
  });

  it('finding a driver: the pickup pulses, an arc to the store, no van', () => {
    const g = tripGeometry('FINDING', live({ runStatus: null, van: null, position: null }), 'Van 1');
    expect(ids(g)).toEqual(['pickup', 'dest']);
    expect(g.markers[0]!.pulse).toBe(true);
    expect(g.route!.length).toBeGreaterThan(10);
    expect(g.path).toBeUndefined();
  });

  it('on the way: the van, a flowing line to the pickup, the rest of the trip dashed', () => {
    const g = tripGeometry('ON_THE_WAY', live(), 'Van 1');
    expect(ids(g)).toEqual(['van', 'pickup', 'dest']);
    expect(g.path).toEqual([
      [VAN.lng, VAN.lat],
      [HOME.lng, HOME.lat],
    ]);
    expect(g.route).toBeDefined();
  });

  it('here: close in on the van and the pickup; on board: the van and where it’s going', () => {
    const here = tripGeometry('HERE', live(), 'Van 1');
    expect(ids(here)).toEqual(['van', 'pickup']);
    expect(here.maxZoom).toBe(16);
    const aboard = tripGeometry('ON_BOARD', live({ status: 'BOARDED' }), 'Van 1');
    expect(ids(aboard)).toEqual(['van', 'dest']);
    expect(aboard.path![1]).toEqual([STORE.lng, STORE.lat]);
  });

  it('the arc starts and ends on the trip’s two ends', () => {
    const a = arc(HOME, STORE);
    expect(a[0]).toEqual([HOME.lng, HOME.lat]);
    expect(a.at(-1)![0]).toBeCloseTo(STORE.lng, 10);
    expect(a.at(-1)![1]).toBeCloseTo(STORE.lat, 10);
  });
});
