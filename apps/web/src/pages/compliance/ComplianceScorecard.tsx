import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  DollarSign,
  ExternalLink,
  GraduationCap,
  Info,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  WifiOff,
} from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui';
import type {
  ScorecardOnboardingSignal,
  ScorecardSeverity,
  ScorecardTrainingSignal,
} from '@alto-people/shared';
import {
  getScorecardActions,
  getScorecardBilling,
  getScorecardExpirations,
  getScorecardOnboarding,
  getScorecardShifts,
  getScorecardTraining,
} from '@/lib/complianceScorecardApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// Shared fetch hook for tiles. Two behaviors that matter:
//   1. First load shows a skeleton; subsequent refreshes keep the previous
//      data on screen so the page doesn't flash empty when nothing changed.
//   2. If a refresh fails *after* a successful first load, we surface a
//      "stale" badge instead of throwing the user back to an error state.
//      They keep the last-good numbers and can retry from the header.
function useTileData<T>(
  fetcher: () => Promise<T>,
  refreshEpoch: number,
): { data: T | null; error: string | null; stale: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const isFirst = data === null;
    if (isFirst) setError(null);
    let cancelled = false;
    fetcher()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
        setStale(false);
      })
      .catch((e) => {
        if (cancelled) return;
        if (isFirst) {
          setError(e instanceof ApiError ? e.message : 'Failed to load.');
        } else {
          setStale(true);
        }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshEpoch]);

  return { data, error, stale };
}

const SEVERITY_BADGE: Record<ScorecardSeverity, { variant: 'success' | 'pending' | 'destructive'; label: string }> = {
  ok: { variant: 'success', label: 'OK' },
  warn: { variant: 'pending', label: 'Warn' },
  critical: { variant: 'destructive', label: 'Critical' },
};

const SEVERITY_RING: Record<ScorecardSeverity, string> = {
  ok: 'border-success/50',
  warn: 'border-warning/50',
  critical: 'border-alert/60',
};

export function ComplianceScorecard() {
  // A single epoch ticks every 15 min (or when the user clicks Refresh) and
  // every tile re-fetches off it. Beats wiring 6 separate timers.
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(new Date());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      setRefreshEpoch((n) => n + 1);
      setLastRefreshedAt(new Date());
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setRefreshEpoch((n) => n + 1);
    setLastRefreshedAt(new Date());
    // Spinner is purely visual; the tiles each manage their own loading.
    // 600ms is enough to register the click without leaving the icon
    // spinning if a tile finishes faster than the eye can catch.
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-4">
        <HeroStrip
          refreshEpoch={refreshEpoch}
          lastRefreshedAt={lastRefreshedAt}
          refreshing={refreshing}
          onRefresh={refresh}
        />

        {/* Tile 1 — promoted to full-width hero. Most important tile per spec. */}
        <OnboardingTile refreshEpoch={refreshEpoch} />

        {/* Expirations + Training: time-bound items. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ExpirationsTile refreshEpoch={refreshEpoch} />
          <TrainingTile refreshEpoch={refreshEpoch} />
        </div>

        {/* Operational + financial. Both have heavy "coming soon" content
            until the schema catches up — pairing them keeps the visual
            weight balanced. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ShiftsTile refreshEpoch={refreshEpoch} />
          <BillingTile refreshEpoch={refreshEpoch} />
        </div>

        <ActionsTile refreshEpoch={refreshEpoch} />
      </div>
    </TooltipProvider>
  );
}

/* ----------------------------------------------------------------- */
/* Hero strip — page header + at-a-glance KPIs + refresh control.    */
/* Combines what used to be separate header + critical banner. The   */
/* critical count is the first thing the user sees, in red, so the   */
/* "is anything on fire?" question is answered without scrolling.    */
/* ----------------------------------------------------------------- */

function HeroStrip({
  refreshEpoch,
  lastRefreshedAt,
  refreshing,
  onRefresh,
}: {
  refreshEpoch: number;
  lastRefreshedAt: Date;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { data } = useTileData(getScorecardActions, refreshEpoch);
  const critical = data?.criticalCount ?? 0;
  const warn = data?.warnCount ?? 0;
  const totalActions = critical + warn;

  return (
    <Card className={cn('border', critical > 0 ? 'border-alert/60' : 'border-navy-secondary')}>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex-1 min-w-[260px]">
            <h1 className="font-display text-xl text-white flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-gold" />
              Walmart Contract Compliance Scorecard
            </h1>
            <p className="text-xs text-silver mt-0.5">
              Live state against Walmart MSA / SOW / MTSA. Auto-refreshes every 15 minutes.
            </p>
          </div>

          <div className="flex items-center gap-5">
            <KpiNumber
              label="Critical"
              value={critical}
              tone={critical > 0 ? 'text-alert' : 'text-silver'}
              icon={critical > 0 ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
            />
            <KpiNumber
              label="Warn"
              value={warn}
              tone={warn > 0 ? 'text-warning' : 'text-silver'}
            />
            <KpiNumber
              label="Open actions"
              value={totalActions}
              tone="text-white"
            />
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <span className="text-[11px] text-silver tabular-nums">
              Updated {fmtTimeAgo(lastRefreshedAt)}
            </span>
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function KpiNumber({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="text-center">
      <div className={cn('text-2xl font-bold tabular-nums flex items-center justify-center gap-1.5', tone)}>
        {icon}
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-widest text-silver/80 mt-0.5">{label}</div>
    </div>
  );
}

/* ----------------------------- TILE 1 ----------------------------- */

function OnboardingTile({ refreshEpoch }: { refreshEpoch: number }) {
  const { data, error, stale } = useTileData(getScorecardOnboarding, refreshEpoch);
  const [drawerSignal, setDrawerSignal] = useState<ScorecardOnboardingSignal | null>(null);

  // Empty population — there's nothing to score yet.
  if (data && data.activeAssociateCount === 0) {
    return (
      <TileShell
        icon={<ClipboardList className="h-4 w-4" />}
        title="Onboarding completeness"
        severity="ok"
        loading={false}
        error={null}
        stale={stale}
      >
        <div className="text-sm text-silver flex items-center gap-2 py-4">
          <Info className="h-4 w-4" />
          No active associates yet — once HR approves an application this tile lights up.
        </div>
      </TileShell>
    );
  }

  return (
    <TileShell
      icon={<ClipboardList className="h-4 w-4" />}
      title="Onboarding completeness"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
      stale={stale}
    >
      {data && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 items-start">
            {/* Hero metric — fully compliant donut. */}
            <ComplianceDonut
              fully={data.fullyCompliantCount}
              total={data.activeAssociateCount}
            />

            {/* Per-signal grid — wider on the right so labels breathe. */}
            <div className="space-y-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-widest text-silver/80">
                  Per signal
                </span>
                <span className="text-[10px] text-silver/80 tabular-nums">
                  {data.activeAssociateCount} active
                </span>
              </div>
              {data.signals.map((s) => {
                const total = data.activeAssociateCount;
                const pct = total === 0 ? 100 : Math.round((s.completedCount / total) * 100);
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setDrawerSignal(s)}
                    className="group w-full flex items-center justify-between gap-3 px-2 py-1.5 rounded hover:bg-navy-secondary/40 text-left min-w-0"
                  >
                    <ClauseTooltip clause={s.contractClause}>
                      <span className="text-xs text-white truncate">{s.label}</span>
                    </ClauseTooltip>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-[11px] text-silver tabular-nums hidden sm:inline">
                        {s.completedCount}/{total} ({pct}%)
                      </span>
                      <span className="text-[11px] text-silver tabular-nums sm:hidden">
                        {pct}%
                      </span>
                      <PctBar pct={pct} severity={pctSeverity(pct)} className="w-16 sm:w-24" />
                      <ChevronRight className="h-3.5 w-3.5 text-silver/60 group-hover:text-silver" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <Drawer open={drawerSignal !== null} onOpenChange={(o) => !o && setDrawerSignal(null)}>
            <DrawerHeader>
              <DrawerTitle>{drawerSignal?.label ?? ''}</DrawerTitle>
              <DrawerDescription>
                {drawerSignal?.contractClause ?? ''}
              </DrawerDescription>
            </DrawerHeader>
            <DrawerBody>
              {drawerSignal && drawerSignal.missing.length === 0 ? (
                <div className="text-sm text-success flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  All active associates have this on file.
                </div>
              ) : (
                <ul className="space-y-1">
                  {drawerSignal?.missing.map((m) => (
                    <li
                      key={`${m.associateId}-${m.clientId}`}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-navy-secondary"
                    >
                      <div>
                        <div className="text-sm text-white">{m.associateName ?? '—'}</div>
                        <div className="text-[10px] text-silver">{m.clientName ?? '—'}</div>
                      </div>
                      {m.associateId && (
                        <Link
                          to={`/people?associate=${m.associateId}`}
                          className="text-xs text-gold hover:underline flex items-center gap-1"
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </Link>
                      )}
                    </li>
                  ))}
                  {drawerSignal && drawerSignal.missingCount > drawerSignal.missing.length && (
                    <li className="text-[11px] text-silver/80 px-2 pt-1">
                      Showing {drawerSignal.missing.length} of {drawerSignal.missingCount}.
                    </li>
                  )}
                </ul>
              )}
            </DrawerBody>
          </Drawer>
        </>
      )}
    </TileShell>
  );
}

// Chart-only donut (no legend) sized for the Tile 1 hero column. The shared
// <DonutChart> component bundles its own legend in a flex-row, which doesn't
// fit a 220px column — so we drop down to recharts here directly. The center
// label sits in the donut hole via absolute positioning over a sized parent;
// this only works because the parent has explicit width/height in px.
function ComplianceDonut({ fully, total }: { fully: number; total: number }) {
  const pct = total === 0 ? 100 : Math.round((fully / total) * 100);
  const gaps = Math.max(0, total - fully);
  const tone = pct === 100 ? 'text-success' : pct >= 80 ? 'text-warning' : 'text-alert';
  const SIZE = 170;

  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={[
                { name: 'Fully compliant', value: fully },
                { name: 'Has gaps', value: gaps },
              ]}
              dataKey="value"
              cx="50%"
              cy="50%"
              innerRadius={Math.round(SIZE * 0.34)}
              outerRadius={Math.round(SIZE * 0.48)}
              paddingAngle={gaps > 0 && fully > 0 ? 3 : 0}
              startAngle={90}
              endAngle={-270}
              stroke="none"
              isAnimationActive
              animationDuration={500}
            >
              <Cell fill="#34A874" />
              <Cell fill="#E96255" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="font-display text-3xl tabular-nums text-white leading-none">
            {pct}%
          </div>
          <div className="text-[10px] uppercase tracking-widest text-silver/70 mt-1">
            compliant
          </div>
        </div>
      </div>
      <div className={cn('text-xs mt-3', tone)}>
        {fully} of {total} fully compliant
      </div>
      {gaps > 0 && (
        <div className="text-[10px] text-silver mt-0.5">
          {gaps} {gaps === 1 ? 'associate has' : 'associates have'} at least one gap
        </div>
      )}
    </div>
  );
}

/* ----------------------------- TILE 2 ----------------------------- */

function ExpirationsTile({ refreshEpoch }: { refreshEpoch: number }) {
  const { data, error, stale } = useTileData(getScorecardExpirations, refreshEpoch);

  return (
    <TileShell
      icon={<Clock className="h-4 w-4" />}
      title="Expiring documents (next 90 days)"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
      stale={stale}
    >
      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
            <BucketTile label="0–30 days" count={data.buckets.red.length} severity="critical" />
            <BucketTile label="31–60 days" count={data.buckets.amber.length} severity="warn" />
            <BucketTile label="61–90 days" count={data.buckets.green.length} severity="ok" />
          </div>
          {(['red', 'amber', 'green'] as const).map((bucket) => {
            const items = data.buckets[bucket];
            if (items.length === 0) return null;
            return (
              <div key={bucket} className="mb-2">
                <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-1">
                  {bucket === 'red' ? '0–30 days' : bucket === 'amber' ? '31–60 days' : '61–90 days'}
                </div>
                <ul className="space-y-1">
                  {items.slice(0, 5).map((it, i) => (
                    <li key={i} className="flex justify-between items-center text-xs gap-2">
                      <span className="text-white truncate">{it.subject.associateName ?? it.label}</span>
                      <span className="text-silver tabular-nums shrink-0">
                        {it.label} · {it.daysUntil}d
                      </span>
                    </li>
                  ))}
                  {items.length > 5 && (
                    <li className="text-[10px] text-silver/80">+{items.length - 5} more</li>
                  )}
                </ul>
              </div>
            );
          })}
          {data.unsupported.length > 0 && (
            <div className="mt-3 pt-3 border-t border-navy-secondary">
              <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-1">
                Coming soon
              </div>
              {data.unsupported.map((u) => (
                <ComingSoonRow key={u.kind} label={u.label} reason={u.reason} />
              ))}
            </div>
          )}
        </>
      )}
    </TileShell>
  );
}

/* ----------------------------- TILE 3 ----------------------------- */

function ShiftsTile({ refreshEpoch }: { refreshEpoch: number }) {
  const { data, error, stale } = useTileData(getScorecardShifts, refreshEpoch);

  return (
    <TileShell
      icon={<TrendingUp className="h-4 w-4" />}
      title="Shift compliance (ASN Nexus)"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
      stale={stale}
    >
      {data && (
        <div className="space-y-2">
          <p className="text-[11px] text-silver">Window: last {data.windowDays} days</p>
          {data.signals.map((s) => (
            <div
              key={s.key}
              className={cn(
                'px-2 py-1.5 rounded flex items-center justify-between gap-2 min-w-0',
                s.status === 'live' ? 'bg-navy-secondary/30' : 'bg-navy-secondary/10',
              )}
            >
              <ClauseTooltip clause={s.contractClause}>
                <span className="text-xs text-white truncate">{s.label}</span>
              </ClauseTooltip>
              {s.status === 'live' && s.value !== null ? (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-silver tabular-nums">
                    {s.value}% / {s.target}%
                  </span>
                  <PctBar pct={s.value} severity={liveSeverity(s.value, s.target ?? 0)} />
                </div>
              ) : s.status === 'live' && s.value === null ? (
                <span className="text-[11px] text-silver/80 shrink-0">No data in window</span>
              ) : (
                <Badge variant="outline" className="shrink-0">Coming soon</Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </TileShell>
  );
}

/* ----------------------------- TILE 4 ----------------------------- */

function BillingTile({ refreshEpoch }: { refreshEpoch: number }) {
  const { data, error, stale } = useTileData(getScorecardBilling, refreshEpoch);

  const mismatches = useMemo(
    () => data?.rateChecks.filter((r) => r.expectedRate !== null && !r.match) ?? [],
    [data],
  );

  return (
    <TileShell
      icon={<DollarSign className="h-4 w-4" />}
      title="Billing & invoicing"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
      stale={stale}
    >
      {data && (
        <>
          <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-1">
            Bill rates vs SOW
          </div>
          {mismatches.length === 0 ? (
            <div className="text-xs text-success flex items-center gap-2">
              <CheckCircle2 className="h-3.5 w-3.5" />
              All matched jobs are at the contracted rate.
            </div>
          ) : (
            <ul className="space-y-1">
              {mismatches.slice(0, 6).map((r) => (
                <li key={r.jobId} className="text-xs flex items-center justify-between gap-2">
                  <span className="text-white truncate">
                    {r.clientName} / {r.jobName}
                  </span>
                  <span className="tabular-nums text-alert">
                    ${r.billRate.toFixed(2)} ≠ ${r.expectedRate?.toFixed(2)}
                  </span>
                </li>
              ))}
              {mismatches.length > 6 && (
                <li className="text-[10px] text-silver/80">+{mismatches.length - 6} more</li>
              )}
            </ul>
          )}
          {data.unsupported.length > 0 && (
            <div className="mt-3 pt-3 border-t border-navy-secondary">
              <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-1">
                Coming soon
              </div>
              {data.unsupported.map((u) => (
                <ComingSoonRow key={u.key} label={u.label} reason={u.reason} />
              ))}
            </div>
          )}
        </>
      )}
    </TileShell>
  );
}

/* ----------------------------- TILE 5 ----------------------------- */

function TrainingTile({ refreshEpoch }: { refreshEpoch: number }) {
  const { data, error, stale } = useTileData(getScorecardTraining, refreshEpoch);
  const [drawerSignal, setDrawerSignal] = useState<ScorecardTrainingSignal | null>(null);

  return (
    <TileShell
      icon={<GraduationCap className="h-4 w-4" />}
      title="Training completeness"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
      stale={stale}
    >
      {data && (
        <>
          <div className="space-y-1.5">
            {data.signals.map((s) => {
              const pct = s.totalAssociates === 0 ? 100 : Math.round((s.completedCount / s.totalAssociates) * 100);
              return (
                <button
                  key={s.tag}
                  type="button"
                  disabled={s.status !== 'live'}
                  onClick={() => s.status === 'live' && setDrawerSignal(s)}
                  className={cn(
                    'group w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left min-w-0',
                    s.status === 'live' ? 'hover:bg-navy-secondary/40' : 'opacity-70',
                  )}
                >
                  <ClauseTooltip clause={s.contractClause}>
                    <span className="text-xs text-white truncate">{s.label}</span>
                  </ClauseTooltip>
                  {s.status === 'live' ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-silver tabular-nums hidden sm:inline">
                        {s.completedCount}/{s.totalAssociates} ({pct}%)
                      </span>
                      <span className="text-[11px] text-silver tabular-nums sm:hidden">
                        {pct}%
                      </span>
                      <PctBar pct={pct} severity={pctSeverity(pct)} />
                      <ChevronRight className="h-3.5 w-3.5 text-silver/60 group-hover:text-silver" />
                    </div>
                  ) : (
                    <Badge variant="outline">
                      {s.status === 'no_course' ? 'Tag a course' : 'No enrollments'}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-silver/80 mt-2">
            "Tag a course" means no Learning course has the matching <span className="font-mono">complianceTag</span>. Set it from the Learning admin page to start tracking.
          </p>

          <Drawer open={drawerSignal !== null} onOpenChange={(o) => !o && setDrawerSignal(null)}>
            <DrawerHeader>
              <DrawerTitle>{drawerSignal?.label ?? ''}</DrawerTitle>
              <DrawerDescription>{drawerSignal?.contractClause ?? ''}</DrawerDescription>
            </DrawerHeader>
            <DrawerBody>
              {drawerSignal && drawerSignal.missing.length === 0 ? (
                <div className="text-sm text-success flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  All active associates have completed this training.
                </div>
              ) : (
                <ul className="space-y-1">
                  {drawerSignal?.missing.map((m) => (
                    <li
                      key={`${m.associateId}-${m.clientId}`}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-navy-secondary"
                    >
                      <div>
                        <div className="text-sm text-white">{m.associateName ?? '—'}</div>
                        <div className="text-[10px] text-silver">{m.clientName ?? '—'}</div>
                      </div>
                      {m.associateId && (
                        <Link
                          to={`/people?associate=${m.associateId}`}
                          className="text-xs text-gold hover:underline flex items-center gap-1"
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </DrawerBody>
          </Drawer>
        </>
      )}
    </TileShell>
  );
}

/* ----------------------------- TILE 6 ----------------------------- */

type ActionFilter = 'all' | 'critical' | 'warn';

function ActionsTile({ refreshEpoch }: { refreshEpoch: number }) {
  const { data, error, stale } = useTileData(getScorecardActions, refreshEpoch);
  const [filter, setFilter] = useState<ActionFilter>('all');

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.actions;
    return data.actions.filter((a) => a.severity === filter);
  }, [data, filter]);

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Sparkles className="h-4 w-4 text-gold" />
            Open actions
            {stale && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-[10px] text-warning ml-1">
                    <WifiOff className="h-3 w-3" />
                    Stale
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Last refresh failed.
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {data && data.actions.length > 0 && (
            <div className="flex items-center gap-1">
              <FilterChip
                active={filter === 'all'}
                onClick={() => setFilter('all')}
                label="All"
                count={data.actions.length}
              />
              <FilterChip
                active={filter === 'critical'}
                onClick={() => setFilter('critical')}
                label="Critical"
                count={data.criticalCount}
                tone="alert"
              />
              <FilterChip
                active={filter === 'warn'}
                onClick={() => setFilter('warn')}
                label="Warn"
                count={data.warnCount}
                tone="warning"
              />
            </div>
          )}
        </div>
        {error && <div className="text-sm text-alert">{error}</div>}
        {!data && !error && <Skeleton className="h-32" />}
        {data && data.actions.length === 0 && (
          <div className="rounded-md border border-success/40 bg-success/10 px-4 py-6 flex flex-col items-center text-center">
            <CheckCircle2 className="h-6 w-6 text-success mb-2" />
            <div className="text-sm text-success font-medium">No open compliance actions</div>
            <div className="text-[11px] text-silver mt-0.5">
              Every signal across all five tiles is clear.
            </div>
          </div>
        )}
        {data && data.actions.length > 0 && filtered.length === 0 && (
          <div className="text-xs text-silver py-3 text-center">
            No actions match this filter.
          </div>
        )}
        {data && filtered.length > 0 && (
          <ul className="divide-y divide-navy-secondary border border-navy-secondary rounded">
            {filtered.map((a) => (
              <li key={a.id} className="px-3 py-2 flex items-center justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <SeverityDot severity={a.severity} />
                  <div className="min-w-0">
                    <div className="text-xs text-white truncate">{a.title}</div>
                    <div className="text-[10px] text-silver/80 truncate">{a.contractClause}</div>
                  </div>
                </div>
                {a.link && (
                  <Link
                    to={a.link}
                    className="text-[11px] text-gold hover:underline flex items-center gap-1 shrink-0"
                  >
                    Fix <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: 'alert' | 'warning';
}) {
  const accentTone =
    tone === 'alert' ? 'text-alert' :
    tone === 'warning' ? 'text-warning' :
    'text-white';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 px-2.5 rounded-md border text-[11px] flex items-center gap-1.5 transition-colors',
        active
          ? 'border-gold bg-gold/10 text-white'
          : 'border-navy-secondary text-silver hover:text-white hover:bg-navy-secondary/40',
      )}
    >
      <span>{label}</span>
      <span className={cn('tabular-nums font-semibold', active ? 'text-white' : accentTone)}>
        {count}
      </span>
    </button>
  );
}

/* ----------------------- Reusable tile chrome --------------------- */

function TileShell({
  icon,
  title,
  severity,
  loading,
  error,
  stale,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  severity: ScorecardSeverity;
  loading: boolean;
  error: string | null;
  stale?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn('border', SEVERITY_RING[severity])}>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <span className="text-gold">{icon}</span>
            {title}
          </div>
          <div className="flex items-center gap-2">
            {stale && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-[10px] text-warning">
                    <WifiOff className="h-3 w-3" />
                    Stale
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs">
                  Last refresh failed. Numbers may be out of date — click Refresh to retry.
                </TooltipContent>
              </Tooltip>
            )}
            <Badge variant={SEVERITY_BADGE[severity].variant}>
              {SEVERITY_BADGE[severity].label}
            </Badge>
          </div>
        </div>
        {error && <div className="text-sm text-alert">{error}</div>}
        {loading && <Skeleton className="h-32" />}
        {!loading && !error && children}
      </CardContent>
    </Card>
  );
}

function PctBar({
  pct,
  severity,
  className,
}: {
  pct: number;
  severity: ScorecardSeverity;
  className?: string;
}) {
  const fill = severity === 'critical' ? 'bg-alert' : severity === 'warn' ? 'bg-warning' : 'bg-success';
  return (
    <div className={cn('h-2 rounded-full bg-navy-secondary overflow-hidden', className ?? 'w-16')}>
      <div className={cn('h-full transition-all', fill)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function BucketTile({ label, count, severity }: { label: string; count: number; severity: ScorecardSeverity }) {
  const tone =
    severity === 'critical' ? 'border-alert/60 bg-alert/10 text-alert' :
    severity === 'warn' ? 'border-warning/60 bg-warning/10 text-warning' :
    'border-success/60 bg-success/10 text-success';
  return (
    <div className={cn('rounded border px-2 py-2 text-center', tone)}>
      <div className="text-lg font-bold tabular-nums">{count}</div>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
    </div>
  );
}

function ComingSoonRow({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="flex items-center justify-between text-xs py-1">
      <span className="text-silver">{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 text-[10px] text-silver/80">
            <Info className="h-3 w-3" />
            Coming soon
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs">
          {reason}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function ClauseTooltip({ clause, children }: { clause: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted decoration-silver/40 underline-offset-4">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{clause}</TooltipContent>
    </Tooltip>
  );
}

function SeverityDot({ severity }: { severity: ScorecardSeverity }) {
  const tone = severity === 'critical' ? 'bg-alert' : severity === 'warn' ? 'bg-warning' : 'bg-success';
  return <span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', tone)} />;
}

function pctSeverity(pct: number): ScorecardSeverity {
  if (pct >= 95) return 'ok';
  if (pct >= 80) return 'warn';
  return 'critical';
}

function liveSeverity(value: number, target: number): ScorecardSeverity {
  if (value >= target) return 'ok';
  if (value >= target * 0.93) return 'warn';
  return 'critical';
}

function fmtTimeAgo(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}
