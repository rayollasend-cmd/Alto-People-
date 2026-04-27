import { apiFetch } from './api';

// ----- Open enrollment ---------------------------------------------------

export type OpenEnrollmentStatus = 'DRAFT' | 'OPEN' | 'CLOSED';

export interface OpenEnrollmentWindow {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  startsOn: string;
  endsOn: string;
  effectiveOn: string;
  status: OpenEnrollmentStatus;
  createdAt: string;
}

export const listOpenEnrollment = (clientId?: string) =>
  apiFetch<{ windows: OpenEnrollmentWindow[] }>(
    clientId ? `/open-enrollment?clientId=${clientId}` : '/open-enrollment',
  );

export const createOpenEnrollment = (input: {
  clientId: string;
  name: string;
  startsOn: string;
  endsOn: string;
  effectiveOn: string;
}) => apiFetch<{ id: string }>('/open-enrollment', { method: 'POST', body: input });

export const openEnrollmentOpen = (id: string) =>
  apiFetch<{ ok: true }>(`/open-enrollment/${id}/open`, { method: 'POST', body: {} });

export const openEnrollmentClose = (id: string) =>
  apiFetch<{ ok: true }>(`/open-enrollment/${id}/close`, { method: 'POST', body: {} });

// ----- QLE ---------------------------------------------------------------

export type QleKind =
  | 'MARRIAGE'
  | 'DIVORCE'
  | 'BIRTH'
  | 'ADOPTION'
  | 'DEATH_OF_DEPENDENT'
  | 'LOSS_OF_COVERAGE'
  | 'GAIN_OF_COVERAGE'
  | 'RELOCATION'
  | 'OTHER';

export type QleStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

export interface Qle {
  id: string;
  associateId: string;
  associateName: string;
  kind: QleKind;
  eventDate: string;
  allowedUntil: string;
  evidenceUrl: string | null;
  notes: string | null;
  status: QleStatus;
  decidedAt: string | null;
  createdAt: string;
}

export const listQles = (params?: { associateId?: string; status?: QleStatus }) => {
  const q = new URLSearchParams();
  if (params?.associateId) q.set('associateId', params.associateId);
  if (params?.status) q.set('status', params.status);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ qles: Qle[] }>(`/qles${suffix}`);
};

export const createQle = (input: {
  associateId: string;
  kind: QleKind;
  eventDate: string;
  allowedUntil?: string;
  evidenceUrl?: string | null;
  notes?: string | null;
}) => apiFetch<{ id: string }>('/qles', { method: 'POST', body: input });

export const decideQle = (id: string, decision: 'APPROVED' | 'DENIED') =>
  apiFetch<{ ok: true }>(`/qles/${id}/decide`, {
    method: 'POST',
    body: { decision },
  });

// ----- COBRA -------------------------------------------------------------

export type CobraStatus = 'NOTIFIED' | 'ELECTED' | 'WAIVED' | 'EXPIRED' | 'TERMINATED';

export interface CobraOffer {
  id: string;
  associateId: string;
  associateName: string;
  qualifyingEvent: string;
  qeDate: string;
  electionDeadline: string;
  coverageEndsOn: string;
  noticedAt: string;
  electedAt: string | null;
  premiumPerMonth: string | null;
  status: CobraStatus;
}

export const listCobra = () =>
  apiFetch<{ offers: CobraOffer[] }>('/cobra');

export const createCobra = (input: {
  associateId: string;
  qualifyingEvent: string;
  qeDate: string;
  electionDeadline?: string;
  coverageEndsOn?: string;
  premiumPerMonth?: number | null;
}) => apiFetch<{ id: string }>('/cobra', { method: 'POST', body: input });

export const electCobra = (id: string) =>
  apiFetch<{ ok: true }>(`/cobra/${id}/elect`, { method: 'POST', body: {} });

export const waiveCobra = (id: string) =>
  apiFetch<{ ok: true }>(`/cobra/${id}/waive`, { method: 'POST', body: {} });

// ----- ACA ---------------------------------------------------------------

export interface AcaEmployeeMonths {
  associateId: string;
  associateName: string;
  months: Array<{
    month: number;
    offerOfCoverage: string | null;
    lowestPremiumCents: number | null;
    safeHarbor: string | null;
    isFullTime: boolean;
  } | null>;
}

export const get1095c = (year: number) =>
  apiFetch<{ year: number; employees: AcaEmployeeMonths[] }>(
    `/aca/1095c?year=${year}`,
  );

export const upsertAcaMonth = (input: {
  associateId: string;
  year: number;
  month: number;
  offerOfCoverage?: string | null;
  lowestPremiumCents?: number | null;
  safeHarbor?: string | null;
  isFullTime?: boolean;
}) => apiFetch<{ ok: true }>('/aca/months', { method: 'POST', body: input });
