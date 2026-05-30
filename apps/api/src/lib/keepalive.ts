import { prisma } from '../db.js';

/**
 * Periodically ping Postgres so Neon's serverless compute doesn't suspend
 * mid-session. The ping is a single `SELECT 1` — cheapest possible query.
 *
 * Defaults off. Production runs Neon with auto-suspend disabled at the
 * branch level, so pings would just burn compute hours with no upside.
 * Keep this around for environments that DO suspend (dev branches on the
 * Neon Free tier, ephemeral preview deploys) where iterating in the
 * browser would otherwise eat a cold-start every few minutes.
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
