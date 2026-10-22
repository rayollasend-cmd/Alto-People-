import type { Prisma, PrismaClient } from '@prisma/client';
import { loadRoundingPolicies, roundPunches } from '../punchRounding.js';
import { tenantIdForWrite } from '../tenant.js';
import { loadLiveRules, type LiveRules } from './live.js';

/**
 * What pay computes hours from, loaded once per request or job: the
 * tenant's live labor rules (lib/laborRules/live) and its punch rounding
 * (lib/punchRounding — applied when pay is computed, never to the punch).
 * Every view that must match the paycheck to the hundredth of an hour —
 * the payroll sheet, the client statement, the associate's estimate —
 * splits `forPay(entry)` with `rules`, exactly as the aggregator does.
 */
export interface PayContext {
  rules: LiveRules;
  /** The entry's punches as pay counts them (rounded where a policy says so). */
  forPay<T extends { clockInAt: Date; clockOutAt: Date | null; locationId?: string | null }>(e: T): T;
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function loadPayContext(db: Db, tenantId: string = tenantIdForWrite()): Promise<PayContext> {
  const [rules, rounding] = await Promise.all([loadLiveRules(db, tenantId), loadRoundingPolicies(db, tenantId)]);
  return {
    rules,
    forPay: (e) => {
      if (!rounding.any) return e;
      const r = roundPunches(rounding.forSite(e.locationId), e.clockInAt, e.clockOutAt);
      return r.rounded ? { ...e, clockInAt: r.clockInAt, clockOutAt: r.clockOutAt } : e;
    },
  };
}
