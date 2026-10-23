import { apiFetch } from './api';

/**
 * PAYEXP (apps/api/src/routes/payExp.ts): daily pay, manual checks,
 * third-party sick pay, "check my pay before payday", the W-4 estimator,
 * and the bonus gross-up quote.
 */

/* ---- Daily pay ---- */

export type DailyPayTiming = 'SAME_DAY' | 'NEXT_DAY';
export type DailyPayEligibility = 'ENROLLED' | 'EVERYONE';

export interface DailyPayPolicy {
  status: 'OFF' | 'PENDING' | 'ACTIVE';
  timing: DailyPayTiming;
  eligibility: DailyPayEligibility;
  feeCents: number;
  dailyCapCents: number;
  pending: { timing?: DailyPayTiming; eligibility?: DailyPayEligibility; feeCents?: number; dailyCapCents?: number } | null;
  approvalId: string | null;
  approvedAt: string | null;
  lastRunAt: string | null;
}

export interface DailySettlement {
  itemId: string;
  runId: string;
  associateId: string;
  name: string;
  workDate: string;
  gross: number;
  net: number;
  status: 'PENDING' | 'DISBURSED' | 'FAILED' | 'HELD' | 'VOIDED';
  reason: string | null;
  createdAt: string;
}

export interface DailyPayDesk {
  policy: DailyPayPolicy;
  enrolled: Array<{ associateId: string; name: string; enrolledAt: string }>;
  enrolledCount: number;
  truncated: boolean;
  dailySchedulePeople: number;
  recent: DailySettlement[];
}

export const getDailyPayDesk = () => apiFetch<DailyPayDesk>('/payroll/daily-pay');

export const requestDailyPayPolicy = (body: { enable: boolean; timing?: DailyPayTiming; eligibility?: DailyPayEligibility; feeCents?: number; dailyCapCents?: number }) =>
  apiFetch<{ applied: boolean; pending: boolean; approvalId: string | null; policy: DailyPayPolicy }>('/payroll/daily-pay/policy', { method: 'PUT', body });

export const setDailyPayEnrollment = (associateId: string, enrolled: boolean) =>
  apiFetch<{ ok: true }>('/payroll/daily-pay/enroll', { method: 'POST', body: { associateId, enrolled } });

export interface DailyPayRunSummary {
  ran: boolean;
  reason?: 'OFF' | 'NOT_YET';
  paid: Array<{ associateId: string; workDate: string; gross: number; net: number; status: string }>;
  held: Array<{ associateId: string; workDate: string; reason: string }>;
  skipped: Array<{ associateId: string; reason: string }>;
}
export const runDailyPayNow = () => apiFetch<DailyPayRunSummary>('/payroll/daily-pay/run', { method: 'POST' });

export interface MyDailyPay {
  active: boolean;
  timing: DailyPayTiming;
  feeCents: number;
  enrolled: boolean;
  onDailySchedule: boolean;
  canOptIn: boolean;
}
export const getMyDailyPay = () => apiFetch<MyDailyPay>('/me/daily-pay');
export const setMyDailyPay = (enrolled: boolean) => apiFetch<{ ok: true }>('/me/daily-pay', { method: 'POST', body: { enrolled } });

/* ---- Manual checks and third-party sick pay ---- */

export interface ManualCheckRow {
  itemId: string;
  runId: string;
  associateId: string;
  associateName: string;
  checkNumber: string;
  payDate: string | null;
  gross: number;
  taxes: number;
  net: number;
  status: 'RECORDED' | 'VOIDED';
  voidReason: string | null;
  replacesItemId: string | null;
}

export interface SickPayRow {
  id: string;
  associateId: string;
  associateName: string;
  payerName: string;
  payDate: string;
  grossAmount: number;
  nontaxableAmount: number;
  federalWithheld: number;
  socialSecurityWithheld: number;
  medicareWithheld: number;
  stateWithheld: number;
  employerTaxesBy: 'EMPLOYER' | 'INSURER';
  w2ReportedBy: 'EMPLOYER' | 'INSURER';
  voided: boolean;
}

export const getManualChecks = () => apiFetch<{ checks: ManualCheckRow[]; sickPay: SickPayRow[] }>('/payroll/manual-checks');

export interface ManualCheckInput {
  associateId: string;
  checkNumber: string;
  payDate: string;
  earningKind?: 'REGULAR' | 'OVERTIME' | 'BONUS' | 'COMMISSION' | 'HOLIDAY' | 'SICK' | 'VACATION';
  hours?: number | null;
  gross: number;
  preTaxDeductions?: number;
  federal: number;
  socialSecurity: number;
  medicare: number;
  state: number;
  local?: number;
  postTaxDeductions?: number;
  net: number;
  memo?: string | null;
  replacesItemId?: string | null;
}
export const recordManualCheck = (body: ManualCheckInput) => apiFetch<{ runId: string; itemId: string }>('/payroll/manual-checks', { method: 'POST', body });
export const voidManualCheck = (runId: string, reason: string) => apiFetch<{ ok: true }>(`/payroll/manual-checks/${runId}/void`, { method: 'POST', body: { reason } });

export interface SickPayInput {
  associateId: string;
  payerName: string;
  payDate: string;
  grossAmount: number;
  nontaxableAmount?: number;
  federalWithheld?: number;
  socialSecurityWithheld?: number;
  medicareWithheld?: number;
  stateWithheld?: number;
  employerTaxesBy: 'EMPLOYER' | 'INSURER';
  w2ReportedBy: 'EMPLOYER' | 'INSURER';
  notes?: string | null;
}
export const recordSickPay = (body: SickPayInput) =>
  apiFetch<{ id: string; employerTaxes: { fica: number; medicare: number; futa: number; suta: number } }>('/payroll/sick-pay', { method: 'POST', body });
/** Void a sick pay record; the reason goes on the audit record (asked in the page's prompt). */
export const voidSickPay = (id: string, reason?: string) => apiFetch<{ ok: true }>(`/payroll/sick-pay/${id}/void`, { method: 'POST', body: reason ? { reason } : {} });

/* ---- Check my pay before payday ---- */

export interface PreviewFlag {
  line: string;
  kind: 'HOURS' | 'MISSING_DAY' | 'RATE' | 'TAX' | 'DEDUCTION' | 'OTHER';
  note: string;
  at: string;
  caseId?: string | null;
  correctionId?: string | null;
}

export interface PayPreview {
  available: boolean;
  reason: 'NO_SCHEDULE' | 'NOT_YET' | null;
  payDate: string | null;
  opensOn: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  source: 'RUN' | 'ESTIMATE';
  days: Array<{ date: string; hours: number; entries: Array<{ id: string; clockInAt: string; clockOutAt: string | null; siteName: string | null; approved: boolean }> }>;
  earnings: Array<{ line: string; kind: string; hours: number | null; rate: number | null; amount: number }>;
  gross: number;
  taxes: Array<{ line: string; kind: 'FEDERAL' | 'SOCIAL_SECURITY' | 'MEDICARE' | 'STATE' | 'LOCAL'; amount: number }>;
  deductions: Array<{ line: string; kind: 'PRE_TAX' | 'POST_TAX'; amount: number }>;
  paidAhead: number;
  net: number;
  check: { status: 'CONFIRMED' | 'FLAGGED'; flags: PreviewFlag[]; at: string } | null;
}

export const getMyPayPreview = () => apiFetch<PayPreview>('/me/pay-preview');
export const confirmMyPayPreview = () => apiFetch<PayPreview>('/me/pay-preview/confirm', { method: 'POST' });
export const flagMyPayPreview = (body: { line: string; kind: PreviewFlag['kind']; note: string; timeEntryId?: string | null; proposedClockIn?: string | null; proposedClockOut?: string | null }) =>
  apiFetch<{ preview: PayPreview; routedTo: 'LEAD' | 'PAYROLL'; caseId: string | null; correctionId: string | null }>('/me/pay-preview/flag', { method: 'POST', body });

export interface PayChecksSummary {
  run: { id: string; periodStart: string; periodEnd: string };
  people: number;
  confirmed: number;
  flagged: number;
  openFlags: number;
  unanswered: number;
  confirmationRate: number;
  open: Array<{ associateId: string; name: string; flags: PreviewFlag[] }>;
}
export const getPayChecks = (runId: string) => apiFetch<PayChecksSummary>(`/payroll/pay-checks?run=${encodeURIComponent(runId)}`);
export const resolvePayCheckFlags = (runId: string, associateId: string) => apiFetch<{ ok: true }>('/payroll/pay-checks/resolve', { method: 'POST', body: { runId, associateId } });

/* ---- W-4 estimator ---- */

export type FilingStatus = 'SINGLE' | 'MARRIED_FILING_JOINTLY' | 'HEAD_OF_HOUSEHOLD';

export interface W4EstimatorContext {
  payFrequency: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';
  payPerPeriod: number;
  periodsRemaining: number;
  ytdWages: number;
  ytdFederalWithheld: number;
  current: { filingStatus: FilingStatus; multipleJobs: boolean; dependentsAmount: number; otherIncome: number; deductions: number; extraWithholding: number } | null;
}

export interface W4EstimateInput {
  filingStatus: FilingStatus;
  payFrequency: W4EstimatorContext['payFrequency'];
  payPerPeriod: number;
  periodsRemaining: number;
  ytdWages: number;
  ytdFederalWithheld: number;
  otherJobsAnnual?: number;
  otherJobsWithheldAnnual?: number;
  otherIncome?: number;
  deductionsAboveStandard?: number;
  childrenUnder17?: number;
  otherDependents?: number;
}

export interface W4Projection {
  perCheck: number;
  yearWithholding: number;
  refund: number;
}

export interface W4EstimateResult {
  yearWages: number;
  yearIncome: number;
  estimatedTax: number;
  credits: number;
  asIs: W4Projection | null;
  suggested: { filingStatus: FilingStatus; multipleJobs: boolean; dependentsAmount: number; otherIncome: number; deductions: number; extraWithholding: number };
  withSuggested: W4Projection;
}

export const getW4EstimatorContext = () => apiFetch<W4EstimatorContext>('/me/w4-estimator');
export const estimateMyW4 = (body: W4EstimateInput) => apiFetch<W4EstimateResult>('/me/w4-estimator', { method: 'POST', body });

/* ---- Gross-up ---- */

export interface GrossUpBreakdown {
  targetNet: number;
  gross: number;
  preTax: number;
  federal: number;
  socialSecurity: number;
  medicare: number;
  state: number;
  local: number;
  net: number;
  stateMethod: 'NONE' | 'SUPPLEMENTAL_RATE' | 'FLAT_STATE' | 'AGGREGATE';
  federalMethod: 'SUPPLEMENTAL_22' | 'SUPPLEMENTAL_37_OVER_1M' | 'MIXED';
}

export const quoteGrossUp = (body: { associateId: string; targetNet: number; includePreTax?: boolean; runId?: string | null }) =>
  apiFetch<{ breakdown: GrossUpBreakdown; electedPreTaxPercent: number; state: string | null }>('/payroll/gross-up/quote', { method: 'POST', body });
