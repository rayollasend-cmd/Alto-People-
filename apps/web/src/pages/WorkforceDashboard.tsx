import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Banknote,
  CalendarDays,
  ClipboardList,
  Inbox,
  Mail,
  Phone,
  Radio,
  ShieldAlert,
  Store,
  UserPlus,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate, fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The Workforce Manager's COMMAND CENTER — the engine room of the
 * company, structured the way the field actually is: stores.
 *
 *   COMMAND STRIP — one instrument row of global truth (floor count,
 *   stores needing you, unscheduled punches, fill, incidents, dispatch,
 *   tomorrow).
 *
 *   THE BOARD — every operationally-live store as a status tile,
 *   triage-sorted red → amber → green: its coverage bar, its problems
 *   as chips, its supervisors with one-tap call. The board itself says
 *   where to point.
 *
 *   LIVE WIRE — everything happening everywhere, newest first:
 *   no-shows, incidents, unscheduled punches. Plus the dispatch list.
 *
 * Polls every 60s. Every state has an explicit all-clear.
 */

interface StoreTile {
  clientId: string | null;
  clientName: string;
  onFloor: number;
  scheduledNow: number;
  openToday: number;
  unconfirmedTomorrow: number;
  openTomorrow: number;
  exceptionsToday: number;
  noShowsToday: number;
  incidentsToday: number;
  unscheduledNow: number;
  status: 'red' | 'amber' | 'green';
}

interface WireItem {
  type: 'exception' | 'incident' | 'unscheduled';
  kind: string | null;
  name: string | null;
  clientName: string | null;
  at: string;
}

interface WorkforceOverview {
  generatedAt: string;
  now: {
    onFloor: number;
    scheduledNow: number;
    people: Array<{ associateId: string; name: string }>;
    unscheduled: Array<{
      associateId: string;
      name: string;
      clientName: string | null;
      clockInAt: string;
    }>;
    unscheduledCount: number;
  };
  today: { filled: number; open: number; stores: StoreTile[] };
  exceptionsToday: { count: number; feed: unknown[] };
  tomorrow: { confirmed: number; unconfirmed: number; open: number };
  week: {
    start: string;
    fillRatePct: number | null;
    noCallNoShows: number;
    callOuts: number;
    lates: number;
  };
  incidentsToday: number;
  needsAttention: number;
  wire: WireItem[];
  close: {
    pendingApprovals: number;
    payday: { date: string; schedule: string } | null;
  };
  readyToSchedule: {
    count: number;
    rows: Array<{
      associateId: string;
      name: string;
      clientName: string | null;
      approvedAt: string | null;
    }>;
  };
  dispatch: {
    openNext48h: number;
    upcoming: Array<{
      shiftId: string;
      clientName: string;
      position: string;
      startsAt: string;
    }>;
  };
}

interface SupervisorRow {
  userId: string;
  role: 'SHIFT_SUPERVISOR' | 'FLOOR_SUPERVISOR';
  email: string;
  name: string;
  phone: string | null;
  associateId: string | null;
  clientId: string | null;
  clientName: string | null;
}

const STATUS_EDGE: Record<StoreTile['status'], string> = {
  red: 'border-l-alert',
  amber: 'border-l-warning',
  green: 'border-l-success/70',
};
const STATUS_DOT: Record<StoreTile['status'], string> = {
  red: 'bg-alert',
  amber: 'bg-warning',
  green: 'bg-success/80',
};

function greetKey(hour: number): MessageKey {
  if (hour < 12) return 'fin.morning';
  if (hour < 17) return 'fin.afternoon';
  return 'fin.evening';
}

export function WorkforceDashboard() {
  const { t } = useI18n();
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['workforce', 'overview'],
    queryFn: () => apiFetch<WorkforceOverview>('/workforce/overview'),
    refetchInterval: 60_000,
  });
  const supsQuery = useQuery({
    queryKey: ['workforce', 'supervisors'],
    queryFn: () =>
      apiFetch<{ supervisors: SupervisorRow[] }>('/workforce/supervisors'),
    staleTime: 5 * 60_000,
  });
  const data = query.data;
  const supsByClient = new Map<string, SupervisorRow[]>();
  for (const s of supsQuery.data?.supervisors ?? []) {
    if (!s.clientId) continue;
    const list = supsByClient.get(s.clientId) ?? [];
    list.push(s);
    supsByClient.set(s.clientId, list);
  }
  const firstName = user?.firstName || (user?.email?.split('@')[0] ?? '');

  if (query.isError) {
    return (
      <div className="mx-auto">
        <h1 className="font-display text-3xl text-white">{t('wf.title')}</h1>
        <ErrorBanner
          className="mt-4"
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('common.wentWrong')}
        </ErrorBanner>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-28" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-72 lg:col-span-2" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  const instruments: Array<{
    value: string;
    label: string;
    tone?: 'alert' | 'warning' | 'plain';
    to: string;
  }> = [
    {
      value: String(data.needsAttention),
      label: t('wf.instrNeeds'),
      tone: data.needsAttention > 0 ? 'alert' : 'plain',
      to: '/scheduling',
    },
    {
      value: String(data.now.unscheduledCount),
      label: t('wf.instrUnsched'),
      tone: data.now.unscheduledCount > 0 ? 'alert' : 'plain',
      to: '/time-attendance',
    },
    {
      value: data.week.fillRatePct !== null ? `${data.week.fillRatePct}%` : '—',
      label: t('wf.instrFill'),
      to: '/scheduling',
    },
    {
      value: String(data.incidentsToday),
      label: t('wf.instrIncidents'),
      tone: data.incidentsToday > 0 ? 'alert' : 'plain',
      to: '/compliance',
    },
    {
      value: String(data.dispatch.openNext48h),
      label: t('wf.instrOpen48'),
      tone: data.dispatch.openNext48h > 0 ? 'warning' : 'plain',
      to: '/marketplace',
    },
    {
      value: String(data.tomorrow.confirmed),
      label: t('wf.instrTomorrow'),
      to: '/scheduling',
    },
  ];

  return (
    <div className="mx-auto space-y-5">
      {/* ---- Greeting ------------------------------------------------- */}
      <div className="animate-enter">
        <h1 className="font-display text-3xl md:text-4xl text-white">
          {t(greetKey(new Date().getHours()))}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-silver">
          {t('wf.subtitle')}
          <span className="flex items-center gap-1.5 text-xs text-silver/60">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            {t('portal.live')}
          </span>
        </p>
      </div>

      {/* ---- Command strip: the instrument row -------------------------- */}
      <Card className="relative overflow-hidden border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]"
        />
        <CardContent className="relative p-5">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            <Link to="/time-attendance" className="group shrink-0">
              <div className="text-5xl md:text-6xl font-bold tracking-tight tabular-nums text-white group-hover:text-gold-bright transition-colors">
                {data.now.onFloor}
                <span className="ml-2 align-middle text-base font-normal text-silver">
                  / {data.now.scheduledNow}
                </span>
              </div>
              <div className="mt-1 text-sm text-silver">{t('wf.instrFloor')}</div>
            </Link>
            <div
              aria-hidden="true"
              className="hidden h-12 w-px bg-navy-secondary sm:block"
            />
            <div className="grid flex-1 grid-cols-3 gap-x-6 gap-y-3 sm:grid-cols-6">
              {instruments.map((ins) => (
                <Link key={ins.label} to={ins.to} className="group min-w-0">
                  <div
                    className={cn(
                      'text-2xl font-bold tracking-tight tabular-nums transition-colors',
                      ins.tone === 'alert'
                        ? 'text-alert'
                        : ins.tone === 'warning'
                          ? 'text-warning'
                          : 'text-white group-hover:text-gold-bright',
                    )}
                  >
                    {ins.value}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-silver/70">
                    {ins.label}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ---- THE BOARD ---------------------------------------------- */}
        <div className="lg:col-span-2">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <Store className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('wf.board')}
            </h2>
            <span
              className={cn(
                'text-xs tabular-nums',
                data.needsAttention > 0 ? 'text-alert' : 'text-success',
              )}
            >
              {data.needsAttention > 0
                ? t('wf.needsYou', { count: data.needsAttention })
                : t('wf.allGreenBoard')}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.today.stores.map((s, i) => {
              const sups = s.clientId ? supsByClient.get(s.clientId) ?? [] : [];
              const chips: Array<{ text: string; cls: string }> = [
                s.noShowsToday > 0 && {
                  text: t('wf.tileNoShows', { count: s.noShowsToday }),
                  cls: 'bg-alert/15 text-alert',
                },
                s.incidentsToday > 0 && {
                  text: t('wf.tileIncidents', { count: s.incidentsToday }),
                  cls: 'bg-alert/15 text-alert',
                },
                s.unscheduledNow > 0 && {
                  text: t('wf.tileUnsched', { count: s.unscheduledNow }),
                  cls: 'bg-alert/15 text-alert',
                },
                s.openToday > 0 && {
                  text: t('wf.storeOpen', { count: s.openToday }),
                  cls: 'bg-warning/15 text-warning',
                },
                s.unconfirmedTomorrow > 0 && {
                  text: t('wf.tileUnconf', { count: s.unconfirmedTomorrow }),
                  cls: 'bg-warning/15 text-warning',
                },
              ].filter(Boolean) as Array<{ text: string; cls: string }>;
              const pct =
                s.scheduledNow > 0
                  ? Math.min(100, (s.onFloor / s.scheduledNow) * 100)
                  : s.onFloor > 0
                    ? 100
                    : 0;
              return (
                <Card
                  key={s.clientName}
                  className={cn(
                    'animate-enter border-l-2',
                    STATUS_EDGE[s.status],
                  )}
                  style={enterStagger(i, 40, 8)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-white">
                        {s.clientName}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-silver">
                        <span
                          aria-hidden="true"
                          className={cn('h-2 w-2 rounded-full', STATUS_DOT[s.status])}
                        />
                        {t('wf.storeNow', { on: s.onFloor, sched: s.scheduledNow })}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-navy-secondary/50">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          s.onFloor < s.scheduledNow ? 'bg-warning/80' : 'bg-success/70',
                        )}
                        style={{ width: `${Math.max(4, pct)}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {chips.length === 0 ? (
                        <span className="text-xs text-success">{t('wf.tileQuiet')}</span>
                      ) : (
                        chips.map((c) => (
                          <span
                            key={c.text}
                            className={cn(
                              'rounded-full px-2 py-0.5 text-2xs font-medium tabular-nums',
                              c.cls,
                            )}
                          >
                            {c.text}
                          </span>
                        ))
                      )}
                    </div>
                    {sups.length > 0 && (
                      <div className="mt-3 space-y-1.5 border-t border-navy-secondary/60 pt-2.5">
                        {sups.slice(0, 3).map((sup) => (
                          <div key={sup.userId} className="flex items-center gap-2">
                            <Avatar
                              src={
                                sup.associateId
                                  ? `/api/associates/${sup.associateId}/photo`
                                  : null
                              }
                              name={sup.name}
                              email={sup.email}
                              size="xs"
                            />
                            <span className="min-w-0 flex-1 truncate text-xs text-silver">
                              {sup.name}
                              <span className="text-silver/50">
                                {' '}· {t(
                                  sup.role === 'SHIFT_SUPERVISOR'
                                    ? 'wf.roleShift'
                                    : 'wf.roleFloor',
                                )}
                              </span>
                            </span>
                            {sup.phone && (
                              <a
                                href={`tel:${sup.phone}`}
                                aria-label={`${t('me.mgr.call')} ${sup.name}`}
                                className="grid h-7 w-7 shrink-0 place-items-center rounded text-silver/70 transition-colors hover:text-gold"
                              >
                                <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                              </a>
                            )}
                            <a
                              href={`mailto:${sup.email}`}
                              aria-label={`${t('me.mgr.email')} ${sup.name}`}
                              className="grid h-7 w-7 shrink-0 place-items-center rounded text-silver/70 transition-colors hover:text-gold"
                            >
                              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* ---- Ready to schedule: the HR → field baton ---------------- */}
          <Card
            className={cn(
              'mt-3 animate-enter',
              data.readyToSchedule.count > 0 && 'border-gold/30',
            )}
            style={enterStagger(4)}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                  <UserPlus className="h-4 w-4 text-gold" aria-hidden="true" />
                  {t('wf.readyTitle')}
                </h2>
                {data.readyToSchedule.count > 0 && (
                  <Link
                    to="/scheduling"
                    className="inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-9"
                  >
                    {t('wf.goScheduling')}
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                )}
              </div>
              {data.readyToSchedule.count === 0 ? (
                <p className="mt-2 text-sm text-success">{t('wf.readyNone')}</p>
              ) : (
                <ul className="mt-2 divide-y divide-navy-secondary/60">
                  {data.readyToSchedule.rows.map((r) => (
                    <li
                      key={r.associateId}
                      className="flex items-center gap-2 py-2 text-xs"
                    >
                      <Link
                        to={`/people?associateId=${r.associateId}&return=${encodeURIComponent('/')}`}
                        className="min-w-0 flex-1 truncate font-medium text-white hover:text-gold-bright"
                      >
                        {r.name}
                      </Link>
                      {r.clientName && (
                        <span className="truncate text-silver/60">{r.clientName}</span>
                      )}
                      {r.approvedAt && (
                        <span className="shrink-0 tabular-nums text-silver/40">
                          {t('wf.readyApproved', { date: fmtDate(r.approvedAt) })}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ---- LIVE WIRE + dispatch ------------------------------------ */}
        <div className="space-y-4">
          <Card className="animate-enter" style={enterStagger(2)}>
            <CardContent className="p-4">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <Radio className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('wf.wire')}
              </h2>
              {data.wire.length === 0 ? (
                <p className="mt-3 text-sm text-success">{t('wf.wireQuiet')}</p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {data.wire.map((w, i) => (
                    <li key={`${w.type}-${w.at}-${i}`} className="flex gap-2.5 text-xs">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'mt-1 h-2 w-2 shrink-0 rounded-full',
                          w.type === 'incident' || w.kind === 'NO_CALL_NO_SHOW' || w.type === 'unscheduled'
                            ? 'bg-alert'
                            : 'bg-warning',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-white">
                          {w.type === 'incident'
                            ? t('wf.incidentWord')
                            : w.type === 'unscheduled'
                              ? t('wf.unschedPunch')
                              : t(`wf.kind.${w.kind}` as MessageKey)}
                        </span>
                        {w.name && <span className="text-silver"> — {w.name}</span>}
                        {w.clientName && (
                          <span className="text-silver/60"> · {w.clientName}</span>
                        )}
                        <span className="text-silver/40 tabular-nums"> · {fmtTime(w.at)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ---- Payroll close: the field → Finance baton --------------- */}
          <Card
            className={cn(
              'animate-enter',
              data.close.pendingApprovals > 0 && 'border-warning/30',
            )}
            style={enterStagger(3)}
          >
            <CardContent className="p-4">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <Banknote className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('wf.closeTitle')}
              </h2>
              {data.close.pendingApprovals === 0 ? (
                <p className="mt-2 text-sm text-success">{t('wf.closeClear')}</p>
              ) : (
                <p className="mt-2 text-sm text-warning tabular-nums">
                  {t('wf.closePending', { count: data.close.pendingApprovals })}
                </p>
              )}
              <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
                {data.close.payday ? (
                  <span className="tabular-nums text-silver/60">
                    {t('wf.closePayday', { date: fmtDate(data.close.payday.date) })}
                  </span>
                ) : (
                  <span />
                )}
                {data.close.pendingApprovals > 0 && (
                  <Link
                    to="/time-attendance"
                    className="inline-flex items-center gap-1 text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-9"
                  >
                    {t('wf.goLive')}
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>

          <Card
            className={cn(
              'animate-enter',
              data.dispatch.openNext48h > 0 && 'border-warning/30',
            )}
            style={enterStagger(4)}
          >
            <CardContent className="p-4">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <Inbox className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('wf.dispatchTitle')}
              </h2>
              {data.dispatch.upcoming.length === 0 ? (
                <p className="mt-3 text-sm text-success">{t('wf.dispatchNone')}</p>
              ) : (
                <>
                  <ul className="mt-3 divide-y divide-navy-secondary/60">
                    {data.dispatch.upcoming.map((s) => (
                      <li key={s.shiftId} className="py-2 text-xs">
                        <span className="font-medium text-white tabular-nums">
                          {fmtDate(s.startsAt)}, {fmtTime(s.startsAt)}
                        </span>
                        <span className="text-silver"> — {s.position}</span>
                        <span className="text-silver/60"> · {s.clientName}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/marketplace"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-9"
                  >
                    {t('wf.goMarketplace')}
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ---- The six doors --------------------------------------------- */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6 md:gap-3">
        {(
          [
            ['/scheduling', 'wf.goScheduling', CalendarDays],
            ['/approvals', 'wf.goApprovals', Inbox],
            ['/time-attendance', 'wf.goLive', Radio],
            ['/ops', 'wf.goOps', ClipboardList],
            ['/marketplace', 'wf.goMarketplace', Store],
            ['/compliance', 'wf.goIncidents', ShieldAlert],
          ] as const
        ).map(([to, key, Icon]) => (
          <Link
            key={to}
            to={to}
            className="group flex min-h-12 items-center gap-2 rounded-md border border-navy-secondary bg-navy px-3 py-3 text-sm text-white transition-colors hover:border-gold/50 hover:bg-navy/80 active:border-gold/50 active:bg-navy-secondary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Icon
              className="h-4 w-4 text-silver transition-colors group-hover:text-gold"
              aria-hidden="true"
            />
            <span className="flex-1 truncate">{t(key)}</span>
            <ArrowRight
              className="h-3.5 w-3.5 text-silver/70 transition-colors group-hover:text-gold"
              aria-hidden="true"
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
