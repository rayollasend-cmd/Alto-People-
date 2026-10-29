import type { AssociatePaySchedule } from '@alto-people/shared';
import { apiFetch } from './api';
import type { ReadinessRequestItem } from './payrollApi';

/* ===== The payroll period ledger (finance walk 1) ======================== */

export type LedgerStatus = 'PAID' | 'DUE' | 'MISSED' | 'OFF_CYCLE' | 'EXTERNAL';

export interface LedgerPeriod {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: LedgerStatus;
  runId: string | null;
  runStatus: string | null;
  runKind: string | null;
  unpaidHours: number;
  unpaidPeople: number;
}

export interface PeriodLedger {
  asOf: string;
  schedules: Array<{ scheduleId: string; name: string; frequency: string; clientId: string | null; periods: LedgerPeriod[] }>;
  missed: { periods: number; hours: number; people: number };
  unpaid: Array<{ associateId: string; name: string; scheduleId: string; periodStart: string; periodEnd: string; payDate: string; hours: number }>;
}

export function getPeriodLedger(scheduleId?: string): Promise<PeriodLedger> {
  return apiFetch<PeriodLedger>(`/payroll/period-ledger${scheduleId ? `?scheduleId=${scheduleId}` : ''}`);
}

/* ===== Back pay: evening hours the old UTC cut missed ===================== */

export interface BackPayPunch {
  timeEntryId: string;
  workDay: string;
  hours: number;
  rate: number;
  sourceRunId: string;
  amount: number;
}

export interface BackPayPerson {
  associateId: string;
  name: string;
  punches: BackPayPunch[];
  hours: number;
  rates: number[];
  overtimeHours: number;
  overtimePremium: number;
  amount: number;
  periods: Array<{ periodStart: string; periodEnd: string }>;
  /** The open regular run it would go on; null when none is open for them. */
  target: { runId: string; periodStart: string; periodEnd: string } | null;
}

export interface BackPayOwed {
  total: number;
  people: BackPayPerson[];
  waitingForRun: number;
}

export interface BackPayAddResult {
  people: Array<{ associateId: string; name: string; amount: number; runId: string | null }>;
  total: number;
  waiting: Array<{ associateId: string; name: string; amount: number }>;
  /** Sent to a second person (202). */
  pending?: boolean;
  approvalId?: string;
}

export function getBackPay(): Promise<BackPayOwed> {
  return apiFetch<BackPayOwed>('/payroll/back-pay');
}

/** Add it to the next regular run; one key per press so a retried request never adds twice. */
export function addBackPay(associateIds?: string[]): Promise<BackPayAddResult> {
  const key = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? `backpay-${crypto.randomUUID()}` : `backpay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return apiFetch<BackPayAddResult>('/payroll/back-pay/add', { method: 'POST', body: associateIds ? { associateIds } : {}, headers: { 'Idempotency-Key': key } });
}

/* ===== Readiness: ask everyone at once (finance walk 4) =================== */

export function requestReadiness(associateIds: string[], items: ReadinessRequestItem[]): Promise<{ requested: number; skipped: Array<{ associateId: string; reason: string }> }> {
  return apiFetch('/payroll/readiness/request', { method: 'POST', body: { associateIds, items } });
}

/* ===== Close: the tax deposit (finance walk 18) =========================== */

export interface RunDeposit {
  id: string;
  status: 'PENDING' | 'PAID';
  dueDate: string;
  amount: number;
  confirmationNumber: string | null;
}

export function createRunTaxDeposit(runId: string): Promise<{ created: boolean; deposit: RunDeposit }> {
  return apiFetch(`/payroll/runs/${runId}/tax-deposit`, { method: 'POST' });
}

/* ===== The disburse dialog (finance walk 12) ============================== */

export interface DisbursePreview {
  runId: string;
  provider: { name: string; health: 'healthy' | 'idle' | 'stale' | 'erroring' | 'unconfigured' | 'stub'; detail: string; blocked: boolean };
  split: Array<{ method: 'DIRECT_DEPOSIT' | 'PAY_CARD' | 'CHECK' | 'NONE'; count: number; amount: number }>;
  arrival: { payDate: string | null; arrivesOn: string; sameDay: boolean; cutoffEt: string | null; submitBy: string | null; late: boolean } | null;
  funding: { accountLabel: string | null; last4: string | null; status: string | null; amount: number | null } | null;
  nextStep: { key: string; label: string; to: string; waitingOn: string | null } | null;
}

export function getDisbursePreview(runId: string): Promise<DisbursePreview> {
  return apiFetch<DisbursePreview>(`/payroll/runs/${runId}/disburse-preview`);
}

/* ===== The person record's Pay tab (finance walk 19) ===================== */

export interface PaySummary {
  associateId: string;
  /** A local tax rule set by hand on this person, if any. */
  localTaxRuleId: string | null;
  schedule: AssociatePaySchedule | null;
  payAccount: { rail: 'BANK_ACCOUNT' | 'PAY_CARD' | 'NONE'; last4: string | null; accountType: string | null; verified: boolean; prenoteStatus: string | null };
  paystubs: Array<{ itemId: string; runId: string; periodStart: string; periodEnd: string; runStatus: string; runKind: string; status: string; hours: number; gross: number; net: number; paidAt: string | null }>;
  ytd: { year: number; paystubs: number; gross: number; net: number; federalWithholding: number; socialSecurity: number; medicare: number; stateWithholding: number; localWithholding: number; preTaxDeductions: number; postTaxDeductions: number };
  externalPayments: number;
}

export function getPaySummary(associateId: string): Promise<PaySummary> {
  return apiFetch<PaySummary>(`/payroll/associates/${associateId}/pay-summary`);
}

/* ===== Federal W-4 facts (audit Tier 3) =================================== */

export interface FederalW4Facts {
  exempt: boolean;
  exemptTaxYear: number | null;
  nonresidentAlien: boolean;
  pre2020Allowances: number | null;
  lockIn: { filingStatus: 'SINGLE' | 'MARRIED_FILING_JOINTLY' | 'HEAD_OF_HOUSEHOLD'; multipleJobs: boolean; effectiveDate: string | null } | null;
  /** The IRS letter itself, filed in the person's documents. */
  lockInLetter?: { documentId: string; filename: string; mimeType: string; uploadedAt: string; available: boolean } | null;
  effective: { filingStatus: string | null; exempt: boolean; nonresidentAlien: boolean; pre2020Allowances: number | null; flags: string[] } | null;
}

export interface FederalW4Input {
  exempt?: boolean;
  exemptTaxYear?: number | null;
  nonresidentAlien?: boolean;
  pre2020Allowances?: number | null;
  lockIn?: { filingStatus: 'SINGLE' | 'MARRIED_FILING_JOINTLY' | 'HEAD_OF_HOUSEHOLD'; multipleJobs: boolean; effectiveDate: string } | null;
}

export function getFederalW4(associateId: string): Promise<FederalW4Facts> {
  return apiFetch<FederalW4Facts>(`/payroll/federal-w4/${associateId}`);
}

export function saveFederalW4(associateId: string, body: FederalW4Input): Promise<FederalW4Facts> {
  return apiFetch<FederalW4Facts>(`/payroll/federal-w4/${associateId}`, { method: 'PUT', body });
}

/** File the IRS lock-in letter (PDF or photo) in the person's documents. */
export async function uploadLockInLetter(associateId: string, file: File): Promise<FederalW4Facts> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/api/payroll/federal-w4/${associateId}/lock-in-letter`, { method: 'POST', credentials: 'include', body: fd });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Couldn’t upload the letter (${res.status}).`);
  }
  return res.json();
}

export const lockInLetterUrl = (associateId: string) => `/api/payroll/federal-w4/${associateId}/lock-in-letter`;

/* ===== Pay change context and the mass pay change (finance walk 13) ======= */

export interface PayChangeContext {
  associateId: string;
  current: { payType: 'HOURLY' | 'SALARY'; amount: number; effectiveFrom: string } | null;
  proposed: { payType: 'HOURLY' | 'SALARY'; amount: number; effectiveFrom: string };
  deltaPct: number | null;
  band: { name: string; min: number; mid: number; max: number; currentPct: number | null; proposedPct: number } | null;
  client: { id: string; name: string } | null;
  position: string | null;
  billRate: number | null;
  burdenPct: number;
  marginBefore: number | null;
  marginAfter: number | null;
  landsIn: { scheduleName: string; periodStart: string; periodEnd: string; payDate: string } | null;
  backPay: { from: string; through: string; hours: number; amount: number } | null;
}

export function getPayChangeContext(associateId: string, q: { payType: 'HOURLY' | 'SALARY'; amount: number; effectiveFrom: string }): Promise<PayChangeContext> {
  return apiFetch<PayChangeContext>(`/comp/associates/${associateId}/pay-change-context?payType=${q.payType}&amount=${q.amount}&effectiveFrom=${q.effectiveFrom}`);
}

export interface PayBatchFilter {
  associateIds?: string[];
  siteIds?: string[];
  departmentIds?: string[];
  clientIds?: string[];
  payrollScheduleIds?: string[];
  managerIds?: string[];
}

export interface PayBatchInput {
  filter: PayBatchFilter;
  mode: 'SET' | 'ADD' | 'PCT';
  value: number;
  effectiveFrom: string;
  reason: 'MERIT' | 'PROMOTION' | 'MARKET_ADJUSTMENT' | 'CORRECTION' | 'OTHER';
  notes?: string | null;
}

export interface PayBatchPreview {
  matched: number;
  willChange: number;
  rows: Array<{ associateId: string; name: string; payType: 'HOURLY' | 'SALARY'; from: number | null; to: number; deltaPct: number | null; billRate: number | null; marginBefore: number | null; marginAfter: number | null; belowZeroMargin: boolean; backPay: number }>;
  skipped: Array<{ associateId: string; name: string; reason: string }>;
  totals: { backPay: number; negativeMargin: number };
}

export function previewPayBatch(body: PayBatchInput): Promise<PayBatchPreview> {
  return apiFetch<PayBatchPreview>('/comp/batch/preview', { method: 'POST', body });
}

export function applyPayBatch(body: PayBatchInput): Promise<{ pending?: true; approvalId?: string; people?: number; applied?: number; skipped: PayBatchPreview['skipped'] }> {
  return apiFetch('/comp/batch', { method: 'POST', body });
}

/* ===== The executive money band (finance walk 17) ======================== */

export interface ExecutiveMoney {
  asOf: string;
  cash: { total: number; accounts: number } | null;
  lowPoint: { weekStart: string; balance: number; belowMinimum: boolean; minimumCash: number | null } | null;
  profit: { month: string; mtdNetIncome: number; ytd: { actual: number; budget: number; variance: number } | null; budgetName: string | null } | null;
  dso: Array<{ month: string; days: number | null; paid: number }>;
  payrollRuns: Array<{ runId: string; periodStart: string; periodEnd: string; people: number; gross: number; employerTaxes: number; cost: number; costPerPerson: number }>;
}

export function getExecutiveMoney(): Promise<ExecutiveMoney> {
  return apiFetch<ExecutiveMoney>('/executive/money');
}
