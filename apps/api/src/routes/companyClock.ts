import { Router } from 'express';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { endOfWeekUTC, orgDateKey } from '../lib/timeAnomalies.js';
import { soonestPayday } from '../lib/payday.js';

/**
 * The company clock — one rhythm, every building.
 *
 * Finance lives by week end (Fri) → Tuesday-evening close → payday; the
 * other department heads couldn't see that clock at all. This tiny
 * endpoint feeds the shared strip on the HR, Finance, and Workforce
 * consoles so "the close is tomorrow" is ambient knowledge everywhere
 * instead of a fact Finance has to keep announcing.
 *
 * Gated on view:org — a staff-tier read every department head holds.
 */

export const companyClockRouter = Router();

const DAY_MS = 86_400_000;

/** Next Tuesday (org-local), today included: the hours-approval close. */
function nextCloseKey(now: Date): string {
  for (let i = 0; i < 7; i++) {
    const candidate = new Date(now.getTime() + i * DAY_MS);
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: 'America/New_York',
    }).format(candidate);
    if (weekday === 'Tue') return orgDateKey(candidate);
  }
  return orgDateKey(now); // unreachable
}

companyClockRouter.get(
  '/company/clock',
  requireCapability('view:org'),
  async (_req, res, next) => {
    try {
      const now = new Date();
      // endOfWeekUTC = the instant the Sat→Fri org week closes; the last
      // day OF the week is the day before that instant's date key.
      const weekEndInstant = endOfWeekUTC(now);
      const weekEndsOn = orgDateKey(new Date(weekEndInstant.getTime() - DAY_MS / 2));
      const payday = await soonestPayday(prisma, now);
      res.json({
        weekEndsOn,
        closeOn: nextCloseKey(now),
        payday: payday ? { date: payday.date, schedule: payday.schedule } : null,
      });
    } catch (err) {
      next(err);
    }
  },
);
