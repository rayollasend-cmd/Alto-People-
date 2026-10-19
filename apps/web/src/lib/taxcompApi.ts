import { apiFetch } from './api';

/* ----- State withholding ---------------------------------------------------- */

export type StateCoverage = 'verified' | 'acknowledged' | 'awaiting_review' | 'none';

export interface StateCoverageRow {
  state: string;
  name: string;
  coverage: StateCoverage;
  people: number;
  taxYear: number | null;
  confidence: 'medium' | 'low' | null;
  source: string | null;
  notes: string | null;
  form: string | null;
  acknowledgment: { taxYear: number; at: string; by: string | null; note: string | null; current: boolean } | null;
  /** Disability, paid-leave and employee-UI contributions withheld for work in this state. */
  programs?: Array<{ code: string; label: string; employeeRate: number; employerRate: number; wageCap: number | null; weeklyEmployeeMax: number | null; verified: boolean; source: string }>;
  /** Programs enacted but not collecting yet (Maryland FAMLI, 2027). */
  programsComing?: Array<{ label: string; startsOn: string; source: string }>;
}

export interface StateCoverageResponse {
  states: StateCoverageRow[];
  counts: { verified: number; acknowledged: number; awaitingReview: number; blockedPeople: number };
}

export const getStateCoverage = () => apiFetch<StateCoverageResponse>('/payroll/state-tax/coverage');
export const acknowledgeState = (state: string, note?: string) =>
  apiFetch<{ ok: true }>(`/payroll/state-tax/${state}/acknowledge`, { method: 'POST', body: { confirm: true, ...(note ? { note } : {}) } });
export const revokeStateAcknowledgment = (state: string) => apiFetch<void>(`/payroll/state-tax/${state}/acknowledge`, { method: 'DELETE' });

export interface StateCalcInput {
  state: string;
  wages: number;
  frequency: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';
  filingStatus: 'SINGLE' | 'MARRIED' | 'HEAD_OF_HOUSEHOLD';
  allowances: number;
  dependents: number;
  federal: number;
  county?: string;
}
export function calculateStateTax(i: StateCalcInput) {
  const qs = new URLSearchParams({
    state: i.state,
    wages: String(i.wages),
    frequency: i.frequency,
    filingStatus: i.filingStatus,
    allowances: String(i.allowances),
    dependents: String(i.dependents),
    federal: String(i.federal),
    ...(i.county ? { county: i.county } : {}),
  });
  return apiFetch<{ state: string; perPeriod: number; coverage: StateCoverage }>(`/payroll/state-tax/calculate?${qs.toString()}`);
}

export interface StateCertificate {
  state: string;
  stateName: string;
  form: string | null;
  filingStatus: 'SINGLE' | 'MARRIED' | 'HEAD_OF_HOUSEHOLD';
  allowances: number;
  dependents: number;
  additionalWithholding: number;
  exempt: boolean;
  county: string | null;
  signedAt: string | null;
}
export type StateCertificateInput = Omit<StateCertificate, 'stateName' | 'form' | 'signedAt'>;

export const getStateW4Forms = () =>
  apiFetch<{ forms: Array<{ state: string; name: string; form: string }>; marylandCounties: string[] }>('/payroll/state-w4-forms');
export const getStateCertificates = (associateId: string) => apiFetch<{ workState: string | null; certificates: StateCertificate[] }>(`/payroll/state-w4/${associateId}`);
export const saveStateCertificate = (associateId: string, body: StateCertificateInput) =>
  apiFetch<{ certificate: StateCertificate }>(`/payroll/state-w4/${associateId}`, { method: 'PUT', body });
export const getMyStateCertificates = () =>
  apiFetch<{ workState: string | null; needed: { state: string; name: string; form: string } | null; certificates: StateCertificate[] }>('/me/state-w4');
export const saveMyStateCertificate = (body: StateCertificateInput) => apiFetch<{ certificate: StateCertificate }>('/me/state-w4', { method: 'PUT', body });

/* ----- WOTC -------------------------------------------------------------- */

export const WOTC_QUESTIONS = [
  'snap',
  'veteran',
  'vetDisability',
  'vetDischargedLastYear',
  'vetUnemployed6m',
  'vetUnemployed4w',
  'tanf9',
  'tanf18',
  'felony',
  'vocRehab',
  'ssi',
  'longTermUnemployed',
] as const;
export type WotcQuestion = (typeof WOTC_QUESTIONS)[number];
export type WotcAnswer = 'yes' | 'no' | 'unsure';
export type WotcStatus = 'NOT_STARTED' | 'DECLINED' | 'NOT_ELIGIBLE' | 'LIKELY_ELIGIBLE' | 'SUBMITTED' | 'CERTIFIED' | 'DENIED';

export const getWotcApplicant = (applicationId: string) =>
  apiFetch<{ questions: WotcQuestion[]; screening: { status: WotcStatus; answers: Partial<Record<WotcQuestion, WotcAnswer>>; signedName: string | null; signedAt: string | null } | null }>(
    `/wotc/applications/${applicationId}`,
  );
export const submitWotcApplicant = (
  applicationId: string,
  body: { declined: true; signedName: string } | { declined: false; signedName: string; answers: Partial<Record<WotcQuestion, WotcAnswer>> },
) => apiFetch<{ status: WotcStatus; signedAt: string | null }>(`/wotc/applications/${applicationId}`, { method: 'POST', body });

export interface WotcScreening {
  id: string;
  associateId: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  siteId: string | null;
  siteName: string | null;
  status: WotcStatus;
  targetGroups: Array<{ code: string; label: string; maxCredit: number }>;
  signedAt: string | null;
  offerDate: string | null;
  hireDate: string | null;
  startDate: string | null;
  startingWage: number | null;
  position: string | null;
  filingState: string | null;
  employerComplete: boolean;
  deadline: string | null;
  daysLeft: number | null;
  submittedAt: string | null;
  submissionRef: string | null;
  filedOnTime: boolean | null;
  certifiedAt: string | null;
  certifiedGroup: string | null;
  denialReason: string | null;
  signedAfterOffer: boolean;
  hours: number;
  wages: number;
  creditRate: number;
  estimatedCredit: number;
  potentialCredit: number;
}

export interface WotcSummary {
  truncated: boolean;
  screened: number;
  declined: number;
  eligible: number;
  toFile: number;
  overdue: number;
  dueThisWeek: number;
  submitted: number;
  filedOnTime: number;
  certified: number;
  denied: number;
  estimatedCredit: number;
  pipelineCredit: number;
  byPlace: Array<{ clientName: string | null; siteName: string | null; screened: number; eligible: number; certified: number; estimatedCredit: number }>;
}

export const getWotcSummary = () => apiFetch<WotcSummary>('/wotc/summary');
export const listWotcScreenings = (status?: WotcStatus | null) =>
  apiFetch<{ screenings: WotcScreening[]; truncated: boolean }>(`/wotc/screenings${status ? `?status=${status}` : ''}`);
export const getWotcScreening = (id: string) =>
  apiFetch<{ screening: WotcScreening & { answers: Partial<Record<WotcQuestion, WotcAnswer>>; questions: WotcQuestion[] } }>(`/wotc/screenings/${id}`);
export const saveWotcEmployer = (
  id: string,
  body: { offerDate: string | null; hireDate: string | null; startDate: string | null; startingWage: number | null; position: string | null; filingState: string | null },
) => apiFetch<{ screening: WotcScreening }>(`/wotc/screenings/${id}/employer`, { method: 'PATCH', body });
export const markWotcSubmitted = (id: string, body: { submittedOn?: string; reference: string }) =>
  apiFetch<{ screening: WotcScreening }>(`/wotc/screenings/${id}/submitted`, { method: 'POST', body });
export const recordWotcOutcome = (id: string, body: { outcome: 'CERTIFIED'; group: string } | { outcome: 'DENIED'; reason: string }) =>
  apiFetch<{ screening: WotcScreening }>(`/wotc/screenings/${id}/outcome`, { method: 'POST', body });
export const getWotcSettings = () => apiFetch<{ enabled: boolean; designatedZips: number }>('/wotc/settings');
export const saveWotcSettings = (enabled: boolean) => apiFetch<{ enabled: boolean }>('/wotc/settings', { method: 'PUT', body: { enabled } });
export const saveWotcZips = (zips: Array<{ zip: string; kind: 'EZ' | 'RRC' }>) => apiFetch<{ count: number }>('/wotc/zips', { method: 'PUT', body: { zips } });
export const wotc8850Url = (id: string) => `/api/wotc/screenings/${id}/8850.pdf`;
export const wotcExportUrl = (state?: string) => `/api/wotc/export.csv${state ? `?state=${state}` : ''}`;

/* ----- ACA ------------------------------------------------------------------ */

export type AcaClassification = 'FULL_TIME' | 'VARIABLE_HOUR' | 'SEASONAL' | 'PART_TIME';
export type AcaStatus = 'full_time' | 'approaching' | 'on_track' | 'new_hire';
export type AcaOfferCode = 'CODE_1A' | 'CODE_1B' | 'CODE_1C' | 'CODE_1D' | 'CODE_1E' | 'CODE_1F' | 'CODE_1G' | 'CODE_1H';

export interface AcaSettings {
  measurementMonths: number;
  adminDays: number;
  stabilityMonths: number;
  initialMeasurementMonths: number;
  stabilityStartMonth: number;
  stabilityStartDay: number;
  fullTimeHoursPerMonth: number;
  breakInServiceWeeks: number;
  ruleOfParity: boolean;
  defaultOfferCode: AcaOfferCode;
  affordabilitySafeHarbor: '2F' | '2G' | '2H' | null;
  lowestPremiumCents: number | null;
}

export interface AcaWorker {
  associateId: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  siteName: string | null;
  hireDate: string | null;
  measurement: {
    classification: AcaClassification;
    status: AcaStatus;
    today: 'not_employed' | 'lnap' | 'full_time' | 'not_full_time';
    inProgress: { start: string; end: string; monthsElapsed: number; hours: number; averageHours: number; stabilityStart: string; kind: 'initial' | 'standard' } | null;
    offerDue: { stabilityStart: string; stabilityEnd: string; dueBy: string; reason: 'measured_full_time' | 'projected_full_time' | 'hired_full_time' } | null;
  };
  offer: { id: string; stabilityStart: string; response: 'PENDING' | 'ENROLLED' | 'WAIVED'; offeredAt: string } | null;
  offerState: 'not_due' | 'due' | 'overdue' | 'offered';
}

export interface AcaSummary {
  truncated: boolean;
  year: number;
  threshold: number;
  counts: { measured: number; fullTime: number; approaching: number; onTrack: number; newHires: number; crossingThreshold: number; offersDue: number; offersOverdue: number };
  exposure: { offeredShare: number; a: number; b: number; failsNinetyFive: boolean; amounts: { a: number; b: number }; fullTime: number; offered: number };
  likelyAle: boolean;
  byClient: Array<{ clientId: string | null; clientName: string | null; fullTime: number; offered: number; due: number; overdue: number; exposureB: number }>;
}

export const getAcaSettings = () => apiFetch<{ settings: AcaSettings }>('/aca/settings');
export const saveAcaSettings = (s: AcaSettings) => apiFetch<{ settings: AcaSettings }>('/aca/settings', { method: 'PUT', body: s });
export const listAcaWorkers = () => apiFetch<{ workers: AcaWorker[]; truncated: boolean; fullTimeHoursPerMonth: number }>('/aca/workers');
export const getAcaSummary = () => apiFetch<AcaSummary>('/aca/summary');
export const setAcaClassification = (associateId: string, body: { classification: AcaClassification; effectiveFrom: string; reason?: string }) =>
  apiFetch<{ worker: AcaWorker | null }>(`/aca/workers/${associateId}/classification`, { method: 'PUT', body });
export const recordAcaOffer = (body: { associateId: string; stabilityStart: string; stabilityEnd: string; offerCode?: AcaOfferCode; lowestPremiumCents?: number | null }) =>
  apiFetch<{ offer: { id: string; response: string } }>('/aca/offers', { method: 'POST', body });
export const answerAcaOffer = (id: string, response: 'PENDING' | 'ENROLLED' | 'WAIVED') => apiFetch<{ ok: true }>(`/aca/offers/${id}`, { method: 'PATCH', body: { response } });
export const syncAca1095c = (year: number) => apiFetch<{ year: number; people: number }>('/aca/sync-1095c', { method: 'POST', body: { year } });
