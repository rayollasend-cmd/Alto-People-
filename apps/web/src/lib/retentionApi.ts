import { apiFetch } from './api';

/** Retention desk (apps/api/src/lib/retention.ts). Never shown to the worker. */

export type RiskBand = 'HIGH' | 'MEDIUM' | 'LOW';
export type PlayKind = 'MORE_HOURS' | 'CHECK_IN' | 'SCHEDULE_FIX' | 'RIDE_HELP' | 'RECOGNITION' | 'PAY_REVIEW';

export interface RiskReason {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export interface RetentionItem {
  associateId: string;
  name: string;
  photoUrl: string | null;
  score: number;
  band: RiskBand;
  reasons: RiskReason[];
  plays: PlayKind[];
  store: { id: string; name: string } | null;
  client: { id: string; name: string } | null;
  recentPlays: Array<{ id: string; kind: PlayKind; status: 'OPEN' | 'DONE'; note: string | null; createdAt: string; approvalId: string | null }>;
}

export interface RetentionSummary {
  bands: Record<RiskBand, number>;
  stores: Array<{ id: string; name: string; high: number; medium: number }>;
  plays: Array<{ kind: PlayKind; taken: number; stayed: number; left: number; pending: number; stayRate: number | null }>;
}

export const listRetention = (q: { band?: 'HIGH' | 'MEDIUM' | 'LOW' | 'AT_RISK'; locationId?: string }) => {
  const p = new URLSearchParams();
  if (q.band) p.set('band', q.band);
  if (q.locationId) p.set('locationId', q.locationId);
  return apiFetch<{ truncated: boolean; computedAt: string | null; items: RetentionItem[] }>(`/retention?${p.toString()}`);
};
export const getRetentionSummary = () => apiFetch<RetentionSummary>('/retention/summary');
export const getCrewRisk = () => apiFetch<{ high: number; medium: number }>('/retention/crew');
export const logPlay = (associateId: string, body: { kind: PlayKind; note?: string; proposedRate?: number }) =>
  apiFetch<{ playId: string; approvalId: string | null; pending: boolean }>(`/retention/${associateId}/plays`, { method: 'POST', body });
export const markPlayDone = (id: string, note?: string) => apiFetch<{ ok: true }>(`/retention/plays/${id}`, { method: 'PATCH', body: { note } });
export const recomputeRetention = () => apiFetch<{ scored: number; high: number }>('/retention/recompute', { method: 'POST' });
