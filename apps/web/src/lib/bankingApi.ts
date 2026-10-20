import { apiFetch } from './api';

/* Payroll banking (API: /payroll-banking). */

export type BankRail = 'PLATFORM' | 'ACH' | 'BRANCH' | 'WISE' | 'CHECK';
export type AchSpeed = 'SAME_DAY' | 'NEXT_DAY' | 'TWO_DAY';
export type KybStatus = 'NOT_STARTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type FundingStatus = 'NOT_STARTED' | 'DRAFT' | 'AWAITING_APPROVAL' | 'SUBMITTED' | 'SETTLED' | 'RETURNED' | 'WIRE_PENDING' | 'WIRE_RECEIVED' | 'CANCELLED';
export type AccountStatus = 'UNVERIFIED' | 'MICRODEPOSITS_SENT' | 'PRENOTE_SENT' | 'VERIFIED' | 'FAILED' | 'DISABLED';

export interface BankingProfile {
  id: string;
  bankRail: BankRail;
  achSpeed: AchSpeed;
  submitCutoffEt: string;
  companyName: string | null;
  companyId: string | null;
  companyEntryDescription: string;
  immediateDestination: string | null;
  immediateDestinationName: string | null;
  immediateOrigin: string | null;
  immediateOriginName: string | null;
  originatingDfi: string | null;
  kybStatus: KybStatus;
  kybCheckedAt: string | null;
  kybNote: string | null;
  perRunLimitCents: number | null;
  perDayLimitCents: number | null;
  requirePrenote: boolean;
  collectTaxes: boolean;
  collectGarnishments: boolean;
  fundingAccountId: string | null;
  gaps: string[];
}

export interface EmployerAccount {
  id: string;
  label: string;
  bankName: string | null;
  routingNumber: string;
  accountLast4: string;
  accountType: 'CHECKING' | 'SAVINGS';
  status: AccountStatus;
  microDepositSentAt: string | null;
  attemptsLeft: number;
  verifiedAt: string | null;
  createdAt: string;
}

export interface FundingBreakdown {
  netPayCents: number;
  achPeople: number;
  otherRailNetCents: number;
  taxesCents: number;
  garnishmentsCents: number;
  feesCents: number;
}

export interface Funding {
  id: string | null;
  payrollRunId: string;
  status: FundingStatus;
  amountCents: number;
  breakdown: FundingBreakdown;
  payDate: string;
  debitEffectiveDate: string;
  fundingDeadline: string;
  achSpeed: AchSpeed;
  bankAccountId: string | null;
  approvalRequestId: string | null;
  submittedAt: string | null;
  settledAt: string | null;
  returnCode: string | null;
  returnReason: string | null;
  returnedAt: string | null;
  note: string | null;
}

export interface RunToFund {
  runId: string;
  periodStart: string;
  periodEnd: string;
  clientName: string | null;
  funding: Funding;
}

export interface BankingSummary {
  profile: BankingProfile;
  connection: { id: string; provider: string; environment: string; name: string } | null;
  accounts: EmployerAccount[];
  runs: RunToFund[];
  openReturns: number;
  sameDayWindows: Array<{ submitBy: string; settles: string; label: string }>;
}

export interface AchFileRow {
  id: string;
  purpose: 'FUNDING' | 'DIRECT_DEPOSIT' | 'PRENOTE' | 'MICRODEPOSIT' | 'GARNISHMENT' | 'VENDOR';
  provider: string;
  status: string;
  effectiveDate: string;
  sameDay: boolean;
  entryCount: number;
  totalDebitCents: number;
  totalCreditCents: number;
  payrollRunId: string | null;
  createdAt: string;
  submittedAt: string | null;
  error: string | null;
  returns: number;
}

export interface AchEntryRow {
  id: string;
  traceNumber: string;
  kind: string;
  purpose: string;
  effectiveDate: string;
  amountCents: number;
  name: string;
  accountLast4: string;
  status: string;
  returnCode: string | null;
  returnedAt: string | null;
  nocCode: string | null;
  nocAppliedAt: string | null;
  payrollItemId: string | null;
}

export interface CalendarRow {
  scheduleId: string;
  scheduleName: string;
  periodStart: string;
  periodEnd: string;
  nominalPayDate: string;
  payDate: string;
  shiftReason: string | null;
  creditSubmitDate: string;
  debitEffectiveDate: string;
  fundingDeadline: string;
}

export interface PayrollCalendar {
  year: number;
  achSpeed: AchSpeed;
  cutoffEt: string;
  holidays: Array<{ date: string; name: string; source: 'FEDERAL_RESERVE' | 'OVERRIDE'; closed: boolean }>;
  rows: CalendarRow[];
  overrides: Array<{ id: string; date: string; name: string; closed: boolean }>;
}

export interface DepositAccount {
  id: string;
  associateId: string;
  name: string;
  accountLast4: string | null;
  accountType: string | null;
  bankName: string | null;
  isPrimary: boolean;
  verified: boolean;
  split: { kind: string; amountCents: number | null; percent: number | null } | null;
  prenoteStatus: 'SENT' | 'CLEARED' | 'RETURNED' | null;
  prenoteSentAt: string | null;
}

const B = '/payroll-banking';

export const getBankingSummary = () => apiFetch<BankingSummary>(`${B}/summary`);
export const updateBankingProfile = (body: Partial<Omit<BankingProfile, 'id' | 'gaps' | 'kybCheckedAt' | 'fundingAccountId'>>) =>
  apiFetch<{ profile: BankingProfile; pending?: true; approvalId?: string; title?: string }>(`${B}/profile`, { method: 'PUT', body });

export const addEmployerAccount = (body: { label: string; bankName?: string | null; routingNumber: string; accountNumber: string; accountType: 'CHECKING' | 'SAVINGS' }) =>
  apiFetch<{ account: EmployerAccount }>(`${B}/accounts`, { method: 'POST', body });
export const startVerification = (id: string, method: 'MICRODEPOSITS' | 'PRENOTE') =>
  apiFetch<{ status: AccountStatus; account: EmployerAccount }>(`${B}/accounts/${id}/verify`, { method: 'POST', body: { method } });
export const confirmDeposits = (id: string, amounts: [number, number]) =>
  apiFetch<{ status: AccountStatus; attemptsLeft: number; account: EmployerAccount }>(`${B}/accounts/${id}/confirm`, { method: 'POST', body: { amounts } });
export const setFundingAccount = (id: string) => apiFetch<{ profile: BankingProfile }>(`${B}/accounts/${id}/funding`, { method: 'POST', body: {} });
export const disableAccount = (id: string) => apiFetch<void>(`${B}/accounts/${id}`, { method: 'DELETE' });

export const getRunFunding = (runId: string) => apiFetch<{ applies: boolean; funding: Funding | null }>(`${B}/runs/${runId}/funding`);
export const pullFunding = (runId: string) =>
  apiFetch<{ funding: Funding; pending?: true; approvalId?: string; title?: string }>(`${B}/runs/${runId}/funding`, { method: 'POST', body: {}, headers: { 'Idempotency-Key': `fund-${runId}-${Date.now()}` } });
export const recordWire = (runId: string, state: 'WIRE_PENDING' | 'WIRE_RECEIVED', note: string) =>
  apiFetch<{ funding: Funding }>(`${B}/runs/${runId}/wire`, { method: 'POST', body: { state, note } });

export const listAchFiles = () => apiFetch<{ files: AchFileRow[] }>(`${B}/files`);
export const listAchEntries = () => apiFetch<{ entries: AchEntryRow[] }>(`${B}/entries`);
export const uploadReturnFile = (content: string) =>
  apiFetch<{ returned: number; corrected: number; unknown: number; total: number }>(`${B}/returns`, { method: 'POST', body: { content } });
export const sendPrenotes = () => apiFetch<{ sent: number; file: string | null }>(`${B}/prenotes`, { method: 'POST', body: {} });
export const getDeposits = () =>
  apiFetch<{ counts: { cleared: number; sent: number; returned: number; due: number; unverified: number; split: number }; accounts: DepositAccount[] }>(`${B}/deposits`);

export const getPayrollCalendar = (year: number) => apiFetch<PayrollCalendar>(`${B}/calendar?year=${year}`);
export const addHolidayOverride = (body: { date: string; name: string; closed: boolean }) => apiFetch(`${B}/holidays`, { method: 'POST', body });
export const removeHolidayOverride = (id: string) => apiFetch<void>(`${B}/holidays/${id}`, { method: 'DELETE' });

export async function downloadAchFile(id: string): Promise<void> {
  const res = await fetch(`/api${B}/files/${id}/download`, { credentials: 'include' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'The download failed.');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const a = document.createElement('a');
  a.href = url;
  a.download = m?.[1] ?? 'ach.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ----- plain-language helpers ---------------------------------------------- */

export const centsToMoney = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** "4:00 PM ET Tue, Oct 13" — the funding deadline is always Eastern (the Fed's clock). */
export function etDeadline(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const day = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  return `${time} ET ${day}`;
}

/** "4:00 PM" for a 24-hour "16:00". */
export function clockText(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Fri, Oct 16" for a YYYY-MM-DD. */
export function shortDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

/** The one sentence a run's funding comes down to. */
export function fundingSentence(f: Funding, now = new Date()): string {
  const amount = centsToMoney(f.amountCents);
  switch (f.status) {
    case 'NOT_STARTED':
    case 'DRAFT':
      return new Date(f.fundingDeadline) < now
        ? `The deadline to pull ${amount} for ${shortDay(f.payDate)} pay has passed — pull it now and pay goes out a day later, or wire it.`
        : `Fund ${amount} by ${etDeadline(f.fundingDeadline)} for ${shortDay(f.payDate)} pay.`;
    case 'AWAITING_APPROVAL':
      return `${amount} is over a funding limit and waits for a second person.`;
    case 'SUBMITTED':
      return `${amount} is on its way from your account and settles ${shortDay(f.debitEffectiveDate)}. Pay goes out after that.`;
    case 'SETTLED':
      return `${amount} arrived. ${shortDay(f.payDate)} pay is ready to send.`;
    case 'RETURNED':
      return `The bank returned the ${amount} debit${f.returnCode ? ` (${f.returnCode})` : ''}: ${f.returnReason ?? 'see details'}. Wire it or pull again.`;
    case 'WIRE_PENDING':
      return `Waiting for a ${amount} wire. Mark it received when it lands.`;
    case 'WIRE_RECEIVED':
      return `The ${amount} wire arrived. ${shortDay(f.payDate)} pay is ready to send.`;
    default:
      return `This run’s funding was cancelled.`;
  }
}

export const FUNDING_LABEL: Record<FundingStatus, string> = {
  NOT_STARTED: 'Not pulled',
  DRAFT: 'Not pulled',
  AWAITING_APPROVAL: 'Needs approval',
  SUBMITTED: 'On its way',
  SETTLED: 'Funded',
  RETURNED: 'Returned',
  WIRE_PENDING: 'Wire expected',
  WIRE_RECEIVED: 'Funded by wire',
  CANCELLED: 'Cancelled',
};
