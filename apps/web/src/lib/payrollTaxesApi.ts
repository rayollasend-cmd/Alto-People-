import { apiFetch } from './api';

/* The payroll-tax desk (API: /payroll-taxes). */

export type AgencyKind = 'FEDERAL_WITHHOLDING' | 'FEDERAL_UNEMPLOYMENT' | 'STATE_WITHHOLDING' | 'STATE_UNEMPLOYMENT' | 'LOCAL';
export type LiabilityStatus = 'OPEN' | 'SCHEDULED' | 'PAID' | 'VOID';
export type PaymentStatus = 'SCHEDULED' | 'SUBMITTED' | 'PAID' | 'FAILED' | 'CANCELLED';
export type ReturnStatus = 'DRAFT' | 'SUBMITTED' | 'FILED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED';
export type NoticeStatus = 'NEW' | 'IN_REVIEW' | 'RESPONDED' | 'RESOLVED';
export type ReturnKind = 'F941' | 'F940' | 'STATE_WH_QUARTERLY' | 'STATE_WH_ANNUAL' | 'SUI_WAGE_REPORT' | 'STATE_PROGRAM_REPORT' | 'LOCAL_QUARTERLY' | 'F941X' | 'STATE_AMENDED';
export type DepositFrequency = 'NEXT_DAY' | 'SEMIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

export interface DepositLine {
  kind: AgencyKind;
  jurisdiction: string;
  agency: string;
  dueDate: string;
  amount: number;
  liabilities: number;
  scheduled: number;
  accountId: string | null;
}

export interface ChecklistReturn {
  kind: ReturnKind;
  label: string;
  jurisdiction: string;
  agency: string;
  periodLabel: string;
  dueDate: string | null;
  returnId: string | null;
  status: ReturnStatus | 'NOT_STARTED';
}

export interface RegistrationNeed {
  kind: AgencyKind;
  jurisdiction: string;
  agencyName: string;
  accountId: string | null;
  reason: string;
  steps: string[];
}

export interface TaxOverview {
  today: string;
  filing: { mode: 'PROVIDER' | 'IN_HOUSE'; providerLabel: string | null; penaltyGuarantee: boolean; environment: string | null };
  totals: { owedOpen: number; overdue: number; dueSoon: number; failedPayments: number; openNotices: number };
  overdue: DepositLine[];
  dueSoon: DepositLine[];
  upcoming: DepositLine[];
  returns: { previous: { periodLabel: string; items: ChecklistReturn[] }; current: { periodLabel: string; items: ChecklistReturn[] } };
  registrations: RegistrationNeed[];
  noticesDue: Array<{ id: string; agencyName: string; noticeType: string; responseDueAt: string | null; amountDue: number | null }>;
  /** This quarter's posted taxes (withheld and employer share) and how much of it is deposited. */
  quarter?: { periodLabel: string; posted: number; deposited: number };
  /** Payroll has posted at least one tax here. */
  hasLiabilities?: boolean;
  /** Paid payrolls whose taxes never posted to the desk. */
  unposted?: { count: number; amount: number; runs: UnpostedRun[] };
}

export interface UnpostedRun {
  id: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidOn: string | null;
  amount: number;
  /** Its stored totals say it withheld tax, but it has no paid paychecks to post them from. */
  paychecksMissing: boolean;
}

export interface Liability {
  id: string;
  kind: AgencyKind;
  kindLabel: string;
  jurisdiction: string;
  agency: string;
  accountId: string | null;
  payrollRunId: string | null;
  payPeriod: string | null;
  periodLabel: string;
  liabilityDate: string;
  dueDate: string;
  amount: number;
  breakdown: Record<string, number> | null;
  status: LiabilityStatus;
  paymentId: string | null;
}

export interface TaxPayment {
  id: string;
  kind: AgencyKind;
  kindLabel: string;
  jurisdiction: string;
  agency: string;
  accountId: string | null;
  periodLabel: string;
  amount: number;
  dueDate: string;
  method: 'PROVIDER' | 'EFTPS' | 'STATE_PORTAL' | 'LOCAL_PORTAL';
  status: PaymentStatus;
  providerRef: string | null;
  confirmationNumber: string | null;
  submittedAt: string | null;
  paidAt: string | null;
  late: boolean;
  failureReason: string | null;
  createdAt: string;
}

export interface TaxReturn {
  id: string;
  kind: ReturnKind;
  label: string;
  jurisdiction: string;
  agency: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  status: ReturnStatus;
  method: string | null;
  providerRef: string | null;
  confirmationNumber: string | null;
  filedAt: string | null;
  rejectionReason: string | null;
  amendsId: string | null;
  totals: Record<string, number>;
  delta: Record<string, number> | null;
  notes: string[];
  rowCount: number;
  rows?: Array<Record<string, string | number | null>>;
  createdAt: string;
}

export interface ReconLine {
  kind: AgencyKind;
  jurisdiction: string;
  agencyLabel: string;
  posted: number;
  paid: number;
  open: number;
  latePayments: number;
  returnKind: ReturnKind | null;
  returnTax: number | null;
  returnStatus: string | null;
  flags: string[];
}

export interface AgencyAccount {
  id: string;
  employerOrgId: string | null;
  kind: AgencyKind;
  kindLabel: string;
  jurisdiction: string;
  agencyName: string;
  accountNumber: string | null;
  depositFrequency: DepositFrequency;
  dueDayOfMonth: number;
  rate: number | null;
  rateYear: number | null;
  wageBase: number | null;
  status: 'ACTIVE' | 'PENDING_REGISTRATION' | 'CLOSED';
  effectiveFrom: string | null;
  effectiveTo: string | null;
  notes: string | null;
}

export interface AgencySummary {
  kind: AgencyKind;
  jurisdiction: string;
  agency: string;
  accountStatus: string | null;
  accountNumber: string | null;
  depositFrequency: string | null;
  open: number;
  paid: number;
  nextDue: string | null;
}

export interface NoticeListItem {
  id: string;
  accountId: string | null;
  agencyName: string;
  jurisdiction: string | null;
  noticeType: string;
  noticeNumber: string | null;
  noticeDate: string;
  periodLabel: string | null;
  amountDue: number | null;
  responseDueAt: string | null;
  status: NoticeStatus;
  assignedToId: string | null;
  hasFile: boolean;
  fileName: string | null;
  penaltyAmount: number | null;
  abatedAmount: number | null;
}

export interface NoticeDetail extends NoticeListItem {
  assignedToName: string | null;
  summary: string | null;
  response: string | null;
  respondedAt: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  events: Array<{ at: string; by: string | null; byName: string | null; what: string }>;
  evidence: { liabilities: number; paid: number; payments: TaxPayment[] } | null;
  createdAt: string;
}

export interface NoticeDashboard {
  open: number;
  overdueResponses: number;
  amountInDispute: number;
  penalties: number;
  abated: number;
}

const B = '/payroll-taxes';

export const getTaxOverview = () => apiFetch<TaxOverview>(`${B}/overview`);
export const listAgencies = () => apiFetch<{ agencies: AgencySummary[] }>(`${B}/agencies`);
export const getAgency = (kind: AgencyKind, jurisdiction: string) =>
  apiFetch<{ kind: AgencyKind; kindLabel: string; jurisdiction: string; agency: string; accounts: AgencyAccount[]; liabilities: Liability[]; payments: TaxPayment[]; returns: TaxReturn[]; notices: NoticeListItem[] }>(
    `${B}/agencies/${kind}/${encodeURIComponent(jurisdiction)}`,
  );

export const listLiabilities = (q: { status?: LiabilityStatus; kind?: AgencyKind; jurisdiction?: string; period?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => !!v) as Array<[string, string]>).toString();
  return apiFetch<{ liabilities: Liability[] }>(`${B}/liabilities${qs ? `?${qs}` : ''}`);
};
export const rebuildLiabilities = (from: string, to: string) => apiFetch<{ runs: number; postings: number }>(`${B}/liabilities/rebuild`, { method: 'POST', body: { from, to } });

export const listPayments = (status?: PaymentStatus) => apiFetch<{ payments: TaxPayment[] }>(`${B}/payments${status ? `?status=${status}` : ''}`);
export const createTaxPayment = (liabilityIds: string[]) =>
  apiFetch<{ payment: TaxPayment; pending: { approvalId: string; title: string } | null }>(`${B}/payments`, { method: 'POST', body: { liabilityIds } });
export const markTaxPaymentPaid = (id: string, confirmationNumber: string, paidOn?: string) =>
  apiFetch<{ payment: TaxPayment }>(`${B}/payments/${id}/mark-paid`, { method: 'POST', body: { confirmationNumber, paidOn: paidOn || null } });
export const cancelTaxPayment = (id: string) => apiFetch<{ payment: TaxPayment }>(`${B}/payments/${id}/cancel`, { method: 'POST', body: {} });
export const retryTaxPayment = (id: string) => apiFetch<{ payment: TaxPayment }>(`${B}/payments/${id}/retry`, { method: 'POST', body: {} });
export const refreshTaxPayments = () => apiFetch<{ changed: number }>(`${B}/payments/refresh`, { method: 'POST', body: {} });

export const listReturns = (period?: string) => apiFetch<{ periodLabel: string; checklist: ChecklistReturn[]; returns: TaxReturn[] }>(`${B}/returns${period ? `?period=${period}` : ''}`);
export const getReturn = (id: string) => apiFetch<{ return: TaxReturn; amendments: TaxReturn[] }>(`${B}/returns/${id}`);
export const generateTaxReturn = (kind: ReturnKind, jurisdiction: string, periodLabel: string) =>
  apiFetch<{ return: TaxReturn }>(`${B}/returns/generate`, { method: 'POST', body: { kind, jurisdiction, periodLabel } });
export const fileTaxReturn = (id: string, method: 'PROVIDER' | 'MANUAL', confirmationNumber?: string) =>
  apiFetch<{ return: TaxReturn }>(`${B}/returns/${id}/file`, { method: 'POST', body: { method, ...(confirmationNumber ? { confirmationNumber } : {}) } });
export const recordReturnOutcome = (id: string, outcome: 'ACCEPTED' | 'REJECTED', reason?: string) =>
  apiFetch<{ return: TaxReturn }>(`${B}/returns/${id}/outcome`, { method: 'POST', body: { outcome, ...(reason ? { reason } : {}) } });
export const amendTaxReturn = (id: string) => apiFetch<{ return: TaxReturn }>(`${B}/returns/${id}/amend`, { method: 'POST', body: {} });

export const getReconciliation = (period?: string) => apiFetch<{ periodLabel: string; lines: ReconLine[]; clean: boolean }>(`${B}/reconciliation${period ? `?period=${period}` : ''}`);

export const listTaxAccounts = () => apiFetch<{ accounts: AgencyAccount[] }>(`${B}/accounts`);
export type AccountInput = Partial<Omit<AgencyAccount, 'id' | 'kindLabel'>> & { kind?: AgencyKind; jurisdiction?: string };
export const createTaxAccount = (body: AccountInput) => apiFetch<{ account: AgencyAccount }>(`${B}/accounts`, { method: 'POST', body });
export const updateTaxAccount = (id: string, body: AccountInput) => apiFetch<{ account: AgencyAccount }>(`${B}/accounts/${id}`, { method: 'PATCH', body });

export const listNotices = (status?: NoticeStatus | 'ACTIVE') => apiFetch<{ notices: NoticeListItem[]; dashboard: NoticeDashboard }>(`${B}/notices${status ? `?status=${status}` : ''}`);
export const getNotice = (id: string) => apiFetch<{ notice: NoticeDetail }>(`${B}/notices/${id}`);
export const updateNotice = (
  id: string,
  body: Partial<{ status: NoticeStatus; assignedToId: string | null; responseDueAt: string | null; response: string | null; resolution: string | null; penaltyAmount: number | null; abatedAmount: number | null; amountDue: number | null; note: string }>,
) => apiFetch<{ notice: NoticeDetail }>(`${B}/notices/${id}`, { method: 'PATCH', body });
export const listTaxAssignees = () => apiFetch<{ assignees: Array<{ id: string; name: string }> }>(`${B}/assignees`);

export interface NoticeInput {
  agencyName: string;
  noticeType: string;
  noticeDate: string;
  accountId?: string;
  jurisdiction?: string;
  noticeNumber?: string;
  periodLabel?: string;
  amountDue?: string;
  responseDueAt?: string;
  assignedToId?: string;
  summary?: string;
}

/** Multipart: the notice's fields and, optionally, its scan. */
export async function createNotice(input: NoticeInput, file: File | null): Promise<{ notice: NoticeDetail }> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== '') fd.append(k, String(v));
  if (file) fd.append('file', file);
  const res = await fetch(`/api${B}/notices`, { method: 'POST', credentials: 'include', body: fd });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Couldn’t save the notice (${res.status}).`);
  }
  return res.json();
}

export const noticeFileUrl = (id: string) => `/api${B}/notices/${id}/file`;

async function download(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'The download failed.');
  }
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = m?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

export const downloadPaymentWorksheet = (id: string) => download(`/api${B}/payments/${id}/worksheet.csv`, 'tax-payment.csv');
export const downloadReturnCsv = (id: string, withSsn: boolean) => download(`/api${B}/returns/${id}/export.csv${withSsn ? '?ssn=1' : ''}`, 'tax-return.csv');
