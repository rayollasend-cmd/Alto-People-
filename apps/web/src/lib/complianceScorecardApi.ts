import type {
  ManualAttestationCreateInput,
  ManualAttestationListResponse,
  ManualAttestationSignal,
  ScorecardActionsResponse,
  ScorecardBillingResponse,
  ScorecardExpirationsResponse,
  ScorecardOnboardingResponse,
  ScorecardShiftsResponse,
  ScorecardTrainingResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

const ROOT = '/compliance-scorecard';

export function getScorecardOnboarding(): Promise<ScorecardOnboardingResponse> {
  return apiFetch<ScorecardOnboardingResponse>(`${ROOT}/onboarding`);
}

export function getScorecardExpirations(): Promise<ScorecardExpirationsResponse> {
  return apiFetch<ScorecardExpirationsResponse>(`${ROOT}/expirations`);
}

export function getScorecardShifts(): Promise<ScorecardShiftsResponse> {
  return apiFetch<ScorecardShiftsResponse>(`${ROOT}/shifts`);
}

export function getScorecardBilling(): Promise<ScorecardBillingResponse> {
  return apiFetch<ScorecardBillingResponse>(`${ROOT}/billing`);
}

export function getScorecardTraining(): Promise<ScorecardTrainingResponse> {
  return apiFetch<ScorecardTrainingResponse>(`${ROOT}/training`);
}

export function getScorecardActions(): Promise<ScorecardActionsResponse> {
  return apiFetch<ScorecardActionsResponse>(`${ROOT}/actions`);
}

export function listAttestationSignals(): Promise<ManualAttestationListResponse> {
  return apiFetch<ManualAttestationListResponse>(`${ROOT}/attestations`);
}

export function upsertAttestation(
  body: ManualAttestationCreateInput,
): Promise<{ signal: ManualAttestationSignal }> {
  return apiFetch<{ signal: ManualAttestationSignal }>(`${ROOT}/attestations`, {
    method: 'POST',
    body,
  });
}
