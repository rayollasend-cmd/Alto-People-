import { useCallback, useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
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
  ScorecardActionsResponse,
  ScorecardBillingResponse,
  ScorecardExpirationsResponse,
  ScorecardOnboardingResponse,
  ScorecardOnboardingSignal,
  ScorecardSeverity,
  ScorecardShiftsResponse,
  ScorecardTrainingResponse,
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

  useEffect(() => {
    const id = setInterval(() => {
      setRefreshEpoch((n) => n + 1);
      setLastRefreshedAt(new Date());
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(() => {
    setRefreshEpoch((n) => n + 1);
    setLastRefreshedAt(new Date());
  }, []);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl text-white flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-gold" />
              Walmart Contract Compliance Scorecard
            </h1>
            <p className="text-sm text-silver mt-1">
              Live state of our compliance against Walmart MSA / SOW / MTSA. Refreshes every 15 minutes.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-silver tabular-nums">
              Last refreshed {fmtTimeAgo(lastRefreshedAt)}
            </span>
            <Button size="sm" variant="outline" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        </div>

        <CriticalBanner refreshEpoch={refreshEpoch} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <OnboardingTile refreshEpoch={refreshEpoch} />
          <ExpirationsTile refreshEpoch={refreshEpoch} />
          <ShiftsTile refreshEpoch={refreshEpoch} />
          <BillingTile refreshEpoch={refreshEpoch} />
          <TrainingTile refreshEpoch={refreshEpoch} />
        </div>

        <ActionsTile refreshEpoch={refreshEpoch} />
      </div>
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------ */
/* Critical banner — surfaces /actions counts at the top of the page. */
/* ------------------------------------------------------------------ */

function CriticalBanner({ refreshEpoch }: { refreshEpoch: number }) {
  const [data, setData] = useState<ScorecardActionsResponse | null>(null);
  useEffect(() => {
    getScorecardActions().then(setData).catch(() => setData(null));
  }, [refreshEpoch]);
  if (!data || data.criticalCount === 0) return null;
  return (
    <div className="rounded-lg border border-alert/60 bg-alert/10 p-4 flex items-start gap-3">
      <AlertTriangle className="h-5 w-5 text-alert flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="font-semibold text-alert text-sm">
          {data.criticalCount} critical {data.criticalCount === 1 ? 'item' : 'items'} need attention
        </div>
        <p className="text-xs text-silver mt-0.5">
          Scroll to the Open Actions tile for the full list.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------- TILE 1 ----------------------------- */

function OnboardingTile({ refreshEpoch }: { refreshEpoch: number }) {
  const [data, setData] = useState<ScorecardOnboardingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerSignal, setDrawerSignal] = useState<ScorecardOnboardingSignal | null>(null);

  useEffect(() => {
    setData(null); setError(null);
    getScorecardOnboarding()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load.'));
  }, [refreshEpoch]);

  return (
    <TileShell
      icon={<ClipboardList className="h-4 w-4" />}
      title="Onboarding completeness"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
    >
      {data && (
        <>
          <p className="text-[11px] text-silver mb-2">
            {data.activeAssociateCount} active {data.activeAssociateCount === 1 ? 'associate' : 'associates'}
          </p>
          <div className="space-y-1.5">
            {data.signals.map((s) => {
              const total = data.activeAssociateCount;
              const pct = total === 0 ? 100 : Math.round((s.completedCount / total) * 100);
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setDrawerSignal(s)}
                  className="group w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-navy-secondary/40 text-left"
                >
                  <ClauseTooltip clause={s.contractClause}>
                    <span className="text-xs text-white">{s.label}</span>
                  </ClauseTooltip>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-silver tabular-nums">
                      {s.completedCount}/{total} ({pct}%)
                    </span>
                    <PctBar pct={pct} severity={pctSeverity(pct)} />
                    <ChevronRight className="h-3.5 w-3.5 text-silver/60 group-hover:text-silver" />
                  </div>
                </button>
              );
            })}
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
                        <a
                          href={`/people?associate=${m.associateId}`}
                          className="text-xs text-gold hover:underline flex items-center gap-1"
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </a>
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

/* ----------------------------- TILE 2 ----------------------------- */

function ExpirationsTile({ refreshEpoch }: { refreshEpoch: number }) {
  const [data, setData] = useState<ScorecardExpirationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    getScorecardExpirations()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load.'));
  }, [refreshEpoch]);

  return (
    <TileShell
      icon={<Clock className="h-4 w-4" />}
      title="Expiring documents (next 90 days)"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
    >
      {data && (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
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
  const [data, setData] = useState<ScorecardShiftsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    getScorecardShifts()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load.'));
  }, [refreshEpoch]);

  return (
    <TileShell
      icon={<TrendingUp className="h-4 w-4" />}
      title="Shift compliance (ASN Nexus)"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
    >
      {data && (
        <div className="space-y-2">
          <p className="text-[11px] text-silver">Window: last {data.windowDays} days</p>
          {data.signals.map((s) => (
            <div
              key={s.key}
              className={cn(
                'px-2 py-1.5 rounded flex items-center justify-between',
                s.status === 'live' ? 'bg-navy-secondary/30' : 'bg-navy-secondary/10',
              )}
            >
              <ClauseTooltip clause={s.contractClause}>
                <span className="text-xs text-white">{s.label}</span>
              </ClauseTooltip>
              {s.status === 'live' && s.value !== null ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-silver tabular-nums">
                    {s.value}% / target {s.target}%
                  </span>
                  <PctBar pct={s.value} severity={liveSeverity(s.value, s.target ?? 0)} />
                </div>
              ) : s.status === 'live' && s.value === null ? (
                <span className="text-[11px] text-silver/80">No data in window</span>
              ) : (
                <Badge variant="outline">Coming soon</Badge>
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
  const [data, setData] = useState<ScorecardBillingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    getScorecardBilling()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load.'));
  }, [refreshEpoch]);

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
  const [data, setData] = useState<ScorecardTrainingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerSignal, setDrawerSignal] = useState<ScorecardTrainingSignal | null>(null);

  useEffect(() => {
    setData(null); setError(null);
    getScorecardTraining()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load.'));
  }, [refreshEpoch]);

  return (
    <TileShell
      icon={<GraduationCap className="h-4 w-4" />}
      title="Training completeness"
      severity={data?.severity ?? 'ok'}
      loading={!data && !error}
      error={error}
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
                    'group w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left',
                    s.status === 'live' ? 'hover:bg-navy-secondary/40' : 'opacity-70',
                  )}
                >
                  <ClauseTooltip clause={s.contractClause}>
                    <span className="text-xs text-white">{s.label}</span>
                  </ClauseTooltip>
                  {s.status === 'live' ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-silver tabular-nums">
                        {s.completedCount}/{s.totalAssociates} ({pct}%)
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
                        <a
                          href={`/people?associate=${m.associateId}`}
                          className="text-xs text-gold hover:underline flex items-center gap-1"
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </a>
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

function ActionsTile({ refreshEpoch }: { refreshEpoch: number }) {
  const [data, setData] = useState<ScorecardActionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    getScorecardActions()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load.'));
  }, [refreshEpoch]);

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Sparkles className="h-4 w-4 text-gold" />
            Open actions
          </div>
          {data && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-alert tabular-nums">{data.criticalCount} critical</span>
              <span className="text-warning tabular-nums">{data.warnCount} warn</span>
            </div>
          )}
        </div>
        {error && <div className="text-sm text-alert">{error}</div>}
        {!data && !error && <Skeleton className="h-32" />}
        {data && data.actions.length === 0 && (
          <div className="text-xs text-success flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5" />
            No open compliance actions. Nice work.
          </div>
        )}
        {data && data.actions.length > 0 && (
          <ul className="divide-y divide-navy-secondary border border-navy-secondary rounded">
            {data.actions.map((a) => (
              <li key={a.id} className="px-3 py-2 flex items-center justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <SeverityDot severity={a.severity} />
                  <div className="min-w-0">
                    <div className="text-xs text-white truncate">{a.title}</div>
                    <div className="text-[10px] text-silver/80 truncate">{a.contractClause}</div>
                  </div>
                </div>
                {a.link && (
                  <a
                    href={a.link}
                    className="text-[11px] text-gold hover:underline flex items-center gap-1 shrink-0"
                  >
                    Fix <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </li>
            ))}
          </ul>
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
  children,
}: {
  icon: React.ReactNode;
  title: string;
  severity: ScorecardSeverity;
  loading: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn('border', SEVERITY_RING[severity])}>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <span className="text-gold">{icon}</span>
            {title}
          </div>
          <Badge variant={SEVERITY_BADGE[severity].variant}>
            {SEVERITY_BADGE[severity].label}
          </Badge>
        </div>
        {error && <div className="text-sm text-alert">{error}</div>}
        {loading && <Skeleton className="h-32" />}
        {!loading && !error && children}
      </CardContent>
    </Card>
  );
}

function PctBar({ pct, severity }: { pct: number; severity: ScorecardSeverity }) {
  const fill = severity === 'critical' ? 'bg-alert' : severity === 'warn' ? 'bg-warning' : 'bg-success';
  return (
    <div className="w-16 h-1.5 rounded-full bg-navy-secondary overflow-hidden">
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
