import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  FileText,
  HardHat,
  Mail,
  MapPin,
  MessageSquare,
  MessageSquarePlus,
  Phone,
  ShieldCheck,
  UserCheck,
  Users,
} from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  fmtDate,
  fmtDateOnly,
  fmtDateOnlyRange,
  fmtHours,
  fmtMoney,
  fmtShiftRangeTz,
  fmtStatementNo,
  fmtTime,
  fmtTimeTz,
  parseYmd,
  zonedDayKey,
  zonedMinutesOfDay,
} from '@/lib/format';
import { coverageByHour } from './coverage';
import { cn } from '@/lib/cn';
import { userPhotoUrl } from '@/lib/photoUrl';
import { enterStagger } from '@/lib/motion';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import type { PageAction } from '@/components/ui/PageHeader';
import { HomeMeta } from '@/components/home/HomeMeta';
import { OpenBalance, StatementRow, type PortalStatement } from './PortalStatements';
import { PortalRequests, type RequestPrefill } from './PortalRequests';
import { groupWaves, wavePresent } from './waves';
import { PushPrompt } from '@/components/PushPrompt';
import { onLiveEvent } from '@/lib/liveEvents';
import { ServiceReportDialog } from './ServiceReportDialog';
import { shiftDays } from './scope';
import {
  CoverageCurve,
  DetailsTable,
  ReliabilityChart,
  RingMeter,
  StatTile,
  WeekFillChart,
} from './portalCharts';

/**
 * The client portal home — the store manager's site.
 *
 * Reads top-down the way a manager reads a morning brief: the hero is
 * the floor RIGHT NOW against the contracted line, drawn hour by hour
 * across today; a KPI strip carries the four numbers they report upward
 * (fill, reliability grade, hours delivered, tomorrow); then the cards,
 * each one question, each with a figure or a chart and a table twin
 * behind "Details". Store accounts see one store; client-wide accounts
 * get a per-store strip and can drill in.
 *
 * Admins with view:executive / manage:org preview any client via
 * ?clientId= (+ optional ?locationId=) — the pitch-demo path.
 */

interface RosterRow {
  shiftId: string;
  associateId: string | null;
  name: string | null;
  position: string;
  isLead: boolean;
  clockInAt: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  locationName: string | null;
  state: 'open' | 'on-floor' | 'done' | 'confirmed' | 'unconfirmed';
}

interface WeekRow {
  start: string;
  end: string;
  filled: number;
  total: number;
  fillPct: number | null;
  showed: number;
  reliabilityPct: number | null;
  showedUpPct: number | null;
  contracted: number;
  delivered: number;
  noCallNoShows: number;
  callOuts: number;
  lates: number;
  replaced: number;
  current: boolean;
}

interface OpsRoll {
  shifts: number;
  open: number;
  sopDone: number;
  sopTotal: number;
  taskDone: number;
  taskTotal: number;
  tempAlerts: number;
  incomplete: number;
  photos: number;
}

interface OpsDay {
  dateKey: string;
  shifts: number;
  open: number;
  sopDone: number;
  sopTotal: number;
  taskDone: number;
  taskTotal: number;
  tempAlerts: number;
  incomplete: number;
  photos: number;
  notes: Array<{ department: string; period: string; summary: string }>;
}

interface PortalOverview {
  client: { id: string; name: string };
  store: { id: string; name: string; timezone: string; address: string | null } | null;
  stores: Array<{
    id: string;
    name: string;
    onFloor: number;
    scheduledNow: number;
    openToday: number;
  }>;
  generatedAt: string;
  now: {
    onFloor: Array<{
      associateId: string;
      name: string;
      position: string | null;
      isLead: boolean;
      clockInAt: string;
    }>;
    scheduledNow: number;
    target: number | null;
    targetLabel: string | null;
  };
  today: { date: string; roster: RosterRow[]; filled: number; open: number };
  week: {
    start: string;
    end: string;
    days: Array<{ date: string; filled: number; open: number }>;
    filled: number;
    open: number;
    fillRatePct: number | null;
    hours: number;
    workedHours: number;
    /** Contracted person-hours for the whole week; null without windowed targets. */
    contractedHours?: number | null;
  };
  tomorrow: {
    confirmed: number;
    unconfirmed: number;
    open: number;
    coverInFlight: number;
    /** Tomorrow's contracted headcount (each window summed); null without a target. Absent from an older server. */
    target?: number | null;
  };
  leads: {
    people: Array<{
      /** The lead's photo; null when none is on file. Absent from an older server. */
      photoUrl?: string | null;
      userId: string;
      name: string;
      phone: string | null;
      email: string;
      title: 'supervisor' | 'floor-lead';
      onFloor: boolean;
      runningOps: boolean;
      /** The store shift windows this supervisor leads ("Overnight"). */
      shifts?: string[];
    }>;
    supportEmail: string | null;
  };
  ops: {
    yesterday: OpsDay | null;
    today: OpsDay | null;
    /** Running at this moment, whatever day it was filed under. */
    live: Array<{
      id: string;
      department: string;
      period: string;
      openedAt: string;
      sopDone: number;
      sopTotal: number;
    }>;
    /** Today, INCLUDING an overnight that carried into it. */
    current: OpsRoll | null;
    /** Last night's overnight specifically. */
    lastNight: OpsRoll | null;
    todayKey: string;
    yesterdayKey: string;
  } | null;
  reliability: {
    weeks: WeekRow[];
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    score: number | null;
    /** contract = delivered vs the floor target; schedule = no target set. */
    basis: 'contract' | 'schedule' | null;
  };
  clearance: {
    total: number;
    i9Complete: number;
    checksInFlight: number;
    flagged: number;
    /** I-9 done, nothing flagged or in flight — per person. Absent from an older server. */
    cleared?: number;
  };
  statements: Array<PortalStatement & { finalizedAt: string | null }>;
  /** Every unpaid statement (not only the four shown). */
  balance?: {
    count: number;
    amount: number | null;
    pastDue: number;
    pastDueAmount: number | null;
    oldestDaysPastDue: number | null;
    pastDueIds: string[];
  };
  candidatesWaiting?: number;
  requests?: { overdue: number; overdueDays: number | null; overdueId: string | null; answered: number; answeredId: string | null };
  /** Nothing filed today: the next checklist still to start, and whether the store ever ran one. */
  opsPlan?: {
    everRan: boolean;
    next: { department: string; windowLabel: string; startsAt: string } | null;
    missedToday: number;
  } | null;
  coverage: {
    weekStart: string;
    noCallNoShows: number;
    callOuts: number;
    lates: number;
    replacementsFound: number;
  };
  safety: { monthIncidents: number; open: number; daysSinceLast: number | null };
  serviceReport: {
    weekStart: string;
    url: string;
    reviewed: { reviewedAt: string; reviewedBy: string | null } | null;
    /** Anything scheduled that week — an empty week's report is not a task. */
    hadShifts?: boolean;
  };
}

/** One row of the store's "Needs you" — what to do, and the link that does it. */
interface NeedRow {
  key: string;
  tone: 'alert' | 'warning' | 'gold';
  icon: ComponentType<{ className?: string }>;
  title: string;
  sub?: string;
  to?: string;
  href?: string;
  action?: ReactNode;
}
const NEED_TONE: Record<NeedRow['tone'], string> = { alert: 'text-alert', warning: 'text-warning', gold: 'text-gold' };

/** "Reviewed by Dana · Sep 3" — the client's own mark on a document. */
function ReviewedMark({
  reviewed,
  onMark,
  t,
  busy = false,
}: {
  reviewed: { reviewedAt: string; reviewedBy: string | null } | null;
  onMark: (() => void) | null;
  t: ReturnType<typeof useI18n>['t'];
  busy?: boolean;
}) {
  if (reviewed) {
    return (
      <span className="flex items-center gap-1 text-2xs text-success">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        {reviewed.reviewedBy
          ? t('portal.reviewed', { name: reviewed.reviewedBy, date: fmtDate(reviewed.reviewedAt) })
          : t('portal.reviewedNoName', { date: fmtDate(reviewed.reviewedAt) })}
      </span>
    );
  }
  if (!onMark) return null;
  return (
    <Button size="xs" variant="ghost" onClick={onMark} loading={busy} disabled={busy}>
      <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
      {t('portal.markReviewed')}
    </Button>
  );
}

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

const GRADE_STYLE: Record<NonNullable<PortalOverview['reliability']['grade']>, string> = {
  A: 'text-success',
  B: 'text-success',
  C: 'text-warning',
  D: 'text-alert',
  F: 'text-alert',
};

/** Build the API query string for the caller's scope: admins pass the
 *  preview client (+ store); a client-wide portal account may drill into
 *  one of its own stores. */
function scopeQuery(params: URLSearchParams, isPortal: boolean): string {
  const q = new URLSearchParams();
  const client = params.get('clientId');
  const loc = params.get('locationId');
  if (!isPortal && client) q.set('clientId', client);
  if (loc) q.set('locationId', loc);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function ClientPortalHome() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  // A region account (the command center) opens a store to read it; the
  // request desk, "reviewed" marks and statement questions are a client
  // account's own acts, and the API refuses them from a region account.
  const isRegionAccount = isPortal && !user?.clientId && !!user?.regionId;
  const canAct = isPortal && !!user?.clientId;
  const location = useLocation();
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const qs = scopeQuery(searchParams, isPortal);
  const [prefill, setPrefill] = useState<RequestPrefill | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const queryClient = useQueryClient();
  const [marking, setMarking] = useState<string | null>(null);
  const markReviewed = async (kind: 'STATEMENT' | 'SERVICE_REPORT', key: string) => {
    if (marking) return;
    setMarking(`${kind}:${key}`);
    try {
      await apiFetch('/client-portal/acknowledge', { method: 'POST', body: { kind, key } });
      toast.success(t('portal.markedReviewed'));
      await queryClient.invalidateQueries({ queryKey: ['clientPortal'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('portal.loadFailed'));
    } finally {
      setMarking(null);
    }
  };

  const enabled = isPortal || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['clientPortal', 'overview', isPortal ? 'me' : previewId, qs],
    queryFn: () => apiFetch<PortalOverview>(`/client-portal/overview${qs}`),
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    // Drilling into a store keeps the page on screen until the store loads.
    placeholderData: (prev) => prev,
  });
  const data = query.data;
  // The Inbox links here with a #section (#portal-statements): land on it.
  useEffect(() => {
    if (!data || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [data, location.hash]);
  // An alert, a reply or a statement rings the bell; the page catches up.
  useEffect(
    () => onLiveEvent('notification', () => void queryClient.invalidateQueries({ queryKey: ['clientPortal', 'overview'] })),
    [queryClient],
  );

  // The home card reads the live roster; the Day page reads the punch
  // record. Map the live states onto the wave grammar.
  const waves = useMemo(
    () =>
      data
        ? groupWaves(
            data.today.roster.map((r) => ({
              ...r,
              clockOutAt: null,
              state: r.state === 'done' ? ('worked' as const) : r.state,
            })),
          )
        : [],
    [data],
  );
  const curve = useMemo(
    () =>
      data
        ? coverageByHour(data.today.roster, data.today.date, data.store?.timezone ?? null)
        : [],
    [data],
  );

  if (!isPortal && !canPreview) {
    return <EmptyState icon={Building2} title={t('portal.noAccess')} description="" />;
  }
  if (!isPortal && !previewId) {
    return (
      <EmptyState icon={Building2} title={t('portal.title')} description={t('portal.pickClient')} />
    );
  }

  if (query.isError) {
    return (
      <HomeTemplate
        title={t('portal.title')}
        topbarTitle={t('portal.title')}
        subtitle={t('portal.subtitle')}
        hero={
              <EmptyState
                icon={Building2}
                title={t('portal.onFloorNow')}
                description={query.error instanceof ApiError && query.error.message ? query.error.message : t('portal.loadFailed')}
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {isRegionAccount && (
                      <Button size="sm" asChild>
                        <Link to="/region">
                          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                          {t('portal.backToRegion')}
                        </Link>
                      </Button>
                    )}
                    {/* Retrying a 4xx ("Pick a store in your region") never helps. */}
                    {!(query.error instanceof ApiError && query.error.status >= 400 && query.error.status < 500) && (
                      <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
                        {t('common.retry')}
                      </Button>
                    )}
                  </div>
                }
              />
        }
      />
    );
  }

  if (!data) {
    return (
      <HomeTemplate title={t('portal.title')} topbarTitle={t('portal.title')} subtitle={t('portal.subtitle')} hero={<Skeleton className="h-64" />}>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </HomeTemplate>
    );
  }

  const onFloor = data.now.onFloor;
  const target = data.now.target;
  const staffed = target !== null ? onFloor.length >= target : onFloor.length > 0;
  const short = target !== null && onFloor.length < target;
  const heroTone = short ? 'warning' : staffed ? 'success' : 'gold';
  const scheduleTo = `/portal/schedule${qs}`;
  const drillTo = (locationId: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (locationId) next.set('locationId', locationId);
    else next.delete('locationId');
    setSearchParams(next, { replace: true });
  };
  const storeTz = data.store?.timezone ?? data.today.roster[0]?.timezone ?? null;
  const todayLocalKey = zonedDayKey(new Date(), storeTz);
  const nowHour =
    todayLocalKey === data.today.date ? Math.floor(zonedMinutesOfDay(new Date(), storeTz) / 60) : null;

  const covParts = [
    part(t, data.coverage.noCallNoShows, 'portal.covNoShowOne', 'portal.covNoShow'),
    part(t, data.coverage.callOuts, 'portal.covCallOutOne', 'portal.covCallOut'),
    part(t, data.coverage.lates, 'portal.covLateOne', 'portal.covLate'),
  ].filter(Boolean) as string[];
  const replaced = part(
    t,
    data.coverage.replacementsFound,
    'portal.covReplacedOne',
    'portal.covReplaced',
  );
  const pastWeeks = data.reliability.weeks.filter((w) => !w.current);
  const lastWeek = pastWeeks[pastWeeks.length - 1];
  const sum = (f: (w: WeekRow) => number) => pastWeeks.reduce((a, w) => a + f(w), 0);
  const fillDelta =
    data.week.fillRatePct !== null && lastWeek && lastWeek.fillPct !== null
      ? data.week.fillRatePct - lastWeek.fillPct
      : null;
  const hoursPct =
    data.week.hours > 0 ? Math.min(100, Math.round((data.week.workedHours / data.week.hours) * 100)) : null;
  const tomorrowTotal = data.tomorrow.confirmed + data.tomorrow.unconfirmed + data.tomorrow.open;
  // The card used to lead with LAST NIGHT and only fall back to today, so
  // at ten in the morning a store manager saw a finished overnight while
  // the morning crew was on the floor in front of them. It leads with now.
  // Last night is still one click away, under Store operations.
  const opsLive = data.ops?.live ?? [];
  const opsDay = data.ops?.current ?? data.ops?.today ?? null;
  const opsNotes = data.ops?.today?.notes ?? data.ops?.yesterday?.notes ?? [];
  const opsLastNight = data.ops?.lastNight ?? null;
  const pctOf = (r: { sopDone: number; sopTotal: number } | null) =>
    r && r.sopTotal > 0 ? Math.round((r.sopDone / r.sopTotal) * 100) : null;
  const sopPct = pctOf(opsDay);
  const lastNightPct = pctOf(opsLastNight);
  const lastNightHref = `/portal/ops${qs ? `${qs}&` : '?'}date=${
    data.ops?.yesterdayKey ?? ''
  }&period=OVERNIGHT`;
  const cl = data.clearance;
  // Cleared = I-9 done and nothing flagged or in flight, per person (the API
  // counts it). "2 of 2 cleared" sat beside "1 I-9 pending" before.
  const clearedCount = cl.cleared ?? Math.max(0, cl.total - cl.flagged - cl.checksInFlight - (cl.total - cl.i9Complete));
  const clearancePct = cl.total > 0 ? Math.round((clearedCount / cl.total) * 100) : null;
  const clearanceClean =
    cl.total > 0 && cl.flagged === 0 && cl.checksInFlight === 0 && cl.i9Complete === cl.total;
  const clearanceParts = [
    part(t, cl.flagged, 'portal.clFlaggedOne', 'portal.clFlagged'),
    part(t, cl.checksInFlight, 'portal.clInFlightOne', 'portal.clInFlight'),
    part(t, cl.total - cl.i9Complete, 'portal.clI9One', 'portal.clI9'),
  ].filter(Boolean) as string[];
  const weekDays = data.week.days.map((d) => ({ ...d, day: dayInitial(d.date) }));
  // The contract, said where it bites: nothing scheduled today against it.
  const scheduledToday = data.today.roster.filter((r) => r.state !== 'open').length;
  const nothingScheduled = target !== null && scheduledToday === 0;
  const windowName = data.now.targetLabel ?? t('portal.heroContracted');
  const requestCoverage = (when: 'today' | 'tomorrow') => {
    const day = when === 'today' ? data.today.date : shiftDays(data.today.date, 1);
    setPrefill({
      kind: 'STAFFING',
      subject: t('portal.coverageSubject', { date: fmtDateOnly(day, { weekday: true, year: 'auto' }) }),
      body: when === 'today' && target !== null ? t('portal.coverageBody', { window: windowName, target }) : '',
      nonce: Date.now(),
    });
  };
  const hasCurve = curve.some((p) => p.scheduled + p.open > 0);
  const contracted = data.week.contractedHours ?? null;
  const tomorrowTarget = data.tomorrow.target ?? null;
  const tomorrowScheduled = data.tomorrow.confirmed + data.tomorrow.unconfirmed;
  const tomorrowShort = tomorrowTarget !== null && tomorrowScheduled < tomorrowTarget;
  const deliveredHours = sum((w) => w.delivered);
  const contractedHours4w = sum((w) => w.contracted);

  // ---- Needs you: what the store manager has to do, each with its link ----
  const bal = data.balance;
  const needs: NeedRow[] = [];
  if (bal && bal.pastDue > 0) {
    needs.push({
      key: 'statements',
      tone: 'alert',
      icon: FileText,
      title: t('portal.needStatements', { count: bal.pastDue }),
      sub: [
        bal.pastDueAmount !== null ? fmtMoney(bal.pastDueAmount) : null,
        bal.oldestDaysPastDue !== null ? t('portal.needOldest', { count: bal.oldestDaysPastDue }) : null,
      ]
        .filter(Boolean)
        .join(' · '),
      href: '#portal-statements',
    });
  }
  if (canAct && data.serviceReport.hadShifts !== false && !data.serviceReport.reviewed) {
    needs.push({
      key: 'report',
      tone: 'gold',
      icon: ClipboardCheck,
      title: t('portal.needReport', { range: fmtDateOnlyRange(data.serviceReport.weekStart, shiftDays(data.serviceReport.weekStart, 6)) }),
      action: (
        <span className="flex flex-wrap items-center gap-1">
          <Button size="xs" variant="secondary" onClick={() => setReportOpen(true)}>
            <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t('portal.needReportOpen')}
          </Button>
          <ReviewedMark
            reviewed={data.serviceReport.reviewed}
            onMark={() => void markReviewed('SERVICE_REPORT', data.serviceReport.weekStart)}
            t={t}
            busy={marking === `SERVICE_REPORT:${data.serviceReport.weekStart}`}
          />
        </span>
      ),
    });
  }
  if ((data.candidatesWaiting ?? 0) > 0) {
    needs.push({
      key: 'candidates',
      tone: 'gold',
      icon: UserCheck,
      title: t('portal.needCandidates', { count: data.candidatesWaiting ?? 0 }),
      to: `/portal/candidates${qs}`,
    });
  }
  if (canAct && data.requests && data.requests.overdue > 0) {
    needs.push({
      key: 'requests-overdue',
      tone: 'warning',
      icon: MessageSquare,
      title: t('portal.needReqOverdue', { count: data.requests.overdue }),
      sub: data.requests.overdueDays !== null ? t('portal.reqReplyOverdue', { count: data.requests.overdueDays }) : undefined,
      to: data.requests.overdueId ? `/portal/requests?id=${data.requests.overdueId}` : '/portal/requests',
    });
  }
  if (canAct && data.requests && data.requests.answered > 0) {
    needs.push({
      key: 'requests-answered',
      tone: 'gold',
      icon: CheckCircle2,
      title: t('portal.needReqAnswered', { count: data.requests.answered }),
      to: data.requests.answeredId ? `/portal/requests?id=${data.requests.answeredId}` : '/portal/requests',
    });
  }
  const headerActions: PageAction[] = [
    ...(canAct
      ? [
          {
            key: 'request',
            label: t('portal.requestCoverage'),
            icon: MessageSquarePlus,
            primary: true,
            onSelect: () => requestCoverage('today'),
            // The hero carries it when nothing is scheduled — said once.
            hidden: nothingScheduled,
          },
        ]
      : []),
    { key: 'report', label: t('portal.svcReport'), icon: FileText, primary: !canAct || nothingScheduled, onSelect: () => setReportOpen(true), hint: t('portal.svcReportHint') },
    { key: 'schedule', label: t('portal.openSchedule'), icon: CalendarDays, to: scheduleTo },
  ];
  const relWeeks = data.reliability.weeks.map((w) => ({
    ...w,
    label: w.current ? t('portal.relNowShort') : fmtDate(parseYmd(w.start)).replace(/,.*$/, ''),
  }));

  return (
    // Design system §4.1 (UX upgrade step 6, the sweep): the Home template.
    // The store site titles the place, not the person — the store is the
    // identity a client signs into; the floor against the contracted line
    // is the hero; the week's report and history are the ways in.
    <HomeTemplate
        className="print-area"
        title={data.store ? data.store.name : data.client.name}
        topbarTitle={t('portal.title')}
        subtitle={
          data.store ? (
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span>{data.client.name}</span>
              {data.store.address && (
                // One line on a phone (it wrapped to two above the hero).
                <span className="flex min-w-0 max-w-full items-center gap-1 text-silver/70">
                  <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{data.store.address}</span>
                </span>
              )}
            </span>
          ) : (
            <span>{t('portal.subtitle')}</span>
          )
        }
        meta={
          <HomeMeta
            items={[
              <span key="live" className="inline-flex items-center gap-1.5">
                <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                </span>
                {t('portal.asOf', { time: fmtTime(data.generatedAt) })}
              </span>,
              // Last week's report: its review state lives up here, not at the foot of the page.
              data.serviceReport.reviewed ? (
                <span key="report" className="text-success">
                  {data.serviceReport.reviewed.reviewedBy
                    ? t('portal.reportReviewedBy', { name: data.serviceReport.reviewed.reviewedBy, date: fmtDate(data.serviceReport.reviewed.reviewedAt) })
                    : t('portal.reportReviewed', { date: fmtDate(data.serviceReport.reviewed.reviewedAt) })}
                </span>
              ) : data.serviceReport.hadShifts !== false ? (
                <span key="report" className="text-warning">{t('portal.reportNotReviewed')}</span>
              ) : null,
            ]}
          />
        }
        actions={headerActions}
        hero={
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
        <CardContent className="relative">
          <div className="grid gap-5 md:grid-cols-12">
            <div className="md:col-span-4">
              <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
                {t('portal.onFloorNow')}
              </span>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className={cn(
                    'text-5xl font-bold leading-none tracking-tight sm:text-6xl',
                    short ? 'text-warning' : 'text-white',
                  )}
                >
                  {onFloor.length}
                </span>
                {target !== null && (
                  <span className="text-2xl font-semibold text-silver/60">/ {target}</span>
                )}
              </div>
              <p className="mt-2 text-sm text-silver" data-testid="portal-hero-line">
                {target !== null
                  ? nothingScheduled
                    ? // The real problem, said: nothing scheduled against the contract.
                      t('portal.heroNothingScheduled', { window: windowName, target })
                    : short
                      ? t('portal.heroShort', {
                          missing: target - onFloor.length,
                          window: windowName,
                        })
                      : t('portal.heroMet', { window: windowName })
                  : data.now.scheduledNow > 0
                    ? t('portal.onOfSched', { on: onFloor.length, sched: data.now.scheduledNow })
                    : onFloor.length > 0
                      ? t('portal.onPlain', { on: onFloor.length })
                      : t('portal.nobodyNow')}
              </p>
              {canAct && nothingScheduled && (
                <Button size="sm" className="mt-3 print:hidden" onClick={() => requestCoverage('today')}>
                  <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  {t('portal.requestCoverage')}
                </Button>
              )}
              {onFloor.length > 0 && (
                <div className="mt-3 flex items-center -space-x-2">
                  {onFloor.slice(0, 8).map((p) => (
                    <Avatar
                      key={p.associateId}
                      src={photoUrl(p.associateId)}
                      name={p.name}
                      email=""
                      size="md"
                      ringed
                    />
                  ))}
                  {onFloor.length > 8 && (
                    <span className="pl-4 text-sm text-silver tabular-nums">+{onFloor.length - 8}</span>
                  )}
                </div>
              )}
            </div>
            {/* An empty day's curve is a blank box on a phone: there it waits under Details. */}
            <div className={cn('md:col-span-8', !hasCurve && 'hidden sm:block')}>
              <SectionTitle
                size="sm"
                className="mb-0"
                title={t('portal.curveTitle')}
                trailing={
                  <span className="text-xs text-silver/60 tabular-nums">
                    {t('portal.todayMeta', { filled: data.today.filled, open: data.today.open })}
                  </span>
                }
              />
              <div className="mt-2">
                <CoverageCurve
                  points={curve}
                  target={target}
                  nowHour={nowHour}
                  labels={{
                    scheduled: t('portal.chartScheduled'),
                    open: t('portal.chartOpen'),
                    contracted: t('portal.chartContracted'),
                    now: t('portal.chartNow'),
                    empty: t('portal.chartNothing'),
                    at: (h) => t('portal.chartAt', { hour: h }),
                  }}
                />
                <DetailsTable
                  label={t('portal.details')}
                  columns={[t('portal.chartHour'), t('portal.chartScheduled'), t('portal.chartOpen')]}
                  rows={curve.filter((p) => p.scheduled + p.open > 0).map((p) => [p.label, p.scheduled, p.open])}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
        }
        banners={
          isPortal ? (
            <>
              {/* A region account opened one of its stores: back is the command
                  center (/portal with no store is "Pick a store in your region"). */}
              {isRegionAccount && (
                <Link to="/region" className="inline-flex min-h-8 items-center gap-1 text-sm text-gold underline-offset-2 hover:underline print:hidden">
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('portal.backToRegion')}
                </Link>
              )}
              <PushPrompt />
            </>
          ) : undefined
        }
        decisions={{
          title: t('home.needsYou'),
          count: needs.length,
          content:
            needs.length === 0 ? (
              <p className="text-sm text-silver/70" id="portal-needs-you">{t('portal.needNothing')}</p>
            ) : (
              <Card id="portal-needs-you" className="scroll-mt-20">
                <CardContent className="py-1">
                  <ul className="divide-y divide-navy-secondary/60" aria-label={t('home.needsYou')}>
                    {needs.map((n) => {
                      const Icon = n.icon;
                      const text = (
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-white">{n.title}</span>
                          {n.sub && <span className={cn('block text-xs tabular-nums', n.tone === 'alert' ? 'text-alert' : 'text-silver')}>{n.sub}</span>}
                        </span>
                      );
                      const linkCls =
                        'group -mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2.5 hover:bg-navy-secondary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright';
                      return (
                        <li key={n.key} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid={`need-${n.key}`}>
                          {n.to || n.href ? (
                            n.to ? (
                              <Link to={n.to} className={linkCls}>
                                <Icon className={cn('h-4 w-4 shrink-0', NEED_TONE[n.tone])} />
                                {text}
                                <ChevronRight className="h-4 w-4 shrink-0 text-silver/50 group-hover:text-gold" aria-hidden="true" />
                              </Link>
                            ) : (
                              <a href={n.href} className={linkCls}>
                                <Icon className={cn('h-4 w-4 shrink-0', NEED_TONE[n.tone])} />
                                {text}
                                <ChevronRight className="h-4 w-4 shrink-0 text-silver/50 group-hover:text-gold" aria-hidden="true" />
                              </a>
                            )
                          ) : (
                            <span className="flex min-w-0 flex-1 items-center gap-3 py-2.5">
                              <Icon className={cn('h-4 w-4 shrink-0', NEED_TONE[n.tone])} />
                              {text}
                            </span>
                          )}
                          {n.action && <span className="pb-2 sm:pb-0">{n.action}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            ),
        }}
        assistant={<HugoSeat />}
      >
      <ServiceReportDialog
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        scope={new URLSearchParams(qs)}
        initial={{ kind: 'range', from: data.serviceReport.weekStart, to: shiftDays(data.serviceReport.weekStart, 6) }}
      />
      {/* ---- Per-store strip for market managers ------------------------ */}
      {data.stores.length > 1 && !data.store && (
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 animate-enter">
          {data.stores.map((s) => {
            const pct = s.scheduledNow > 0 ? Math.min(100, Math.round((s.onFloor / s.scheduledNow) * 100)) : null;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => drillTo(s.id)}
                className="rounded-lg border border-navy-secondary bg-navy-secondary/20 p-3 text-left transition-colors hover:border-gold/40 elev-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-white">{s.name}</span>
                  {s.openToday > 0 ? (
                    <span className="shrink-0 text-2xs font-medium text-alert">
                      {t('portal.openCount', { count: s.openToday })}
                    </span>
                  ) : (
                    <span className="shrink-0 text-2xs text-silver/50">{t('portal.storeOk')}</span>
                  )}
                </div>
                <div className="mt-1.5 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tracking-tight text-white">{s.onFloor}</span>
                  <span className="text-xs text-silver/70">
                    {t('portal.storeOfSched', { sched: s.scheduledNow })}
                  </span>
                </div>
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
                  <div
                    className={cn('h-full rounded-full', pct !== null && pct < 100 ? 'bg-warning' : 'bg-success')}
                    style={{ width: `${pct ?? 0}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
      {!isRegionAccount && data.store && data.stores.length === 0 && !user?.locationId && (
        <button
          type="button"
          onClick={() => drillTo(null)}
          className="text-xs text-gold underline-offset-2 hover:underline"
        >
          ← {t('portal.allStores', { client: data.client.name })}
        </button>
      )}

      {/* ---- KPI strip: one tile kit, two across on a phone -------------- */}
      <MetricStrip label={t('portal.kpiStrip')} className="animate-enter">
        <StatTile
          label={t('portal.kpiFill')}
          value={data.week.fillRatePct !== null ? `${data.week.fillRatePct}%` : '—'}
          delta={
            fillDelta !== null
              ? `${fillDelta > 0 ? '+' : ''}${fillDelta} ${t('portal.kpiPts')}`
              : null
          }
          deltaTone={fillDelta === null || fillDelta === 0 ? 'neutral' : fillDelta > 0 ? 'good' : 'bad'}
          meter={
            data.week.fillRatePct !== null
              ? {
                  percent: data.week.fillRatePct,
                  tone: data.week.fillRatePct >= 95 ? 'good' : data.week.fillRatePct >= 85 ? 'primary' : 'warn',
                }
              : null
          }
          sub={t('portal.kpiFillSub', { filled: data.week.filled, total: data.week.filled + data.week.open })}
        />
        {/* The grade explains itself: the person-hours behind the letter (as History says). */}
        <MetricCard
          label={t('portal.kpiGrade')}
          href={`/portal/history${qs}`}
          value={
            <span className={data.reliability.grade ? GRADE_STYLE[data.reliability.grade] : 'text-silver/50'}>
              {data.reliability.grade ?? '—'}
            </span>
          }
          valueTitle={data.reliability.grade ?? undefined}
          deltaText={data.reliability.score !== null ? { text: t('portal.relScore', { score: data.reliability.score }), tone: 'neutral' } : null}
          hint={
            contractedHours4w > 0
              ? t('portal.kpiDeliveredSub', {
                  delivered: Math.round(deliveredHours).toLocaleString('en-US'),
                  contracted: Math.round(contractedHours4w).toLocaleString('en-US'),
                })
              : pastWeeks.some((w) => w.total > 0)
                ? t('portal.kpiGradeSub', { ncns: sum((w) => w.noCallNoShows), replaced: sum((w) => w.replaced) })
                : t('portal.relNoHistory')
          }
        />
        {/* Scheduled against the contract, this week — the gap the page used never to say. */}
        <MetricCard
          label={contracted !== null ? t('portal.kpiSchedVsContract') : t('portal.kpiHours')}
          value={contracted !== null ? fmtHours(data.week.hours) : fmtHours(data.week.workedHours)}
          unit={contracted !== null ? `/ ${fmtHours(contracted)}` : undefined}
          tone={contracted !== null && data.week.hours < contracted ? 'warning' : 'default'}
          meter={
            contracted !== null
              ? { percent: Math.min(100, Math.round((data.week.hours / Math.max(contracted, 1)) * 100)), tone: data.week.hours < contracted ? 'warn' : 'good' }
              : hoursPct !== null
                ? { percent: hoursPct, tone: 'primary' }
                : null
          }
          hint={
            contracted !== null
              ? t('portal.kpiSchedVsContractSub', { worked: fmtHours(data.week.workedHours) })
              : t('portal.kpiHoursSub', { scheduled: fmtHours(data.week.hours) })
          }
          href={scheduleTo}
        />
        <MetricCard
          label={t('portal.kpiTomorrow')}
          value={tomorrowTotal === 0 ? (tomorrowTarget !== null ? 0 : '—') : data.tomorrow.confirmed}
          unit={tomorrowTotal === 0 ? undefined : `/ ${tomorrowTotal}`}
          tone={tomorrowShort ? 'warning' : 'default'}
          meter={
            tomorrowTotal > 0
              ? {
                  percent: Math.round((data.tomorrow.confirmed / tomorrowTotal) * 100),
                  tone: data.tomorrow.open > 0 || tomorrowShort ? 'warn' : 'good',
                }
              : null
          }
          hint={
            <>
              {tomorrowShort && (
                <span className="block text-warning" data-testid="tomorrow-vs-contract">
                  {t('portal.tomorrowVsContract', { scheduled: tomorrowScheduled, target: tomorrowTarget ?? 0 })}
                </span>
              )}
              {tomorrowTotal === 0
                ? tomorrowShort
                  ? null
                  : t('portal.tomorrowNone')
                : [
                    data.tomorrow.open > 0 && t('portal.openCount', { count: data.tomorrow.open }),
                    data.tomorrow.unconfirmed > 0 && t('portal.awaiting', { count: data.tomorrow.unconfirmed }),
                    data.tomorrow.coverInFlight > 0 && t('portal.coverInFlightShort', { count: data.tomorrow.coverInFlight }),
                  ]
                    .filter(Boolean)
                    .join(' · ') || t('portal.tomorrowAllSet')}
            </>
          }
        />
      </MetricStrip>

      {/* items-start: a short card no longer stretches to its tall neighbour (200px of nothing). */}
      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-12">
        {/* ---- Today by shift (the full list lives on /portal/today) ---- */}
        <Card className="animate-enter xl:col-span-5" style={enterStagger(2)}>
          <CardContent>
            <SectionTitle
              size="sm"
              className="mb-0"
              title={t('portal.todayByShift')}
              trailing={
                <Link to={`/portal/today${qs}`} className="text-xs text-gold underline-offset-2 hover:underline">
                  {t('portal.todayOpen')}
                </Link>
              }
            />
            {waves.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.noShiftsToday')}</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {waves.map((w) => {
                  const inCount = w.phase === 'finished' ? wavePresent(w) : w.clockedIn.length;
                  const pct = w.expected > 0 ? Math.round((inCount / w.expected) * 100) : 0;
                  const short = w.phase === 'live' && inCount < w.expected;
                  return (
                    <li key={w.key}>
                      <Link
                        to={`/portal/today${qs}`}
                        className="-mx-2 block rounded-md px-2 py-1 hover:bg-navy-secondary/30"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span
                            className={cn(
                              'text-sm tabular-nums',
                              w.phase === 'finished' ? 'text-silver/70' : 'text-white',
                            )}
                          >
                            {fmtShiftRangeTz(w.startsAt, w.endsAt, w.timezone)}
                            {w.phase === 'live' && (
                              <span className="ml-2 text-2xs font-medium uppercase tracking-wider text-success">
                                {t('portal.live')}
                              </span>
                            )}
                          </span>
                          <span
                            className={cn(
                              'text-sm font-semibold tabular-nums',
                              short ? 'text-warning' : w.phase === 'finished' ? 'text-silver/70' : 'text-white',
                            )}
                          >
                            {w.phase === 'upcoming'
                              ? t('portal.waveExpected', { expected: w.expected })
                              : t('portal.waveInOfShort', { in: inCount, expected: w.expected })}
                            {w.open.length > 0 && (
                              <span className="text-alert"> · {t('portal.openCount', { count: w.open.length })}</span>
                            )}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              w.phase === 'upcoming' ? 'bg-silver/30' : short ? 'bg-warning' : 'bg-success',
                            )}
                            style={{ width: `${w.phase === 'upcoming' ? 100 : pct}%` }}
                          />
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ---- Your Alto lead ------------------------------------------ */}
        <Card className="animate-enter xl:col-span-3" style={enterStagger(3)}>
          <CardContent>
            <SectionTitle size="sm" className="mb-0" icon={HardHat} title={t('portal.leadTitle')} />
            {data.leads.people.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">
                {data.leads.supportEmail ? t('portal.leadNoneEmail') : t('portal.leadNone')}
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {data.leads.people.map((p) => (
                  <li key={p.email} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {/* The API's photoUrl: null means no photo on file — initials, no request that 404s. */}
                    <Avatar src={p.photoUrl !== undefined ? (p.photoUrl ?? undefined) : userPhotoUrl(p.userId)} name={p.name} email={p.email} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-white">
                        <span className="truncate">{p.name}</span>
                        <a
                          href={`mailto:${p.email}`}
                          aria-label={t('portal.emailPerson', { name: p.name })}
                          title={p.email}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-silver/70 hover:text-gold print:hidden"
                        >
                          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                        </a>
                        {p.onFloor && (
                          <span className="relative flex h-2 w-2" aria-hidden="true">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-silver/70">
                        {t(p.title === 'supervisor' ? 'portal.leadSupervisor' : 'portal.leadFloor')}
                        {p.shifts && p.shifts.length > 0 && <span className="text-silver"> · {p.shifts.join(', ')}</span>}
                        {p.onFloor && <span className="text-success"> · {t('portal.leadOnFloor')}</span>}
                        {p.runningOps && <span className="text-gold"> · {t('portal.leadRunningOps')}</span>}
                      </div>
                    </div>
                    {/* Actions take their own row on a phone so the name never squeezes. */}
                    <div className="flex w-full flex-wrap items-center gap-1 pl-11 print:hidden">
                      {canAct && (
                        <Button size="sm" variant="secondary" asChild>
                          <Link to={`/messages?to=${p.userId}`} aria-label={`${t('portal.messageLead')} ${p.name}`}>
                            <MessageSquare className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                            {t('portal.messageLead')}
                          </Link>
                        </Button>
                      )}
                      {p.phone && (
                        <Button size="sm" variant="ghost" asChild>
                          <a href={`tel:${p.phone.replace(/[^+\d]/g, '')}`}>
                            <Phone className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                            {t('portal.call')}
                          </a>
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {data.leads.supportEmail && (
              <p className="mt-3 text-xs text-silver/60">
                {t('portal.leadEscalate')}{' '}
                <a className="text-gold hover:underline" href={`mailto:${data.leads.supportEmail}`}>
                  {data.leads.supportEmail}
                </a>
              </p>
            )}
          </CardContent>
        </Card>

        {/* ---- Last night's work (ops evidence) ------------------------- */}
        <Card className="animate-enter xl:col-span-4" style={enterStagger(4)}>
          <CardContent>
            <SectionTitle
              size="sm"
              className="mb-0"
              icon={ClipboardCheck}
              title={
                <>
                  {opsLive.length > 0 ? t('portal.opsNowTitle') : t('portal.opsTodayTitle')}
                  {opsLive.length > 0 && (
                    <span className="ml-1 inline-flex items-center gap-1 text-2xs font-normal text-success">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                      </span>
                      {t('portal.opsNowLine', { count: opsLive.length })}
                    </span>
                  )}
                </>
              }
              trailing={
                <Link to={`/portal/ops${qs}`} className="text-xs text-gold underline-offset-2 hover:underline">
                  {t('portal.opsOpen')}
                </Link>
              }
            />
            {!opsDay ? (
              <div className="mt-3 text-sm text-silver/70" data-testid="portal-ops-plan">
                {data.opsPlan?.next ? (
                  <p>
                    {t('portal.opsNextUp', {
                      department: data.opsPlan.next.department,
                      window: data.opsPlan.next.windowLabel,
                      time: fmtTimeTz(data.opsPlan.next.startsAt, storeTz),
                    })}
                  </p>
                ) : data.opsPlan?.everRan ? (
                  <p>{t('portal.opsNothingYet')}</p>
                ) : (
                  <p className="text-silver/60">{t('portal.opsNone')}</p>
                )}
                {(data.opsPlan?.missedToday ?? 0) > 0 && (
                  <p className="mt-1 text-xs text-warning">{t('portal.opsMissedToday', { count: data.opsPlan?.missedToday ?? 0 })}</p>
                )}
              </div>
            ) : (
              <>
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
                        shifts: opsDay.shifts,
                        tasks: opsDay.taskDone,
                        total: opsDay.taskTotal,
                        photos: opsDay.photos,
                      })}
                    </p>
                    {(opsDay.tempAlerts > 0 || opsDay.incomplete > 0 || opsDay.open > 0) && (
                      <p className="mt-1 text-xs text-warning tabular-nums">
                        {[
                          opsDay.tempAlerts > 0 && t('portal.opsTemp', { count: opsDay.tempAlerts }),
                          opsDay.incomplete > 0 && t('portal.opsIncomplete', { count: opsDay.incomplete }),
                          opsDay.open > 0 && t('portal.opsStillOpen', { count: opsDay.open }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                </div>
                {/* What is on the floor right now, named. A percentage
                    alone never told the manager who to walk up to. */}
                {opsLive.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t border-navy-secondary/60 pt-3">
                    {opsLive.map((l) => {
                      const pct = l.sopTotal > 0 ? Math.round((l.sopDone / l.sopTotal) * 100) : null;
                      return (
                        <li key={l.id} className="flex items-center gap-2 text-xs">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-white">
                            {l.department}
                            <span className="text-silver/50"> · {l.period.toLowerCase()}</span>
                          </span>
                          <span className="shrink-0 tabular-nums text-silver/70">
                            {pct === null ? '—' : `${pct}%`}
                          </span>
                          <span className="shrink-0 tabular-nums text-silver/50">
                            {t('portal.opsSince', { time: fmtTime(new Date(l.openedAt)) })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {/* Last night, on purpose — the thing this card used to be,
                    now a link into the filter that actually shows it. */}
                {opsLastNight && (
                  <Link
                    to={lastNightHref}
                    className="mt-3 flex items-center justify-between gap-2 rounded-md border border-navy-secondary/70 px-2.5 py-2 text-xs transition-colors hover:border-gold/40"
                  >
                    <span className="min-w-0">
                      <span className="text-white">{t('portal.opsLastNight')}</span>
                      <span className="ml-1.5 text-silver/70 tabular-nums">
                        {t('portal.opsLastNightLine', {
                          shifts: opsLastNight.shifts,
                          pct: lastNightPct ?? 0,
                        })}
                      </span>
                    </span>
                    <span className="shrink-0 text-gold">{t('portal.opsSeeLastNight')}</span>
                  </Link>
                )}
                {opsNotes.length > 0 && (
                  <ul className="mt-3 space-y-1.5 border-t border-navy-secondary/60 pt-3">
                    {opsNotes.map((n, i) => (
                      <li key={i} className="text-xs text-silver/80">
                        <span className="font-medium text-white">{n.department}</span>
                        <span className="text-silver/50"> · {n.period.toLowerCase()}</span>
                        <span className="text-silver/60"> — </span>
                        {n.summary}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* ---- This week: fill by day ------------------------------------ */}
        <Card className="animate-enter xl:col-span-7" style={enterStagger(5)}>
          <CardContent>
            <SectionTitle
              size="sm"
              className="mb-0"
              icon={CalendarDays}
              title={t('portal.week')}
              trailing={
                <span className="text-xs text-silver/60 tabular-nums">
                  {fmtDate(parseYmd(data.week.start))} – {fmtDate(parseYmd(data.week.end))}
                </span>
              }
            />
            <div className="mt-3">
              <WeekFillChart
                days={weekDays}
                todayKey={data.today.date}
                labels={{
                  filled: t('portal.chartFilled'),
                  open: t('portal.chartOpen'),
                  heading: (d) => {
                    const row = weekDays.find((x) => x.day === d);
                    return row ? fmtDate(parseYmd(row.date)) : d;
                  },
                }}
              />
            </div>
            <p className="mt-2 text-sm text-silver tabular-nums">
              {data.week.fillRatePct !== null
                ? t('portal.weekSentence', { pct: data.week.fillRatePct, hours: fmtHours(data.week.hours) })
                : t('portal.weekHoursOnly', { hours: fmtHours(data.week.hours) })}
              <span className="text-silver/60"> · {t('portal.weekDelivered', { worked: fmtHours(data.week.workedHours) })}</span>
            </p>
            <DetailsTable
              label={t('portal.details')}
              columns={[t('portal.chartDay'), t('portal.chartFilled'), t('portal.chartOpen')]}
              rows={data.week.days.map((d) => [fmtDate(parseYmd(d.date)), d.filled, d.open])}
            />
          </CardContent>
        </Card>

        {/* ---- Reliability (4 weeks) ------------------------------------ */}
        <Card className="animate-enter xl:col-span-5" style={enterStagger(6)}>
          <CardContent>
            <SectionTitle
              size="sm"
              className="mb-0"
              icon={ShieldCheck}
              title={t('portal.reliability')}
              trailing={
                <span
                  className={cn(
                    'text-2xl font-bold leading-none tracking-tight',
                    data.reliability.grade ? GRADE_STYLE[data.reliability.grade] : 'text-silver/50',
                  )}
                >
                  {data.reliability.grade ?? '—'}
                </span>
              }
            />
            <div className="mt-3">
              <ReliabilityChart
                weeks={relWeeks}
                labels={{
                  fill: t('portal.chartShowed'),
                  target: t('portal.chartTarget'),
                  heading: (l) => {
                    const w = relWeeks.find((x) => x.label === l);
                    return w ? `${fmtDate(parseYmd(w.start))} – ${fmtDate(parseYmd(w.end))}` : l;
                  },
                }}
              />
            </div>
            <p className="mt-2 text-sm text-silver tabular-nums">
              {pastWeeks.some((w) => w.total > 0)
                ? t('portal.relMonthLine', {
                    ncns: sum((w) => w.noCallNoShows),
                    lates: sum((w) => w.lates),
                    replaced: sum((w) => w.replaced),
                  })
                : t('portal.relNoHistory')}
            </p>
            <p className="mt-1 text-xs text-silver/70 tabular-nums">
              {t('portal.relThisWeek')}{' '}
              {covParts.length === 0 ? (
                <span className="text-success">{t('portal.covClean')}</span>
              ) : (
                covParts.join(' · ')
              )}
              {replaced && <span className="text-success"> · {replaced}</span>}
            </p>
            {data.reliability.basis === 'schedule' && (
              <p className="mt-2 text-xs text-warning">{t('portal.relBasisSchedule')}</p>
            )}
            <DetailsTable
              label={t('portal.details')}
              columns={[
                t('portal.chartWeek'),
                t('portal.chartShowed'),
                t('portal.chartShowedUp'),
                t('portal.chartFillPct'),
                t('portal.covNoShowCol'),
                t('portal.covCallOutCol'),
                t('portal.covLateCol'),
                t('portal.covReplacedCol'),
              ]}
              rows={data.reliability.weeks.map((w) => [
                `${fmtDate(parseYmd(w.start))} – ${fmtDate(parseYmd(w.end))}`,
                w.reliabilityPct === null ? '—' : `${w.reliabilityPct}%`,
                w.showedUpPct === null ? '—' : `${w.showedUpPct}%`,
                w.fillPct === null ? '—' : `${w.fillPct}%`,
                w.noCallNoShows,
                w.callOuts,
                w.lates,
                w.replaced,
              ])}
            />
          </CardContent>
        </Card>

        {/* ---- Crew clearance ------------------------------------------- */}
        <Card className="animate-enter xl:col-span-4" style={enterStagger(7)}>
          <CardContent>
            <SectionTitle size="sm" className="mb-0" title={t('portal.clearance')} />
            {cl.total === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.clNone')}</p>
            ) : (
              <div className="mt-3 flex items-center gap-4">
                <RingMeter
                  percent={clearancePct}
                  tone={clearanceClean ? 'good' : cl.flagged > 0 ? 'bad' : 'warn'}
                  label={t('portal.clearance')}
                >
                  <span className="text-xl font-bold tracking-tight text-white">
                    {clearedCount}
                    <span className="text-xs font-normal text-silver/60">/{cl.total}</span>
                  </span>
                </RingMeter>
                <div className="min-w-0 flex-1">
                  {clearanceClean ? (
                    <p className="flex items-start gap-1.5 text-sm text-success">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      {t('portal.clAllClear', { count: cl.total })}
                    </p>
                  ) : (
                    <>
                      <p className="text-sm text-white tabular-nums">
                        {t('portal.clCleared', { cleared: clearedCount, total: cl.total })}
                      </p>
                      <p className={cn('mt-1 text-xs tabular-nums', cl.flagged > 0 ? 'text-alert' : 'text-warning')}>
                        {clearanceParts.join(' · ')}
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---- Safety ---------------------------------------------------- */}
        <Card className="animate-enter xl:col-span-4" style={enterStagger(8)}>
          <CardContent>
            <SectionTitle size="sm" className="mb-0" title={t('portal.safety')} />
            <div className="mt-2 text-4xl font-bold tracking-tight text-white">
              {data.safety.daysSinceLast === null ? '365+' : data.safety.daysSinceLast}
              <span className="ml-2 text-base font-normal text-silver">{t('portal.safetyDays')}</span>
            </div>
            <p className={cn('mt-1.5 text-sm tabular-nums', data.safety.open > 0 ? 'text-warning' : 'text-silver')}>
              {data.safety.monthIncidents === 0
                ? t('portal.safetyCleanMonth')
                : t('portal.safetyMonth', { count: data.safety.monthIncidents })}
              {data.safety.open > 0 && ` · ${t('portal.safetyOpen', { count: data.safety.open })}`}
            </p>
          </CardContent>
        </Card>

        {/* ---- Statements: money, due dates, how late — one row kit with History ---- */}
        <Card className="animate-enter scroll-mt-20 xl:col-span-4" style={enterStagger(9)} id="portal-statements">
          <CardContent>
            <SectionTitle size="sm" className="mb-0" title={t('portal.statements')} trailing={<OpenBalance balance={data.balance} />} />
            {data.statements.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.stNone')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-navy-secondary/60">
                {data.statements.slice(0, 4).map((s) => (
                  <StatementRow
                    key={s.id}
                    s={s}
                    inStore={!!data.store}
                    actions={
                      s.paidAt ? null : (
                      <>
                        {canAct && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setPrefill({
                                kind: 'BILLING',
                                subject: t('portal.stDisputeSubject', {
                                  n: s.number !== null ? fmtStatementNo(s.number) : fmtDate(parseYmd(s.periodEnd)),
                                }),
                                nonce: Date.now(),
                              })
                            }
                          >
                            {t('portal.stDispute')}
                          </Button>
                        )}
                        <ReviewedMark
                          reviewed={s.reviewed}
                          onMark={canAct ? () => void markReviewed('STATEMENT', s.id) : null}
                          t={t}
                          busy={marking === `STATEMENT:${s.id}`}
                        />
                      </>
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Requests: the client in the loop -------------------------- */}
      {/* The request desk is a client account's own (a region account reads; the API refuses it). */}
      {canAct && <PortalRequests prefill={prefill} refetchMs={180_000} />}
    </HomeTemplate>
  );
}

/** "3 call-outs" / "1 call-out" / null when zero. */
function part(
  t: ReturnType<typeof useI18n>['t'],
  count: number,
  one: MessageKey,
  many: MessageKey,
): string | null {
  if (count <= 0) return null;
  return count === 1 ? t(one) : t(many, { count });
}

/** Weekday initial for a YYYY-MM-DD key, locale-aware. */
function dayInitial(ymd: string): string {
  const d = parseYmd(ymd);
  if (!d) return '';
  return new Intl.DateTimeFormat(
    typeof document !== 'undefined' && document.documentElement.lang === 'es' ? 'es-US' : 'en-US',
    { weekday: 'short' },
  ).format(d);
}
