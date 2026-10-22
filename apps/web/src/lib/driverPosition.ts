/**
 * The driver's last known position, shared across the driver app.
 *
 * The run card's location stream (DriverHome.useShareVanLocation) writes
 * it; every tap that should carry a fix — Arrived, No-show, On board,
 * Report a problem — reads it (floor walk 17). A fix older than
 * MAX_AGE_MS is not evidence of where the van is now and is left out.
 */

export interface DriverFix {
  lat: number;
  lng: number;
  accuracy: number | null;
  at: number;
}

const MAX_AGE_MS = 2 * 60_000;
let last: DriverFix | null = null;

export function rememberDriverFix(fix: Omit<DriverFix, 'at'>, now = Date.now()): void {
  last = { ...fix, at: now };
}

/** The fix to send with a mark, or nothing when there is none fresh enough. */
export function currentDriverFix(now = Date.now()): { lat: number; lng: number; accuracy: number | null } | null {
  if (!last || now - last.at > MAX_AGE_MS) return null;
  return { lat: last.lat, lng: last.lng, accuracy: last.accuracy };
}

/** Tests only. */
export function forgetDriverFix(): void {
  last = null;
}
