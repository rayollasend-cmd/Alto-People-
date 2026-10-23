import { apiFetch } from './api';

export type AssetKind =
  | 'LAPTOP'
  | 'PHONE'
  | 'TABLET'
  | 'DEVICE'
  | 'BADGE'
  | 'KEY'
  | 'PPE'
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
  /** The store it's kept at. */
  locationId?: string | null;
  storeName?: string | null;
  clientName?: string | null;
  currentAssignment: {
    id: string;
    associateId: string;
    associateName: string;
    assignedAt: string;
    /** The holder has left (a separation is recorded). Absent on an older API. */
    holderLeft?: boolean;
  } | null;
  createdAt: string;
}

/** Counts over everything in the caller's reach (not the page's filters). */
export interface AssetSummary {
  assigned: number;
  available: number;
  inRepair: number;
  lost: number;
  /** Kit still out with someone who has left — the recovery list. */
  heldByLeavers: number;
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
  locationId?: string;
}) => {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.kind) q.set('kind', params.kind);
  if (params?.locationId) q.set('locationId', params.locationId);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ assets: Asset[]; summary?: AssetSummary; truncated?: boolean }>(`/assets${suffix}`);
};

export interface AssetInput {
  kind: AssetKind;
  label: string;
  serial?: string | null;
  model?: string | null;
  purchasedAt?: string | null;
  purchasePrice?: number | null;
  notes?: string | null;
  locationId?: string | null;
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

/** Record an asset back in hand (POST /asset-assignments/:id/return). */
export const returnAssetAssignment = (assignmentId: string, input: { notes?: string | null; newStatus?: AssetStatus } = {}) =>
  apiFetch<{ ok: true }>(`/asset-assignments/${assignmentId}/return`, { method: 'POST', body: input });
