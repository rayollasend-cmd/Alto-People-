import type { HeadcountOverview } from '@alto-people/shared';
import { apiFetch } from './api';

export type { HeadcountOverview, HeadcountRow, ReconciliationSummary } from '@alto-people/shared';

export interface TurnoverSummary {
  days: number;
  hires: number;
  terminations: number;
  netChange: number;
  annualizedTurnoverRate: number;
  currentActive: number;
}

/** Brief 1A-2: every number on the Headcount screen comes from this one read. */
export const getHeadcountOverview = () =>
  apiFetch<HeadcountOverview>('/headcount/overview');

export const getTurnover = (days: number) =>
  apiFetch<TurnoverSummary>(`/headcount/turnover?days=${days}`);
