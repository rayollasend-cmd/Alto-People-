import type {
  ManualAttestationCreateInput,
  ManualAttestationListResponse,
  ManualAttestationSignal,
  SafetyIncident,
  SafetyIncidentCreateInput,
  SafetyIncidentListResponse,
  SafetyIncidentUpdateInput,
  ScorecardActionState,
  ScorecardActionStateInput,
  ScorecardActionsResponse,
  ScorecardBillingResponse,
  ScorecardExpirationsResponse,
  ScorecardHistoryResponse,
  ScorecardOnboardingResponse,
  ScorecardSafetyResponse,
  ScorecardShiftsResponse,
  ScorecardTrainingResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

const ROOT = '/compliance-scorecard';

/** Every tile endpoint takes an optional client scope — '' / undefined = org-wide. */
const scoped = (path: string, clientId?: string) =>
  clientId ? `${ROOT}${path}?clientId=${encodeURIComponent(clientId)}` : `${ROOT}${path}`;

export function getScorecardOnboarding(clientId?: string): Promise<ScorecardOnboardingResponse> {
  return apiFetch<ScorecardOnboardingResponse>(scoped('/onboarding', clientId));
}

export function getScorecardExpirations(clientId?: string): Promise<ScorecardExpirationsResponse> {
  return apiFetch<ScorecardExpirationsResponse>(scoped('/expirations', clientId));
}

export function getScorecardShifts(clientId?: string): Promise<ScorecardShiftsResponse> {
  return apiFetch<ScorecardShiftsResponse>(scoped('/shifts', clientId));
}

export function getScorecardBilling(clientId?: string): Promise<ScorecardBillingResponse> {
  return apiFetch<ScorecardBillingResponse>(scoped('/billing', clientId));
}

export function getScorecardTraining(clientId?: string): Promise<ScorecardTrainingResponse> {
  return apiFetch<ScorecardTrainingResponse>(scoped('/training', clientId));
}

export function getScorecardActions(clientId?: string): Promise<ScorecardActionsResponse> {
  return apiFetch<ScorecardActionsResponse>(scoped('/actions', clientId));
}

export function getScorecardHistory(
  clientId?: string,
  days = 90,
): Promise<ScorecardHistoryResponse> {
  const base = scoped('/history', clientId);
  return apiFetch<ScorecardHistoryResponse>(
    `${base}${base.includes('?') ? '&' : '?'}days=${days}`,
  );
}

export function setScorecardActionState(
  body: ScorecardActionStateInput,
): Promise<{ state: ScorecardActionState }> {
  return apiFetch<{ state: ScorecardActionState }>(`${ROOT}/actions/state`, {
    method: 'POST',
    body,
  });
}

/** URL for the board one-pager PDF (opened via window.open / anchor). */
export function scorecardReportUrl(clientId?: string): string {
  return `/api${scoped('/report.pdf', clientId)}`;
}

export function getScorecardSafety(clientId?: string): Promise<ScorecardSafetyResponse> {
  return apiFetch<ScorecardSafetyResponse>(scoped('/safety', clientId));
}

export function listSafetyIncidents(
  clientId?: string,
  status?: 'OPEN' | 'CLOSED',
): Promise<SafetyIncidentListResponse> {
  const base = scoped('/safety-incidents', clientId);
  return apiFetch<SafetyIncidentListResponse>(
    status ? `${base}${base.includes('?') ? '&' : '?'}status=${status}` : base,
  );
}

export function createSafetyIncident(
  body: SafetyIncidentCreateInput,
): Promise<{ incident: SafetyIncident }> {
  return apiFetch<{ incident: SafetyIncident }>(`${ROOT}/safety-incidents`, {
    method: 'POST',
    body,
  });
}

export function updateSafetyIncident(
  id: string,
  body: SafetyIncidentUpdateInput,
): Promise<{ incident: SafetyIncident }> {
  return apiFetch<{ incident: SafetyIncident }>(`${ROOT}/safety-incidents/${id}`, {
    method: 'PATCH',
    body,
  });
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
