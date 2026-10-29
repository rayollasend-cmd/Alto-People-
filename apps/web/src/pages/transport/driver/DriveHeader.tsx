import { lazy, Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, LogIn, LogOut, Wallet } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { hapticConfirm } from '@/lib/haptics';
import { fmtMoneyWhole } from '@/lib/format';
import { driverClockIn, driverClockOut, getDriverTime } from '@/lib/transportApi';
import { Button } from '@/components/ui/Button';
import { fmtIn } from '../rideShifts';
import { livePay, useDriverPay, type DriverPay } from './driverPay';
import { useTick } from './driveKit';
import type { DayCounts } from './driveModel';
import '@/lib/i18n/en/drive';

/** Opened from the pill — its own chunk (the week's chart rides with it). */
const EarningsSheet = lazy(() => import('./EarningsSheet'));

/**
 * The line under the greeting in drive mode — the driver's day at a
 * glance, never competing with the run's one gold button:
 *
 *   [Today $86 · Week $412 ›]  [On the clock · 2h 10m  Clock out]
 *   Today: 2 of 4 runs done · 15 riders
 *
 * The pill ticks while the driver is on the clock and opens their pay;
 * the clock is the driver shift's time clock, compact.
 */
export function DriveHeader({ counts }: { counts: DayCounts | null }) {
  const { t } = useI18n();
  const { pay, fetchedAt, day } = useDriverPay();
  const [payOpen, setPayOpen] = useState(false);
  const linked = !!day?.associateId;
  return (
    <div className="w-full space-y-2" data-testid="drive-header">
      {day?.hours && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {linked && <PayPill pay={pay} fetchedAt={fetchedAt} onOpen={() => setPayOpen(true)} />}
          {linked && <ClockChip onClock={day.hours.onClock} />}
          {!linked && <p className="text-sm text-ink-muted">{t('drive.noAssociate')}</p>}
        </div>
      )}
      {counts && <DayLine counts={counts} />}
      {payOpen && (
        <Suspense fallback={null}>
          <EarningsSheet onClose={() => setPayOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

/** "Today: 2 of 4 runs done · 15 riders" — the day's one count, from the same runs the page shows. */
export function DayLine({ counts }: { counts: DayCounts }) {
  const { t } = useI18n();
  // No runs today: the empty state below says so — once.
  if (counts.total === 0) return null;
  return (
    <p className="text-base tabular-nums text-ink-muted" data-testid="day-line">
      {t('drive.dayRuns', { done: counts.done, total: counts.total })}
      {' · '}
      {counts.riders === 1 ? t('drive.ridersOne') : t('drive.ridersCount', { count: counts.riders })}
    </p>
  );
}

/** "Today $86 · Week $412" — whole dollars here (the sheet has the cents), live on the clock. */
export function PayPill({ pay, fetchedAt, onOpen }: { pay: DriverPay | null; fetchedAt: number; onOpen: () => void }) {
  const { t } = useI18n();
  const now = useTick(1_000, !!pay?.onClock);
  const p = pay ? livePay(pay, fetchedAt, now) : null;
  const label = !p || p.rate === null ? t('drive.payPillNoRate') : t('drive.payPill', { today: fmtMoneyWhole(p.today), week: fmtMoneyWhole(p.week) });
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      title={t('drive.payOpen')}
      data-testid="pay-pill"
      className="inline-flex h-11 min-w-0 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm font-semibold tabular-nums text-ink transition-colors hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright min-[400px]:text-base"
    >
      {p?.onClock ? (
        // On the clock: the money is moving — a live dot instead of the wallet.
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive-700 opacity-60 motion-reduce:hidden" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-positive-700" />
        </span>
      ) : (
        <Wallet className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      )}
      <span className="truncate">{label}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
    </button>
  );
}

/** The driver shift's time clock — a quiet control beside the pay, not a gold call to action. */
export function ClockChip({ onClock }: { onClock: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const time = useQuery({ queryKey: ['transport', 'driver', 'time'], queryFn: getDriverTime, enabled: onClock, staleTime: 60_000 });
  const open = time.data?.entries.find((e) => !e.clockOutAt) ?? null;
  const now = useTick(60_000, onClock);
  const clock = async () => {
    setBusy(true);
    try {
      if (onClock) {
        await driverClockOut();
        toast.success(t('drive.clockedOut'));
      } else {
        await driverClockIn();
        toast.success(t('drive.clockedIn'));
      }
      hapticConfirm();
      await queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  // The time on the clock rides in the button's name and tooltip; the pay sheet says it in full.
  const since = onClock && open ? t('drive.onClockFor', { time: fmtIn(now - Date.parse(open.clockInAt)) }) : onClock ? t('drive.todayOnClock') : t('drive.todayOffClock');
  return (
    <Button
      size="sm"
      variant="secondary"
      className="shrink-0 coarse:text-sm"
      data-testid="clock-chip"
      title={since}
      aria-label={`${onClock ? t('drive.clockOut') : t('drive.clockIn')} — ${since}`}
      onClick={() => void clock()}
      loading={busy}
      disabled={busy}
    >
      {onClock ? <LogOut className="h-3.5 w-3.5" /> : <LogIn className="h-3.5 w-3.5" />}
      {onClock ? t('drive.clockOut') : t('drive.clockIn')}
    </Button>
  );
}
