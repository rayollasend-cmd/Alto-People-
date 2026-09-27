import { orgDateKey } from './timeAnomalies.js';

/**
 * Deep links that notifications carry into the web app, built in one place
 * so the parameters always match what the pages read.
 *
 * A link that names a person must land on that person. The overtime alert
 * used to link to plain `/scheduling`, which opened whatever view and store
 * the reader had last left the page on — rarely the associate it was about.
 */

/**
 * One associate's week on the schedule: the week grid, scrolled to their
 * row. Pass the client whose roster they're on — an org-wide roster is
 * paged and can cut them off — and where the week should start: an
 * instant (a shift's start, a week's start) is read as the org's local
 * date — an evening shift's UTC date is already tomorrow — and a
 * YYYY-MM-DD calendar date (a leave's first day) is used as it is.
 */
export function associateWeekLink(opts: {
  associateId: string;
  clientId?: string | null;
  week?: Date | string | null;
}): string {
  const p = new URLSearchParams({ view: 'week', associate: opts.associateId });
  if (opts.clientId) p.set('client', opts.clientId);
  if (opts.week) p.set('week', typeof opts.week === 'string' ? opts.week.slice(0, 10) : orgDateKey(opts.week));
  return `/scheduling?${p.toString()}`;
}
