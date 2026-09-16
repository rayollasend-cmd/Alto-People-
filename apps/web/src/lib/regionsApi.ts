import { apiFetch } from './api';

/* ---- The region command center --------------------------------------- */

export interface StoreSnapshot {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  timezone: string;
  now: { onFloor: number; target: number | null; targetLabel: string | null; short: number };
  today: { expected: number; present: number; open: number; missedSoFar: number };
  tomorrow: { expected: number; open: number; unconfirmed: number };
  reliability: {
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    score: number | null;
    basis: 'contract' | 'schedule' | null;
  };
  requests: { open: number; overdue: number };
  leads: { onFloor: number; total: number };
  alert: string | null;
}

export interface RegionOverview {
  region: { id: string; name: string };
  generatedAt: string;
  preview: boolean;
  totals: {
    stores: number;
    onFloor: number;
    target: number | null;
    shortNow: number;
    alerts: number;
    openToday: number;
    openTomorrow: number;
    unconfirmedTomorrow: number;
    openRequests: number;
    overdueRequests: number;
    score: number | null;
    gradeCounts: Record<string, number>;
  };
  stores: StoreSnapshot[];
}

export function regionOverview(regionId?: string | null): Promise<RegionOverview> {
  return apiFetch(`/region/overview${regionId ? `?regionId=${encodeURIComponent(regionId)}` : ''}`);
}

/* ---- Regions admin ------------------------------------------------------ */

export interface RegionStore {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
}

export interface RegionRow {
  id: string;
  name: string;
  stores: RegionStore[];
  accounts: Array<{ id: string; email: string; status: string }>;
}

export function listRegions(): Promise<{ regions: RegionRow[]; unassigned: RegionStore[] }> {
  return apiFetch('/regions');
}

export function createRegion(body: { name: string; locationIds?: string[] }): Promise<{ id: string }> {
  return apiFetch('/regions', { method: 'POST', body });
}

export function updateRegion(id: string, body: { name?: string; locationIds?: string[] }): Promise<void> {
  return apiFetch<void>(`/regions/${id}`, { method: 'PATCH', body });
}

export function deleteRegion(id: string): Promise<void> {
  return apiFetch<void>(`/regions/${id}`, { method: 'DELETE' });
}
