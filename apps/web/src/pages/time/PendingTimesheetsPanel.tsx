import { lazy, Suspense, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { timesheetQueuePath, type TimeEntry } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useI18n } from '@/lib/i18n';
import { fmtDateOnlyRange, fmtTimeTz, fmtWeekdayTz, fmtDateTz, ymdLocal, browserTimeZone, tzAbbrev, zonedDayKey } from '@/lib/format';
import { useListKeyboard } from '@/lib/shortcuts';
import { timeAnomalyLabel } from '@/lib/timeLabels';
import {
  approveTimeEntry,
  bulkApproveTimeEntries,
  countAdminTimeEntries,
  listAdminTimeEntries,
  listPayPeriods,
  rejectTimeEntry,
} from '@/lib/timeApi';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatHM } from './punchFormat';

/** The /time-attendance entry editor, loaded only when "Fix time" opens it. */
const TimeEntryFormDrawer = lazy(() => import('./AdminTimeView').then((m) => ({ default: m.TimeEntryFormDrawer })));

/**
 * The timesheets waiting for approval, inline — for the Approvals hub (role
 * walk floor 7, HR 16). The hub used to show "Timesheets 6" as the last of
 * eight tiles and bounce to another page; here the clean ones approve in
 * one tap (and can be looked at first) and the flagged ones are listed
 * with their reason, their age and their pay period, each with Fix time,
 * Approve and Reject. j/k move, a approves, d opens the reject box.
 *
 * Same predicate as every count (lib/pendingTime via the count endpoint):
 * finished punches in the last 90 days the caller can see. Renders nothing
 * when none are pending, so the hub can fold it with its other zeros.
 * The caller's own entries never get Approve — someone else approves
 * those, and the server refuses (own_entry) either way.
 */

const SHOW = 5;

/** "Thu Sep 18 · 1:55–9:55 PM" — the zone only when it isn't the viewer's. */
function punchLine(e: TimeEntry): string {
  const tz = e.locationTimezone ?? browserTimeZone();
  const day = `${fmtWeekdayTz(e.clockInAt, tz)} ${fmtDateTz(e.clockInAt, tz)}`;
  const span = e.clockOutAt ? `${fmtTimeTz(e.clockInAt, tz)}–${fmtTimeTz(e.clockOutAt, tz)}` : fmtTimeTz(e.clockInAt, tz);
  const zone = tz !== browserTimeZone() ? ` ${tzAbbrev(tz, e.clockInAt)}` : '';
  return `${day} · ${span}${zone}`;
}

export function PendingTimesheetsPanel({ className }: { className?: string }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ownId = user?.associateId ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [showClean, setShowClean] = useState(false);
  const [fixing, setFixing] = useState<TimeEntry | null>(null);

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
  // The pay periods, so a flagged row says which one it falls in and whether it was paid.
  const periodsQuery = useQuery({ queryKey: ['time', 'pay-periods'], queryFn: listPayPeriods, enabled: total > 0, staleTime: 10 * 60_000 });
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

  /** "34 days ago · Sep 12 – 25, 2026, paid" — how old the entry is and the pay period it belongs to. */
  const ageAndPeriod = (e: TimeEntry): string => {
    const day = zonedDayKey(e.clockInAt, e.locationTimezone ?? browserTimeZone());
    const days = Math.max(0, Math.round((Date.parse(`${ymdLocal()}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000));
    const age = days === 0 ? t('pts.today') : t('pts.daysAgo', { count: days });
    const period = (periodsQuery.data?.periods ?? []).find((p) => p.start <= day && day <= p.end);
    if (!period) return age;
    const range = fmtDateOnlyRange(period.start, period.end);
    return `${age} · ${period.hasRun ? t('pts.periodPaid', { range }) : t('pts.period', { range })}`;
  };

  const oldest = countQuery.data?.oldestPendingAt;
  const queueHref = timesheetQueuePath({
    from: ymdLocal(oldest ? new Date(oldest) : new Date(Date.now() - 90 * 86_400_000)),
    to: ymdLocal(new Date()),
  });

  const approveAllClean = async () => {
    if (clean.length === 0 || busy) return;
    setBusy('all');
    try {
      const res = await bulkApproveTimeEntries({ entryIds: clean.map((e) => e.id) });
      if (res.failed > 0) toast.warning(t('pts.someFailed', { ok: res.succeeded, failed: res.failed }));
      else
        toast.success(t('pts.approvedN', { count: res.succeeded }), {
          // Where the approved rows are now: the queue, approved.
          action: { label: t('pts.seeThem'), onClick: () => navigate(queueHref.replace('status=COMPLETED', 'status=APPROVED')) },
        });
      setShowClean(false);
      refresh();
    } catch (err) {
      fail(err, t('pts.couldNotApprove'));
    } finally {
      setBusy(null);
    }
  };
  const approveOne = async (e: TimeEntry) => {
    if (busy || isOwn(e)) return;
    setBusy(e.id);
    try {
      await approveTimeEntry(e.id);
      toast.success(t('pts.approvedOne', { name: e.associateName ?? t('pts.entry') }));
      refresh();
    } catch (err) {
      fail(err, t('pts.couldNotApprove'));
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
      toast.success(t('pts.rejectedOne', { name: e.associateName ?? t('pts.entry') }));
      setRejecting(null);
      setReason('');
      refresh();
    } catch (err) {
      fail(err, t('pts.couldNotReject'));
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
    enabled: rejecting === null && fixing === null,
  });

  if (!countQuery.data || total === 0) return null;

  return (
    <section className={cn('rounded-lg border border-navy-secondary bg-navy-secondary/20 p-4', className)} aria-label={t('pts.aria')} data-testid="pending-timesheets-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">
          {t('pts.title')} <span className="tabular-nums text-silver">· {t('pts.pending', { count: total })}</span>
        </h3>
        {/* The one link to the full queue (the page header no longer repeats it). */}
        <Link to={queueHref} className="inline-flex items-center gap-1 text-xs text-gold hover:underline">
          {t('pts.openQueue')} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      {clean.length > 0 && (
        <div className="mt-3 rounded-md border border-success/30 bg-success/10 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowClean((v) => !v)}
              aria-expanded={showClean}
              className="inline-flex items-center gap-1 text-sm text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            >
              {t('pts.cleanLine', { count: clean.length })}
              <span className="text-xs text-silver">· {showClean ? t('pts.hide') : t('pts.show')}</span>
              <ChevronDown className={cn('h-3.5 w-3.5 text-silver transition-transform', showClean && 'rotate-180')} aria-hidden="true" />
            </button>
            <Button size="sm" variant="primary" onClick={approveAllClean} loading={busy === 'all'} disabled={busy !== null} data-testid="approve-clean">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {t('pts.approveClean', { count: clean.length })}
            </Button>
          </div>
          {showClean && (
            <ul className="mt-2 divide-y divide-success/20 text-sm" aria-label={t('pts.cleanAria')} data-testid="clean-rows">
              {clean.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
                  <span className="font-medium text-ink">{e.associateName ?? '—'}</span>
                  <span className="tabular-nums text-silver">
                    {punchLine(e)} · {formatHM(e.netMinutes ?? e.minutesElapsed)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {own.length > 0 && <p className="mt-2 text-xs text-silver/70">{t('pts.yoursLine', { count: own.length })}</p>}

      {flagged.length > 0 && (
        <div className="mt-3">
          <p className="text-2xs uppercase tracking-wider text-silver">{t('pts.flaggedHead', { count: flagged.length })}</p>
          <ul {...kb.listProps} className="mt-1.5 divide-y divide-navy-secondary rounded-md outline-none focus-visible:ring-2 focus-visible:ring-gold/50">
            {shownFlagged.map((e) => {
              const mine = isOwn(e);
              const rowBusy = busy === e.id;
              return (
                <li
                  key={e.id}
                  {...kb.rowProps(e.id)}
                  // Stacked on a phone: name and reason, then the punch, then a full-width pair of buttons.
                  className={cn('flex flex-col gap-1.5 py-2.5 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3', kb.cursor === e.id && 'bg-gold/[0.08]')}
                  data-testid="pending-flagged-row"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-ink">{e.associateName ?? '—'}</span>
                      <span className="text-xs text-warning">{(e.anomalies ?? []).map(timeAnomalyLabel).join(' · ')}</span>
                    </span>
                    <span className="block tabular-nums text-silver">
                      {punchLine(e)} · {formatHM(e.netMinutes ?? e.minutesElapsed)}
                    </span>
                    <span className="block text-xs text-silver/70" data-testid="flagged-age">
                      {ageAndPeriod(e)}
                    </span>
                  </span>
                  {mine ? (
                    <span className="text-2xs text-silver/70" title={t('pts.yoursTitle')}>
                      {t('pts.yours')}
                    </span>
                  ) : rejecting === e.id ? (
                    <span className="flex w-full items-center gap-2 sm:w-auto">
                      <Input
                        autoFocus
                        value={reason}
                        onChange={(ev) => setReason(ev.target.value)}
                        placeholder={t('pts.reasonPh')}
                        className="h-8 text-sm"
                        aria-label={t('pts.reasonAria')}
                      />
                      <Button size="sm" variant="destructive" onClick={() => void rejectOne(e)} loading={rowBusy} disabled={busy !== null || reason.trim().length === 0}>
                        {t('pts.reject')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setRejecting(null); setReason(''); }} disabled={rowBusy}>
                        {t('common.cancel')}
                      </Button>
                    </span>
                  ) : (
                    <span className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:items-center sm:gap-1">
                      {/* A forgotten clock-out wants the right time, not a yes or no. */}
                      <Button size="sm" variant="secondary" onClick={() => setFixing(e)} disabled={busy !== null}>
                        {t('pts.fixTime')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void approveOne(e)} loading={rowBusy} disabled={busy !== null}>
                        {t('pts.approve')}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-alert hover:bg-alert/10 hover:text-alert" onClick={() => setRejecting(e.id)} disabled={busy !== null}>
                        {t('pts.reject')}
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {flagged.length > SHOW && <p className="mt-1.5 text-xs text-silver/70">{t('pts.moreFlagged', { count: flagged.length - SHOW })}</p>}
        </div>
      )}
      {fixing && (
        <Suspense fallback={null}>
          <TimeEntryFormDrawer
            mode="edit"
            entry={fixing}
            onClose={() => setFixing(null)}
            onSaved={() => {
              setFixing(null);
              refresh();
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
