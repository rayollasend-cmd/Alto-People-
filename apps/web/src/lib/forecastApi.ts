import type {
  ForecastPlanInput,
  ForecastResponse,
  ForecastSignalInput,
  ForecastSitesResponse,
  SeasonPlanComputed,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Brief 3-4: the labor-demand forecast reads and writes. Every number on
 * the page is computed by the server; a compute is followed by a refetch.
 */

export interface ForecastRunResult {
  runId: string;
  sites: number;
  weeks: number;
  scored: number;
  weights: { lastYearWeight: number; bandLow: number; bandHigh: number; mapePct: number | null; summerMapePct: number | null; scoredWeeks: number };
}

export function listForecastSites(): Promise<ForecastSitesResponse> {
  return apiFetch<ForecastSitesResponse>('/forecast/sites');
}

export function getSiteForecast(locationId: string): Promise<ForecastResponse> {
  return apiFetch<ForecastResponse>(`/forecast/sites/${encodeURIComponent(locationId)}`);
}

export function runForecast(): Promise<ForecastRunResult> {
  return apiFetch<ForecastRunResult>('/forecast/runs', { method: 'POST', body: {} });
}

export function setForecastSignal(body: ForecastSignalInput): Promise<{ signal: { id: string } }> {
  return apiFetch<{ signal: { id: string } }>('/forecast/signals', { method: 'PUT', body });
}

export function removeForecastSignal(id: string): Promise<void> {
  return apiFetch<void>(`/forecast/signals/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function createPlanFromForecast(body: ForecastPlanInput): Promise<SeasonPlanComputed> {
  return apiFetch<SeasonPlanComputed>('/forecast/plan', { method: 'POST', body });
}
