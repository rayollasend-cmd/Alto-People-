import { apiFetch } from './api';

/**
 * What a site or client requires its people to hold; the Compliance
 * agent's coverage.credentials measures each one weekly (agent families
 * step 5).
 *
 * Query keys name their inputs:
 *   ['credentialRequirements', 'list']   every requirement with its latest week
 */

export type RequirementKind = 'VACCINATION' | 'TRAINING' | 'QUALIFICATION';

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
  latest: { weekOf: string; population: number; missing: number } | null;
}

export interface CredentialRequirementInput {
  locationId: string;
  kind: RequirementKind;
  vaccinationKind?: string | null;
  complianceTag?: string | null;
  qualificationId?: string | null;
  label: string;
}

export const listCredentialRequirements = () => apiFetch<{ requirements: CredentialRequirementRow[] }>('/credential-requirements');

export const createCredentialRequirement = (body: CredentialRequirementInput) =>
  apiFetch<{ id: string }>('/credential-requirements', { method: 'POST', body });

export const removeCredentialRequirement = (id: string) => apiFetch<void>(`/credential-requirements/${id}`, { method: 'DELETE' });
