import { onTestFinished, vi } from 'vitest';

/**
 * Pin this test's clock (`Date` only — timers, sockets and Prisma's own
 * timestamps run on the real one) to the most recent Wednesday, 16:00 UTC:
 * noon in the stores' Eastern time, mid-store-week (Saturday → Friday).
 *
 * For a test whose seed is relative to now — a shift "in an hour", punches
 * "earlier this week" — and whose assertion is about TODAY or THIS WEEK.
 * Against the real clock those fail after 8 PM Pacific (an hour from now is
 * tomorrow in Eastern time) and from Friday evening (the store week turns
 * over), and CI runs at every hour. Recent, not fixed: the date stays
 * within a week of the real one, so the year's tax tables and anything
 * keyed to "the last N days" behave as they do in production.
 */
export function pinMidweekNoon(): Date {
  const real = new Date();
  const back = (real.getUTCDay() - 3 + 7) % 7;
  const pinned = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate() - back, 16));
  if (pinned.getTime() > real.getTime()) pinned.setUTCDate(pinned.getUTCDate() - 7);
  vi.useFakeTimers({ toFake: ['Date'], now: pinned });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return pinned;
}
