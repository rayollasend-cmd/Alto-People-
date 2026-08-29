import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  ClipboardList,
  DoorOpen,
  Flag,
  Thermometer,
  Users,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { CountUpValue } from '@/components/ui/MetricCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  getOpsBoard,
  getOpsFeed,
  getOpsScorecard,
  opsPhotoUrl,
  type OpsFeedEvent,
  type OpsShiftHeader,
} from '@/lib/opsApi';

/**
 * The operations command center — presence in every store without being
 * in any of them. A live headline band, per-store mission tiles with
 * progress rings, the floor feed (completions, temps, photos ticking in),
 * a photo wall, and the rolling scorecard. Refreshes itself every 30s.
 */

const PERIOD_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  EVENING: 'Evening',
  CLOSING: 'Closing',
  OVERNIGHT: 'Overnight',
};

type BoardShift = OpsShiftHeader & { clientName: string; openedByEmail: string };

/* Cached relative-time formatter (toLocale* is lint-banned). */
const REL_FMT = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
function relTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return REL_FMT.format(-mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 24) return REL_FMT.format(-hours, 'hour');
  return REL_FMT.format(-Math.round(hours / 24), 'day');
}

/** SVG completion ring — the tile's heartbeat. */
function ProgressRing({ pct, alert }: { pct: number; alert: boolean }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16 shrink-0" aria-hidden="true">
      <circle cx="32" cy="32" r={r} fill="none" strokeWidth="5" className="stroke-navy-secondary" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        transform="rotate(-90 32 32)"
        className={cn(
          'transition-all duration-700',
          alert ? 'stroke-alert' : pct >= 80 ? 'stroke-success' : 'stroke-gold',
        )}
      />
      <text
        x="32"
        y="36"
        textAnchor="middle"
        className={cn(
          'fill-white text-[13px] font-semibold tabular-nums',
        )}
      >
        {pct}%
      </text>
    </svg>
  );
}

const FEED_ICON: Record<OpsFeedEvent['kind'], typeof Activity> = {
  task: CheckCircle2,
  temp: Thermometer,
  photo: Camera,
  open: DoorOpen,
  close: Flag,
};

export function OpsBoard() {
  const [board, setBoard] = useState<{
    dateKey: string;
    active: BoardShift[];
    closedToday: BoardShift[];
  } | null>(null);
  const [feed, setFeed] = useState<Awaited<ReturnType<typeof getOpsFeed>> | null>(null);
  const [scorecard, setScorecard] = useState<Awaited<
    ReturnType<typeof getOpsScorecard>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getOpsBoard()
        .then((b) => {
          if (!cancelled) setBoard(b);
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof ApiError ? err.message : 'Could not load the board.');
          }
        });
      getOpsFeed()
        .then((f) => {
          if (!cancelled) setFeed(f);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30_000);
    getOpsScorecard(4)
      .then((s) => {
        if (!cancelled) setScorecard(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const headline = useMemo(() => {
    if (!board) return null;
    const all = [...board.active, ...board.closedToday];
    const floor = board.active.reduce((n, s) => n + s.actualHeadcount, 0);
    const tempAlerts = all.reduce((n, s) => n + s.tempAlerts, 0);
    const sopDone = all.reduce((n, s) => n + s.taskDone, 0);
    const sopTotal = all.reduce((n, s) => n + s.taskTotal, 0);
    const stores = new Set(all.map((s) => s.clientName)).size;
    return {
      live: board.active.length,
      floor,
      stores,
      tempAlerts,
      sopPct: sopTotal > 0 ? Math.round((sopDone / sopTotal) * 100) : null,
      incomplete: board.closedToday.filter((s) => s.closedIncomplete).length,
    };
  }, [board]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!board || !headline) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-4">
      {/* ===== Headline band — the six numbers that ARE the floor ===== */}
      <div className="relative overflow-hidden rounded-lg border border-navy-secondary bg-gradient-to-br from-navy-secondary/60 via-navy to-navy p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-gold/10 blur-3xl"
        />
        <div className="relative flex flex-wrap items-center gap-x-8 gap-y-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span
                  className={cn(
                    'absolute inline-flex h-full w-full rounded-full opacity-60',
                    headline.live > 0 ? 'animate-ping bg-success' : 'bg-silver/40',
                  )}
                />
                <span
                  className={cn(
                    'relative inline-flex h-2.5 w-2.5 rounded-full',
                    headline.live > 0 ? 'bg-success' : 'bg-silver/40',
                  )}
                />
              </span>
              <span className="text-2xs uppercase tracking-[0.2em] text-gold">
                Floor command · {board.dateKey}
              </span>
            </div>
            <div className="mt-1 text-xl font-medium text-white">
              {headline.live > 0
                ? `${headline.live} shift${headline.live === 1 ? '' : 's'} running across ${headline.stores} store${headline.stores === 1 ? '' : 's'}`
                : 'All floors quiet'}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-8 gap-y-3">
            <HeadlineStat
              label="On the floor"
              value={<CountUpValue value={headline.floor} />}
              icon={Users}
              tone="text-white"
            />
            <HeadlineStat
              label="SOP today"
              value={headline.sopPct == null ? '—' : <CountUpValue value={`${headline.sopPct}%`} />}
              icon={ClipboardList}
              tone={
                headline.sopPct == null
                  ? 'text-silver'
                  : headline.sopPct >= 80
                    ? 'text-success'
                    : 'text-warning'
              }
            />
            <HeadlineStat
              label="Temp alerts"
              value={<CountUpValue value={headline.tempAlerts} />}
              icon={Thermometer}
              tone={headline.tempAlerts > 0 ? 'text-alert' : 'text-success'}
            />
            <HeadlineStat
              label="Incomplete closes"
              value={<CountUpValue value={headline.incomplete} />}
              icon={Flag}
              tone={headline.incomplete > 0 ? 'text-warning' : 'text-success'}
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4 min-w-0">
          {/* ===== Live mission tiles ===== */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Live now</CardTitle>
            </CardHeader>
            <CardContent>
              {board.active.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title="No ops shifts running right now"
                  description="Supervisors open their shift from Store Ops when they start — it will appear here the moment they do."
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {board.active.map((s) => {
                    const pct =
                      s.taskTotal > 0 ? Math.round((s.taskDone / s.taskTotal) * 100) : 0;
                    return (
                      <div
                        key={s.id}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border bg-navy-secondary/20 p-3.5 transition-colors',
                          s.tempAlerts > 0
                            ? 'border-alert/60 bg-alert/[0.06]'
                            : 'border-navy-secondary hover:border-gold/30',
                        )}
                      >
                        <ProgressRing pct={pct} alert={s.tempAlerts > 0} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-white">
                            {s.department}
                            <span className="ml-1.5 text-xs font-normal text-gold">
                              {PERIOD_LABEL[s.period]}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-silver">
                            {s.clientName}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs tabular-nums text-silver/80">
                            <span className="inline-flex items-center gap-1">
                              <Users className="h-3 w-3 text-gold" aria-hidden="true" />
                              {s.actualHeadcount}/{s.scheduledHeadcount}
                            </span>
                            <span>
                              {s.taskDone}/{s.taskTotal} tasks
                            </span>
                            {s.tempAlerts > 0 && (
                              <span className="inline-flex items-center gap-1 text-alert">
                                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                                {s.tempAlerts} temp
                              </span>
                            )}
                          </div>
                          <div className="mt-1 truncate text-2xs text-silver/50">
                            {s.openedByEmail} · opened {relTime(s.openedAt)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ===== Photo wall ===== */}
          {feed && feed.photos.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  From the floor
                  <span className="ml-2 text-xs font-normal text-silver/60">
                    latest photos, straight off the aisles
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2.5 overflow-x-auto pb-1">
                  {feed.photos.map((p) => (
                    <a
                      key={p.id}
                      href={opsPhotoUrl(p.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="group relative block h-32 w-44 shrink-0 overflow-hidden rounded-lg border border-navy-secondary"
                      title={`${p.title} — ${p.store}`}
                    >
                      <img
                        src={opsPhotoUrl(p.id)}
                        alt={p.title}
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-navy/95 to-transparent p-2">
                        <div className="truncate text-2xs font-medium text-white">
                          {p.department} · {p.store}
                        </div>
                        <div className="truncate text-2xs text-silver/70">
                          {p.title} · {relTime(p.at)}
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ===== Closed today ===== */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Closed today</CardTitle>
            </CardHeader>
            <CardContent>
              {board.closedToday.length === 0 ? (
                <p className="text-sm text-silver">Nothing closed yet today.</p>
              ) : (
                <ul className="divide-y divide-navy-secondary/60">
                  {board.closedToday.map((s) => (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="text-sm text-white">
                          {s.department}
                          <span className="ml-1.5 text-xs text-gold">
                            {PERIOD_LABEL[s.period]}
                          </span>
                          <span className="ml-2 text-xs text-silver/70">{s.clientName}</span>
                        </div>
                        {s.closingSummary && (
                          <div className="mt-0.5 max-w-prose truncate text-xs italic text-silver/70">
                            “{s.closingSummary}”
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
                        <span className="text-silver">
                          SOP <span className="text-white">{s.sopDone}</span>/{s.sopTotal}
                        </span>
                        {s.tempAlerts > 0 && (
                          <Badge variant="destructive">{s.tempAlerts} temp</Badge>
                        )}
                        {s.closedIncomplete ? (
                          <Badge variant="destructive">incomplete</Badge>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-success">
                            <CheckCircle2 className="h-3.5 w-3.5" /> complete
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ===== Scorecard ===== */}
          {scorecard && scorecard.rows.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Standards — last {scorecard.weeks} weeks
                  <span className="ml-2 text-xs font-normal text-silver/60 tabular-nums">
                    {scorecard.totals.shifts} shifts · {scorecard.totals.tempChecks} temp checks
                    · {scorecard.totals.handoverCarried}/{scorecard.totals.handoverCreated}{' '}
                    handovers carried
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {scorecard.rows.map((r) => (
                    <div
                      key={`${r.clientName}|${r.department}`}
                      className="flex items-center gap-3"
                    >
                      <div className="w-56 min-w-0 shrink-0">
                        <div className="truncate text-sm text-white">{r.department}</div>
                        <div className="truncate text-2xs text-silver/60">{r.clientName}</div>
                      </div>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-navy-secondary">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all duration-700',
                            (r.sopPct ?? 0) >= 90
                              ? 'bg-success'
                              : (r.sopPct ?? 0) >= 70
                                ? 'bg-gold'
                                : 'bg-alert',
                          )}
                          style={{ width: `${r.sopPct ?? 0}%` }}
                        />
                      </div>
                      <div
                        className={cn(
                          'w-12 shrink-0 text-right text-sm tabular-nums',
                          r.sopPct == null
                            ? 'text-silver/50'
                            : r.sopPct >= 90
                              ? 'text-success'
                              : r.sopPct >= 70
                                ? 'text-warning'
                                : 'text-alert',
                        )}
                      >
                        {r.sopPct == null ? '—' : `${r.sopPct}%`}
                      </div>
                      <div className="w-24 shrink-0 text-right text-2xs tabular-nums text-silver/60">
                        {r.shifts} shifts
                        {r.tempAlerts > 0 && (
                          <span className="ml-1 text-alert">· {r.tempAlerts}⚠</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ===== The floor feed — presence itself ===== */}
        <Card className="xl:sticky xl:top-4 xl:self-start">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              <Activity className="mr-1.5 inline h-4 w-4 text-gold" aria-hidden="true" />
              Floor feed
              <span className="ml-2 text-2xs font-normal uppercase tracking-wider text-silver/50">
                live · 30s refresh
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!feed || feed.events.length === 0 ? (
              <p className="text-sm text-silver">
                Quiet — events appear here the moment a supervisor records them.
              </p>
            ) : (
              <ul className="relative space-y-0 max-h-[560px] overflow-y-auto pr-1">
                {feed.events.map((e, i) => {
                  const Icon = FEED_ICON[e.kind];
                  return (
                    <li key={`${e.at}-${i}`} className="relative flex gap-3 pb-4">
                      {/* Timeline spine */}
                      {i < feed.events.length - 1 && (
                        <span
                          aria-hidden
                          className="absolute left-[11px] top-6 h-full w-px bg-navy-secondary"
                        />
                      )}
                      <span
                        className={cn(
                          'relative z-[1] mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border',
                          e.alert
                            ? 'border-alert/60 bg-alert/15 text-alert'
                            : e.kind === 'photo'
                              ? 'border-sky/40 bg-sky/10 text-sky'
                              : e.kind === 'temp'
                                ? 'border-teal/40 bg-teal/10 text-teal'
                                : 'border-navy-secondary bg-navy-secondary/40 text-silver/70',
                        )}
                      >
                        <Icon className="h-3 w-3" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-xs font-medium text-white">
                            {e.headline}
                          </span>
                          <span className="shrink-0 text-2xs tabular-nums text-silver/50">
                            {relTime(e.at)}
                          </span>
                        </div>
                        <div className="truncate text-2xs text-silver/60">
                          {e.department} · {e.store}
                          {e.detail && (
                            <span className={cn(e.alert && 'text-alert')}> · {e.detail}</span>
                          )}
                        </div>
                        {e.photoId && (
                          <a
                            href={opsPhotoUrl(e.photoId)}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 block h-16 w-24 overflow-hidden rounded border border-navy-secondary"
                          >
                            <img
                              src={opsPhotoUrl(e.photoId)}
                              alt={e.headline}
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          </a>
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
    </div>
  );
}

function HeadlineStat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  icon: typeof Users;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-md border border-navy-secondary bg-navy/60">
        <Icon className="h-4 w-4 text-gold" aria-hidden="true" />
      </span>
      <div>
        <div className={cn('text-xl font-semibold leading-none tabular-nums', tone)}>
          {value}
        </div>
        <div className="mt-1 text-2xs uppercase tracking-wider text-silver/60">{label}</div>
      </div>
    </div>
  );
}
