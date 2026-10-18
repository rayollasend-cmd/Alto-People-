import type { Role } from '@alto-people/shared';
import { apiFetch } from './api';

/** The org chart's two views (apps/api/src/lib/orgChart.ts). */
export type OrgChartView = 'company' | 'field';

export type OrgNodeKind = 'person' | 'staff' | 'lead' | 'vacancy' | 'region' | 'client' | 'store' | 'group';

export interface OrgNode {
  id: string;
  parentId: string | null;
  kind: OrgNodeKind;
  name: string;
  subtitle: string | null;
  role: Role | null;
  shiftLabels: string[] | null;
  photoUrl: string | null;
  associateId: string | null;
  userId: string | null;
  departmentId: string | null;
  departmentName: string | null;
  clientId: string | null;
  clientName: string | null;
  siteName: string | null;
  reports: number;
  shiftsToday: number | null;
  filledToday: number | null;
  positionStatus: 'PLANNED' | 'OPEN' | 'FROZEN' | null;
  former: boolean;
}

export interface OrgChartResponse {
  view: OrgChartView;
  nodes: OrgNode[];
  fieldOnly: number;
  unplaced: number;
  truncated: boolean;
  limit: number;
  /** Field view at enterprise size: crew loads per store (getStoreCrew) and search runs on the server. */
  crewDeferred?: boolean;
}

export function getOrgChart(opts: { view: OrgChartView; clientId?: string | null; former?: boolean }): Promise<OrgChartResponse> {
  const qs = new URLSearchParams({ view: opts.view });
  if (opts.clientId) qs.set('clientId', opts.clientId);
  if (opts.former) qs.set('former', '1');
  return apiFetch<OrgChartResponse>(`/org/chart?${qs.toString()}`);
}

/** One store's crew, when the field view loads crew per store. */
export function getStoreCrew(siteId: string, former = false): Promise<{ nodes: OrgNode[] }> {
  return apiFetch<{ nodes: OrgNode[] }>(`/org/chart/crew?siteId=${encodeURIComponent(siteId)}${former ? '&former=1' : ''}`);
}

/** Search the whole field roster; each match comes with its store. */
export function searchFieldPeople(q: string, clientId?: string | null): Promise<{ nodes: OrgNode[] }> {
  const qs = new URLSearchParams({ q });
  if (clientId) qs.set('clientId', clientId);
  return apiFetch<{ nodes: OrgNode[] }>(`/org/chart/search?${qs.toString()}`);
}

/** Who an office account reports to (accounts with no person record, or a manager with none). */
export function setStaffReportsTo(userId: string, managerUserId: string | null): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/org/staff/${userId}/reports-to`, { method: 'PUT', body: { managerUserId } });
}
