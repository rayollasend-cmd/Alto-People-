import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent } from '@/components/ui/Card';
import { CountUpValue } from '@/components/ui/MetricCard';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * "My earnings this week" — the schedule as money, animated. Earned so
 * far counts up on mount; a progress bar walks toward the projected
 * Friday total; today's shift greets with its dollar value. Estimates
 * only (gross, at the associate's rate) — the disclaimer says so.
 * Vanishes quietly when the login has no associate record or the fetch
 * fails: motivation is a bonus, never an error state.
 */

interface Earnings {
  hourlyRate: number;
  earnedSoFar: number;
  workedHours: number;
  projectedWeek: number;
  remainingHours: number;
  todayShift: {
    startsAt: string;
    endsAt: string;
    estAmount: number;
    inProgress: boolean;
  } | null;
}

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function EarningsCard() {
  const { t } = useI18n();
  const [data, setData] = useState<Earnings | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiFetch<Earnings>('/time/me/earnings')
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;
  if (data === null) return <Skeleton className="h-28" />;
  // Nothing scheduled and nothing worked: stay quiet rather than show $0.
  if (data.projectedWeek <= 0 && data.earnedSoFar <= 0) return null;

  const pct =
    data.projectedWeek > 0
      ? Math.min(100, Math.round((data.earnedSoFar / data.projectedWeek) * 100))
      : 0;

  return (
    <Card className="border-gold/25 bg-gradient-to-br from-gold/[0.07] to-transparent">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
            <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
            {t('earn.title')}
          </span>
          {data.todayShift && data.todayShift.estAmount > 0 && (
            <span className="text-xs text-white">
              {t(data.todayShift.inProgress ? 'earn.finishToday' : 'earn.readyToday', {
                amount: MONEY.format(data.todayShift.estAmount),
              })}
            </span>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div>
            <div className="text-3xl font-semibold tabular-nums text-white">
              <CountUpValue value={MONEY.format(data.earnedSoFar)} />
            </div>
            <div className="text-2xs text-silver/70">{t('earn.soFar')}</div>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold tabular-nums text-gold">
              {MONEY.format(data.projectedWeek)}
            </div>
            <div className="text-2xs text-silver/70">{t('earn.projected')}</div>
          </div>
        </div>

        {/* The week filling up. */}
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-navy-secondary/70">
          <div
            className="h-full rounded-full bg-gold transition-all duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-2xs text-silver/70">
          <span className="tabular-nums">
            {t('earn.hours', {
              worked: data.workedHours.toFixed(2),
              remaining: data.remainingHours.toFixed(2),
            })}
          </span>
          <Link to="/marketplace" className="text-gold hover:text-gold-bright">
            {t('earn.pickup')}
          </Link>
        </div>
        <p className="mt-1.5 text-2xs text-silver/50">{t('earn.disclaimer')}</p>
      </CardContent>
    </Card>
  );
}
