import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  DollarSign,
  Download,
  ExternalLink,
  GraduationCap,
  HardHat,
  Info,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
// Recharts (~290 KB) lives behind a lazy boundary — see ComplianceDonut below.
const ComplianceDonut = lazy(() =>
  import('./ComplianceDonut').then((m) => ({ default: m.ComplianceDonut })),
);
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
  ErrorBanner,
  Skeleton,
  TooltipProvider,
} from '@/components/ui';
import { FilterChip } from '@/components/ui/FilterBar';
import { downloadCsv } from '@/lib/csv';
import type {
  OshaIncidentSeverity,
  ScorecardAction,
  ScorecardActionState,
  ScorecardExpiringItem,
  ScorecardHistoryPoint,
  ScorecardOnboardingSignal,
  ScorecardSeverity,
  ScorecardTrainingSignal,
} from '@alto-people/shared';
import {
  OSHA_DART_TARGET,
  OSHA_RATE_MIN_HOURS,
  OSHA_TRIR_TARGET,
  oshaRateMeaningful,
  scorecardGrade,
  scorecardSeverityFromFailPct,
} from '@alto-people/shared';
import {
  getScorecardActions,
  getScorecardBilling,
  getScorecardExpirations,
  getScorecardHistory,
  getScorecardOnboarding,
  getScorecardSafety,
  getScorecardShifts,
  getScorecardTraining,
  nudgeScorecardSignal,
  scorecardReportUrl,
  setScorecardActionState,
  snoozeAttestation,
  unsnoozeAttestation,
  upsertAttestation,
} from '@/lib/complianceScorecardApi';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { enrollAssociates } from '@/lib/lms94Api';
import { useClients } from '@/lib/useClients';
import type {
  ManualAttestationOutcome,
  ManualAttestationSignal,
} from '@alto-people/shared';
import { Input, Textarea, Label } from '@/components/ui';
import { downloadDocumentUrl } from '@/lib/documentsApi';
import { fmtDate, fmtRelativeDate, fmtStatementNo, parseYmd, ymdLocal } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Sparkline } from '@/components/ui/charts/Sparkline';
import { ACTIONS_PAGE, groupScorecardActions, type ActionEntry } from './scorecardActions';

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// Shared fetch hook for tiles. Two behaviors that matter:
//   1. First load shows a skeleton; subsequent refreshes keep the previous
//      data on screen so the page doesn't flash empty when nothing changed.
//   2. If a refresh fails *after* a successful first load, we surface a
//      "stale" badge instead of throwing the user back to an error state.
//      They keep the last-good numbers and can retry from the header.
//
// The key names the tile and its scope (the client filter): a new scope is
// a different query, so the tile drops back to the skeleton rather than
// showing the old scope's numbers under the new filter. refreshEpoch is
// the page-wide refresh tick (header button, 15-minute timer): a bump
// refetches in place, keeping the data on screen.
function useTileData<T>(
  key: readonly unknown[],
  fetcher: () => Promise<T>,
  refreshEpoch: number,
): { data: T | null; error: string | null; stale: boolean } {
  const query = useQuery({
    queryKey: ['compliance', 'scorecard', ...key],
    queryFn: fetcher,
    retry: false,
    staleTime: REFRESH_INTERVAL_MS,
  });
  const { refetch } = query;
  const lastEpoch = useRef(refreshEpoch);
  useEffect(() => {
    if (lastEpoch.current === refreshEpoch) return;
    lastEpoch.current = refreshEpoch;
    void refetch();
  }, [refreshEpoch, refetch]);

  const data = query.data ?? null;
  const failed = query.isError;
  return {
    data,
    error:
      failed && data === null
        ? query.error instanceof ApiError
          ? query.error.message
          : 'Failed to load.'
        : null,
    stale: failed && data !== null,
  };
}

/**
 * Mirrors the server's fix-link routing (buildActionsTile): a missing-signal
 * row opens the compliance tab that OWNS the signal — the receiving tab
 * consumes ?associateId= and auto-opens the person. Same-tab navigation is
 * fine here (we're already on /compliance); ?return= gives the I-9/E-Verify
 * surfaces a way back to the scorecard. Person-level gaps (age, W-4, offer,
 * policy ack) still open the person record — with the param the People page
 * actually reads.
 */
const SCORECARD_RETURN = `&return=${encodeURIComponent('/compliance?tab=scorecard')}`;

function onboardingFixLink(
  key: ScorecardOnboardingSignal['key'],
  associateId: string,
): string {
  switch (key) {
    case 'I9_BOTH_SECTIONS':
      return `/compliance?tab=i9&associateId=${associateId}${SCORECARD_RETURN}`;
    case 'E_VERIFY':
      return `/compliance?tab=everify&associateId=${associateId}${SCORECARD_RETURN}`;
    case 'BACKGROUND_CHECK':
      return `/compliance?tab=background&associateId=${associateId}`;
    case 'DRUG_TEST_60D':
      return `/compliance?tab=drugtests&associateId=${associateId}`;
    default:
      return `/people?associateId=${associateId}`;
  }
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
  const [refreshing, setRefreshing] = useState(false);
  // '' = org-wide. Every tile endpoint takes the same ?clientId= scope.
  const [clientId, setClientId] = useState('');
  const { clients } = useClients();

  useEffect(() => {
    const id = setInterval(() => {
      setRefreshEpoch((n) => n + 1);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setRefreshEpoch((n) => n + 1);
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
          refreshing={refreshing}
          onRefresh={refresh}
          clientId={clientId}
          clientName={clients.find((c) => c.id === clientId)?.name ?? null}
        />

        {/* Client scope — the same filter every tile respects. Only shown
            when there's actually more than one client to slice by. */}
        {clients.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip active={clientId === ''} onClick={() => setClientId('')}>
              All clients
            </FilterChip>
            {clients.map((c) => (
              <FilterChip
                key={c.id}
                active={clientId === c.id}
                onClick={() => setClientId(c.id)}
              >
                {c.name}
              </FilterChip>
            ))}
          </div>
        )}

        {/* Tile 1 — promoted to full-width hero. Most important tile per spec. */}
        <OnboardingTile refreshEpoch={refreshEpoch} clientId={clientId} />

        {/* Expirations + Training: time-bound items. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ExpirationsTile refreshEpoch={refreshEpoch} clientId={clientId} />
          <TrainingTile refreshEpoch={refreshEpoch} clientId={clientId} />
        </div>

        {/* Operational + financial, side by side. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ShiftsTile refreshEpoch={refreshEpoch} clientId={clientId} />
          <BillingTile refreshEpoch={refreshEpoch} clientId={clientId} />
        </div>

        {/* Tile 7 — OSHA safety: the factory sign + incident log. */}
        <SafetyTile refreshEpoch={refreshEpoch} clientId={clientId} />

        <ActionsTile refreshEpoch={refreshEpoch} clientId={clientId} />
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
  refreshing,
  onRefresh,
  clientId,
  clientName,
}: {
  refreshEpoch: number;
  refreshing: boolean;
  onRefresh: () => void;
  clientId: string;
  /** The client in scope, for the subtitle; null = every client. */
  clientName: string | null;
}) {
  const fetchActions = useCallback(
    () => getScorecardActions(clientId || undefined),
    [clientId],
  );
  const fetchHistory = useCallback(
    () => getScorecardHistory(clientId || undefined),
    [clientId],
  );
  const { data } = useTileData(['actions', clientId], fetchActions, refreshEpoch);
  const { data: history } = useTileData(['history', clientId], fetchHistory, refreshEpoch);
  const critical = data?.criticalCount ?? 0;
  const warn = data?.warnCount ?? 0;
  const totalActions = data?.totalActionCount ?? critical + warn;
  const score = data?.score ?? null;
  const grade = score === null ? null : scorecardGrade(score);
  const weekDelta = history?.weekDelta ?? null;
  // The snapshot the week's change is measured from (the API's rule: the
  // closest one at least 6 days older than the latest), so the change
  // reads "was 40 on Oct 15" instead of an undated "-23 wk".
  const weekAnchor = useMemo(() => {
    const points = history?.points ?? [];
    if (weekDelta === null || points.length < 2) return null;
    const latestMs = Date.parse(points[points.length - 1]!.day);
    return [...points].reverse().find((p) => latestMs - Date.parse(p.day) >= 6 * 24 * 3600 * 1000) ?? null;
  }, [history, weekDelta]);

  return (
    <Card className={cn('border', critical > 0 ? 'border-alert/60' : 'border-navy-secondary')}>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex-1 min-w-[260px]">
            <h2 className="text-xl text-ink flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-gold" />
              Contract compliance scorecard
            </h2>
            <p className="text-xs text-silver mt-0.5">
              Live against {clientName ? `the ${clientName} contract` : 'every client contract'}: MSA, SOW and MTSA. Refreshes every 15 minutes.{' '}
              <Link to="/compliance?tab=audit" className="text-gold underline underline-offset-2">
                Audit evidence →
              </Link>
            </p>
          </div>

          {/* Weighted score — the one number a board asks for. */}
          {score !== null && (
            <div className="flex items-center gap-3">
              <div className="text-center">
                <div
                  className={cn(
                    'text-3xl font-bold tabular-nums leading-none',
                    score >= 85 ? 'text-success' : score >= 60 ? 'text-warning' : 'text-alert',
                  )}
                >
                  {score}
                  <span className="text-sm font-semibold text-silver/80 ml-1">/ 100</span>
                </div>
                <div className="text-2xs uppercase tracking-widest text-silver/80 mt-1">
                  Score · grade {grade}
                </div>
                {weekDelta !== null && weekAnchor && (
                  <div
                    className={cn(
                      'text-2xs tabular-nums mt-0.5',
                      weekDelta > 0 ? 'text-success' : weekDelta < 0 ? 'text-alert' : 'text-silver',
                    )}
                  >
                    {weekDelta > 0 ? '+' : weekDelta < 0 ? '−' : '±'}
                    {Math.abs(weekDelta)} · was {weekAnchor.score} on {fmtDate(parseYmd(weekAnchor.day))}
                  </div>
                )}
              </div>
              {history && history.points.length >= 2 && (
                <ScoreSparkline points={history.points} />
              )}
            </div>
          )}

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
            {data && (
              <span className="text-xs2 text-silver tabular-nums">
                Updated {fmtTimeAgo(new Date(data.generatedAt))}
              </span>
            )}
            <Button size="sm" variant="outline" asChild>
              <a href={scorecardReportUrl(clientId || undefined)} download>
                <Download className="h-3.5 w-3.5" />
                Board PDF
              </a>
            </Button>
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

/** 90 days of snapshot scores — the kit's sparkline (padded scale, so a
 *  one-point wobble doesn't read as a cliff), green when it rose. */
function ScoreSparkline({ points }: { points: ScorecardHistoryPoint[] }) {
  if (points.length < 2) return null;
  const first = points[0]!;
  const latest = points[points.length - 1]!;
  const label = `Score ${first.score} on ${fmtDate(parseYmd(first.day))}, ${latest.score} on ${fmtDate(parseYmd(latest.day))}`;
  return (
    // The dates live in the tooltip: a sparkline has no axis.
    <span title={label} className="inline-flex">
      <Sparkline
        series={points.map((p) => p.score)}
        tone={latest.score >= first.score ? 'good' : 'bad'}
        width={96}
        height={30}
        label={`Compliance score trend: ${label}`}
      />
    </span>
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
      <div className="text-2xs uppercase tracking-widest text-silver/80 mt-0.5">{label}</div>
    </div>
  );
}

/* ----------------------------- TILE 1 ----------------------------- */

const NUDGEABLE_SIGNALS = new Set<ScorecardOnboardingSignal['key']>([
  'DRUG_TEST_60D',
  'W4_ON_FILE',
  'OFFER_LETTER_SIGNED',
  'POLICY_ACK_SIGNED',
]);

function OnboardingTile({ refreshEpoch, clientId }: { refreshEpoch: number; clientId: string }) {
  const fetcher = useCallback(
    () => getScorecardOnboarding(clientId || undefined),
    [clientId],
  );
  const { data, error, stale } = useTileData(['onboarding', clientId], fetcher, refreshEpoch);
  const [drawerSignal, setDrawerSignal] = useState<ScorecardOnboardingSignal | null>(null);
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [nudging, setNudging] = useState(false);

  // Week-over-week movement of the donut's number, from the daily
  // snapshots — "are we digging out or falling behind?"
  const historyFetcher = useCallback(
    () => getScorecardHistory(clientId || undefined),
    [clientId],
  );
  const { data: history } = useTileData(['history', clientId], historyFetcher, refreshEpoch);
  const fullyDelta = useMemo(() => {
    const points = history?.points ?? [];
    if (points.length < 2) return null;
    const latest = points[points.length - 1];
    const latestMs = Date.parse(latest.day);
    const anchor = [...points]
      .reverse()
      .find((p) => latestMs - Date.parse(p.day) >= 6 * 24 * 3600 * 1000);
    return anchor ? latest.fullyCompliantCount - anchor.fullyCompliantCount : null;
  }, [history]);

  const nudgeAll = async (signal: ScorecardOnboardingSignal) => {
    if (!NUDGEABLE_SIGNALS.has(signal.key)) return;
    setNudging(true);
    try {
      const r = await nudgeScorecardSignal({
        signalKey: signal.key as Parameters<typeof nudgeScorecardSignal>[0]['signalKey'],
        ...(clientId ? { clientId } : {}),
      });
      toast.success(
        r.nudged === 0
          ? `Everyone missing this was already reminded in the last 7 days (${r.deduped} skipped).`
          : `Reminded ${r.nudged} associate${r.nudged === 1 ? '' : 's'}${r.deduped > 0 ? ` (${r.deduped} already reminded this week)` : ''}.`,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Nudge failed.');
    } finally {
      setNudging(false);
    }
  };

  const exportSignalCsv = (signal: ScorecardOnboardingSignal) => {
    const rows: Array<Array<string>> = [
      ['associate', 'client', 'federal_deadline', 'days_overdue'],
      ...signal.missing.map((m) => [
        m.associateName ?? '',
        m.clientName ?? '',
        m.dueBy ?? '',
        m.daysOverdue != null && m.daysOverdue > 0 ? String(m.daysOverdue) : '',
      ]),
    ];
    if (signal.missingCount > signal.missing.length) {
      rows.push([
        `NOTE: showing ${signal.missing.length} of ${signal.missingCount} missing (display cap).`,
        '', '', '',
      ]);
    }
    downloadCsv(
      `missing-${signal.key.toLowerCase()}-${ymdLocal()}.csv`,
      rows,
    );
  };

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
            <div>
              <Suspense fallback={<Skeleton className="h-48 w-44" />}>
                <ComplianceDonut
                  fully={data.fullyCompliantCount}
                  total={data.activeAssociateCount}
                />
              </Suspense>
              {fullyDelta !== null && (
                <div
                  className={cn(
                    'text-2xs tabular-nums text-center mt-1',
                    fullyDelta > 0 ? 'text-success' : fullyDelta < 0 ? 'text-alert' : 'text-silver/80',
                  )}
                >
                  {fullyDelta > 0 ? '+' : ''}
                  {fullyDelta} fully compliant vs last week
                </div>
              )}
            </div>

            {/* Per-signal grid — wider on the right so labels breathe. */}
            <div className="space-y-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-2xs uppercase tracking-widest text-silver/80">
                  Per signal
                </span>
                <span className="text-2xs text-silver/80 tabular-nums">
                  {data.activeAssociateCount} active
                </span>
              </div>
              {data.signals.map((s) => {
                const total = data.activeAssociateCount;
                const pct = total === 0 ? 100 : Math.round((s.completedCount / total) * 100);
                // The clause and the list are two controls side by side: the
                // row used to be a <button> holding the clause's <button>.
                return (
                  <div
                    key={s.key}
                    className="group w-full flex items-center justify-between gap-3 px-2 py-1.5 rounded hover:bg-navy-secondary/40 min-w-0"
                  >
                    <ClauseTooltip clause={s.contractClause}>
                      <span className="text-xs text-white truncate">{s.label}</span>
                    </ClauseTooltip>
                    <button
                      type="button"
                      onClick={() => setDrawerSignal(s)}
                      aria-label={`${s.label}: ${s.completedCount} of ${total}. See who is missing it`}
                      className="flex flex-1 items-center justify-end gap-3 shrink-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                    >
                      {(s.overdueCount ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 rounded bg-alert/15 px-1.5 py-0.5 text-2xs font-semibold text-alert">
                          <AlertTriangle className="h-3 w-3" />
                          {s.overdueCount} past deadline
                        </span>
                      )}
                      <span className="text-xs2 text-silver tabular-nums hidden sm:inline">
                        {s.completedCount}/{total} ({pct}%)
                      </span>
                      <span className="text-xs2 text-silver tabular-nums sm:hidden">
                        {pct}%
                      </span>
                      <PctBar pct={pct} severity={pctSeverity(pct)} className="w-16 sm:w-24" />
                      <ChevronRight className="h-3.5 w-3.5 text-silver/70 group-hover:text-silver" />
                    </button>
                  </div>
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
            {drawerSignal && drawerSignal.missing.length > 0 && (
              <div className="px-4 pb-2 flex flex-wrap items-center gap-2">
                <Button size="xs" variant="outline" onClick={() => exportSignalCsv(drawerSignal)}>
                  <Download className="h-3 w-3" />
                  Export CSV
                </Button>
                {canManage && NUDGEABLE_SIGNALS.has(drawerSignal.key) && (
                  <Button
                    size="xs"
                    variant="outline"
                    loading={nudging}
                    onClick={() => void nudgeAll(drawerSignal)}
                    title="Remind every missing associate (skips anyone reminded in the last 7 days)"
                  >
                    Nudge all {drawerSignal.missingCount} missing
                  </Button>
                )}
              </div>
            )}
            <DrawerBody>
              {drawerSignal && drawerSignal.missing.length === 0 ? (
                <div className="text-sm text-success flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  All active associates have this on file.
                </div>
              ) : (
                <ul className="space-y-1">
                  {drawerSignal &&
                    drawerSignal.missing.map((m) => (
                      <li
                        key={`${m.associateId}-${m.clientId}`}
                        className={cn(
                          'flex items-center justify-between gap-2 px-2 py-1.5 rounded border',
                          (m.daysOverdue ?? 0) > 0 ? 'border-alert/50 bg-alert/5' : 'border-navy-secondary',
                        )}
                      >
                        <div>
                          <div className="text-sm text-white">{m.associateName ?? '—'}</div>
                          <div className="text-2xs text-silver">{m.clientName ?? '—'}</div>
                          {m.dueBy && (
                            <div
                              className={cn(
                                'text-2xs tabular-nums',
                                (m.daysOverdue ?? 0) > 0 ? 'text-alert font-semibold' : 'text-silver/80',
                              )}
                            >
                              {(m.daysOverdue ?? 0) > 0
                                ? `${m.daysOverdue} day${m.daysOverdue === 1 ? '' : 's'} past the federal deadline (was due ${fmtDate(m.dueBy)})`
                                : `Federal deadline ${fmtDate(m.dueBy)}`}
                            </div>
                          )}
                        </div>
                        {m.associateId && (
                          <Link
                            to={onboardingFixLink(drawerSignal.key, m.associateId)}
                            className="text-xs text-gold hover:underline flex items-center gap-1"
                          >
                            Open <ExternalLink className="h-3 w-3" />
                          </Link>
                        )}
                      </li>
                    ))}
                  {drawerSignal && drawerSignal.missingCount > drawerSignal.missing.length && (
                    <li className="text-xs2 text-silver/80 px-2 pt-1">
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

// ComplianceDonut moved to its own module so recharts loads behind a
// lazy() boundary instead of sitting in this chunk.

/* ----------------------------- TILE 2 ----------------------------- */

/**
 * Mirrors the server's expirationFixLink — each expiring row deep-links the
 * surface that renews it.
 */
function expirationFixLink(
  kind: ScorecardExpiringItem['kind'],
  associateId: string | null,
): string | null {
  if (!associateId) return null;
  switch (kind) {
    case 'I9_WORK_AUTH':
      return `/compliance?tab=i9&associateId=${associateId}${SCORECARD_RETURN}`;
    case 'DRUG_TEST':
      return `/compliance?tab=drugtests&associateId=${associateId}`;
    case 'J1_DS2019':
      return `/compliance?tab=j1&associateId=${associateId}`;
    case 'DOCUMENT':
      return `/people?associateId=${associateId}&tab=documents`;
    case 'AGREEMENT':
      return `/agreements?associateId=${associateId}`;
    default:
      return `/people?associateId=${associateId}`;
  }
}

type ExpirationBucket = 'red' | 'amber' | 'green';
const BUCKET_LABEL: Record<ExpirationBucket, string> = {
  red: '0–30 days',
  amber: '31–60 days',
  green: '61–90 days',
};

function ExpirationsTile({ refreshEpoch, clientId }: { refreshEpoch: number; clientId: string }) {
  const fetcher = useCallback(
    () => getScorecardExpirations(clientId || undefined),
    [clientId],
  );
  const { data, error, stale } = useTileData(['expirations', clientId], fetcher, refreshEpoch);
  const [bucketDrawer, setBucketDrawer] = useState<ExpirationBucket | null>(null);
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [drawerSignal, setDrawerSignal] =
    useState<ManualAttestationSignal | null>(null);
  const [localSignals, setLocalSignals] = useState<
    ManualAttestationSignal[] | null
  >(null);

  // Local copy lets the drawer optimistically replace a signal after the
  // upsert returns, without waiting for the next 15-min tile refresh.
  const signals = localSignals ?? data?.attestations ?? [];

  const applyUpdated = useCallback(
    (updated: ManualAttestationSignal) => {
      setLocalSignals((prev) => {
        const base = prev ?? data?.attestations ?? [];
        return base.map((s) => (s.key === updated.key ? updated : s));
      });
    },
    [data],
  );
  const { attestingKey, quickAttest } = useQuickAttest(applyUpdated);
  // The header speaks for the documents it counts: 0 / 0 / 0 under a red
  // "Critical" read as a contradiction when the red came from the
  // insurance attestations below. Those carry their own badge.
  const documentSeverity: ScorecardSeverity = !data
    ? 'ok'
    : data.buckets.red.length > 0
      ? 'critical'
      : data.buckets.amber.length > 0
        ? 'warn'
        : 'ok';
  const attestationSeverity = attestationsSeverity(signals);

  return (
    <TileShell
      icon={<Clock className="h-4 w-4" />}
      title="Expiring documents (next 90 days)"
      severity={documentSeverity}
      loading={!data && !error}
      error={error}
      stale={stale}
    >
      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
            {(['red', 'amber', 'green'] as const).map((bucket) => (
              <button
                key={bucket}
                type="button"
                onClick={() => data.buckets[bucket].length > 0 && setBucketDrawer(bucket)}
                className={cn(
                  'text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                  data.buckets[bucket].length > 0 && 'hover:opacity-90 cursor-pointer',
                )}
                aria-label={`Open the full ${BUCKET_LABEL[bucket]} list`}
              >
                <BucketTile
                  label={BUCKET_LABEL[bucket]}
                  count={data.buckets[bucket].length}
                  severity={bucket === 'red' ? 'critical' : bucket === 'amber' ? 'warn' : 'ok'}
                />
              </button>
            ))}
          </div>
          {(['red', 'amber', 'green'] as const).map((bucket) => {
            const items = data.buckets[bucket];
            if (items.length === 0) return null;
            return (
              <div key={bucket} className="mb-2">
                <div className="text-2xs uppercase tracking-widest text-silver/80 mb-1">
                  {bucket === 'red' ? '0–30 days' : bucket === 'amber' ? '31–60 days' : '61–90 days'}
                </div>
                <ul className="space-y-1">
                  {items.slice(0, 5).map((it, i) => {
                    const link = expirationFixLink(it.kind, it.subject.associateId);
                    const row = (
                      <>
                        <span className="text-white truncate">{it.subject.associateName ?? it.label}</span>
                        <span className="text-silver tabular-nums shrink-0">
                          {it.label} · {it.daysUntil}d
                        </span>
                      </>
                    );
                    return (
                      <li key={i} className="text-xs">
                        {link ? (
                          <Link
                            to={link}
                            className="flex justify-between items-center gap-2 rounded px-1 -mx-1 py-0.5 hover:bg-navy-secondary/40"
                          >
                            {row}
                          </Link>
                        ) : (
                          <span className="flex justify-between items-center gap-2 py-0.5">{row}</span>
                        )}
                      </li>
                    );
                  })}
                  {items.length > 5 && (
                    <li>
                      <button
                        type="button"
                        onClick={() => setBucketDrawer(bucket)}
                        className="text-2xs text-gold hover:underline"
                      >
                        +{items.length - 5} more — view all
                      </button>
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
          {bucketDrawer && (
            <ExpirationBucketDrawer
              bucket={bucketDrawer}
              items={data.buckets[bucketDrawer]}
              onClose={() => setBucketDrawer(null)}
            />
          )}
          {signals.length > 0 && (
            <div className="mt-3 pt-3 border-t border-navy-secondary">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-2xs uppercase tracking-widest text-silver/80">Insurance attestations</span>
                <Badge variant={SEVERITY_BADGE[attestationSeverity].variant}>{SEVERITY_BADGE[attestationSeverity].label}</Badge>
              </div>
              <ul className="space-y-1.5">
                {signals.map((s) => (
                  <AttestationRow
                    key={s.key}
                    signal={s}
                    canManage={canManage}
                    onClick={() => setDrawerSignal(s)}
                    attesting={attestingKey === s.key}
                    onQuickAttest={
                      canManage && !s.current && s.status !== 'attested'
                        ? () => void quickAttest(s)
                        : null
                    }
                  />
                ))}
              </ul>
            </div>
          )}
          <AttestationDrawer
            signal={drawerSignal}
            canManage={canManage}
            onClose={() => setDrawerSignal(null)}
            onSaved={(updated) => {
              applyUpdated(updated);
              setDrawerSignal(null);
            }}
          />
        </>
      )}
    </TileShell>
  );
}

/** Full bucket list: every expiring item (the tile previews 5), with a
 *  type-to-filter box, kind chips, fix links, and a CSV export. */
function ExpirationBucketDrawer({
  bucket,
  items,
  onClose,
}: {
  bucket: ExpirationBucket;
  items: ScorecardExpiringItem[];
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('');

  const kinds = useMemo(
    () => [...new Set(items.map((i) => i.kind))].sort(),
    [items],
  );
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((i) => {
      if (kindFilter && i.kind !== kindFilter) return false;
      if (!term) return true;
      return (
        (i.subject.associateName ?? '').toLowerCase().includes(term) ||
        i.label.toLowerCase().includes(term) ||
        (i.subject.clientName ?? '').toLowerCase().includes(term)
      );
    });
  }, [items, q, kindFilter]);

  const exportCsv = () => {
    downloadCsv(`expiring-${BUCKET_LABEL[bucket].replace(/[^0-9a-z]+/gi, '-')}-${ymdLocal()}.csv`, [
      ['associate', 'client', 'item', 'kind', 'expires', 'days_until'],
      ...filtered.map((i) => [
        i.subject.associateName ?? '',
        i.subject.clientName ?? '',
        i.label,
        i.kind,
        i.expiresAt.slice(0, 10),
        String(i.daysUntil),
      ]),
    ]);
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Expiring in {BUCKET_LABEL[bucket]}</DrawerTitle>
        <DrawerDescription>
          {items.length} item{items.length === 1 ? '' : 's'} — every row deep-links the surface
          that renews it.
        </DrawerDescription>
      </DrawerHeader>
      <div className="px-4 pb-2 space-y-2">
        <div className="flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name, item, or client…"
            aria-label="Filter expiring items"
          />
          <Button size="xs" variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="h-3 w-3" />
            CSV
          </Button>
        </div>
        {kinds.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <FilterChip active={kindFilter === ''} onClick={() => setKindFilter('')}>
              All kinds
            </FilterChip>
            {kinds.map((k) => (
              <FilterChip key={k} active={kindFilter === k} onClick={() => setKindFilter(k)}>
                {k.replace(/_/g, ' ').toLowerCase()}
              </FilterChip>
            ))}
          </div>
        )}
      </div>
      <DrawerBody>
        {filtered.length === 0 ? (
          <EmptyState size="sm" title={"Nothing matches this filter."} />
        ) : (
          <ul className="space-y-1">
            {filtered.map((it, i) => {
              const link = expirationFixLink(it.kind, it.subject.associateId);
              const row = (
                <>
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">
                      {it.subject.associateName ?? it.label}
                    </div>
                    <div className="text-2xs text-silver truncate">
                      {it.label}
                      {it.subject.clientName ? ` · ${it.subject.clientName}` : ''}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'text-xs tabular-nums shrink-0',
                      it.daysUntil <= 7 ? 'text-alert font-semibold' : 'text-silver',
                    )}
                  >
                    {fmtDate(it.expiresAt)} · {it.daysUntil}d
                  </span>
                </>
              );
              return (
                <li key={`${it.kind}-${it.subject.associateId}-${i}`}>
                  {link ? (
                    <Link
                      to={link}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-navy-secondary hover:bg-navy-secondary/40"
                    >
                      {row}
                    </Link>
                  ) : (
                    <span className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-navy-secondary">
                      {row}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DrawerBody>
    </Drawer>
  );
}

/* ----------------------------- TILE 3 ----------------------------- */

function ShiftsTile({ refreshEpoch, clientId }: { refreshEpoch: number; clientId: string }) {
  const fetcher = useCallback(
    () => getScorecardShifts(clientId || undefined),
    [clientId],
  );
  const { data, error, stale } = useTileData(['shifts', clientId], fetcher, refreshEpoch);

  return (
    <TileShell
      icon={<TrendingUp className="h-4 w-4" />}
      title="Shift compliance"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
      stale={stale}
    >
      {data && (
        <div className="space-y-2">
          <p className="text-xs2 text-silver">Window: last {data.windowDays} days</p>
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
                <span className="text-xs2 text-silver/80 shrink-0">No data in window</span>
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

function BillingTile({ refreshEpoch, clientId }: { refreshEpoch: number; clientId: string }) {
  const fetcher = useCallback(
    () => getScorecardBilling(clientId || undefined),
    [clientId],
  );
  const { data, error, stale } = useTileData(['billing', clientId], fetcher, refreshEpoch);
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [drawerSignal, setDrawerSignal] =
    useState<ManualAttestationSignal | null>(null);
  const [localSignals, setLocalSignals] = useState<
    ManualAttestationSignal[] | null
  >(null);

  const mismatches = useMemo(
    () => data?.rateChecks.filter((r) => r.expectedRate !== null && !r.match) ?? [],
    [data],
  );

  // Local copy lets the drawer optimistically replace a signal after the
  // upsert returns, without waiting for the next 15-min tile refresh.
  const signals = localSignals ?? data?.attestations ?? [];

  const applyUpdated = useCallback(
    (updated: ManualAttestationSignal) => {
      setLocalSignals((prev) => {
        const base = prev ?? data?.attestations ?? [];
        return base.map((s) => (s.key === updated.key ? updated : s));
      });
    },
    [data],
  );
  const { attestingKey, quickAttest } = useQuickAttest(applyUpdated);

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
          <div className="text-2xs uppercase tracking-widest text-silver/80 mb-1">
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
                <li key={r.jobId} className="text-xs">
                  <Link
                    to={`/clients/${r.clientId}`}
                    className="flex items-center justify-between gap-2 rounded px-1 -mx-1 py-0.5 hover:bg-navy-secondary/40"
                  >
                    <span className="text-white truncate">
                      {r.clientName} / {r.jobName}
                    </span>
                    <span className="tabular-nums text-alert shrink-0">
                      ${r.billRate.toFixed(2)} ≠ ${r.expectedRate?.toFixed(2)}
                    </span>
                  </Link>
                </li>
              ))}
              {mismatches.length > 6 && (
                <li className="text-2xs text-silver/80">+{mismatches.length - 6} more</li>
              )}
            </ul>
          )}
          {/* Honesty line: "all matched" only counts jobs a SOW pattern
              recognizes — say how many the check actually had an opinion on. */}
          <p className="text-2xs text-silver/70 mt-1">
            {data.rateChecks.filter((r) => r.expectedRate !== null).length} of{' '}
            {data.rateChecks.length} active jobs matched a SOW rate pattern
            {data.rateChecks.some((r) => r.expectedRate === null) &&
              ' — the rest carry no contractual expectation'}
            .
          </p>

          <div className="mt-3 pt-3 border-t border-navy-secondary">
            <div className="text-2xs uppercase tracking-widest text-silver/80 mb-1.5">
              Invoice forfeiture watch (90-day MSA window)
            </div>
            {data.atRiskStatements.length === 0 ? (
              <div className="text-xs text-success flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5" />
                No unpaid statement is older than 60 days
                {data.unpaidFinalCount > 0 &&
                  ` (${data.unpaidFinalCount} outstanding, all younger)`}
                .
              </div>
            ) : (
              <ul className="space-y-1">
                {data.atRiskStatements.slice(0, 6).map((s) => (
                  <li key={s.statementId} className="text-xs">
                    <Link
                      to={`/clients/${s.clientId}`}
                      className="flex items-center justify-between gap-2 rounded px-1 -mx-1 py-0.5 hover:bg-navy-secondary/40"
                    >
                      <span className="text-white truncate">
                        {s.clientName} · statement {fmtStatementNo(s.number)}
                        {s.amount !== null && (
                          <span className="text-silver/80">
                            {' '}· ${s.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </span>
                        )}
                      </span>
                      <span
                        className={cn(
                          'tabular-nums shrink-0 font-semibold',
                          s.daysToForfeit <= 5 ? 'text-alert' : 'text-warning',
                        )}
                      >
                        {s.daysToForfeit < 0
                          ? `${-s.daysToForfeit}d past window`
                          : `${s.daysToForfeit}d to forfeit`}
                      </span>
                    </Link>
                  </li>
                ))}
                {data.atRiskStatements.length > 6 && (
                  <li className="text-2xs text-silver/80">
                    +{data.atRiskStatements.length - 6} more
                  </li>
                )}
              </ul>
            )}
          </div>
          {signals.length > 0 && (
            <div className="mt-3 pt-3 border-t border-navy-secondary">
              <div className="text-2xs uppercase tracking-widest text-silver/80 mb-1.5">
                Manual attestations
              </div>
              <ul className="space-y-1.5">
                {signals.map((s) => (
                  <AttestationRow
                    key={s.key}
                    signal={s}
                    canManage={canManage}
                    onClick={() => setDrawerSignal(s)}
                    attesting={attestingKey === s.key}
                    onQuickAttest={
                      canManage && !s.current && s.status !== 'attested'
                        ? () => void quickAttest(s)
                        : null
                    }
                  />
                ))}
              </ul>
            </div>
          )}
          <AttestationDrawer
            signal={drawerSignal}
            canManage={canManage}
            onClose={() => setDrawerSignal(null)}
            onSaved={(updated) => {
              applyUpdated(updated);
              setDrawerSignal(null);
            }}
          />
        </>
      )}
    </TileShell>
  );
}

/**
 * One-click attest with the drawer's fresh-form defaults: outcome YES,
 * action taken today, no notes. Offered only on rows with no current
 * attestation (the drawer would pre-fill from `current` otherwise, so the
 * defaults would diverge from what it submits). NO / N/A / notes still go
 * through the drawer.
 */
function useQuickAttest(
  applyUpdated: (updated: ManualAttestationSignal) => void,
) {
  const [attestingKey, setAttestingKey] = useState<string | null>(null);
  const quickAttest = async (signal: ManualAttestationSignal) => {
    setAttestingKey(signal.key);
    try {
      // Same date construction as AttestationDrawer's submit path.
      const today = new Date().toISOString().slice(0, 10);
      const r = await upsertAttestation({
        key: signal.key,
        periodStart: signal.periodStart,
        outcome: 'YES',
        actionTakenAt: new Date(`${today}T12:00:00Z`).toISOString(),
        notes: null,
        evidenceDocumentId: signal.current?.evidenceDocumentId ?? null,
      });
      applyUpdated(r.signal);
      toast.success(`${signal.label} attested.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Attest failed.');
    } finally {
      setAttestingKey(null);
    }
  };
  return { attestingKey, quickAttest };
}

function AttestationRow({
  signal,
  canManage,
  onClick,
  attesting,
  onQuickAttest,
}: {
  signal: ManualAttestationSignal;
  canManage: boolean;
  onClick: () => void;
  attesting: boolean;
  onQuickAttest: (() => void) | null;
}) {
  const status = signal.status;
  const Icon =
    status === 'attested'
      ? CheckCircle2
      : status === 'overdue'
        ? AlertTriangle
        : Clock;
  const colorClass =
    status === 'attested'
      ? 'text-success'
      : status === 'overdue'
        ? 'text-alert'
        : status === 'due_soon'
          ? 'text-warning'
          : 'text-silver/70';

  const statusText = (() => {
    if (status === 'attested' && signal.current) {
      const at = signal.current.actionTakenAt
        ? fmtDate(signal.current.actionTakenAt)
        : 'date not recorded';
      return `Done ${at} by ${signal.current.attestedByEmail}`;
    }
    if (status === 'overdue') {
      const due = new Date(signal.dueDate);
      const now = new Date();
      const days = Math.max(
        1,
        Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)),
      );
      return `Overdue by ${days} day${days === 1 ? '' : 's'} (was due ${fmtDate(parseYmd(signal.dueDate))})`;
    }
    return `Due ${fmtDate(parseYmd(signal.dueDate))}`;
  })();

  return (
    // The quick-attest button is a SIBLING of the row button, not a child —
    // nested <button>s are invalid HTML and break click targets.
    <li className="flex items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={!canManage}
        className={cn(
          'flex-1 min-w-0 text-left flex items-start gap-2 px-2 py-1.5 rounded text-xs',
          canManage && 'hover:bg-navy-secondary/40 cursor-pointer',
          !canManage && 'cursor-default',
        )}
        title={canManage ? 'Click to attest' : 'View only — manage:compliance required'}
      >
        <Icon className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', colorClass)} />
        <div className="min-w-0 flex-1">
          <div className="text-white truncate">{signal.label}</div>
          <div className={cn('truncate', colorClass)}>{statusText}</div>
        </div>
      </button>
      {canManage && (status === 'overdue' || status === 'due_soon') && <SnoozeControl signal={signal} />}
      {onQuickAttest && (
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0 mt-0.5 text-silver hover:text-success"
          onClick={onQuickAttest}
          loading={attesting}
          title="Attest now: Yes, action taken today. Open the row for notes or other outcomes."
        >
          Attest
          <Check className="h-3 w-3" aria-hidden="true" />
        </Button>
      )}
    </li>
  );
}

/**
 * Put this attestation's daily reminder off — for one you're handling
 * elsewhere. The digest leaves it out until the date; a new period starts
 * with reminders on again.
 */
function SnoozeControl({ signal }: { signal: ManualAttestationSignal }) {
  const [until, setUntil] = useState<string | null>(signal.snoozedUntil ?? null);
  const [busy, setBusy] = useState(false);
  const snooze = async (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    setBusy(true);
    try {
      const r = await snoozeAttestation(signal.key, ymdLocal(d));
      setUntil(r.snoozedUntil);
      toast.success(`Reminders for “${signal.label}” are off until ${fmtDate(r.snoozedUntil)}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not snooze it.');
    } finally {
      setBusy(false);
    }
  };
  const wake = async () => {
    setBusy(true);
    try {
      await unsnoozeAttestation(signal.key);
      setUntil(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not turn reminders back on.');
    } finally {
      setBusy(false);
    }
  };
  if (until && new Date(until) > new Date()) {
    return (
      <Button size="xs" variant="ghost" className="shrink-0 mt-0.5 text-silver" loading={busy} onClick={() => void wake()} title="Turn the daily reminder back on">
        Snoozed to {fmtDate(until)}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="ghost" className="shrink-0 mt-0.5 text-silver" loading={busy} title="Put the daily reminder off">
          Snooze
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void snooze(3)}>3 days</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void snooze(7)}>1 week</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void snooze(14)}>2 weeks</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const OUTCOME_LABELS: Record<ManualAttestationOutcome, string> = {
  YES: 'Yes',
  NO: 'No',
  NOT_APPLICABLE: 'N/A',
};

function AttestationDrawer({
  signal,
  canManage,
  onClose,
  onSaved,
}: {
  signal: ManualAttestationSignal | null;
  canManage: boolean;
  onClose: () => void;
  onSaved: (updated: ManualAttestationSignal) => void;
}) {
  const [outcome, setOutcome] = useState<ManualAttestationOutcome>('YES');
  const [actionTakenAt, setActionTakenAt] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when a new signal is targeted; pre-fill from existing
  // attestation so re-attesting feels like editing, not starting over.
  useEffect(() => {
    if (!signal) return;
    if (signal.current) {
      setOutcome(signal.current.outcome);
      setActionTakenAt(
        signal.current.actionTakenAt
          ? signal.current.actionTakenAt.slice(0, 10)
          : '',
      );
      setNotes(signal.current.notes ?? '');
    } else {
      setOutcome('YES');
      // Pre-fill action date with today (most common case).
      setActionTakenAt(new Date().toISOString().slice(0, 10));
      setNotes('');
    }
    setError(null);
  }, [signal]);

  if (!signal) return null;

  const submit = async () => {
    if (!canManage) return;
    if (outcome !== 'NOT_APPLICABLE' && !actionTakenAt) {
      setError('Action date is required when outcome is Yes or No.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await upsertAttestation({
        key: signal.key,
        periodStart: signal.periodStart,
        outcome,
        actionTakenAt:
          outcome === 'NOT_APPLICABLE' || !actionTakenAt
            ? null
            : new Date(`${actionTakenAt}T12:00:00Z`).toISOString(),
        notes: notes.trim() || null,
        // Preserve any evidence already attached (e.g. via API/backfill)
        // instead of nulling it out on every re-attestation. New-file
        // upload is not offered here: POST /documents/admin/upload
        // strictly requires an associateId, and these attestations are
        // organization/client-scoped — they carry no associate subject.
        evidenceDocumentId: signal.current?.evidenceDocumentId ?? null,
      });
      // Same confirmation the quick-attest path gives — the drawer closes
      // on save, so without a toast success was indistinguishable from a
      // silent dismissal.
      toast.success(`${signal.label} attested.`);
      onSaved(r.signal);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{signal.label}</DrawerTitle>
        <DrawerDescription>{signal.description}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="text-xs text-silver/80 mb-3">
          Period:{' '}
          <span className="text-white">
            {fmtDate(parseYmd(signal.periodStart))} →{' '}
            {fmtDate(parseYmd(signal.periodEnd))}
          </span>{' '}
          · due {fmtDate(parseYmd(signal.dueDate))}
        </div>

        {signal.previous && (
          <div className="rounded border border-navy-secondary bg-navy-secondary/30 p-2.5 text-xs mb-4">
            <div className="text-silver/70">
              Previous period ({fmtDate(parseYmd(signal.previous.periodStart))} →{' '}
              {fmtDate(parseYmd(signal.previous.periodEnd))})
            </div>
            <div className="text-white mt-0.5">
              {OUTCOME_LABELS[signal.previous.outcome]}
              {signal.previous.actionTakenAt && (
                <>
                  {' '}
                  · action taken{' '}
                  {fmtDate(signal.previous.actionTakenAt)}
                </>
              )}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <Label>Outcome</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {(['YES', 'NO', 'NOT_APPLICABLE'] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => canManage && setOutcome(o)}
                  disabled={!canManage}
                  className={cn(
                    'px-3 py-1.5 rounded text-xs border',
                    outcome === o
                      ? o === 'YES'
                        ? 'border-success text-success bg-success/10'
                        : o === 'NO'
                          ? 'border-alert text-alert bg-alert/10'
                          : 'border-silver text-silver bg-silver/10'
                      : 'border-navy-secondary text-silver/70 hover:text-white',
                  )}
                >
                  {OUTCOME_LABELS[o]}
                </button>
              ))}
            </div>
          </div>
          {outcome !== 'NOT_APPLICABLE' && (
            <div>
              <Label htmlFor="actionTakenAt">Date the action was taken</Label>
              <Input
                id="actionTakenAt"
                type="date"
                value={actionTakenAt}
                onChange={(e) => setActionTakenAt(e.target.value)}
                disabled={!canManage}
                className="mt-1"
              />
            </div>
          )}
          <div>
            <Label htmlFor="attestationNotes">Notes (optional)</Label>
            <Textarea
              id="attestationNotes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={!canManage}
              rows={3}
              placeholder="e.g. submitted with adjusted hours for J. Smith"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Evidence</Label>
            {signal.current?.evidenceDocumentId ? (
              <a
                href={downloadDocumentUrl(signal.current.evidenceDocumentId)}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1.5 text-xs text-gold hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View evidence document
              </a>
            ) : (
              <p className="mt-1 text-xs2 text-silver/70">
                No evidence document attached.
                {canManage &&
                  ' File upload is not available for these organization-scoped attestations yet — admin document uploads must be attached to an associate.'}
              </p>
            )}
          </div>
        </div>

        {error && (
          <p role="alert" className="text-xs text-alert mt-3">
            {error}
          </p>
        )}
      </DrawerBody>
      <div className="border-t border-navy-secondary p-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {canManage && (
          <Button onClick={submit} loading={saving}>
            {signal.current ? 'Update attestation' : 'Save attestation'}
          </Button>
        )}
      </div>
    </Drawer>
  );
}

/* ----------------------------- TILE 5 ----------------------------- */

function TrainingTile({ refreshEpoch, clientId }: { refreshEpoch: number; clientId: string }) {
  // Local bump so a bulk enroll refreshes this tile without waiting on the
  // page-wide 15-minute epoch.
  const [bump, setBump] = useState(0);
  const fetcher = useCallback(
    () => getScorecardTraining(clientId || undefined),
    [clientId],
  );
  const { data, error, stale } = useTileData(['training', clientId], fetcher, refreshEpoch + bump);
  const [drawerSignal, setDrawerSignal] = useState<ScorecardTrainingSignal | null>(null);
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [enrolling, setEnrolling] = useState(false);

  // Enroll EVERY missing associate into the tag's published course via the
  // existing LMS endpoint (max 500 ids per call — chunked). One enrollment
  // system, one notification path.
  const enrollAllMissing = async (signal: ScorecardTrainingSignal) => {
    const course = signal.courses[0];
    if (!course || signal.missingIds.length === 0) return;
    setEnrolling(true);
    try {
      let created = 0;
      let skipped = 0;
      for (let i = 0; i < signal.missingIds.length; i += 500) {
        const r = await enrollAssociates(course.id, signal.missingIds.slice(i, i + 500));
        created += r.created;
        skipped += r.skipped;
      }
      toast.success(
        `Enrolled ${created} associate${created === 1 ? '' : 's'} in “${course.title}”` +
          (skipped > 0 ? ` (${skipped} already enrolled)` : '') +
          '.',
      );
      setDrawerSignal(null);
      setBump((b) => b + 1);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Enrollment failed.');
    } finally {
      setEnrolling(false);
    }
  };

  const exportMissingCsv = (signal: ScorecardTrainingSignal) => {
    const rows: Array<Array<string>> = [
      ['associate', 'client'],
      ...signal.missing.map((m) => [m.associateName ?? '', m.clientName ?? '']),
    ];
    if (signal.missingIds.length > signal.missing.length) {
      rows.push([
        `NOTE: showing ${signal.missing.length} of ${signal.missingIds.length} missing (display cap) — "Enroll all missing" still covers everyone.`,
        '',
      ]);
    }
    downloadCsv(`missing-training-${signal.tag.toLowerCase()}-${ymdLocal()}.csv`, rows);
  };

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
              // The clause and the list are sibling controls (never a button
              // inside a button); a signal with nothing to measure is text.
              return s.status === 'live' ? (
                <div
                  key={s.tag}
                  className="group w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded min-w-0 hover:bg-navy-secondary/40"
                >
                  <ClauseTooltip clause={s.contractClause}>
                    <span className="text-xs text-ink truncate">{s.label}</span>
                  </ClauseTooltip>
                  <button
                    type="button"
                    onClick={() => setDrawerSignal(s)}
                    aria-label={`${s.label}: ${s.completedCount} of ${s.totalAssociates}. See who is missing it`}
                    className="flex flex-1 items-center justify-end gap-2 shrink-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                  >
                    <span className="text-xs2 text-silver tabular-nums hidden sm:inline">
                      {s.completedCount}/{s.totalAssociates} ({pct}%)
                    </span>
                    <span className="text-xs2 text-silver tabular-nums sm:hidden">
                      {pct}%
                    </span>
                    <PctBar pct={pct} severity={pctSeverity(pct)} />
                    <ChevronRight className="h-3.5 w-3.5 text-silver/70 group-hover:text-silver" />
                  </button>
                </div>
              ) : (
                <div key={s.tag} className="w-full flex items-center justify-between gap-2 px-2 py-1.5 min-w-0">
                  <span className="text-xs text-ink truncate">{s.label}</span>
                  <Badge variant="outline">
                    {s.status === 'no_course' ? 'No course linked' : 'No enrollments'}
                  </Badge>
                </div>
              );
            })}
          </div>
          {data.signals.some((s) => s.status === 'no_course') && (
            <p className="text-2xs text-silver/80 mt-2">
              “No course linked” means no Learning course covers this training yet.{' '}
              <Link to="/learning" className="text-gold underline underline-offset-2">
                Link a course in Learning
              </Link>{' '}
              to start tracking it.
            </p>
          )}

          <Drawer open={drawerSignal !== null} onOpenChange={(o) => !o && setDrawerSignal(null)}>
            <DrawerHeader>
              <DrawerTitle>{drawerSignal?.label ?? ''}</DrawerTitle>
              <DrawerDescription>{drawerSignal?.contractClause ?? ''}</DrawerDescription>
            </DrawerHeader>
            {drawerSignal && drawerSignal.missingIds.length > 0 && (
              <div className="px-4 pb-2 flex flex-wrap items-center gap-2">
                <Button size="xs" variant="outline" onClick={() => exportMissingCsv(drawerSignal)}>
                  <Download className="h-3 w-3" />
                  Export CSV
                </Button>
                {canManage && drawerSignal.courses.length > 0 && (
                  <Button
                    size="xs"
                    variant="outline"
                    loading={enrolling}
                    onClick={() => void enrollAllMissing(drawerSignal)}
                    title={`Enroll every missing associate in “${drawerSignal.courses[0].title}” — each gets the standard enrollment notification`}
                  >
                    Enroll all {drawerSignal.missingIds.length} missing
                  </Button>
                )}
                {canManage && drawerSignal.courses.length === 0 && (
                  <span className="text-2xs text-silver/70">
                    Publish a course with this tag to enable one-click enrollment.
                  </span>
                )}
              </div>
            )}
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
                        <div className="text-2xs text-silver">{m.clientName ?? '—'}</div>
                      </div>
                      {m.associateId && (
                        <Link
                          to={`/people?associateId=${m.associateId}`}
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

/* ----------------------------- TILE 7 ----------------------------- */
// Reads the Phase 88 OSHA injury log (OshaIncident). Incidents are logged
// and resolved on /compliance/osha — this tile adds the rates (TRIR/DART
// vs real hours), the days-since sign, and the 300A posting attestation.

const SEVERITY_LABEL: Record<OshaIncidentSeverity, string> = {
  FIRST_AID: 'First aid',
  MEDICAL_TREATMENT: 'Medical treatment',
  RESTRICTED_DUTY: 'Restricted duty',
  DAYS_AWAY: 'Days away from work',
  FATAL: 'Fatality',
};

const INCIDENT_STATUS_LABEL: Record<string, string> = {
  REPORTED: 'Reported',
  INVESTIGATING: 'Investigating',
  ESCALATED: 'Escalated',
  RESOLVED: 'Resolved',
};

function SafetyTile({ refreshEpoch, clientId }: { refreshEpoch: number; clientId: string }) {
  const fetcher = useCallback(
    () => getScorecardSafety(clientId || undefined),
    [clientId],
  );
  const { data, error, stale } = useTileData(['safety', clientId], fetcher, refreshEpoch);

  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;

  // 300A attestation — same optimistic-signal pattern as the other tiles.
  const [attSignal, setAttSignal] = useState<ManualAttestationSignal | null>(null);
  const [localSignals, setLocalSignals] = useState<ManualAttestationSignal[] | null>(null);
  const signals = localSignals ?? data?.attestations ?? [];
  const applyUpdated = useCallback(
    (updated: ManualAttestationSignal) => {
      setLocalSignals((prev) => {
        const base = prev ?? data?.attestations ?? [];
        return base.map((s) => (s.key === updated.key ? updated : s));
      });
    },
    [data],
  );
  const { attestingKey, quickAttest } = useQuickAttest(applyUpdated);

  return (
    <TileShell
      icon={<HardHat className="h-4 w-4" />}
      title="Safety (OSHA)"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
      stale={stale}
    >
      {data && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 items-start">
            {/* The factory sign. */}
            <div className="rounded border border-navy-secondary bg-navy-secondary/20 px-4 py-5 text-center">
              <div
                className={cn(
                  'text-4xl font-bold tabular-nums leading-none',
                  data.daysSinceLastRecordable === null || data.daysSinceLastRecordable >= 30
                    ? 'text-success'
                    : data.daysSinceLastRecordable >= 7
                      ? 'text-warning'
                      : 'text-alert',
                )}
              >
                {data.daysSinceLastRecordable ?? '—'}
              </div>
              <div className="text-2xs uppercase tracking-widest text-silver/80 mt-2">
                Days since last recordable
              </div>
              {data.daysSinceLastRecordable === null && (
                <div className="text-2xs text-silver/70 mt-1">
                  No recordable incident on file.
                </div>
              )}
            </div>

            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 flex-1">
                  {data.trir !== null && !oshaRateMeaningful(data.hoursWorkedYtd) ? (
                    // One case on a few thousand hours reads as a TRIR in the
                    // hundreds: below the threshold the rate is noise, so the
                    // tile says so instead of printing it in red.
                    <div className="col-span-2">
                      <div className="text-sm font-semibold text-ink leading-tight">
                        {data.recordableCountYtd} {data.recordableCountYtd === 1 ? 'recordable' : 'recordables'} · rates shown after{' '}
                        {OSHA_RATE_MIN_HOURS.toLocaleString('en-US')} h
                      </div>
                      <div className="text-2xs text-silver/80">
                        TRIR and DART need enough hours to mean something; {Math.round(data.hoursWorkedYtd).toLocaleString('en-US')} worked so far this year.
                      </div>
                    </div>
                  ) : (
                  <>
                  <SafetyStat
                    label={`TRIR (target ≤ ${OSHA_TRIR_TARGET})`}
                    value={data.trir === null ? '—' : String(data.trir)}
                    tone={
                      data.trir === null
                        ? 'text-silver'
                        : data.trir > OSHA_TRIR_TARGET
                          ? 'text-alert'
                          : 'text-success'
                    }
                  />
                  <SafetyStat
                    label={`DART (target ≤ ${OSHA_DART_TARGET})`}
                    value={data.dart === null ? '—' : String(data.dart)}
                    tone={
                      data.dart === null
                        ? 'text-silver'
                        : data.dart > OSHA_DART_TARGET
                          ? 'text-alert'
                          : 'text-success'
                    }
                  />
                  </>
                  )}
                  <SafetyStat
                    label="Recordables YTD"
                    value={String(data.recordableCountYtd)}
                    tone={data.recordableCountYtd > 0 ? 'text-warning' : 'text-success'}
                  />
                  <SafetyStat
                    label="Hours worked YTD"
                    value={Math.round(data.hoursWorkedYtd).toLocaleString()}
                    tone="text-white"
                  />
                </div>
                {canManage && (
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/compliance/osha">
                      <Plus className="h-3.5 w-3.5" />
                      Log incident
                    </Link>
                  </Button>
                )}
              </div>
              {data.trir === null && (
                <p className="text-2xs text-silver/70 mb-2">
                  TRIR/DART need hours worked — rates appear once time entries exist for this year.
                </p>
              )}

              <div className="flex items-center justify-between mb-1">
                <span className="text-2xs uppercase tracking-widest text-silver/80">
                  Unresolved incidents
                </span>
                <Link
                  to="/compliance/osha"
                  className="text-2xs text-gold hover:underline"
                >
                  Full injury log →
                </Link>
              </div>
              {data.openIncidents.length === 0 ? (
                <div className="text-xs text-success flex items-center gap-2 py-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  No unresolved incidents.
                </div>
              ) : (
                <ul className="space-y-1">
                  {data.openIncidents.map((inc) => (
                    <li key={inc.id}>
                      <Link
                        to="/compliance/osha"
                        className={cn(
                          'flex items-center justify-between gap-2 px-2 py-1.5 rounded border hover:bg-navy-secondary/40',
                          inc.isRecordable ? 'border-alert/50 bg-alert/5' : 'border-navy-secondary',
                        )}
                      >
                        <div className="min-w-0">
                          <div className="text-xs text-white truncate">
                            {inc.associateName ?? '—'}
                            <span className="text-silver/80"> · {SEVERITY_LABEL[inc.severity]}</span>
                            {inc.isRecordable && (
                              <span className="ml-1.5 inline-flex rounded bg-alert/15 px-1 py-px text-2xs font-semibold text-alert align-middle">
                                Recordable
                              </span>
                            )}
                            <span className="ml-1.5 inline-flex rounded bg-navy-secondary px-1 py-px text-2xs text-silver align-middle">
                              {INCIDENT_STATUS_LABEL[inc.status] ?? inc.status}
                            </span>
                          </div>
                          <div className="text-2xs text-silver/80 truncate">
                            {fmtDate(inc.occurredAt)}
                            {inc.location ? ` · ${inc.location}` : ''}
                            {inc.clientName ? ` · ${inc.clientName}` : ''}
                          </div>
                        </div>
                        <span className="text-xs2 text-gold flex items-center gap-1 shrink-0">
                          Manage <ExternalLink className="h-3 w-3" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {signals.length > 0 && (
                <div className="mt-3 pt-3 border-t border-navy-secondary">
                  <div className="text-2xs uppercase tracking-widest text-silver/80 mb-1.5">
                    Annual attestations
                  </div>
                  <ul className="space-y-1.5">
                    {signals.map((s) => (
                      <AttestationRow
                        key={s.key}
                        signal={s}
                        canManage={canManage}
                        onClick={() => setAttSignal(s)}
                        attesting={attestingKey === s.key}
                        onQuickAttest={
                          canManage && !s.current && s.status !== 'attested'
                            ? () => void quickAttest(s)
                            : null
                        }
                      />
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          <AttestationDrawer
            signal={attSignal}
            canManage={canManage}
            onClose={() => setAttSignal(null)}
            onSaved={(updated) => {
              applyUpdated(updated);
              setAttSignal(null);
            }}
          />
        </>
      )}
    </TileShell>
  );
}

function SafetyStat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <div className={cn('text-lg font-bold tabular-nums leading-tight', tone)}>{value}</div>
      <div className="text-2xs text-silver/80">{label}</div>
    </div>
  );
}

/* ----------------------------- TILE 6 ----------------------------- */

type ActionFilter = 'all' | 'critical' | 'warn';

/** Action ids are prefixed by the tile that generated them. */
const ACTION_SOURCE_LABEL: Record<string, string> = {
  onb: 'Onboarding',
  exp: 'Expirations',
  shf: 'Shifts',
  bil: 'Billing',
  trn: 'Training',
  saf: 'Safety',
};
const actionSource = (id: string): string => id.split(':')[0] ?? '';

function ActionsTile({ refreshEpoch, clientId }: { refreshEpoch: number; clientId: string }) {
  const fetcher = useCallback(
    () => getScorecardActions(clientId || undefined),
    [clientId],
  );
  const { data, error, stale } = useTileData(['actions', clientId], fetcher, refreshEpoch);
  const [filter, setFilter] = useState<ActionFilter>('all');
  const [sourceFilter, setSourceFilter] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [shown, setShown] = useState(ACTIONS_PAGE);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [shownPeople, setShownPeople] = useState<Record<string, number>>({});
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;

  // Optimistic per-action state overlay: mutations land here instantly and
  // the next refresh (server truth) supersedes it. DONE/SNOOZED rows stay
  // visible-but-dimmed until then so the click has a visible receipt.
  const [localStates, setLocalStates] = useState<Record<string, ScorecardActionState>>({});
  const [busy, setBusy] = useState<Set<string>>(() => new Set());

  // A new dataset (scope change / refetch) resets the overlay — the server
  // list already reflects every persisted state.
  useEffect(() => {
    setLocalStates({});
  }, [data]);
  // A new filter starts at the first page.
  useEffect(() => {
    setShown(ACTIONS_PAGE);
  }, [filter, sourceFilter, mineOnly, clientId]);

  type Patch = { status?: 'OPEN' | 'SNOOZED' | 'DONE'; assigneeUserId?: string | null; snoozedUntil?: string | null };
  /** One or many actions; the toast says how many landed. */
  const mutateStates = async (ids: string[], patch: Patch, success: (n: number) => string) => {
    setBusy((prev) => new Set([...prev, ...ids]));
    let ok = 0;
    let failure: string | null = null;
    try {
      // Ten at a time: a signal can hold 100 people.
      for (let i = 0; i < ids.length; i += 10) {
        const results = await Promise.allSettled(
          ids.slice(i, i + 10).map((actionId) => setScorecardActionState({ actionId, ...patch })),
        );
        const landed: Record<string, ScorecardActionState> = {};
        results.forEach((r, k) => {
          if (r.status === 'fulfilled') {
            ok += 1;
            landed[ids[i + k]!] = r.value.state;
          } else if (!failure) {
            failure = r.reason instanceof ApiError ? r.reason.message : 'Update failed.';
          }
        });
        setLocalStates((prev) => ({ ...prev, ...landed }));
      }
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
    if (ok > 0) toast.success(success(ok));
    if (failure) toast.error(failure);
  };
  const snoozePatch = (): Patch => ({
    status: 'SNOOZED',
    snoozedUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  const stateFor = (a: { id: string; state?: ScorecardActionState | null }) =>
    localStates[a.id] ?? a.state ?? null;

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.actions.filter((a) => {
      if (filter !== 'all' && a.severity !== filter) return false;
      if (sourceFilter && actionSource(a.id) !== sourceFilter) return false;
      if (mineOnly && stateFor(a)?.assigneeUserId !== user?.id) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filter, sourceFilter, mineOnly, localStates, user]);
  const entries = useMemo(() => groupScorecardActions(filtered), [filtered]);
  const visible = entries.slice(0, shown);

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of data?.actions ?? []) {
      const s = actionSource(a.id);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return counts;
  }, [data]);

  // Client-side CSV of the currently filtered list — no extra endpoint.
  const exportCsv = () => {
    if (filtered.length === 0) return;
    const rows = [
      ['severity', 'source', 'title', 'contract_clause', 'associate', 'client', 'status', 'assignee', 'link'],
      ...filtered.map((a) => {
        const st = stateFor(a);
        return [
          a.severity,
          ACTION_SOURCE_LABEL[actionSource(a.id)] ?? actionSource(a.id),
          a.title,
          a.contractClause,
          a.subject.associateName ?? '',
          a.subject.clientName ?? '',
          st?.status ?? 'OPEN',
          st?.assigneeEmail ?? '',
          a.link ?? '',
        ];
      }),
    ];
    // An export that silently stops at the response cap would misrepresent
    // the org's exposure — say so in the file itself.
    if (data?.truncated) {
      rows.push([
        '',
        '',
        `NOTE: list truncated — showing ${data.actions.length} of ${data.totalActionCount} open actions. Narrow by client or fix criticals to see the rest.`,
        '', '', '', '', '', '',
      ]);
    }
    downloadCsv(`compliance-open-actions-${ymdLocal()}.csv`, rows);
  };

  /** The ⋯ menu of one action: assign, snooze, done. Fix stays outside it. */
  const rowMenu = (a: ScorecardAction, label: string) => {
    const st = stateFor(a);
    const resolved = st && (st.status === 'DONE' || st.status === 'SNOOZED');
    if (!canManage || resolved) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="ghost" aria-label={`More for ${label}`} disabled={busy.has(a.id)}>
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!st?.assigneeUserId && user && (
            <DropdownMenuItem onSelect={() => void mutateStates([a.id], { assigneeUserId: user.id }, () => 'Assigned to you.')}>
              I've got it
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void mutateStates([a.id], snoozePatch(), () => 'Snoozed for 7 days.')}>
            Snooze 7 days
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void mutateStates([a.id], { status: 'DONE' }, () => 'Marked done.')}>
            Mark done
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const fixLink = (to: string | null, label: string) =>
    to ? (
      <Link
        to={to}
        className="inline-flex min-h-8 items-center gap-1 rounded px-1.5 text-xs2 text-gold hover:underline"
        aria-label={`Fix: ${label}`}
      >
        Fix <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </Link>
    ) : null;

  const stateLine = (st: ScorecardActionState | null) =>
    st && (st.assigneeEmail || st.status !== 'OPEN') ? (
      <div className="text-2xs mt-0.5 flex items-center gap-1.5 flex-wrap">
        {st.status === 'DONE' && (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircle2 className="h-3 w-3" /> Done
          </span>
        )}
        {st.status === 'SNOOZED' && st.snoozedUntil && (
          <span className="inline-flex items-center gap-1 text-warning">
            <Clock className="h-3 w-3" /> Snoozed until {fmtDate(st.snoozedUntil)}
          </span>
        )}
        {st.assigneeEmail && <span className="text-silver">→ {st.assigneeEmail}</span>}
      </div>
    ) : null;

  /** One action as a row: dot, what, then Fix and ⋯. Wraps under the text on a phone. */
  const actionRow = (a: ScorecardAction, opts: { inGroup?: boolean } = {}) => {
    const st = stateFor(a);
    const resolvedLocally = st && (st.status === 'DONE' || st.status === 'SNOOZED');
    const who = a.subject.associateName ?? a.title;
    const title = opts.inGroup ? who : a.title;
    const sub = opts.inGroup ? a.subject.clientName || null : a.contractClause;
    return (
      <li
        key={a.id}
        className={cn(
          'flex flex-wrap items-start gap-x-3 gap-y-1 py-2',
          opts.inGroup ? 'pl-8 pr-3' : 'px-3',
          resolvedLocally && 'opacity-50',
        )}
      >
        <div className="flex min-w-0 flex-1 basis-40 items-start gap-2">
          {!opts.inGroup && <SeverityDot severity={a.severity} />}
          <div className="min-w-0">
            <div className="text-xs text-ink break-words">{title}</div>
            {sub && <div className="text-2xs text-silver/80 break-words">{sub}</div>}
            {stateLine(st)}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {fixLink(a.link, title)}
          {rowMenu(a, title)}
        </div>
      </li>
    );
  };

  const groupRow = (g: Extract<ActionEntry, { kind: 'group' }>) => {
    const isOpen = open.has(g.key);
    const ids = g.actions
      .filter((a) => {
        const st = stateFor(a);
        return !(st && (st.status === 'DONE' || st.status === 'SNOOZED'));
      })
      .map((a) => a.id);
    const unassigned = g.actions.filter((a) => !stateFor(a)?.assigneeUserId).map((a) => a.id);
    const people = g.actions.length;
    const listId = `actions-${g.key.replace(/[^a-z0-9]+/gi, '-')}`;
    const peopleShown = shownPeople[g.key] ?? ACTIONS_PAGE;
    const setPeopleShown = (n: number) => setShownPeople((p) => ({ ...p, [g.key]: n }));
    return (
      <li key={g.key}>
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
          <button
            type="button"
            className="flex min-w-0 flex-1 basis-40 items-start gap-2 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            aria-expanded={isOpen}
            aria-controls={listId}
            onClick={() =>
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(g.key)) next.delete(g.key);
                else next.add(g.key);
                return next;
              })
            }
          >
            <SeverityDot severity={g.severity} />
            <span className="min-w-0">
              <span className="block text-xs text-ink break-words">
                {g.label} <span className="text-silver">· {plural(people, 'person', 'people')}</span>
              </span>
              <span className="block text-2xs text-silver/80 break-words">{g.actions[0]!.contractClause}</span>
            </span>
            <ChevronRight
              className={cn('ml-auto mt-0.5 h-3.5 w-3.5 shrink-0 text-silver transition-transform', isOpen && 'rotate-90')}
              aria-hidden="true"
            />
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {fixLink(g.link, g.label)}
            {canManage && ids.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="ghost" aria-label={`More for ${g.label}`} disabled={ids.some((id) => busy.has(id))}>
                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {user && unassigned.length > 0 && (
                    <DropdownMenuItem
                      onSelect={() =>
                        void mutateStates(unassigned, { assigneeUserId: user.id }, (n) => `Assigned ${plural(n, 'action', 'actions')} to you.`)
                      }
                    >
                      Assign all {unassigned.length} to me
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() => void mutateStates(ids, snoozePatch(), (n) => `Snoozed ${plural(n, 'action', 'actions')} for 7 days.`)}
                  >
                    Snooze all {ids.length} for 7 days
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {isOpen && (
          <ul id={listId} className="divide-y divide-navy-secondary/60 border-t border-navy-secondary/60 bg-navy-secondary/10">
            {g.actions.slice(0, peopleShown).map((a) => actionRow(a, { inGroup: true }))}
            {people > peopleShown && (
              <li className="py-2 pl-8 pr-3">
                <Button size="xs" variant="ghost" onClick={() => setPeopleShown(people)}>
                  Show all {people}
                </Button>
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Sparkles className="h-4 w-4 text-gold" />
            Open actions
            {/* The meaning lives in the visible text, not a tooltip —
                hover doesn't exist on the tablets these dashboards run on. */}
            {stale && (
              <span className="inline-flex items-center gap-1 text-2xs text-warning ml-1">
                <WifiOff className="h-3 w-3" />
                Stale — refresh failed
              </span>
            )}
          </div>
          {data && data.actions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} count={data.actions.length}>
                All
              </FilterChip>
              <FilterChip active={filter === 'critical'} onClick={() => setFilter('critical')} count={data.criticalCount}>
                Critical
              </FilterChip>
              <FilterChip active={filter === 'warn'} onClick={() => setFilter('warn')} count={data.warnCount}>
                Warn
              </FilterChip>
              <Button
                size="sm"
                variant="outline"
                className="ml-1"
                onClick={exportCsv}
                disabled={filtered.length === 0}
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </Button>
            </div>
          )}
        </div>
        {/* Second filter axis: which tile generated the action + "mine". */}
        {data && data.actions.length > 0 && (sourceCounts.size > 1 || canManage) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {sourceCounts.size > 1 && (
              <>
                <FilterChip active={sourceFilter === ''} onClick={() => setSourceFilter('')}>
                  All sources
                </FilterChip>
                {[...sourceCounts.entries()].map(([src, count]) => (
                  <FilterChip
                    key={src}
                    active={sourceFilter === src}
                    onClick={() => setSourceFilter(sourceFilter === src ? '' : src)}
                    count={count}
                  >
                    {ACTION_SOURCE_LABEL[src] ?? src}
                  </FilterChip>
                ))}
              </>
            )}
            {canManage && (
              <FilterChip active={mineOnly} onClick={() => setMineOnly((v) => !v)}>
                Assigned to me
              </FilterChip>
            )}
          </div>
        )}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!data && !error && <Skeleton className="h-32" />}
        {data && data.actions.length === 0 && (
          <div className="rounded-md border border-success/40 bg-success/10 px-4 py-6 flex flex-col items-center text-center">
            <CheckCircle2 className="h-6 w-6 text-success mb-2" />
            <div className="text-sm text-success font-medium">No open compliance actions</div>
            <div className="text-xs2 text-silver mt-0.5">
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
          <>
            <ul className="divide-y divide-navy-secondary border border-navy-secondary rounded" aria-label="Open actions">
              {visible.map((e) => (e.kind === 'group' ? groupRow(e) : actionRow(e.action)))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-silver/80">
              <span>
                {plural(filtered.length, 'action', 'actions')} in {plural(entries.length, 'row', 'rows')}
                {entries.length > shown ? ` · showing ${shown}` : ''}
                {data.truncated
                  ? ` · the list holds ${data.actions.length} of ${data.totalActionCount}; narrow by client or clear criticals to see the rest`
                  : ''}
              </span>
              {entries.length > shown && (
                <Button size="xs" variant="outline" onClick={() => setShown((n) => n + ACTIONS_PAGE)}>
                  Show {Math.min(ACTIONS_PAGE, entries.length - shown)} more
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
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
              <span className="inline-flex items-center gap-1 text-2xs text-warning">
                <WifiOff className="h-3 w-3" />
                Stale — refresh failed
              </span>
            )}
            <Badge variant={SEVERITY_BADGE[severity].variant}>
              {SEVERITY_BADGE[severity].label}
            </Badge>
          </div>
        </div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
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
      <div className="text-2xs uppercase tracking-wider">{label}</div>
    </div>
  );
}

/**
 * Dotted-underlined legal term that reveals its clause text on TAP or
 * click. This was a hover Tooltip, which made the clause unreachable on
 * touch devices — and the clause is the whole point of the underline.
 */
function ClauseTooltip({ clause, children }: { clause: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    // min-w-0 + truncate on the trigger: as an inline-block flex item the
    // label never shrank below its full text, so on a phone it shoved the
    // score (and its bar) off the right edge instead of ellipsizing.
    <span ref={ref} className="relative inline-flex min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="block min-w-0 max-w-full truncate cursor-help underline decoration-dotted decoration-silver/40 underline-offset-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-sm"
      >
        {children}
      </button>
      {open && (
        <span
          role="note"
          className="absolute left-0 top-full z-50 mt-1.5 block w-72 max-w-[80vw] rounded-md border border-navy-secondary bg-navy p-2.5 text-xs leading-relaxed text-silver elev-3"
        >
          {clause}
        </span>
      )}
    </span>
  );
}

/** The worst state among a block of attestations: overdue is critical,
 *  coming due is a warning. */
function attestationsSeverity(signals: ManualAttestationSignal[]): ScorecardSeverity {
  if (signals.some((s) => s.status === 'overdue')) return 'critical';
  if (signals.some((s) => s.status === 'due_soon')) return 'warn';
  return 'ok';
}

const DOT_SEVERITY_LABEL: Record<ScorecardSeverity, string> = { critical: 'Critical', warn: 'Needs attention', ok: 'On track' };

function SeverityDot({ severity }: { severity: ScorecardSeverity }) {
  const tone = severity === 'critical' ? 'bg-alert' : severity === 'warn' ? 'bg-warning' : 'bg-success';
  return (
    <span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', tone)}>
      <span className="sr-only">{DOT_SEVERITY_LABEL[severity] ?? severity}</span>
    </span>
  );
}

// Delegates to the shared threshold so this bar can never disagree with the
// server's tile badge (they used to: 95/80 here vs 100/90 there).
function pctSeverity(pct: number): ScorecardSeverity {
  return scorecardSeverityFromFailPct(100 - pct);
}

function liveSeverity(value: number, target: number): ScorecardSeverity {
  if (value >= target) return 'ok';
  if (value >= target * 0.93) return 'warn';
  return 'critical';
}

// Shared relative formatter — one "time ago" dialect across the app.
const fmtTimeAgo = (d: Date): string => fmtRelativeDate(d);
