import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CalendarOff,
  Clock,
  DollarSign,
  FileText,
  MapPin,
  Timer,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  ActiveTimeEntryResponse,
  PayrollItem,
  Shift,
  TimeOffBalance,
} from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { getActiveTimeEntry } from '@/lib/timeApi';
import { listMyShifts } from '@/lib/schedulingApi';
import { fmtDate, fmtRelativeDayTz, fmtShiftRangeTz, fmtTime } from '@/lib/format';
import { listMyPayrollItems } from '@/lib/payrollApi';
import { getMyBalance } from '@/lib/timeOffApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  PullToRefreshIndicator,
  usePullToRefresh,
} from '@/lib/usePullToRefresh';
import { hapticConfirm } from '@/lib/haptics';
import { getPushStatus, subscribeToPush } from '@/lib/push';
import { Skeleton } from '@/components/ui/Skeleton';
import { OnboardingBanner } from '@/components/OnboardingBanner';
import { cn } from '@/lib/cn';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export function AssociateDashboard() {
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();

  const [active, setActive] = useState<ActiveTimeEntryResponse | null | undefined>(undefined);
  const [nextShift, setNextShift] = useState<Shift | null | undefined>(undefined);
  const [latestPaystub, setLatestPaystub] = useState<PayrollItem | null | undefined>(undefined);
  const [balances, setBalances] = useState<TimeOffBalance[] | null | undefined>(undefined);
  const [failed, setFailed] = useState({
    clock: false,
    shift: false,
    pay: false,
    timeOff: false,
  });

  const greetingName =
    user?.email ? user.email.split('@')[0].split('.')[0].replace(/^\w/, (c) => c.toUpperCase()) : 'there';

  const refreshAll = useCallback(async () => {
    // Each fetch is independent; one failing shouldn't blank out the others.
    // 403/404 are fully expected for accounts without the linked records
    // (non-associate roles hitting this view, no payroll yet) and render as
    // genuine empty states. Anything else — network down, 500 — must NOT
    // masquerade as "Nothing scheduled": the card shows a retry instead.
    const settle = <T,>(p: Promise<T>): Promise<{ value: T | null; failed: boolean }> =>
      p.then(
        (value) => ({ value, failed: false }),
        (err) => ({
          value: null,
          failed: !(err instanceof ApiError && (err.status === 403 || err.status === 404)),
        }),
      );

    const [a, shifts, pay, bal] = await Promise.all([
      settle(getActiveTimeEntry()),
      settle(listMyShifts()),
      settle(listMyPayrollItems()),
      settle(getMyBalance()),
    ]);
    setActive(a.value ?? null);
    setNextShift(pickNextShift(shifts.value?.shifts ?? []));
    setLatestPaystub((pay.value?.items ?? [])[0] ?? null);
    setBalances(bal.value?.balances ?? []);
    setFailed({
      clock: a.failed,
      shift: shifts.failed,
      pay: pay.failed,
      timeOff: bal.failed,
    });
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const pullState = usePullToRefresh(refreshAll);
  const isClockedIn = !!active?.active;

  return (
    <div className="mx-auto">
      <PullToRefreshIndicator state={pullState} />
      <PageHeader
        title={t('dash.greeting', { name: greetingName })}
        subtitle={t('dash.subtitle')}
      />

      <OnboardingBanner />
      <EnablePushCard />

      {/* Top row — clock-in and next shift get the spotlight. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4 mb-4">
        {failed.clock ? (
          <LoadFailedCard
            label={t('dash.clock')}
            icon={Clock}
            onRetry={refreshAll}
            className="md:col-span-1"
          />
        ) : (
          <ClockCard active={active} isClockedIn={isClockedIn} />
        )}
        {failed.shift ? (
          <LoadFailedCard
            label={t('dash.nextShift')}
            icon={Timer}
            onRetry={refreshAll}
            className="md:col-span-2"
          />
        ) : (
          <NextShiftCard nextShift={nextShift} />
        )}
      </div>

      {/* Second row — pay + time-off balance. Quieter, but still front-page. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 mb-6">
        {failed.pay ? (
          <LoadFailedCard label={t('dash.lastPaystub')} icon={DollarSign} onRetry={refreshAll} />
        ) : (
          <PaystubCard item={latestPaystub} onView={() => navigate('/payroll')} />
        )}
        {failed.timeOff ? (
          <LoadFailedCard label={t('dash.timeOff')} icon={CalendarOff} onRetry={refreshAll} />
        ) : (
          <TimeOffCard balances={balances} onView={() => navigate('/time-off')} />
        )}
      </div>

      <QuickActions />
    </div>
  );
}

/* ---------------------------- helpers / cards ----------------------------- */

const PUSH_DISMISS_KEY = 'alto:pushCard.dismissed.v1';

/**
 * One-tap opt-in for lock-screen notifications. Only renders when push is
 * actually available here (supported browser, permission not denied, not
 * already subscribed) and the user hasn't dismissed it — most sessions
 * never see it. The permission prompt fires from the tap, as required.
 */
function EnablePushCard() {
  const { t } = useI18n();
  const [status, setStatus] = useState<'hidden' | 'ready' | 'working'>('hidden');

  useEffect(() => {
    let cancelled = false;
    if (localStorage.getItem(PUSH_DISMISS_KEY)) return;
    getPushStatus().then((s) => {
      if (!cancelled && s === 'available') setStatus('ready');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'hidden') return null;

  const enable = async () => {
    setStatus('working');
    try {
      await subscribeToPush();
      hapticConfirm();
      toast.success("Notifications on — you'll hear about shifts even with the app closed.");
      setStatus('hidden');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not enable notifications.');
      setStatus('ready');
    }
  };
  const dismiss = () => {
    try {
      localStorage.setItem(PUSH_DISMISS_KEY, '1');
    } catch {
      // Storage unavailable — the card just reappears next session.
    }
    setStatus('hidden');
  };

  return (
    <div className="mb-4 p-4 rounded-lg border border-gold/40 bg-gold/5 flex items-center justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <div className="text-white font-medium">{t('dash.pushTitle')}</div>
        <p className="text-xs text-silver mt-0.5">{t('dash.pushBody')}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" onClick={enable} loading={status === 'working'}>
          {t('dash.pushOn')}
        </Button>
        <Button variant="ghost" size="sm" onClick={dismiss}>
          {t('dash.pushLater')}
        </Button>
      </div>
    </div>
  );
}

// Same definition of "next" as the My Schedule page (endsAt >= now): an
// in-progress shift IS the next shift until it ends. The old startsAt-based
// window made this card skip ahead to the following shift an hour into the
// current one while the schedule page still highlighted the current one.
function pickNextShift(shifts: Shift[]): Shift | null {
  const now = Date.now();
  const upcoming = shifts
    .filter((s) => new Date(s.endsAt).getTime() >= now && s.status !== 'CANCELLED')
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return upcoming[0] ?? null;
}

function fmtElapsed(sinceIso: string): string {
  const ms = Date.now() - new Date(sinceIso).getTime();
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Rendered in place of a card whose fetch failed for a non-expected reason
 * (network down, 500). Deliberately NOT the card's empty state — "Nothing
 * scheduled" when the request never landed is confidently wrong, and for
 * the clock card guessing "off the clock" could trigger a double punch.
 */
function LoadFailedCard({
  label,
  icon: Icon,
  onRetry,
  className,
}: {
  label: string;
  icon: typeof Clock;
  onRetry: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Card className={className}>
      <CardContent className="pt-5">
        <div className="text-[11px] uppercase tracking-widest text-silver flex items-center gap-1.5">
          <Icon className="h-3 w-3" aria-hidden="true" />
          {label}
        </div>
        <div role="alert" className="font-display text-xl text-white mt-2">
          {t('dash.loadFailed')}
        </div>
        <p className="text-sm text-silver mt-1">{t('dash.checkConnection')}</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </CardContent>
    </Card>
  );
}

interface ClockCardProps {
  active: ActiveTimeEntryResponse | null | undefined;
  isClockedIn: boolean;
}

/**
 * Live clock STATUS only — associates punch at the worksite kiosk
 * (company policy, and the API rejects phone punches for the ASSOCIATE
 * role). This card used to offer a Clock in button that contradicted
 * the Time page's kiosk-only explainer and could never succeed; now it
 * mirrors the kiosk state and points at the tablet.
 */
function ClockCard({ active, isClockedIn }: ClockCardProps) {
  const { t } = useI18n();
  if (active === undefined) {
    return (
      <Card className="md:col-span-1">
        <CardContent className="pt-6">
          <Skeleton className="h-3 w-24 mb-3" />
          <Skeleton className="h-8 w-32 mb-3" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card
      className={cn(
        'md:col-span-1',
        isClockedIn && 'border-success/40 bg-success/5'
      )}
    >
      <CardContent className="pt-5">
        <div className="text-[11px] uppercase tracking-widest text-silver flex items-center gap-1.5">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {t('dash.clock')}
        </div>
        <div className="font-display text-2xl text-white mt-2 leading-tight">
          {isClockedIn ? t('dash.onClock') : t('dash.offClock')}
        </div>
        {isClockedIn && active?.active ? (
          <div className="text-xs text-silver mt-1 tabular-nums">
            {t('dash.startedIn', {
              time: fmtTime(active.active.clockInAt),
              elapsed: fmtElapsed(active.active.clockInAt),
            })}
          </div>
        ) : (
          <p className="text-xs text-silver/70 mt-1">{t('dash.kioskHint')}</p>
        )}
      </CardContent>
    </Card>
  );
}

function NextShiftCard({ nextShift }: { nextShift: Shift | null | undefined }) {
  const { t } = useI18n();
  if (nextShift === undefined) {
    return (
      <Card className="md:col-span-2">
        <CardContent className="pt-6">
          <Skeleton className="h-3 w-32 mb-3" />
          <Skeleton className="h-8 w-2/3 mb-2" />
          <Skeleton className="h-4 w-1/2" />
        </CardContent>
      </Card>
    );
  }
  if (!nextShift) {
    return (
      <Card className="md:col-span-2">
        <CardContent className="pt-5">
          <div className="text-[11px] uppercase tracking-widest text-silver flex items-center gap-1.5">
            <Timer className="h-3 w-3" aria-hidden="true" />
            {t('dash.nextShift')}
          </div>
          <div className="font-display text-xl text-white mt-2">
            {t('dash.nothingScheduled')}
          </div>
          <p className="text-sm text-silver mt-1">{t('dash.managerWillPublish')}</p>
          <Link
            to="/scheduling"
            className="text-sm text-gold hover:text-gold-bright active:text-gold-bright mt-3 inline-flex items-center gap-1 coarse:min-h-11"
          >
            {t('dash.viewSchedule')}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="md:col-span-2">
      <CardContent className="pt-5">
        <div className="text-[11px] uppercase tracking-widest text-silver flex items-center gap-1.5">
          <Timer className="h-3 w-3" aria-hidden="true" />
          {t('dash.nextShift')}
        </div>
        <div className="flex items-baseline gap-2 mt-2 flex-wrap">
          <div className="font-display text-2xl text-white leading-tight">
            {fmtRelativeDayTz(nextShift.startsAt, nextShift.timezone)}
          </div>
          <div className="text-lg text-gold tabular-nums">
            {fmtShiftRangeTz(nextShift.startsAt, nextShift.endsAt, nextShift.timezone)}
          </div>
        </div>
        <div className="text-sm text-silver mt-1">
          {nextShift.position}
          {nextShift.clientName && ` · ${nextShift.clientName}`}
        </div>
        {nextShift.location && (
          // flex (not inline-flex): as an inline box this sat on the SAME
          // line as the "See full schedule" link below with no separator —
          // "Front endSee full schedule" (caught by the visual walk).
          <div className="text-xs text-silver/70 mt-1 flex items-center gap-1">
            <MapPin className="h-3 w-3" aria-hidden="true" />
            {nextShift.location}
          </div>
        )}
        <Link
          to="/scheduling"
          className="text-sm text-gold hover:text-gold-bright active:text-gold-bright mt-3 inline-flex items-center gap-1 coarse:min-h-11"
        >
          {t('dash.seeFullSchedule')}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardContent>
    </Card>
  );
}

function PaystubCard({
  item,
  onView,
}: {
  item: PayrollItem | null | undefined;
  onView: () => void;
}) {
  const { t } = useI18n();
  if (item === undefined) {
    return (
      <Card>
        <CardContent className="pt-6">
          <Skeleton className="h-3 w-32 mb-3" />
          <Skeleton className="h-8 w-1/2 mb-2" />
          <Skeleton className="h-4 w-1/3" />
        </CardContent>
      </Card>
    );
  }
  if (!item) {
    return (
      <Card>
        <CardContent className="pt-5">
          <div className="text-[11px] uppercase tracking-widest text-silver flex items-center gap-1.5">
            <DollarSign className="h-3 w-3" aria-hidden="true" />
            {t('dash.lastPaystub')}
          </div>
          <div className="font-display text-xl text-white mt-2">{t('dash.noPaystubs')}</div>
          <p className="text-sm text-silver mt-1">{t('dash.firstPaystub')}</p>
        </CardContent>
      </Card>
    );
  }
  const showDisbursed = !!item.disbursedAt;
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-[11px] uppercase tracking-widest text-silver flex items-center gap-1.5">
          <DollarSign className="h-3 w-3" aria-hidden="true" />
          {t('dash.lastPaystub')}
        </div>
        <div className="font-display text-3xl text-gold mt-2 tabular-nums">
          {fmtMoney(item.netPay)}
        </div>
        <div className="text-xs text-silver mt-1 tabular-nums">
          {t('dash.netWorked', { hours: item.hoursWorked.toFixed(2) })}
          {showDisbursed && item.disbursedAt && (
            <> · {t('dash.paidOn', { date: fmtDate(item.disbursedAt) })}</>
          )}
        </div>
        <button
          type="button"
          onClick={onView}
          className="text-sm text-gold hover:text-gold-bright active:text-gold-bright mt-3 inline-flex items-center gap-1 coarse:min-h-11"
        >
          {t('dash.viewPayHistory')}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </CardContent>
    </Card>
  );
}

const CATEGORY_LABEL: Record<string, string> = {
  SICK: 'Sick',
  VACATION: 'Vacation',
  PTO: 'PTO',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

function TimeOffCard({
  balances,
  onView,
}: {
  balances: TimeOffBalance[] | null | undefined;
  onView: () => void;
}) {
  const { t } = useI18n();
  if (balances === undefined) {
    return (
      <Card>
        <CardContent className="pt-6">
          <Skeleton className="h-3 w-24 mb-3" />
          <Skeleton className="h-8 w-1/3 mb-2" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    );
  }
  if (!balances || balances.length === 0) {
    return (
      <Card>
        <CardContent className="pt-5">
          <div className="text-[11px] uppercase tracking-widest text-silver flex items-center gap-1.5">
            <CalendarOff className="h-3 w-3" aria-hidden="true" />
            {t('dash.timeOff')}
          </div>
          <div className="font-display text-xl text-white mt-2">{t('dash.noBalance')}</div>
          <p className="text-sm text-silver mt-1">{t('dash.sickAccrues')}</p>
          <button
            type="button"
            onClick={onView}
            className="text-sm text-gold hover:text-gold-bright active:text-gold-bright mt-3 inline-flex items-center gap-1 coarse:min-h-11"
          >
            {t('dash.openTimeOff')}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </CardContent>
      </Card>
    );
  }
  // Show the largest balance prominently; list any others as small chips.
  const sorted = [...balances].sort((a, b) => b.balanceMinutes - a.balanceMinutes);
  const primary = sorted[0];
  const rest = sorted.slice(1);
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-[11px] uppercase tracking-widest text-silver flex items-center gap-1.5">
          <CalendarOff className="h-3 w-3" aria-hidden="true" />
          {t('dash.timeOff')}
        </div>
        <div className="flex items-baseline gap-2 mt-2 flex-wrap">
          <div className="font-display text-3xl text-gold tabular-nums">
            {(primary.balanceMinutes / 60).toFixed(1)}h
          </div>
          <div className="text-sm text-silver">{CATEGORY_LABEL[primary.category] ?? primary.category}</div>
        </div>
        {rest.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {rest.map((b) => (
              <span
                key={b.category}
                className="text-xs text-silver bg-navy-secondary/40 rounded px-2 py-0.5 tabular-nums"
              >
                {CATEGORY_LABEL[b.category] ?? b.category}: {(b.balanceMinutes / 60).toFixed(1)}h
              </span>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onView}
          className="text-sm text-gold hover:text-gold-bright active:text-gold-bright mt-3 inline-flex items-center gap-1 coarse:min-h-11"
        >
          {t('dash.requestOrView')}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </CardContent>
    </Card>
  );
}

const QUICK_LINKS: { to: string; labelKey: MessageKey; icon: typeof Clock }[] = [
  { to: '/time-attendance', labelKey: 'dash.myTimesheet', icon: Clock },
  { to: '/scheduling', labelKey: 'dash.scheduleSwaps', icon: Timer },
  { to: '/documents', labelKey: 'dash.documents', icon: FileText },
  { to: '/time-off', labelKey: 'dash.requestTimeOff', icon: CalendarOff },
];

function QuickActions() {
  const { t } = useI18n();
  return (
    <section>
      <h2 className="font-display text-xl text-white mb-3">{t('dash.quickLinks')}</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {QUICK_LINKS.map(({ to, labelKey, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group flex items-center gap-2 px-3 py-3 min-h-12 rounded-md border border-navy-secondary bg-navy hover:border-gold/50 hover:bg-navy/80 active:bg-navy-secondary/60 active:border-gold/50 transition-colors text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Icon className="h-4 w-4 text-silver group-hover:text-gold transition-colors" aria-hidden="true" />
            <span className="flex-1 truncate">{t(labelKey)}</span>
            <ArrowRight className="h-3.5 w-3.5 text-silver/70 group-hover:text-gold transition-colors" />
          </Link>
        ))}
      </div>
    </section>
  );
}
