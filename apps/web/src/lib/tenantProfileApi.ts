import type { BusinessModel, TenantModule, TenantModules, TenantProfile, TermKey, Terminology, UpdateTenantProfileInput } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Brief 2-1b — the tenant profile: business model, module switches and
 * the terminology table. Read by the Organization profile page.
 */
export interface TenantProfileResponse {
  tenantId: string;
  /** The Organization page's header: name, plan, people on the books (hired, not separated), active sites. */
  facts?: { name: string | null; plan: string | null; createdAt: string | null; onTheBooks: number; sites: number };
  profile: TenantProfile;
  defaults: { modules: TenantModules; terminology: Terminology };
  catalog: {
    businessModels: readonly BusinessModel[];
    modules: Array<{ key: TenantModule; label: string }>;
    termKeys: readonly TermKey[];
  };
}

export const getTenantProfile = () => apiFetch<TenantProfileResponse>('/admin/tenant/profile');

export const saveTenantProfile = (body: UpdateTenantProfileInput) =>
  apiFetch<{ tenantId: string; profile: TenantProfile }>('/admin/tenant/profile', { method: 'PUT', body });
