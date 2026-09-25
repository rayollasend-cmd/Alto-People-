import type { JobPayUnit, JobPostingSchedule, Prisma } from '@prisma/client';

/**
 * Job-board syndication: the open postings as an XML feed in Indeed's
 * format — the de-facto standard that ZipRecruiter, Glassdoor, Talent.com
 * and most aggregators also read. A board is given its own feed URL
 * (`?board=indeed`), and every job's link carries `?source=<board>` so an
 * applicant who came from it is credited to it on their record and in
 * recruiting analytics' source of hire and cost per hire.
 */

export interface FeedPosting {
  id: string;
  slug: string;
  title: string;
  description: string;
  location: string | null;
  minSalary: Prisma.Decimal | null;
  maxSalary: Prisma.Decimal | null;
  currency: string;
  schedule: JobPostingSchedule | null;
  payUnit: JobPayUnit | null;
  openedAt: Date | null;
  createdAt: Date;
}

/** A board's key, as it appears in `?board=` and in the candidate's source. */
export function boardKey(raw: unknown): string {
  const k = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^[a-z0-9-]{1,30}$/.test(k) ? k : 'job-board';
}

/** "Destin, FL 32541" → its parts; anything else is the city as written. */
export function splitLocation(loc: string | null): { city: string; state: string; postalcode: string } {
  const s = (loc ?? '').trim();
  const m = s.match(/^(.+?),\s*([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);
  if (m) return { city: m[1]!.trim(), state: m[2]!.toUpperCase(), postalcode: m[3] ?? '' };
  return { city: s, state: '', postalcode: '' };
}

const JOBTYPE: Record<JobPostingSchedule, string> = {
  FULL_TIME: 'fulltime',
  PART_TIME: 'parttime',
  TEMPORARY: 'temporary',
  SEASONAL: 'seasonal',
};

function money(n: Prisma.Decimal, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(Number(n));
}

/** "$14.00 - $17.00 per hour", "$42,000.00 per year", or '' when not given. */
export function salaryText(p: Pick<FeedPosting, 'minSalary' | 'maxSalary' | 'currency' | 'payUnit'>): string {
  const lo = p.minSalary ? money(p.minSalary, p.currency) : null;
  const hi = p.maxSalary ? money(p.maxSalary, p.currency) : null;
  const range = lo && hi && lo !== hi ? `${lo} - ${hi}` : (lo ?? hi);
  if (!range) return '';
  return p.payUnit ? `${range} per ${p.payUnit === 'HOUR' ? 'hour' : 'year'}` : range;
}

/** CDATA can hold anything but its own terminator. */
function cdata(v: string): string {
  return `<![CDATA[${v.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The posting's text as the simple HTML boards display: paragraphs and line breaks. */
export function descriptionHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function buildJobFeed(input: {
  postings: FeedPosting[];
  board: string;
  orgName: string;
  baseUrl: string;
  now?: Date;
}): string {
  const base = input.baseUrl.replace(/\/$/, '');
  const jobs = input.postings.map((p) => {
    const where = splitLocation(p.location);
    const fields: Array<[string, string]> = [
      ['title', p.title],
      ['date', (p.openedAt ?? p.createdAt).toUTCString()],
      ['referencenumber', p.id],
      ['url', `${base}/careers/${encodeURIComponent(p.slug)}?source=${encodeURIComponent(input.board)}`],
      ['company', input.orgName],
      ['city', where.city],
      ['state', where.state],
      ['country', 'US'],
      ['postalcode', where.postalcode],
      ['description', descriptionHtml(p.description)],
      ['salary', salaryText(p)],
      ['jobtype', p.schedule ? JOBTYPE[p.schedule] : ''],
    ];
    const body = fields
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `    <${k}>${cdata(v)}</${k}>`)
      .join('\n');
    return `  <job>\n${body}\n  </job>`;
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<source>',
    `  <publisher>${cdata(input.orgName)}</publisher>`,
    `  <publisherurl>${cdata(`${base}/careers`)}</publisherurl>`,
    `  <lastBuildDate>${(input.now ?? new Date()).toUTCString()}</lastBuildDate>`,
    ...jobs,
    '</source>',
    '',
  ].join('\n');
}
