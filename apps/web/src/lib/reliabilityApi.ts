import type { ReliabilityResponse } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The reliability read. One bounded window, served from daily rollups and
 * (when connected) Sentry — the page never asks the server to scan raw
 * history, and it is capped at 90 days on the server.
 */
export function getReliability(days: number): Promise<ReliabilityResponse> {
  return apiFetch<ReliabilityResponse>(`/product-analytics/reliability?days=${days}`);
}
