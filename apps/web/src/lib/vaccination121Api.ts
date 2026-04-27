import { apiFetch } from './api';

export type VaccinationKind =
  | 'COVID19'
  | 'INFLUENZA_FLU'
  | 'HEPATITIS_B'
  | 'TDAP'
  | 'MMR'
  | 'TB_TEST'
  | 'OTHER';

export interface VaccinationRecord {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  kind: VaccinationKind;
  customLabel: string | null;
  doseNumber: number;
  totalDoses: number | null;
  administeredOn: string;
  administeredBy: string | null;
  manufacturer: string | null;
  lotNumber: string | null;
  documentUrl: string | null;
  expiresOn: string | null;
  notes: string | null;
}

export interface ExpiringRecord {
  id: string;
  associateId: string;
  associateName: string;
  kind: VaccinationKind;
  customLabel: string | null;
  expiresOn: string | null;
  daysUntil: number;
  overdue: boolean;
}

export interface CoverageReport {
  totalAssociates: number;
  coverage: Record<VaccinationKind, { count: number; pct: number }>;
}

export const KIND_LABELS: Record<VaccinationKind, string> = {
  COVID19: 'COVID-19',
  INFLUENZA_FLU: 'Influenza (flu)',
  HEPATITIS_B: 'Hepatitis B',
  TDAP: 'Tdap',
  MMR: 'MMR',
  TB_TEST: 'TB test',
  OTHER: 'Other',
};

export const listVaccinations = (params: {
  associateId?: string;
  kind?: VaccinationKind;
}) => {
  const q = new URLSearchParams();
  if (params.associateId) q.set('associateId', params.associateId);
  if (params.kind) q.set('kind', params.kind);
  const qs = q.toString();
  return apiFetch<{ records: VaccinationRecord[] }>(
    `/vaccinations${qs ? `?${qs}` : ''}`,
  );
};

export const listExpiringSoon = (days = 60) =>
  apiFetch<{ days: number; records: ExpiringRecord[] }>(
    `/vaccinations/expiring-soon?days=${days}`,
  );

export const getCoverage = () =>
  apiFetch<CoverageReport>('/vaccinations/coverage');

export const createVaccination = (input: {
  associateId: string;
  kind: VaccinationKind;
  customLabel?: string | null;
  doseNumber?: number;
  totalDoses?: number | null;
  administeredOn: string;
  administeredBy?: string | null;
  manufacturer?: string | null;
  lotNumber?: string | null;
  documentUrl?: string | null;
  expiresOn?: string | null;
  notes?: string | null;
}) =>
  apiFetch<{ id: string }>('/vaccinations', { method: 'POST', body: input });

export const deleteVaccination = (id: string) =>
  apiFetch<void>(`/vaccinations/${id}`, { method: 'DELETE' });
