import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpDown, Building2, Inbox, MessageSquare, Search, Store } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDate, fmtRelativeDate, fmtTime, parseYmd, zonedMinutesOfDay } from '@/lib/format';
import { cn } from '@/lib/cn';
import { regionOverview, type StoreSnapshot } from '@/lib/regionsApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { CoverageCurve, DetailsTable, ReliabilityChart, RingMeter, StatTile, StoreBarChart } from '@/pages/portal/portalCharts';
import { hourLabel } from '@/pages/portal/coverage';

/**
 * The region command center — the market manager's page. Reads the way a
 * regional brief reads: the market's floor right now and across today
 * (hero), one tile per store that carries its own alarm (the store rail),
 * the four numbers that go upward (KPIs), the stores side by side, the
 * month's trend, and what is open with Alto. Every figure comes from the
 * same instruments the store manager's page uses. Each store is one tap
 * away; the full numbers table sits behind Details.
 */

const GRADE_STYLE: Record<NonNullable<StoreSnapshot['reliability']['grade']>, string> = {
  A: 'text-success',
  B: 'text-success',
  C: 'text-warning',
  D: 'text-alert',
  F: 'text-alert',
};

type SortKey = 'rank' | 'name' | 'grade' | 'floor' | 'today' | 'tomorrow' | 'requests';
type Tone = 'bad' | 'warn' | 'good' | 'muted';
const TONE_TEXT: Record<Tone, string> = { bad: 'text-alert', warn: 'text-warning', good: 'text-success', muted: 'text-silver/50' };
const TONE_RING: Record<Tone, 'bad' | 'warn' | 'good' | 'primary'> = { bad: 'bad', warn: 'warn', good: 'good', muted: 'primary' };

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
    const rank = (s: StoreSnapshot) => data?.stores.indexOf(s) ?? 0;
    const cmp: Record<SortKey, (a: StoreSnapshot, b: StoreSnapshot) => number> = {
      rank: (a, b) => rank(a) - rank(b),
      name: (a, b) => a.name.localeCompare(b.name),
      grade: (a, b) => (a.reliability.score ?? -1) - (b.reliability.score ?? -1),
      floor: (a, b) => b.now.short - a.now.short || b.now.onFloor - a.now.onFloor,
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
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const tot = data.totals;
  const storeHref = (s: StoreSnapshot) =>
    data.preview ? `/portal?clientId=${s.clientId}&locationId=${s.id}` : `/portal?locationId=${s.id}`;
  const short = tot.target !== null && tot.onFloor < tot.target;
  const heroTone = short ? 'warning' : tot.onFloor > 0 ? 'success' : 'gold';
  const nowHour = Math.floor(zonedMinutesOfDay(new Date(), null) / 60);
  const curve = data.hours.map((h) => ({ hour: h.hour, label: hourLabel(h.hour), scheduled: h.scheduled, open: h.open }));
  const relWeeks = data.weeks.map((w) => ({
    ...w,
    label: w.current ? t('portal.relNowShort') : fmtDate(parseYmd(w.start)).replace(/,.*$/, ''),
  }));

  /** The one line each tile says — its alarm, or that it is covered. */
  const storeStatus = (s: StoreSnapshot): { tone: Tone; text: string } => {
    if (s.alert) return { tone: 'bad', text: t('region.tileShort', { count: s.now.short }) };
    if (s.today.open > 0) return { tone: 'bad', text: t('region.attnOpenToday', { count: s.today.open }) };
    if (s.requests.overdue > 0) return { tone: 'bad', text: t('region.attnOverdue', { count: s.requests.overdue }) };
    if (s.now.short > 0) return { tone: 'warn', text: t('region.tileShort', { count: s.now.short }) };
    if (s.tomorrow.open > 0) return { tone: 'warn', text: t('region.attnOpenTomorrow', { count: s.tomorrow.open }) };
    if (s.tomorrow.unconfirmed > 0) return { tone: 'warn', text: t('region.attnUnconfirmed', { count: s.tomorrow.unconfirmed }) };
    if (s.leads.total === 0) return { tone: 'warn', text: t('region.cardNoLead') };
    if (s.now.target === null) return { tone: 'muted', text: t('region.tileNoTarget') };
    if (s.today.expected === 0) return { tone: 'muted', text: t('region.tileNothingToday') };
    return { tone: 'good', text: t('region.tileCovered') };
  };

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

      {/* ---- Hero: the market's floor right now, drawn across the day ------ */}
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
              <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg border border-navy-secondary/60 bg-navy/40 px-2 py-2">
                  <dt className="text-2xs uppercase tracking-wider text-silver/60">{t('region.kpiShort')}</dt>
                  <dd className={cn('mt-0.5 text-xl font-bold tabular-nums', tot.shortNow > 0 ? 'text-warning' : 'text-white')}>{tot.shortNow}</dd>
                </div>
                <div className="rounded-lg border border-navy-secondary/60 bg-navy/40 px-2 py-2">
                  <dt className="text-2xs uppercase tracking-wider text-silver/60">{t('portal.chartOpen')}</dt>
                  <dd className={cn('mt-0.5 text-xl font-bold tabular-nums', tot.openToday > 0 ? 'text-alert' : 'text-white')}>{tot.openToday}</dd>
                </div>
                <div className="rounded-lg border border-navy-secondary/60 bg-navy/40 px-2 py-2">
                  <dt className="text-2xs uppercase tracking-wider text-silver/60">{t('region.kpiAlerts')}</dt>
                  <dd className={cn('mt-0.5 text-xl font-bold tabular-nums', tot.alerts > 0 ? 'text-alert' : 'text-white')}>{tot.alerts}</dd>
                </div>
              </dl>
            </div>
            <div className="md:col-span-8">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium text-white">{t('region.curveTitle')}</h2>
                <span className="text-xs text-silver/60 tabular-nums">{t('region.curveMeta', { open: tot.openToday })}</span>
              </div>
              <div className="mt-2">
                <CoverageCurve
                  points={curve}
                  target={tot.target}
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

      {/* ---- The store rail: one tile per store, each carrying its own alarm ---- */}
      <section aria-labelledby="region-stores">
        <div className="flex items-baseline justify-between gap-3 px-0.5">
          <h2 id="region-stores" className="text-sm font-medium text-white">
            {t('region.storesRail')}
          </h2>
          <span className="text-xs text-silver/60">{t('region.storesRailHint')}</span>
        </div>
        {data.stores.length === 0 ? (
          <Card className="mt-2">
            <CardContent className="p-6">
              <EmptyState icon={Store} title={t('region.noStores')} description={t('region.noStoresHint')} />
            </CardContent>
          </Card>
        ) : (
          <ul
            className={cn(
              'mt-2 grid grid-cols-2 gap-3 md:grid-cols-3',
              data.stores.length >= 5 ? 'xl:grid-cols-5' : data.stores.length === 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3',
            )}
          >
            {data.stores.map((s) => {
              const st = storeStatus(s);
              const pct = s.now.target ? Math.min(100, Math.round((s.now.onFloor / s.now.target) * 100)) : null;
              return (
                <li key={s.id} className="min-w-0">
                  <Link
                    to={storeHref(s)}
                    className={cn(
                      'block h-full rounded-xl border bg-navy-surface p-4 transition-colors hover:border-gold/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold',
                      st.tone === 'bad' ? 'border-alert/40 bg-gradient-to-b from-alert/[0.08] to-transparent' : 'border-navy-secondary',
                    )}
                    aria-label={`${s.name} · ${s.now.onFloor}${s.now.target !== null ? ` / ${s.now.target}` : ''} · ${st.text}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-white">{s.name}</span>
                      <span
                        className={cn('shrink-0 text-base font-bold leading-none', s.reliability.grade ? GRADE_STYLE[s.reliability.grade] : 'text-silver/40')}
                        title={s.reliability.score !== null ? `${s.reliability.score}%` : undefined}
                      >
                        {s.reliability.grade ?? '—'}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <RingMeter percent={pct} tone={TONE_RING[st.tone]} size={64} label={t('region.colFloor')}>
                        <span className={cn('text-lg font-bold leading-none tabular-nums', s.now.short > 0 ? 'text-warning' : 'text-white')}>
                          {s.now.onFloor}
                        </span>
                      </RingMeter>
                      <div className="min-w-0">
                        <div className="text-2xs uppercase tracking-wider text-silver/60">{t('region.colFloor')}</div>
                        <div className="text-sm tabular-nums text-white">
                          {s.now.onFloor}
                          {s.now.target !== null && <span className="text-silver/50"> / {s.now.target}</span>}
                        </div>
                        <div className="mt-1 text-2xs text-silver/60 tabular-nums">
                          {t('region.tileToday', { present: s.today.present, expected: s.today.expected })}
                        </div>
                      </div>
                    </div>
                    <p className={cn('mt-3 flex items-center gap-1.5 text-xs', TONE_TEXT[st.tone])}>
                      {st.tone === 'bad' && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                      <span className="truncate">{st.text}</span>
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---- KPI strip: the numbers that go upward ------------------------------ */}
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
                labels={{ value: t('portal.chartShowed'), target: t('portal.chartTarget'), heading: (n) => n }}
              />
            </div>
            <DetailsTable
              label={t('portal.details')}
              columns={[t('region.colStore'), t('region.colGrade'), t('portal.chartShowed')]}
              rows={data.stores.map((s) => [s.name, s.reliability.grade ?? '—', s.reliability.score === null ? '—' : `${s.reliability.score}%`])}
            />
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
        <Card className="xl:col-span-12">
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

      {/* ---- Every number, every store — behind Details ------------------------- */}
      {data.stores.length > 0 && (
        <details className="group print:hidden">
          <summary className="inline-flex min-h-8 cursor-pointer select-none items-center text-2xs uppercase tracking-wider text-silver/60 hover:text-silver coarse:min-h-11">
            {t('region.tableDetails')}
          </summary>
          <Card className="mt-2">
            <CardContent className="p-4 sm:p-5">
              <label className="relative block w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-silver/50" aria-hidden="true" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('region.findStore')} className="pl-8" aria-label={t('region.findStore')} />
              </label>
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
        </details>
      )}
    </div>
  );
}
