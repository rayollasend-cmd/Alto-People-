import { bookRide, type BookRideInput, type MyTransport, type Ride, type RideDirection } from '@/lib/transportApi';

/**
 * Rides against the schedule — the click-saver. Rides never depend on a
 * shift, but most are for one: this matches each upcoming shift to the
 * rides already booked for it (either way), and books the missing legs in
 * one tap from where the associate went last time.
 */

const H = 3_600_000;
const NEAR_MS = 3 * H;
const ACTIVE: Ride['status'][] = ['REQUESTED', 'SCHEDULED', 'BOARDED'];

export type Shift = MyTransport['shifts'][number];

export interface ShiftCoverage {
  shift: Shift;
  there: Ride | null;
  home: Ride | null;
  /** Legs still bookable (outside the cutoff, not yet booked). */
  canBook: RideDirection[];
}

function near(r: Ride, shift: Shift, direction: RideDirection): boolean {
  if (r.direction !== direction || !ACTIVE.includes(r.status)) return false;
  if (r.shiftId === shift.id) return true;
  const at = direction === 'TO_WORK' ? shift.startsAt : shift.endsAt;
  return r.store.id === shift.locationId && Math.abs(Date.parse(r.targetAt) - Date.parse(at)) <= NEAR_MS;
}

export function coverageFor(data: MyTransport, now = Date.now()): ShiftCoverage[] {
  const cutoff = now + data.settings.cutoffHours * H;
  return data.shifts
    .filter((s) => s.locationId && data.stores.some((st) => st.id === s.locationId) && Date.parse(s.endsAt) > now)
    .map((shift) => {
      const there = data.rides.find((r) => near(r, shift, 'TO_WORK')) ?? null;
      const home = data.rides.find((r) => near(r, shift, 'FROM_WORK')) ?? null;
      const canBook: RideDirection[] = [];
      if (!there && Date.parse(shift.startsAt) > cutoff) canBook.push('TO_WORK');
      if (!home && Date.parse(shift.endsAt) > cutoff) canBook.push('FROM_WORK');
      return { shift, there, home, canBook };
    });
}

/** The pickup one-tap booking uses — where they went last time. */
export function defaultPickupBody(data: MyTransport): Pick<BookRideInput, 'stopId' | 'placeId' | 'address' | 'lat' | 'lng'> | null {
  const d = data.defaultPickup;
  if (!d) return null;
  if (d.kind === 'stop') return { stopId: d.stopId };
  if (d.kind === 'place') return { placeId: d.placeId };
  return { address: d.address, ...(d.lat !== null && d.lng !== null ? { lat: d.lat, lng: d.lng } : {}) };
}

/** Book the missing legs of each shift; returns how many rides were booked.
 *  Stops at the first refusal and rethrows it (the caller says why). */
export async function bookShifts(data: MyTransport, covers: ShiftCoverage[]): Promise<number> {
  const pickup = defaultPickupBody(data);
  if (!pickup) return 0;
  let booked = 0;
  for (const c of covers) {
    for (const direction of c.canBook) {
      await bookRide({
        direction,
        locationId: c.shift.locationId!,
        ...pickup,
        targetAt: direction === 'TO_WORK' ? c.shift.startsAt : c.shift.endsAt,
        shiftId: c.shift.id,
      });
      booked += 1;
    }
  }
  return booked;
}

/** "2h 10m", "45m", "3d". */
export function fmtIn(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "2:41" of a countdown. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
