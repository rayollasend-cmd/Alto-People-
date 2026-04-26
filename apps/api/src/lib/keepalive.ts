import { prisma } from '../db.js';

/**
 * Periodically ping Postgres so Neon's serverless compute doesn't suspend
 * mid-session. The ping is a single `SELECT 1` — cheapest possible query.
 *
 * Runs only when KEEP_ALIVE_INTERVAL_SECONDS > 0 (opt-in via env). Defaults
 * off because every ping consumes Neon compute hours; the trade-off makes
 * sense for a developer working in the browser, not for a production
 * deployment that can absorb the occasional cold start.
 */
export function startKeepAlive(intervalSeconds: number): NodeJS.Timeout | null {
  if (intervalSeconds <= 0) return null;
  const intervalMs = intervalSeconds * 1000;
  // Don't queue overlapping pings if a previous one is still in flight.
  let inFlight = false;
  const ping = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      // Best-effort — log and move on. The next interval will retry.
      console.warn(
        '[alto-people/api] keep-alive ping failed:',
        err instanceof Error ? err.message : err
      );
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(ping, intervalMs);
  // Run once immediately so the DB is warm before any user request lands.
  void ping();
  return handle;
}
