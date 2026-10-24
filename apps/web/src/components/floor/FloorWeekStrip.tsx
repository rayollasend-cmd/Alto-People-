import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays } from '@/components/ui/icons';
import { getFloorWeek } from '@/lib/floorApi';
import { fmtDate, fmtWeekday, parseYmd } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useI18n } from '@/lib/i18n';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The week at the store, for the watch-only floor supervisor — who has
 * no schedule read, only today and tomorrow before this. Counts, never
 * money: scheduled, confirmed, still open, one cell a day.
 */
export function FloorWeekStrip({ className }: { className?: string }) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['floor', 'week'], queryFn: getFloorWeek, refetchInterval: 5 * 60_000 });
  const days = q.data?.days ?? null;
  return (
    <Card className={cn('animate-enter', className)} data-testid="floor-week">
      <CardContent className="p-5">
        <SectionTitle icon={CalendarDays} title={t('floorUi.thisWeekAtStore')} className="mb-0" />
        {days === null ? (
          <Skeleton className="mt-3 h-20" />
        ) : (
          <div className="mt-3 grid grid-cols-7 gap-1.5">
            {days.map((d, i) => {
              const date = parseYmd(d.date)!;
              const tone = d.open > 0 ? 'text-warning' : d.scheduled > 0 ? 'text-success' : 'text-silver/50';
              return (
                <Link
                  key={d.date}
                  to={`/today?date=${d.date}`}
                  aria-label={t('floorUi.weekDayAria', { date: fmtDate(date), scheduled: d.scheduled, open: d.open })}
                  className={cn(
                    'flex flex-col items-center rounded-md border px-0.5 py-2 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    i === 0 ? 'border-gold/50 bg-gold/[0.08]' : 'border-navy-secondary bg-navy-secondary/20',
                  )}
                >
                  <span className={cn('text-2xs uppercase', i === 0 ? 'text-gold' : 'text-silver/70')}>{fmtWeekday(date, 'narrow')}</span>
                  <span className="text-sm font-semibold tabular-nums text-ink">{date.getDate()}</span>
                  <span className={cn('mt-1 text-2xs tabular-nums', tone)}>{d.scheduled > 0 ? d.scheduled : '–'}</span>
                  <span aria-hidden="true" className={cn('mt-1 h-1.5 w-1.5 rounded-full', d.open > 0 ? 'bg-warning' : 'bg-transparent')} />
                </Link>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-2xs text-silver/70">{t('floorUi.weekLegend')}</p>
      </CardContent>
    </Card>
  );
}
