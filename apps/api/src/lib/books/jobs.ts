import type { PrismaClient } from '@prisma/client';
import { runPayablesJobs } from './jobs/payables.js';
import { runBankJobs } from './jobs/bank.js';
import { runCloseJobs } from './jobs/close.js';
import { runQuickbooksJobs } from './jobs/quickbooks.js';
import { backfillPosting } from './posting/gaps.js';
import { tenantIdForWrite } from '../tenant.js';

/** When each tenant's posting last caught up (in memory: a restart just catches up once more). */
const lastCatchUp = new Map<string, number>();
const CATCH_UP_EVERY_MS = 60 * 60_000;

/**
 * Hourly: post anything from the last 35 days that should be on the books
 * and isn't — a posting that failed while its operation succeeded (the
 * hooks log and move on). Idempotent; usually finds nothing.
 */
async function catchUpPosting(db: PrismaClient, now: Date): Promise<void> {
  const tenantId = tenantIdForWrite();
  if (now.getTime() - (lastCatchUp.get(tenantId) ?? 0) < CATCH_UP_EVERY_MS) return;
  lastCatchUp.set(tenantId, now.getTime());
  await backfillPosting(db, { since: new Date(now.getTime() - 35 * 86_400_000) });
}

/**
 * The books' scheduled work for the tenant in context, every few minutes
 * (index.ts): recurring bills due, bank feeds to pull, accruals to reverse
 * and depreciation to post, and the QuickBooks outbox and pull. Each part
 * is isolated: one failing never stops the others.
 */
export async function runBooksJobs(db: PrismaClient, now: Date = new Date()): Promise<void> {
  // One sweep per tenant at a time (deep audit CODE-23): a slow QuickBooks pull must not let the
  // next tick start a second sweep beside it — the job runner guards its own timer, this guards
  // every other caller too.
  const tenantId = tenantIdForWrite();
  if (inFlight.has(tenantId)) return;
  inFlight.add(tenantId);
  try {
    await runBooksParts(db, now);
  } finally {
    inFlight.delete(tenantId);
  }
}

const inFlight = new Set<string>();

/** Whether a tenant's books sweep is running now (tests). */
export const booksSweepRunning = (tenantId: string): boolean => inFlight.has(tenantId);

async function runBooksParts(db: PrismaClient, now: Date): Promise<void> {
  for (const [name, fn] of [
    ['posting', catchUpPosting],
    ['payables', runPayablesJobs],
    ['bank', runBankJobs],
    ['close', runCloseJobs],
    ['quickbooks', runQuickbooksJobs],
  ] as const) {
    try {
      await fn(db, now);
    } catch (err) {
      console.error(`[books] ${name} jobs failed`, err);
    }
  }
}
