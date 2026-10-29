import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getMyNextPayday } from '@/lib/payrollApi';
import { getDriverToday, type DriverToday } from '@/lib/transportApi';
import type { Earnings } from '@/components/EarningsCard';

/**
 * The driver's pay, the Uber way but honest: drivers are paid by the hour
 * on the clock, not per ride. Everything here comes from the associate
 * earnings engine (apps/api lib/associateEarnings — overtime-aware), as
 * GET /transport/driver/today passes it on; a driver who can also read
 * their own time (/time/me/earnings) or payroll (/payroll/me/next-payday)
 * gets the fuller picture from there. Nothing is invented: a figure the
 * answer doesn't carry is left out, never guessed.
 */

export interface DriverPay {
  /** Today, YYYY-MM-DD (the company calendar). */
  date: string;
  /** The hourly rate; null when none is on file. */
  rate: number | null;
  /** The company's standard rate, not one set for this driver. */
  rateIsDefault: boolean;
  /** What the next minute pays (1.5× once overtime starts, when the engine says so). */
  currentRate: number;
  onClock: boolean;
  /** This punch so far (on the clock only). */
  shift: number | null;
  /** Today so far. */
  today: number;
  /** This week (Sat→Fri) so far. */
  week: number;
  projectedWeek: number;
  weekStart: string;
  weekEnd: string;
  /** Hours on the clock today, and hours of them behind the wheel (runs started → ended). */
  workedToday: number;
  drivenToday: number;
  workedWeek: number;
  overtime: Earnings['overtime'] | null;
  takeHome: Earnings['takeHome'] | null;
  days: Earnings['days'] | null;
  /** YYYY-MM-DD */
  payday: string | null;
}

const cap = (h: number) => Math.min(Math.max(0, h), 16);

export function payFrom(day: DriverToday, full: Earnings | null = null, payday: string | null = null): DriverPay | null {
  const e = day.earnings;
  if (!e) return null;
  const days = full?.days ?? e.days ?? null;
  const rate = e.hourlyRate > 0 ? e.hourlyRate : null;
  const currentRate = full?.currentRatePerHour ?? e.currentRatePerHour ?? e.hourlyRate;
  const fromDays = days?.find((d) => d.date === day.date)?.workedAmount;
  return {
    date: day.date,
    rate,
    rateIsDefault: (e.rateSource ?? (full as { rateSource?: string } | null)?.rateSource) === 'default',
    currentRate,
    onClock: e.onClock,
    shift: e.onClock ? (full?.currentShiftEarned ?? e.currentShiftEarned ?? null) : null,
    // The engine's own day when the answer has it; else today's hours at the rate.
    today: fromDays ?? Math.round(day.hours.worked * currentRate * 100) / 100,
    week: full?.earnedSoFar ?? e.earnedSoFar,
    projectedWeek: full?.projectedWeek ?? e.projectedWeek,
    weekStart: e.weekStart,
    weekEnd: e.weekEnd,
    workedToday: day.hours.worked,
    drivenToday: day.hours.driven,
    workedWeek: full?.workedHours ?? e.workedHours,
    overtime: full?.overtime ?? e.overtime ?? null,
    takeHome: full?.takeHome ?? e.takeHome ?? null,
    days,
    payday: payday ?? day.nextPayday?.payDate ?? null,
  };
}

/** The same figures `seconds` after the server's answer: on the clock, the money moves. */
export function livePay(base: DriverPay, fetchedAt: number, now: number): DriverPay {
  if (!base.onClock) return base;
  const h = cap((now - fetchedAt) / 3_600_000);
  const add = h * base.currentRate;
  return {
    ...base,
    shift: base.shift === null ? null : base.shift + add,
    today: base.today + add,
    week: base.week + add,
    projectedWeek: Math.max(base.projectedWeek, base.week + add),
    workedToday: base.workedToday + h,
    workedWeek: base.workedWeek + h,
  };
}

/** The driver's pay and when it was read — one /driver/today request shared with the rest of the page. */
export function useDriverPay(): { pay: DriverPay | null; fetchedAt: number; day: DriverToday | undefined; loading: boolean } {
  const { can } = useAuth();
  const todayQ = useQuery({ queryKey: ['transport', 'driver', 'today'], queryFn: getDriverToday, refetchInterval: 60_000 });
  const linked = !!todayQ.data?.associateId;
  // The fuller engine answer, for a driver who may read their own time (the associate's card shares it).
  const fullQ = useQuery({
    queryKey: ['me', 'earnings'],
    queryFn: () => apiFetch<Earnings>('/time/me/earnings'),
    enabled: linked && can('view:time'),
    refetchInterval: 60_000,
    retry: false,
  });
  const paydayQ = useQuery({ queryKey: ['payroll', 'me', 'next-payday'], queryFn: getMyNextPayday, enabled: linked && can('view:payroll'), staleTime: 5 * 60_000, retry: false });
  const day = todayQ.data;
  const pay = day?.hours ? payFrom(day, fullQ.data ?? null, paydayQ.data?.nextPayday?.payDate ?? null) : null;
  return { pay, fetchedAt: Math.max(todayQ.dataUpdatedAt, fullQ.dataUpdatedAt), day, loading: todayQ.isLoading };
}
