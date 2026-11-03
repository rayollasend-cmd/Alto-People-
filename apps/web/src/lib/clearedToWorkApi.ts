import type { ClearedListResponse, ComplianceWorkforce } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Cleared to work (owner, 2026-11-03): one row per person in a compliance
 * group — Cleared / Needs attention / Not cleared — the exceptions queue and
 * the scheduling overrides of the last 90 days (apps/api routes/clearedToWork).
 *
 * Query keys name their inputs:
 *   ['compliance', 'clearedToWork', workforce]   (never persisted: lib/queryPersist)
 */
export function listCleared(opts: { workforce?: ComplianceWorkforce } = {}): Promise<ClearedListResponse> {
  return apiFetch<ClearedListResponse>(`/compliance/cleared${opts.workforce ? `?workforce=${opts.workforce}` : ''}`);
}
