import { apiFetch } from './api';
import type { SiteType } from '@alto-people/shared';

/** The business structure, edited from the Org chart (apps/api/src/routes/structure.ts). */

export interface StructureOptions {
  regions: Array<{ id: string; name: string }>;
  /** Cost centers and business units; regionId is the region they sit under, if any. */
  costCenters: Array<{ id: string; type: string; name: string; code: string | null; glCode: string | null; regionId: string | null }>;
  /** Empty for a direct employer (no client portal). */
  clients: Array<{ id: string; name: string }>;
  businessModel: string;
}

export interface SiteDetails {
  id: string;
  name: string;
  type: SiteType;
  timezone: string;
  isActive: boolean;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  clientId: string | null;
  clientName: string | null;
  regionId: string | null;
  orgUnitId: string | null;
  costCenter: { id: string; name: string; code: string | null; glCode: string | null } | null;
}

export const getStructureOptions = () => apiFetch<StructureOptions>('/org/structure/options');
export const getSiteDetails = (id: string) => apiFetch<{ site: SiteDetails }>(`/org/structure/sites/${encodeURIComponent(id)}`);
export const createRegion = (name: string) => apiFetch<{ region: { id: string; name: string } }>('/org/structure/regions', { method: 'POST', body: { name } });
export const renameRegion = (id: string, name: string) =>
  apiFetch<{ region: { id: string; name: string } }>(`/org/structure/regions/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
export const retireRegion = (id: string) => apiFetch<void>(`/org/structure/regions/${encodeURIComponent(id)}`, { method: 'DELETE' });

export interface PlacementResult {
  regionId: string | null;
  orgUnitId: string | null;
  costCenterCleared: boolean;
}
export const placeSite = (id: string, change: { regionId?: string | null; orgUnitId?: string | null }) =>
  apiFetch<PlacementResult>(`/org/structure/sites/${encodeURIComponent(id)}/placement`, { method: 'PUT', body: change });

export interface NewSiteInput {
  name: string;
  type?: SiteType;
  timezone?: string;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  clientId?: string | null;
  regionId?: string | null;
}
export const createStructureSite = (body: NewSiteInput) =>
  apiFetch<{ site: { id: string; name: string; type: SiteType; clientId: string | null } }>('/org/structure/sites', { method: 'POST', body });

/* ----- Node ids on the field chart (lib/orgChart.ts) ------------------------- */

/** The site behind a store node ("s:<id>"). */
export const siteIdOf = (nodeId: string): string | null => (nodeId.startsWith('s:') ? nodeId.slice(2) : null);
/** The region behind a region node ("r:<id>"). */
export const regionIdOf = (nodeId: string): string | null => (nodeId.startsWith('r:') ? nodeId.slice(2) : null);
