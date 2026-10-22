import type {
  IntegrationCapability,
  IntegrationConnectionCreateInput,
  IntegrationConnectionPatchInput,
  IntegrationConnectionSummary,
  IntegrationSyncErrorRow,
  IntegrationSyncRequestInput,
  IntegrationSyncRunSummary,
  IntegrationVendorInfo,
} from '@alto-people/shared';
import { apiFetch } from './api';

/** Brief 3-5: the tenant admin's HR and VMS connections. */
export const listIntegrationVendors = () => apiFetch<{ vendors: IntegrationVendorInfo[] }>('/integration-connections/vendors');
export const listIntegrationConnections = () => apiFetch<{ connections: IntegrationConnectionSummary[] }>('/integration-connections');
export const getIntegrationConnection = (id: string) =>
  apiFetch<{ connection: IntegrationConnectionSummary; vendor: IntegrationVendorInfo; runs: IntegrationSyncRunSummary[] }>(`/integration-connections/${id}`);
export const createIntegrationConnection = (body: IntegrationConnectionCreateInput) =>
  apiFetch<{ connection: IntegrationConnectionSummary }>('/integration-connections', { method: 'POST', body });
export const patchIntegrationConnection = (id: string, body: IntegrationConnectionPatchInput) =>
  apiFetch<{ connection: IntegrationConnectionSummary }>(`/integration-connections/${id}`, { method: 'PATCH', body });
export const deleteIntegrationConnection = (id: string) => apiFetch<void>(`/integration-connections/${id}`, { method: 'DELETE' });
export const testIntegrationConnection = (id: string) =>
  apiFetch<{ results: Array<{ capability: IntegrationCapability; runId: string | null; status: string; total: number; succeeded: number; failed: number }> }>(`/integration-connections/${id}/test`, { method: 'POST' });
export const syncIntegrationConnection = (id: string, body: IntegrationSyncRequestInput) =>
  apiFetch<{ run: { runId: string; status: string; total: number; succeeded: number; failed: number } }>(`/integration-connections/${id}/sync`, { method: 'POST', body });
export const listIntegrationRunErrors = (runId: string) => apiFetch<{ errors: IntegrationSyncErrorRow[] }>(`/integration-connections/runs/${runId}/errors`);
