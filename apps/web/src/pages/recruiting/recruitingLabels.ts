import type { CandidateStage } from '@alto-people/shared';

/** Human labels for the recruiting pipeline, shared by the drawer's panels. */

export const STAGE_LABEL: Record<CandidateStage, string> = {
  APPLIED: 'Applied',
  SCREENING: 'Screening',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  HIRED: 'Hired',
  WITHDRAWN: 'Withdrawn',
  REJECTED: 'Rejected',
};

/** Where candidates come from — the stored slugs, in picker order. */
export const CANDIDATE_SOURCES = [
  'referral',
  'careers-page',
  'indeed',
  'linkedin',
  'walk-in',
  'agency',
  'other',
] as const;

export const SOURCE_LABEL: Record<string, string> = {
  referral: 'Referral',
  'careers-page': 'Careers page',
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  ziprecruiter: 'ZipRecruiter',
  'walk-in': 'Walk-in',
  agency: 'Agency',
  other: 'Other',
  manual: 'Manual',
};

/**
 * The interviewer's recommendation. Stored as -2..2 — the drawer used to
 * print that as "x/5", so a strong no read as "-2/5".
 */
export const RATING_OPTIONS = [
  { value: 2, label: 'Strong yes' },
  { value: 1, label: 'Yes' },
  { value: 0, label: 'Neutral' },
  { value: -1, label: 'No' },
  { value: -2, label: 'Strong no' },
] as const;

export function ratingLabel(rating: number): string {
  return RATING_OPTIONS.find((o) => o.value === rating)?.label ?? String(rating);
}

/** Whole days since an ISO timestamp. */
export function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * An offer as the recruiter should read it (PEOPLE-13): a SENT offer past
 * its expiry is expired — never "Awaiting their signature" with an Accept
 * button — even before the server's on-read sweep has caught up.
 */
export function offerShownStatus<S extends string>(o: { status: S; expiresAt: string | null }, now: number = Date.now()): S | 'EXPIRED' {
  return o.status === 'SENT' && o.expiresAt !== null && Date.parse(o.expiresAt) < now ? 'EXPIRED' : o.status;
}
