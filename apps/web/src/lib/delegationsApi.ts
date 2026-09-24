import type { TeamDelegation, TeamDelegationCandidate, TeamDelegationInput, TeamDelegationsResponse } from '@alto-people/shared';
import { apiFetch } from './api';

/** Out-of-office cover for the team inbox — who covers for me, whom I cover. */

export function getMyDelegations(): Promise<TeamDelegationsResponse> {
  return apiFetch<TeamDelegationsResponse>('/delegations/mine');
}

export function getDelegationCandidates(): Promise<{ candidates: TeamDelegationCandidate[] }> {
  return apiFetch<{ candidates: TeamDelegationCandidate[] }>('/delegations/candidates');
}

export function createDelegation(input: TeamDelegationInput): Promise<{ delegation: TeamDelegation }> {
  return apiFetch<{ delegation: TeamDelegation }>('/delegations', { method: 'POST', body: JSON.stringify(input) });
}

export function removeDelegation(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/delegations/${id}`, { method: 'DELETE' });
}
