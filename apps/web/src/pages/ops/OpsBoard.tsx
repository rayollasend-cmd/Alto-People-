import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardList } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  getOpsBoard,
  getOpsScorecard,
  type OpsShiftHeader,
} from '@/lib/opsApi';

/**
 * The leadership view: every running ops shift across every store, today's
 * closes with their honesty flags, and the rolling scorecard. Read-only —
 * oversight verifies with evidence, it doesn't approve.
 */

const PERIOD_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  EVENING: 'Evening',
  CLOSING: 'Closing',
  OVERNIGHT: 'Overnight',
};

type BoardShift = OpsShiftHeader & { clientName: string; openedByEmail: string };

export function OpsBoard() {
  const [board, setBoard] = useState<{
    dateKey: string;
    active: BoardShift[];
    closedToday: BoardShift[];
  } | null>(null);
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
    };
    load();
    // The floor changes by the minute — keep the board live-ish.
    const timer = setInterval(load, 60_000);
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

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!board) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>
            Live now
            <span className="ml-2 text-sm font-normal text-silver/70 tabular-nums">
              {board.active.length} shift{board.active.length === 1 ? '' : 's'} running
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {board.active.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No ops shifts running right now"
              description="Supervisors open their shift from Store Ops when they start."
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {board.active.map((s) => {
                const pct =
                  s.taskTotal > 0 ? Math.round((s.taskDone / s.taskTotal) * 100) : 0;
                return (
                  <div
                    key={s.id}
                    className={cn(
                      'rounded-md border bg-navy-secondary/20 p-3',
                      s.tempAlerts > 0 ? 'border-alert/50' : 'border-navy-secondary',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-white">
                          {s.department} — {PERIOD_LABEL[s.period]}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-silver">
                          {s.clientName} · {s.openedByEmail}
                        </div>
                      </div>
                      {s.tempAlerts > 0 && (
                        <Badge variant="destructive">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          {s.tempAlerts}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs tabular-nums text-silver">
                      <span className="text-white">{s.taskDone}</span>/{s.taskTotal} · {pct}%
                      <span className="text-silver/60">
                        · floor {s.actualHeadcount}/{s.scheduledHeadcount}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-navy-secondary">
                      <div
                        className={cn(
                          'h-full transition-all',
                          pct >= 80 ? 'bg-success' : pct >= 40 ? 'bg-gold' : 'bg-warning',
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Closed today
            <span className="ml-2 text-sm font-normal text-silver/70">{board.dateKey}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {board.closedToday.length === 0 ? (
            <p className="text-sm text-silver">Nothing closed yet today.</p>
          ) : (
            <ul className="divide-y divide-navy-secondary/60">
              {board.closedToday.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-white">
                      {s.department} — {PERIOD_LABEL[s.period]}
                      <span className="ml-2 text-xs text-silver/70">{s.clientName}</span>
                    </div>
                    {s.closingSummary && (
                      <div className="mt-0.5 truncate text-xs text-silver/70">
                        “{s.closingSummary}”
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs tabular-nums">
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

      {scorecard && scorecard.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              Scorecard — last {scorecard.weeks} weeks
              <span className="ml-2 text-sm font-normal text-silver/70 tabular-nums">
                {scorecard.totals.shifts} shifts · {scorecard.totals.tempChecks} temp checks (
                {scorecard.totals.tempOutOfRange} out of range) ·{' '}
                {scorecard.totals.handoverCarried}/{scorecard.totals.handoverCreated} handovers
                carried
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-2xs uppercase tracking-wider text-silver/60">
                    <th className="py-1.5 pr-3">Store</th>
                    <th className="py-1.5 pr-3">Department</th>
                    <th className="py-1.5 pr-3 text-right">Shifts</th>
                    <th className="py-1.5 pr-3 text-right">SOP %</th>
                    <th className="py-1.5 pr-3 text-right">Incomplete</th>
                    <th className="py-1.5 text-right">Temp alerts</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-secondary/60">
                  {scorecard.rows.map((r) => (
                    <tr key={`${r.clientName}|${r.department}`}>
                      <td className="py-1.5 pr-3 text-white">{r.clientName}</td>
                      <td className="py-1.5 pr-3 text-silver">{r.department}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-silver">
                        {r.shifts}
                      </td>
                      <td
                        className={cn(
                          'py-1.5 pr-3 text-right tabular-nums',
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
                      </td>
                      <td
                        className={cn(
                          'py-1.5 pr-3 text-right tabular-nums',
                          r.incomplete > 0 ? 'text-warning' : 'text-silver/50',
                        )}
                      >
                        {r.incomplete}
                      </td>
                      <td
                        className={cn(
                          'py-1.5 text-right tabular-nums',
                          r.tempAlerts > 0 ? 'text-alert' : 'text-silver/50',
                        )}
                      >
                        {r.tempAlerts}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
