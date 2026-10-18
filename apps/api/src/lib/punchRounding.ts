import type { Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';

/**
 * Punch rounding, applied when pay is computed — never to the punch itself.
 *
 *   NONE            pay the exact minutes (the default).
 *   NEAREST         round each punch to the nearest increment (5, 6 or 15
 *                   minutes) by the neutral rule: under half the increment
 *                   rounds down, half or more rounds up — for 15 minutes,
 *                   1–7 down and 8–14 up (29 CFR 785.48(b)). Over time it
 *                   favors neither side.
 *   EMPLOYEE_FAVOR  clock-in rounds down, clock-out rounds up: the worker
 *                   is never paid less than they worked.
 *
 *   Rounding that only ever favors the employer (clock-in up, clock-out
 *   down) is refused with the reason: it fails the DOL's neutrality test
 *   and California courts' scrutiny. The raw punch stays on the entry and
 *   the timesheet shows "rounded from".
 */

export type RoundingMode = 'NONE' | 'NEAREST' | 'EMPLOYEE_FAVOR';
export const ROUNDING_INCREMENTS = [5, 6, 15] as const;

export interface RoundingPolicy {
  mode: RoundingMode;
  increment: number;
}

export const NO_ROUNDING: RoundingPolicy = { mode: 'NONE', increment: 15 };

const MIN = 60_000;

function roundMs(t: Date, inc: number, how: 'nearest' | 'down' | 'up'): Date {
  const step = inc * MIN;
  // Round on the minute grid (seconds are dropped first, as a clock shows them).
  const ms = Math.floor(t.getTime() / MIN) * MIN;
  const base = Math.floor(ms / step) * step;
  const rem = ms - base;
  if (rem === 0) return new Date(ms);
  if (how === 'down') return new Date(base);
  if (how === 'up') return new Date(base + step);
  // Neutral: strictly under half rounds down; half or more rounds up (7 of 15 down, 8 up).
  return new Date(rem * 2 < step ? base : base + step);
}

/** The punches pay is computed from. Returns the input unchanged under NONE. */
export function roundPunches(policy: RoundingPolicy, clockInAt: Date, clockOutAt: Date | null): { clockInAt: Date; clockOutAt: Date | null; rounded: boolean } {
  if (policy.mode === 'NONE') return { clockInAt, clockOutAt, rounded: false };
  const inc = policy.increment;
  const cin = roundMs(clockInAt, inc, policy.mode === 'EMPLOYEE_FAVOR' ? 'down' : 'nearest');
  const cout = clockOutAt ? roundMs(clockOutAt, inc, policy.mode === 'EMPLOYEE_FAVOR' ? 'up' : 'nearest') : null;
  // Never let rounding invert a short entry.
  const safeOut = cout && cout.getTime() < cin.getTime() ? cin : cout;
  const rounded = cin.getTime() !== clockInAt.getTime() || (clockOutAt !== null && safeOut !== null && safeOut.getTime() !== clockOutAt.getTime());
  return { clockInAt: cin, clockOutAt: safeOut, rounded };
}

/** Validate a configuration someone is saving; refuses employer-only rounding with the reason. */
export function validateRoundingInput(input: { mode: string; increment?: number | null }): RoundingPolicy {
  const mode = input.mode;
  if (mode === 'EMPLOYER_FAVOR' || mode === 'UP_IN_DOWN_OUT') {
    throw new HttpError(
      400,
      'rounding_not_neutral',
      'Rounding clock-ins up and clock-outs down only ever takes time from the worker. The U.S. Department of Labor allows rounding only when it is neutral over time (29 CFR 785.48(b)), and California courts reject rounding that favors the employer. Choose "Nearest" (neutral) or "Always in the worker’s favor".',
    );
  }
  if (mode !== 'NONE' && mode !== 'NEAREST' && mode !== 'EMPLOYEE_FAVOR') throw new HttpError(400, 'bad_rounding_mode', 'Pick none, nearest, or in the worker’s favor.');
  const increment = input.increment ?? 15;
  if (!(ROUNDING_INCREMENTS as readonly number[]).includes(increment)) throw new HttpError(400, 'bad_increment', 'Round to 5, 6 or 15 minutes.');
  return { mode, increment };
}

/** The policy for each site (site row first, then the tenant-wide row). */
export async function loadRoundingPolicies(db: PrismaClient | Prisma.TransactionClient, tenantId: string): Promise<{ forSite: (siteId: string | null | undefined) => RoundingPolicy; any: boolean }> {
  const rows = await db.punchRoundingPolicy.findMany({ where: { tenantId }, select: { siteId: true, mode: true, increment: true } });
  const tenantRow = rows.find((r) => r.siteId === null);
  const bySite = new Map(rows.filter((r) => r.siteId).map((r) => [r.siteId!, r]));
  const asPolicy = (r: { mode: string; increment: number } | undefined): RoundingPolicy => (r ? { mode: r.mode as RoundingMode, increment: r.increment } : NO_ROUNDING);
  return {
    any: rows.some((r) => r.mode !== 'NONE'),
    forSite: (siteId) => asPolicy((siteId ? bySite.get(siteId) : undefined) ?? tenantRow),
  };
}
