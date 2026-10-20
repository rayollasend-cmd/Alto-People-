import type { PrismaClient } from '@prisma/client';
import { makeDueRecurringBills } from '../payables/recurring.js';

/**
 * The books' scheduled work — payables. Runs for the tenant in context:
 * recurring bills whose date has come become bills (a draft, or straight
 * to approval when the template says so). Idempotent.
 */
export async function runPayablesJobs(db: PrismaClient, now: Date = new Date()): Promise<void> {
  await makeDueRecurringBills(db, now);
}
