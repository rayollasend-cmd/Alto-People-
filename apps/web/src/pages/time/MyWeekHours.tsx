import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Timer } from 'lucide-react';
import { paidMinutesForRange, type Shift, type TimeEntry } from '@alto-people/shared';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { fmtHours } from '@/lib/format';
import { listMyTimeEntries } from '@/lib/timeApi';
import { listMyShifts } from '@/lib/schedulingApi';
import { paidShiftMinutes } from '@/pages/scheduling/ShiftCard';
import { workweekBounds } from '@/lib/workweek';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useMyEarnings } from '@/components/EarningsCard';

/**
 * The week at a glance, on the Time page: hours worked (every punch this
 * week, the running one included) against hours scheduled — the Sat→Fri
 * workweek payroll and overtime run on (lib/workweek). The overtime it
 * names is the server's — each punch's share of the labor-rules split the
 * paycheck pays (daily rules included where they're paid), and the
 * schedule's projected overtime from the earnings estimate — never
 * "minutes − 40h" worked out here.
 *
 * "To go" is only what is still ahead: a future shift in full, the shift in
 * progress from now. A shift that already ended without a punch is not
 * "to go" — it reads "7h scheduled, not punched", with the way to fix it
 * (F500 G2: a past, unworked shift used to say "7h to go").
 */

/** The week's shifts split by the clock: what is still ahead, and what passed with no punch. */
export function weekScheduleSplit(
  shifts: readonly Pick<Shift, 'id' | 'startsAt' | 'endsAt' | 'status'>[],
  entries: readonly Pick<TimeEntry, 'shiftId' | 'clockInAt' | 'clockOutAt' | 'status'>[],
  now: Date = new Date(),
): { toGoMinutes: number; notPunchedMinutes: number } {
  const t = now.getTime();
  const live = entries.filter((e) => e.status !== 'REJECTED');
  let toGoMinutes = 0;
  let notPunchedMinutes = 0;
  for (const s of shifts) {
    const start = new Date(s.startsAt).getTime();
    const end = new Date(s.endsAt).getTime();
    if (end > t) {
      toGoMinutes += paidMinutesForRange(new Date(Math.max(start, t)), new Date(end));
      continue;
    }
    // Ended: was it punched? The punch linked to it, or any punch that
    // overlaps its window (a walk-in punch the matcher didn't link).
    const punched = live.some(
      (e) =>
        e.shiftId === s.id ||
        (new Date(e.clockInAt).getTime() < end && (e.clockOutAt ? new Date(e.clockOutAt).getTime() : t) > start),
    );
    if (!punched) notPunchedMinutes += paidMinutesForRange(s.startsAt, s.endsAt);
  }
  return { toGoMinutes, notPunchedMinutes };
}

export function MyWeekHours() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const { start, end } = workweekBounds();
  // No `.catch(() => null)` on these. Swallowing the error made the query
  // *succeed* with null, so React Query never retried, nothing was ever
  // shown, and the tile simply wasn't there — an associate checking their
  // hours couldn't tell a failed request from a week they hadn't worked.
  const entries = useQuery({
    queryKey: ['me', 'timeEntries', 'week', start.toISOString()],
    queryFn: () => listMyTimeEntries({ from: start.toISOString(), to: end.toISOString() }),
    refetchInterval: 5 * 60_000,
  });
  const shifts = useQuery({
    queryKey: ['me', 'shifts'],
    queryFn: () => listMyShifts(),
  });
  // Decorative: the projected-overtime line only. A failed fetch just leaves it off.
  const earnings = useMyEarnings();
  if (entries.isError || shifts.isError) {
    return (
      <QueryError
        className="mb-5"
        what="your hours this week"
        query={entries.isError ? entries : shifts}
      />
    );
  }
  // The tile is the page's hero number; a bar of the right height keeps the
  // rest of the page from jumping when it lands.
  if (entries.isLoading || shifts.isLoading) return <Skeleton className="mb-5 h-36" />;
  if (!entries.data || !shifts.data) return null;

  const worked = entries.data.entries
    .filter((e) => e.status !== 'REJECTED')
    .reduce((n, e) => n + (e.netMinutes ?? e.minutesElapsed), 0);
  const weekShifts = shifts.data.shifts.filter((s) => {
    const at = new Date(s.startsAt).getTime();
    return s.status !== 'CANCELLED' && at >= start.getTime() && at < end.getTime();
  });
  const scheduled = weekShifts.reduce((n, s) => n + paidShiftMinutes(s), 0);
  if (worked === 0 && scheduled === 0) return null;

  const pct = scheduled > 0 ? Math.min(100, Math.round((worked / scheduled) * 100)) : 100;
  const { toGoMinutes: toGo, notPunchedMinutes: notPunched } = weekScheduleSplit(weekShifts, entries.data.entries);
  // "Fix a punch" opens the request on this same page (PunchFixes reads ?fix=1).
  const fixParams = new URLSearchParams(params);
  fixParams.set('fix', '1');
  const overtime = Math.round(
    entries.data.entries
      .filter((e) => e.status !== 'REJECTED')
      .reduce((n, e) => n + (e.hours ? e.hours.overtimeMinutes + e.hours.doubleTimeMinutes : 0), 0),
  );
  const projectedOtHours = earnings.data?.overtime?.projectedOtHours ?? 0;
  const heading = projectedOtHours > 0;

  return (
    <section
      aria-label={t('sched.thisWeek')}
      className="mb-5 rounded-lg border border-navy-secondary bg-navy p-5 animate-enter"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
          <Timer className="h-3.5 w-3.5" aria-hidden="true" />
          {t('sched.thisWeek')}
        </span>
        {scheduled > 0 && (toGo > 0 || notPunched === 0) && (
          <span className="text-xs tabular-nums text-silver/80">
            {toGo > 0 ? t('week.toGo', { hours: fmtHours(toGo / 60) }) : t('week.allWorked')}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-4xl font-bold tracking-tight tabular-nums text-white">{fmtHours(worked / 60)}</span>
        {scheduled > 0 && (
          <span className="text-lg font-semibold tabular-nums text-silver/60">
            / {fmtHours(scheduled / 60)} {t('week.scheduledShort')}
          </span>
        )}
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
        <div
          className={cn('h-full rounded-full transition-all', overtime > 0 ? 'bg-warning' : 'bg-gold')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {notPunched > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-warning" data-testid="week-not-punched">
          <span className="tabular-nums">{t('week.notPunched', { hours: fmtHours(notPunched / 60) })}</span>
          <Link to={`?${fixParams.toString()}`} className="font-medium text-gold underline-offset-2 hover:underline">
            {t('timefix.title')}
          </Link>
        </p>
      )}
      {(overtime > 0 || heading) && (
        <p className={cn('mt-2 text-xs', overtime > 0 ? 'text-warning' : 'text-silver')}>
          {overtime > 0
            ? t('week.overtime', { hours: fmtHours(overtime / 60) })
            : t('week.headingOver', { hours: fmtHours(projectedOtHours) })}
        </p>
      )}
    </section>
  );
}
