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
}

export interface ListUsersFilters {
  role?: Role;
  status?: UserStatus;
  q?: string;
}

export function listAdminUsers(
  filters: ListUsersFilters = {},
): Promise<{ users: AdminUser[] }> {
  const params = new URLSearchParams();
  if (filters.role) params.set('role', filters.role);
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  const qs = params.toString();
  return apiFetch<{ users: AdminUser[] }>(
    `/admin/users${qs ? `?${qs}` : ''}`,
  );
}

export function patchAdminUser(
  id: string,
  body: { role?: Role; status?: UserStatus },
): Promise<void> {
  return apiFetch<void>(`/admin/users/${id}`, { method: 'PATCH', body });
}

export function forcePasswordReset(id: string): Promise<void> {
  return apiFetch<void>(`/admin/users/${id}/force-password-reset`, {
    method: 'POST',
  });
}
