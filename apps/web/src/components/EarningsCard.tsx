import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Flame, ReceiptText, TrendingUp, Zap } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { displayLocale, fmtMoney } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/Card';
import { CountUpValue } from '@/components/ui/MetricCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * "My earnings this week" — the schedule as money, live. Earned so far
 * counts up on mount and TICKS every second while the associate is on
 * the clock (server truth refreshes each minute); seven day-bars show
 * the shape of the week; overtime past 40h shows at its real 1.5×; last
 * week is the pace to beat; eligible open shifts carry a dollar figure.
 * Estimates only (gross, at the associate's rate) — the disclaimer says
 * so. Vanishes quietly when the login has no associate record or the
 * fetch fails: motivation is a bonus, never an error state.
 */

interface EarningsDay {
  date: string;
  workedMinutes: number;
  workedAmount: number;
  scheduledMinutes: number;
  scheduledAmount: number;
}

interface Earnings {
  weekStart: string;
  weekEnd: string;
  hourlyRate: number;
  earnedSoFar: number;
  workedHours: number;
  projectedWeek: number;
  remainingHours: number;
  onClock: boolean;
  currentRatePerHour: number;
  overtime: {
    thresholdHours: number;
    multiplier: number;
    unlocked: boolean;
    otHoursSoFar: number;
    projectedOtHours: number;
  };
  lastWeekEarned: number;
  days: EarningsDay[];
  openShifts: { count: number; estAmount: number };
  todayShift: {
    startsAt: string;
    endsAt: string;
    estAmount: number;
    inProgress: boolean;
  } | null;
}

const REFRESH_MS = 60_000;

export function EarningsCard() {
  const { t } = useI18n();
  const [data, setData] = useState<Earnings | null>(null);
  const [failed, setFailed] = useState(false);
  // Seconds elapsed since the last server truth — drives the live ticker.
  const [tickSeconds, setTickSeconds] = useState(0);
  const fetchedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      apiFetch<Earnings>('/time/me/earnings')
        .then((d) => {
          if (cancelled) return;
          fetchedAt.current = Date.now();
          setTickSeconds(0);
          setData(d);
        })
        .catch(() => {
          if (cancelled) return;
          setFailed((f) => f || fetchedAt.current === 0);
        });
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // The Uber moment: while clocked in, the number moves every second.
  const onClock = data?.onClock ?? false;
  useEffect(() => {
    if (!onClock) return;
    const id = setInterval(() => {
      setTickSeconds(Math.floor((Date.now() - fetchedAt.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [onClock]);

  const dayInitials = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(displayLocale(), { weekday: 'narrow' });
    return (iso: string) => fmt.format(new Date(`${iso}T12:00:00Z`));
  }, []);

  if (failed && data === null) return null;
  if (data === null) return <Skeleton className="h-36" />;
  // Nothing scheduled and nothing worked: stay quiet rather than show $0.
  if (data.projectedWeek <= 0 && data.earnedSoFar <= 0) return null;

  const liveEarned =
    data.earnedSoFar + (onClock ? (data.currentRatePerHour / 3600) * tickSeconds : 0);
  // The projection already contains the in-progress shift; it only moves
  // if live earnings somehow outrun it (working past the scheduled end).
  const liveProjected = Math.max(data.projectedWeek, liveEarned);
  const pct =
    data.projectedWeek > 0
      ? Math.min(100, Math.round((liveEarned / data.projectedWeek) * 100))
      : 0;

  const maxDay = Math.max(
    1,
    ...data.days.map((d) => d.workedAmount + d.scheduledAmount),
  );
  const todayIso = new Date().toISOString().slice(0, 10);
  const behindBy = data.lastWeekEarned - data.projectedWeek;

  return (
    <Card className="border-gold/25 bg-gradient-to-br from-gold/[0.07] to-transparent">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
            <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
            {t('earn.title')}
          </span>
          {onClock ? (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              {t('earn.live', { rate: fmtMoney(data.currentRatePerHour) })}
            </span>
          ) : (
            data.todayShift &&
            data.todayShift.estAmount > 0 && (
              <span className="text-xs text-white">
                {t(data.todayShift.inProgress ? 'earn.finishToday' : 'earn.readyToday', {
                  amount: fmtMoney(data.todayShift.estAmount),
                })}
              </span>
            )
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div>
            <div className="text-3xl font-semibold tabular-nums text-white">
              {onClock ? (
                // Live: no mount animation fighting the ticker — the
                // number itself is the animation.
                <span>{fmtMoney(liveEarned)}</span>
              ) : (
                <CountUpValue value={fmtMoney(data.earnedSoFar)} />
              )}
            </div>
            <div className="text-2xs text-silver/70">{t('earn.soFar')}</div>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold tabular-nums text-gold">
              {fmtMoney(liveProjected)}
            </div>
            <div className="text-2xs text-silver/70">{t('earn.projected')}</div>
          </div>
        </div>

        {/* Overtime, at its real value. */}
        {data.overtime.unlocked ? (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">
            <Zap className="h-3.5 w-3.5" aria-hidden="true" />
            {t('earn.otUnlocked', { rate: fmtMoney(data.currentRatePerHour) })}
          </div>
        ) : (
          data.overtime.projectedOtHours > 0 && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-gold/15 px-2.5 py-1 text-xs font-medium text-gold">
              <Zap className="h-3.5 w-3.5" aria-hidden="true" />
              {t('earn.otPace', { hours: data.overtime.projectedOtHours.toFixed(1) })}
            </div>
          )
        )}

        {/* The shape of the week — worked solid, scheduled ghosted. */}
        <div
          className="mt-3 flex items-end gap-1.5"
          role="img"
          aria-label={t('earn.weekBarsLabel')}
        >
          {data.days.map((d) => {
            const total = d.workedAmount + d.scheduledAmount;
            const isToday = d.date === todayIso;
            return (
              <div
                key={d.date}
                className="flex flex-1 flex-col items-center gap-1"
                title={`${d.date} · ${fmtMoney(d.workedAmount)}${
                  d.scheduledAmount > 0 ? ` + ${fmtMoney(d.scheduledAmount)}` : ''
                }`}
              >
                <div className="flex h-12 w-full flex-col justify-end overflow-hidden rounded-sm bg-navy-secondary/50">
                  {d.scheduledAmount > 0 && (
                    <div
                      className="w-full bg-gold/25"
                      style={{ height: `${(d.scheduledAmount / maxDay) * 100}%` }}
                    />
                  )}
                  {d.workedAmount > 0 && (
                    <div
                      className="w-full bg-gold"
                      style={{ height: `${(d.workedAmount / maxDay) * 100}%` }}
                    />
                  )}
                </div>
                <span
                  className={cn(
                    'text-2xs leading-none',
                    isToday ? 'font-bold text-gold' : 'text-silver/60',
                  )}
                >
                  {dayInitials(d.date)}
                </span>
                <span
                  className={cn(
                    'text-2xs leading-none tabular-nums',
                    total > 0 ? 'text-silver/80' : 'text-silver/40',
                  )}
                >
                  {total > 0 ? fmtMoney(Math.round(total)).replace(/\.00$/, '') : '·'}
                </span>
              </div>
            );
          })}
        </div>

        {/* The week filling up. */}
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-navy-secondary/70">
          <div
            className="h-full rounded-full bg-gold transition-all duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-2xs text-silver/70">
          <span className="tabular-nums">
            {t('earn.rateLine', {
              worked: data.workedHours.toFixed(2),
              remaining: data.remainingHours.toFixed(2),
              rate: fmtMoney(data.hourlyRate),
            })}
          </span>
          {data.lastWeekEarned > 0 && (
            <span className="tabular-nums">
              {t('earn.lastWeek', { amount: fmtMoney(data.lastWeekEarned) })}{' '}
              {behindBy <= 0 ? (
                <span className="text-success">
                  {t('earn.beatPace')}
                  <Flame className="ml-0.5 inline h-3 w-3" aria-hidden="true" />
                </span>
              ) : (
                <span className="text-gold">
                  {t('earn.behindPace', { amount: fmtMoney(behindBy) })}
                </span>
              )}
            </span>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-2xs">
          {data.openShifts.count > 0 && data.openShifts.estAmount > 0 ? (
            <Link to="/marketplace" className="font-medium text-gold hover:text-gold-bright">
              {t('earn.openShifts', {
                count: String(data.openShifts.count),
                amount: fmtMoney(data.openShifts.estAmount),
              })}
            </Link>
          ) : (
            <Link to="/marketplace" className="text-gold hover:text-gold-bright">
              {t('earn.pickup')}
            </Link>
          )}
          <Link
            to="/payroll"
            className="inline-flex items-center gap-1 text-silver/70 hover:text-white"
          >
            <ReceiptText className="h-3 w-3" aria-hidden="true" />
            {t('earn.paystubs')}
          </Link>
        </div>
        <p className="mt-1.5 text-2xs text-silver/50">{t('earn.disclaimer')}</p>
      </CardContent>
    </Card>
  );
}
