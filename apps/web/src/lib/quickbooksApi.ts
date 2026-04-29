import type {
  QboAccountConfigInput,
  QboAccountListResponse,
  QboAuthorizeStartResponse,
  QboStatus,
  QboSyncAssociatesResponse,
  QboSyncResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listQboAccounts(clientId: string): Promise<QboAccountListResponse> {
  const sp = new URLSearchParams({ clientId });
  return apiFetch<QboAccountListResponse>(`/quickbooks/accounts/list?${sp.toString()}`);
}

export function syncAssociatesToQbo(clientId: string): Promise<QboSyncAssociatesResponse> {
  return apiFetch<QboSyncAssociatesResponse>('/quickbooks/sync-associates', {
    method: 'POST',
    body: { clientId },
  });
}

export function getStatus(clientId: string): Promise<QboStatus> {
  const sp = new URLSearchParams({ clientId });
  return apiFetch<QboStatus>(`/quickbooks/status?${sp.toString()}`);
}

export function startConnect(clientId: string): Promise<QboAuthorizeStartResponse> {
  return apiFetch<QboAuthorizeStartResponse>('/quickbooks/connect/start', {
    method: 'POST',
    body: { clientId },
  });
}

export function disconnect(clientId: string): Promise<void> {
  return apiFetch<void>('/quickbooks/disconnect', {
    method: 'POST',
    body: { clientId },
  });
}

export function updateAccounts(
  clientId: string,
  body: QboAccountConfigInput
): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>('/quickbooks/accounts', {
    method: 'PATCH',
    body: { clientId, ...body },
  });
}

export function syncRun(runId: string): Promise<QboSyncResponse> {
  return apiFetch<QboSyncResponse>(`/quickbooks/sync-run/${runId}`, {
    method: 'POST',
  });
}
