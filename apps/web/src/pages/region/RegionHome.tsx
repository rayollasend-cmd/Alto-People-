import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Building2, MessageSquare, Search, Store } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { regionOverview, type StoreSnapshot } from '@/lib/regionsApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatTile } from '@/pages/portal/portalCharts';

/**
 * The region command center — every store a Manager, Business Operations
 * Support runs, on one screen, on the same numbers each store manager
 * sees. Short stores float to the top; each card opens that store's own
 * site. Refreshes every minute.
 */

const GRADE_STYLE: Record<NonNullable<StoreSnapshot['reliability']['grade']>, string> = {
  A: 'text-success',
  B: 'text-success',
  C: 'text-warning',
  D: 'text-alert',
  F: 'text-alert',
};

type Filter = 'all' | 'short' | 'open' | 'requests';

export function RegionHome() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams] = useSearchParams();
  const isRegion = user?.role === 'CLIENT_PORTAL' && !user.clientId && !!user.regionId;
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('regionId');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const enabled = isRegion || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['region', 'overview', isRegion ? 'me' : previewId],
    queryFn: () => regionOverview(isRegion ? null : previewId),
    enabled,
    refetchInterval: 60_000,
  });
  const data = query.data;

  const stores = useMemo(() => {
    const all = data?.stores ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((s) => {
      if (needle && !`${s.name} ${s.clientName}`.toLowerCase().includes(needle)) return false;
      if (filter === 'short') return s.now.short > 0 || !!s.alert;
      if (filter === 'open') return s.today.open > 0 || s.tomorrow.open > 0;
      if (filter === 'requests') return s.requests.open > 0;
      return true;
    });
  }, [data, filter, q]);

  if (!isRegion && !canPreview) {
    return <EmptyState icon={Building2} title={t('portal.noAccess')} description="" />;
  }
  if (!isRegion && !previewId) {
    return <EmptyState icon={Building2} title={t('region.title')} description={t('region.pick')} />;
  }
  if (query.isError) {
    return (
      <div className="mx-auto">
        <PageHeader title={t('region.title')} />
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('portal.loadFailed')}
        </ErrorBanner>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/3" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const tot = data.totals;
  const storeHref = (s: StoreSnapshot) =>
    data.preview ? `/portal?clientId=${s.clientId}&locationId=${s.id}` : `/portal?locationId=${s.id}`;
  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'all', label: t('region.filterAll'), count: data.stores.length },
    { key: 'short', label: t('region.filterShort'), count: data.stores.filter((s) => s.now.short > 0 || !!s.alert).length },
    { key: 'open', label: t('region.filterOpen'), count: data.stores.filter((s) => s.today.open > 0 || s.tomorrow.open > 0).length },
    { key: 'requests', label: t('region.filterRequests'), count: data.stores.filter((s) => s.requests.open > 0).length },
  ];

  return (
    <div className="mx-auto space-y-4">
      <PageHeader
        title={data.region.name}
        topbarTitle={t('region.title')}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t('region.subtitle', { count: tot.stores })}</span>
            <span className="flex items-center gap-1.5 text-xs text-silver/60">
              <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              {t('portal.asOf', { time: fmtTime(data.generatedAt) })}
            </span>
          </span>
        }
        primaryAction={
          !data.preview ? (
            <Button size="sm" asChild>
              <Link to="/messages">
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('msg.title')}
              </Link>
            </Button>
          ) : undefined
        }
      />

      {/* ---- Region KPIs ---------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label={t('region.kpiFloor')}
          value={tot.onFloor}
          unit={tot.target !== null ? `/ ${tot.target}` : undefined}
          meter={
            tot.target
              ? { percent: Math.min(100, Math.round((tot.onFloor / tot.target) * 100)), tone: tot.shortNow > 0 ? 'warn' : 'good' }
              : null
          }
          sub={
            tot.shortNow > 0
              ? t('region.kpiFloorShort', { count: tot.shortNow })
              : t('region.kpiFloorOk')
          }
        />
        <StatTile
          label={t('region.kpiGrade')}
          value={tot.score === null ? '—' : `${tot.score}%`}
          delta={
            tot.gradeCounts.F > 0
              ? t('region.kpiGradeF', { count: tot.gradeCounts.F })
              : t('region.kpiGradeA', { count: tot.gradeCounts.A })
          }
          deltaTone={tot.gradeCounts.F > 0 ? 'bad' : 'good'}
          sub={t('region.kpiGradeSub', { a: tot.gradeCounts.A, b: tot.gradeCounts.B, f: tot.gradeCounts.F })}
        />
        <StatTile
          label={t('region.kpiOpen')}
          value={tot.openToday}
          unit={t('region.kpiOpenUnit')}
          deltaTone={tot.openToday > 0 ? 'bad' : 'good'}
          sub={t('region.kpiOpenSub', { open: tot.openTomorrow, unconfirmed: tot.unconfirmedTomorrow })}
        />
        <StatTile
          label={t('region.kpiRequests')}
          value={tot.openRequests}
          delta={tot.overdueRequests > 0 ? t('region.kpiRequestsOverdue', { count: tot.overdueRequests }) : null}
          deltaTone="bad"
          sub={t('region.kpiRequestsSub')}
        />
      </div>

      {/* ---- Filter row: one row, above everything it scopes ------------- */}
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-2 bg-navy/95 px-4 py-2 backdrop-blur md:mx-0 md:px-0">
        {filters.map((f) => (
          <Button key={f.key} size="sm" variant={filter === f.key ? 'secondary' : 'ghost'} onClick={() => setFilter(f.key)}>
            {f.label}
            <span className="ml-1.5 tabular-nums text-silver/60">{f.count}</span>
          </Button>
        ))}
        <label className="relative ml-auto block w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-silver/50" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('region.findStore')} className="pl-8" aria-label={t('region.findStore')} />
        </label>
      </div>

      {/* ---- The stores ------------------------------------------------- */}
      {stores.length === 0 ? (
        <Card>
          <CardContent className="p-6">
            <EmptyState icon={Store} title={t('region.noStores')} description={data.stores.length === 0 ? t('region.noStoresHint') : ''} />
          </CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {stores.map((s) => {
            const short = s.now.short > 0;
            const pct =
              s.now.target && s.now.target > 0
                ? Math.min(100, Math.round((s.now.onFloor / s.now.target) * 100))
                : s.today.expected > 0
                  ? Math.min(100, Math.round((s.today.present / Math.max(1, s.today.expected)) * 100))
                  : 0;
            return (
              <li key={s.id}>
                <Link
                  to={storeHref(s)}
                  className={cn(
                    'block h-full rounded-lg border bg-navy-secondary/20 p-4 transition-colors hover:border-gold/40 elev-1',
                    s.alert ? 'border-alert/40' : short ? 'border-warning/40' : 'border-navy-secondary',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-white">{s.name}</div>
                      {s.clientName !== s.name && <div className="truncate text-2xs text-silver/60">{s.clientName}</div>}
                    </div>
                    <span
                      className={cn(
                        'shrink-0 text-2xl font-bold leading-none tracking-tight',
                        s.reliability.grade ? GRADE_STYLE[s.reliability.grade] : 'text-silver/40',
                      )}
                      title={s.reliability.score !== null ? `${s.reliability.score}%` : undefined}
                    >
                      {s.reliability.grade ?? '—'}
                    </span>
                  </div>

                  <div className="mt-3 flex items-baseline gap-1.5">
                    <span className={cn('text-3xl font-bold leading-none tracking-tight', short ? 'text-warning' : 'text-white')}>
                      {s.now.onFloor}
                    </span>
                    {s.now.target !== null && <span className="text-sm text-silver/60">/ {s.now.target}</span>}
                    <span className="ml-1 text-xs text-silver/70">{t('region.onFloorNow')}</span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
                    <div className={cn('h-full rounded-full', short ? 'bg-warning' : 'bg-success')} style={{ width: `${pct}%` }} />
                  </div>

                  {s.alert && (
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-alert">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                      {s.alert}
                    </p>
                  )}

                  <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <Stat label={t('region.cardToday')} value={`${s.today.present}/${s.today.expected}`} tone={s.today.open > 0 ? 'bad' : 'plain'} sub={s.today.open > 0 ? t('portal.openCount', { count: s.today.open }) : undefined} />
                    <Stat label={t('region.cardTomorrow')} value={String(s.tomorrow.expected)} tone={s.tomorrow.open > 0 ? 'bad' : s.tomorrow.unconfirmed > 0 ? 'warn' : 'plain'} sub={s.tomorrow.open > 0 ? t('portal.openCount', { count: s.tomorrow.open }) : s.tomorrow.unconfirmed > 0 ? t('region.cardUnconfirmed', { count: s.tomorrow.unconfirmed }) : undefined} />
                    <Stat label={t('region.cardRequests')} value={String(s.requests.open)} tone={s.requests.overdue > 0 ? 'bad' : 'plain'} sub={s.requests.overdue > 0 ? t('region.cardOverdue', { count: s.requests.overdue }) : undefined} />
                  </dl>
                  <div className="mt-2 text-2xs text-silver/50">
                    {s.leads.total > 0
                      ? t('region.cardLeads', { on: s.leads.onFloor, total: s.leads.total })
                      : t('region.cardNoLead')}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone: 'plain' | 'warn' | 'bad'; sub?: string }) {
  return (
    <div className="rounded-md bg-navy/40 px-2 py-1.5">
      <dt className="text-2xs uppercase tracking-wider text-silver/50">{label}</dt>
      <dd className={cn('text-sm font-semibold tabular-nums', tone === 'bad' ? 'text-alert' : tone === 'warn' ? 'text-warning' : 'text-white')}>
        {value}
      </dd>
      {sub && <dd className={cn('text-2xs', tone === 'bad' ? 'text-alert/80' : tone === 'warn' ? 'text-warning/80' : 'text-silver/50')}>{sub}</dd>}
    </div>
  );
}
