import type { Role } from '@alto-people/shared';
import { apiFetch } from './api';

/** Brief 2-3 step 3 — the permission matrix and custom roles (/tenant-roles). */

export interface TenantRoleRow {
  /** `system:<ROLE>` for a built-in role. */
  id: string;
  name: string;
  description: string | null;
  archetype: Role;
  system: boolean;
  capabilities: string[];
  holders: number;
  /** False when the role's module is off for this organization. */
  offered: boolean;
}

export interface ScimGroupMapping {
  id: string;
  groupName: string;
  archetype: Role;
  tenantRoleId: string | null;
  tenantRoleName: string | null;
  priority: number;
}

export const getTenantRoles = () => apiFetch<{ capabilities: string[]; roles: TenantRoleRow[] }>('/tenant-roles');

export const createTenantRole = (body: { name: string; description?: string | null; archetype: Role; capabilities: string[] }) =>
  apiFetch<{ id: string }>('/tenant-roles', { method: 'POST', body });

export const updateTenantRole = (id: string, body: { name?: string; description?: string | null; capabilities?: string[] }) =>
  apiFetch<{ ok: true }>(`/tenant-roles/${id}`, { method: 'PATCH', body });

export const deleteTenantRole = (id: string) => apiFetch<void>(`/tenant-roles/${id}`, { method: 'DELETE' });

export const assignTenantRole = (userId: string, tenantRoleId: string | null) =>
  apiFetch<{ ok: true }>(`/tenant-roles/assign/${userId}`, { method: 'PUT', body: { tenantRoleId } });

export const getScimGroups = () =>
  apiFetch<{ mappings: ScimGroupMapping[]; groups: Array<{ id: string; displayName: string; members: number; updatedAt: string }> }>('/tenant-roles/scim-groups');

export const mapScimGroup = (body: { groupName: string; archetype: Role; tenantRoleId?: string | null; priority?: number }) =>
  apiFetch<{ id: string }>('/tenant-roles/scim-groups', { method: 'POST', body });

export const unmapScimGroup = (id: string) => apiFetch<void>(`/tenant-roles/scim-groups/${id}`, { method: 'DELETE' });
