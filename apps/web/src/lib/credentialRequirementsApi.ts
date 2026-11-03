import { apiFetch } from './api';

/**
 * What a site or client requires its people to hold; the Compliance
 * agent's coverage.credentials measures each one weekly (agent families
 * step 5).
 *
 * Query keys name their inputs:
 *   ['credentialRequirements', 'list']   every requirement with its latest week
 */

/** BACKGROUND_CHECK / DRUG_TEST (cleared to work, owner 2026-11-03): a passed one no older than maxAgeDays. */
export type RequirementKind = 'VACCINATION' | 'TRAINING' | 'QUALIFICATION' | 'BACKGROUND_CHECK' | 'DRUG_TEST';

export interface CredentialRequirementRow {
  id: string;
  kind: RequirementKind;
  label: string;
  locationId: string | null;
  clientId: string | null;
  place: string;
  vaccinationKind: string | null;
  complianceTag: string | null;
  qualificationId: string | null;
  /** Screenings: how old the latest passed one may be, in days; null = any. Absent from older servers. */
  maxAgeDays?: number | null;
  latest: { weekOf: string; population: number; missing: number } | null;
}

export interface CredentialRequirementInput {
  /** One site, (clientId) every site of a client, or (companyWide) everyone in the workforce. */
  locationId?: string;
  clientId?: string;
  companyWide?: boolean;
  kind: RequirementKind;
  vaccinationKind?: string | null;
  complianceTag?: string | null;
  qualificationId?: string | null;
  maxAgeDays?: number | null;
  label: string;
}

export const listCredentialRequirements = () => apiFetch<{ requirements: CredentialRequirementRow[] }>('/credential-requirements');

export const createCredentialRequirement = (body: CredentialRequirementInput) =>
  apiFetch<{ id: string }>('/credential-requirements', { method: 'POST', body });

export const removeCredentialRequirement = (id: string) => apiFetch<void>(`/credential-requirements/${id}`, { method: 'DELETE' });
