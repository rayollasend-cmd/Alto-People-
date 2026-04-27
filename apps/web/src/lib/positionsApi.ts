import type {
  Position,
  PositionAssignInput,
  PositionHeadcount,
  PositionInput,
  PositionListResponse,
  PositionStatus,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listPositions(filters: {
  clientId?: string;
  status?: PositionStatus;
} = {}): Promise<PositionListResponse> {
  const sp = new URLSearchParams();
  if (filters.clientId) sp.set('clientId', filters.clientId);
  if (filters.status) sp.set('status', filters.status);
  const qs = sp.toString();
  return apiFetch<PositionListResponse>(`/positions${qs ? `?${qs}` : ''}`);
}

export function getHeadcount(clientId?: string): Promise<PositionHeadcount> {
  const q = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return apiFetch<PositionHeadcount>(`/positions/headcount${q}`);
}

export function createPosition(input: PositionInput): Promise<Position> {
  return apiFetch<Position>('/positions', { method: 'POST', body: input });
}

export function updatePosition(
  id: string,
  input: Partial<PositionInput>,
): Promise<Position> {
  return apiFetch<Position>(`/positions/${id}`, { method: 'PUT', body: input });
}

export function setPositionStatus(
  id: string,
  status: PositionStatus,
): Promise<Position> {
  return apiFetch<Position>(`/positions/${id}/status`, {
    method: 'POST',
    body: { status },
  });
}

export function assignPosition(
  id: string,
  input: PositionAssignInput,
): Promise<Position> {
  return apiFetch<Position>(`/positions/${id}/assign`, {
    method: 'POST',
    body: input,
  });
}

export function vacatePosition(id: string): Promise<Position> {
  return apiFetch<Position>(`/positions/${id}/vacate`, { method: 'POST' });
}

export function deletePosition(id: string): Promise<void> {
  return apiFetch<void>(`/positions/${id}`, { method: 'DELETE' });
}
