import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CalendarOff,
  Clock,
  DollarSign,
  MapPin,
  Play,
  Square,
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
import { ApiError } from '@/lib/api';
import { clockIn, clockOut, getActiveTimeEntry, tryGetGeolocation } from '@/lib/timeApi';
import { listMyShifts } from '@/lib/schedulingApi';
import { listMyPayrollItems } from '@/lib/payrollApi';
import { getMyBalance } from '@/lib/timeOffApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { OnboardingBanner } from '@/components/OnboardingBanner';
import { cn } from '@/lib/cn';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const HOUR_MS = 60 * 60 * 1000;

export function AssociateDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [active, setActive] = useState<ActiveTimeEntryResponse | null | undefined>(undefined);
  const [nextShift, setNextShift] = useState<Shift | null | undefined>(undefined);
  const [latestPaystub, setLatestPaystub] = useState<PayrollItem | null | undefined>(undefined);
  const [balances, setBalances] = useState<TimeOffBalance[] | null | undefined>(undefined);
  const [clocking, setClocking] = useState(false);

  const greetingName =
    user?.email ? user.email.split('@')[0].split('.')[0].replace(/^\w/, (c) => c.toUpperCase()) : 'there';

  const refreshAll = useCallback(async () => {
    // Each fetch is independent; one failing shouldn't blank out the others.
    // 403s are fully expected for non-associate roles that hit this view by
    // mistake (the parent gates by role, but defensive doesn't cost much).
    const settle = <T,>(p: Promise<T>): Promise<T | null> =>
      p.catch((err) => {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return null;
        return null;
      });

    const [a, shifts, pay, bal] = await Promise.all([
      settle(getActiveTimeEntry()),
      settle(listMyShifts()),
      settle(listMyPayrollItems()),
      settle(getMyBalance()),
    ]);
    setActive(a ?? null);
    setNextShift(pickNextShift(shifts?.shifts ?? []));
    setLatestPaystub((pay?.items ?? [])[0] ?? null);
    setBalances(bal?.balances ?? []);
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const isClockedIn = !!active?.active;

  const handleClockToggle = async () => {
    if (clocking) return;
    setClocking(true);
    try {
      // Best-effort geo; clock-in/out work without it (geofence on the
      // server is what enforces presence when configured).
      const geo = await tryGetGeolocation(3_000);
      const body = geo ? { geo } : {};
      if (isClockedIn) {
        await clockOut(body);
        toast.success('Clocked out');
      } else {
        await clockIn(body);
        toast.success('Clocked in');
      }
      await refreshAll();
    } catch (err) {
      toast.error(isClockedIn ? 'Could not clock out' : 'Could not clock in', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setClocking(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Hey {greetingName} 👋
        </h1>
        <p className="text-silver">Here's what's on for today.</p>
      </header>

      <OnboardingBanner />

      {/* Top row — clock-in and next shift get the spotlight. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4 mb-4">
        <ClockCard
          active={active}
          isClockedIn={isClockedIn}
          clocking={clocking}
          onToggle={handleClockToggle}
        />
        <NextShiftCard nextShift={nextShift} />
      </div>

      {/* Second row — pay + time-off balance. Quieter, but still front-page. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 mb-6">
        <PaystubCard item={latestPaystub} onView={() => navigate('/payroll')} />
        <TimeOffCard balances={balances} onView={() => navigate('/time-off')} />
      </div>

      <QuickActions />
    </div>
  );
}

/* ---------------------------- helpers / cards ----------------------------- */

function pickNextShift(shifts: Shift[]): Shift | null {
  const now = Date.now();
  const upcoming = shifts
    .filter((s) => new Date(s.startsAt).getTime() >= now - HOUR_MS && s.status !== 'CANCELLED')
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return upcoming[0] ?? null;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtRelativeDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtElapsed(sinceIso: string): string {
  const ms = Date.now() - new Date(sinceIso).getTime();
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

interface ClockCardProps {
  active: ActiveTimeEntryResponse | null | undefined;
  isClockedIn: boolean;
  clocking: boolean;
  onToggle: () => void;
}

function ClockCard({ active, isClockedIn, clocking, onToggle }: ClockCardProps) {
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
        <div className="text-[10px] uppercase tracking-widest text-silver flex items-center gap-1.5">
          <Clock className="h-3 w-3" aria-hidden="true" />
          Clock
        </div>
        <div className="font-display text-2xl text-white mt-2 leading-tight">
          {isClockedIn ? 'On the clock' : 'Off the clock'}
        </div>
        {isClockedIn && active?.active && (
          <div className="text-xs text-silver mt-1 tabular-nums">
            Started {fmtTime(active.active.clockInAt)} · {fmtElapsed(active.active.clockInAt)} in
          </div>
        )}
        <Button
          onClick={onToggle}
          loading={clocking}
          className="w-full mt-4"
          variant={isClockedIn ? 'destructive' : 'primary'}
        >
          {isClockedIn ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {isClockedIn ? 'Clock out' : 'Clock in'}
        </Button>
      </CardContent>
    </Card>
  );
}

function NextShiftCard({ nextShift }: { nextShift: Shift | null | undefined }) {
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
          <div className="text-[10px] uppercase tracking-widest text-silver flex items-center gap-1.5">
            <Timer className="h-3 w-3" aria-hidden="true" />
            Next shift
          </div>
          <div className="font-display text-xl text-white mt-2">
            Nothing scheduled
          </div>
          <p className="text-sm text-silver mt-1">
            Your manager will publish shifts ahead of the week. Check back soon.
          </p>
          <Link
            to="/scheduling"
            className="text-sm text-gold hover:text-gold-bright mt-3 inline-flex items-center gap-1"
          >
            View schedule
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="md:col-span-2">
      <CardContent className="pt-5">
        <div className="text-[10px] uppercase tracking-widest text-silver flex items-center gap-1.5">
          <Timer className="h-3 w-3" aria-hidden="true" />
          Next shift
        </div>
        <div className="flex items-baseline gap-2 mt-2 flex-wrap">
          <div className="font-display text-2xl text-white leading-tight">
            {fmtRelativeDay(nextShift.startsAt)}
          </div>
          <div className="text-lg text-gold tabular-nums">
            {fmtTime(nextShift.startsAt)} – {fmtTime(nextShift.endsAt)}
          </div>
        </div>
        <div className="text-sm text-silver mt-1">
          {nextShift.position}
          {nextShift.clientName && ` · ${nextShift.clientName}`}
        </div>
        {nextShift.location && (
          <div className="text-xs text-silver/70 mt-1 inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" aria-hidden="true" />
            {nextShift.location}
          </div>
        )}
        <Link
          to="/scheduling"
          className="text-sm text-gold hover:text-gold-bright mt-3 inline-flex items-center gap-1"
        >
          See full schedule
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
          <div className="text-[10px] uppercase tracking-widest text-silver flex items-center gap-1.5">
            <DollarSign className="h-3 w-3" aria-hidden="true" />
            Last paystub
          </div>
          <div className="font-display text-xl text-white mt-2">No paystubs yet</div>
          <p className="text-sm text-silver mt-1">
            Your first one will show up here once your manager runs payroll.
          </p>
        </CardContent>
      </Card>
    );
  }
  const showDisbursed = !!item.disbursedAt;
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-[10px] uppercase tracking-widest text-silver flex items-center gap-1.5">
          <DollarSign className="h-3 w-3" aria-hidden="true" />
          Last paystub
        </div>
        <div className="font-display text-3xl text-gold mt-2 tabular-nums">
          {fmtMoney(item.netPay)}
        </div>
        <div className="text-xs text-silver mt-1 tabular-nums">
          Net · {item.hoursWorked.toFixed(2)}h worked
          {showDisbursed && item.disbursedAt && (
            <> · paid {new Date(item.disbursedAt).toLocaleDateString()}</>
          )}
        </div>
        <button
          type="button"
          onClick={onView}
          className="text-sm text-gold hover:text-gold-bright mt-3 inline-flex items-center gap-1"
        >
          View pay history
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
          <div className="text-[10px] uppercase tracking-widest text-silver flex items-center gap-1.5">
            <CalendarOff className="h-3 w-3" aria-hidden="true" />
            Time off
          </div>
          <div className="font-display text-xl text-white mt-2">No balance yet</div>
          <p className="text-sm text-silver mt-1">
            Sick-leave hours accrue automatically as you work.
          </p>
          <button
            type="button"
            onClick={onView}
            className="text-sm text-gold hover:text-gold-bright mt-3 inline-flex items-center gap-1"
          >
            Open time off
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
        <div className="text-[10px] uppercase tracking-widest text-silver flex items-center gap-1.5">
          <CalendarOff className="h-3 w-3" aria-hidden="true" />
          Time off
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
          className="text-sm text-gold hover:text-gold-bright mt-3 inline-flex items-center gap-1"
        >
          Request or view balance
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </CardContent>
    </Card>
  );
}

const QUICK_LINKS: { to: string; label: string; icon: typeof Clock }[] = [
  { to: '/time-attendance', label: 'My timesheet', icon: Clock },
  { to: '/scheduling', label: 'Schedule & swaps', icon: Timer },
  { to: '/documents', label: 'Documents', icon: DollarSign },
  { to: '/time-off', label: 'Request time off', icon: CalendarOff },
];

function QuickActions() {
  return (
    <section>
      <h2 className="font-display text-xl text-white mb-3">Quick links</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {QUICK_LINKS.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group flex items-center gap-2 px-3 py-3 rounded-md border border-navy-secondary bg-navy hover:border-gold/50 hover:bg-navy/80 transition-colors text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Icon className="h-4 w-4 text-silver group-hover:text-gold transition-colors" aria-hidden="true" />
            <span className="flex-1 truncate">{label}</span>
            <ArrowRight className="h-3.5 w-3.5 text-silver/50 group-hover:text-gold transition-colors" />
          </Link>
        ))}
      </div>
    </section>
  );
}
