import { Prisma, type W4FilingStatus } from '@prisma/client';

/**
 * PHASE 8 PLACEHOLDER WITHHOLDING.
 *
 * This is a flat-bracket approximation, NOT IRS-compliant. Real federal
 * withholding requires the wage-bracket or percentage-method tables from
 * IRS Pub 15-T plus state/local layers. We isolate the calculation here
 * so a Phase 9+ swap to real tables (or a SaaS like Symmetry) is one file.
 */

const FLAT_BRACKETS: Record<W4FilingStatus, number> = {
  SINGLE: 0.18,
  MARRIED_FILING_JOINTLY: 0.14,
  HEAD_OF_HOUSEHOLD: 0.16,
};

export interface WithholdingInput {
  grossPay: number;
  filingStatus: W4FilingStatus | null;
  /** Per-paycheck additional withholding from W-4 line 4(c). */
  extraWithholding?: number;
}

export function computeFederalWithholding(input: WithholdingInput): number {
  const status = input.filingStatus ?? 'SINGLE';
  const rate = FLAT_BRACKETS[status];
  const base = Math.max(0, input.grossPay * rate);
  const extra = Math.max(0, input.extraWithholding ?? 0);
  return round2(base + extra);
}

export function computeNet(grossPay: number, withholding: number): number {
  return round2(grossPay - withholding);
}

export function round2(n: number): number {
  // 1.005 in IEEE 754 is actually 1.00499…, so plain Math.round(n*100)/100
  // and even toFixed produce 1.00 instead of the expected 1.01. The
  // Number.EPSILON nudge is the standard JS workaround. For a real ledger
  // we'd switch to decimal.js, but the dollar values payroll handles here
  // never exceed safe-integer cents so this is fine.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Convert milliseconds → fractional hours, rounded to 2 decimals. */
export function msToHours(ms: number): number {
  return round2(ms / (1000 * 60 * 60));
}

/**
 * Aggregate APPROVED time entries for one associate within a period.
 * Returns total hours worked. Excludes ACTIVE/COMPLETED/REJECTED.
 */
export function sumApprovedHours(
  entries: Array<{ status: string; clockInAt: Date; clockOutAt: Date | null }>
): number {
  let totalMs = 0;
  for (const e of entries) {
    if (e.status !== 'APPROVED') continue;
    if (!e.clockOutAt) continue;
    totalMs += e.clockOutAt.getTime() - e.clockInAt.getTime();
  }
  return msToHours(totalMs);
}

/** Pick the best hourly rate for an associate from their period shifts. */
export function pickHourlyRate(
  shifts: Array<{ hourlyRate: Prisma.Decimal | null }>,
  defaultRate: number
): number {
  // Use the highest rate among ASSIGNED/COMPLETED shifts in the period —
  // a defensible choice for an MVP. Real payroll uses contracted rate.
  let best = defaultRate;
  for (const s of shifts) {
    if (s.hourlyRate === null) continue;
    const r = Number(s.hourlyRate);
    if (r > best) best = r;
  }
  return round2(best);
}
