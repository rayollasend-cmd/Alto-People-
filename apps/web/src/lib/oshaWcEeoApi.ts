import { apiFetch } from './api';

export type OshaSeverity =
  | 'FIRST_AID'
  | 'MEDICAL_TREATMENT'
  | 'RESTRICTED_DUTY'
  | 'DAYS_AWAY'
  | 'FATAL';

export type OshaStatus = 'REPORTED' | 'INVESTIGATING' | 'RESOLVED' | 'ESCALATED';

export interface OshaIncident {
  id: string;
  clientId: string;
  clientName: string;
  associateId: string | null;
  associateName: string | null;
  occurredAt: string;
  reportedAt: string;
  location: string | null;
  description: string;
  bodyPart: string | null;
  severity: OshaSeverity;
  daysAway: number;
  daysRestricted: number;
  isRecordable: boolean;
  status: OshaStatus;
  resolutionNote: string | null;
  resolvedAt: string | null;
}

export interface WcClassCode {
  id: string;
  stateCode: string | null;
  code: string;
  description: string;
  ratePer100: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export const listOshaIncidents = (clientId?: string) =>
  apiFetch<{ incidents: OshaIncident[] }>(
    clientId ? `/osha/incidents?clientId=${clientId}` : '/osha/incidents',
  );
export const createOshaIncident = (input: {
  clientId: string;
  associateId?: string | null;
  occurredAt: string;
  location?: string | null;
  description: string;
  bodyPart?: string | null;
  severity: OshaSeverity;
  daysAway?: number;
  daysRestricted?: number;
}) => apiFetch<{ id: string }>('/osha/incidents', { method: 'POST', body: input });
export const updateOshaIncident = (
  id: string,
  input: {
    status?: OshaStatus;
    resolutionNote?: string | null;
    daysAway?: number;
    daysRestricted?: number;
    isRecordable?: boolean;
  },
) => apiFetch<{ ok: true }>(`/osha/incidents/${id}`, { method: 'PUT', body: input });
export const get300A = (clientId: string, year: number) =>
  apiFetch<{
    totalCases: number;
    fatalities: number;
    daysAwayCases: number;
    restrictedCases: number;
    otherRecordable: number;
    totalDaysAway: number;
    totalDaysRestricted: number;
  }>(`/osha/300a?clientId=${clientId}&year=${year}`);

export const listWcClassCodes = (stateCode?: string) =>
  apiFetch<{ codes: WcClassCode[] }>(
    stateCode ? `/wc/class-codes?stateCode=${stateCode}` : '/wc/class-codes',
  );
export const createWcClassCode = (input: {
  stateCode?: string | null;
  code: string;
  description: string;
  ratePer100: number;
  effectiveFrom: string;
}) => apiFetch<{ id: string }>('/wc/class-codes', { method: 'POST', body: input });

export const getEeoReport = (clientId: string) =>
  apiFetch<{
    total: number;
    buckets: Array<{ category: string; race: string; gender: string; count: number }>;
  }>(`/eeo/report?clientId=${clientId}`);
