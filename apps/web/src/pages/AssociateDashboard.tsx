import { useCallback, useEffect, useState } from 'react';
import { greetingName as greetingNameOf } from '@/lib/greeting';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarDays,
  CalendarOff,
  Clock,
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
import { listOpenShifts } from '@/lib/qualApi';
import { fmtDate, fmtDayShort, fmtHours, fmtMoney, parseYmd } from '@/lib/format';
import { getMyNextPayday, listMyPayrollItems } from '@/lib/payrollApi';
import { getMyBalance } from '@/lib/timeOffApi';
import { getEmployeeNumber } from '@/lib/selfApi';
import { Button } from '@/components/ui/Button';
import { EmergencyBanner } from '@/components/EmergencyBanner';
import { Card, CardContent } from '@/components/ui/Card';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import {
  PullToRefreshIndicator,
  usePullToRefresh,
} from '@/lib/usePullToRefresh';
import { hapticConfirm } from '@/lib/haptics';
import { getPushStatus, subscribeToPush } from '@/lib/push';
import { OnboardingBanner, useOpenOnboarding } from '@/components/OnboardingBanner';
import { ReadyToWorkCard } from '@/components/ReadyToWorkCard';
import { CelebrationRibbon } from '@/components/CelebrationRibbon';
import { EarningsCard } from '@/components/EarningsCard';
import { FirstPaycheckCard } from '@/components/FirstPaycheckCard';
import { RideStrip } from '@/pages/transport/RideStrip';
import { StatTile } from '@/pages/portal/portalCharts';
import { paidShiftMinutes } from '@/pages/scheduling/ShiftCard';
import { MyShiftHero, MyWeekStrip, pickNextShift } from '@/pages/associate/MyShiftHero';
import { AssociateNeedsYou, TrainingNudge, useAssociateNeedsYou } from '@/components/home/AssociateNeedsYou';
import { workweekBounds } from '@/lib/workweek';

/**
 * 403/404 are fully expected for accounts without the linked records
 * (non-associate roles hitting this view, no payroll yet) and render as
 * genuine empty states (null data). Anything else — network down, 500 —
 * must NOT masquerade as "Nothing scheduled": it rethrows so the query
 * errors and the card shows a retry instead.
 */
async function emptyOnExpectedDenial<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      return null;
    }
    throw err;
  }
}

export function AssociateDashboard() {
  const { user } = useAuth();
  const { t } = useI18n();

  const greetingName = greetingNameOf(user, '');

  // Each fetch is an independent query; one failing shouldn't blank out
  // the others. Cached results render instantly on revisit and refresh
  // in the background once stale.
  const activeQuery = useQuery({
    queryKey: ['me', 'activeEntry'],
    queryFn: () => emptyOnExpectedDenial(getActiveTimeEntry()),
  });
  const shiftsQuery = useQuery({
    queryKey: ['me', 'shifts'],
    queryFn: () => emptyOnExpectedDenial(listMyShifts()),
  });
  const payQuery = useQuery({
    queryKey: ['me', 'payrollItems'],
    queryFn: () => emptyOnExpectedDenial(listMyPayrollItems()),
  });
  const balanceQuery = useQuery({
    queryKey: ['me', 'timeOffBalance'],
    queryFn: () => emptyOnExpectedDenial(getMyBalance()),
  });
  // The Open shifts page's own list, so the tile's number is what the tap
  // opens onto.
  const openQuery = useQuery({
    queryKey: ['me', 'marketplace', 'open'],
    queryFn: () => emptyOnExpectedDenial(listOpenShifts()),
  });

  // undefined → still loading (skeleton); null/[] → honest empty state.
  const active: ActiveTimeEntryResponse | null | undefined = activeQuery.data;
  const shifts: Shift[] | undefined =
    shiftsQuery.data === undefined ? undefined : (shiftsQuery.data?.shifts ?? []);
  const nextShift = shifts ? pickNextShift(shifts) : null;
  const latestPaystub: PayrollItem | null | undefined =
    payQuery.data === undefined
      ? undefined
      : ((payQuery.data?.items ?? [])[0] ?? null);
  const balances: TimeOffBalance[] | null | undefined =
    balanceQuery.data === undefined
      ? undefined
      : (balanceQuery.data?.balances ?? []);
  const openShiftCount = openQuery.data === undefined ? null : (openQuery.data?.shifts?.length ?? 0);

  const { refetch: refetchActive } = activeQuery;
  const { refetch: refetchShifts } = shiftsQuery;
  const { refetch: refetchPay } = payQuery;
  const { refetch: refetchBalance } = balanceQuery;
  const { refetch: refetchOpen } = openQuery;
  const refreshAll = useCallback(async () => {
    await Promise.all([
      refetchActive(),
      refetchShifts(),
      refetchPay(),
      refetchBalance(),
      refetchOpen(),
    ]);
  }, [refetchActive, refetchShifts, refetchPay, refetchBalance, refetchOpen]);

  const pullState = usePullToRefresh(refreshAll);
  // The counted "Needs you" the template promises — the same numbers as
  // the sidebar badge, from GET /me/inbox.
  const needs = useAssociateNeedsYou();
  // The place, the way the supervisor's floor leads with its store: where
  // their next (or current) shift is.
  const place = nextShift
    ? [nextShift.locationName, nextShift.clientName].filter(Boolean).join(' · ')
    : '';

  const openOnboarding = useOpenOnboarding();
  // Their shift, in the tone of the moment — on the clock, late, coming
  // up, or nothing scheduled.
  const shiftHero =
    activeQuery.isError || shiftsQuery.isError ? (
    <LoadFailedCard label={t('dash.nextShift')} icon={Timer} onRetry={refreshAll} className="mb-4" />
    ) : (
    <MyShiftHero
      active={active}
      shifts={shifts}
      openShiftCount={openShiftCount}
      footer={(state) =>
        // Late already says where to punch; the number is what they
        // need at the tablet.
        state === 'late' ? (
          <EmployeeNumberLine />
        ) : (
          <div className="mt-4 border-t border-navy-secondary/60 pt-3">
            <p className="text-xs text-silver/80">
              {t('dash.offClock')} · {t('dash.kioskHint')}
            </p>
            <EmployeeNumberLine />
          </div>
        )
      }
    />
    );

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      {/* Design system §4.1 (UX upgrade step 2): the Home template, phone
          first. Banners that interrupt, the greeting, the shift as the one
          hero, then what needs them, their numbers, their pay and week,
          Hugo, and the shortcuts. */}
      <HomeTemplate
        title={greetingName ? t('dash.greeting', { name: greetingName }) : t('dash.greetingNoName')}
        topbarTitle={t('tabs.home')}
        subtitle={
          place ? (
            <span className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
              {place}
            </span>
          ) : (
            t('dash.subtitle')
          )
        }
        banners={
          <>
            {/* A storm outranks everything below: the one-tap check-in, only
                while an emergency that includes this person is active. */}
            <EmergencyBanner />
            <CelebrationRibbon />
            {/* From the clock-in number to the first punch: where they work, who
                runs the floor, and how to reach them. */}
            <ReadyToWorkCard className="mb-4" />
          </>
        }
        hero={
          // Until the checklist is done, onboarding is the one thing this
          // person has to do, so it is the hero and the shift follows it.
          openOnboarding ? <OnboardingBanner hero /> : shiftHero
        }
        decisions={{ title: t('home.needsYou'), count: needs.count, content: <AssociateNeedsYou /> }}
        assistant={<HugoSeat />}
        waysIn={<QuickActions />}
      >
        {openOnboarding && shiftHero}
        {/* Training in the flow of work: a required course still open, or a
            certification about to lapse, the day it matters. */}
        <TrainingNudge nextShiftAt={nextShift?.startsAt ?? null} />
        {/* Their van — the ride that's coming, or a one-tap ride for the
            next shift that needs one. */}
        <RideStrip />
        <EnablePushCard />
        {/* The four numbers their week runs on — the supervisor's KPI strip,
            for one person. */}
        <MyNumbers
          shifts={shifts}
          paystub={latestPaystub}
          payFailed={payQuery.isError}
          balances={balances}
          balanceFailed={balanceQuery.isError}
          openShiftCount={openShiftCount}
        />
        <div className="mb-4 space-y-4">
          <EarningsCard />
          {/* New hires see their own relay lane — every "where's my check?"
              this answers is a case that never gets filed. */}
          <FirstPaycheckCard />
        </div>
        <MyWeekStrip shifts={shiftsQuery.isError ? null : shifts} />
      </HomeTemplate>
    </>
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
    // eslint-disable-next-line no-restricted-syntax -- reads the browser's push permission state, not the API
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
      toast.success(t('dash.pushOnToast'));
      setStatus('hidden');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('dash.pushFailed'));
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
        <div className="text-xs font-medium text-silver/70 flex items-center gap-1.5">
          <Icon className="h-3 w-3" aria-hidden="true" />
          {label}
        </div>
        <div role="alert" className="text-xl text-white mt-2">
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

/**
 * The kiosk clock-in number, on the card that talks about clocking in.
 * It used to live only at More → My profile → scroll — three-plus taps
 * for the credential every shift starts with. Masked until tapped so a
 * glance over a shoulder in the break room doesn't leak it.
 */
function EmployeeNumberLine() {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const { data } = useQuery({
    queryKey: ['me', 'employeeNumber'],
    queryFn: () => getEmployeeNumber().catch(() => null),
    staleTime: 5 * 60_000,
  });
  if (!data?.employeeNumber) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-2">
      <span className="text-xs text-silver/70">{t('dash.myNumber')}</span>
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        className="font-mono text-sm tracking-[0.3em] text-white rounded px-1 coarse:min-h-9 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        aria-label={revealed ? t('dash.hideNumber') : t('dash.showNumber')}
      >
        {revealed ? data.employeeNumber : '••••'}
      </button>
    </div>
  );
}

// Same keys the Time-off page uses for these categories — the dashboard
// chip and the Time-off balance card must never disagree on wording.
const CATEGORY_KEY: Record<string, MessageKey> = {
  SICK: 'timeoff.cat.SICK',
  VACATION: 'timeoff.cat.VACATION',
  PTO: 'timeoff.cat.PTO',
  BEREAVEMENT: 'timeoff.cat.BEREAVEMENT',
  JURY_DUTY: 'timeoff.cat.JURY_DUTY',
  OTHER: 'timeoff.cat.OTHER',
};

/**
 * Their four numbers, as tiles — hours this week (the Sat→Fri workweek
 * payroll counts, lib/workweek), the last paycheck, time off, and the open
 * shifts they can grab. They replace two tall cards whose empty states
 * ("No paystubs yet", "No balance yet") filled a phone screen by themselves.
 */
function MyNumbers({
  shifts,
  paystub,
  payFailed,
  balances,
  balanceFailed,
  openShiftCount,
}: {
  shifts: Shift[] | undefined;
  paystub: PayrollItem | null | undefined;
  payFailed: boolean;
  balances: TimeOffBalance[] | null | undefined;
  balanceFailed: boolean;
  openShiftCount: number | null;
}) {
  const { t } = useI18n();
  // Before the first paycheck, the date it lands is the useful number.
  const paydayQuery = useQuery({
    queryKey: ['me', 'nextPayday'],
    queryFn: () => getMyNextPayday().catch(() => ({ nextPayday: null })),
    staleTime: 10 * 60_000,
  });
  const nextPayday = paydayQuery.data?.nextPayday ?? null;
  const week = (() => {
    if (!shifts) return null;
    const { start, end } = workweekBounds();
    const inWeek = shifts.filter((s) => {
      const at = new Date(s.startsAt).getTime();
      return s.status !== 'CANCELLED' && at >= start.getTime() && at < end.getTime();
    });
    return { count: inWeek.length, minutes: inWeek.reduce((n, s) => n + paidShiftMinutes(s), 0) };
  })();
  const primary = balances && balances.length > 0 ? [...balances].sort((a, b) => b.balanceMinutes - a.balanceMinutes)[0]! : null;

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 animate-enter">
      <TileLink to="/scheduling">
        <StatTile
          className="h-full"
          label={t('tile.thisWeek')}
          value={week ? fmtHours(week.minutes / 60) : '—'}
          sub={
            week
              ? week.count === 0
                ? t('tile.noShifts')
                : t(week.count === 1 ? 'tile.shiftsOne' : 'tile.shiftsMany', { count: week.count })
              : undefined
          }
        />
      </TileLink>
      <TileLink to="/payroll">
        <StatTile
          className="h-full"
          label={t('tile.lastPay')}
          value={paystub ? fmtMoney(paystub.netPay) : '—'}
          sub={
            payFailed
              ? t('dash.loadFailed')
              : paystub === undefined
                ? undefined
                : paystub
                  ? paystub.disbursedAt
                    ? t('tile.paidOn', { date: fmtDate(paystub.disbursedAt) })
                    : t('dash.netWorked', { hours: fmtHours(paystub.hoursWorked) })
                  : nextPayday
                    ? t('tile.nextPayday', {
                        date:
                          fmtDayShort(parseYmd(nextPayday.payDate), { anchored: true }) ?? nextPayday.payDate,
                      })
                    : t('tile.noPayYet')
          }
        />
      </TileLink>
      <TileLink to="/time-off">
        <StatTile
          className="h-full"
          label={t('tile.timeOff')}
          value={primary ? fmtHours(primary.balanceMinutes / 60) : '—'}
          sub={
            balanceFailed
              ? t('dash.loadFailed')
              : balances === undefined
                ? undefined
                : primary
                  ? CATEGORY_KEY[primary.category]
                    ? t(CATEGORY_KEY[primary.category]!)
                    : primary.category
                  : t('tile.accrues')
          }
        />
      </TileLink>
      <TileLink to="/marketplace">
        <StatTile
          className="h-full"
          label={t('tile.openShifts')}
          value={openShiftCount ?? '—'}
          sub={openShiftCount === null ? undefined : openShiftCount > 0 ? t('tile.openSome') : t('tile.openNone')}
        />
      </TileLink>
    </div>
  );
}

/** A tile that opens where the number is worked — same as My floor's. */
function TileLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="group block rounded-lg transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright [&>div]:transition-colors [&>div]:hover:border-gold/40"
    >
      {children}
    </Link>
  );
}

const QUICK_LINKS: { to: string; labelKey: MessageKey; icon: typeof Clock }[] = [
  // Same words as the page it opens ("My time"), and a calendar for the schedule.
  { to: '/time-attendance', labelKey: 'time.myTime', icon: Clock },
  { to: '/scheduling', labelKey: 'dash.scheduleSwaps', icon: CalendarDays },
  { to: '/documents', labelKey: 'dash.documents', icon: FileText },
  // ?new=1 lands straight in the request dialog — one tap to ask for a day.
  { to: '/time-off?new=1', labelKey: 'dash.requestTimeOff', icon: CalendarOff },
];

function QuickActions() {
  const { t } = useI18n();
  return (
    <section>
      <h2 className="text-xl text-white mb-3">{t('dash.quickLinks')}</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {QUICK_LINKS.map(({ to, labelKey, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group flex items-center gap-2 px-3 py-3 min-h-12 rounded-md border border-navy-secondary bg-navy hover:border-gold/50 hover:bg-navy/80 active:bg-navy-secondary/60 active:border-gold/50 transition-colors text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Icon className="h-4 w-4 text-silver group-hover:text-gold transition-colors" aria-hidden="true" />
            <span className="min-w-0 flex-1 leading-tight">{t(labelKey)}</span>
            <ArrowRight className="h-3.5 w-3.5 text-silver/70 group-hover:text-gold transition-colors" />
          </Link>
        ))}
      </div>
    </section>
  );
}
