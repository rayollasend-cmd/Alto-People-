import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Megaphone, Users } from '@/components/ui/icons';
import { useGreeting, greetingName } from '@/lib/greeting';
import { useAuth } from '@/lib/auth';
import { getMarketingOverview } from '@/lib/marketingApi';
import { fmtDate, ymdLocal } from '@/lib/format';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import { HomeMeta } from '@/components/home/HomeMeta';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LiveNow } from '@/components/ui/LiveNow';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { CampaignsPanel } from './CampaignsPanel';
import { EmployerBrandEditor } from './EmployerBrandEditor';
import { ConversionChart, FunnelHero, PostingsPanel, SourceOfHireGrid, StageFunnel } from './FunnelPanels';
import { PostingsBoardsPanel } from './PostingsBoardsPanel';

/**
 * Marketing's home and hub, one page: the careers funnel as the hero
 * (views → applicants → interviewed → hires), then the work — source of
 * hire, the employer brand page, referral campaigns. The marketing manager
 * lands here; anyone with view:marketing opens it at /marketing.
 */

type Tab = 'funnel' | 'postings' | 'sources' | 'brand' | 'campaigns';
type Preset = '30d' | '90d' | '12m';
const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '12m', label: '12 months' },
];
const DAYS: Record<Preset, number> = { '30d': 29, '90d': 89, '12m': 364 };

function shift(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return ymdLocal(new Date(y, m - 1, d + days));
}

export function MarketingHome() {
  const { user, can } = useAuth();
  const greet = useGreeting();
  const [params, setParams] = useSearchParams();
  const tab = (['funnel', 'postings', 'sources', 'brand', 'campaigns'].includes(params.get('tab') ?? '') ? params.get('tab') : 'funnel') as Tab;
  const preset = ((['30d', '90d', '12m'] as Preset[]).includes(params.get('range') as Preset) ? params.get('range') : '90d') as Preset;
  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      next.set(key, value);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  const range = useMemo(() => {
    const today = ymdLocal();
    return { from: shift(today, -DAYS[preset]), to: today };
  }, [preset]);
  const q = useQuery({ queryKey: ['marketing', 'overview', range], queryFn: () => getMarketingOverview(range) });
  const o = q.data ?? null;
  const canEdit = can('manage:marketing');
  const name = greetingName(user, '');

  return (
    <HomeTemplate
      // The page's name is the heading; the greeting is the quiet line under it (F500 G4).
      title="Marketing"
      topbarTitle="Marketing"
      subtitle="The top of the funnel: who sees the jobs, who applies, who gets hired and from where."
      meta={
        <HomeMeta
          items={[
            <>
              <LiveNow render={(now) => greet(now.getHours())} />
              {name ? `, ${name}` : ''}
            </>,
            `${fmtDate(range.from)} – ${fmtDate(range.to)}`,
          ]}
        />
      }
      actions={<SegmentedControl ariaLabel="Range" options={PRESETS} value={preset} onChange={(v) => setParam('range', v)} />}
      hero={
        q.isError ? (
          <QueryError what="the funnel" query={q} />
        ) : o ? (
          <FunnelHero o={o} />
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        )
      }
      decisions={
        o
          ? {
              title: 'Needs you',
              count: (canEdit ? o.campaigns.bonusesProposed : 0) + (o.bySource.length === 0 ? 1 : 0),
              content: (
                <div className="space-y-2 text-sm">
                  {o.campaigns.bonusesProposed > 0 && (
                    <p>
                      <Link to="/marketing/bonuses" className="text-accent hover:underline">
                        {o.campaigns.bonusesProposed} referral bonus{o.campaigns.bonusesProposed === 1 ? '' : 'es'} with Finance
                      </Link>
                      <span className="text-ink-muted"> — approved ones land on the next payroll run.</span>
                    </p>
                  )}
                  {o.bySource.length === 0 && (
                    <p className="text-ink-muted">
                      No applicants in the range. Give every place you post its own link and the funnel fills in by source.{' '}
                      <button type="button" className="text-accent hover:underline" onClick={() => setParam('tab', 'postings')}>
                        Build a tracked link
                      </button>
                      .
                    </p>
                  )}
                  {o.campaigns.active === 0 && canEdit && (
                    <p className="text-ink-muted">
                      No live referral campaign.{' '}
                      <button type="button" className="text-accent hover:underline" onClick={() => setParam('tab', 'campaigns')}>
                        Start one
                      </button>
                      .
                    </p>
                  )}
                  {o.campaigns.bonusesProposed === 0 && o.bySource.length > 0 && (o.campaigns.active > 0 || !canEdit) && (
                    <p className="text-ink-muted">All clear — the funnel is moving and no bonus is waiting.</p>
                  )}
                </div>
              ),
            }
          : undefined
      }
      assistant={<HugoSeat />}
      waysIn={
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/careers" target="_blank" rel="noopener noreferrer">
              <Megaphone className="h-4 w-4" aria-hidden="true" />
              The careers site
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/recruiting">
              <Users className="h-4 w-4" aria-hidden="true" />
              The pipeline
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/recruiting/analytics">Recruiting analytics</Link>
          </Button>
        </div>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setParam('tab', v)}>
        <TabsList>
          <TabsTrigger value="funnel">Funnel</TabsTrigger>
          <TabsTrigger value="postings">Postings &amp; boards</TabsTrigger>
          <TabsTrigger value="sources">Source of hire</TabsTrigger>
          <TabsTrigger value="brand">Employer brand</TabsTrigger>
          <TabsTrigger value="campaigns">Referral campaigns</TabsTrigger>
        </TabsList>
        <TabsContent value="funnel">
          {o ? (
            <div className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <StageFunnel o={o} />
                <ConversionChart o={o} />
              </div>
              <PostingsPanel o={o} />
            </div>
          ) : q.isError ? (
            <EmptyState title="The funnel did not load" description="Retry above." className="py-8" />
          ) : (
            <Skeleton className="h-64" />
          )}
        </TabsContent>
        <TabsContent value="postings">
          <PostingsBoardsPanel o={o} />
        </TabsContent>
        <TabsContent value="sources">
          <SourceOfHireGrid o={o} loading={q.isPending} />
        </TabsContent>
        <TabsContent value="brand">
          <EmployerBrandEditor canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="campaigns">
          <CampaignsPanel canEdit={canEdit} />
        </TabsContent>
      </Tabs>
    </HomeTemplate>
  );
}
