import { apiFetch } from './api';

/** Unemployment and workers' comp claims (apps/api/src/routes/claims.ts). */

export type UiStatus = 'NEW' | 'RESPONDED' | 'DETERMINED' | 'HEARING_SCHEDULED' | 'APPEALED' | 'CLOSED';
export type Outcome = 'ALLOWED' | 'DENIED';
export type OfferResponse = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'NO_RESPONSE';

export interface ClaimNext {
  key: string;
  label: string;
  dueAt: string | null;
  overdue: boolean;
}

export interface UiClaim {
  id: string;
  associateId: string;
  associateName: string;
  clientId: string | null;
  clientName: string | null;
  separationId: string | null;
  state: string;
  claimDate: string;
  noticeReceivedAt: string;
  responseDueAt: string;
  stateClaimNumber: string | null;
  status: UiStatus;
  decision: 'CONTEST' | 'DO_NOT_CONTEST' | null;
  decisionReason: string | null;
  respondedAt: string | null;
  determination: Outcome | null;
  determinationAt: string | null;
  chargesAmount: number | null;
  hearingAt: string | null;
  hearingOutcome: Outcome | null;
  appealFiledAt: string | null;
  appealOutcome: Outcome | null;
  outcome: Outcome | null;
  notes: string | null;
  next: ClaimNext | null;
  createdAt: string;
}

export interface WorkOffer {
  id: string;
  associateId: string;
  claimId: string | null;
  offeredAt: string;
  description: string;
  payRate: number | null;
  response: OfferResponse;
  respondedAt: string | null;
  declineReason: string | null;
}

export interface ClaimEvidence {
  separation: { id: string; reason: string; reasonLabel: string; lastDayWorked: string; noticeDate: string | null; status: string; notes: string | null; finalPaycheckDate: string | null } | null;
  lastAssignment: { store: string; client: string | null; startedAt: string; endedAt: string | null; reason: string | null; stillPlaced: boolean } | null;
  discipline: Array<{ id: string; kind: string; label: string; incidentDate: string; description: string; acknowledged: boolean }>;
  attendance: { score: number; asOf: string; events: Array<{ kind: string; label: string; date: string; points: number; excused: boolean }> };
  signedPolicies: Array<{ title: string; signedAt: string }>;
  workOffers: Array<Omit<WorkOffer, 'associateId' | 'claimId'>>;
  posture: { kind: 'strong' | 'mixed' | 'weak'; points: string[] };
}

export interface UiSummary {
  open: number;
  responsesDueThisWeek: number;
  overdue: number;
  hearingsNext14Days: number;
  contestedDecided: number;
  winRate: number | null;
  estimatedSuiImpact: number;
  suiImpactFactor: number;
  byClient: Array<{ clientId: string | null; clientName: string; claims: number; allowed: number; charges: number }>;
}

const qs = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
};

export const getUiSummary = () => apiFetch<UiSummary>('/claims/unemployment/summary');
export const listUiClaims = (q: { status?: string; q?: string; page?: number } = {}) =>
  apiFetch<{ claims: UiClaim[]; total: number; hasMore: boolean }>(`/claims/unemployment?${qs(q)}`);
export const getUiClaim = (id: string) => apiFetch<{ claim: UiClaim; evidence: ClaimEvidence }>(`/claims/unemployment/${id}`);
export const openUiClaim = (body: { associateId: string; state: string; claimDate: string; noticeReceivedAt: string; responseDueAt?: string; stateClaimNumber?: string | null; notes?: string | null }) =>
  apiFetch<{ claim: UiClaim }>('/claims/unemployment', { method: 'POST', body });
export const respondUiClaim = (id: string, body: { decision: 'CONTEST' | 'DO_NOT_CONTEST'; reason: string }) => apiFetch<{ claim: UiClaim }>(`/claims/unemployment/${id}/respond`, { method: 'POST', body });
export const patchUiClaim = (id: string, body: Partial<{ determination: Outcome | null; determinationAt: string | null; chargesAmount: number | null; hearingAt: string | null; hearingOutcome: Outcome | null; appealFiledAt: string | null; appealOutcome: Outcome | null; stateClaimNumber: string | null; notes: string | null; close: boolean }>) =>
  apiFetch<{ claim: UiClaim }>(`/claims/unemployment/${id}`, { method: 'PATCH', body });
export const uiPacketUrl = (id: string) => `/api/claims/unemployment/${id}/packet.pdf`;
export const recordWorkOffer = (body: { associateId: string; claimId?: string | null; offeredAt: string; description: string; payRate?: number | null; response?: OfferResponse; declineReason?: string | null }) =>
  apiFetch<{ offer: WorkOffer }>('/claims/work-offers', { method: 'POST', body });
export const answerWorkOffer = (id: string, body: { response: OfferResponse; declineReason?: string | null }) => apiFetch<{ offer: WorkOffer }>(`/claims/work-offers/${id}`, { method: 'PATCH', body });

/* ----- Workers' comp ----- */

export type WcStatus = 'OPEN' | 'SUBMITTED' | 'ACCEPTED' | 'DENIED' | 'CLOSED';
export type Treatment = 'NONE' | 'FIRST_AID' | 'CLINIC' | 'EMERGENCY_ROOM' | 'HOSPITALIZED';

export interface FroiFields {
  employer: { name: string; fein: string | null; address: string | null; policyNumber: string | null };
  employee: { name: string; address: string | null; phone: string | null; dob: string | null; ssnLast4: string | null; hireDate: string | null; jobTitle: string | null; wageRate: number | null; wageUnit: 'HOUR' | 'YEAR' | null; hoursPerWeek: number | null };
  injury: {
    occurredAt: string;
    where: string | null;
    description: string;
    bodyPart: string | null;
    nature: string | null;
    cause: string | null;
    objectOrSubstance: string | null;
    witnesses: string | null;
    treatment: Treatment | null;
    physician: string | null;
    lastDayWorked: string | null;
    returnedToWork: boolean | null;
    fatal: boolean;
  };
  reportedBy: { name: string | null; title: string | null };
}

export interface RestrictionRules {
  maxHoursPerShift?: number | null;
  liftLimitLbs?: number | null;
  positions?: string[];
}

export interface WcClaim {
  id: string;
  oshaIncidentId: string | null;
  associateId: string;
  associateName: string;
  clientId: string | null;
  clientName: string | null;
  locationId: string | null;
  storeName: string | null;
  jurisdiction: string;
  injuryDate: string;
  reportedToEmployerAt: string;
  froiDueAt: string;
  froi: FroiFields;
  froiSubmittedAt: string | null;
  carrierName: string | null;
  carrierClaimNumber: string | null;
  status: WcStatus;
  claimType: 'MEDICAL_ONLY' | 'INDEMNITY';
  lostTimeDays: number;
  restrictedDays: number;
  reserveMedical: number | null;
  reserveIndemnity: number | null;
  restrictions: string | null;
  restrictionRules: RestrictionRules | null;
  rtwDate: string | null;
  notes: string | null;
  dutyOffers: Array<{ id: string; offeredAt: string; shiftId: string | null; description: string; response: OfferResponse; respondedAt: string | null }>;
  next: ClaimNext | null;
  createdAt: string;
}

export interface WcSummary {
  open: number;
  froiDue: number;
  froiOverdue: number;
  lostTimeDaysOpen: number;
  restrictedDaysOpen: number;
  claimsLast12Months: number;
  incidentRate: number | null;
  hoursWorkedLast12Months: number;
  byPlace: Array<{ clientName: string; storeName: string | null; claims: number; lostTimeDays: number }>;
}

export interface UnclaimedIncident {
  id: string;
  occurredAt: string;
  severity: 'MEDICAL_TREATMENT' | 'RESTRICTED_DUTY' | 'DAYS_AWAY' | 'FATAL';
  description: string;
  bodyPart: string | null;
  associateName: string | null;
  clientName: string;
  storeName: string | null;
}

export interface DutyMatch {
  id: string;
  position: string;
  startsAt: string;
  endsAt: string;
  hours: number;
  store: string | null;
  client: string | null;
}

export const getWcSummary = () => apiFetch<WcSummary>('/claims/workers-comp/summary');
export const listUnclaimedIncidents = () => apiFetch<{ incidents: UnclaimedIncident[] }>('/claims/workers-comp/incidents');
export const listWcClaims = (q: { status?: string; page?: number } = {}) => apiFetch<{ claims: WcClaim[]; total: number; hasMore: boolean }>(`/claims/workers-comp?${qs(q)}`);
export const getWcClaim = (id: string) => apiFetch<{ claim: WcClaim; froiDefaultDays: number }>(`/claims/workers-comp/${id}`);
export const openWcClaim = (body: { oshaIncidentId: string; jurisdiction?: string }) => apiFetch<{ claim: WcClaim }>('/claims/workers-comp', { method: 'POST', body });
export const patchWcClaim = (id: string, body: Record<string, unknown>) => apiFetch<{ claim: WcClaim }>(`/claims/workers-comp/${id}`, { method: 'PATCH', body });
export const submitFroi = (id: string, body: { carrierName: string; carrierClaimNumber?: string | null }) => apiFetch<{ claim: WcClaim }>(`/claims/workers-comp/${id}/submit`, { method: 'POST', body });
export const froiPdfUrl = (id: string) => `/api/claims/workers-comp/${id}/froi.pdf`;
export const getDutyMatches = (id: string) => apiFetch<{ rules: RestrictionRules | null; shifts: DutyMatch[] }>(`/claims/workers-comp/${id}/duty-matches`);
export const offerModifiedDuty = (id: string, body: { shiftId?: string | null; description: string }) => apiFetch<{ claim: WcClaim }>(`/claims/workers-comp/${id}/duty-offers`, { method: 'POST', body });
export const answerDutyOffer = (id: string, offerId: string, response: OfferResponse) =>
  apiFetch<{ claim: WcClaim }>(`/claims/workers-comp/${id}/duty-offers/${offerId}`, { method: 'PATCH', body: { response } });
