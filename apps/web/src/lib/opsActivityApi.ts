import { apiFetch } from './api';

/** The floor's record — GET /ops-activity (routes/opsActivity.ts on the API). */
export type OpsActivityKind = 'call_out' | 'published' | 'swap' | 'incident';
export interface OpsActivityItem {
  id: string;
  kind: OpsActivityKind;
  at: string;
  title: string;
  detail: string | null;
  href: string;
}

export const getOpsActivity = (days = 7) => apiFetch<{ days: number; items: OpsActivityItem[] }>(`/ops-activity?days=${days}`);
