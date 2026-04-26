import type {
  BackgroundCheck,
  BackgroundCheckListResponse,
  BackgroundInitiateInput,
  BackgroundUpdateInput,
  I9ListResponse,
  I9UpsertInput,
  I9Verification,
  J1ListResponse,
  J1Profile,
  J1UpsertInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listI9s(filter: 'pending' | 'complete' | 'all' = 'all'): Promise<I9ListResponse> {
  const qs = filter === 'all' ? '' : `?status=${filter}`;
  return apiFetch<I9ListResponse>(`/compliance/i9${qs}`);
}

export function upsertI9(associateId: string, body: I9UpsertInput): Promise<I9Verification> {
  return apiFetch<I9Verification>(`/compliance/i9/${associateId}`, {
    method: 'POST',
    body,
  });
}

export function listBackgroundChecks(): Promise<BackgroundCheckListResponse> {
  return apiFetch<BackgroundCheckListResponse>('/compliance/background');
}

export function initiateBackgroundCheck(
  body: BackgroundInitiateInput
): Promise<BackgroundCheck> {
  return apiFetch<BackgroundCheck>('/compliance/background', { method: 'POST', body });
}

export function updateBackgroundCheck(
  id: string,
  body: BackgroundUpdateInput
): Promise<BackgroundCheck> {
  return apiFetch<BackgroundCheck>(`/compliance/background/${id}/update`, {
    method: 'POST',
    body,
  });
}

export function listJ1Profiles(opts: { expiringWithin?: number } = {}): Promise<J1ListResponse> {
  const qs = opts.expiringWithin ? `?expiringWithin=${opts.expiringWithin}` : '';
  return apiFetch<J1ListResponse>(`/compliance/j1${qs}`);
}

export function upsertJ1(associateId: string, body: J1UpsertInput): Promise<J1Profile> {
  return apiFetch<J1Profile>(`/compliance/j1/${associateId}`, { method: 'POST', body });
}
