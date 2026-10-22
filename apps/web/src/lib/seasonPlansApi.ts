import type {
  SeasonDemandWeek,
  SeasonPlanCompareResponse,
  SeasonPlanComputed,
  SeasonPlanInput,
  SeasonPlanListResponse,
  SeasonPlanUpdate,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The Season Planner reads and writes. A plan is a scenario of inputs;
 * every number the page shows is computed by the server on read, so a
 * save is always followed by a refetch rather than local arithmetic.
 */

export interface SeasonPlanDefaultsResponse {
  weeks: string[];
  vans: { count: number; maxCapacity: number };
  sites: Array<{
    locationId: string;
    siteName: string;
    clientId: string;
    clientName: string;
    bedsAvailable: number;
    vanSeatsPerRun: number;
    runsPerShift: number;
    routeMinutes: number;
    demand: SeasonDemandWeek[];
  }>;
}

export function listSeasonPlans(includeArchived = false): Promise<SeasonPlanListResponse> {
  return apiFetch<SeasonPlanListResponse>(`/season-plans${includeArchived ? '?archived=1' : ''}`);
}

export function getSeasonPlan(id: string): Promise<SeasonPlanComputed> {
  return apiFetch<SeasonPlanComputed>(`/season-plans/${id}`);
}

export function createSeasonPlan(body: SeasonPlanInput): Promise<SeasonPlanComputed> {
  return apiFetch<SeasonPlanComputed>('/season-plans', { method: 'POST', body });
}

export function updateSeasonPlan(id: string, body: SeasonPlanUpdate): Promise<SeasonPlanComputed> {
  return apiFetch<SeasonPlanComputed>(`/season-plans/${id}`, { method: 'PATCH', body });
}

export function duplicateSeasonPlan(id: string, name: string): Promise<SeasonPlanComputed> {
  return apiFetch<SeasonPlanComputed>(`/season-plans/${id}/duplicate`, { method: 'POST', body: { name } });
}

export function compareSeasonPlans(a: string, b: string): Promise<SeasonPlanCompareResponse> {
  return apiFetch<SeasonPlanCompareResponse>(`/season-plans/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
}

/** Download hrefs — opened with window.open so iOS hands them to Files. */
export function seasonPlanCsvUrl(id: string): string {
  return `/api/season-plans/${id}/csv`;
}

export function seasonPlanSitePdfUrl(id: string, locationId: string): string {
  return `/api/season-plans/${id}/sites/${locationId}/pdf`;
}

/** What-if on the live week (field roles, 2026-10): the plan against the calendar. */
export interface LiveWhatIfRow {
  locationId: string;
  siteName: string;
  clientId: string;
  clientName: string;
  date: string;
  part: 'day' | 'evening' | 'overnight';
  planned: number;
  scheduled: number;
  gap: number;
  over: number;
  drafted: number;
}

export interface LiveWhatIf {
  planId: string;
  week: string;
  shiftHours: number;
  rows: LiveWhatIfRow[];
  totals: { planned: number; scheduled: number; gap: number; over: number; drafted: number; gapHours: number; gapCost: number | null; unpriced: number };
}

export function getSeasonPlanLive(id: string, week?: string): Promise<LiveWhatIf> {
  return apiFetch(`/season-plans/${id}/live${week ? `?week=${encodeURIComponent(week)}` : ''}`);
}

export function applySeasonPlanLive(id: string, week?: string): Promise<{ week: string; created: number }> {
  return apiFetch(`/season-plans/${id}/live/apply`, { method: 'POST', body: week ? { week } : {} });
}

export function discardSeasonPlanLive(id: string, week?: string): Promise<{ week: string; removed: number }> {
  return apiFetch(`/season-plans/${id}/live/discard`, { method: 'POST', body: week ? { week } : {} });
}
