import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, FileText, History } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDate, fmtHours, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { downloadStatementFile } from '@/pages/clients/statementsShared';
import { DetailsTable, HoursChart, RingMeter, StatTile, WeekFillChart } from './portalCharts';
import { scopeParams, shiftDays } from './scope';

/**
 * History — how well Alto delivered over a period. One preset row above
 * everything it scopes (last 7 days, last week, this month, last month,
 * custom); every card below re-renders against the same slice, so the
 * numbers always agree: showed-up grade, fill per day, hours scheduled
 * vs delivered, incidents as counts, checklist evidence, safety, the
 * statements that closed inside the range, and the service report for
 * every week it touches. The range lives in the URL.
 */

interface HistoryPayload {
  client: { id: string; name: string };
  store: { id: string; name: string } | null;
  range: { from: string; to: string; days: number };
  generatedAt: string;
  days: Array<{
    date: string;
    published: number;
    filled: number;
    ended: number;
    showed: number;
    open: number;
    scheduledHours: number;
    workedHours: number;
    fillPct: number | null;
    reliabilityPct: number | null;
    showedUpPct: number | null;
    contracted: number;
    delivered: number;
  }>;
  totals: {
    published: number;
    filled: number;
    open: number;
    ended: number;
    showed: number;
    fillPct: number | null;
    reliabilityPct: number | null;
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    basis: 'contract' | 'schedule' | null;
    contractedHours: number;
    deliveredHours: number;
    showedUpPct: number | null;
    scheduledHours: number;
    workedHours: number;
  };
  incidents: { noCallNoShows: number; callOuts: number; lates: number; replacementsFound: number };
  ops: {
    shifts: number;
    sopDone: number;
    sopTotal: number;
    taskDone: number;
    taskTotal: number;
    tempAlerts: number;
    incomplete: number;
    photos: number;
  } | null;
  safety: { incidents: number; open: number };
  statements: Array<{
    id: string;
    number: number | null;
    periodStart: string;
    periodEnd: string;
    amount: number | null;
    hours: number | null;
    storeHours: number | null;
    storeAmount: number | null;
    paidAt: string | null;
    pdfUrl: string;
    reviewed: { reviewedAt: string; reviewedBy: string | null } | null;
  }>;
  serviceReports: Array<{
    weekStart: string;
    weekEnd: string;
    url: string;
    reviewed: { reviewedAt: string; reviewedBy: string | null } | null;
  }>;
  /** Market accounts only: the stores side by side, ranked by grade. */
  stores: Array<{
    id: string;
    name: string;
    published: number;
    filled: number;
    ended: number;
    showed: number;
    fillPct: number | null;
    reliabilityPct: number | null;
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  }>;
}

type Preset = 'last7' | 'lastWeek' | 'thisMonth' | 'lastMonth' | 'custom';

const GRADE_STYLE: Record<NonNullable<HistoryPayload['totals']['grade']>, string> = {
  A: 'text-success',
  B: 'text-success',
  C: 'text-warning',
  D: 'text-alert',
  F: 'text-alert',
};

/** Org week starts Saturday: the last completed Sat→Fri week before today. */
function lastWeekRange(today: string): { from: string; to: string } {
  const d = parseYmd(today)!;
  const dow = d.getDay(); // 0 Sun … 6 Sat
  const sinceSat = (dow + 1) % 7; // days since the most recent Saturday
  const thisWeekStart = shiftDays(today, -sinceSat);
  return { from: shiftDays(thisWeekStart, -7), to: shiftDays(thisWeekStart, -1) };
}

function presetRange(preset: Preset, today: string): { from: string; to: string } | null {
  switch (preset) {
    case 'last7':
      return { from: shiftDays(today, -6), to: today };
    case 'lastWeek':
      return lastWeekRange(today);
    case 'thisMonth':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'lastMonth': {
      const [y, m] = today.split('-').map(Number);
      const first = new Date(Date.UTC(y!, m! - 2, 1)).toISOString().slice(0, 10);
      const last = new Date(Date.UTC(y!, m! - 1, 0)).toISOString().slice(0, 10);
      return { from: first, to: last };
    }
    default:
      return null;
  }
}

export function PortalHistory() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const scope = scopeParams(searchParams, isPortal);
  const scopeQs = scope.toString() ? `?${scope.toString()}` : '';
  const today = ymdLocal();
  const preset = (searchParams.get('range') as Preset | null) ?? 'last7';
  const custom = { from: searchParams.get('from'), to: searchParams.get('to') };
  const range = useMemo(() => {
    const p = presetRange(preset, today);
    if (p) return p;
    return { from: custom.from ?? shiftDays(today, -6), to: custom.to ?? today };
  }, [preset, custom.from, custom.to, today]);
  const qs = `?${new URLSearchParams([...scope.entries(), ['from', range.from], ['to', range.to]]).toString()}`;

  const enabled = isPortal || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['clientPortal', 'history', qs],
    queryFn: () => apiFetch<HistoryPayload>(`/client-portal/history${qs}`),
    enabled,
    placeholderData: (prev) => prev,
  });
  const data = query.data;
  const queryClient = useQueryClient();
  const markReviewed = async (kind: 'STATEMENT' | 'SERVICE_REPORT', key: string) => {
    try {
      await apiFetch('/client-portal/acknowledge', { method: 'POST', body: { kind, key } });
      toast.success(t('portal.markedReviewed'));
      void queryClient.invalidateQueries({ queryKey: ['clientPortal'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('portal.loadFailed'));
    }
  };
  const reviewedMark = (
    reviewed: { reviewedAt: string; reviewedBy: string | null } | null,
    onMark: () => void,
  ) =>
    reviewed ? (
      <span className="flex items-center gap-1 text-2xs text-success">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        {reviewed.reviewedBy
          ? t('portal.reviewed', { name: reviewed.reviewedBy, date: fmtDate(reviewed.reviewedAt) })
          : t('portal.reviewedNoName', { date: fmtDate(reviewed.reviewedAt) })}
      </span>
    ) : isPortal ? (
      <Button size="xs" variant="ghost" onClick={onMark}>
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        {t('portal.markReviewed')}
      </Button>
    ) : null;

  if (!isPortal && !canPreview) {
    return <EmptyState icon={History} title={t('portal.noAccess')} description="" />;
  }
  if (!isPortal && !previewId) {
    return <EmptyState icon={History} title={t('portal.historyNav')} description={t('portal.pickClient')} />;
  }

  const setPreset = (p: Preset, from?: string, to?: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('range', p);
    if (p === 'custom') {
      if (from) next.set('from', from);
      if (to) next.set('to', to);
    } else {
      next.delete('from');
      next.delete('to');
    }
    setSearchParams(next, { replace: true });
  };
  const presets: Array<{ key: Preset; label: string }> = [
    { key: 'last7', label: t('portal.rangeLast7') },
    { key: 'lastWeek', label: t('portal.rangeLastWeek') },
    { key: 'thisMonth', label: t('portal.rangeThisMonth') },
    { key: 'lastMonth', label: t('portal.rangeLastMonth') },
    { key: 'custom', label: t('portal.rangeCustom') },
  ];

  const dayLabel = (ymd: string) =>
    new Intl.DateTimeFormat(
      typeof document !== 'undefined' && document.documentElement.lang === 'es' ? 'es-US' : 'en-US',
      data && data.range.days > 14 ? { month: 'numeric', day: 'numeric' } : { weekday: 'short' },
    ).format(parseYmd(ymd) ?? new Date());
  const days = (data?.days ?? []).map((d) => ({ ...d, day: dayLabel(d.date) }));
  const sopPct = data?.ops && data.ops.sopTotal > 0 ? Math.round((data.ops.sopDone / data.ops.sopTotal) * 100) : null;
  const hoursPct =
    data && data.totals.scheduledHours > 0
      ? Math.min(100, Math.round((data.totals.workedHours / data.totals.scheduledHours) * 100))
      : null;

  return (
    <div className={cn('mx-auto space-y-4', query.isFetching && data && 'opacity-80 transition-opacity')}>
      <PageHeader
        title={t('portal.historyNav')}
        topbarTitle={t('portal.historyNav')}
        subtitle={
          data
            ? `${data.store ? data.store.name : data.client.name} · ${fmtDate(parseYmd(data.range.from))} – ${fmtDate(parseYmd(data.range.to))}`
            : undefined
        }
        breadcrumbs={[{ label: t('portal.title'), to: `/portal${scopeQs}` }]}
        secondaryActions={
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/portal${scopeQs}`}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.backHome')}
            </Link>
          </Button>
        }
      />

      {/* ---- Range: one row, above everything it scopes ---------------- */}
      <div className="sticky top-0 z-10 -mx-4 bg-navy/95 px-4 py-2 backdrop-blur md:mx-0 md:px-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={preset === p.key ? 'secondary' : 'ghost'}
              onClick={() => setPreset(p.key, range.from, range.to)}
            >
              {p.label}
            </Button>
          ))}
          {preset === 'custom' && (
            <span className="flex items-center gap-1.5 text-xs text-silver/70">
              <input
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) => e.target.value && setPreset('custom', e.target.value, range.to)}
                aria-label={t('portal.rangeFrom')}
                className="h-8 rounded-md border border-navy-secondary bg-navy px-2 text-xs text-white coarse:h-10"
              />
              –
              <input
                type="date"
                value={range.to}
                min={range.from}
                max={today}
                onChange={(e) => e.target.value && setPreset('custom', range.from, e.target.value)}
                aria-label={t('portal.rangeTo')}
                className="h-8 rounded-md border border-navy-secondary bg-navy px-2 text-xs text-white coarse:h-10"
              />
            </span>
          )}
        </div>
      </div>

      {query.isError ? (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('portal.loadFailed')}
        </ErrorBanner>
      ) : !data ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      ) : (
        <>
          {/* ---- KPI strip ------------------------------------------------ */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile
              label={t('portal.kpiGradeRange')}
              value={
                <span className={data.totals.grade ? GRADE_STYLE[data.totals.grade] : 'text-silver/50'}>
                  {data.totals.grade ?? '—'}
                </span>
              }
              delta={
                data.totals.reliabilityPct !== null
                  ? t('portal.relScore', { score: data.totals.reliabilityPct })
                  : null
              }
              sub={
                data.totals.basis === 'contract'
                  ? t('portal.kpiDeliveredSub', {
                      delivered: Math.round(data.totals.deliveredHours),
                      contracted: Math.round(data.totals.contractedHours),
                    })
                  : data.totals.basis === 'schedule'
                    ? t('portal.kpiShowedSub', { showed: data.totals.showed, ended: data.totals.ended })
                    : t('portal.relNoHistory')
              }
            />
            <StatTile
              label={t('portal.kpiFillRange')}
              value={data.totals.fillPct !== null ? `${data.totals.fillPct}%` : '—'}
              meter={
                data.totals.fillPct !== null
                  ? {
                      percent: data.totals.fillPct,
                      tone: data.totals.fillPct >= 95 ? 'good' : data.totals.fillPct >= 85 ? 'primary' : 'warn',
                    }
                  : null
              }
              sub={t('portal.kpiFillSub', { filled: data.totals.filled, total: data.totals.published })}
            />
            <StatTile
              label={t('portal.kpiHoursRange')}
              value={fmtHours(data.totals.workedHours)}
              meter={hoursPct !== null ? { percent: hoursPct, tone: 'primary' } : null}
              sub={t('portal.kpiHoursSub', { scheduled: fmtHours(data.totals.scheduledHours) })}
            />
            <StatTile
              label={t('portal.kpiIncidents')}
              value={data.incidents.noCallNoShows}
              unit={t('portal.kpiNcnsWord')}
              deltaTone={data.incidents.noCallNoShows > 0 ? 'bad' : 'good'}
              sub={t('portal.kpiIncidentsSub', {
                callOuts: data.incidents.callOuts,
                lates: data.incidents.lates,
                replaced: data.incidents.replacementsFound,
              })}
            />
          </div>

          {data.totals.basis === 'schedule' && (
            <p className="text-xs text-warning">{t('portal.relBasisSchedule')}</p>
          )}

          {/* ---- Market accounts: the stores side by side ------------------ */}
          {data.stores.length > 0 && (
            <Card>
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-medium text-white">{t('portal.storesRanked')}</h2>
                  <span className="text-xs text-silver/60">{t('portal.storesRankedSub')}</span>
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-2xs uppercase tracking-wider text-silver/60">
                        <th className="py-1 pr-3 font-medium">{t('portal.colStore')}</th>
                        <th className="py-1 pr-3 font-medium">{t('portal.colGrade')}</th>
                        <th className="py-1 pr-3 font-medium">{t('portal.colShowed')}</th>
                        <th className="py-1 pr-3 font-medium">{t('portal.colFill')}</th>
                        <th className="py-1 pr-3 font-medium">{t('portal.colShifts')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-navy-secondary/60">
                      {data.stores.map((s) => {
                        const to = `/portal/history?${new URLSearchParams([
                          ...scope.entries(),
                          ['locationId', s.id],
                          ['range', preset],
                          ...(preset === 'custom' ? ([['from', range.from], ['to', range.to]] as [string, string][]) : []),
                        ]).toString()}`;
                        return (
                          <tr key={s.id}>
                            <td className="py-2 pr-3">
                              <Link to={to} className="font-medium text-white underline-offset-2 hover:underline">
                                {s.name}
                              </Link>
                            </td>
                            <td className={cn('py-2 pr-3 text-lg font-bold leading-none', s.grade ? GRADE_STYLE[s.grade] : 'text-silver/50')}>
                              {s.grade ?? '—'}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-white">
                              {s.reliabilityPct === null ? '—' : `${s.reliabilityPct}%`}
                              <span className="text-silver/50"> · {s.showed}/{s.ended}</span>
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-white">{s.fillPct === null ? '—' : `${s.fillPct}%`}</td>
                            <td className="py-2 pr-3 tabular-nums text-silver">{s.published}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
            {/* ---- Fill per day ------------------------------------------ */}
            <Card className="xl:col-span-7">
              <CardContent className="p-4 sm:p-5">
                <h2 className="text-sm font-medium text-white">{t('portal.histFillTitle')}</h2>
                <div className="mt-3">
                  <WeekFillChart
                    days={days}
                    todayKey={today}
                    labels={{
                      filled: t('portal.chartFilled'),
                      open: t('portal.chartOpen'),
                      heading: (d) => {
                        const row = days.find((x) => x.day === d);
                        return row ? fmtDate(parseYmd(row.date)) : d;
                      },
                    }}
                  />
                  <DetailsTable
                    label={t('portal.details')}
                    columns={[t('portal.chartDay'), t('portal.chartFilled'), t('portal.chartOpen'), t('portal.chartShowed')]}
                    rows={days.map((d) => [
                      fmtDate(parseYmd(d.date)),
                      d.filled,
                      d.open,
                      d.reliabilityPct === null ? '—' : `${d.reliabilityPct}%`,
                    ])}
                  />
                </div>
              </CardContent>
            </Card>

            {/* ---- Hours scheduled vs delivered --------------------------- */}
            <Card className="xl:col-span-5">
              <CardContent className="p-4 sm:p-5">
                <h2 className="text-sm font-medium text-white">{t('portal.histHoursTitle')}</h2>
                <div className="mt-3">
                  <HoursChart
                    days={days}
                    labels={{
                      scheduled: t('portal.chartScheduledHours'),
                      worked: t('portal.chartWorkedHours'),
                      heading: (d) => {
                        const row = days.find((x) => x.day === d);
                        return row ? fmtDate(parseYmd(row.date)) : d;
                      },
                    }}
                  />
                  <DetailsTable
                    label={t('portal.details')}
                    columns={[t('portal.chartDay'), t('portal.chartScheduledHours'), t('portal.chartWorkedHours')]}
                    rows={days.map((d) => [fmtDate(parseYmd(d.date)), fmtHours(d.scheduledHours), fmtHours(d.workedHours)])}
                  />
                </div>
              </CardContent>
            </Card>

            {/* ---- Checklist evidence ------------------------------------- */}
            <Card className="xl:col-span-4">
              <CardContent className="p-5">
                <h2 className="text-sm font-medium text-white">{t('portal.histOpsTitle')}</h2>
                {!data.ops ? (
                  <p className="mt-3 text-sm text-silver/60">{t('portal.opsNone')}</p>
                ) : (
                  <div className="mt-3 flex items-center gap-4">
                    <RingMeter
                      percent={sopPct}
                      tone={sopPct === null ? 'primary' : sopPct >= 95 ? 'good' : sopPct >= 80 ? 'primary' : 'warn'}
                      label={t('portal.opsSopWord')}
                    >
                      <span className="text-xl font-bold tracking-tight text-white">
                        {sopPct === null ? '—' : `${sopPct}%`}
                      </span>
                    </RingMeter>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white">{t('portal.opsSopWord')}</div>
                      <p className="mt-1 text-xs text-silver/70 tabular-nums">
                        {t('portal.opsLine', {
                          shifts: data.ops.shifts,
                          tasks: data.ops.taskDone,
                          total: data.ops.taskTotal,
                          photos: data.ops.photos,
                        })}
                      </p>
                      {(data.ops.tempAlerts > 0 || data.ops.incomplete > 0) && (
                        <p className="mt-1 text-xs text-warning tabular-nums">
                          {[
                            data.ops.tempAlerts > 0 && t('portal.opsTemp', { count: data.ops.tempAlerts }),
                            data.ops.incomplete > 0 && t('portal.opsIncomplete', { count: data.ops.incomplete }),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ---- Safety --------------------------------------------------- */}
            <Card className="xl:col-span-4">
              <CardContent className="p-5">
                <h2 className="text-sm font-medium text-white">{t('portal.safety')}</h2>
                <div className="mt-2 text-4xl font-bold tracking-tight text-white">
                  {data.safety.incidents}
                  <span className="ml-2 text-base font-normal text-silver">{t('portal.safetyInRange')}</span>
                </div>
                <p className={cn('mt-1.5 text-sm tabular-nums', data.safety.open > 0 ? 'text-warning' : 'text-silver')}>
                  {data.safety.incidents === 0
                    ? t('portal.safetyCleanRange')
                    : data.safety.open > 0
                      ? t('portal.safetyOpen', { count: data.safety.open })
                      : t('portal.safetyAllResolved')}
                </p>
              </CardContent>
            </Card>

            {/* ---- Statements + service reports ----------------------------- */}
            <Card className="xl:col-span-4">
              <CardContent className="p-5">
                <h2 className="text-sm font-medium text-white">{t('portal.histDocs')}</h2>
                {data.statements.length === 0 && data.serviceReports.length === 0 ? (
                  <p className="mt-3 text-sm text-silver/60">{t('portal.stNone')}</p>
                ) : (
                  <ul className="mt-3 divide-y divide-navy-secondary/60">
                    {data.statements.map((s) => {
                      const amount = data.store && s.storeAmount !== null ? s.storeAmount : s.amount;
                      return (
                        <li key={s.id} className="flex items-center justify-between gap-2 py-2.5">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-white tabular-nums">
                              {s.number !== null ? t('portal.stNumber', { n: s.number }) : t('portal.statements')}
                            </div>
                            <div className="text-xs text-silver/70 tabular-nums">
                              {fmtDate(parseYmd(s.periodStart))} – {fmtDate(parseYmd(s.periodEnd))}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {amount !== null && (
                              <span className="text-sm font-semibold tabular-nums text-white">{fmtMoney(amount)}</span>
                            )}
                            {s.paidAt ? (
                              <Badge variant="success" size="sm">{t('portal.paidOn', { date: fmtDate(s.paidAt) })}</Badge>
                            ) : (
                              <Badge variant="pending" size="sm">{t('portal.due')}</Badge>
                            )}
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => void downloadStatementFile(s.pdfUrl, `statement-${s.periodStart}.pdf`)}
                              aria-label={t('portal.stPdf')}
                              title={t('portal.stPdf')}
                            >
                              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                            {reviewedMark(s.reviewed, () => void markReviewed('STATEMENT', s.id))}
                          </div>
                        </li>
                      );
                    })}
                    {data.serviceReports.map((r) => (
                      <li key={r.weekStart} className="flex items-center justify-between gap-2 py-2.5">
                        <div className="min-w-0">
                          <div className="text-sm text-white">{t('portal.svcReportWeek')}</div>
                          <div className="text-xs text-silver/70 tabular-nums">
                            {fmtDate(parseYmd(r.weekStart))} – {fmtDate(parseYmd(r.weekEnd))}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => void downloadStatementFile(r.url, `service-report-${r.weekStart}.pdf`)}
                          >
                            <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                            PDF
                          </Button>
                          {reviewedMark(r.reviewed, () => void markReviewed('SERVICE_REPORT', r.weekStart))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
