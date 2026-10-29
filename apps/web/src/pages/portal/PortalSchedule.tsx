import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, FileText, Printer, UserPlus } from '@/components/ui/icons';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate, fmtDayHeaderTz, fmtShiftRangeTz, parseYmd, ymdLocal, zonedDayKey } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { CoverageHeatmap, DetailsTable, type HeatDay } from './portalCharts';
import { coverageByHour } from './coverage';
import { ListTemplate } from '@/components/templates';
import { ServiceReportDialog } from './ServiceReportDialog';
import { shiftDays } from './scope';
import '@/lib/i18n/en/portal';

/**
 * The store's week — charts first. A coverage heatmap (day × hour) shows
 * WHEN the floor is covered and where the holes are; the fill columns
 * show how many. Names stay one tap away per day (closed by default,
 * always expanded in print), so "who is my lead Thursday" is still
 * answerable without opening a PDF. Reads the portal's own rate-free
 * endpoint, never the manager grid.
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
  /** The evening before the week, running into its first day — hours only. Absent from an older server. */
  carryIn?: Array<Pick<ScheduleShift, 'startsAt' | 'endsAt' | 'timezone' | 'state'>>;
  filled: number;
  open: number;
  /** The contracted windows (store-local minutes; end <= start wraps midnight). Absent from an older server. */
  targets?: Array<{ locationId: string; label: string; startMinute: number; endMinute: number; headcount: number }>;
  generatedAt: string;
}

/** The contracted headcount at the top of each hour: every window covering it, summed. */
export function hourlyContract(targets: NonNullable<PortalSchedule['targets']>): number[] {
  return Array.from({ length: 24 }, (_, h) => {
    const m = h * 60;
    return targets.reduce((n, w) => {
      const inside = w.endMinute > w.startMinute ? m >= w.startMinute && m < w.endMinute : m >= w.startMinute || m < w.endMinute;
      return inside ? n + w.headcount : n;
    }, 0);
  });
}

/** A window's length in hours (one that ends at or before its start runs past midnight). */
const windowHours = (w: { startMinute: number; endMinute: number }) => (((w.endMinute - w.startMinute + 1440) % 1440) || 1440) / 60;

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

const STATE_STYLE: Record<ScheduleShift['state'], string> = {
  'on-floor': 'text-success',
  confirmed: 'text-silver',
  unconfirmed: 'text-warning',
  done: 'text-silver/60',
  open: 'text-alert',
};


function dayShort(ymd: string): string {
  return new Intl.DateTimeFormat(
    typeof document !== 'undefined' && document.documentElement.lang === 'es' ? 'es-US' : 'en-US',
    { weekday: 'short' },
  ).format(parseYmd(ymd) ?? new Date());
}

export function PortalSchedule() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const locationId = searchParams.get('locationId');
  // No ?week= is the store's own this-week, which the server answers with —
  // late Friday in Pacific, a Chicago store is already in next week.
  const weekParam = searchParams.get('week');
  const week = weekParam ?? ymdLocal();
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());

  const scopeQs = useMemo(() => {
    const q = new URLSearchParams();
    if (!isPortal && previewId) q.set('clientId', previewId);
    if (locationId) q.set('locationId', locationId);
    return q;
  }, [isPortal, previewId, locationId]);
  const qs = `?${new URLSearchParams([...scopeQs.entries(), ...(weekParam ? ([['week', weekParam]] as [string, string][]) : [])]).toString()}`;
  const homeQs = scopeQs.toString() ? `?${scopeQs.toString()}` : '';
  const [reportOpen, setReportOpen] = useState(false);

  const enabled = isPortal || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['clientPortal', 'schedule', qs],
    queryFn: () => apiFetch<PortalSchedule>(`/client-portal/schedule${qs}`),
    enabled,
    refetchInterval: 120_000,
    // Stepping between weeks keeps the page on screen until the next loads.
    placeholderData: (prev) => prev,
  });
  const overview = useQuery({
    queryKey: ['clientPortal', 'overview', isPortal ? 'me' : previewId, homeQs],
    queryFn: () =>
      apiFetch<{ now: { target: number | null }; store: { timezone: string } | null }>(
        `/client-portal/overview${homeQs}`,
      ),
    enabled,
    staleTime: 60_000,
  });
  const data = query.data;
  const target = overview.data?.now.target ?? null;
  const tz = overview.data?.store?.timezone ?? null;

  // The contract hour by hour: the heatmap marks every contracted hour short
  // of it — six days with nothing scheduled against a contract of 8 looked
  // neutral when only hours with a slot could be "below" (F500 G5).
  const contractByHour = useMemo(() => (data?.targets?.length ? hourlyContract(data.targets) : null), [data]);
  // Every day reads the whole week (plus the evening before it): an
  // overnight counts in the hours it covers on BOTH days, not only on the
  // day it starts — 12a–6a read "0 scheduled" with two stockers on (LEAD-3).
  const heatDays: HeatDay[] = useMemo(
    () => {
      const all = [...(data?.carryIn ?? []), ...(data?.days ?? []).flatMap((d) => d.shifts)];
      return (data?.days ?? []).map((d) => {
        const points = coverageByHour(all, d.date, tz);
        return {
          date: d.date,
          label: dayShort(d.date),
          scheduled: points.map((p) => p.scheduled),
          open: points.map((p) => p.open),
          ...(contractByHour ? { target: contractByHour } : {}),
        };
      });
    },
    [data, tz, contractByHour],
  );
  // The week in hours: scheduled (staffed shifts) against contracted (each window × its length × 7).
  const scheduledHours = (data?.days ?? []).reduce(
    (n, d) => n + d.shifts.filter((s) => s.state !== 'open').reduce((a, sh) => a + (Date.parse(sh.endsAt) - Date.parse(sh.startsAt)) / 3_600_000, 0),
    0,
  );
  const contractedHours = (data?.targets ?? []).reduce((n, w) => n + w.headcount * windowHours(w) * 7, 0);

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
    else next.set('week', shiftDays(data?.week.start ?? week, delta * 7));
    setSearchParams(next, { replace: true });
  };
  const toggleDay = (date: string) =>
    setOpenDays((s) => {
      const next = new Set(s);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  // The store's today (its zone when it has one), not the browser's.
  const today = tz ? zonedDayKey(new Date(), tz) : ymdLocal();

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        className="print-area"
        // Titled by page like its siblings (Today, History, Store operations); the store and week below.
        title={t('portal.schedule')}
        topbarTitle={t('portal.schedule')}
        subtitle={
          data
            ? `${data.store ? data.store.name : data.client.name} · ${t('portal.schedWeek', {
                start: fmtDate(parseYmd(data.week.start)),
                end: fmtDate(parseYmd(data.week.end)),
              })}`
            : undefined
        }
        // The trail is the way back to the store (the phone's Back too); the
        // "← My store" button beside it was a third control for the same trip.
        breadcrumbs={[{ label: t('portal.homeCrumb'), to: `/portal${homeQs}` }, { label: t('portal.schedule') }]}
        // A week with gaps wants coverage, not a printout: Request coverage leads (F500 G5).
        actions={[
          {
            key: 'request',
            label: t('portal.reqNew'),
            icon: UserPlus,
            primary: true,
            hidden: !isPortal,
            to: `/portal/requests?${new URLSearchParams([
              ['new', 'STAFFING'],
              ['subject', t('portal.coverageForWeek', { date: fmtDate(parseYmd(data?.week.start ?? week)) })],
            ]).toString()}`,
          },
          { key: 'report', label: t('portal.svcReport'), icon: FileText, onSelect: () => setReportOpen(true) },
          { key: 'print', label: t('portal.print'), icon: Printer, onSelect: () => window.print() },
        ]}
    >
      <ServiceReportDialog
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        scope={scopeQs}
        initial={{ kind: 'range', from: data?.week.start ?? week, to: data?.week.end ?? week }}
      />

      <div className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-2 bg-navy/95 px-4 py-2 backdrop-blur md:mx-0 md:px-0 print:hidden">
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
          <Skeleton className="h-56" />
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <>
          {/* ---- When the floor is covered ------------------------------ */}
          <Card>
            <CardContent>
              <SectionTitle
                size="sm"
                className="mb-0"
                title={t('portal.heatTitle')}
                trailing={
                  <span className="text-xs text-silver tabular-nums" data-testid="sched-summary">
                    {t('portal.schedSummary', { filled: data.filled, open: data.open })}
                    {/* Scheduled against contracted hours: the week's gap in one number. */}
                    {contractedHours > 0 && (
                      <span className={cn(scheduledHours < contractedHours && 'text-warning')}>
                        {' · '}
                        {t('portal.schedVsContract', { scheduled: Math.round(scheduledHours), contracted: Math.round(contractedHours) })}
                      </span>
                    )}
                  </span>
                }
              />
              <div className="mt-3">
                <CoverageHeatmap
                  days={heatDays}
                  target={target}
                  todayKey={today}
                  labels={{
                    cell: (day, hour, scheduled, open) =>
                      t('portal.heatCell', { day, hour, scheduled, open }),
                    scale: { low: t('portal.heatLow'), high: t('portal.heatHigh') },
                    unfilled: t('portal.heatUnfilled'),
                    belowTarget: contractByHour ? t('portal.heatBelowContract') : t('portal.heatBelow', { target: target ?? 0 }),
                    swipe: t('portal.heatSwipe'),
                  }}
                />
                <DetailsTable
                  label={t('portal.details')}
                  columns={[
                    t('portal.chartDay'),
                    t('portal.heatPeak'),
                    t('portal.heatLowest'),
                    t('portal.chartOpen'),
                  ]}
                  rows={heatDays.map((d) => {
                    const active = d.scheduled.filter((n) => n > 0);
                    return [
                      fmtDate(parseYmd(d.date)),
                      active.length ? Math.max(...active) : 0,
                      active.length ? Math.min(...active) : 0,
                      d.open.reduce((a, b) => a + b, 0) > 0 ? t('portal.yes') : t('portal.no'),
                    ];
                  })}
                />
              </div>
            </CardContent>
          </Card>

          {/* ---- Names, one tap away per day ------------------------------ */}
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-navy-secondary/60">
                {data.days.map((d) => {
                  const isToday = d.date === today;
                  const open = openDays.has(d.date);
                  const filled = d.shifts.filter((s) => s.state !== 'open').length;
                  const unfilled = d.shifts.length - filled;
                  return (
                    <li key={d.date} className="print:break-inside-avoid">
                      <button
                        type="button"
                        onClick={() => toggleDay(d.date)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-navy-secondary/30 print:hidden"
                      >
                        <span
                          className={cn(
                            'min-w-0 flex-1 text-sm font-medium',
                            isToday ? 'text-gold' : 'text-white',
                          )}
                        >
                          {fmtDayHeaderTz(parseYmd(d.date), undefined)}
                        </span>
                        <span
                          className={cn(
                            'text-xs tabular-nums',
                            unfilled > 0 ? 'text-alert' : 'text-silver/60',
                          )}
                        >
                          {d.shifts.length === 0
                            ? t('portal.schedDayNone')
                            : t('portal.schedDayMeta', { filled, total: d.shifts.length })}
                        </span>
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 shrink-0 text-silver/60 transition-transform',
                            open && 'rotate-180',
                          )}
                          aria-hidden="true"
                        />
                      </button>
                      <div className="hidden px-4 pt-3 text-sm font-medium text-white print:block">
                        {fmtDayHeaderTz(parseYmd(d.date), undefined)}
                      </div>
                      {d.shifts.length > 0 && (
                        <ul
                          className={cn(
                            'divide-y divide-navy-secondary/60 px-4 pb-3',
                            !open && 'hidden',
                            'print:block',
                          )}
                        >
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
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </ListTemplate>
  );
}
