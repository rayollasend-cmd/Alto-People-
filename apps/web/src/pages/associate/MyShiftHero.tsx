import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Clock, MapPin, Timer, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { ActiveTimeEntryResponse, Shift } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { hapticConfirm } from '@/lib/haptics';
import { fmtMoney, fmtMoneyEst, fmtRelativeDayTz, fmtShiftRangeTz, fmtTime, fmtTimeTz, fmtWeekday, mapsUrl, parseYmd, zonedDayKey } from '@/lib/format';
import { acknowledgeMyShift, getMyShiftDetail } from '@/lib/schedulingApi';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { paidShiftMinutes } from '@/pages/scheduling/ShiftCard';
import { useMyEarnings, useTickSeconds } from '@/components/EarningsCard';

/**
 * The associate's shift, the way the supervisor's floor reads: ONE hero that
 * answers "where am I with work right now", in the tone of the moment —
 *
 *   on the clock   green   since when, how long, when the shift ends
 *   late           amber   the shift started and there's no punch — go to
 *                          the tablet (it used to say "Next shift: Today"
 *                          and, separately, "Off the clock", and let the
 *                          associate work out they were late)
 *   upcoming       gold    when (day + hours), a countdown, where, who's
 *                          running the shift and who's on with them, and
 *                          the two things to do: confirm, directions
 *   nothing        quiet   nothing scheduled — and the open shifts to grab
 *
 * Associates punch at the store tablet only; nothing here clocks anyone in.
 */

const photoUrl = (associateId: string | null) => (associateId ? `/api/associates/${associateId}/photo` : undefined);
const MIN = 60_000;

// Same definition of "next" as the schedule page (endsAt >= now): a shift in
// progress IS the next shift until it ends.
export function pickNextShift(shifts: Shift[], now = Date.now()): Shift | null {
  return (
    shifts
      .filter((s) => new Date(s.endsAt).getTime() >= now && s.status !== 'CANCELLED')
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0] ?? null
  );
}

function fmtSpan(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Re-render every 30s so countdowns and "on the clock" durations move. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function MyShiftHero({
  active,
  shifts,
  openShiftCount,
  footer,
  estRate = null,
  onAcknowledged,
  showScheduleLink = true,
}: {
  active: ActiveTimeEntryResponse | null | undefined;
  shifts: Shift[] | null | undefined;
  /** Open shifts they can pick up — the "nothing scheduled" state's way out. */
  openShiftCount: number | null;
  /** Under the hero when they're not on the clock (their kiosk number). */
  footer?: (state: 'late' | 'upcoming' | 'none') => React.ReactNode;
  /** Their hourly rate, for "worth ~$105" on an upcoming shift. */
  estRate?: number | null;
  /** A page holding its own copy of the shifts (My schedule) hears the confirm. */
  onAcknowledged?: (shiftId: string, acknowledgedAt: string) => void;
  /** Off on the schedule page itself. */
  showScheduleLink?: boolean;
}) {
  const { t } = useI18n();
  const now = useNow();
  const queryClient = useQueryClient();
  const [acking, setAcking] = useState(false);
  const next = shifts ? pickNextShift(shifts, now) : null;
  const detail = useQuery({
    queryKey: ['me', 'shiftDetail', next?.id],
    queryFn: () => getMyShiftDetail(next!.id),
    enabled: !!next,
    staleTime: 5 * 60_000,
  });

  if (active === undefined || shifts === undefined) {
    return (
      <Card className="mb-4">
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </CardContent>
      </Card>
    );
  }

  const entry = active?.active ?? null;
  const startMs = next ? new Date(next.startsAt).getTime() : 0;
  const started = !!next && startMs <= now;
  const state: 'on' | 'late' | 'upcoming' | 'none' = entry
    ? 'on'
    : next && started
      ? 'late'
      : next
        ? 'upcoming'
        : 'none';

  const needsConfirm = !!next && next.status === 'ASSIGNED' && !next.acknowledgedAt && !started;
  const confirmed = !!next && next.status === 'ASSIGNED' && !!next.acknowledgedAt && !started;
  const place = next ? [next.locationName, next.location].filter(Boolean).join(' · ') : '';
  const supervisors = detail.data?.supervisors ?? [];
  const teammates = detail.data?.teammates ?? [];

  const acknowledge = async () => {
    if (!next || acking) return;
    setAcking(true);
    try {
      const updated = await acknowledgeMyShift(next.id);
      hapticConfirm();
      toast.success(t('shift.confirmedToast'));
      onAcknowledged?.(next.id, updated?.acknowledgedAt ?? new Date().toISOString());
      await queryClient.invalidateQueries({ queryKey: ['me', 'shifts'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('shift.confirmFailed'));
    } finally {
      setAcking(false);
    }
  };

  const tone =
    state === 'on' ? 'success' : state === 'late' ? 'warning' : state === 'upcoming' ? 'gold' : 'quiet';

  return (
    <section
      aria-label={t('hero.label')}
      className={cn(
        'relative mb-4 overflow-hidden rounded-lg border animate-enter',
        tone === 'success' && 'border-success/40 bg-navy bg-gradient-to-br from-success/[0.12] via-transparent to-transparent',
        tone === 'warning' && 'border-warning/50 bg-navy bg-gradient-to-br from-warning/[0.14] via-transparent to-transparent',
        tone === 'gold' && 'border-gold/30 bg-navy bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent',
        tone === 'quiet' && 'border-navy-secondary bg-navy',
      )}
    >
      {tone !== 'quiet' && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0',
            tone === 'success' && 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-success)/0.14),transparent_55%)]',
            tone === 'warning' && 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-warning)/0.16),transparent_55%)]',
            tone === 'gold' && 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]',
          )}
        />
      )}
      <div className="relative p-5">
        {/* Eyebrow: what this card is about right now. */}
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider',
              tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-gold',
            )}
          >
            {state === 'late' ? (
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            ) : state === 'on' ? (
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Timer className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {state === 'on' ? t('dash.onClock') : state === 'late' ? t('hero.late') : t('dash.nextShift')}
          </span>
          {state === 'on' && (
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
          )}
          {state === 'upcoming' && startMs - now < 24 * 60 * MIN && (
            <span className="text-xs tabular-nums text-silver/80">
              {t('sched.startsIn', { time: fmtSpan(Math.max(1, Math.round((startMs - now) / MIN))) })}
            </span>
          )}
        </div>

        {/* The headline. */}
        {state === 'on' && entry ? (
          <>
            <div className="mt-2 text-3xl font-bold leading-tight tracking-tight text-white tabular-nums sm:text-4xl">
              {fmtSpan(Math.max(0, Math.floor((now - new Date(entry.clockInAt).getTime()) / MIN)))}
            </div>
            <LiveShiftEarnings />
            <p className="mt-1 text-sm text-silver">
              {t('hero.started', { time: fmtTime(entry.clockInAt) })}
              {next && started && (
                <> · {t('hero.endsAt', { time: fmtTimeTz(next.endsAt, next.timezone) })}</>
              )}
            </p>
          </>
        ) : state === 'late' && next ? (
          <>
            <div className="mt-2 text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl">
              {t('hero.startedAgo', { time: fmtSpan(Math.max(1, Math.round((now - startMs) / MIN))) })}
            </div>
            <p className="mt-1 text-sm text-silver">{t('hero.lateBody')}</p>
            <p className="mt-2 text-xs text-silver/80 tabular-nums">
              {fmtShiftRangeTz(next.startsAt, next.endsAt, next.timezone)}
              {` · ${next.position}`}
            </p>
          </>
        ) : state === 'upcoming' && next ? (
          <>
            <div className="mt-2 text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl">
              {fmtRelativeDayTz(next.startsAt, next.timezone, now)}
              <span className="text-silver/50"> · </span>
              <span className="tabular-nums">{fmtShiftRangeTz(next.startsAt, next.endsAt, next.timezone)}</span>
            </div>
            <p className="mt-1.5 text-sm text-silver">
              {next.position}
              {next.clientName ? ` · ${next.clientName}` : ''}
              {estRate != null && paidShiftMinutes(next) > 0 && (
                <span className="font-semibold text-gold">
                  {' '}· {t('sched.heroWorth', { amount: fmtMoneyEst((paidShiftMinutes(next) / 60) * estRate) })}
                </span>
              )}
            </p>
          </>
        ) : (
          <>
            <div className="mt-2 text-2xl font-semibold text-white">{t('dash.nothingScheduled')}</div>
            <p className="mt-1 text-sm text-silver">
              {openShiftCount && openShiftCount > 0
                ? t(openShiftCount === 1 ? 'hero.openOne' : 'hero.openMany', { count: openShiftCount })
                : t('dash.managerWillPublish')}
            </p>
          </>
        )}

        {/* Where, and who — the store, its shift supervisor, the crew. */}
        {next && state !== 'none' && (place || supervisors.length > 0 || teammates.length > 0) && (
          <div className="mt-4 space-y-2.5 border-t border-navy-secondary/60 pt-3">
            {place && (
              <div className="flex items-center gap-2 text-sm text-silver">
                <MapPin className="h-4 w-4 shrink-0 text-silver/70" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{place}</span>
                <a
                  href={mapsUrl([next.clientName, next.locationName, next.location].filter(Boolean).join(' '))}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-sm text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-9 inline-flex items-center"
                >
                  {t('shift.directions')}
                </a>
              </div>
            )}
            {supervisors.length > 0 && (
              <div className="flex items-center gap-2.5">
                <Avatar src={photoUrl(supervisors[0]!.associateId)} name={supervisors[0]!.name} email="" size="sm" />
                <div className="min-w-0 text-sm">
                  <span className="text-silver/70">{t('hero.supervisor')} · </span>
                  <span className="text-white">{supervisors.map((s) => s.name).join(', ')}</span>
                </div>
              </div>
            )}
            {teammates.length > 0 && (
              <div className="flex items-center gap-2.5">
                <div className="flex -space-x-2" aria-hidden="true">
                  {teammates.slice(0, 5).map((m) => (
                    <Avatar key={m.associateId} src={photoUrl(m.associateId)} name={m.name} email="" size="sm" ringed />
                  ))}
                </div>
                <span className="flex items-center gap-1 text-xs text-silver">
                  <Users className="h-3.5 w-3.5 text-silver/70" aria-hidden="true" />
                  {t(teammates.length === 1 ? 'hero.withYouOne' : 'hero.withYouMany', { count: teammates.length })}
                </span>
              </div>
            )}
          </div>
        )}

        {/* What to do. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          {needsConfirm && (
            <Button size="sm" onClick={() => void acknowledge()} loading={acking} disabled={acking}>
              <Check className="h-3.5 w-3.5" />
              {t('shift.illBeThere')}
            </Button>
          )}
          {confirmed && (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t('shift.youConfirmed')}
            </span>
          )}
          {state === 'none' && openShiftCount !== null && openShiftCount > 0 ? (
            <Button size="sm" asChild>
              <Link to="/marketplace">{t('hero.pickUp')}</Link>
            </Button>
          ) : (
            showScheduleLink && (
              <Link
                to="/scheduling"
                className="inline-flex items-center text-sm text-gold hover:text-gold-bright coarse:min-h-11"
              >
                {t('dash.seeFullSchedule')} →
              </Link>
            )
          )}
        </div>
        {state !== 'on' && footer?.(state)}
      </div>
    </section>
  );
}

/**
 * The next seven days, one cell each — what the supervisor's "Next 7 days"
 * is to the store, for one person: which days they work, when they start,
 * and which still need a confirm.
 */
export function MyWeekStrip({ shifts }: { shifts: Shift[] | null | undefined }) {
  const { t } = useI18n();
  if (!shifts) return null;
  const now = Date.now();
  const tz = shifts.find((s) => s.timezone)?.timezone ?? null;
  const todayKey = zonedDayKey(new Date(now), tz);
  const days = Array.from({ length: 7 }, (_, i) => {
    const base = parseYmd(todayKey)!;
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const onDay = shifts
      .filter((s) => s.status !== 'CANCELLED' && zonedDayKey(s.startsAt, s.timezone) === key)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return { key, date: d, shifts: onDay };
  });
  const working = days.filter((d) => d.shifts.length > 0).length;

  return (
    <Card className="mb-4 animate-enter">
      <CardContent className="p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium text-white">{t('week.title')}</h2>
          <span className="text-xs text-silver/70">
            {t(working === 1 ? 'week.daysOne' : 'week.daysMany', { count: working })}
          </span>
        </div>
        <Link to="/scheduling" className="mt-3 grid grid-cols-7 gap-1.5" aria-label={t('dash.seeFullSchedule')}>
          {days.map((d, i) => {
            const first = d.shifts[0];
            const unconfirmed = d.shifts.some(
              (s) => s.status === 'ASSIGNED' && !s.acknowledgedAt && new Date(s.startsAt).getTime() > now,
            );
            return (
              <div
                key={d.key}
                className={cn(
                  'flex flex-col items-center rounded-md border px-0.5 py-2 text-center',
                  i === 0 ? 'border-gold/50 bg-gold/[0.08]' : 'border-navy-secondary bg-navy-secondary/20',
                  first && i !== 0 && 'border-gold/25',
                )}
              >
                <span className={cn('text-2xs uppercase', i === 0 ? 'text-gold' : 'text-silver/70')}>
                  {fmtWeekday(d.date, 'narrow')}
                </span>
                <span className="text-sm font-semibold tabular-nums text-white">{d.date.getDate()}</span>
                <span
                  className={cn(
                    'mt-1 text-2xs leading-tight tabular-nums',
                    first ? 'text-gold' : 'text-silver/50',
                  )}
                >
                  {first
                    ? fmtTimeTz(first.startsAt, first.timezone).replace(':00', '').replace(/\s?([AP])M/i, (_m, p: string) => p.toLowerCase())
                    : t('week.off')}
                </span>
                <span
                  aria-hidden="true"
                  className={cn('mt-1 h-1.5 w-1.5 rounded-full', unconfirmed ? 'bg-warning' : 'bg-transparent')}
                />
              </div>
            );
          })}
        </Link>
        {days.some((d) =>
          d.shifts.some((s) => s.status === 'ASSIGNED' && !s.acknowledgedAt && new Date(s.startsAt).getTime() > now),
        ) && (
          <p className="mt-2 flex items-center gap-1.5 text-2xs text-silver/70">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
            {t('week.needsConfirm')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * On the clock: what this shift has earned so far, ticking every second at
 * the current rate (1.5× once the week is past 40h) — the money at the top
 * while they work. Same numbers as the weekly earnings card below.
 */
function LiveShiftEarnings() {
  const { t } = useI18n();
  const q = useMyEarnings();
  const d = q.data;
  const onClock = !!d?.onClock && d.currentShiftEarned != null;
  const tick = useTickSeconds(onClock, q.dataUpdatedAt);
  if (!d || !onClock) return null;
  const earned = (d.currentShiftEarned ?? 0) + (d.currentRatePerHour / 3600) * tick;
  return (
    <p className="mt-1 text-lg font-semibold tabular-nums text-gold" aria-live="off">
      {t('hero.earnedShift', { amount: fmtMoney(earned) })}
    </p>
  );
}
