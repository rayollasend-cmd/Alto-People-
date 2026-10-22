import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { timesheetQueuePath, type TimeEntry } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { ymdLocal } from '@/lib/format';
import { useListKeyboard } from '@/lib/shortcuts';
import { timeAnomalyLabel } from '@/lib/timeLabels';
import {
  approveTimeEntry,
  bulkApproveTimeEntries,
  countAdminTimeEntries,
  listAdminTimeEntries,
  rejectTimeEntry,
} from '@/lib/timeApi';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { fmtPunchDateTime, fmtPunchTime, formatHM } from './punchFormat';

/**
 * The timesheets waiting for approval, inline — for the Approvals hub (role
 * walk floor 7, HR 16). The hub used to show "Timesheets 6" as the last of
 * eight tiles and bounce to another page; here the clean ones approve in
 * one tap and the flagged ones are listed with their reason, each with
 * Approve and Reject. j/k move, a approves, d opens the reject box.
 *
 * Same predicate as every count (lib/pendingTime via the count endpoint):
 * finished punches in the last 90 days the caller can see. Renders nothing
 * when none are pending, so the hub can fold it with its other zeros.
 * The caller's own entries never get Approve — someone else approves
 * those, and the server refuses (own_entry) either way.
 */

const SHOW = 5;

export function PendingTimesheetsPanel({ className }: { className?: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const ownId = user?.associateId ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const countQuery = useQuery({
    queryKey: ['time', 'pending-count', 'panel'],
    queryFn: () => countAdminTimeEntries('COMPLETED', {}, { groupBy: 'payPeriod' }),
  });
  const total = countQuery.data?.count ?? 0;
  const listQuery = useQuery({
    queryKey: ['time', 'entries', 'pending-panel'],
    queryFn: () => listAdminTimeEntries({ status: 'COMPLETED', order: 'asc' }),
    enabled: total > 0,
  });
  const entries = useMemo(() => (listQuery.data?.entries ?? []).filter((e) => e.status === 'COMPLETED'), [listQuery.data]);
  const isOwn = (e: TimeEntry) => ownId !== null && e.associateId === ownId;
  const clean = useMemo(() => entries.filter((e) => (e.anomalies?.length ?? 0) === 0 && !isOwn(e)), [entries, ownId]); // eslint-disable-line react-hooks/exhaustive-deps
  const flagged = useMemo(() => entries.filter((e) => (e.anomalies?.length ?? 0) > 0), [entries]);
  const own = useMemo(() => entries.filter((e) => isOwn(e) && (e.anomalies?.length ?? 0) === 0), [entries, ownId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownFlagged = flagged.slice(0, SHOW);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['time'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
    void qc.invalidateQueries({ queryKey: ['approvals'] });
  };
  const fail = (err: unknown, fallback: string) => toast.error(err instanceof ApiError ? err.message : fallback);

  const approveAllClean = async () => {
    if (clean.length === 0 || busy) return;
    setBusy('all');
    try {
      const res = await bulkApproveTimeEntries({ entryIds: clean.map((e) => e.id) });
      if (res.failed > 0) toast.warning(`${res.succeeded} approved · ${res.failed} could not be — open the queue to see why.`);
      else toast.success(`${res.succeeded} ${res.succeeded === 1 ? 'entry' : 'entries'} approved.`);
      refresh();
    } catch (err) {
      fail(err, 'Could not approve.');
    } finally {
      setBusy(null);
    }
  };
  const approveOne = async (e: TimeEntry) => {
    if (busy || isOwn(e)) return;
    setBusy(e.id);
    try {
      await approveTimeEntry(e.id);
      toast.success(`${e.associateName ?? 'Entry'} approved.`);
      refresh();
    } catch (err) {
      fail(err, 'Could not approve.');
    } finally {
      setBusy(null);
    }
  };
  const rejectOne = async (e: TimeEntry) => {
    const why = reason.trim();
    if (!why || busy) return;
    setBusy(e.id);
    try {
      await rejectTimeEntry(e.id, { reason: why });
      toast.success(`${e.associateName ?? 'Entry'} rejected.`);
      setRejecting(null);
      setReason('');
      refresh();
    } catch (err) {
      fail(err, 'Could not reject.');
    } finally {
      setBusy(null);
    }
  };

  const kb = useListKeyboard<TimeEntry>({
    items: shownFlagged,
    idOf: (e) => e.id,
    onApprove: (e) => void approveOne(e),
    onDecline: (e) => {
      if (!isOwn(e)) setRejecting(e.id);
    },
    enabled: rejecting === null,
  });

  if (!countQuery.data || total === 0) return null;

  const oldest = countQuery.data.oldestPendingAt;
  const queueHref = timesheetQueuePath({
    from: ymdLocal(oldest ? new Date(oldest) : new Date(Date.now() - 90 * 86_400_000)),
    to: ymdLocal(new Date()),
  });

  return (
    <section className={cn('rounded-lg border border-navy-secondary bg-navy-secondary/20 p-4', className)} aria-label="Timesheets to approve" data-testid="pending-timesheets-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">
          Timesheets <span className="tabular-nums text-silver">· {total} pending</span>
        </h3>
        <Link to={queueHref} className="inline-flex items-center gap-1 text-xs text-gold hover:underline">
          Open the queue <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      {clean.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2">
          <span className="text-sm text-ink">
            <span className="font-medium tabular-nums">{clean.length}</span> clean {clean.length === 1 ? 'entry' : 'entries'} — no flags
          </span>
          <Button size="sm" variant="primary" onClick={approveAllClean} loading={busy === 'all'} disabled={busy !== null}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Approve all
          </Button>
        </div>
      )}
      {own.length > 0 && (
        <p className="mt-2 text-xs text-silver/70">
          {own.length} of these {own.length === 1 ? 'is yours' : 'are yours'} — someone else approves it.
        </p>
      )}

      {flagged.length > 0 && (
        <div className="mt-3">
          <p className="text-2xs uppercase tracking-wider text-silver">
            Flagged · {flagged.length} — each needs a look
          </p>
          <ul {...kb.listProps} className="mt-1.5 divide-y divide-navy-secondary rounded-md outline-none focus-visible:ring-2 focus-visible:ring-gold/50">
            {shownFlagged.map((e) => {
              const mine = isOwn(e);
              const rowBusy = busy === e.id;
              return (
                <li
                  key={e.id}
                  {...kb.rowProps(e.id)}
                  className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm', kb.cursor === e.id && 'bg-gold/[0.08]')}
                  data-testid="pending-flagged-row"
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-ink">{e.associateName ?? '—'}</span>
                    <span className="ml-2 tabular-nums text-silver">
                      {fmtPunchDateTime(e.clockInAt, e.locationTimezone)}
                      {e.clockOutAt ? ` → ${fmtPunchTime(e.clockOutAt, e.locationTimezone)}` : ''} · {formatHM(e.netMinutes ?? e.minutesElapsed)}
                    </span>
                    <span className="block text-xs text-warning">{(e.anomalies ?? []).map(timeAnomalyLabel).join(' · ')}</span>
                  </span>
                  {mine ? (
                    <span className="text-2xs text-silver/70" title="Someone else approves your own time.">
                      Yours — someone else approves it
                    </span>
                  ) : rejecting === e.id ? (
                    <span className="flex w-full items-center gap-2 sm:w-auto">
                      <Input
                        autoFocus
                        value={reason}
                        onChange={(ev) => setReason(ev.target.value)}
                        placeholder="Why — the worker reads this"
                        className="h-8 text-sm"
                        aria-label="Rejection reason"
                      />
                      <Button size="sm" variant="destructive" onClick={() => void rejectOne(e)} loading={rowBusy} disabled={busy !== null || reason.trim().length === 0}>
                        Reject
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setRejecting(null); setReason(''); }} disabled={rowBusy}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => void approveOne(e)} loading={rowBusy} disabled={busy !== null}>
                        Approve
                      </Button>
                      <Button size="sm" variant="ghost" className="text-alert hover:bg-alert/10 hover:text-alert" onClick={() => setRejecting(e.id)} disabled={busy !== null}>
                        Reject
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {flagged.length > SHOW && (
            <p className="mt-1.5 text-xs text-silver/70">
              {flagged.length - SHOW} more flagged in the queue.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
