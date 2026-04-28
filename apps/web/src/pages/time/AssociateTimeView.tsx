import { useCallback, useEffect, useState } from 'react';
import type { BreakType, Job, TimeEntry } from '@alto-people/shared';
import {
  clockIn,
  clockOut,
  endBreak,
  getActiveTimeEntry,
  listMyTimeEntries,
  startBreak,
  tryGetGeolocation,
} from '@/lib/timeApi';
import { listJobs } from '@/lib/jobsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Clock, CalendarRange } from 'lucide-react';

function formatHM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function statusBadge(status: TimeEntry['status']): { label: string; cls: string } {
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

const ANOMALY_LABELS: Record<string, string> = {
  GEOFENCE_VIOLATION_IN: 'Off-site clock-in',
  GEOFENCE_VIOLATION_OUT: 'Off-site clock-out',
  NO_BREAK: 'No break taken',
  MEAL_BREAK_TOO_SHORT: 'Meal break < 30 min',
  OVERTIME_UNAPPROVED: 'Overtime',
  FORGOT_CLOCKOUT: 'Forgot clock-out',
  OUTSIDE_SHIFT_WINDOW: 'Off-schedule',
};

function useTicker(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return Date.now();
}

// YYYY-MM-DD in local time. Converted to ISO on the way out to the API.
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultHistoryFromYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 29); // last 30 days inclusive — matches the API default
  return ymdLocal(d);
}

function defaultHistoryToYmd(): string {
  return ymdLocal(new Date());
}

function ymdToIsoStart(ymd: string): string {
  return new Date(`${ymd}T00:00:00`).toISOString();
}

function ymdToIsoEndExclusive(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export function AssociateTimeView() {
  const [active, setActive] = useState<TimeEntry | null>(null);
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [breakBusy, setBreakBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Phase 65 — history range. Defaults to last 30 days (also the API default).
  const [historyFromYmd, setHistoryFromYmd] = useState<string>(defaultHistoryFromYmd());
  const [historyToYmd, setHistoryToYmd] = useState<string>(defaultHistoryToYmd());

  useTicker(!!active);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [a, list, jobList] = await Promise.all([
        getActiveTimeEntry(),
        listMyTimeEntries({
          from: ymdToIsoStart(historyFromYmd),
          to: ymdToIsoEndExclusive(historyToYmd),
        }),
        listJobs().catch(() => ({ jobs: [] as Job[] })),
      ]);
      setActive(a.active);
      setEntries(list.entries);
      setJobs(jobList.jobs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load time data.');
    }
  }, [historyFromYmd, historyToYmd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Reflect break state — derived from the API's active entry; the dashboard
  // model is "open break exists" but we don't have that on the entry shape,
  // so we infer from a local flag we set on start/end.
  const [onBreak, setOnBreak] = useState(false);
  useEffect(() => {
    // When the active entry changes (e.g. via refresh), reset the local flag.
    // The next render of either the start-break or end-break button will fix
    // the state if our cache is wrong.
    if (!active) setOnBreak(false);
  }, [active]);

  const handleClockIn = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const geo = await tryGetGeolocation();
      if (!geo) {
        setInfo("Couldn't read your location — clocking in without GPS.");
      }
      await clockIn({
        geo: geo ?? undefined,
        jobId: selectedJobId || undefined,
      });
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
    setInfo(null);
    try {
      const geo = await tryGetGeolocation();
      await clockOut({ geo: geo ?? undefined });
      setOnBreak(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Clock-out failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleStartBreak = async (type: BreakType) => {
    if (breakBusy) return;
    setBreakBusy(true);
    setError(null);
    try {
      await startBreak(type);
      setOnBreak(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Start break failed.');
    } finally {
      setBreakBusy(false);
    }
  };

  const handleEndBreak = async () => {
    if (breakBusy) return;
    setBreakBusy(true);
    setError(null);
    try {
      await endBreak();
      setOnBreak(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'End break failed.');
    } finally {
      setBreakBusy(false);
    }
  };

  const liveMinutes = active
    ? Math.max(0, Math.floor((Date.now() - new Date(active.clockInAt).getTime()) / 60_000))
    : 0;

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="Time & Attendance"
        subtitle="Clock in when you start. Clock out when you stop."
      />

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
              {active.jobName && <span className="ml-2 text-silver normal-case tracking-normal">· {active.jobName}</span>}
            </div>
            <div className="font-display text-5xl md:text-6xl text-white mb-1 tabular-nums">
              {formatHM(liveMinutes)}
            </div>
            <div className="text-sm text-silver mb-6">
              since {new Date(active.clockInAt).toLocaleTimeString()}
              {active.clockInLat != null && active.clockInLng != null && (
                <span className="ml-2 text-silver/60">
                  · {active.clockInLat.toFixed(4)}, {active.clockInLng.toFixed(4)}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
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
              {!onBreak ? (
                <>
                  <button
                    type="button"
                    onClick={() => handleStartBreak('MEAL')}
                    disabled={breakBusy}
                    className="px-3 py-2 rounded text-sm border border-gold/40 text-gold hover:bg-gold/10 disabled:opacity-50"
                  >
                    Start meal break
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStartBreak('REST')}
                    disabled={breakBusy}
                    className="px-3 py-2 rounded text-sm border border-silver/30 text-silver hover:bg-silver/10 disabled:opacity-50"
                  >
                    Start rest break
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleEndBreak}
                  disabled={breakBusy}
                  className="px-3 py-2 rounded text-sm border border-gold/40 text-gold hover:bg-gold/10 disabled:opacity-50"
                >
                  {breakBusy ? 'Ending…' : 'End break'}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="text-xs uppercase tracking-widest text-silver mb-2">
              Not clocked in
            </div>
            <div className="font-display text-3xl text-white mb-4">
              Ready when you are.
            </div>
            {jobs.length > 0 && (
              <label className="block mb-4 max-w-xs">
                <span className="block text-xs uppercase tracking-widest text-silver mb-1">
                  Job (optional)
                </span>
                <select
                  value={selectedJobId}
                  onChange={(e) => setSelectedJobId(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white"
                >
                  <option value="">— No job tag —</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                      {j.payRate ? ` · $${j.payRate.toFixed(2)}/hr` : ''}
                      {j.clientName ? ` · ${j.clientName}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              type="button"
              size="lg"
              onClick={handleClockIn}
              loading={busy}
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Clock in'}
            </Button>
            <p className="text-xs text-silver/60 mt-3">
              Your browser will ask permission to share your location for geofence verification.
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-alert mt-4">
            {error}
          </p>
        )}
        {info && (
          <p className="text-sm text-silver mt-4">{info}</p>
        )}
      </section>

      <section aria-label="Recent time entries">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
          <h2 className="font-display text-2xl text-white">Recent entries</h2>
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-silver mb-1">
                From
              </label>
              <input
                type="date"
                value={historyFromYmd}
                max={historyToYmd}
                onChange={(e) =>
                  setHistoryFromYmd(e.target.value || defaultHistoryFromYmd())
                }
                className="h-9 text-sm rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-white focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold w-40"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-silver mb-1">
                To
              </label>
              <input
                type="date"
                value={historyToYmd}
                min={historyFromYmd}
                onChange={(e) =>
                  setHistoryToYmd(e.target.value || defaultHistoryToYmd())
                }
                className="h-9 text-sm rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-white focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold w-40"
              />
            </div>
          </div>
        </div>
        {!entries && <SkeletonRows count={4} rowHeight="h-20" />}
        {entries && entries.length === 0 && (() => {
          const isDefaultRange =
            historyFromYmd === defaultHistoryFromYmd() &&
            historyToYmd === defaultHistoryToYmd();
          return isDefaultRange ? (
            <EmptyState
              icon={Clock}
              title="No time entries yet"
              description="Once you clock in for the first time, your shifts will appear here."
            />
          ) : (
            <EmptyState
              icon={CalendarRange}
              title="Nothing in this range"
              description="Try widening the date range above to see older entries."
            />
          );
        })()}
        {entries && entries.length > 0 && (
          <ul className="space-y-2">
            {entries.map((e) => {
              const badge = statusBadge(e.status);
              const anomalies = e.anomalies ?? [];
              return (
                <li
                  key={e.id}
                  className="flex items-start justify-between gap-4 p-4 bg-navy border border-navy-secondary rounded-lg"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-white tabular-nums">
                      {new Date(e.clockInAt).toLocaleString()} –{' '}
                      {e.clockOutAt
                        ? new Date(e.clockOutAt).toLocaleTimeString()
                        : '…'}
                    </div>
                    <div className="text-sm text-silver">
                      {formatHM(e.minutesElapsed)}
                      {e.jobName && <span className="ml-2">· {e.jobName}</span>}
                      {e.payRate && (
                        <span className="ml-2">· ${e.payRate.toFixed(2)}/hr</span>
                      )}
                      {e.rejectionReason && (
                        <span className="ml-2 text-alert">· {e.rejectionReason}</span>
                      )}
                    </div>
                    {anomalies.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {anomalies.map((a) => (
                          <span
                            key={a}
                            className="text-[10px] uppercase tracking-widest px-2 py-0.5 rounded border border-alert/40 bg-alert/10 text-alert"
                          >
                            {ANOMALY_LABELS[a] ?? a}
                          </span>
                        ))}
                      </div>
                    )}
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
