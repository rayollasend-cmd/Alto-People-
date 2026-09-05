import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Flame, ReceiptText, TrendingUp, Zap } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { displayLocale, fmtMoney } from '@/lib/format';
import { enterStagger } from '@/lib/motion';
import { Card, CardContent } from '@/components/ui/Card';
import { CountUpValue } from '@/components/ui/MetricCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * "My earnings this week" — a SCOREBOARD, not a dashboard. Three zones:
 *   1. The score: one hero number in the brand display face, ticking live
 *      while on the clock, with a single human pace sentence under it.
 *   2. The week: seven quiet day bars (solid = worked, ghost = scheduled),
 *      today glowing. No labels racing the bars — amounts live in the
 *      tooltips and behind Details.
 *   3. One footer line + a Details unfold holding everything that used to
 *      shout from the card face (schedule hours, last week, paychecks
 *      link, the tax disclaimer).
 * Estimates only (gross, at the associate's rate) — Details says so.
 * Vanishes quietly when the login has no associate record or the fetch
 * fails: motivation is a bonus, never an error state.
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

/** "$1,234.56" → dollars + cents, so the hero can set the cents smaller —
 *  the fintech treatment that makes a money number feel engineered. Falls
 *  back to the whole string if the locale ever drops the decimal point. */
function splitMoney(v: number): { main: string; cents: string } {
  const s = fmtMoney(v);
  const i = s.lastIndexOf('.');
  return i === -1 ? { main: s, cents: '' } : { main: s.slice(0, i), cents: s.slice(i) };
}

export function EarningsCard() {
  const { t } = useI18n();
  const [data, setData] = useState<Earnings | null>(null);
  const [failed, setFailed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
  if (data === null) return <Skeleton className="h-56" />;
  // Nothing scheduled and nothing worked: stay quiet rather than show $0.
  if (data.projectedWeek <= 0 && data.earnedSoFar <= 0) return null;

  const liveEarned =
    data.earnedSoFar + (onClock ? (data.currentRatePerHour / 3600) * tickSeconds : 0);
  const liveProjected = Math.max(data.projectedWeek, liveEarned);
  const earned = splitMoney(onClock ? liveEarned : data.earnedSoFar);

  const maxDay = Math.max(
    1,
    ...data.days.map((d) => d.workedAmount + d.scheduledAmount),
  );
  const todayIso = new Date().toISOString().slice(0, 10);
  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(data.weekEnd).getTime() - Date.now()) / 86_400_000),
  );

  // The one human sentence under the score. Pace + last-week verdict fold
  // into it — they used to be three separate rows of small print.
  const moreComing = liveProjected > liveEarned + 0.005;
  const beatsLast = data.lastWeekEarned > 0 && liveProjected >= data.lastWeekEarned;
  const shortBy = data.lastWeekEarned - liveProjected;

  return (
    <Card className="border-gold/25 bg-gradient-to-br from-gold/[0.07] to-transparent">
      <CardContent className="p-4">
        {/* ---- Zone 1: the score ---------------------------------------- */}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
            <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
            {t('earn.title')}
          </span>
          {onClock ? (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
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

        <div
          className="mt-2 font-display text-hero-lg text-white"
          aria-live="off"
          aria-label={fmtMoney(onClock ? liveEarned : data.earnedSoFar)}
        >
          {onClock ? (
            // Live: no mount animation fighting the ticker — the number
            // itself is the animation.
            <span>{earned.main}</span>
          ) : (
            <CountUpValue value={earned.main} />
          )}
          {earned.cents && (
            <span className="font-sans text-xl font-medium tabular-nums text-silver/70">
              {earned.cents}
            </span>
          )}
        </div>

        <p className="mt-1 text-sm text-silver">
          {moreComing ? (
            <>
              {t('earn.paceTo', { amount: fmtMoney(liveProjected) })}
              {daysLeft > 0 && (
                <span className="text-silver/60">
                  {' '}· {daysLeft === 1 ? t('earn.dayLeft') : t('earn.daysLeft', { n: String(daysLeft) })}
                </span>
              )}
              {data.lastWeekEarned > 0 &&
                (beatsLast ? (
                  <span className="text-success">
                    {' '}
                    {t('earn.beatsLast')}
                    <Flame className="ml-0.5 inline h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                ) : (
                  <span className="text-gold"> {t('earn.shortOfLast', { amount: fmtMoney(shortBy) })}</span>
                ))}
            </>
          ) : (
            t('earn.weekWrapped')
          )}
        </p>

        {/* Overtime UNLOCKED is the one chip allowed on the card face —
            it's live news (every hour pays 1.5× right now). The projected-OT
            forecast is NOT shown here: that money is already inside the
            "On pace for $X" sentence, and repeating it with a (paid 1.5×)
            parenthetical was exactly the figure-it-out noise the redesign
            removed. The forecast lives in Details for the curious. */}
        {data.overtime.unlocked && (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">
            <Zap className="h-3.5 w-3.5" aria-hidden="true" />
            {t('earn.otUnlocked', { rate: fmtMoney(data.currentRatePerHour) })}
          </div>
        )}

        {/* ---- Zone 2: the week ------------------------------------------ */}
        <div
          className="mt-4 flex items-end gap-1.5"
          role="img"
          aria-label={t('earn.weekBarsLabel')}
        >
          {data.days.map((d, idx) => {
            const total = d.workedAmount + d.scheduledAmount;
            const isToday = d.date === todayIso;
            // A 30-minute morning must still read as a sliver, never as an
            // empty day — floor each non-zero segment at 6%.
            const h = (amt: number) =>
              amt > 0 ? `${Math.max(6, (amt / maxDay) * 100)}%` : '0%';
            return (
              <div
                key={d.date}
                className="flex flex-1 flex-col items-center gap-1.5"
                title={`${d.date} · ${fmtMoney(d.workedAmount)}${
                  d.scheduledAmount > 0 ? ` + ${fmtMoney(d.scheduledAmount)}` : ''
                }`}
              >
                <div
                  className={cn(
                    'flex h-16 w-full flex-col justify-end overflow-hidden rounded-sm bg-navy-secondary/40',
                    isToday && 'ring-1 ring-gold/60',
                  )}
                >
                  {/* DOM order = top→bottom: scheduled (ghost) rides on top
                      of worked (solid), so the top segment owns the radius.
                      grow-y builds each day from the baseline on mount,
                      staggered left→right. */}
                  {d.scheduledAmount > 0 && (
                    <div
                      className="w-full rounded-t-sm bg-gold/25 origin-bottom animate-grow-y"
                      style={{ height: h(d.scheduledAmount), ...enterStagger(idx, 40, 6) }}
                    />
                  )}
                  {d.workedAmount > 0 && (
                    <div
                      className={cn(
                        'w-full bg-gold origin-bottom animate-grow-y',
                        d.scheduledAmount === 0 && 'rounded-t-sm',
                      )}
                      style={{ height: h(d.workedAmount), ...enterStagger(idx, 40, 6) }}
                    />
                  )}
                </div>
                <span
                  className={cn(
                    'text-2xs leading-none',
                    isToday ? 'font-bold text-gold' : total > 0 ? 'text-silver/70' : 'text-silver/40',
                  )}
                >
                  {dayInitials(d.date)}
                </span>
              </div>
            );
          })}
        </div>

        {/* ---- Zone 3: one quiet footer + Details ------------------------ */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-navy-secondary/50 pt-2.5 text-xs">
          <span className="tabular-nums text-silver/80">
            {t('earn.hoursRate', {
              worked: `${data.workedHours.toLocaleString(displayLocale(), { maximumFractionDigits: 2 })}h`,
              rate: fmtMoney(data.hourlyRate),
            })}
          </span>
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
        </div>

        <button
          type="button"
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
          className="mt-1.5 inline-flex items-center gap-1 coarse:min-h-11 text-2xs text-silver/60 hover:text-silver focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
        >
          {t('earn.details')}
          <ChevronDown
            className={cn('h-3 w-3 transition-transform', detailsOpen && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
        {detailsOpen && (
          <div className="grid animate-unfold">
            <div className="overflow-hidden">
              <div className="pt-1.5 space-y-1 text-2xs text-silver/70">
                <p className="tabular-nums">
                  {t('earn.rateLine', {
                    worked: data.workedHours.toFixed(2),
                    remaining: data.remainingHours.toFixed(2),
                    rate: fmtMoney(data.hourlyRate),
                  })}
                </p>
                {data.lastWeekEarned > 0 && (
                  <p className="tabular-nums">
                    {t('earn.lastWeekPlain', { amount: fmtMoney(data.lastWeekEarned) })}
                  </p>
                )}
                {!data.overtime.unlocked && data.overtime.projectedOtHours > 0 && (
                  <p className="tabular-nums">
                    {t('earn.otPace', { hours: data.overtime.projectedOtHours.toFixed(1) })}
                  </p>
                )}
                <p>
                  <Link
                    to="/payroll"
                    className="inline-flex items-center gap-1 text-silver/70 hover:text-white"
                  >
                    <ReceiptText className="h-3 w-3" aria-hidden="true" />
                    {t('earn.paystubs')}
                  </Link>
                </p>
                <p className="text-silver/50">{t('earn.disclaimer')}</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
