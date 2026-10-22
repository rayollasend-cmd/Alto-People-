import type { Prisma, PrismaClient } from '@prisma/client';
import { localParts } from './laborRules/evaluate.js';
import { loadRulePool, rulesForSite, type StoredRuleSet } from './laborRules/store.js';

/**
 * Whether a shift sits in a predictability-pay jurisdiction — the fact the
 * web needs to REQUIRE a change reason on every edit, assignment, release
 * and cancellation of that shift (audit Tier 1 #9: the API parsed
 * `changeReason` on four writes and no form sent it, so every late change
 * in a fair-workweek city went unrecorded).
 *
 *   The answer is the site's resolved `predictive.noticeDays` under the
 *   same pool lib/predictabilityPay reads (the shipped packs plus the
 *   tenant's overrides). Serializers are synchronous and a schedule page
 *   carries thousands of shifts, so the pool is cached per tenant for a
 *   minute and the lookup is a pure resolution against it. A route primes
 *   the cache before serializing; a cold cache answers null rather than
 *   blocking (the next request has it).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const POOL_TTL_MS = 60_000;
const pools = new Map<string, { pool: StoredRuleSet[]; loadedAt: number }>();

/** Load (or refresh) the tenant's rule pool so `fairWorkweekNoticeDays` can answer synchronously. */
export async function primeFairWorkweek(db: Db, tenantId: string, now: Date = new Date()): Promise<void> {
  const hit = pools.get(tenantId);
  if (hit && now.getTime() - hit.loadedAt < POOL_TTL_MS) return;
  const pool = await loadRulePool(db, tenantId);
  pools.set(tenantId, { pool, loadedAt: now.getTime() });
}

/** Forget every cached pool (tests, and a rule-set edit that must show at once). */
export function resetFairWorkweekCache(): void {
  pools.clear();
}

export interface FairWorkweekSite {
  id: string;
  state: string | null;
  city: string | null;
  timezone: string;
}

/**
 * The notice window, in days, the shift's site owes under its rules on the
 * shift's local date; null where no predictive-scheduling law applies, for
 * a shift with no site, or while the tenant's pool is not primed.
 */
export function fairWorkweekNoticeDays(tenantId: string, site: FairWorkweekSite | null | undefined, startsAt: Date): number | null {
  if (!site) return null;
  const hit = pools.get(tenantId);
  if (!hit) return null;
  const date = localParts(startsAt, site.timezone).date;
  const days = rulesForSite(hit.pool, site, date).params.predictive?.noticeDays;
  return days == null ? null : days;
}
