import { prisma } from '../../db.js';
import { logger } from '../logger.js';
import { runForEachTenant } from '../tenantJobs.js';
import { bankingProfile, usesOurAch } from './ach.js';
import { clearPrenotes, markEntriesSettled, sendDuePrenotes } from './directDeposit.js';
import { settleDueFunding } from './funding.js';

/**
 * Hourly per tenant on our own ACH: funding debits past their effective
 * date settle, entries with no return after two banking days settle,
 * prenotes clear, and newly verified accounts get their prenote.
 */
export async function bankingTick(now = new Date()): Promise<void> {
  const profile = await bankingProfile(prisma);
  if (!usesOurAch(profile)) return;
  await settleDueFunding(prisma, now);
  await markEntriesSettled(prisma, now);
  await clearPrenotes(prisma, now);
  await sendDuePrenotes(prisma, null, now).catch((err) => logger.warn({ err }, 'prenote send skipped'));
}

export function startBankingCron(): void {
  const tick = () => runForEachTenant('banking', () => bankingTick()).catch((err) => logger.warn({ err }, 'banking sweep failed'));
  setInterval(tick, 60 * 60_000).unref();
}
