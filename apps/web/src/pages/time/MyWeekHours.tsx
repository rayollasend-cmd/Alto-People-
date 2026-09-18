import { useQuery } from '@tanstack/react-query';
import { Timer } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { fmtHours } from '@/lib/format';
import { listMyTimeEntries } from '@/lib/timeApi';
import { listMyShifts } from '@/lib/schedulingApi';
import { paidShiftMinutes } from '@/pages/scheduling/ShiftCard';

/**
 * The week at a glance, on the Time page: hours worked (every punch this
 * week, the running one included) against hours scheduled — the same
 * local Sunday-start week as the schedule page and the home tile — and how
 * close that runs to the 40-hour overtime line.
 */
const OT_MIN = 40 * 60;

function weekBounds(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

export function MyWeekHours() {
  const { t } = useI18n();
  const { start, end } = weekBounds();
  const entries = useQuery({
    queryKey: ['me', 'timeEntries', 'week', start.toISOString()],
    queryFn: () => listMyTimeEntries({ from: start.toISOString(), to: end.toISOString() }).catch(() => null),
    refetchInterval: 5 * 60_000,
  });
  const shifts = useQuery({
    queryKey: ['me', 'shifts'],
    queryFn: () => listMyShifts().catch(() => null),
  });
  if (!entries.data || !shifts.data) return null;

  const worked = entries.data.entries
    .filter((e) => e.status !== 'REJECTED')
    .reduce((n, e) => n + (e.netMinutes ?? e.minutesElapsed), 0);
  const scheduled = shifts.data.shifts
    .filter((s) => {
      const at = new Date(s.startsAt).getTime();
      return s.status !== 'CANCELLED' && at >= start.getTime() && at < end.getTime();
    })
    .reduce((n, s) => n + paidShiftMinutes(s), 0);
  if (worked === 0 && scheduled === 0) return null;

  const pct = scheduled > 0 ? Math.min(100, Math.round((worked / scheduled) * 100)) : 100;
  const toGo = Math.max(0, scheduled - worked);
  const overtime = Math.max(0, worked - OT_MIN);
  const heading = Math.max(worked, scheduled) > OT_MIN;

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
        {scheduled > 0 && (
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
      {(overtime > 0 || heading) && (
        <p className={cn('mt-2 text-xs', overtime > 0 ? 'text-warning' : 'text-silver')}>
          {overtime > 0
            ? t('week.overtime', { hours: fmtHours(overtime / 60) })
            : t('week.headingOver', { hours: fmtHours((scheduled - OT_MIN) / 60) })}
        </p>
      )}
    </section>
  );
}
