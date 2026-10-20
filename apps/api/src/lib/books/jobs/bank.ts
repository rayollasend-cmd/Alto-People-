import type { PrismaClient } from '@prisma/client';
import { applyRules, syncStaleFeeds } from '../bank/service.js';

/**
 * The books' bank work for the tenant in context: pull new transactions
 * for Plaid feeds not synced in the last four hours, then run the
 * auto-apply rules over anything still waiting for review (a rule made
 * after the transactions came in catches up here).
 */
export async function runBankJobs(db: PrismaClient, now: Date = new Date()): Promise<void> {
  await syncStaleFeeds(db, now);
  await applyRules(db, { autoOnly: true, userId: null });
}
