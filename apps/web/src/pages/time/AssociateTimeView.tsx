import { useCallback, useEffect, useState } from 'react';
import type { TimeEntry } from '@alto-people/shared';
import {
  clockIn,
  clockOut,
  getActiveTimeEntry,
  listMyTimeEntries,
} from '@/lib/timeApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

function formatHM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function statusBadge(status: TimeEntry['status']): {
  label: string;
  cls: string;
} {
  switch (status) {
    case 'ACTIVE':
      return { label: 'Active', cls: 'bg-gold/20 text-gold border-gold/40' };
    case 'COMPLETED':
      return { label: 'Pending', cls: 'bg-silver/10 text-silver border-silver/30' };
    case 'APPROVED':
      return { label: 'Approved', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
    case 'REJECTED':
      return { label: 'Rejected', cls: 'bg-alert/15 text-alert border-alert/30' };
  }
}

function useTicker(active: boolean): number {
  // Re-renders once per second so the live "Active" timer updates without
  // requiring a polling refetch.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return Date.now();
}

export function AssociateTimeView() {
  const [active, setActive] = useState<TimeEntry | null>(null);
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useTicker(!!active);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [a, list] = await Promise.all([getActiveTimeEntry(), listMyTimeEntries()]);
      setActive(a.active);
      setEntries(list.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load time data.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleClockIn = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await clockIn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Clock-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleClockOut = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await clockOut();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Clock-out failed.');
    } finally {
      setBusy(false);
    }
  };

  // Live elapsed minutes for the active entry — recomputed every render
  // (which the ticker triggers each second).
  const liveMinutes = active
    ? Math.max(0, Math.floor((Date.now() - new Date(active.clockInAt).getTime()) / 60_000))
    : 0;

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Time & Attendance
        </h1>
        <p className="text-silver">Clock in when you start. Clock out when you stop.</p>
      </header>

      <section
        className={cn(
          'bg-navy border rounded-lg p-6 md:p-8 mb-8',
          active ? 'border-gold/40' : 'border-navy-secondary'
        )}
        aria-label="Current shift status"
      >
        {active ? (
          <>
            <div className="text-xs uppercase tracking-widest text-gold mb-2">
              Currently clocked in
            </div>
            <div className="font-display text-5xl md:text-6xl text-white mb-1 tabular-nums">
              {formatHM(liveMinutes)}
            </div>
            <div className="text-sm text-silver mb-6">
              since {new Date(active.clockInAt).toLocaleTimeString()}
            </div>
            <button
              type="button"
              onClick={handleClockOut}
              disabled={busy}
              className={cn(
                'px-6 py-3 rounded font-medium text-base transition',
                busy
                  ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
                  : 'bg-alert text-white hover:opacity-90'
              )}
            >
              {busy ? 'Saving…' : 'Clock out'}
            </button>
          </>
        ) : (
          <>
            <div className="text-xs uppercase tracking-widest text-silver mb-2">
              Not clocked in
            </div>
            <div className="font-display text-3xl text-white mb-6">
              Ready when you are.
            </div>
            <button
              type="button"
              onClick={handleClockIn}
              disabled={busy}
              className={cn(
                'px-6 py-3 rounded font-medium text-base transition',
                busy
                  ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
                  : 'bg-gold text-navy hover:bg-gold-bright'
              )}
            >
              {busy ? 'Saving…' : 'Clock in'}
            </button>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-alert mt-4">
            {error}
          </p>
        )}
      </section>

      <section aria-label="Recent time entries">
        <h2 className="font-display text-2xl text-white mb-3">Recent entries</h2>
        {!entries && <p className="text-silver">Loading…</p>}
        {entries && entries.length === 0 && (
          <p className="text-silver">No entries yet — clock in to start your first.</p>
        )}
        {entries && entries.length > 0 && (
          <ul className="space-y-2">
            {entries.map((e) => {
              const badge = statusBadge(e.status);
              return (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-4 p-4 bg-navy border border-navy-secondary rounded-lg"
                >
                  <div className="min-w-0">
                    <div className="text-white tabular-nums">
                      {new Date(e.clockInAt).toLocaleString()} –{' '}
                      {e.clockOutAt
                        ? new Date(e.clockOutAt).toLocaleTimeString()
                        : '…'}
                    </div>
                    <div className="text-sm text-silver">
                      {formatHM(e.minutesElapsed)}
                      {e.rejectionReason && (
                        <span className="ml-2 text-alert">
                          · {e.rejectionReason}
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 text-xs uppercase tracking-widest px-2 py-1 rounded border',
                      badge.cls
                    )}
                  >
                    {badge.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
