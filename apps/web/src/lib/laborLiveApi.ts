import { apiFetch } from './api';

/* ----- Labor rules go live (apps/api/src/lib/laborRules/live.ts) ------------ */

export type ActivationStatus = 'PENDING' | 'LIVE' | 'ENDED' | 'REJECTED';

export interface LaborActivation {
  id: string;
  jurisdiction: string;
  siteId: string | null;
  status: ActivationStatus;
  signedLabels: string[];
  counselName: string;
  counselFirm: string;
  counselSignedOn: string;
  changeReport: { people?: number; amountDifference?: number; premiumAmount?: number; runs?: number } | null;
  approvalRequestId: string | null;
  requestedBy: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
  endedBy: string | null;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
}

export interface LaborJurisdiction {
  jurisdiction: string;
  label: string;
  sites: Array<{ id: string; name: string; activation: LaborActivation | null }>;
  current: LaborActivation | null;
  history: LaborActivation[];
}

export const getLaborActivations = () => apiFetch<{ attestation: string; jurisdictions: LaborJurisdiction[] }>('/labor-rules/activations');

export interface ChangeReportPerson {
  associateId: string;
  name: string;
  hourlyRate: number;
  paid: number;
  live: number;
  difference: number;
  premiumHours: number;
  premiumAmount: number;
  reasons: string[];
}

export interface ChangeReport {
  jurisdiction: string;
  siteId: string | null;
  runs: Array<{ id: string; periodStart: string; periodEnd: string }>;
  people: number;
  amountDifference: number;
  premiumAmount: number;
  byRule: Partial<Record<'OVERTIME' | 'MEAL' | 'REST' | 'REST_BETWEEN_SHIFTS' | 'SPREAD_OF_HOURS' | 'SPLIT_SHIFT', number>>;
  rows: ChangeReportPerson[];
  signables: Array<{ id: string; label: string; source: string; status: string }>;
}

export const getChangeReport = (jurisdiction: string, siteId?: string | null) =>
  apiFetch<ChangeReport>(`/labor-rules/change-report?jurisdiction=${encodeURIComponent(jurisdiction)}${siteId ? `&siteId=${siteId}` : ''}`);

export interface GoLiveInput {
  jurisdiction: string;
  siteId?: string | null;
  counselName: string;
  counselFirm: string;
  counselSignedOn: string;
  attestation: string;
}

export type GoLiveResult = { pending: true; approvalId: string; activationId: string; title: string } | { pending: false; activationId: string; status: string };

export const goLive = (input: GoLiveInput) => apiFetch<GoLiveResult>('/labor-rules/activations', { method: 'POST', body: input });
export const backToShadow = (id: string, reason: string) => apiFetch<{ id: string; status: string }>(`/labor-rules/activations/${id}/end`, { method: 'POST', body: { reason } });

/* ----- Timekeeping ------------------------------------------------------------ */

export type RoundingMode = 'NONE' | 'NEAREST' | 'EMPLOYEE_FAVOR';

export interface Timekeeping {
  rounding: { mode: RoundingMode; increment: number; updatedAt: string | null };
  siteRounding: Array<{ siteId: string; siteName: string; mode: RoundingMode; increment: number }>;
  sites: Array<{ id: string; name: string; state: string | null }>;
  otEqualization: boolean;
}

export const getTimekeeping = () => apiFetch<Timekeeping>('/labor-rules/timekeeping');
export const setRounding = (input: { siteId?: string | null; mode: RoundingMode; increment: number }) =>
  apiFetch<{ siteId: string | null; mode: RoundingMode; increment: number }>('/labor-rules/rounding', { method: 'PUT', body: input });
export const clearSiteRounding = (siteId: string) => apiFetch<void>(`/labor-rules/rounding/${siteId}`, { method: 'DELETE' });
export const setOtEqualization = (enabled: boolean) => apiFetch<{ otEqualization: boolean }>('/labor-rules/ot-equalization', { method: 'PUT', body: { enabled } });

export interface ScheduleChangeRow {
  id: string;
  associateId: string;
  name: string;
  siteName: string | null;
  workDate: string;
  change: 'added' | 'reduced' | 'cancelled' | 'moved';
  noticeDays: number;
  premiumHours: number;
  premiumCents: number;
  exempt: boolean;
  exemptReason: string | null;
  rule: string;
  live: boolean;
  paid: boolean;
  createdAt: string;
}

export const getScheduleChanges = () => apiFetch<{ truncated: boolean; changes: ScheduleChangeRow[] }>('/labor-rules/schedule-changes');
export type ExemptReason = 'EMPLOYEE_REQUESTED' | 'MUTUAL_SWAP' | 'VOLUNTARY_PICKUP' | 'EMERGENCY';
/** Excuse a late change the law exempts (or take it back) — only until payroll pays it. */
export const setScheduleChangeExemption = (id: string, body: { exemptReason: ExemptReason | null; note?: string }) =>
  apiFetch<{ id: string; exempt: boolean; exemptReason: string | null }>(`/labor-rules/schedule-changes/${id}`, { method: 'PATCH', body });

/* ----- Overtime offered fairly ---------------------------------------------- */

export interface RotationCandidate {
  associateId: string;
  name: string;
  weekHours: number;
  wouldAddOvertimeHours: number;
  recentOvertimeHours: number;
  rank: number;
  offer: { id: string; status: 'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'SKIPPED'; offeredAt: string; respondedAt: string | null; note: string | null } | null;
}

export const getRotation = (shiftId: string) => apiFetch<{ shiftId: string; open: boolean; enabled: boolean; candidates: RotationCandidate[] }>(`/overtime-offers/shifts/${shiftId}`);
export const offerShift = (shiftId: string, associateId: string, overrideReason?: string | null) =>
  apiFetch<{ shiftId: string; enabled: boolean; candidates: RotationCandidate[] }>(`/overtime-offers/shifts/${shiftId}`, { method: 'POST', body: { associateId, overrideReason: overrideReason ?? null } });
export const recordOfferAnswer = (offerId: string, status: 'ACCEPTED' | 'DECLINED') => apiFetch<{ id: string; status: string }>(`/overtime-offers/${offerId}/respond`, { method: 'POST', body: { status } });

export interface OtEqualizationRow {
  associateId: string;
  name: string;
  overtimeHours: number;
  regularHours: number;
  offered: number;
  accepted: number;
  declined: number;
  skipped: number;
}
export const getOtEqualization = (weeks = 4) =>
  apiFetch<{ weeks: number; since: string; averageOvertimeHours: number; spread: number; people: OtEqualizationRow[]; truncated: boolean }>(`/overtime-offers/report?weeks=${weeks}`);

export interface MyOtOffer {
  id: string;
  wouldAddOvertimeHours: number;
  offeredAt: string;
  shift: { id: string; position: string; startsAt: string; endsAt: string; siteName: string | null; timezone: string | null };
}
export const getMyOtOffers = () => apiFetch<{ offers: MyOtOffer[] }>('/overtime-offers/mine');
export const answerMyOtOffer = (id: string, status: 'ACCEPTED' | 'DECLINED') => apiFetch<{ id: string; status: string }>(`/overtime-offers/mine/${id}/respond`, { method: 'POST', body: { status } });

/* ----- Punch corrections and break answers --------------------------------- */

export type CorrectionKind = 'MISSED_CLOCK_IN' | 'MISSED_CLOCK_OUT' | 'WRONG_TIME' | 'NEW_ENTRY';
export type CorrectionStatus = 'PROMPTED' | 'SUBMITTED' | 'APPROVED' | 'DENIED' | 'WITHDRAWN';

export interface CorrectionRequest {
  id: string;
  associateId: string;
  name: string;
  kind: CorrectionKind;
  status: CorrectionStatus;
  workDate: string | null;
  siteName: string | null;
  /** The site's IANA zone: punches are read on its clock. */
  timezone?: string | null;
  timeEntryId: string | null;
  proposedClockIn: string | null;
  proposedClockOut: string | null;
  reason: string | null;
  attestationText: string | null;
  attestedAt: string | null;
  before: { clockInAt?: string | null; clockOutAt?: string | null; status?: string } | null;
  after: { clockInAt?: string | null; clockOutAt?: string | null; status?: string } | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
}

export interface MyCorrections {
  attestation: string;
  requests: CorrectionRequest[];
  entries: Array<{ id: string; clockInAt: string; clockOutAt: string | null; status: string; siteName: string | null; timezone?: string | null }>;
  sites: Array<{ id: string; name: string }>;
}

export const getMyCorrections = () => apiFetch<MyCorrections>('/time-corrections/mine');

export interface CorrectionInput {
  kind: CorrectionKind;
  timeEntryId?: string | null;
  siteId?: string | null;
  proposedClockIn?: string | null;
  proposedClockOut?: string | null;
  reason: string;
  attested: boolean;
}
export const submitCorrection = (input: CorrectionInput) => apiFetch<{ id: string; status: string }>('/time-corrections', { method: 'POST', body: input });
export const finishPromptedCorrection = (id: string, input: { proposedClockOut: string; reason: string; attested: boolean }) =>
  apiFetch<{ id: string; status: string }>(`/time-corrections/${id}/finish`, { method: 'POST', body: input });
export const withdrawCorrection = (id: string) => apiFetch<{ id: string; status: string }>(`/time-corrections/${id}/withdraw`, { method: 'POST', body: {} });

export const listCorrections = (status: CorrectionStatus = 'SUBMITTED') => apiFetch<{ truncated: boolean; requests: CorrectionRequest[] }>(`/time-corrections?status=${status}`);
export const decideCorrection = (id: string, decision: 'APPROVE' | 'DENY', reason?: string | null) =>
  apiFetch<{ id: string; status: string }>(`/time-corrections/${id}/decide`, { method: 'POST', body: { decision, reason: reason ?? null } });

export interface BreakFlag {
  id: string;
  associateId: string;
  name: string;
  meal: 'YES' | 'NO' | 'WAIVED';
  rest: 'YES' | 'NO' | null;
  note: string | null;
  clockInAt: string | null;
  clockOutAt: string | null;
  siteName: string | null;
  timezone?: string | null;
  createdAt: string;
}
export const listBreakFlags = () => apiFetch<{ truncated: boolean; flags: BreakFlag[] }>('/time-corrections/break-flags');
export const acknowledgeBreakFlag = (id: string) => apiFetch<void>(`/time-corrections/break-flags/${id}/ack`, { method: 'POST', body: {} });

export const getBreakQuestions = () => apiFetch<{ meal: boolean; rest: boolean; mealAfterHours: number | null }>('/time-corrections/break-questions');
