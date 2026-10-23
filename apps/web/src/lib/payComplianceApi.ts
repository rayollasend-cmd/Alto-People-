import { apiFetch } from './api';

/** Pay compliance (2026): limits + Roth catch-up, pay notices, new-hire reports. */

export interface YearLimits {
  year: number;
  deferral402g: number;
  catchUp50: number;
  superCatchUp60to63: number;
  hsaSelf: number;
  hsaFamily: number;
  hsaCatchUp55: number;
  healthFsa: number;
  dependentCareFsa: number;
  rothCatchUpWageThreshold: number;
  fallback: boolean;
}

export type RothCatchUpStatus = 'NOT_ELIGIBLE' | 'AGE_UNKNOWN' | 'PRE_TAX_OR_ROTH' | 'ROTH_BY_ELECTION' | 'ROTH_DEEMED' | 'CATCH_UP_STOPPED';

export interface RothCatchUpRow {
  associateId: string;
  name: string;
  plan: string;
  planKind: string;
  rothElection: boolean;
  planAllowsDeemedRoth: boolean;
  age: number | null;
  status: RothCatchUpStatus;
  higherEarner: boolean;
  catchUpAllowance: number;
  priorYearFicaWages: number | null;
  threshold: number;
  ytdDeferred: number | null;
  annualLimit: number;
}

export const ROTH_STATUS_LABEL: Record<RothCatchUpStatus, string> = {
  NOT_ELIGIBLE: 'Under 50',
  AGE_UNKNOWN: 'Birth date missing',
  PRE_TAX_OR_ROTH: 'Catch-up can be pre-tax',
  ROTH_BY_ELECTION: 'Catch-up is Roth (elected)',
  ROTH_DEEMED: 'Catch-up made Roth automatically',
  CATCH_UP_STOPPED: 'Catch-up stopped: plan has no Roth',
};

export function getRothCatchUp(year?: number) {
  return apiFetch<{ year: number; limits: YearLimits; people: RothCatchUpRow[] }>(`/pay-compliance/roth-catch-up${year ? `?year=${year}` : ''}`);
}

export function getPersonRothCatchUp(associateId: string) {
  return apiFetch<{ year: number; plans: RothCatchUpRow[] }>(`/pay-compliance/people/${associateId}/roth-catch-up`);
}

export interface WageStatementRuleView {
  state: string;
  citation: string;
  elements: Array<{ key: string; label: string }>;
}

export interface NoticeRuleView {
  state: string;
  citation: string;
  triggers: string[];
  stateLanguages: string[];
  coversExempt: boolean;
}

export function getWageStatementRules() {
  return apiFetch<{ rules: WageStatementRuleView[]; noticeRules: NoticeRuleView[] }>('/pay-compliance/wage-statement-rules');
}

export interface PayNotice {
  id: string;
  associateId: string;
  name: string;
  state: string;
  form: string;
  formTitle: string;
  trigger: 'HIRE' | 'RATE_CHANGE' | 'MANUAL';
  language: string;
  status: 'SENT' | 'ACKNOWLEDGED';
  sentAt: string;
  acknowledgedAt: string | null;
  signedName: string | null;
  overdue: boolean;
  missing: string[];
  untranslatedLanguage: string | null;
}

export function listPayNotices() {
  return apiFetch<{ notices: PayNotice[]; truncated: boolean }>('/pay-compliance/pay-notices');
}

export function issuePayNotice(associateId: string) {
  return apiFetch<{ notice: PayNotice }>('/pay-compliance/pay-notices', { method: 'POST', body: { associateId } });
}

export function remindPayNotice(id: string) {
  return apiFetch<{ ok: true }>(`/pay-compliance/pay-notices/${id}/remind`, { method: 'POST' });
}

export function listMyPayNotices() {
  return apiFetch<{ notices: PayNotice[] }>('/me/pay-notices');
}

export interface PayNoticeDetail {
  notice: PayNotice;
  sections: Array<{ language: string; lines: Array<{ label: string; value: string }> }>;
}

export function getMyPayNotice(id: string) {
  return apiFetch<PayNoticeDetail>(`/me/pay-notices/${id}`);
}

export function acknowledgeMyPayNotice(id: string, signedName: string) {
  return apiFetch<{ notice: PayNotice }>(`/me/pay-notices/${id}/acknowledge`, { method: 'POST', body: { signedName } });
}

/** How new hires get filed here today: an electronic service, or the CSV a person uploads at the state portal. */
export interface NewHireFilingStatus {
  kind: 'ELECTRONIC' | 'MANUAL_UPLOAD';
  provider: { key: string; label: string };
  configured: boolean;
  note: string;
}

export interface NewHireReportRow {
  id: string;
  associateId: string;
  name: string;
  state: string;
  hireDate: string | null;
  dueDate: string | null;
  deadlineDays: number;
  confirmDeadlineWithState: boolean;
  status: 'DUE' | 'SUBMITTED';
  overdue: boolean;
  method: string | null;
  confirmation: string | null;
  submittedAt: string | null;
  blockedBy: string[];
  /** The same gaps, split: the person's (fix on their record) and the employer's (fix once, in Employers). */
  missing?: { person: Array<'ssn' | 'address'>; employer: Array<'ein' | 'address'> };
  /** The employer of record, when something blocks the report. */
  employer?: { id: string; name: string } | null;
  filingService: string | null;
}

export function listNewHireReports() {
  return apiFetch<{ reports: NewHireReportRow[]; truncated: boolean; filing: NewHireFilingStatus }>('/pay-compliance/new-hire-reports');
}

export function getNewHireSettings() {
  return apiFetch<{ multistateState: string | null }>('/pay-compliance/new-hire-settings');
}

export function setNewHireSettings(multistateState: string | null) {
  return apiFetch<{ multistateState: string | null }>('/pay-compliance/new-hire-settings', { method: 'PUT', body: { multistateState } });
}

export function markNewHireReportsSubmitted(reportIds: string[], confirmation: string | null) {
  return apiFetch<{ marked: number }>('/pay-compliance/new-hire-reports/submit', { method: 'POST', body: { reportIds, confirmation } });
}

export function fileNewHireReports(state: string) {
  return apiFetch<{ filed: number; confirmation: string; blocked: number }>('/pay-compliance/new-hire-reports/file', { method: 'POST', body: { state } });
}

/** Downloads the state's file; resolves to the report ids it carried. */
export async function downloadNewHireFile(state: string): Promise<string[]> {
  const res = await fetch(`/api/pay-compliance/new-hire-reports/file.csv?state=${encodeURIComponent(state)}`, { credentials: 'include' });
  if (!res.ok) {
    let message = 'Download failed.';
    try {
      const data = await res.json();
      if (data?.error?.message) message = data.error.message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const ids = (res.headers.get('x-report-ids') ?? '').split(',').filter(Boolean);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `new-hire-${state}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return ids;
}
