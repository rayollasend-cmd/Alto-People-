import type { JobPostingSchedule } from '@/lib/recruiting90Api';

/**
 * A job posting started from somewhere else — a staffing gap on the
 * headcount plan or the recruiter home — travels as URL params to the
 * postings tab, which opens the new-posting drawer filled in. Kept out of
 * the page module so the headcount plan doesn't load the recruiting page.
 */

/** A posting started from somewhere else (a staffing gap): what to fill in. */
export interface PostingSeed {
  clientId: string | null;
  title: string;
  location: string;
  openings: number;
  schedule: JobPostingSchedule | null;
}

const SCHEDULE_VALUES: readonly JobPostingSchedule[] = ['FULL_TIME', 'PART_TIME', 'TEMPORARY', 'SEASONAL'];

/** The posting seed a URL carries, or null when it isn't a new-posting link. */
export function postingSeedFrom(search: string): PostingSeed | null {
  const sp = new URLSearchParams(search);
  if (sp.get('new') !== '1' || sp.get('tab') !== 'postings') return null;
  const openings = Number(sp.get('openings'));
  const schedule = sp.get('schedule');
  return {
    clientId: sp.get('clientId') || null,
    title: (sp.get('title') ?? '').slice(0, 200),
    location: (sp.get('location') ?? '').slice(0, 200),
    openings: Number.isInteger(openings) && openings >= 1 && openings <= 500 ? openings : 1,
    schedule: SCHEDULE_VALUES.includes(schedule as JobPostingSchedule) ? (schedule as JobPostingSchedule) : null,
  };
}

/** The link that opens a posting for a staffing gap, already filled in. */
export function postingForGapHref(gap: { clientId: string | null; storeName: string; openings: number }): string {
  const sp = new URLSearchParams({ tab: 'postings', new: '1' });
  if (gap.clientId) sp.set('clientId', gap.clientId);
  sp.set('title', `Associate — ${gap.storeName}`);
  sp.set('location', gap.storeName);
  sp.set('openings', String(Math.max(1, Math.min(500, gap.openings))));
  sp.set('schedule', 'SEASONAL');
  return `/recruiting/extras?${sp.toString()}`;
}
