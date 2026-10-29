import { apiFetch } from './api';

/** The pay ↔ bill desk (apps/api/src/routes/payBill.ts). */

export type PremiumKey = 'DOUBLE_TIME' | 'MEAL_REST' | 'PREDICTABILITY' | 'HOLIDAY' | 'SHIFT_DIFFERENTIAL';
export type PremiumMode = 'NOT_BILLABLE' | 'AT_COST' | 'BILL_MARKUP';
export type RetroRebill = 'AUTO' | 'REVIEW' | 'NEVER';
export type OvertimeBilling = 'MULTIPLIED' | 'STRAIGHT';

export const PREMIUM_KEYS: PremiumKey[] = ['DOUBLE_TIME', 'MEAL_REST', 'PREDICTABILITY', 'HOLIDAY', 'SHIFT_DIFFERENTIAL'];
export const PREMIUM_LABEL: Record<PremiumKey, string> = {
  DOUBLE_TIME: 'Double time',
  MEAL_REST: 'Meal and rest premiums',
  PREDICTABILITY: 'Predictability pay',
  HOLIDAY: 'Holiday premium',
  SHIFT_DIFFERENTIAL: 'Shift differentials',
};

export interface PremiumRule {
  mode: PremiumMode;
  markupPct?: number | null;
}

export interface BillingTerms {
  id: string | null;
  clientId: string;
  effectiveFrom: string | null;
  retroRebill: RetroRebill;
  overtimeBilling: OvertimeBilling;
  premiumRules: Record<PremiumKey, PremiumRule>;
  defaultMarkupPct: number | null;
  notes: string | null;
}

export interface StatementRef {
  id: string;
  clientId: string;
  number: number | null;
  status: string;
}

export interface PaycheckMargin {
  payrollItemId: string;
  payrollRunId: string;
  associateId: string;
  associateName: string;
  clientId: string | null;
  clientName: string;
  hours: number;
  wages: number;
  employerTaxes: number;
  burden: number;
  overhead: number;
  cost: number;
  billed: number;
  pending: number;
  margin: number;
  marginPct: number | null;
  statements: StatementRef[];
}

export type UnbilledReason = 'NO_STATEMENT' | 'NOT_YET_BILLED' | 'AWAITING_REVIEW' | 'NOT_BILLABLE' | 'NEVER_REBILL' | 'REJECTED' | 'NO_RATE';

export interface UnbilledRow {
  associateId: string;
  associateName: string;
  payrollItemId: string;
  clientId: string | null;
  clientName: string;
  kind: 'HOURS' | 'PREMIUM' | 'RETRO';
  label: string;
  hours: number;
  payAmount: number;
  reason: UnbilledReason;
  reasonText: string;
  workFrom: string | null;
  workTo: string | null;
}

export interface ReconReport {
  periodStart: string;
  periodEnd: string;
  runs: Array<{ id: string; periodStart: string; periodEnd: string; status: string; clientName: string | null; checks: number }>;
  hours: { paid: number; billed: number; onDraft: number; unbilled: number };
  premiums: { paid: number; billed: number; queued: number; awaitingReview: number; notBillable: number; unbilled: number };
  retro: { paid: number; rebilled: number; queued: number; awaitingReview: number; notRebilled: number };
  totals: { wages: number; cost: number; billed: number; pending: number; margin: number; marginPct: number | null; gapPay: number };
  paychecks: PaycheckMargin[];
  unbilled: UnbilledRow[];
  /** Hours a final statement billed that no paystub paid, by person and week (finance walk 11). */
  billedNotPaid?: BilledNotPaidRow[];
  billedNotPaidHours?: number;
}

export interface BilledNotPaidRow {
  associateId: string;
  associateName: string;
  clientId: string;
  clientName: string;
  weekStart: string;
  hours: number;
  statementId: string;
  statementNumber: number | null;
}

export interface BillingAdjustmentRow {
  id: string;
  clientId: string;
  clientName: string;
  kind: 'RETRO' | 'PREMIUM' | 'REVERSAL';
  status: 'READY' | 'PENDING_REVIEW' | 'BILLED' | 'VOID';
  ruleKey: string | null;
  label: string;
  basis: string | null;
  hours: number;
  payAmount: number;
  amount: number;
  workFrom: string | null;
  workTo: string | null;
  associateId: string | null;
  payrollRunId: string | null;
  approvalId: string | null;
  reason: string | null;
  originalStatements: Array<{ id: string; number: number | null }>;
  billedStatement: { id: string; number: number | null } | null;
  createdAt: string;
}

export interface StoreRunningCost {
  siteId: string | null;
  siteName: string;
  clientName: string | null;
  hours: number;
  overtimeHours: number;
  wages: number;
  loadedCost: number;
  onClockNow: number;
}

export interface RunningCost {
  weekStart: string;
  weekEnd: string;
  stores: StoreRunningCost[];
  totals: { hours: number; wages: number; loadedCost: number; onClockNow: number };
}

export interface TermsInput {
  effectiveFrom: string;
  retroRebill: RetroRebill;
  overtimeBilling: OvertimeBilling;
  premiumRules: Record<PremiumKey, PremiumRule>;
  defaultMarkupPct: number | null;
  notes?: string | null;
}

/** `gapPeriods`: `start:end` of every period with billable pay on no statement, oldest first. */
export const getPayPeriods = () => apiFetch<{ periods: Array<{ periodStart: string; periodEnd: string; runs: number }>; gapPeriods?: string[] }>('/pay-bill/periods');

export function getReconciliation(periodStart: string, periodEnd: string, clientId?: string | null): Promise<ReconReport> {
  const qs = new URLSearchParams({ periodStart, periodEnd });
  if (clientId) qs.set('clientId', clientId);
  return apiFetch<ReconReport>(`/pay-bill/reconciliation?${qs.toString()}`);
}

export const getBillingAdjustments = (status?: BillingAdjustmentRow['status']) =>
  apiFetch<{ adjustments: BillingAdjustmentRow[]; truncated: boolean }>(`/pay-bill/adjustments${status ? `?status=${status}` : ''}`);

export const draftAdjustmentStatement = (clientId: string) =>
  apiFetch<{ statementId: string; clientId: string; amount: number; adjustments: number }>(`/pay-bill/clients/${clientId}/adjustment-statement`, { method: 'POST' });

export const getBillingClients = () => apiFetch<{ clients: Array<{ id: string; name: string; terms: BillingTerms }>; truncated: boolean }>('/pay-bill/clients');

export const getClientTerms = (clientId: string) =>
  apiFetch<{ client: { id: string; name: string }; current: BillingTerms; history: Array<TermsInput & { id: string; createdAt: string }> }>(`/pay-bill/clients/${clientId}/terms`);

export const saveClientTerms = (clientId: string, input: TermsInput) =>
  apiFetch<{ current: BillingTerms }>(`/pay-bill/clients/${clientId}/terms`, { method: 'PUT', body: input });

export const getRunningCost = () => apiFetch<RunningCost>('/pay-bill/running-cost');
