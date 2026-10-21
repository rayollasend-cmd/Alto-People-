import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Copy, Link2, Rss } from 'lucide-react';
import { toast } from 'sonner';
import { jobFeedUrl, listJobPostings, type JobPostingRecord } from '@/lib/recruiting90Api';
import type { MarketingOverview } from '@/lib/marketingApi';
import { useAuth } from '@/lib/auth';
import { SOURCE_LABEL } from '@/pages/recruiting/recruitingLabels';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';

/**
 * Marketing → Postings & boards: every posting with its traffic, the
 * job-board feed links, and a tracked-link builder — pick a posting and
 * where the link will be placed, copy, and every applicant who comes
 * through it is credited to that source. No hand-typing ?source=indeed.
 *
 * The postings themselves are Recruiting's (open, close, openings and the
 * job-board switch live there); this is the view marketing works from.
 */

const BOARDS: Array<{ key: string; name: string; how: string }> = [
  { key: 'indeed', name: 'Indeed', how: 'Send it to your Indeed account manager, or add it under Employer → XML feed.' },
  { key: 'ziprecruiter', name: 'ZipRecruiter', how: 'Send it to your ZipRecruiter rep as an XML job feed.' },
  { key: 'glassdoor', name: 'Glassdoor', how: 'Glassdoor reads the same feed — send it to your rep.' },
  { key: 'linkedin', name: 'LinkedIn', how: 'For LinkedIn Limited Listings, give it to your LinkedIn contact.' },
];

/** Where a link can be placed — the recorded sources plus the usual channels. */
const LINK_SOURCES: Array<{ key: string; label: string }> = [
  ...Object.entries(SOURCE_LABEL)
    .filter(([k]) => !['manual', 'walk-in', 'referral', 'careers-page'].includes(k))
    .map(([key, label]) => ({ key, label })),
  { key: 'facebook', label: 'Facebook' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'craigslist', label: 'Craigslist' },
  { key: 'flyer', label: 'Flyer / QR code' },
  { key: 'text', label: 'Text message' },
  { key: 'email', label: 'Email campaign' },
].filter((s, i, all) => all.findIndex((x) => x.key === s.key) === i);

export function trackedLink(origin: string, slug: string | null, source: string): string {
  const path = slug ? `/careers/${encodeURIComponent(slug)}` : '/careers';
  return `${origin}${path}?source=${encodeURIComponent(source)}`;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error('Could not copy — select the link and copy it.');
  }
}

type Row = JobPostingRecord & { views: number; applicants: number; hiresInRange: number };

export function PostingsBoardsPanel({ o }: { o: MarketingOverview | null }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['marketing', 'postings'], queryFn: listJobPostings });
  const traffic = useMemo(() => new Map((o?.byPosting ?? []).map((p) => [p.slug, p])), [o]);
  const rows: Row[] | null = q.data
    ? q.data.postings
        .filter((p) => p.status !== 'DRAFT')
        .map((p) => ({ ...p, views: traffic.get(p.slug)?.views ?? 0, applicants: traffic.get(p.slug)?.applicants ?? 0, hiresInRange: traffic.get(p.slug)?.hires ?? 0 }))
    : null;
  const open = (rows ?? []).filter((p) => p.status === 'OPEN');
  const inFeeds = open.filter((p) => p.syndicate).length;

  const [slug, setSlug] = useState<string>('');
  const [source, setSource] = useState<string>(LINK_SOURCES[0]?.key ?? 'indeed');
  const link = trackedLink(window.location.origin, slug || null, source);
  const sourceName = LINK_SOURCES.find((s) => s.key === source)?.label ?? source;

  const columns: GridColumn<Row>[] = [
    {
      key: 'title',
      header: 'Posting',
      accessor: (p) => p.title,
      sortable: true,
      primary: true,
      cell: (p) => (
        <span className="min-w-0">
          <a href={`/careers/${p.slug}`} target="_blank" rel="noopener noreferrer" className="text-ink hover:text-accent hover:underline">
            {p.title}
          </a>
          <span className="block text-xs text-ink-muted">{[p.clientName, p.location].filter(Boolean).join(' · ') || '—'}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (p) => p.status,
      sortable: true,
      cardMeta: true,
      cell: (p) => <Badge variant={p.status === 'OPEN' ? 'success' : 'outline'}>{p.status === 'OPEN' ? 'Open' : 'Closed'}</Badge>,
    },
    {
      key: 'boards',
      header: 'Job boards',
      accessor: (p) => (p.status === 'OPEN' && p.syndicate ? 'In the feeds' : 'Careers page only'),
      cardMeta: true,
      cell: (p) =>
        p.status !== 'OPEN' ? (
          <span className="text-ink-muted">—</span>
        ) : p.syndicate ? (
          <Badge variant="info">In the feeds</Badge>
        ) : (
          <span className="text-xs text-ink-muted">Careers page only</span>
        ),
    },
    { key: 'openings', header: 'Hired / asked', accessor: (p) => p.hired, align: 'right', className: 'tabular-nums', cell: (p) => `${p.hired} / ${p.openings}` },
    { key: 'views', header: 'Views', accessor: (p) => p.views, sortable: true, align: 'right', className: 'tabular-nums' },
    { key: 'applicants', header: 'Applied', accessor: (p) => p.applicants, sortable: true, align: 'right', className: 'tabular-nums' },
    {
      key: 'link',
      header: '',
      accessor: () => null,
      searchable: false,
      csv: () => '',
      stopRowClick: true,
      align: 'right',
      cell: (p) => (
        <Button size="xs" variant="ghost" onClick={() => setSlug(p.slug)} aria-label={`Build a tracked link for ${p.title}`}>
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> Link
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-3">
          <SectionTitle
            as="h3"
            title="Tracked link"
            description="Pick the posting and where the link will be placed. Everyone who applies through it is credited to that source in the funnel and in cost per hire."
          />
          <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
            <Field label="Posting">
              {(p) => (
                <Select {...p} value={slug} onChange={(e) => setSlug(e.target.value)}>
                  <option value="">All jobs (the careers page)</option>
                  {open.map((po) => (
                    <option key={po.id} value={po.slug}>
                      {po.title}
                      {po.clientName ? ` — ${po.clientName}` : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Placed on">
              {(p) => (
                <Select {...p} value={source} onChange={(e) => setSource(e.target.value)}>
                  {LINK_SOURCES.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              readOnly
              value={link}
              aria-label="Tracked link"
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-ink"
            />
            <Button size="sm" onClick={() => void copy(link, `${sourceName} link`)}>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy link
            </Button>
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="marketing-postings" className="space-y-3">
        <SectionTitle
          id="marketing-postings"
          title="Postings"
          description="Open and closed postings with their traffic in the range above."
          trailing={
            can('manage:recruiting') ? (
              <Link to="/recruiting/extras?tab=postings" className="text-xs text-accent hover:underline">
                Manage postings
              </Link>
            ) : undefined
          }
        />
        {q.isError ? (
          <QueryError what="the postings" query={q} />
        ) : (
          <DataGrid<Row>
            id="marketing-postings"
            caption="Postings"
            rows={rows}
            loading={q.isPending}
            columns={columns}
            rowKey={(p) => p.id}
            noun={{ one: 'posting', many: 'postings' }}
            defaultSort={{ key: 'views', direction: 'desc' }}
            exportCsv={{ filename: 'postings.csv' }}
            urlState={false}
            empty={{ title: 'No postings yet', description: 'Recruiting opens postings; they show here with their traffic.' }}
          />
        )}
      </section>

      <Card>
        <CardContent className="space-y-3">
          <SectionTitle
            as="h3"
            title={
              <span className="flex items-center gap-2">
                <Rss className="h-4 w-4 text-accent" aria-hidden="true" /> Job-board feeds
              </span>
            }
            description={`${inFeeds} of ${open.length} open posting${open.length === 1 ? '' : 's'} in the feeds. Each board gets its own link, so applicants are credited to the board they came from. Google for Jobs reads the careers page directly.`}
          />
          <ul className="divide-y divide-line">
            {BOARDS.map((b) => {
              const url = jobFeedUrl(b.key);
              return (
                <li key={b.key} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                  <div className="w-28 shrink-0 text-sm text-ink">{b.name}</div>
                  <div className="min-w-0 flex-1">
                    <input
                      readOnly
                      value={url}
                      aria-label={`${b.name} feed link`}
                      onFocus={(e) => e.currentTarget.select()}
                      className="w-full truncate rounded-md border border-line bg-surface px-2 py-1 font-mono text-2xs text-ink-muted"
                    />
                    <p className="mt-1 text-2xs text-ink-muted">{b.how}</p>
                  </div>
                  <Button size="sm" variant="outline" className="self-start sm:self-center" onClick={() => void copy(url, `${b.name} feed link`)}>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy
                  </Button>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
