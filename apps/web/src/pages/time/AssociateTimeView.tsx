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
import {
  fmtPayRate,
  fmtTime,
  ymdLocal,
  ymdToIsoEndExclusive,
  ymdToIsoStart,
} from '@/lib/format';
import { hapticSuccess } from '@/lib/haptics';
import { timeAnomalyLabel } from '@/lib/timeLabels';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Clock, CalendarRange, ChevronDown } from 'lucide-react';
import { ShiftTimeline } from './ShiftTimeline';
import { TimesheetWeeks } from './TimesheetWeeks';
import { fmtPunchTime, formatHM, punchDayOffset } from './punchFormat';

const STATUS_LABELS: Record<TimeEntry['status'], string> = {
  ACTIVE: 'Active',
  COMPLETED: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const STATUS_VARIANTS: Record<
  TimeEntry['status'],
  'accent' | 'pending' | 'success' | 'destructive'
> = {
  ACTIVE: 'accent',
  COMPLETED: 'pending',
  APPROVED: 'success',
  REJECTED: 'destructive',
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

function defaultHistoryFromYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 29); // last 30 days inclusive — matches the API default
  return ymdLocal(d);
}

function defaultHistoryToYmd(): string {
  return ymdLocal(new Date());
}

export function AssociateTimeView() {
  const [active, setActive] = useState<TimeEntry | null>(null);
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  // History row expanded to its punch timeline. One at a time keeps the
  // list scannable on a phone.
  const [expandedId, setExpandedId] = useState<string | null>(null);
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

  // Break state comes from the server (TimeEntry.onBreak) so it survives a
  // page refresh mid-break — the old client-local flag forgot the break on
  // reload and the UI then offered "Start break" into a 409. Local sets on
  // start/end keep the buttons instant; refresh() re-syncs from truth.
  const [onBreak, setOnBreak] = useState(false);
  useEffect(() => {
    setOnBreak(active?.onBreak ?? false);
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
      hapticSuccess();
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
      hapticSuccess();
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

  // Approaching-overtime nudge. Sum this workweek's worked minutes (Sun 00:00
  // local → now) from loaded history plus any in-progress shift, and warn as
  // the associate nears the federal 40h/week overtime line. Directional, not a
  // payroll figure — breaks and the employer's exact workweek may differ.
  const WEEKLY_OT_MIN = 40 * 60;
  const OT_WARN_MIN = 35 * 60;
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  // The open shift is excluded from the history sum and re-added as
  // liveMinutes: /me/entries applies no status filter, so the ACTIVE entry is
  // already in `entries` with minutesElapsed = now - clockInAt — the very same
  // quantity liveMinutes computes. Adding both counted the current shift
  // twice and pushed the overtime warning hours early. REJECTED time is
  // dropped too; it was never worked hours.
  const weekMinutes =
    (entries ?? [])
      .filter(
        (e) =>
          new Date(e.clockInAt) >= weekStart &&
          e.status !== 'REJECTED' &&
          e.id !== active?.id,
      )
      .reduce((sum, e) => sum + (e.minutesElapsed ?? 0), 0) + liveMinutes;
  const weekHours = (weekMinutes / 60).toFixed(1);
  const overtimeNudge =
    weekMinutes >= WEEKLY_OT_MIN
      ? {
          tone: 'border-alert/40 bg-alert/[0.07] text-silver',
          text: `You've logged ${weekHours}h this workweek — past the 40h line, so additional hours count as overtime. Check with your manager if that's unexpected.`,
        }
      : weekMinutes >= OT_WARN_MIN
        ? {
            tone: 'border-gold/40 bg-gold/[0.07] text-silver',
            text: `You've logged ${weekHours}h this workweek — about ${(
              (WEEKLY_OT_MIN - weekMinutes) /
              60
            ).toFixed(1)}h from the 40h overtime line.`,
          }
        : null;

  return (
    <div className="mx-auto">
      <PageHeader
        title="Time & Attendance"
        subtitle="Clock in when you start. Clock out when you stop."
      />

      {overtimeNudge && (
        <div
          className={cn(
            'mb-6 flex items-start gap-2.5 rounded-lg border p-3 text-sm',
            overtimeNudge.tone,
          )}
          role="status"
        >
          <Clock className="h-4 w-4 shrink-0 mt-0.5 text-gold" />
          <span>{overtimeNudge.text}</span>
        </div>
      )}

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
              since {fmtTime(active.clockInAt)}
              {active.clockInLat != null && active.clockInLng != null && (
                <span className="ml-2 text-silver/70">
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
                    ? 'bg-navy-secondary text-silver/70 cursor-not-allowed'
                    : 'bg-alert text-white hover:opacity-90'
                )}
              >
                {busy ? 'Saving…' : 'Clock out'}
              </button>
              {!onBreak ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleStartBreak('MEAL')}
                    disabled={breakBusy}
                  >
                    Start meal break
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleStartBreak('REST')}
                    disabled={breakBusy}
                  >
                    Start rest break
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleEndBreak}
                  loading={breakBusy}
                  disabled={breakBusy}
                >
                  End break
                </Button>
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
                <Select
                  value={selectedJobId}
                  onChange={(e) => setSelectedJobId(e.target.value)}
                >
                  <option value="">— No job tag —</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                      {j.payRate ? ` · ${fmtPayRate(j.payRate, 'HOURLY')}` : ''}
                      {j.clientName ? ` · ${j.clientName}` : ''}
                    </option>
                  ))}
                </Select>
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
            <p className="text-xs text-silver/70 mt-3">
              Your browser will ask permission to share your location for geofence verification.
            </p>
          </>
        )}
        {error && <ErrorBanner className="mt-4">{error}</ErrorBanner>}
        {info && (
          <p className="text-sm text-silver mt-4">{info}</p>
        )}
      </section>

      <section aria-label="Recent time entries">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
          <h2 className="font-display text-2xl text-white">Recent entries</h2>
          {/* Full-width 2-up on phones (two fixed w-40 fields overflowed
              360px screens); back to the compact inline pair at sm+. */}
          <div className="grid grid-cols-2 gap-2 w-full sm:flex sm:w-auto sm:items-end">
            <div>
              <label className="block text-xs2 uppercase tracking-wider text-silver mb-1">
                From
              </label>
              <input
                type="date"
                value={historyFromYmd}
                max={historyToYmd}
                onChange={(e) =>
                  setHistoryFromYmd(e.target.value || defaultHistoryFromYmd())
                }
                className="h-9 coarse:h-11 text-sm coarse:text-base rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-white focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold w-full sm:w-40"
              />
            </div>
            <div>
              <label className="block text-xs2 uppercase tracking-wider text-silver mb-1">
                To
              </label>
              <input
                type="date"
                value={historyToYmd}
                min={historyFromYmd}
                onChange={(e) =>
                  setHistoryToYmd(e.target.value || defaultHistoryToYmd())
                }
                className="h-9 coarse:h-11 text-sm coarse:text-base rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-white focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold w-full sm:w-40"
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
          <TimesheetWeeks
            entries={entries}
            renderEntry={(e) => {
              const anomalies = e.anomalies ?? [];
              const expanded = expandedId === e.id;
              const dayOff = e.clockOutAt
                ? punchDayOffset(e.clockInAt, e.clockOutAt, e.locationTimezone)
                : 0;
              return (
                <div>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : e.id)}
                    className="flex w-full items-start justify-between gap-4 px-3 py-2.5 text-left active:bg-navy-secondary/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-white tabular-nums">
                        {fmtPunchTime(e.clockInAt, e.locationTimezone)}
                        {' → '}
                        {e.clockOutAt ? (
                          <>
                            {fmtPunchTime(e.clockOutAt, e.locationTimezone)}
                            {dayOff > 0 && (
                              <span className="ml-1 text-2xs text-warning align-super">
                                +{dayOff}d
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-silver">on the clock</span>
                        )}
                      </div>
                      <div className="text-sm text-silver">
                        {formatHM(e.netMinutes ?? e.minutesElapsed)}
                        {e.netMinutes != null && e.netMinutes < e.minutesElapsed && (
                          <span className="ml-1 text-silver/70">
                            ({formatHM(e.minutesElapsed - e.netMinutes)} break)
                          </span>
                        )}
                        {e.jobName && <span className="ml-2">· {e.jobName}</span>}
                        {e.payRate && (
                          <span className="ml-2">· {fmtPayRate(e.payRate, 'HOURLY')}</span>
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
                              className="text-xs2 uppercase tracking-widest px-2 py-0.5 rounded border border-alert/40 bg-alert/10 text-alert"
                            >
                              {timeAnomalyLabel(a)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge variant={STATUS_VARIANTS[e.status]}>
                        {STATUS_LABELS[e.status]}
                      </Badge>
                      <ChevronDown
                        aria-hidden
                        className={cn(
                          'h-4 w-4 text-silver/60 transition-transform',
                          expanded && 'rotate-180',
                        )}
                      />
                    </span>
                  </button>
                  {expanded && (
                    <div className="px-3 pb-3">
                      <ShiftTimeline entry={e} />
                    </div>
                  )}
                </div>
              );
            }}
          />
        )}
      </section>
    </div>
  );
}
