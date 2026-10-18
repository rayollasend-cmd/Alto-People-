import { apiFetch } from './api';

/* Certified payroll (API: /certified-payroll) and the contractors desk (API: /contractors, /me/w9). */

const CP = '/certified-payroll';
const CT = '/contractors';

/* ----- Certified payroll ----------------------------------------------------- */

export type FringeMode = 'CASH' | 'PLAN' | 'MIXED';
export type WeekStatus = 'OPEN' | 'DRAFT' | 'SIGNED' | 'SUBMITTED';

export interface ProjectSummary {
  id: string;
  name: string;
  contractNumber: string | null;
  agency: string | null;
  wageDeterminationNumber: string | null;
  state: string | null;
  status: 'ACTIVE' | 'CLOSED' | 'ARCHIVED';
  site: { id: string; name: string } | null;
  workers: number;
  weeksDue: number;
  oldestDue: string | null;
  unsigned: number;
}

export interface ProjectRate {
  id: string;
  classification: string;
  baseRate: number;
  fringeRate: number;
  apprenticesPerJourneyman: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ProjectWorker {
  id: string;
  associateId: string;
  name: string;
  classification: string;
  isApprentice: boolean;
  apprenticeRegistration: string | null;
  apprenticeLevelPercent: number | null;
  startedOn: string;
  endedOn: string | null;
}

export interface ProjectDetail {
  id: string;
  name: string;
  contractNumber: string | null;
  agency: string | null;
  awardingBody: string | null;
  wageDeterminationNumber: string | null;
  dirProjectId: string | null;
  siteId: string | null;
  site: { id: string; name: string } | null;
  addressLine1: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  zip: string | null;
  startDate: string;
  endDate: string | null;
  weekEndsOn: number;
  fringeMode: FringeMode;
  payrollOfficerName: string | null;
  payrollOfficerTitle: string | null;
  status: ProjectSummary['status'];
  rates: ProjectRate[];
  workers: ProjectWorker[];
}

export interface WeekRow {
  weekEnding: string;
  status: WeekStatus;
  payrollNumber: number | null;
  signedAt: string | null;
  submittedAt: string | null;
}

export interface CertifiedRow {
  associateId: string;
  name: string;
  idLast4: string | null;
  classification: string;
  isApprentice: boolean;
  straight: number[];
  overtime: number[];
  totalStraight: number;
  totalOvertime: number;
  rate: number | null;
  overtimeRate: number | null;
  prevailingBase: number | null;
  prevailingFringe: number | null;
  requiredRate: number | null;
  belowPrevailing: boolean;
  grossThisProject: number;
  grossAllWork: number;
  deductions: { fica: number; withholding: number; other: number; total: number } | null;
  net: number | null;
  paid: boolean;
}

export interface CertifiedException {
  kind: 'BELOW_PREVAILING' | 'APPRENTICE_RATIO' | 'NO_RATE' | 'UNPAID';
  message: string;
  associateId?: string;
}

export interface WeekDetail {
  project: { id: string; name: string; state: string | null; fringeMode: FringeMode; payrollOfficerName: string | null; payrollOfficerTitle: string | null };
  weekEnding: string;
  payrollNumber: number;
  report: {
    status: WeekStatus;
    payrollNumber: number;
    isFinal: boolean;
    fringeStatement: 'PLANS' | 'CASH' | 'MIXED' | null;
    exceptionsText: string | null;
    signatureName: string | null;
    signerTitle: string | null;
    signedAt: string | null;
    submittedAt: string | null;
    submittedTo: string | null;
    confirmation: string | null;
    pdfHash: string | null;
  } | null;
  week: { days: string[]; rows: CertifiedRow[]; exceptions: CertifiedException[]; totals: { hours: number; grossThisProject: number; workers: number }; allPaid: boolean };
  ecprAvailable: boolean;
}

export interface ProjectInput {
  name: string;
  contractNumber?: string | null;
  agency?: string | null;
  awardingBody?: string | null;
  wageDeterminationNumber?: string | null;
  dirProjectId?: string | null;
  siteId?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  county?: string | null;
  state?: string | null;
  zip?: string | null;
  startDate: string;
  endDate?: string | null;
  weekEndsOn?: number;
  fringeMode?: FringeMode;
  payrollOfficerName?: string | null;
  payrollOfficerTitle?: string | null;
}

export const listProjects = () => apiFetch<{ projects: ProjectSummary[] }>(`${CP}/projects`);
export const createProject = (input: ProjectInput) => apiFetch<{ id: string }>(`${CP}/projects`, { method: 'POST', body: input });
export const getProject = (id: string) => apiFetch<{ project: ProjectDetail; weeks: WeekRow[] }>(`${CP}/projects/${id}`);
export const updateProject = (id: string, input: Partial<ProjectInput> & { status?: ProjectSummary['status'] }) => apiFetch<{ ok: true }>(`${CP}/projects/${id}`, { method: 'PATCH', body: input });
export const addRate = (id: string, input: { classification: string; baseRate: number; fringeRate: number; apprenticesPerJourneyman?: number | null; effectiveFrom: string }) =>
  apiFetch<{ id: string }>(`${CP}/projects/${id}/rates`, { method: 'POST', body: input });
export const removeRate = (id: string, rateId: string) => apiFetch<{ ok: true }>(`${CP}/projects/${id}/rates/${rateId}`, { method: 'DELETE' });
export const addWorker = (id: string, input: { associateId: string; classification: string; isApprentice: boolean; apprenticeRegistration?: string | null; apprenticeLevelPercent?: number | null; startedOn: string }) =>
  apiFetch<{ id: string }>(`${CP}/projects/${id}/workers`, { method: 'POST', body: input });
export const endWorker = (id: string, workerId: string, endedOn: string) => apiFetch<{ ok: true }>(`${CP}/projects/${id}/workers/${workerId}`, { method: 'PATCH', body: { endedOn } });
export const getWeek = (id: string, weekEnding: string) => apiFetch<WeekDetail>(`${CP}/projects/${id}/weeks/${weekEnding}`);
export const signWeek = (id: string, weekEnding: string, input: { signatureName: string; signerTitle: string; fringeStatement: 'PLANS' | 'CASH' | 'MIXED'; exceptionsText?: string | null; isFinal: boolean; attest: true }) =>
  apiFetch<{ status: WeekStatus; payrollNumber: number; pdfHash: string }>(`${CP}/projects/${id}/weeks/${weekEnding}/sign`, { method: 'POST', body: input });
export const markSubmitted = (id: string, weekEnding: string, input: { submittedTo: string; confirmation?: string | null }) =>
  apiFetch<{ status: WeekStatus }>(`${CP}/projects/${id}/weeks/${weekEnding}/submitted`, { method: 'POST', body: input });
export const downloadWh347 = (id: string, weekEnding: string) => download(`/api${CP}/projects/${id}/weeks/${weekEnding}/wh347.pdf`, `WH-347-${weekEnding}.pdf`);
export const downloadEcpr = (id: string, weekEnding: string) => download(`/api${CP}/projects/${id}/weeks/${weekEnding}/ecpr.xml`, `eCPR-${weekEnding}.xml`);

/* ----- Contractors -------------------------------------------------------------- */

export type W9Status = 'NONE' | 'REQUESTED' | 'SIGNED';
export type TinMatchStatus = 'NOT_CHECKED' | 'PENDING' | 'MATCHED' | 'MISMATCH' | 'INVALID';
export type BackupReason = 'NO_TIN' | 'NOT_CERTIFIED' | 'B_NOTICE' | 'IRS_NOTIFIED';

export interface ContractorRow {
  associateId: string;
  name: string;
  email: string;
  employmentType: 'CONTRACTOR_1099_INDIVIDUAL' | 'CONTRACTOR_1099_BUSINESS';
  w9Status: W9Status;
  w9SignedAt: string | null;
  hasTin: boolean;
  tinLast4: string | null;
  tinMatchStatus: TinMatchStatus;
  tinMatchLabel: string | null;
  backupWithholding: boolean;
  backupReason: BackupReason | null;
  openBNotices: Array<{ id: string; kind: 'FIRST' | 'SECOND'; sendBy: string; sentAt: string | null; backupBy: string }>;
}

export interface BNoticeRow {
  id: string;
  associateId: string;
  name: string;
  kind: 'FIRST' | 'SECOND';
  irsNoticeKind: string;
  irsNoticeReceivedOn: string;
  sendBy: string;
  sentAt: string | null;
  backupBy: string;
  respondedAt: string | null;
  resolution: string | null;
}

export interface TinBatch {
  id: string;
  kind: 'BULK' | 'INTERACTIVE';
  status: 'GENERATED' | 'RESULTS_LOADED';
  requestedCount: number;
  summary: Record<string, number | string> | null;
  createdAt: string;
  resultsLoadedAt: string | null;
}

export interface PaymentRun {
  id: string;
  name: string;
  payDate: string;
  status: 'DRAFT' | 'APPROVED' | 'PAID' | 'CANCELLED';
  createdById: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  count: number;
  totals: { amount: number; backupWithheld: number; stateWithheld: number; net: number };
}

export interface ContractorPayment {
  id: string;
  associateId: string;
  name: string;
  description: string;
  invoiceNumber: string | null;
  form: 'NEC' | 'MISC';
  miscBox: number | null;
  amount: number;
  backupWithheld: number;
  workState: string | null;
  stateWithheld: number;
  netAmount: number;
}

export interface StateFiling {
  state: string;
  cfsf: boolean;
  directFiling: boolean;
  payerStateId: string | null;
  notes: string | null;
  isDefault: boolean;
  noIncomeTax: boolean;
}

export interface YearEndRow {
  associateId: string;
  name: string;
  necBox1: number;
  necBox4: number;
  miscTotal: number;
  miscBox4: number;
  states: string[];
  needsNec: boolean;
  needsMisc: boolean;
  issues: string[];
}

export const listContractors = (q?: string) => apiFetch<{ contractors: ContractorRow[]; truncated: boolean }>(`${CT}/profiles${q ? `?q=${encodeURIComponent(q)}` : ''}`);
export const requestW9 = (associateId: string) => apiFetch<{ ok: true }>(`${CT}/profiles/${associateId}/w9-request`, { method: 'POST', body: {} });
export const checkTin = (associateId: string) => apiFetch<{ status: TinMatchStatus; code: number; label: string | null }>(`${CT}/profiles/${associateId}/tin-check`, { method: 'POST', body: {} });
export const setBackup = (associateId: string, input: { action: 'start' | 'stop'; reason?: BackupReason; note: string }) => apiFetch<{ ok: true }>(`${CT}/profiles/${associateId}/backup`, { method: 'POST', body: input });
export const downloadSignedW9 = (associateId: string) => download(`/api${CT}/profiles/${associateId}/w9.pdf`, 'W-9-signed.pdf');

export const listTinBatches = () => apiFetch<{ batches: TinBatch[] }>(`${CT}/tin-match/batches`);
export const createTinBatch = () => apiFetch<{ id: string; requestedCount: number }>(`${CT}/tin-match/batches`, { method: 'POST', body: {} });
export const downloadTinRequest = (id: string) => download(`/api${CT}/tin-match/batches/${id}/request.txt`, 'tin-match-request.txt');
export const loadTinResults = (id: string, text: string) => apiFetch<{ summary: Record<string, number> }>(`${CT}/tin-match/batches/${id}/results`, { method: 'POST', body: { text } });

export const listBNotices = (status: 'open' | 'all' = 'open') => apiFetch<{ notices: BNoticeRow[]; truncated: boolean }>(`${CT}/b-notices?status=${status}`);
export const logBNotice = (associateId: string, input: { irsNoticeKind: 'CP2100' | 'CP2100A' | '972CG'; irsNoticeReceivedOn: string; tinLast4OnNotice?: string | null }) =>
  apiFetch<{ id: string; kind: 'FIRST' | 'SECOND'; sendBy: string; backupBy: string }>(`${CT}/profiles/${associateId}/b-notices`, { method: 'POST', body: input });
export const downloadBNoticeLetter = (id: string) => download(`/api${CT}/b-notices/${id}/letter.pdf`, 'b-notice.pdf');
export const markBNoticeSent = (id: string) => apiFetch<{ sentAt: string }>(`${CT}/b-notices/${id}/sent`, { method: 'POST', body: {} });
export const resolveBNotice = (id: string, resolution: 'W9_RECEIVED' | 'SSA_VALIDATION' | 'IRS_147C') => apiFetch<{ ok: true }>(`${CT}/b-notices/${id}/resolve`, { method: 'POST', body: { resolution } });

export const listPaymentRuns = () => apiFetch<{ runs: PaymentRun[]; me: string }>(`${CT}/payment-runs`);
export const createPaymentRun = (input: { name: string; payDate: string }) => apiFetch<{ id: string }>(`${CT}/payment-runs`, { method: 'POST', body: input });
export const getPaymentRun = (id: string) => apiFetch<{ run: PaymentRun; payments: ContractorPayment[]; me: string }>(`${CT}/payment-runs/${id}`);
export const addPayment = (id: string, input: { associateId: string; description: string; invoiceNumber?: string | null; form: 'NEC' | 'MISC'; miscBox?: number | null; amount: number; workState?: string | null; stateWithheld?: number }) =>
  apiFetch<{ id: string; backupWithheld: number; netAmount: number; backupReason: BackupReason | null }>(`${CT}/payment-runs/${id}/payments`, { method: 'POST', body: input });
export const removePayment = (id: string, paymentId: string) => apiFetch<{ ok: true }>(`${CT}/payment-runs/${id}/payments/${paymentId}`, { method: 'DELETE' });
export const approvePaymentRun = (id: string) => apiFetch<{ status: string }>(`${CT}/payment-runs/${id}/approve`, { method: 'POST', body: {} });
export const markPaymentRunPaid = (id: string, input: { paymentMethod: 'ACH' | 'CHECK' | 'WIRE' | 'CARD' | 'OTHER'; reference?: string | null }) =>
  apiFetch<{ status: string }>(`${CT}/payment-runs/${id}/paid`, { method: 'POST', body: input });
export const cancelPaymentRun = (id: string) => apiFetch<{ status: string }>(`${CT}/payment-runs/${id}/cancel`, { method: 'POST', body: {} });

export const listStateFiling = () => apiFetch<{ states: StateFiling[]; cfsfStates: string[]; cfsfParticipants: string[] }>(`${CT}/state-filing`);
export const saveStateFiling = (state: string, input: { cfsf: boolean; directFiling: boolean; payerStateId?: string | null; notes?: string | null }) =>
  apiFetch<{ ok: true }>(`${CT}/state-filing/${state}`, { method: 'PUT', body: input });
export const downloadStateExport = (state: string, taxYear: number) => download(`/api${CT}/state-filing/${state}/export.csv?taxYear=${taxYear}`, `1099-${state}-${taxYear}.csv`);

export const getYearEnd = (taxYear: number) =>
  apiFetch<{ taxYear: number; threshold: number; rows: YearEndRow[]; totals: { payees: number; necForms: number; miscForms: number; necBox1: number; backupWithheld: number; withIssues: number } }>(`${CT}/year-end?taxYear=${taxYear}`);

/* ----- The contractor's own W-9 ------------------------------------------------------ */

export interface MyW9 {
  required: boolean;
  status: W9Status;
  signedAt: string | null;
  backupWithholding: boolean;
  form: {
    legalName: string;
    businessName: string | null;
    taxClassification: string | null;
    llcTaxClass: string | null;
    exemptPayeeCode: string | null;
    fatcaCode: string | null;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    tinType: 'SSN' | 'EIN' | null;
    tinLast4: string | null;
    subjectToBackup: boolean;
  };
}

export interface W9Submit {
  legalName: string;
  businessName?: string | null;
  taxClassification: 'INDIVIDUAL' | 'C_CORP' | 'S_CORP' | 'PARTNERSHIP' | 'TRUST' | 'LLC' | 'OTHER';
  llcTaxClass?: 'C' | 'S' | 'P' | null;
  exemptPayeeCode?: string | null;
  fatcaCode?: string | null;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  tinType: 'SSN' | 'EIN';
  tin: string;
  subjectToBackup: boolean;
  signatureName: string;
  certify: true;
}

export const getMyW9 = () => apiFetch<MyW9>('/me/w9');
export const submitMyW9 = (input: W9Submit) => apiFetch<{ status: W9Status; signedAt: string; tinLast4: string }>('/me/w9', { method: 'POST', body: input });
export const downloadMyW9 = () => download('/api/me/w9/signed.pdf', 'W-9-signed.pdf');

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
