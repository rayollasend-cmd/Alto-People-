import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * "Needs your decision" for every seat — the chairman's queue pattern,
 * scoped by the API to the signed-in user's capabilities and client, and
 * COLLABORATIVE: teammates sharing the same queue see who has taken each
 * item ("I've got this"), can hand it back, and can escalate it upward
 * to the org admins with a note. Items auto-clear when the underlying
 * work is done. Renders nothing when the queue is empty or unavailable —
 * every item has a primary surface with its own error handling.
 */

interface RoleDecision {
  key: string;
  severity: 'critical' | 'high' | 'normal';
  label: string;
  detail: string;
  stakes: number | null;
  ageDays: number | null;
  linkUrl: string;
  claimedBy: { id: string; name: string } | null;
  claimedByMe: boolean;
  note: string | null;
  escalated: boolean;
}

export function RoleDecisionQueue({ title = 'Needs your decision' }: { title?: string }) {
  const [rows, setRows] = useState<RoleDecision[] | null>(null);
  const [error, setError] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(false);
    apiFetch<{ decisions: RoleDecision[] }>('/me/decisions')
      .then((r) => setRows(r.decisions))
      .catch(() => setError(true));
  }, []);
  useEffect(load, [load]);

  const act = async (key: string, action: 'claim' | 'release' | 'escalate') => {
    if (busyKey) return;
    let note: string | undefined;
    if (action === 'escalate') {
      const typed = window.prompt('Add a note for the admins (optional):', '');
      if (typed === null) return;
      note = typed.trim() || undefined;
    }
    setBusyKey(`${key}:${action}`);
    try {
      await apiFetch('/me/decisions/act', { method: 'POST', body: { key, action, note } });
      toast.success(
        action === 'claim'
          ? "It's yours — your teammates can see you've got it."
          : action === 'release'
            ? 'Released back to the team.'
            : 'Escalated — the admins were notified.',
      );
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the item.');
    } finally {
      setBusyKey(null);
    }
  };

  // Supplement card: vanish quietly on failure or empty — every item has
  // a primary surface with its own error handling.
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
                      {d.escalated && (
                        <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-warning">
                          escalated
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="text-xs text-silver">{d.detail}</div>
                </Link>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {d.claimedBy && !d.claimedByMe ? (
                    <span
                      className="rounded-full bg-steel/20 px-2 py-0.5 text-2xs text-white"
                      title={d.note ?? undefined}
                    >
                      With {d.claimedBy.name}
                    </span>
                  ) : d.claimedByMe ? (
                    <>
                      <span className="rounded-full bg-gold/15 px-2 py-0.5 text-2xs text-gold">
                        You&apos;ve got this
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        loading={busyKey === `${d.key}:release`}
                        disabled={busyKey !== null}
                        onClick={() => void act(d.key, 'release')}
                      >
                        Release
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busyKey === `${d.key}:claim`}
                      disabled={busyKey !== null}
                      onClick={() => void act(d.key, 'claim')}
                    >
                      I&apos;ve got this
                    </Button>
                  )}
                  {!d.escalated && (
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busyKey === `${d.key}:escalate`}
                      disabled={busyKey !== null}
                      onClick={() => void act(d.key, 'escalate')}
                    >
                      Escalate
                    </Button>
                  )}
                </div>
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
