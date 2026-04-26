import { useCallback, useEffect, useState } from 'react';
import type { TimeEntry, TimeEntryStatus } from '@alto-people/shared';
import {
  approveTimeEntry,
  listAdminTimeEntries,
  rejectTimeEntry,
} from '@/lib/timeApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

const STATUS_FILTERS: Array<{ value: TimeEntryStatus | 'ALL'; label: string }> = [
  { value: 'COMPLETED', label: 'Pending review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ALL', label: 'All' },
];

function formatHM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

interface AdminTimeViewProps {
  canManage: boolean;
}

export function AdminTimeView({ canManage }: AdminTimeViewProps) {
  const [filter, setFilter] = useState<TimeEntryStatus | 'ALL'>('COMPLETED');
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listAdminTimeEntries(
        filter === 'ALL' ? {} : { status: filter }
      );
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onApprove = async (id: string) => {
    if (pendingId) return;
    setPendingId(id);
    try {
      await approveTimeEntry(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Approve failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onReject = async (id: string) => {
    if (pendingId) return;
    const reason = window.prompt('Reason for rejection?');
    if (!reason) return;
    setPendingId(id);
    try {
      await rejectTimeEntry(id, { reason });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reject failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Time & Attendance
        </h1>
        <p className="text-silver">
          {canManage
            ? 'Review, approve, or reject time entries from associates.'
            : 'Read-only view of time entries.'}
        </p>
      </header>

      <div className="flex flex-wrap gap-2 mb-5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'px-3 py-1.5 rounded text-sm border transition',
              filter === f.value
                ? 'border-gold text-gold bg-gold/10'
                : 'border-navy-secondary text-silver hover:text-white'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}

      {!entries && <p className="text-silver">Loading…</p>}
      {entries && entries.length === 0 && (
        <p className="text-silver">No entries match this filter.</p>
      )}

      {entries && entries.length > 0 && (
        <div className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-navy-secondary/40 text-silver text-xs uppercase tracking-widest">
              <tr>
                <th className="px-4 py-3 text-left">Associate</th>
                <th className="px-4 py-3 text-left">Client</th>
                <th className="px-4 py-3 text-left">In</th>
                <th className="px-4 py-3 text-left">Out</th>
                <th className="px-4 py-3 text-left">Duration</th>
                <th className="px-4 py-3 text-left">Status</th>
                {canManage && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.id}
                  className="border-t border-navy-secondary/60 text-white"
                >
                  <td className="px-4 py-3">{e.associateName ?? '—'}</td>
                  <td className="px-4 py-3 text-silver">{e.clientName ?? '—'}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {new Date(e.clockInAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {e.clockOutAt
                      ? new Date(e.clockOutAt).toLocaleTimeString()
                      : '—'}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {formatHM(e.minutesElapsed)}
                  </td>
                  <td className="px-4 py-3 text-xs uppercase tracking-widest text-silver">
                    {e.status}
                    {e.rejectionReason && (
                      <div className="text-alert text-[10px] normal-case tracking-normal mt-1">
                        {e.rejectionReason}
                      </div>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {e.status === 'COMPLETED' || e.status === 'REJECTED' ? (
                        <button
                          type="button"
                          onClick={() => onApprove(e.id)}
                          disabled={pendingId === e.id}
                          className={cn(
                            'text-xs px-2 py-1 rounded border mr-2',
                            pendingId === e.id
                              ? 'border-navy-secondary text-silver/50'
                              : 'border-gold/40 text-gold hover:bg-gold/10'
                          )}
                        >
                          Approve
                        </button>
                      ) : null}
                      {e.status === 'COMPLETED' || e.status === 'APPROVED' ? (
                        <button
                          type="button"
                          onClick={() => onReject(e.id)}
                          disabled={pendingId === e.id}
                          className={cn(
                            'text-xs px-2 py-1 rounded border',
                            pendingId === e.id
                              ? 'border-navy-secondary text-silver/50'
                              : 'border-alert/40 text-alert hover:bg-alert/10'
                          )}
                        >
                          Reject
                        </button>
                      ) : null}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
