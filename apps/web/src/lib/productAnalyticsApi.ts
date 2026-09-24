import type {
  ActiveUsersResponse,
  AdoptionResponse,
  RouteUsageResponse,
  TrafficResponse,
  WebVitalsResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Product analytics reads. Every one takes a bounded window and is served
 * from a daily rollup — the dashboard never asks the server to aggregate
 * raw history, which is what keeps a page load off the audit log.
 */

export function getActiveUsers(days: number): Promise<ActiveUsersResponse> {
  return apiFetch<ActiveUsersResponse>(`/product-analytics/active-users?days=${days}`);
}

export function getTraffic(days: number): Promise<TrafficResponse> {
  return apiFetch<TrafficResponse>(`/product-analytics/traffic?days=${days}`);
}

export function getRouteUsage(days: number, limit = 15): Promise<RouteUsageResponse> {
  return apiFetch<RouteUsageResponse>(
    `/product-analytics/routes?days=${days}&limit=${limit}`,
  );
}

export function getAdoption(days: number): Promise<AdoptionResponse> {
  return apiFetch<AdoptionResponse>(`/product-analytics/adoption?days=${days}`);
}

export function getWebVitals(days: number, limit = 15): Promise<WebVitalsResponse> {
  return apiFetch<WebVitalsResponse>(`/product-analytics/web-vitals?days=${days}&limit=${limit}`);
}
