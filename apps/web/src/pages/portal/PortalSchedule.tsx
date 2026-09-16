import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight, FileText, Printer } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate, fmtDayHeaderTz, fmtShiftRangeTz, parseYmd, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { downloadStatementFile } from '@/pages/clients/statementsShared';

/**
 * The store's published week — the "can you email me the schedule?"
 * page. Sat→Fri (the org week every statement uses), one section per
 * day, printable, with the matching weekly service report one click
 * away. Read-only and rate-free by construction: it reads the portal's
 * own schedule endpoint, never the manager grid.
 */

interface ScheduleShift {
  shiftId: string;
  associateId: string | null;
  name: string | null;
  position: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  locationName: string | null;
  state: 'open' | 'on-floor' | 'done' | 'confirmed' | 'unconfirmed';
}

interface PortalSchedule {
  client: { id: string; name: string };
  store: { id: string; name: string } | null;
  week: { start: string; end: string };
  days: Array<{ date: string; shifts: ScheduleShift[] }>;
  filled: number;
  open: number;
  generatedAt: string;
}

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

const STATE_STYLE: Record<ScheduleShift['state'], string> = {
  'on-floor': 'text-success',
  confirmed: 'text-silver',
  unconfirmed: 'text-warning',
  done: 'text-silver/60',
  open: 'text-alert',
};

function shiftDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function PortalSchedule() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const locationId = searchParams.get('locationId');
  const week = searchParams.get('week') ?? ymdLocal();

  const qs = useMemo(() => {
    const q = new URLSearchParams();
    if (!isPortal && previewId) q.set('clientId', previewId);
    if (locationId) q.set('locationId', locationId);
    q.set('week', week);
    return `?${q.toString()}`;
  }, [isPortal, previewId, locationId, week]);

  const enabled = isPortal || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['clientPortal', 'schedule', qs],
    queryFn: () => apiFetch<PortalSchedule>(`/client-portal/schedule${qs}`),
    enabled,
    refetchInterval: 120_000,
  });

  if (!isPortal && !canPreview) {
    return <EmptyState icon={FileText} title={t('portal.noAccess')} description="" />;
  }
  if (!isPortal && !previewId) {
    return (
      <EmptyState icon={FileText} title={t('portal.schedule')} description={t('portal.pickClient')} />
    );
  }

  const goWeek = (delta: number | null) => {
    const next = new URLSearchParams(searchParams);
    if (delta === null) next.delete('week');
    else next.set('week', shiftDays(week, delta * 7));
    setSearchParams(next, { replace: true });
  };
  const homeQs = (() => {
    const q = new URLSearchParams();
    if (!isPortal && previewId) q.set('clientId', previewId);
    if (locationId) q.set('locationId', locationId);
    const s = q.toString();
    return s ? `?${s}` : '';
  })();
  const reportQs = (() => {
    const q = new URLSearchParams();
    if (!isPortal && previewId) q.set('clientId', previewId);
    if (locationId) q.set('locationId', locationId);
    q.set('week', week);
    return `?${q.toString()}`;
  })();

  const data = query.data;
  const today = ymdLocal();

  return (
    <div className="mx-auto space-y-4">
      <PageHeader
        title={data ? (data.store ? data.store.name : data.client.name) : t('portal.schedule')}
        topbarTitle={t('portal.schedule')}
        subtitle={
          data
            ? t('portal.schedWeek', {
                start: fmtDate(parseYmd(data.week.start)),
                end: fmtDate(parseYmd(data.week.end)),
              })
            : undefined
        }
        breadcrumbs={[{ label: t('portal.title'), to: `/portal${homeQs}` }]}
        secondaryActions={
          <>
            <Button size="sm" variant="ghost" className="print:hidden" asChild>
              <Link to={`/portal${homeQs}`}>
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('portal.backHome')}
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="print:hidden"
              onClick={() =>
                void downloadStatementFile(
                  `/api/client-portal/service-report.pdf${reportQs}`,
                  `service-report-${week}.pdf`,
                )
              }
            >
              <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.svcReport')}
            </Button>
          </>
        }
        primaryAction={
          <Button size="sm" className="print:hidden" onClick={() => window.print()}>
            <Printer className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('portal.print')}
          </Button>
        }
      />

      <div className="flex items-center justify-between gap-2 print:hidden">
        <Button size="sm" variant="ghost" onClick={() => goWeek(-1)} aria-label={t('portal.prevWeek')}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button size="sm" variant="secondary" onClick={() => goWeek(null)}>
          {t('portal.thisWeek')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => goWeek(1)} aria-label={t('portal.nextWeek')}>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
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
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <>
          <p className="text-sm text-silver tabular-nums">
            {t('portal.schedSummary', { filled: data.filled, open: data.open })}
          </p>
          {data.days.map((d) => {
            const isToday = d.date === today;
            return (
              <Card
                key={d.date}
                className={cn('print:break-inside-avoid', isToday && 'border-gold/40')}
              >
                <CardContent className="p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className={cn('text-sm font-medium', isToday ? 'text-gold' : 'text-white')}>
                      {fmtDayHeaderTz(parseYmd(d.date), undefined)}
                      {isToday && <span className="ml-2 text-2xs uppercase tracking-wider">{t('portal.todayWord')}</span>}
                    </h2>
                    <span className="text-xs tabular-nums text-silver/60">
                      {d.shifts.length === 0
                        ? t('portal.schedDayNone')
                        : t('portal.schedDayMeta', {
                            filled: d.shifts.filter((s) => s.state !== 'open').length,
                            total: d.shifts.length,
                          })}
                    </span>
                  </div>
                  {d.shifts.length > 0 && (
                    <ul className="mt-2 divide-y divide-navy-secondary/60">
                      {d.shifts.map((s) => (
                        <li key={s.shiftId} className="flex items-center gap-3 py-2">
                          {s.associateId ? (
                            <Avatar src={photoUrl(s.associateId)} name={s.name ?? ''} email="" size="sm" />
                          ) : (
                            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-dashed border-alert/50 text-alert text-xs">
                              ?
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-white">
                              <span className="font-medium">{s.name ?? t('portal.state.open')}</span>
                              <span className="text-silver/80"> · {s.position}</span>
                            </div>
                            <div className="text-xs text-silver tabular-nums">
                              {fmtShiftRangeTz(s.startsAt, s.endsAt, s.timezone)}
                              {!data.store && s.locationName && (
                                <span className="text-silver/60"> · {s.locationName}</span>
                              )}
                            </div>
                          </div>
                          <span className={cn('shrink-0 text-xs', STATE_STYLE[s.state])}>
                            {t(`portal.state.${s.state}` as MessageKey)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
