/**
 * The portal's scope carried in the URL: admins pass the preview client
 * (+ store); a client-wide portal account may drill into one of its own
 * stores. Every portal page threads these through its links so a store
 * manager (or a previewing admin) never loses the store they're on.
 */
export function scopeParams(params: URLSearchParams, isPortal: boolean): URLSearchParams {
  const q = new URLSearchParams();
  const client = params.get('clientId');
  const loc = params.get('locationId');
  if (!isPortal && client) q.set('clientId', client);
  if (loc) q.set('locationId', loc);
  return q;
}

/** YYYY-MM-DD ± days, calendar-safe. */
export function shiftDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}
