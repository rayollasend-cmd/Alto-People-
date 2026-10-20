import type { PrismaClient } from '@prisma/client';
import { runSync } from '../qbo/sync.js';

/**
 * The company QuickBooks, every five minutes for the tenant in context:
 * send what's waiting, then bring in what changed there. Nothing to do
 * until QuickBooks is connected (or while it's paused).
 */
export async function runQuickbooksJobs(db: PrismaClient, now: Date = new Date()): Promise<void> {
  await runSync(db, { now });
}
