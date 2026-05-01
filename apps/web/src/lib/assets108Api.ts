import { apiFetch } from './api';

export type AssetKind =
  | 'LAPTOP'
  | 'PHONE'
  | 'TABLET'
  | 'BADGE'
  | 'KEY'
  | 'VEHICLE'
  | 'UNIFORM'
  | 'OTHER';

export type AssetStatus =
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'RETIRED'
  | 'LOST'
  | 'IN_REPAIR';

export interface Asset {
  id: string;
  kind: AssetKind;
  label: string;
  serial: string | null;
  model: string | null;
  status: AssetStatus;
  purchasedAt: string | null;
  purchasePrice: string | null;
  notes: string | null;
  currentAssignment: {
    id: string;
    associateId: string;
    associateName: string;
    assignedAt: string;
  } | null;
  createdAt: string;
}

export interface AssetAssignment {
  id: string;
  assetId: string;
  assetKind: AssetKind;
  assetLabel: string;
  assetSerial: string | null;
  associateId: string;
  associateName: string;
  assignedAt: string;
  returnedAt: string | null;
  returnNotes: string | null;
}

export const listAssets = (params?: {
  status?: AssetStatus;
  kind?: AssetKind;
}) => {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.kind) q.set('kind', params.kind);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ assets: Asset[] }>(`/assets${suffix}`);
};

export interface AssetInput {
  kind: AssetKind;
  label: string;
  serial?: string | null;
  model?: string | null;
  purchasedAt?: string | null;
  purchasePrice?: number | null;
  notes?: string | null;
}

export const createAsset = (input: AssetInput) =>
  apiFetch<{ id: string }>('/assets', { method: 'POST', body: input });

export const updateAsset = (id: string, input: Partial<AssetInput>) =>
  apiFetch<{ ok: true }>(`/assets/${id}`, { method: 'PUT', body: input });

export const deleteAsset = (id: string) =>
  apiFetch<void>(`/assets/${id}`, { method: 'DELETE' });

export const assignAsset = (input: { assetId: string; associateId: string }) =>
  apiFetch<{ ok: true }>('/asset-assignments', {
    method: 'POST',
    body: input,
  });

export const returnAsset = (
  assignmentId: string,
  input?: { notes?: string; newStatus?: 'AVAILABLE' | 'LOST' | 'IN_REPAIR' | 'RETIRED' },
) =>
  apiFetch<{ ok: true }>(`/asset-assignments/${assignmentId}/return`, {
    method: 'POST',
    body: input ?? {},
  });

export const listAssetAssignments = (params?: {
  associateId?: string;
  assetId?: string;
}) => {
  const q = new URLSearchParams();
  if (params?.associateId) q.set('associateId', params.associateId);
  if (params?.assetId) q.set('assetId', params.assetId);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ assignments: AssetAssignment[] }>(
    `/asset-assignments${suffix}`,
  );
};
