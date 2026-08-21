import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * "Needs your decision" for every seat — the chairman's queue pattern,
 * scoped by the API to the signed-in user's capabilities and client.
 * Items auto-clear when the underlying work is done, so the queue is
 * worked by doing, not by dismissing. Renders nothing when the queue is
 * empty (a clean desk needs no card).
 */

interface RoleDecision {
  key: string;
  severity: 'critical' | 'high' | 'normal';
  label: string;
  detail: string;
  stakes: number | null;
  ageDays: number | null;
  linkUrl: string;
}

export function RoleDecisionQueue({ title = 'Needs your decision' }: { title?: string }) {
  const [rows, setRows] = useState<RoleDecision[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    apiFetch<{ decisions: RoleDecision[] }>('/me/decisions')
      .then((r) => setRows(r.decisions))
      .catch(() => setError(true));
  }, []);
  useEffect(load, [load]);

  // This card is a SUPPLEMENT — every item on it has a primary surface
  // (approvals, time, clients, …) with its own error handling. A failed
  // aux fetch disappears quietly rather than stacking a second Retry
  // card onto a dashboard that already reports its own failures.
  if (error) return null;
  if (rows !== null && rows.length === 0) return null;

  return (
    <Card className={rows?.some((d) => d.severity === 'critical') ? 'border-alert/40' : undefined}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{title}</CardTitle>
          {rows && rows.length > 0 && (
            <span className="text-2xs tabular-nums text-silver/70">{rows.length} waiting</span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {rows === null && <Skeleton className="h-20" />}
        {rows && rows.length > 0 && (
          <ul className="space-y-2">
            {rows.slice(0, 6).map((d) => (
              <li
                key={d.key}
                className={`rounded-md border-l-2 bg-navy-secondary/30 px-3 py-2 ${
                  d.severity === 'critical'
                    ? 'border-alert'
                    : d.severity === 'high'
                      ? 'border-warning'
                      : 'border-navy-secondary'
                }`}
              >
                <Link to={d.linkUrl} className="group block">
                  <div className="flex flex-wrap items-center justify-between gap-x-2">
                    <span className="text-sm text-white group-hover:text-gold">{d.label}</span>
                    <span className="flex items-center gap-1.5 text-2xs tabular-nums text-silver">
                      {d.stakes !== null && <span>{fmtMoney(d.stakes)} at stake</span>}
                      {d.ageDays !== null && d.ageDays > 0 && (
                        <span className="text-silver/60">waiting {d.ageDays}d</span>
                      )}
                    </span>
                  </div>
                  <div className="text-xs text-silver">{d.detail}</div>
                </Link>
              </li>
            ))}
            {rows.length > 6 && (
              <li className="text-center text-2xs text-silver/60">
                +{rows.length - 6} more waiting
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
