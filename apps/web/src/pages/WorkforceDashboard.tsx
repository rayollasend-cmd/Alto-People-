import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarDays,
  ClipboardList,
  Inbox,
  Radio,
  ShieldAlert,
  Store,
  UserX,
  Users,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { Card, CardContent } from '@/components/ui/Card';
import { CountUpValue } from '@/components/ui/MetricCard';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The Workforce Manager's field cockpit — the corporate connection to
 * the store floor, in the owner's charter language:
 *
 *   ON THE FLOOR NOW (hero) → PRE-SHIFT CHECK (unscheduled punches, by
 *   name — "go home before clock-in") → the four field counters (fill /
 *   exceptions / incidents / dispatch) → today's coverage gaps by store
 *   → tomorrow's headcount → the six doors the day walks through.
 *
 * "Silence means green": every card has an explicit all-clear state.
 */

interface WorkforceOverview {
  generatedAt: string;
  now: {
    onFloor: number;
    scheduledNow: number;
    unscheduled: Array<{
      associateId: string;
      name: string;
      clientName: string | null;
      clockInAt: string;
    }>;
    unscheduledCount: number;
  };
  today: {
    filled: number;
    open: number;
    gaps: Array<{ clientName: string; open: number; filled: number }>;
  };
  tomorrow: { confirmed: number; unconfirmed: number; open: number };
  week: {
    start: string;
    fillRatePct: number | null;
    noCallNoShows: number;
    callOuts: number;
    lates: number;
  };
  incidentsToday: number;
  dispatch: { openNext48h: number };
}

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
  const data = query.data;
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
        <Skeleton className="h-40" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28 hidden lg:block" />
          <Skeleton className="h-28 hidden lg:block" />
        </div>
      </div>
    );
  }

  const preShiftHot = data.now.unscheduledCount > 0;
  const exceptions =
    data.week.noCallNoShows + data.week.callOuts + data.week.lates;

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

      {/* ---- The floor now -------------------------------------------- */}
      <Link to="/time-attendance" className="block group">
        <Card className="relative overflow-hidden border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter transition-colors group-hover:border-gold/50">
          <div
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-0',
              data.now.onFloor > 0
                ? 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-success)/0.14),transparent_55%)]'
                : 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]',
            )}
          />
          <CardContent className="relative p-5">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.onFloorNow')}
            </span>
            <div className="mt-2 text-5xl md:text-6xl font-bold tracking-tight tabular-nums text-white">
              {data.now.onFloor}
            </div>
            <p className="mt-1.5 text-sm text-silver tabular-nums">
              {data.now.scheduledNow > 0
                ? t('portal.onOfSched', {
                    on: data.now.onFloor,
                    sched: data.now.scheduledNow,
                  })
                : data.now.onFloor > 0
                  ? t('portal.onPlain', { on: data.now.onFloor })
                  : t('portal.nobodyNow')}
            </p>
          </CardContent>
        </Card>
      </Link>

      {/* ---- Pre-shift check ------------------------------------------ */}
      <Card
        className={cn('animate-enter', preShiftHot && 'border-alert/40')}
        style={enterStagger(1)}
      >
        <CardContent className="p-5">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
            <UserX
              className={cn('h-4 w-4', preShiftHot ? 'text-alert' : 'text-gold')}
              aria-hidden="true"
            />
            {t('wf.preShift')}
          </h2>
          {preShiftHot ? (
            <>
              <p className="mt-1 text-sm font-medium text-alert tabular-nums">
                {t('wf.preShiftAlert', { count: data.now.unscheduledCount })}
              </p>
              <ul className="mt-2 divide-y divide-navy-secondary/60">
                {data.now.unscheduled.map((p) => (
                  <li key={p.associateId} className="flex items-center gap-3 py-2">
                    <Avatar
                      src={`/api/associates/${p.associateId}/photo`}
                      name={p.name}
                      email=""
                      size="sm"
                    />
                    <Link
                      to={`/people?associateId=${p.associateId}&return=${encodeURIComponent('/')}`}
                      className="min-w-0 flex-1 truncate text-sm text-white hover:text-gold"
                    >
                      {p.name}
                      {p.clientName && (
                        <span className="text-silver/80"> · {p.clientName}</span>
                      )}
                    </Link>
                    <span className="shrink-0 text-xs text-silver tabular-nums">
                      {t('wf.preShiftSince', { time: fmtTime(p.clockInAt) })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-3 text-sm text-success">{t('wf.preShiftClean')}</p>
          )}
        </CardContent>
      </Card>

      {/* ---- The four field counters ----------------------------------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <WfKpi
          to="/scheduling"
          label={t('wf.kpiFill')}
          value={data.week.fillRatePct !== null ? `${data.week.fillRatePct}%` : '—'}
          stagger={2}
        />
        <WfKpi
          to="/time-attendance"
          label={t('wf.kpiExceptions')}
          value={String(exceptions)}
          hot={exceptions > 0}
          hint={
            exceptions > 0
              ? t('wf.excBreakdown', {
                  ns: data.week.noCallNoShows,
                  co: data.week.callOuts,
                  late: data.week.lates,
                })
              : t('wf.silenceGreen')
          }
          stagger={3}
        />
        <WfKpi
          to="/compliance"
          label={t('wf.kpiIncidents')}
          value={String(data.incidentsToday)}
          hot={data.incidentsToday > 0}
          hotTone="alert"
          stagger={4}
        />
        <WfKpi
          to="/marketplace"
          label={t('wf.kpiDispatch')}
          value={String(data.dispatch.openNext48h)}
          hot={data.dispatch.openNext48h > 0}
          stagger={5}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ---- Today's coverage gaps ---------------------------------- */}
        <Card
          className={cn('animate-enter', data.today.open > 0 && 'border-warning/30')}
          style={enterStagger(6)}
        >
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <Store className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('wf.gaps')}
            </h2>
            {data.today.gaps.length === 0 ? (
              <p className="mt-3 text-sm text-success">{t('wf.gapsClean')}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.today.gaps.map((g) => (
                  <li
                    key={g.clientName}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span className="truncate text-white">{g.clientName}</span>
                    <span className="shrink-0 tabular-nums">
                      <span className="font-semibold text-alert">{g.open}</span>
                      <span className="text-silver/60">
                        {' '}· {t('wf.gapLine', { open: g.open, filled: g.filled })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ---- Tomorrow ------------------------------------------------ */}
        <Card className="animate-enter" style={enterStagger(7)}>
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <CalendarDays className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('portal.tomorrow')}
            </h2>
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
                data.tomorrow.open > 0 &&
                  t('portal.openCount', { count: data.tomorrow.open }),
              ]
                .filter(Boolean)
                .join(' · ') || t('wf.gapsClean')}
            </p>
          </CardContent>
        </Card>
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

/** Same gold-rail KPI tile grammar as the finance cockpit. */
function WfKpi({
  to,
  label,
  value,
  hint,
  hot = false,
  hotTone = 'warning',
  stagger,
}: {
  to: string;
  label: string;
  value: string;
  hint?: string;
  hot?: boolean;
  hotTone?: 'warning' | 'alert';
  stagger: number;
}) {
  return (
    <Link to={to} className="group block" style={enterStagger(stagger)}>
      <Card
        interactive
        className="h-full animate-enter border-l-2 border-l-gold/40 transition-colors group-hover:border-l-gold"
      >
        <CardContent className="pt-5">
          <div className="text-2xs font-medium uppercase tracking-[0.14em] text-silver/70">
            {label}
          </div>
          <div
            className={cn(
              'mt-3 font-display text-3xl leading-none tabular-nums',
              hot
                ? hotTone === 'alert'
                  ? 'text-alert'
                  : 'text-warning'
                : 'text-gold-bright',
            )}
          >
            <CountUpValue value={value} />
          </div>
          {hint && (
            <div className="mt-2 truncate text-xs text-silver">{hint}</div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
