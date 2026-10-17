import type { CareersApplyInput } from '@alto-people/shared';
import { apiFetch } from './api';

/** The public careers site — no login. */

export interface CareerPostingSummary {
  slug: string;
  title: string;
  location: string | null;
  clientName: string | null;
  minSalary: string | null;
  maxSalary: string | null;
  currency: string;
  openedAt: string | null;
  schedule?: 'FULL_TIME' | 'PART_TIME' | 'TEMPORARY' | 'SEASONAL' | null;
  /** Whether the pay range is hourly or yearly; null when the posting didn't say. */
  payUnit?: 'HOUR' | 'YEAR' | null;
}

export interface CareerPosting extends CareerPostingSummary {
  description: string;
  schedule: 'FULL_TIME' | 'PART_TIME' | 'TEMPORARY' | 'SEASONAL' | null;
  payUnit: 'HOUR' | 'YEAR' | null;
  /** Who is hiring, for search engines' job listings. */
  orgName: string;
}

export const listCareerPostings = () =>
  apiFetch<{ postings: CareerPostingSummary[] }>('/careers');

export const getCareerPosting = (slug: string) =>
  apiFetch<CareerPosting>(`/careers/${encodeURIComponent(slug)}`);

/** What the careers site says about working here — edited by marketing. */
export interface CareersBrand {
  headline: string | null;
  intro: string | null;
  values: Array<{ title: string; body: string }>;
  perks: string[];
  ctaText: string | null;
  photos: Array<{ id: string; alt: string; url: string }>;
}

export const getCareersBrand = () => apiFetch<CareersBrand>('/careers/brand');

/** One more view of the list page or a posting — the top of marketing's funnel. Never throws. */
export function recordCareersView(slug: string | null, source: string | null): void {
  void apiFetch<void>('/careers/view', { method: 'POST', body: { slug, source } }).catch(() => undefined);
}

export const applyToPosting = (slug: string, body: CareersApplyInput) =>
  apiFetch<{ id: string; alreadyApplied: boolean }>(`/careers/${encodeURIComponent(slug)}/apply`, {
    method: 'POST',
    body,
  });
