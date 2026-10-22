import * as React from 'react';
import { StatusBadge, type BadgeVariant, type StatusBadgeProps } from '@/lib/status';

/**
 * ONE WORD PER PAYROLL STATUS (F500 SH-4).
 *
 * The payroll home, the run drawer and the Last run card said "Disbursed"
 * (StatusBadge humanising the code) while the review, the close, Pay checks
 * and Daily pay each kept a private map saying "Paid" — and a cancelled run
 * read "Voided" on two pages and "Cancelled" on a third. Every payroll page
 * now reads its words and tones from here.
 *
 *   Run:      Draft · Finalized · Paid · Cancelled
 *   Paycheck: Not paid yet · Paid · Failed · Held · Voided
 *
 * "Paid" over "Disbursed": plainer, and what the person being paid would say.
 */

export type PayrollRunStatusCode = 'DRAFT' | 'FINALIZED' | 'DISBURSED' | 'CANCELLED';
export type PaycheckStatusCode = 'PENDING' | 'DISBURSED' | 'FAILED' | 'HELD' | 'VOIDED';

export const PAYROLL_RUN_STATUS: Readonly<Record<PayrollRunStatusCode, { label: string; tone: BadgeVariant }>> = {
  DRAFT: { label: 'Draft', tone: 'default' },
  FINALIZED: { label: 'Finalized', tone: 'pending' },
  DISBURSED: { label: 'Paid', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'outline' },
};

export const PAYCHECK_STATUS: Readonly<Record<PaycheckStatusCode, { label: string; tone: BadgeVariant }>> = {
  PENDING: { label: 'Not paid yet', tone: 'pending' },
  DISBURSED: { label: 'Paid', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'destructive' },
  HELD: { label: 'Held', tone: 'destructive' },
  VOIDED: { label: 'Voided', tone: 'outline' },
};

/** An unknown code, humanised ("ON_HOLD" → "On hold"); never throws on odd input. */
const humanise = (status: unknown): string => {
  const s = typeof status === 'string' ? status : '';
  return s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '';
};

/** The run status's word ("Paid"); an unknown code is humanised. */
export function runStatusLabel(status: string): string {
  return PAYROLL_RUN_STATUS[status as PayrollRunStatusCode]?.label ?? humanise(status);
}

export function runStatusTone(status: string): BadgeVariant {
  return PAYROLL_RUN_STATUS[status as PayrollRunStatusCode]?.tone ?? 'default';
}

/** The paycheck status's word; `overrides` for a desk's own wording (Daily pay: VOIDED = "Paid on the regular check"). */
export function paycheckStatusLabel(status: string, overrides?: Partial<Record<PaycheckStatusCode, string>>): string {
  return overrides?.[status as PaycheckStatusCode] ?? PAYCHECK_STATUS[status as PaycheckStatusCode]?.label ?? humanise(status);
}

export function paycheckStatusTone(status: string): BadgeVariant {
  return PAYCHECK_STATUS[status as PaycheckStatusCode]?.tone ?? 'default';
}

/** A payroll run's status badge, in the one vocabulary. */
export function RunStatusBadge({ status, ...rest }: Omit<StatusBadgeProps, 'label' | 'overrides'>) {
  const code = typeof status === 'string' ? status : '';
  return React.createElement(StatusBadge, { status: code, label: runStatusLabel(code), overrides: { [code]: runStatusTone(code) }, ...rest });
}
