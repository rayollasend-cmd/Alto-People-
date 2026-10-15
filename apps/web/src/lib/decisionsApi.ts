import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';

/**
 * The decisions waiting on the signed-in person (GET /me/decisions): the
 * one list every role home opens with (design system §4.1). The server
 * ranks by severity and role affinity; the client only counts and shows.
 */
export type DecisionSeverity = 'critical' | 'high' | 'normal';

export interface MyDecision {
  key: string;
  severity: DecisionSeverity;
  label: string;
  detail: string;
  stakes: number | null;
  ageDays: number | null;
  linkUrl: string;
  domain: string;
  quickAction?: string;
  declineAction?: string;
}

export const myDecisionsKey = ['me', 'decisions'] as const;

export function useMyDecisions(enabled = true) {
  return useQuery({
    queryKey: myDecisionsKey,
    queryFn: () => apiFetch<{ decisions: MyDecision[] }>('/me/decisions').then((r) => r.decisions),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Counts by severity, for the hero and the "Needs you" badge. */
export function countDecisions(rows: MyDecision[] | undefined) {
  const out = { total: 0, critical: 0, high: 0, normal: 0 };
  for (const r of rows ?? []) {
    out.total += 1;
    out[r.severity] += 1;
  }
  return out;
}
