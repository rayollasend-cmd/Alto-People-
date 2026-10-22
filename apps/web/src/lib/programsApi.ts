import type {
  ProgramAlertSettings,
  ProgramAlertsResponse,
  ProgramInput,
  ProgramListResponse,
  ProgramSummary,
  ProgramType,
  ProgramUpdate,
  Sponsor,
  SponsorInput,
  SponsorReportResponse,
  TransitionCalendarResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Program Lifecycle reads and writes (Brief 1C-2): J-1 / H-2B records,
 * sponsors, the alerts their dates fire, the transition calendar and the
 * sponsor report. Every list takes its filters as inputs so the query
 * keys that wrap these can name them.
 */

export interface ProgramFilters {
  type?: ProgramType;
  sponsorId?: string;
  clientId?: string;
  associateId?: string;
  history?: boolean;
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function listPrograms(filters: ProgramFilters = {}): Promise<ProgramListResponse> {
  return apiFetch<ProgramListResponse>(
    `/programs${qs({ type: filters.type, sponsorId: filters.sponsorId, clientId: filters.clientId, associateId: filters.associateId, history: filters.history ? '1' : undefined })}`,
  );
}

export function createProgram(body: ProgramInput): Promise<ProgramSummary> {
  return apiFetch<ProgramSummary>('/programs', { method: 'POST', body });
}

export function updateProgram(id: string, body: ProgramUpdate): Promise<ProgramSummary> {
  return apiFetch<ProgramSummary>(`/programs/${id}`, { method: 'PATCH', body });
}

export function getAssociateProgram(associateId: string): Promise<{ program: ProgramSummary | null }> {
  return apiFetch<{ program: ProgramSummary | null }>(`/programs/associate/${associateId}`);
}

/** A supervisor's floor only; admins get everything. */
export function listMyProgramAlerts(): Promise<ProgramAlertsResponse> {
  return apiFetch<ProgramAlertsResponse>('/programs/alerts/mine');
}

export function getAlertSettings(): Promise<ProgramAlertSettings> {
  return apiFetch<ProgramAlertSettings>('/programs/alert-settings');
}

export function saveAlertSettings(body: ProgramAlertSettings): Promise<ProgramAlertSettings> {
  return apiFetch<ProgramAlertSettings>('/programs/alert-settings', { method: 'PUT', body });
}

export function listSponsors(): Promise<{ sponsors: Sponsor[] }> {
  return apiFetch<{ sponsors: Sponsor[] }>('/programs/sponsors');
}

export function createSponsor(body: SponsorInput): Promise<Sponsor> {
  return apiFetch<Sponsor>('/programs/sponsors', { method: 'POST', body });
}

export function updateSponsor(id: string, body: Partial<SponsorInput>): Promise<Sponsor> {
  return apiFetch<Sponsor>(`/programs/sponsors/${id}`, { method: 'PATCH', body });
}

export interface CalendarQuery {
  from: string;
  to: string;
  locationId?: string;
  clientId?: string;
}

export function getTransitionCalendar(q: CalendarQuery): Promise<TransitionCalendarResponse> {
  return apiFetch<TransitionCalendarResponse>(`/programs/calendar${qs({ from: q.from, to: q.to, locationId: q.locationId, clientId: q.clientId })}`);
}

/** The PDF: counts and dates only, safe to hand a client. */
export function transitionCalendarPdfUrl(q: CalendarQuery): string {
  return `/api/programs/calendar${qs({ from: q.from, to: q.to, locationId: q.locationId, clientId: q.clientId, format: 'pdf' })}`;
}

export function getSponsorReport(id: string, from: string, to: string): Promise<SponsorReportResponse> {
  return apiFetch<SponsorReportResponse>(`/programs/sponsors/${id}/report${qs({ from, to })}`);
}

export function sponsorReportUrl(id: string, from: string, to: string, format: 'csv' | 'pdf'): string {
  return `/api/programs/sponsors/${id}/report${qs({ from, to, format })}`;
}
