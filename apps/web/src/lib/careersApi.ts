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
}

export interface CareerPosting extends CareerPostingSummary {
  description: string;
}

export const listCareerPostings = () =>
  apiFetch<{ postings: CareerPostingSummary[] }>('/careers');

export const getCareerPosting = (slug: string) =>
  apiFetch<CareerPosting>(`/careers/${encodeURIComponent(slug)}`);

export const applyToPosting = (slug: string, body: CareersApplyInput) =>
  apiFetch<{ id: string; alreadyApplied: boolean }>(`/careers/${encodeURIComponent(slug)}/apply`, {
    method: 'POST',
    body,
  });
