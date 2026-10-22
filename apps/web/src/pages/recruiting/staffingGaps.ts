import { apiFetch } from '@/lib/api';
import type { JobPostingRecord } from '@/lib/recruiting90Api';

/**
 * The staffing plan's shortfalls, as recruiting sees them: which stores
 * are short heads in the coming weeks and still have no open posting
 * hiring for them. Shared by the headcount plan (the data) and the
 * recruiter home (the gaps card), kept out of both page modules.
 */

type Source = 'season' | 'forecast' | 'targets' | 'none';

export interface StaffingWeek {
  week: string;
  required: number;
  placed: number;
  scheduled: number;
  gap: number;
  hours: number;
  budget: number | null;
  source: Source;
}

export interface StaffingStore {
  storeId: string;
  storeName: string;
  clientId: string | null;
  clientName: string | null;
  placed: number;
  weeks: StaffingWeek[];
}

export interface StaffingPlanResponse {
  weeks: string[];
  stores: StaffingStore[];
  totals: Array<{ week: string; required: number; placed: number; scheduled: number; gap: number; budget: number | null }>;
  priced: number;
}

export const getStaffingPlan = (opts: { weeks: number; clientId?: string }) => {
  const qs = new URLSearchParams({ weeks: String(opts.weeks) });
  if (opts.clientId) qs.set('clientId', opts.clientId);
  return apiFetch<StaffingPlanResponse>(`/headcount/staffing-plan?${qs.toString()}`);
};

/** The largest weekly shortfall a store carries in the window — the heads a posting should ask for. */
export function largestGap(store: { weeks: Array<{ gap: number }> }): number {
  return store.weeks.reduce((m, w) => Math.max(m, w.gap), 0);
}

export interface StaffingGap {
  storeId: string;
  storeName: string;
  clientId: string | null;
  clientName: string | null;
  short: number;
  /** The first week the store is short. */
  from: string | null;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Does an OPEN posting already hire for this store (same client, the store named in its location or title)? */
export function postingCovers(p: JobPostingRecord, store: Pick<StaffingStore, 'storeName' | 'clientId'>): boolean {
  if (p.status !== 'OPEN') return false;
  if (store.clientId && p.clientId && p.clientId !== store.clientId) return false;
  const name = norm(store.storeName);
  return !!name && (norm(p.location).includes(name) || norm(p.title).includes(name));
}

/** Stores short in any week with no open posting for them, biggest shortfall first. */
export function gapsWithoutPosting(plan: StaffingPlanResponse, postings: JobPostingRecord[]): StaffingGap[] {
  return plan.stores
    .map((s) => ({ s, short: largestGap(s) }))
    .filter(({ s, short }) => short > 0 && !postings.some((p) => postingCovers(p, s)))
    .map(({ s, short }) => ({
      storeId: s.storeId,
      storeName: s.storeName,
      clientId: s.clientId,
      clientName: s.clientName,
      short,
      from: s.weeks.find((w) => w.gap > 0)?.week ?? null,
    }))
    .sort((a, b) => b.short - a.short);
}
