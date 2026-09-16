import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  CalendarDays,
  ClipboardCheck,
  FileText,
  HardHat,
  Mail,
  Phone,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  fmtDate,
  fmtHours,
  fmtMoney,
  fmtShiftRangeTz,
  parseYmd,
} from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ProgressBar } from '@/components/ProgressBar';
import { downloadStatementFile } from '@/pages/clients/statementsShared';
import { PortalRequests, type RequestPrefill } from './PortalRequests';

/**
 * The client portal home — the store manager's site.
 *
 * One hero: are we staffed against what we contracted, right now. Then
 * the questions a manager asks in order — who's here and who leads them,
 * did last night's checklist get done, tomorrow's risk, how reliable
 * Alto has been over the month, is the crew cleared, hours and money,
 * safety — each a card with one human sentence. Store accounts see one
 * store; client-wide accounts get a per-store strip and can drill in.
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
  noCallNoShows: number;
  callOuts: number;
  lates: number;
  replaced: number;
  current: boolean;
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
  };
  tomorrow: { confirmed: number; unconfirmed: number; open: number; coverInFlight: number };
  leads: {
    people: Array<{
      name: string;
      phone: string | null;
      email: string;
      title: 'supervisor' | 'floor-lead';
      onFloor: boolean;
      runningOps: boolean;
    }>;
    supportEmail: string | null;
  };
  ops: { yesterday: OpsDay | null; today: OpsDay | null } | null;
  reliability: {
    weeks: WeekRow[];
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    score: number | null;
  };
  clearance: { total: number; i9Complete: number; checksInFlight: number; flagged: number };
  statements: Array<{
    id: string;
    number: number | null;
    periodStart: string;
    periodEnd: string;
    amount: number | null;
    hours: number | null;
    storeHours: number | null;
    storeAmount: number | null;
    finalizedAt: string | null;
    paidAt: string | null;
    pdfUrl: string;
  }>;
  coverage: {
    weekStart: string;
    noCallNoShows: number;
    callOuts: number;
    lates: number;
    replacementsFound: number;
  };
  safety: { monthIncidents: number; open: number; daysSinceLast: number | null };
  serviceReport: { weekStart: string; url: string };
}

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

const STATE_STYLE: Record<RosterRow['state'], string> = {
  'on-floor': 'text-success',
  confirmed: 'text-silver',
  unconfirmed: 'text-warning',
  done: 'text-silver/60',
  open: 'text-alert',
};

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
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const qs = scopeQuery(searchParams, isPortal);
  const [prefill, setPrefill] = useState<RequestPrefill | null>(null);

  const enabled = isPortal || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['clientPortal', 'overview', isPortal ? 'me' : previewId, qs],
    queryFn: () => apiFetch<PortalOverview>(`/client-portal/overview${qs}`),
    enabled,
    refetchInterval: 60_000,
  });

  if (!isPortal && !canPreview) {
    return <EmptyState icon={Building2} title={t('portal.noAccess')} description="" />;
  }
  if (!isPortal && !previewId) {
    return (
      <EmptyState icon={Building2} title={t('portal.title')} description={t('portal.pickClient')} />
    );
  }

  const data = query.data;

  if (query.isError) {
    return (
      <div className="mx-auto">
        <PageHeader title={t('portal.title')} subtitle={t('portal.subtitle')} />
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
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
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
  const sum = (f: (w: WeekRow) => number) => pastWeeks.reduce((a, w) => a + f(w), 0);
  const opsDay = data.ops?.yesterday ?? data.ops?.today ?? null;
  const opsIsToday = !!data.ops && !data.ops.yesterday && !!data.ops.today;
  const sopPct = opsDay && opsDay.sopTotal > 0 ? Math.round((opsDay.sopDone / opsDay.sopTotal) * 100) : null;
  const cl = data.clearance;
  const clearanceClean = cl.total > 0 && cl.flagged === 0 && cl.checksInFlight === 0 && cl.i9Complete === cl.total;
  const clearanceParts = [
    part(t, cl.flagged, 'portal.clFlaggedOne', 'portal.clFlagged'),
    part(t, cl.checksInFlight, 'portal.clInFlightOne', 'portal.clInFlight'),
    part(t, cl.total - cl.i9Complete, 'portal.clI9One', 'portal.clI9'),
  ].filter(Boolean) as string[];

  return (
    <div className="mx-auto space-y-4">
      <PageHeader
        title={data.store ? data.store.name : data.client.name}
        topbarTitle={t('portal.title')}
        subtitle={
          data.store
            ? [data.client.name, data.store.address].filter(Boolean).join(' · ')
            : t('portal.subtitle')
        }
        secondaryActions={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void downloadStatementFile(
                data.serviceReport.url,
                `service-report-${data.serviceReport.weekStart}.pdf`,
              )
            }
            title={t('portal.svcReportHint', { week: fmtDate(parseYmd(data.serviceReport.weekStart)) })}
          >
            <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('portal.svcReport')}
          </Button>
        }
        primaryAction={
          <Button size="sm" asChild>
            <Link to={scheduleTo}>
              <CalendarDays className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.openSchedule')}
            </Link>
          </Button>
        }
      />

      {/* ---- Per-store strip for market managers ------------------------ */}
      {data.stores.length > 1 && !data.store && (
        <div className="flex gap-2 overflow-x-auto pb-1 animate-enter">
          {data.stores.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => drillTo(s.id)}
              className="shrink-0 rounded-lg border border-navy-secondary bg-navy-secondary/30 px-3 py-2 text-left transition-colors hover:border-gold/40"
            >
              <div className="text-xs font-medium text-white">{s.name}</div>
              <div className="mt-0.5 text-2xs tabular-nums text-silver/70">
                {t('portal.storeChip', { on: s.onFloor, sched: s.scheduledNow })}
                {s.openToday > 0 && (
                  <span className="text-alert"> · {t('portal.openCount', { count: s.openToday })}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      {data.store && data.stores.length === 0 && !user?.locationId && (
        <button
          type="button"
          onClick={() => drillTo(null)}
          className="text-xs text-gold underline-offset-2 hover:underline"
        >
          ← {t('portal.allStores', { client: data.client.name })}
        </button>
      )}

      {/* ---- Hero: staffed vs contracted, right now ---------------------- */}
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
              ? 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-success)/0.14),transparent_55%)]'
              : heroTone === 'warning'
                ? 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-warning)/0.14),transparent_55%)]'
                : 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]',
          )}
        />
        <CardContent className="relative p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.onFloorNow')}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-silver/70">
              {onFloor.length > 0 && (
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                </span>
              )}
              {t('portal.live')}
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span
              className={cn(
                'text-5xl font-bold tracking-tight tabular-nums',
                short ? 'text-warning' : 'text-white',
              )}
            >
              {onFloor.length}
            </span>
            {target !== null && (
              <span className="text-2xl font-semibold tabular-nums text-silver/70">
                / {target}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-silver tabular-nums">
            {target !== null
              ? short
                ? t('portal.heroShort', {
                    missing: target - onFloor.length,
                    window: data.now.targetLabel ?? t('portal.heroContracted'),
                  })
                : t('portal.heroMet', {
                    window: data.now.targetLabel ?? t('portal.heroContracted'),
                  })
              : data.now.scheduledNow > 0
                ? t('portal.onOfSched', { on: onFloor.length, sched: data.now.scheduledNow })
                : onFloor.length > 0
                  ? t('portal.onPlain', { on: onFloor.length })
                  : t('portal.nobodyNow')}
          </p>
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
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* ---- Today's roster ----------------------------------------- */}
        <Card className="animate-enter md:row-span-2" style={enterStagger(1)}>
          <CardContent className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-white">{t('portal.today')}</h2>
              <span
                className={cn(
                  'text-xs tabular-nums',
                  data.today.open > 0 ? 'text-alert' : 'text-silver/60',
                )}
              >
                {t('portal.todayMeta', { filled: data.today.filled, open: data.today.open })}
              </span>
            </div>
            {data.today.roster.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.noShiftsToday')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-navy-secondary/60">
                {data.today.roster.map((r, i) => (
                  <li
                    key={r.shiftId}
                    style={enterStagger(i)}
                    className="flex items-center gap-3 py-2.5 animate-enter"
                  >
                    {r.associateId ? (
                      <Avatar src={photoUrl(r.associateId)} name={r.name ?? ''} email="" size="md" />
                    ) : (
                      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-dashed border-alert/50 text-alert text-xs">
                        ?
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-white">
                        {r.name ?? t('portal.state.open')}
                        <span className="font-normal text-silver/80"> · {r.position}</span>
                        {r.isLead && (
                          <span className="ml-1.5 rounded bg-gold/15 px-1 py-px text-2xs font-medium uppercase tracking-wider text-gold">
                            {t('portal.leadTag')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-silver tabular-nums">
                        {fmtShiftRangeTz(r.startsAt, r.endsAt, r.timezone)}
                        {!data.store && r.locationName && (
                          <span className="text-silver/60"> · {r.locationName}</span>
                        )}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'flex shrink-0 items-center gap-1.5 text-xs',
                        STATE_STYLE[r.state],
                      )}
                    >
                      {r.state === 'on-floor' && (
                        <span className="relative flex h-2 w-2" aria-hidden="true">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                        </span>
                      )}
                      {t(`portal.state.${r.state}` as MessageKey)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ---- Your Alto lead ------------------------------------------ */}
        <Card className="animate-enter" style={enterStagger(2)}>
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <HardHat className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('portal.leadTitle')}
            </h2>
            {data.leads.people.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">
                {data.leads.supportEmail
                  ? t('portal.leadNoneEmail')
                  : t('portal.leadNone')}
              </p>
            ) : (
              <ul className="mt-3 space-y-2.5">
                {data.leads.people.map((p) => (
                  <li key={p.email} className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-white">
                        <span className="truncate">{p.name}</span>
                        {p.onFloor && (
                          <span className="relative flex h-2 w-2" aria-hidden="true">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-silver/70">
                        {t(p.title === 'supervisor' ? 'portal.leadSupervisor' : 'portal.leadFloor')}
                        {p.onFloor && <span className="text-success"> · {t('portal.leadOnFloor')}</span>}
                        {p.runningOps && <span className="text-gold"> · {t('portal.leadRunningOps')}</span>}
                      </div>
                    </div>
                    {p.phone && (
                      <Button size="sm" variant="secondary" asChild>
                        <a href={`tel:${p.phone.replace(/[^+\d]/g, '')}`}>
                          <Phone className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                          {t('portal.call')}
                        </a>
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`mailto:${p.email}`} aria-label={t('portal.emailPerson', { name: p.name })}>
                        <Mail className="h-4 w-4" aria-hidden="true" />
                      </a>
                    </Button>
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

        {/* ---- Tomorrow ------------------------------------------------ */}
        <Card className="animate-enter" style={enterStagger(3)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('portal.tomorrow')}</h2>
            {data.tomorrow.confirmed + data.tomorrow.unconfirmed + data.tomorrow.open === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.tomorrowNone')}</p>
            ) : (
              <>
                <div className="mt-2 text-4xl font-bold tracking-tight tabular-nums text-white">
                  {data.tomorrow.confirmed}
                  <span className="ml-2 text-base font-normal text-silver">
                    {t('portal.confirmedWord')}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-silver tabular-nums">
                  {[
                    data.tomorrow.unconfirmed > 0 &&
                      t('portal.awaiting', { count: data.tomorrow.unconfirmed }),
                    data.tomorrow.open > 0 && t('portal.openCount', { count: data.tomorrow.open }),
                  ]
                    .filter(Boolean)
                    .join(' · ') || t('portal.tomorrowAllSet')}
                </p>
                {data.tomorrow.coverInFlight > 0 && (
                  <p className="mt-1 text-sm text-success tabular-nums">
                    {t('portal.coverInFlight', { count: data.tomorrow.coverInFlight })}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* ---- Last night's work (ops evidence) ------------------------- */}
        <Card className="animate-enter" style={enterStagger(4)}>
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <ClipboardCheck className="h-4 w-4 text-gold" aria-hidden="true" />
              {opsIsToday ? t('portal.opsToday') : t('portal.opsTitle')}
            </h2>
            {!opsDay ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.opsNone')}</p>
            ) : (
              <>
                <div className="mt-2 flex items-baseline gap-2">
                  <span
                    className={cn(
                      'text-4xl font-bold tracking-tight tabular-nums',
                      sopPct === null
                        ? 'text-silver/60'
                        : sopPct >= 95
                          ? 'text-success'
                          : sopPct >= 80
                            ? 'text-white'
                            : 'text-warning',
                    )}
                  >
                    {sopPct === null ? '—' : `${sopPct}%`}
                  </span>
                  <span className="text-sm text-silver">{t('portal.opsSopWord')}</span>
                </div>
                {sopPct !== null && <ProgressBar percent={sopPct} hideLabel className="mt-2" />}
                <p className="mt-2 text-sm text-silver tabular-nums">
                  {t('portal.opsLine', {
                    shifts: opsDay.shifts,
                    tasks: opsDay.taskDone,
                    total: opsDay.taskTotal,
                    photos: opsDay.photos,
                  })}
                </p>
                {(opsDay.tempAlerts > 0 || opsDay.incomplete > 0 || opsDay.open > 0) && (
                  <p className="mt-1 text-sm text-warning tabular-nums">
                    {[
                      opsDay.tempAlerts > 0 && t('portal.opsTemp', { count: opsDay.tempAlerts }),
                      opsDay.incomplete > 0 && t('portal.opsIncomplete', { count: opsDay.incomplete }),
                      opsDay.open > 0 && t('portal.opsStillOpen', { count: opsDay.open }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
                {opsDay.notes.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {opsDay.notes.map((n, i) => (
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

        {/* ---- Reliability (4 weeks) ------------------------------------ */}
        <Card className="animate-enter" style={enterStagger(5)}>
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <ShieldCheck className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('portal.reliability')}
            </h2>
            <div className="mt-2 flex items-end gap-4">
              <div>
                <div
                  className={cn(
                    'text-5xl font-bold leading-none tracking-tight',
                    data.reliability.grade ? GRADE_STYLE[data.reliability.grade] : 'text-silver/50',
                  )}
                >
                  {data.reliability.grade ?? '—'}
                </div>
                {data.reliability.score !== null && (
                  <div className="mt-1 text-2xs uppercase tracking-wider text-silver/60 tabular-nums">
                    {t('portal.relScore', { score: data.reliability.score })}
                  </div>
                )}
              </div>
              <div className="flex flex-1 items-end gap-1.5">
                {data.reliability.weeks.map((w) => (
                  <div
                    key={w.start}
                    className="flex flex-1 flex-col items-center gap-1"
                    title={`${fmtDate(parseYmd(w.start))} – ${fmtDate(parseYmd(w.end))}: ${
                      w.fillPct === null ? '—' : `${w.fillPct}%`
                    }`}
                  >
                    <div className="flex h-12 w-full items-end rounded bg-navy-secondary/60">
                      <div
                        className={cn(
                          'w-full rounded',
                          w.current
                            ? 'bg-gold/50'
                            : (w.fillPct ?? 0) >= 95
                              ? 'bg-success'
                              : (w.fillPct ?? 0) >= 85
                                ? 'bg-gold'
                                : 'bg-alert',
                        )}
                        style={{ height: `${Math.max(w.fillPct === null ? 0 : w.fillPct, 4)}%` }}
                      />
                    </div>
                    <span className="text-2xs tabular-nums text-silver/60">
                      {w.fillPct === null ? '—' : `${w.fillPct}%`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-3 text-sm text-silver tabular-nums">
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
          </CardContent>
        </Card>

        {/* ---- Crew clearance ------------------------------------------- */}
        <Card className="animate-enter" style={enterStagger(6)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('portal.clearance')}</h2>
            {cl.total === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.clNone')}</p>
            ) : clearanceClean ? (
              <p className="mt-3 flex items-center gap-1.5 text-sm text-success">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                {t('portal.clAllClear', { count: cl.total })}
              </p>
            ) : (
              <>
                <p className="mt-3 text-sm text-silver tabular-nums">
                  {t('portal.clCleared', { cleared: cl.total - cl.flagged - cl.checksInFlight, total: cl.total })}
                </p>
                <p className={cn('mt-1 text-sm tabular-nums', cl.flagged > 0 ? 'text-alert' : 'text-warning')}>
                  {clearanceParts.join(' · ')}
                </p>
              </>
            )}
            <p className="mt-2 text-2xs text-silver/50">{t('portal.clFootnote')}</p>
          </CardContent>
        </Card>

        {/* ---- Safety ---------------------------------------------------- */}
        <Card className="animate-enter" style={enterStagger(7)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('portal.safety')}</h2>
            <div className="mt-2 text-4xl font-bold tracking-tight tabular-nums text-white">
              {data.safety.daysSinceLast === null ? '365+' : data.safety.daysSinceLast}
              <span className="ml-2 text-base font-normal text-silver">{t('portal.safetyDays')}</span>
            </div>
            <p
              className={cn(
                'mt-1.5 text-sm tabular-nums',
                data.safety.open > 0 ? 'text-warning' : 'text-silver',
              )}
            >
              {data.safety.monthIncidents === 0
                ? t('portal.safetyCleanMonth')
                : t('portal.safetyMonth', { count: data.safety.monthIncidents })}
              {data.safety.open > 0 && ` · ${t('portal.safetyOpen', { count: data.safety.open })}`}
            </p>
          </CardContent>
        </Card>

        {/* ---- This week: hours ----------------------------------------- */}
        <Card className="animate-enter" style={enterStagger(8)}>
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <CalendarDays className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('portal.week')}
            </h2>
            <div className="mt-3 grid grid-cols-7 gap-1.5 text-center">
              {data.week.days.map((d) => {
                const total = d.filled + d.open;
                const isToday = d.date === data.today.date;
                return (
                  <div
                    key={d.date}
                    className={cn(
                      'rounded-md border py-2',
                      isToday ? 'border-gold/40 bg-gold/[0.06]' : 'border-navy-secondary',
                    )}
                  >
                    <div className="text-2xs text-silver/60">{dayInitial(d.date)}</div>
                    <div
                      className={cn(
                        'mt-0.5 text-sm font-semibold tabular-nums',
                        d.open > 0 ? 'text-alert' : total > 0 ? 'text-white' : 'text-silver/40',
                      )}
                    >
                      {total > 0 ? `${d.filled}/${total}` : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-sm text-silver tabular-nums">
              {data.week.fillRatePct !== null
                ? t('portal.weekSentence', { pct: data.week.fillRatePct, hours: fmtHours(data.week.hours) })
                : t('portal.weekHoursOnly', { hours: fmtHours(data.week.hours) })}
            </p>
            <p className="mt-1 text-xs text-silver/70 tabular-nums">
              {t('portal.weekDelivered', { worked: fmtHours(data.week.workedHours) })}
            </p>
          </CardContent>
        </Card>

        {/* ---- Statements ------------------------------------------------ */}
        <Card className="animate-enter" style={enterStagger(9)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('portal.statements')}</h2>
            {data.statements.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.stNone')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-navy-secondary/60">
                {data.statements.map((s) => {
                  const amount = data.store && s.storeAmount !== null ? s.storeAmount : s.amount;
                  const hours = data.store && s.storeHours !== null ? s.storeHours : s.hours;
                  return (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-white tabular-nums">
                          {s.number !== null ? t('portal.stNumber', { n: s.number }) : t('portal.statements')}
                          {data.store && s.storeAmount !== null && (
                            <span className="ml-1.5 text-2xs font-normal text-silver/50">
                              {t('portal.stStoreShare')}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-silver/70 tabular-nums">
                          {fmtDate(parseYmd(s.periodStart))} – {fmtDate(parseYmd(s.periodEnd))}
                          {hours !== null && ` · ${fmtHours(hours)}`}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {amount !== null && (
                          <span className="text-sm font-semibold tabular-nums text-white">
                            {fmtMoney(amount)}
                          </span>
                        )}
                        {s.paidAt ? (
                          <Badge variant="success">{t('portal.paidOn', { date: fmtDate(s.paidAt) })}</Badge>
                        ) : (
                          <Badge variant="pending">{t('portal.due')}</Badge>
                        )}
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            void downloadStatementFile(s.pdfUrl, `statement-${s.periodStart}.pdf`)
                          }
                          aria-label={t('portal.stPdf')}
                          title={t('portal.stPdf')}
                        >
                          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        {isPortal && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setPrefill({
                                kind: 'BILLING',
                                subject: t('portal.stDisputeSubject', {
                                  n: s.number !== null ? `#${s.number}` : fmtDate(parseYmd(s.periodEnd)),
                                }),
                                nonce: Date.now(),
                              })
                            }
                          >
                            {t('portal.stDispute')}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Requests: the client in the loop -------------------------- */}
      {isPortal && <PortalRequests prefill={prefill} />}
    </div>
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
    { weekday: 'narrow' },
  ).format(d);
}
