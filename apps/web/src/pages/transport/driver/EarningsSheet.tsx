import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Clock, TrendingUp, Wallet } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { fmtDayHeaderTz, fmtHours, fmtMoney, fmtRelativeDayTz, fmtTimeTz, fmtWeekdayTz, parseYmd } from '@/lib/format';
import { getDriverTime } from '@/lib/transportApi';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { SparseReading, StackedBarChart, TREND_MIN_POINTS } from '@/components/ui/charts';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import { livePay, useDriverPay, type DriverPay } from './driverPay';
import { useTick } from './driveKit';
import '@/lib/i18n/en/drive';

/**
 * The driver's pay — Uber's earnings screen, told honestly: drivers are
 * paid by the hour on the clock, not per ride, so it says so, and shows
 * this shift ticking, the week so far and where it's headed, hours worked
 * against hours behind the wheel, the rate, overtime as the engine counts
 * it (never a false "unlocked"), take-home when the answer has it, and
 * when the money lands. Exact cents here; the header pill rounds.
 */
export default function EarningsSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { pay, fetchedAt, day, loading } = useDriverPay();
  const now = useTick(1_000, !!pay?.onClock);
  const p = pay ? livePay(pay, fetchedAt, now) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="earnings-sheet">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-accent" aria-hidden="true" />
            {t('drive.payTitle')}
          </DialogTitle>
          <DialogDescription className="text-base">{t('drive.payHonest')}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <Skeleton className="h-64" />
        ) : !day?.associateId || !p ? (
          <p className="text-base text-ink-muted">{t('drive.noAssociate')}</p>
        ) : (
          <PayBody pay={p} shifts={day.shifts} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PayBody({ pay, shifts }: { pay: DriverPay; shifts: Array<{ id: string; startsAt: string; endsAt: string; today?: boolean }> }) {
  const { t } = useI18n();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const time = useQuery({ queryKey: ['transport', 'driver', 'time'], queryFn: getDriverTime, staleTime: 60_000 });
  const open = time.data?.entries.find((e) => !e.clockOutAt) ?? null;
  const noRate = pay.rate === null;
  const todayShifts = shifts.filter((s) => s.today);
  return (
    <div className="space-y-5 text-ink">
      {noRate && (
        <ErrorBanner severity="warning" className="text-base">
          {t('drive.noRate')}
        </ErrorBanner>
      )}

      {/* This shift, live — or that the clock is off. */}
      <div className="rounded-lg border border-line bg-surface-raised/40 p-4" data-testid="pay-shift">
        {pay.onClock ? (
          <>
            <p className="text-sm font-semibold uppercase tracking-[0.12em] text-positive-800">{t('drive.thisShift')}</p>
            {!noRate && <p className="mt-1 text-4xl font-bold tabular-nums tracking-tight">{fmtMoney(pay.shift ?? pay.today)}</p>}
            <p className="mt-1 text-base text-ink-muted">{open ? t('drive.onClockSince', { time: fmtTimeTz(open.clockInAt, tz) }) : t('drive.todayOnClock')}</p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold uppercase tracking-[0.12em] text-ink-muted">{t('drive.todayOffClock')}</p>
            <p className="mt-1 text-base text-ink">{t('drive.offClockNote')}</p>
          </>
        )}
      </div>

      {/* The week. */}
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.12em] text-ink-muted">{t('drive.thisWeekSoFar')}</p>
        {!noRate && (
          <p className="mt-1 text-4xl font-bold tabular-nums tracking-tight" data-testid="pay-week">
            {fmtMoney(pay.week)}
          </p>
        )}
        {!noRate && pay.projectedWeek > pay.week && (
          <p className="mt-1 flex items-center gap-1.5 text-base text-ink">
            <TrendingUp className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
            {t('drive.onPace', { amount: fmtMoney(pay.projectedWeek), day: fmtDayHeaderTz(parseYmd(pay.weekEnd)) })}
          </p>
        )}
        {!noRate && pay.takeHome && pay.takeHome.net > 0 && <p className="mt-1 text-base text-ink">{t('drive.takeHome', { amount: fmtMoney(pay.takeHome.net) })}</p>}
        {pay.payday && (
          <p className="mt-1 flex items-center gap-1.5 text-base text-ink" data-testid="pay-payday">
            <CalendarDays className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
            {t('drive.paidOn', { date: fmtDayHeaderTz(parseYmd(pay.payday)) })}
          </p>
        )}
      </div>

      {/* Hours, the rate, overtime. */}
      <dl className="grid grid-cols-2 gap-3">
        <Fact label={t('drive.workedToday')} value={fmtHours(round2(pay.workedToday))} />
        <Fact label={t('drive.drivenToday')} value={fmtHours(round2(pay.drivenToday))} />
        <Fact label={t('drive.workedWeek')} value={fmtHours(round2(pay.workedWeek))} />
        <Fact label={t('drive.rate')} value={pay.rate === null ? '—' : fmtMoney(pay.rate)} />
      </dl>
      {!noRate && pay.rateIsDefault && <p className="text-base text-ink-muted">{t('drive.rateDefault')}</p>}
      <Overtime pay={pay} />

      {pay.days && !noRate && <WeekBars pay={pay} />}

      {/* Your time: today's driver shift and the latest punches. */}
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.12em] text-ink-muted">{t('drive.yourTime')}</p>
        <p className="mt-1 flex items-center gap-2 text-base text-ink" data-testid="today-shift">
          <Clock className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
          {todayShifts.length === 0 ? t('drive.noShiftToday') : todayShifts.map((sh) => `${fmtTimeTz(sh.startsAt, tz)}–${fmtTimeTz(sh.endsAt, tz)}`).join(', ')}
        </p>
        {(time.data?.entries.length ?? 0) > 0 && (
          <ul className="mt-1 divide-y divide-line-subtle">
            {time.data!.entries.slice(0, 5).map((e) => (
              <li key={e.id} className="flex min-h-11 items-center justify-between gap-2 text-base">
                <span className="tabular-nums text-ink">
                  {fmtRelativeDayTz(e.clockInAt, tz)} · {fmtTimeTz(e.clockInAt, tz)}
                  {e.clockOutAt ? `–${fmtTimeTz(e.clockOutAt, tz)}` : ''}
                </span>
                <span className="tabular-nums text-ink-muted">{e.hours !== null ? fmtHours(e.hours) : t('drive.todayOnClock')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-sm text-ink-muted">{t('drive.payEstimate')}</p>
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line-subtle px-3 py-2.5">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}

/** Overtime as the engine counts it — said only when the answer carries it. */
function Overtime({ pay }: { pay: DriverPay }) {
  const { t } = useI18n();
  const ot = pay.overtime;
  if (!ot || pay.rate === null) return null;
  const text = ot.unlocked
    ? t('drive.otUnlocked', { rate: fmtMoney(pay.currentRate), threshold: ot.thresholdHours })
    : ot.projectedOtHours > 0
      ? t('drive.otPace', { hours: fmtHours(round2(ot.projectedOtHours)), threshold: ot.thresholdHours })
      : t('drive.otNotYet', { threshold: ot.thresholdHours, hours: fmtHours(round2(pay.workedWeek)) });
  return (
    <p className="text-base text-ink" data-testid="pay-overtime">
      {text}
    </p>
  );
}

/** The week by day (Sat→Fri, worked $) — a number and a sentence until there are enough days to chart. */
function WeekBars({ pay }: { pay: DriverPay }) {
  const { t } = useI18n();
  const days = pay.days ?? [];
  const rows = days.map((d) => ({ day: fmtWeekdayTz(parseYmd(d.date)), date: d.date, worked: Math.round(d.workedAmount * 100) / 100 }));
  const worked = rows.filter((r) => r.worked > 0);
  const sparse = worked.length < TREND_MIN_POINTS;
  const todayRow = rows.find((r) => r.date === pay.date) ?? null;
  return (
    <ChartFrame
      title={t('drive.weekChart')}
      summary={t('drive.weekChartSummary', { days: worked.length, amount: fmtMoney(pay.week) })}
      columns={[
        { key: 'day', label: t('drive.weekChartDay') },
        { key: 'worked', label: t('drive.weekChartWorked'), numeric: true, format: (v) => fmtMoney(Number(v)) },
      ]}
      rows={rows}
      csvName="driver-pay-by-day"
      height={sparse ? 120 : 200}
      empty={<p className="text-base text-ink-muted">{t('drive.weekChartEmpty')}</p>}
    >
      {sparse ? (
        <SparseReading figures={worked.map((r) => ({ label: r.day, value: fmtMoney(r.worked) }))} note={t('drive.weekChartSparse', { count: worked.length, min: TREND_MIN_POINTS })} />
      ) : (
        <StackedBarChart data={rows} x="day" series={[{ key: 'worked', name: t('drive.weekChartWorked') }]} format={(v) => fmtMoney(v)} highlight={todayRow?.day} />
      )}
    </ChartFrame>
  );
}
