import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowUpDown,
  Building2,
  CalendarClock,
  Inbox,
  MessageSquare,
  Search,
  ShieldCheck,
  Store,
  UserX,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDate, fmtRelativeDate, fmtTime, parseYmd, zonedMinutesOfDay } from '@/lib/format';
import { cn } from '@/lib/cn';
import { regionOverview, type RegionOverview, type StoreSnapshot } from '@/lib/regionsApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  CoverageCurve,
  DetailsTable,
  ReliabilityChart,
  StatTile,
  StoreBarChart,
} from '@/pages/portal/portalCharts';
import { hourLabel } from '@/pages/portal/coverage';

/**
 * The region command center — the Manager, Business Operations Support's
 * page. Reads the way a regional brief reads: the region's floor right
 * now and across today (hero), the four numbers that go upward (KPIs),
 * what needs attention this minute, the stores side by side, the month's
 * trend, and what is open with Alto. Every figure comes from the same
 * instruments the store manager's page uses. Each store is one tap away.
 */

const GRADE_STYLE: Record<NonNullable<StoreSnapshot['reliability']['grade']>, string> = {
  A: 'text-success',
  B: 'text-success',
  C: 'text-warning',
  D: 'text-alert',
  F: 'text-alert',
};

type SortKey = 'rank' | 'name' | 'grade' | 'floor' | 'today' | 'tomorrow' | 'requests';

export function RegionHome() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams] = useSearchParams();
  const isRegion = user?.role === 'CLIENT_PORTAL' && !user.clientId && !!user.regionId;
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('regionId');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('rank');

  const enabled = isRegion || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['region', 'overview', isRegion ? 'me' : previewId],
    queryFn: () => regionOverview(isRegion ? null : previewId),
    enabled,
    refetchInterval: 60_000,
  });
  const data = query.data;

  const stores = useMemo(() => {
    const all = [...(data?.stores ?? [])];
    const needle = q.trim().toLowerCase();
    const filtered = needle ? all.filter((s) => `${s.name} ${s.clientName}`.toLowerCase().includes(needle)) : all;
    const rank = (s: StoreSnapshot) => (data?.stores.indexOf(s) ?? 0);
    const cmp: Record<SortKey, (a: StoreSnapshot, b: StoreSnapshot) => number> = {
      rank: (a, b) => rank(a) - rank(b),
      name: (a, b) => a.name.localeCompare(b.name),
      grade: (a, b) => (a.reliability.score ?? -1) - (b.reliability.score ?? -1),
      floor: (a, b) => b.now.short - a.now.short || (b.now.onFloor - a.now.onFloor),
      today: (a, b) => b.today.open - a.today.open || b.today.missedSoFar - a.today.missedSoFar,
      tomorrow: (a, b) => b.tomorrow.open - a.tomorrow.open || b.tomorrow.unconfirmed - a.tomorrow.unconfirmed,
      requests: (a, b) => b.requests.overdue - a.requests.overdue || b.requests.open - a.requests.open,
    };
    return filtered.sort(cmp[sort]);
  }, [data, q, sort]);

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
        <Skeleton className="h-64" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const tot = data.totals;
  const storeHref = (s: StoreSnapshot) =>
    data.preview ? `/portal?clientId=${s.clientId}&locationId=${s.id}` : `/portal?locationId=${s.id}`;
  const dayHref = (s: StoreSnapshot) =>
    data.preview ? `/portal/today?clientId=${s.clientId}&locationId=${s.id}` : `/portal/today?locationId=${s.id}`;
  const short = tot.target !== null && tot.onFloor < tot.target;
  const heroTone = short ? 'warning' : tot.onFloor > 0 ? 'success' : 'gold';
  const nowHour = Math.floor(zonedMinutesOfDay(new Date(), null) / 60);
  const curve = data.hours.map((h) => ({ hour: h.hour, label: hourLabel(h.hour), scheduled: h.scheduled, open: h.open }));
  const curveTarget = tot.target;

  const attention = buildAttention(data, t, storeHref, dayHref);
  const relWeeks = data.weeks.map((w) => ({
    ...w,
    label: w.current ? t('portal.relNowShort') : fmtDate(parseYmd(w.start)).replace(/,.*$/, ''),
  }));

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

      {/* ---- Hero: the region's floor right now, drawn across the day ------ */}
      <Card
        className={cn(
          'relative overflow-hidden animate-enter',
          heroTone === 'warning'
            ? 'border-warning/30 bg-gradient-to-br from-warning/[0.14] via-transparent to-transparent'
            : 'border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent',
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0',
            heroTone === 'success'
              ? 'bg-[radial-gradient(circle_at_10%_0%,rgb(var(--color-success)/0.14),transparent_50%)]'
              : heroTone === 'warning'
                ? 'bg-[radial-gradient(circle_at_10%_0%,rgb(var(--color-warning)/0.14),transparent_50%)]'
                : 'bg-[radial-gradient(circle_at_10%_0%,rgb(var(--color-gold)/0.14),transparent_50%)]',
          )}
        />
        <CardContent className="relative p-5">
          <div className="grid gap-5 md:grid-cols-12">
            <div className="md:col-span-4">
              <span className="text-xs font-medium uppercase tracking-wider text-gold">{t('region.heroEyebrow')}</span>
              <div className="mt-2 flex items-baseline gap-2">
                <span className={cn('text-5xl font-bold leading-none tracking-tight sm:text-6xl', short ? 'text-warning' : 'text-white')}>
                  {tot.onFloor}
                </span>
                {tot.target !== null && <span className="text-2xl font-semibold text-silver/60">/ {tot.target}</span>}
              </div>
              <p className="mt-2 text-sm text-silver">
                {tot.target === null
                  ? t('region.heroNoTargets')
                  : short
                    ? t('region.heroShort', { missing: tot.target - tot.onFloor, stores: tot.shortNow })
                    : t('region.heroMet')}
              </p>
              {/* Per-store bars: who is carrying the region, who is short. */}
              <ul className="mt-4 space-y-2">
                {data.stores.slice(0, 8).map((s) => {
                  const pct = s.now.target ? Math.min(100, Math.round((s.now.onFloor / s.now.target) * 100)) : null;
                  return (
                    <li key={s.id}>
                      <Link to={storeHref(s)} className="block">
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="truncate text-white">{s.name}</span>
                          <span className={cn('shrink-0 tabular-nums', s.now.short > 0 ? 'text-warning' : 'text-silver/70')}>
                            {s.now.onFloor}
                            {s.now.target !== null ? ` / ${s.now.target}` : ''}
                          </span>
                        </div>
                        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
                          <div
                            className={cn('h-full rounded-full', s.now.short > 0 ? 'bg-warning' : 'bg-success')}
                            style={{ width: `${pct ?? (s.now.onFloor > 0 ? 100 : 0)}%` }}
                          />
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="md:col-span-8">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium text-white">{t('region.curveTitle')}</h2>
                <span className="text-xs text-silver/60 tabular-nums">
                  {t('region.curveMeta', { open: tot.openToday })}
                </span>
              </div>
              <div className="mt-2">
                <CoverageCurve
                  points={curve}
                  target={curveTarget}
                  nowHour={nowHour}
                  labels={{
                    scheduled: t('portal.chartScheduled'),
                    open: t('portal.chartOpen'),
                    contracted: t('portal.chartContracted'),
                    now: t('portal.chartNow'),
                    at: (h) => t('portal.chartAt', { hour: h }),
                  }}
                />
                <DetailsTable
                  label={t('portal.details')}
                  columns={[t('portal.chartHour'), t('portal.chartScheduled'), t('portal.chartOpen'), t('portal.chartContracted')]}
                  rows={data.hours
                    .filter((h) => h.scheduled + h.open > 0 || (h.target ?? 0) > 0)
                    .map((h) => [hourLabel(h.hour), h.scheduled, h.open, h.target ?? '—'])}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- KPI strip ------------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label={t('region.kpiGrade')}
          value={tot.score === null ? '—' : `${tot.score}%`}
          delta={tot.gradeCounts.F > 0 ? t('region.kpiGradeF', { count: tot.gradeCounts.F }) : t('region.kpiGradeA', { count: tot.gradeCounts.A })}
          deltaTone={tot.gradeCounts.F > 0 ? 'bad' : 'good'}
          meter={tot.score !== null ? { percent: tot.score, tone: tot.score >= 88 ? 'good' : tot.score >= 70 ? 'primary' : 'bad' } : null}
          sub={t('region.kpiGradeSub', { a: tot.gradeCounts.A, b: tot.gradeCounts.B, f: tot.gradeCounts.F })}
        />
        <StatTile
          label={t('region.kpiShort')}
          value={tot.shortNow}
          unit={t('region.kpiShortUnit', { total: tot.stores })}
          deltaTone={tot.shortNow > 0 ? 'bad' : 'good'}
          sub={tot.alerts > 0 ? t('region.kpiShortAlerts', { count: tot.alerts }) : t('region.kpiFloorOk')}
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* ---- Needs attention ------------------------------------------- */}
        <Card className="xl:col-span-5">
          <CardContent className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <AlertTriangle className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('region.attention')}
              </h2>
              <span className="text-xs text-silver/60 tabular-nums">{attention.length}</span>
            </div>
            {attention.length === 0 ? (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-success">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                {t('region.attentionClean')}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-navy-secondary/60">
                {attention.map((a) => (
                  <li key={a.key}>
                    <Link to={a.href} className="-mx-2 flex items-start gap-3 rounded-md px-2 py-2.5 hover:bg-navy-secondary/30">
                      <a.icon className={cn('mt-0.5 h-4 w-4 shrink-0', a.tone === 'bad' ? 'text-alert' : 'text-warning')} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white">{a.title}</div>
                        <div className="text-xs text-silver/70">{a.store}</div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ---- Stores side by side (delivered vs contracted, 4 weeks) ------- */}
        <Card className="xl:col-span-7">
          <CardContent className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-white">{t('region.storesChart')}</h2>
              <span className="text-xs text-silver/60">{t('region.storesChartSub')}</span>
            </div>
            <div className="mt-3">
              <StoreBarChart
                rows={data.stores.map((s) => ({ id: s.id, name: s.name, value: s.reliability.score }))}
                labels={{
                  value: t('portal.chartShowed'),
                  target: t('portal.chartTarget'),
                  heading: (n) => n,
                }}
              />
            </div>
          </CardContent>
        </Card>

        {/* ---- Leaderboard ---------------------------------------------------- */}
        <Card className="xl:col-span-12">
          <CardContent className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-white">{t('region.leaderboard')}</h2>
              <label className="relative block w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-silver/50" aria-hidden="true" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('region.findStore')} className="pl-8" aria-label={t('region.findStore')} />
              </label>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-2xs uppercase tracking-wider text-silver/60">
                    {(
                      [
                        ['name', t('region.colStore')],
                        ['grade', t('region.colGrade')],
                        ['floor', t('region.colFloor')],
                        ['today', t('region.colToday')],
                        ['tomorrow', t('region.colTomorrow')],
                        ['requests', t('region.colRequests')],
                      ] as Array<[SortKey, string]>
                    ).map(([k, label]) => (
                      <th key={k} className="py-1.5 pr-3 font-medium">
                        <button
                          type="button"
                          onClick={() => setSort(sort === k ? 'rank' : k)}
                          className={cn('inline-flex items-center gap-1 hover:text-white', sort === k && 'text-gold')}
                        >
                          {label}
                          <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </th>
                    ))}
                    <th className="py-1.5 pr-3 font-medium">{t('region.colLeads')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-secondary/60">
                  {stores.map((s) => (
                    <tr key={s.id} className={cn(s.alert && 'bg-alert/[0.06]')}>
                      <td className="py-2.5 pr-3">
                        <Link to={storeHref(s)} className="font-medium text-white underline-offset-2 hover:underline">
                          {s.name}
                        </Link>
                        {s.alert && (
                          <div className="mt-0.5 flex items-center gap-1 text-2xs text-alert">
                            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            {s.alert}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={cn('text-lg font-bold leading-none', s.reliability.grade ? GRADE_STYLE[s.reliability.grade] : 'text-silver/40')}>
                          {s.reliability.grade ?? '—'}
                        </span>
                        {s.reliability.score !== null && <span className="ml-1.5 text-xs tabular-nums text-silver/60">{s.reliability.score}%</span>}
                      </td>
                      <td className={cn('py-2.5 pr-3 tabular-nums', s.now.short > 0 ? 'text-warning' : 'text-white')}>
                        {s.now.onFloor}
                        {s.now.target !== null && <span className="text-silver/50"> / {s.now.target}</span>}
                      </td>
                      <td className="py-2.5 pr-3 tabular-nums text-white">
                        {s.today.present}/{s.today.expected}
                        {s.today.open > 0 && <span className="text-alert"> · {t('portal.openCount', { count: s.today.open })}</span>}
                        {s.today.missedSoFar > 0 && <span className="text-alert/80"> · {t('region.missed', { count: s.today.missedSoFar })}</span>}
                      </td>
                      <td className="py-2.5 pr-3 tabular-nums text-white">
                        {s.tomorrow.expected}
                        {s.tomorrow.open > 0 && <span className="text-alert"> · {t('portal.openCount', { count: s.tomorrow.open })}</span>}
                        {s.tomorrow.unconfirmed > 0 && <span className="text-warning"> · {t('region.cardUnconfirmed', { count: s.tomorrow.unconfirmed })}</span>}
                      </td>
                      <td className="py-2.5 pr-3 tabular-nums text-white">
                        {s.requests.open}
                        {s.requests.overdue > 0 && <span className="text-alert"> · {t('region.cardOverdue', { count: s.requests.overdue })}</span>}
                      </td>
                      <td className="py-2.5 pr-3 tabular-nums text-silver">
                        {s.leads.total > 0 ? `${s.leads.onFloor}/${s.leads.total}` : <span className="text-warning">{t('region.cardNoLead')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* ---- Region trend ---------------------------------------------------- */}
        <Card className="xl:col-span-5">
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('region.trend')}</h2>
            <div className="mt-3">
              <ReliabilityChart weeks={relWeeks} labels={{ fill: t('portal.chartShowed'), target: t('portal.chartTarget'), heading: (l) => l }} />
            </div>
            <DetailsTable
              label={t('portal.details')}
              columns={[t('portal.chartWeek'), t('portal.chartShowed')]}
              rows={data.weeks.map((w) => [fmtDate(parseYmd(w.start)), w.reliabilityPct === null ? '—' : `${w.reliabilityPct}%`])}
            />
          </CardContent>
        </Card>

        {/* ---- Open with Alto --------------------------------------------------- */}
        <Card className="xl:col-span-7">
          <CardContent className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <Inbox className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('region.openRequests')}
              </h2>
              <span className="text-xs text-silver/60 tabular-nums">{data.requests.length}</span>
            </div>
            {data.requests.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('region.openRequestsNone')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-navy-secondary/60">
                {data.requests.slice(0, 12).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-white">{r.subject}</span>
                    <Badge variant="outline">{r.storeName}</Badge>
                    <Badge variant={r.overdue ? 'destructive' : r.status === 'IN_PROGRESS' ? 'accent' : 'pending'}>
                      {r.overdue ? t('portal.reqOverdue') : r.status === 'IN_PROGRESS' ? t('portal.reqInProgress') : t('portal.reqReceived')}
                    </Badge>
                    <span className="w-full text-2xs text-silver/50 sm:w-auto">
                      {fmtRelativeDate(r.createdAt)}
                      {r.owner ? ` · ${r.owner}` : ''}
                      {r.about ? ` · ${t('portal.reqAbout', { name: r.about })}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {data.stores.length === 0 && (
        <Card>
          <CardContent className="p-6">
            <EmptyState icon={Store} title={t('region.noStores')} description={t('region.noStoresHint')} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** The feed: everything a regional manager should act on this minute,
 *  most urgent first, each row a deep link into the store. */
function buildAttention(
  data: RegionOverview,
  t: ReturnType<typeof useI18n>['t'],
  storeHref: (s: StoreSnapshot) => string,
  dayHref: (s: StoreSnapshot) => string,
) {
  const items: Array<{
    key: string;
    title: string;
    store: string;
    href: string;
    tone: 'bad' | 'warn';
    icon: typeof AlertTriangle;
    weight: number;
  }> = [];
  for (const s of data.stores) {
    if (s.alert) items.push({ key: `alert-${s.id}`, title: s.alert, store: s.name, href: dayHref(s), tone: 'bad', icon: AlertTriangle, weight: 0 });
    if (s.requests.overdue > 0) items.push({ key: `overdue-${s.id}`, title: t('region.attnOverdue', { count: s.requests.overdue }), store: s.name, href: storeHref(s), tone: 'bad', icon: Inbox, weight: 1 });
    if (s.today.open > 0) items.push({ key: `open-${s.id}`, title: t('region.attnOpenToday', { count: s.today.open }), store: s.name, href: dayHref(s), tone: 'bad', icon: UserX, weight: 2 });
    if (s.tomorrow.open > 0) items.push({ key: `tmr-${s.id}`, title: t('region.attnOpenTomorrow', { count: s.tomorrow.open }), store: s.name, href: storeHref(s), tone: 'warn', icon: CalendarClock, weight: 3 });
    if (s.tomorrow.unconfirmed > 0) items.push({ key: `unc-${s.id}`, title: t('region.attnUnconfirmed', { count: s.tomorrow.unconfirmed }), store: s.name, href: storeHref(s), tone: 'warn', icon: CalendarClock, weight: 4 });
    if (s.leads.total === 0) items.push({ key: `lead-${s.id}`, title: t('region.cardNoLead'), store: s.name, href: storeHref(s), tone: 'warn', icon: UserX, weight: 5 });
    if (s.reliability.grade === 'F') items.push({ key: `grade-${s.id}`, title: t('region.attnGradeF', { score: s.reliability.score ?? 0 }), store: s.name, href: storeHref(s), tone: 'warn', icon: ShieldCheck, weight: 6 });
  }
  return items.sort((a, b) => a.weight - b.weight || a.store.localeCompare(b.store));
}
