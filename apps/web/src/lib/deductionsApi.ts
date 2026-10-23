import { apiFetch } from './api';

/* Deductions: the garnishment desk, 401(k) plans and benefit carrier feeds. */

async function download(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api${url}`, { credentials: 'include' });
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

/* ----- garnishment desk ------------------------------------------------- */

export type GarnishmentKind = 'CHILD_SUPPORT' | 'TAX_LEVY' | 'STUDENT_LOAN' | 'BANKRUPTCY' | 'CREDITOR' | 'OTHER';
export type GarnishmentStatus = 'ACTIVE' | 'SUSPENDED' | 'COMPLETED' | 'TERMINATED';
export type RemitMethod = 'CHECK' | 'ACH' | 'EFT_SDU' | 'PORTAL';
export type Frequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';

export interface DeskOrder {
  id: string;
  associateId: string;
  associateName: string;
  kind: GarnishmentKind;
  status: GarnishmentStatus;
  source: 'MANUAL' | 'EIWO';
  caseNumber: string | null;
  orderIdentifier: string | null;
  remittanceIdentifier: string | null;
  state: string | null;
  fipsCode: string | null;
  agencyName: string | null;
  payee: string | null;
  payeeKind: string | null;
  remitMethod: RemitMethod;
  payeeAccountLast4: string | null;
  orderFrequency: Frequency | null;
  currentSupport: number | null;
  pastDueSupport: number | null;
  medicalSupport: number | null;
  arrearsOver12Weeks: boolean;
  supportsSecondFamily: boolean;
  amountPerRun: number | null;
  percentOfDisp: number | null;
  adminFee: number | null;
  levyFilingStatus: string | null;
  levyExemptions: number | null;
  levyAdditionalStandard: number;
  levyTaxYear: number | null;
  lumpSumReporting: boolean;
  totalCap: number | null;
  amountWithheld: number;
  remainingBalance: number | null;
  lastDeduction: { amount: number; on: string | null } | null;
  nextRemittance: { remittanceId: string; amount: number; payee: string; dueBy: string; overdue: boolean } | null;
  startDate: string | null;
  endDate: string | null;
  receivedAt: string | null;
  priority: number;
}

export interface StateRule {
  state: string;
  allocationMethod: 'PRO_RATA' | 'FIRST_IN_TIME';
  supportMaxPercent: number | null;
  creditorMaxPercent: number | null;
  adminFeeMax: number | null;
  adminFeeFrequency: 'PER_PAYMENT' | 'MONTHLY' | 'ONE_TIME' | null;
  notes: string | null;
  updatedAt: string;
}

export interface DeskSummary {
  orders: DeskOrder[];
  totals: { active: number; eiwoToReview: number; remittancesPending: number; remittancesPendingAmount: number; overdue: number };
  stateRules: StateRule[];
  levyYears: number[];
  rejectReasons: Array<{ code: string; label: string }>;
}

export interface EiwoDoc {
  id: string;
  receivedAt: string;
  documentActionCode: 'ORG' | 'AMD' | 'TRM' | 'LUM';
  caseIdentifier: string | null;
  orderIdentifier: string | null;
  remittanceIdentifier: string | null;
  issuingState: string | null;
  employeeName: string | null;
  employeeSsnLast4: string | null;
  parsed: {
    problems?: string[];
    match?: string;
    orderFrequency?: Frequency | null;
    currentSupport?: number | null;
    pastDueSupport?: number | null;
    medicalSupport?: number | null;
    lumpSumAmount?: number | null;
    payeeName?: string | null;
    issuingAgency?: string | null;
    arrearsOver12Weeks?: boolean;
  };
  status: 'RECEIVED' | 'ACCEPTED' | 'REJECTED';
  rejectReasonCode: string | null;
  rejectReason: string | null;
  associateId: string | null;
  garnishmentId: string | null;
  hasAck: boolean;
  ackGeneratedAt: string | null;
}

export interface LevyParameter {
  id: string;
  taxYear: number;
  filingStatus: string;
  standardDeduction: number;
  additionalStandardDeduction: number;
  exemptionAmount: number;
  source: string | null;
  updatedAt: string;
}

export interface Notice {
  id: string;
  garnishmentId: string;
  kind: 'TERMINATION' | 'LUMP_SUM';
  payload: Record<string, unknown>;
  createdAt: string;
  sentAt: string | null;
  reference: string | null;
}

export interface PendingRemittance {
  id: string;
  payrollRunId: string;
  period: { start: string; end: string };
  payeeName: string;
  payeeAddress: string | null;
  amount: number;
  deductionCount: number;
  status: 'PENDING' | 'SENT';
  sentAt: string | null;
  reference: string | null;
}

export const getDesk = () => apiFetch<DeskSummary>('/garnishment-desk');
export const listEiwo = (status?: string) => apiFetch<{ documents: EiwoDoc[]; truncated: boolean }>(`/garnishment-desk/eiwo${status ? `?status=${status}` : ''}`);
export const uploadEiwo = (xml: string) => apiFetch<{ documents: EiwoDoc[] }>('/garnishment-desk/eiwo', { method: 'POST', body: { xml } });
export const acceptEiwo = (id: string, body: { associateId?: string; remitMethod?: RemitMethod }) =>
  apiFetch<{ document: EiwoDoc; garnishmentId: string }>(`/garnishment-desk/eiwo/${id}/accept`, { method: 'POST', body });
export const rejectEiwo = (id: string, body: { reasonCode: string; reasonText?: string; terminationDate?: string; newEmployerName?: string }) =>
  apiFetch<{ document: EiwoDoc }>(`/garnishment-desk/eiwo/${id}/reject`, { method: 'POST', body });
export const downloadAck = (id: string) => download(`/garnishment-desk/eiwo/${id}/ack.xml`, 'eiwo-ack.xml');
export const saveOrderDetails = (id: string, body: Record<string, unknown>) => apiFetch<{ id: string }>(`/garnishment-desk/orders/${id}/details`, { method: 'POST', body });
export const requestPayeeBank = (id: string, body: { routingNumber: string; accountNumber: string }) =>
  apiFetch<{ pending: true; approvalId: string; title: string }>(`/garnishment-desk/orders/${id}/payee-bank`, { method: 'POST', body });
export const listNotices = (id: string) => apiFetch<{ notices: Notice[] }>(`/garnishment-desk/orders/${id}/notices`);
export const createNotice = (id: string, body: Record<string, unknown>) => apiFetch<{ notice: Notice }>(`/garnishment-desk/orders/${id}/notices`, { method: 'POST', body });
export const downloadNotice = (id: string) => download(`/garnishment-desk/notices/${id}/file.xml`, 'eiwo-notice.xml');
export const markNoticeSent = (id: string, reference?: string) => apiFetch<{ notice: Notice }>(`/garnishment-desk/notices/${id}/sent`, { method: 'POST', body: { reference } });
export const saveStateRule = (state: string, body: Omit<StateRule, 'state' | 'updatedAt'>) => apiFetch<{ rule: StateRule }>(`/garnishment-desk/state-rules/${state}`, { method: 'PUT', body });
export const deleteStateRule = (state: string) => apiFetch<void>(`/garnishment-desk/state-rules/${state}`, { method: 'DELETE' });
export const listLevyParameters = () => apiFetch<{ parameters: LevyParameter[] }>('/garnishment-desk/levy-parameters');
export const saveLevyParameter = (body: Omit<LevyParameter, 'id' | 'updatedAt'>) => apiFetch<{ parameter: LevyParameter }>('/garnishment-desk/levy-parameters', { method: 'PUT', body });
export const deleteLevyParameter = (id: string) => apiFetch<void>(`/garnishment-desk/levy-parameters/${id}`, { method: 'DELETE' });
export const listRemittances = (status?: 'PENDING' | 'SENT') => apiFetch<{ remittances: PendingRemittance[] }>(`/payroll/garnishment-remittances${status ? `?status=${status}` : ''}`);
export const sendRemittances = (remittanceIds: string[], effectiveDate: string) =>
  apiFetch<{ achFileId: string; fileStatus: string; sent: Array<{ remittanceId: string; entries: number; amount: number }> }>('/garnishment-desk/remittances/send', { method: 'POST', body: { remittanceIds, effectiveDate } });
export const markRemittanceSent = (id: string, reference: string) => apiFetch<{ ok: true }>(`/payroll/garnishment-remittances/${id}/mark-sent`, { method: 'POST', body: { reference } });
export const downloadAdvicePdf = (id: string) => download(`/payroll/garnishment-remittances/${id}/advice.pdf`, 'remittance-advice.pdf');

/* ----- 401(k) ------------------------------------------------------------ */

export type RecordkeeperId = 'GUIDELINE' | 'VESTWELL' | 'EMPOWER_SFTP' | 'GENERIC_SFTP';
export interface ConnectionView { host: string | null; username: string | null; remoteDir: string | null; baseUrl: string | null; hasSecret: boolean }

export interface RetirementPlan {
  id: string;
  name: string;
  planNumber: string | null;
  employerId: string | null;
  employerName: string | null;
  benefitsPlanId: string | null;
  recordkeeper: RecordkeeperId;
  recordkeeperLabel: string;
  transport: 'HTTPS' | 'SFTP' | 'DOWNLOAD';
  connection: ConnectionView;
  status: 'ACTIVE' | 'FROZEN' | 'TERMINATED';
  establishedOn: string | null;
  eligibilityMinAge: number;
  eligibilityServiceDays: number;
  entryTiming: 'IMMEDIATE' | 'MONTHLY' | 'QUARTERLY';
  autoEnroll: boolean;
  autoEnrollPercent: number;
  autoEscalatePercent: number;
  autoEscalateMax: number;
  optOutDays: number;
  matchFormula: Array<{ upToPercent: number; matchPercent: number }>;
  safeHarbor: 'NONE' | 'BASIC' | 'ENHANCED' | 'NONELECTIVE_3';
  rothEnabled: boolean;
  catchUpEnabled: boolean;
  mustAutoEnroll: boolean;
  counts: Record<string, number>;
}

export type PlanInput = Omit<RetirementPlan, 'id' | 'employerName' | 'recordkeeperLabel' | 'transport' | 'connection' | 'mustAutoEnroll' | 'counts'>;

export interface Election {
  id: string;
  associateId: string;
  name: string;
  hireDate: string | null;
  status: 'NOT_ELIGIBLE' | 'ELIGIBLE' | 'ENROLLED' | 'AUTO_ENROLLED' | 'OPTED_OUT';
  preTaxPercent: number;
  rothPercent: number;
  /** A flat amount per paycheck chosen on the Benefits page instead of a rate. */
  flatAmountPerPay: number | null;
  eligibleOn: string | null;
  enrolledOn: string | null;
  optOutDeadline: string | null;
  nextEscalationOn: string | null;
  source: string;
  updatedAt: string;
}

export interface Loan { id: string; associateId: string; loanNumber: string; perPayAmount: number; startDate: string | null; endDate: string | null; balance: number | null; status: string }
export interface PayDateRow { payDate: string; people: number; employee: number; employer: number; fileStatus: string | null }
export interface RetirementFile { id: string; kind: 'CONTRIBUTION' | 'CENSUS' | 'TRUE_UP'; format: string; payDate: string | null; rowCount: number; totals: Record<string, number | string>; status: 'GENERATED' | 'SENT' | 'FAILED'; error: string | null; sentAt: string | null; createdAt: string }

export const listPlans = () =>
  apiFetch<{ plans: RetirementPlan[]; employers: Array<{ id: string; name: string; isDefault: boolean }>; recordkeepers: Array<{ id: RecordkeeperId; label: string; transport: string }>; benefitsPlans: Array<{ id: string; name: string }> }>('/retirement/plans');
export const createPlan = (body: PlanInput) => apiFetch<{ plan: RetirementPlan }>('/retirement/plans', { method: 'POST', body });
export const updatePlan = (id: string, body: PlanInput) => apiFetch<{ plan: RetirementPlan }>(`/retirement/plans/${id}`, { method: 'PUT', body });
export const savePlanConnection = (id: string, body: Record<string, unknown>) => apiFetch<{ connection: ConnectionView }>(`/retirement/plans/${id}/connection`, { method: 'PUT', body });
export const syncPlan = (id: string) => apiFetch<{ eligible: number; autoEnrolled: number; escalated: number }>(`/retirement/plans/${id}/sync`, { method: 'POST' });
export const listElections = (id: string) => apiFetch<{ elections: Election[]; loans: Loan[] }>(`/retirement/plans/${id}/elections`);
export const changeElection = (id: string, body: { status: 'ENROLLED' | 'OPTED_OUT'; preTaxPercent: number; rothPercent: number }) => apiFetch<{ id: string }>(`/retirement/elections/${id}`, { method: 'POST', body });
export const addLoan = (planId: string, body: { associateId: string; loanNumber: string; perPayAmount: number; startDate: string; endDate?: string | null; balance?: number | null }) =>
  apiFetch<{ id: string }>(`/retirement/plans/${planId}/loans`, { method: 'POST', body });
export const setLoanStatus = (id: string, status: string) => apiFetch<{ ok: true }>(`/retirement/loans/${id}/status`, { method: 'POST', body: { status } });
export const listPayDates = (id: string) => apiFetch<{ payDates: PayDateRow[] }>(`/retirement/plans/${id}/pay-dates`);
export const makeContributionFile = (id: string, payDate: string) => apiFetch<{ file: RetirementFile }>(`/retirement/plans/${id}/files/contributions`, { method: 'POST', body: { payDate } });
export const makeCensusFile = (id: string) => apiFetch<{ file: RetirementFile }>(`/retirement/plans/${id}/files/census`, { method: 'POST' });
export const makeTrueUpFile = (id: string, year: number) => apiFetch<{ file: RetirementFile | null; owed: Array<{ associateId: string; name: string; amount: number }>; message?: string }>(`/retirement/plans/${id}/files/true-up`, { method: 'POST', body: { year } });
export const listPlanFiles = (id: string) => apiFetch<{ files: RetirementFile[] }>(`/retirement/plans/${id}/files`);
export const downloadPlanFile = (id: string) => download(`/retirement/files/${id}/download`, 'recordkeeper-file.csv');
export const sendPlanFile = (id: string) => apiFetch<{ file: RetirementFile }>(`/retirement/files/${id}/send`, { method: 'POST' });
export const uploadDeferralChanges = (id: string, content: string) => apiFetch<{ applied: number; unmatched: string[]; skipped: string[] }>(`/retirement/plans/${id}/deferral-changes`, { method: 'POST', body: { content } });

/* ----- benefit carriers -------------------------------------------------- */

export interface CarrierPlan { id: string; name: string; kind: string; insuranceLineCode: string | null; carrierPlanCode: string | null; carrierId?: string | null; defaultLine?: string | null }
export interface Carrier {
  id: string;
  name: string;
  receiverId: string;
  receiverQualifier: string;
  senderId: string;
  senderQualifier: string;
  sponsorTaxId: string | null;
  policyNumber: string | null;
  usageIndicator: 'T' | 'P';
  transport: 'DOWNLOAD' | 'SFTP' | 'HTTPS';
  connection: ConnectionView;
  active: boolean;
  plans: CarrierPlan[];
  lastFile: { createdAt: string; mode: string; status: string } | null;
  /** How the feed is doing (GET /benefit-carriers only). */
  health?: CarrierFeedHealth;
}
/**
 * People the next full file carries, people whose enrollment changed since
 * the last file made (null before the first file), and the newest file with
 * its delivery result. Carriers' acknowledgments aren't received here.
 */
export interface CarrierFeedHealth {
  people: number;
  changesWaiting: number | null;
  lastFile: { createdAt: string; mode: string; status: string; controlNumber: number; memberCount: number; sentAt: string | null; error: string | null } | null;
}
export type CarrierInput = Pick<Carrier, 'name' | 'receiverId' | 'receiverQualifier' | 'senderId' | 'senderQualifier' | 'sponsorTaxId' | 'policyNumber' | 'usageIndicator' | 'transport'> & { active?: boolean };
export interface Edi834File { id: string; mode: 'FULL' | 'CHANGE'; controlNumber: number; memberCount: number; status: 'GENERATED' | 'SENT' | 'FAILED'; error: string | null; sentAt: string | null; createdAt: string }

export const listCarriers = () => apiFetch<{ carriers: Carrier[]; plans: CarrierPlan[] }>('/benefit-carriers');
export const createCarrier = (body: CarrierInput) => apiFetch<{ carrier: Carrier }>('/benefit-carriers', { method: 'POST', body });
export const updateCarrier = (id: string, body: CarrierInput) => apiFetch<{ carrier: Carrier }>(`/benefit-carriers/${id}`, { method: 'PUT', body });
export const saveCarrierConnection = (id: string, body: Record<string, unknown>) => apiFetch<{ connection: ConnectionView }>(`/benefit-carriers/${id}/connection`, { method: 'PUT', body });
export const linkCarrierPlans = (id: string, plans: Array<{ planId: string; insuranceLineCode?: string | null; carrierPlanCode?: string | null }>) =>
  apiFetch<{ ok: true }>(`/benefit-carriers/${id}/plans`, { method: 'PUT', body: { plans } });
export const make834 = (id: string, mode: 'FULL' | 'CHANGE') => apiFetch<{ file: Edi834File | null; excluded: string[]; message?: string }>(`/benefit-carriers/${id}/files`, { method: 'POST', body: { mode } });
export const list834 = (id: string) => apiFetch<{ files: Edi834File[] }>(`/benefit-carriers/${id}/files`);
export const download834 = (id: string) => download(`/benefit-files/${id}/download`, 'enrollment-834.edi');
export const send834 = (id: string) => apiFetch<{ file: Edi834File }>(`/benefit-files/${id}/send`, { method: 'POST' });
