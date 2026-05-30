import { prisma } from '../db.js';

/**
 * Periodically ping Postgres so Neon's serverless compute doesn't suspend
 * mid-session. The ping is a single `SELECT 1` — cheapest possible query.
 *
 * Production defaults to 240s (every 4 min, comfortably under Neon's 5-min
 * idle threshold) — see config/env.ts. Dev and test default off so a local
 * Neon dev branch isn't held continuously open. The trade-off in prod is
 * Neon compute hours vs. user-visible cold-start failures; cold-start
 * failures showed up in Sentry as PrismaClientKnownRequestError on the
 * login endpoint, so the warmth pays for itself.
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
