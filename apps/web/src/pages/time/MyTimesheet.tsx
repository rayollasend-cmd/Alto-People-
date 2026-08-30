import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Flag, History } from 'lucide-react';
import { toast } from 'sonner';
import type { TimeEntry } from '@alto-people/shared';
import { listMyTimeEntries } from '@/lib/timeApi';
import { fileCase } from '@/lib/hrCases123Api';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  fmtDateTz,
  fmtMoney,
  fmtTime,
  fmtWeekdayTz,
  ymdLocal,
  ymdToIsoEndExclusive,
  ymdToIsoStart,
} from '@/lib/format';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Badge } from '@/components/ui/Badge';
import { statusTone } from '@/lib/status';
import { TIME_ENTRY_STATUS_TONES } from '@/lib/timeLabels';
import { Input, Textarea } from '@/components/ui/Input';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';

/**
 * Read-only punch history for hourly associates — the answer to "how
 * many hours did I get approved for?" without asking a manager.
 * Entries group by week (local Sunday-start) with per-week totals and
 * an overtime callout past 40h, each row shows kiosk in/out vs the
 * scheduled shift, and approved hours roll up into a summary band with
 * an estimated-gross figure when every approved entry carries a rate.
 *
 * Read-only by design — associates PUNCH at the kiosk; when something
 * looks wrong, the per-entry "Report an issue" files an HR case with
 * the entry's facts attached, so disputes get a paper trail instead of
 * a hallway conversation.
 */

// Labels stay i18n keys (this page is translated); tones come from the
// shared vocabulary with the time-domain overrides (see lib/timeLabels.ts).
const STATUS_KEY: Record<TimeEntry['status'], MessageKey> = {
  ACTIVE: 'time.status.ACTIVE',
  COMPLETED: 'time.status.COMPLETED',
  APPROVED: 'time.status.APPROVED',
  REJECTED: 'time.status.REJECTED',
};

const WEEK_REGULAR_CAP_MIN = 40 * 60;

function daysAgoYmd(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return ymdLocal(d);
}

/** Local Sunday-start week anchor for grouping. */
function weekStartMs(input: string | Date): number {
  const d = new Date(input);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}

// Two decimals, matching formatHM and the Fieldglass/payroll convention.
function fmtH(minutes: number): string {
  return `${(minutes / 60).toFixed(2)}h`;
}

/** "Wed, Jul 2" — house weekday+date formatting (browser-local). */
function fmtEntryDay(iso: string): string {
  return `${fmtWeekdayTz(iso)}, ${fmtDateTz(iso)}`;
}

type Preset = 'THIS_WEEK' | 'LAST_WEEK' | 'LAST14';

const PRESETS: Array<[Preset, MessageKey]> = [
  ['THIS_WEEK', 'sched.thisWeek'],
  ['LAST_WEEK', 'time.lastWeek'],
  ['LAST14', 'time.last14'],
];

export function MyTimesheet() {
  const { t } = useI18n();
  const [fromYmd, setFromYmd] = useState(daysAgoYmd(13));
  const [toYmd, setToYmd] = useState(ymdLocal(new Date()));
  // Which quick-range chip produced the current window; manual date
  // edits clear it so the chips never lie about what's shown.
  const [activePreset, setActivePreset] = useState<Preset | null>('LAST14');
  const [disputeTarget, setDisputeTarget] = useState<TimeEntry | null>(null);

  const applyPreset = (p: Preset) => {
    setActivePreset(p);
    const now = new Date();
    if (p === 'LAST14') {
      setFromYmd(daysAgoYmd(13));
      setToYmd(ymdLocal(now));
      return;
    }
    const thisWeekStart = new Date(now);
    thisWeekStart.setHours(0, 0, 0, 0);
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    if (p === 'THIS_WEEK') {
      setFromYmd(ymdLocal(thisWeekStart));
      setToYmd(ymdLocal(now));
    } else {
      const lastStart = new Date(thisWeekStart);
      lastStart.setDate(lastStart.getDate() - 7);
      const lastEnd = new Date(thisWeekStart);
      lastEnd.setDate(lastEnd.getDate() - 1);
      setFromYmd(ymdLocal(lastStart));
      setToYmd(ymdLocal(lastEnd));
    }
  };

  const query = useQuery({
    queryKey: ['me', 'timeEntries', fromYmd, toYmd],
    queryFn: async () => {
      try {
        return await listMyTimeEntries({
          from: ymdToIsoStart(fromYmd),
          to: ymdToIsoEndExclusive(toYmd),
        });
      } catch (err) {
        // Not linked to an associate record yet → honest empty state.
        if (err instanceof ApiError && err.status === 403) return { entries: [] };
        throw err;
      }
    },
  });

  const entries = query.data?.entries ?? null;

  const { weeks, approvedMin, pendingMin, grossEstimate } = useMemo(() => {
    const list = entries ?? [];
    let approved = 0;
    let pending = 0;
    let gross: number | null = 0;
    const byWeek = new Map<number, { entries: TimeEntry[]; workedMin: number }>();
    for (const e of list) {
      const net = e.netMinutes ?? e.minutesElapsed;
      if (e.status === 'APPROVED') {
        approved += net;
        // Gross estimate only when EVERY approved entry has a rate — a
        // partial sum would silently understate the number.
        if (gross !== null) {
          gross = e.payRate != null ? gross + (net / 60) * e.payRate : null;
        }
      }
      if (e.status === 'COMPLETED' || e.status === 'ACTIVE') pending += net;
      const wk = weekStartMs(e.clockInAt);
      const bucket = byWeek.get(wk) ?? { entries: [], workedMin: 0 };
      bucket.entries.push(e);
      if (e.status !== 'REJECTED') bucket.workedMin += net;
      byWeek.set(wk, bucket);
    }
    const weeksSorted = [...byWeek.entries()].sort((a, b) => b[0] - a[0]);
    return {
      weeks: weeksSorted,
      approvedMin: approved,
      pendingMin: pending,
      grossEstimate: gross !== null && gross > 0 && approved > 0 ? gross : null,
    };
  }, [entries]);

  // "This week" / "Last week" instead of anonymous dates where they apply.
  const currentWeekMs = weekStartMs(new Date());
  // Stepped back a calendar week, not 7×24h: across a DST change last week's
  // local-midnight anchor is an hour off a fixed-millisecond subtraction, and
  // the equality below would miss — labelling last week as a bare date.
  const lastWeekMs = (() => {
    const d = new Date(currentWeekMs);
    d.setDate(d.getDate() - 7);
    return d.getTime();
  })();
  const weekLabel = (weekMs: number): string => {
    if (weekMs === currentWeekMs) return t('sched.thisWeek');
    if (weekMs === lastWeekMs) return t('time.lastWeek');
    return t('time.weekOf', { date: fmtDateTz(new Date(weekMs)) });
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t('time.myTimesheet')}</CardTitle>
        <CardDescription>{t('time.myTimesheetDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Summary band — the three numbers the page exists to answer,
            in the same stat-strip language as My Schedule. */}
        {!entries && !query.isError && <Skeleton className="h-16 mb-4" />}
        {entries && entries.length > 0 && (
          <div className="mb-4 inline-flex items-stretch rounded-lg border border-navy-secondary bg-navy divide-x divide-navy-secondary">
            <TimesheetStat
              label={t('time.status.APPROVED')}
              value={fmtH(approvedMin)}
              tone="success"
            />
            <TimesheetStat
              label={t('time.status.COMPLETED')}
              value={fmtH(pendingMin)}
              tone={pendingMin > 0 ? 'gold' : 'muted'}
            />
            {grossEstimate !== null && (
              <TimesheetStat
                label={t('time.grossLabel')}
                value={fmtMoney(grossEstimate)}
                tone="plain"
                title={t('time.grossDisclaimer')}
              />
            )}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3 mb-5">
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={t('time.rangeAria')}
          >
            {PRESETS.map(([preset, key]) => {
              const active = activePreset === preset;
              return (
                <Button
                  key={preset}
                  size="xs"
                  variant="outline"
                  aria-pressed={active}
                  onClick={() => applyPreset(preset)}
                  className={cn(
                    active &&
                      'border-gold text-gold bg-gold/10 hover:border-gold hover:text-gold',
                  )}
                >
                  {t(key)}
                </Button>
              );
            })}
          </div>
          <label className="block">
            <span className="text-xs2 uppercase tracking-wider text-silver">
              {t('common.from')}
            </span>
            <Input
              type="date"
              value={fromYmd}
              max={toYmd}
              onChange={(e) => {
                setFromYmd(e.target.value);
                setActivePreset(null);
              }}
              className="mt-1 w-40"
            />
          </label>
          <label className="block">
            <span className="text-xs2 uppercase tracking-wider text-silver">
              {t('common.to')}
            </span>
            <Input
              type="date"
              value={toYmd}
              min={fromYmd}
              onChange={(e) => {
                setToYmd(e.target.value);
                setActivePreset(null);
              }}
              className="mt-1 w-40"
            />
          </label>
        </div>

        {query.isError && (
          <ErrorBanner
            className="mb-4"
            action={
              <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            }
          >
            {query.error instanceof ApiError
              ? query.error.message
              : t('time.loadFailed')}
          </ErrorBanner>
        )}
        {!entries && !query.isError && <SkeletonRows count={4} rowHeight="h-14" />}
        {entries && entries.length === 0 && (
          <EmptyState
            icon={History}
            title={t('time.noEntries')}
            description={t('time.noEntriesDesc')}
          />
        )}
        {entries && entries.length > 0 && (
          <div className="space-y-6">
            {weeks.map(([weekMs, bucket]) => {
              const overtimeMin = Math.max(0, bucket.workedMin - WEEK_REGULAR_CAP_MIN);
              return (
                <section key={weekMs}>
                  <div className="mb-2 flex items-baseline justify-between gap-3 border-b border-navy-secondary pb-1.5">
                    <h3
                      className={cn(
                        'text-xs2 uppercase tracking-wider',
                        weekMs === currentWeekMs
                          ? 'text-gold font-semibold'
                          : 'text-silver/80',
                      )}
                    >
                      {weekLabel(weekMs)}
                    </h3>
                    <span className="flex items-center gap-2 text-xs2 tabular-nums text-silver/70">
                      {fmtH(bucket.workedMin)}
                      {overtimeMin > 0 && (
                        <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning">
                          {t('time.weekOvertime', { hours: fmtH(overtimeMin) })}
                        </span>
                      )}
                    </span>
                  </div>
                  <ul className="divide-y divide-navy-secondary/60">
                    {bucket.entries.map((e) => {
                      const breakMin = (e.breaks ?? []).reduce((s, b) => s + b.minutes, 0);
                      const live = e.status === 'ACTIVE';
                      return (
                        <li
                          key={e.id}
                          className={cn(
                            'py-3 pl-3 -ml-3 rounded-md',
                            live && 'bg-success/5',
                            e.status === 'REJECTED' &&
                              'border-l-2 border-l-alert pl-2.5',
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-sm text-white font-medium">
                                {live && (
                                  <span
                                    className="h-2 w-2 shrink-0 rounded-full bg-success animate-pulse"
                                    aria-hidden="true"
                                  />
                                )}
                                {fmtEntryDay(e.clockInAt)}
                              </div>
                              <div className="text-xs text-silver mt-0.5 tabular-nums">
                                {fmtTime(e.clockInAt)}
                                {' – '}
                                {e.clockOutAt ? fmtTime(e.clockOutAt) : t('time.stillOn')}
                                {breakMin > 0 &&
                                  // Decimal hours like every other duration.
                                  ` · ${t('time.breakMinutes', { minutes: (breakMin / 60).toFixed(2) })}`}
                              </div>
                              {e.shiftStartsAt && e.shiftEndsAt && (
                                <div className="text-xs2 text-silver/60 mt-0.5 tabular-nums">
                                  {t('time.scheduled', {
                                    range: `${fmtTime(e.shiftStartsAt)}–${fmtTime(e.shiftEndsAt)}`,
                                  })}
                                  {e.shiftPosition && ` · ${e.shiftPosition}`}
                                </div>
                              )}
                              {e.rejectionReason && (
                                <div className="text-xs text-alert mt-1">
                                  {e.rejectionReason}
                                </div>
                              )}
                              <Button
                                size="xs"
                                variant="ghost"
                                className="mt-1 -ml-2 text-silver/60 hover:text-white"
                                onClick={() => setDisputeTarget(e)}
                              >
                                <Flag className="h-3 w-3" />
                                {t('time.reportIssue')}
                              </Button>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1.5">
                              <span
                                className={cn(
                                  'text-base font-medium tabular-nums',
                                  e.status === 'REJECTED'
                                    ? 'text-silver/50 line-through'
                                    : 'text-white',
                                )}
                              >
                                {fmtH(e.netMinutes ?? e.minutesElapsed)}
                              </span>
                              <Badge variant={statusTone(e.status, { overrides: TIME_ENTRY_STATUS_TONES })}>
                                {t(STATUS_KEY[e.status])}
                              </Badge>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            {grossEstimate !== null && (
              <p className="text-xs2 text-silver/60">{t('time.grossDisclaimer')}</p>
            )}
          </div>
        )}
      </CardContent>

      <DisputeDialog target={disputeTarget} onClose={() => setDisputeTarget(null)} />
    </Card>
  );
}

function TimesheetStat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone: 'success' | 'gold' | 'muted' | 'plain';
  title?: string;
}) {
  return (
    <div className="px-3.5 py-2 first:pl-4 last:pr-4" title={title}>
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70 whitespace-nowrap">
        {label}
      </div>
      <div
        className={cn(
          'text-2xl tabular-nums mt-0.5',
          tone === 'success' && 'text-success',
          tone === 'gold' && 'text-gold',
          tone === 'muted' && 'text-silver',
          tone === 'plain' && 'text-white',
        )}
      >
        {value}
      </div>
    </div>
  );
}

// Tappable starters for the most common disputes — filling the textarea
// beats thumb-typing a paragraph at the kiosk door. Deliberately not
// translated: they land verbatim in the case description, which (like the
// auto-attached facts below) is written in English for the HR reader.
const DISPUTE_PRESETS = [
  'I forgot to clock out — my shift actually ended at …',
  'My break was shorter than recorded',
  'I worked but this entry is missing time',
  "This entry isn't mine",
] as const;

function DisputeDialog({
  target,
  onClose,
}: {
  target: TimeEntry | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const open = target !== null;

  const submit = async () => {
    if (!target || submitting) return;
    if (message.trim().length === 0) {
      toast.error(t('time.whatsWrong'));
      return;
    }
    setSubmitting(true);
    try {
      const day = fmtEntryDay(target.clockInAt);
      const range = `${fmtTime(target.clockInAt)}–${
        target.clockOutAt ? fmtTime(target.clockOutAt) : '…'
      }`;
      await fileCase({
        category: 'PAYROLL',
        subject: `Time entry ${day} (${range})`,
        // The last line is an app-internal path the HR-cases page renders
        // as a link — it lands reviewers on this exact entry (queue tab,
        // drawer open) instead of a manual search from the prose id.
        description: `${message.trim()}\n\n— Entry details (auto-attached) —\nDate: ${day}\nPunches: ${range}\nStatus: ${target.status}\nEntry id: ${target.id}\nOpen the entry: /time-attendance?entry=${target.id}`,
      });
      toast.success(t('time.reportSent'));
      setMessage('');
      onClose();
    } catch (err) {
      toast.error(t('time.reportFailed'), {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('time.reportIssue')}</DialogTitle>
          <DialogDescription>{t('time.reportIssueDesc')}</DialogDescription>
        </DialogHeader>
        {target && (
          <p className="text-xs text-silver tabular-nums">
            {fmtEntryDay(target.clockInAt)} · {fmtTime(target.clockInAt)}
            {' – '}
            {target.clockOutAt ? fmtTime(target.clockOutAt) : t('time.stillOn')}
          </p>
        )}
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label={t('time.whatsWrong')}
        >
          {DISPUTE_PRESETS.map((preset) => (
            <Button
              key={preset}
              size="xs"
              variant="outline"
              // xs is chip-height with nowrap; these labels are sentences,
              // so let them wrap on narrow phones.
              className="h-auto min-h-7 whitespace-normal py-1.5 text-left coarse:min-h-9"
              onClick={() => setMessage(preset)}
            >
              {preset}
            </Button>
          ))}
        </div>
        <label className="block">
          <span className="text-xs2 uppercase tracking-wider text-silver">
            {t('time.whatsWrong')}
          </span>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t('time.reportPlaceholder')}
            className="mt-1"
          />
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {t('time.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
