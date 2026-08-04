import type { Role } from '@alto-people/shared';
import { apiFetch } from './api';

export type UserStatus = 'ACTIVE' | 'DISABLED' | 'INVITED';

export interface AdminUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  associateId: string | null;
  associateName: string | null;
  clientId: string | null;
  clientName: string | null;
  /** Non-null iff the account is currently brute-force locked (the server
   *  only surfaces locks that are still in the future). */
  lockedUntil: string | null;
}

export interface ListUsersFilters {
  role?: Role;
  status?: UserStatus;
  q?: string;
}

export interface ListUsersResponse {
  users: AdminUser[];
  /** Total matching rows server-side — may exceed users.length when the
   *  list is capped, so callers can render "Showing N of M". */
  total: number;
}

export function listAdminUsers(
  filters: ListUsersFilters = {},
): Promise<ListUsersResponse> {
  const params = new URLSearchParams();
  if (filters.role) params.set('role', filters.role);
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  const qs = params.toString();
  return apiFetch<ListUsersResponse>(
    `/admin/users${qs ? `?${qs}` : ''}`,
  );
}

export interface UserCountsResponse {
  counts: Record<UserStatus, number>;
  total: number;
}

/** Uncapped per-status account counts — the honest source for seat math. */
export function getUserCounts(): Promise<UserCountsResponse> {
  return apiFetch<UserCountsResponse>('/admin/users/counts');
}

export function patchAdminUser(
  id: string,
  body: { role?: Role; status?: UserStatus; clientId?: string | null },
): Promise<void> {
  return apiFetch<void>(`/admin/users/${id}`, { method: 'PATCH', body });
}

export function forcePasswordReset(id: string): Promise<void> {
  return apiFetch<void>(`/admin/users/${id}/force-password-reset`, {
    method: 'POST',
  });
}

/** Clear a brute-force lock (failed-login counter + lockedUntil). */
export function unlockUser(id: string): Promise<void> {
  return apiFetch<void>(`/admin/users/${id}/unlock`, { method: 'POST' });
}
