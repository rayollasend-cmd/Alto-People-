import type { ApiClientInput, ApiClientIssued, ApiClientSummary } from '@alto-people/shared';
import { apiFetch } from './api';

// Brief 2-4 — OAuth clients for the public API (/v1).

export const listApiClients = () => apiFetch<{ clients: ApiClientSummary[] }>('/api-clients');

export const createApiClient = (input: ApiClientInput) =>
  apiFetch<ApiClientIssued>('/api-clients', { method: 'POST', body: input });

export const rotateApiClient = (id: string) =>
  apiFetch<ApiClientIssued>(`/api-clients/${id}/rotate`, { method: 'POST', body: {} });

export const revokeApiClient = (id: string) =>
  apiFetch<{ client: ApiClientSummary }>(`/api-clients/${id}/revoke`, { method: 'POST', body: {} });
