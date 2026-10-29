import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { InboxSource, PayrollUpcomingSummary } from '@alto-people/shared';
import { getPayrollUpcoming } from '@/lib/payrollApi';
import { AlarmClock, AlertTriangle, ScrollText, ArrowRight, Banknote, CalendarRange, Check, CheckCircle2, ClipboardCheck, ClockAlert, FileWarning, Inbox, Receipt, Scale, ShieldCheck, TrendingUp, UserCheck, Wallet } from '@/components/ui/icons';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { displayLocale, fmtDateOnly, fmtDateOnlyRange, fmtDateTz, fmtMoney, fmtTimeTz, fmtWeekdayTz } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { CountUpValue } from '@/components/ui/MetricCard';
import { DetailsTable } from '@/components/ui/charts';
import { AGING_COLORS, AgingBar, CashFlowChart, MarginChart } from './financeCharts';
import type { BillingWeek, CashWeek, FinanceOverview, MarginTrend, MarginWeek, PayCycle } from './financeTypes';
import { useTenant } from '@/lib/auth';
import { useInbox } from '@/lib/inboxApi';
import '@/lib/i18n/en/fin';

/**
 * The finance cockpit's working parts — each answers one question the
 * accountant asks every morning:
 *
 *   PayCycleHero      when's payday, and is the period ready to pay?
 *                     (period → hours approved → payroll run → payday)
 *   TodayList         what needs me, in the order it's due?
 *   BillingWeekCard   is last week in Fieldglass before Monday 2 PM, and
 *                     what's approved, with the buyer, or at risk?
 *   MarginTrendCard   what did we bill, what did we pay, what's left —
 *                     week by week?
 *   ReceivablesCard   who owes us, and for how long?
 */

const PT = 'America/Los_Angeles';
const noon = (ymd: string) => `${ymd.slice(0, 10)}T12:00:00Z`;
/** A calendar date ("2026-09-25") as "Sep 25" — the date itself, in no one's zone. */
const md = (ymd: string) => fmtDateTz(noon(ymd), 'UTC');
const wd = (ymd: string) => fmtWeekdayTz(noon(ymd), 'UTC');
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(noon(b)) - Date.parse(noon(a))) / 86_400_000);
const dueWhen = (iso: string) => `${fmtWeekdayTz(iso, PT)} ${fmtDateTz(iso, PT)}, ${fmtTimeTz(iso, PT)} PT`;
function left(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)}d`;
  if (h >= 1) return `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}
/** Hours to one decimal, every time: "1,111.0h of 1,297.9h", never "1,111h of 1,297.9h". */
export const hrs1 = (h: number) => `${h.toLocaleString(displayLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}h`;

/**
 * Why payroll can't run this period, by the SAME gate the Payroll page's
 * "Run payroll" uses (GET /payroll/upcoming: the schedule's people, and
 * hired people on no schedule). The hero once read "Not started — the
 * period is over — ready to run" with a "Run payroll" link while Payroll's
 * button was disabled ("this run would pay no one"; F500 audit 2026-10-26).
 * Null when nothing blocks it, a run exists, or the gate can't be read.
 */
export interface PayrollBlock {
  scheduleId: string;
  scheduleName: string;
  /** Hired people on no pay schedule at all. */
  peopleOnNoSchedule: number;
}

export function payrollBlock(cycle: PayCycle | null | undefined, upcoming: Pick<PayrollUpcomingSummary, 'bySchedule' | 'peopleOnNoSchedule'> | null | undefined): PayrollBlock | null {
  if (!cycle || cycle.run || !upcoming) return null;
  const rows = upcoming.bySchedule ?? [];
  const row = rows.find((r) => r.periodStart === cycle.periodStart && r.periodEnd === cycle.periodEnd) ?? (rows.length === 1 ? rows[0] : null);
  if (!row || row.people > 0 || row.draftRunId) return null;
  return { scheduleId: row.scheduleId, scheduleName: row.scheduleName, peopleOnNoSchedule: upcoming.peopleOnNoSchedule ?? 0 };
}

/** The payroll gate's read — the same query (and cache) as the Payroll page's hero. */
export function usePayrollBlock(cycle: PayCycle | null | undefined): PayrollBlock | null {
  const upcoming = useQuery({ queryKey: ['payroll', 'upcoming'], queryFn: () => getPayrollUpcoming(), retry: false, staleTime: 60_000, enabled: !!cycle && !cycle.run });
  return payrollBlock(cycle, upcoming.data);
}

/** How late the oldest money is: "oldest 48 days past due", or "not yet due" (it read "oldest -11d past due"). */
export const oldestText = (t: ReturnType<typeof useI18n>['t'], days: number) => (days <= 0 ? t('fin.arNotDue') : t('fin.arOldest', { count: days }));

/**
 * The "Billed at contract rates" tile's hint (deep audit 2026-10-29
 * MONEY-20): once the week is on finalized statements, their figure — what
 * Books and receivables carry — rides beside it, with why they differ (each
 * shift's own rate and the overtime split, against one rate per person-week).
 */
export function revenueHint(t: ReturnType<typeof useI18n>['t'], w: MarginWeek): string {
  const head = t('fin.kpiRevenueHint', { hours: hrs1(w.hours - w.unpricedHours) });
  if (w.billedOnStatements != null) {
    return Math.abs(w.billedOnStatements - w.revenue) >= 0.005
      ? `${head} · ${t('fin.kpiRevenueOnStatements', { amount: fmtMoney(w.billedOnStatements) })}`
      : `${head} · ${t('fin.kpiRevenueStatementsMatch')}`;
  }
  return w.inProgress ? head : `${head} · ${t('fin.kpiRevenueNotBilled')}`;
}

/** Re-render every minute — countdowns stay honest without a refetch. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/* ------------------------------------------------------------------ */
/* Pay cycle                                                           */
/* ------------------------------------------------------------------ */

type StepState = 'done' | 'current' | 'todo' | 'warn';

function Step({ state, label, value, sub, children, className }: { state: StepState; label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <li className={cn('relative min-w-0 flex-1', className)}>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'grid h-6 w-6 shrink-0 place-items-center rounded-full border',
            state === 'done' && 'border-success/60 bg-success/15 text-success',
            state === 'current' && 'border-gold/70 bg-gold/15 text-gold',
            state === 'warn' && 'border-warning/70 bg-warning/15 text-warning',
            state === 'todo' && 'border-navy-secondary text-silver/50',
          )}
          aria-hidden="true"
        >
          {state === 'done' ? <Check className="h-3.5 w-3.5" /> : state === 'warn' ? <AlertTriangle className="h-3 w-3" /> : <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />}
        </span>
        <span className="text-2xs font-semibold uppercase tracking-wider text-silver/70">{label}</span>
      </div>
      <div className="mt-1.5 pl-8 text-sm font-semibold tabular-nums text-white">{value}</div>
      {sub && <div className="pl-8 text-xs text-silver tabular-nums">{sub}</div>}
      {children && <div className="pl-8">{children}</div>}
    </li>
  );
}

function Bar({ pct, tone = 'bg-gold' }: { pct: number; tone?: string }) {
  return (
    <div className="mt-1.5 h-1.5 w-full max-w-[10rem] overflow-hidden rounded-full bg-navy-secondary/70" aria-hidden="true">
      <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function PayCycleHero({ data }: { data: FinanceOverview }) {
  const { t } = useI18n();
  const payday = data.payday.next;
  const cycle = data.payCycle ?? null;
  const today = todayYmd();
  const daysToPayday = payday ? Math.max(0, daysBetween(today, payday.date.slice(0, 10))) : null;
  // People went unpaid: said at the top of the hero, not only in the list
  // under it — the cycle below can look calm while two paydays passed.
  const inbox = useInbox();
  const missed = inbox.data?.sources?.find((src) => src.key === 'payroll-missed-paydays');
  // Hours waiting from periods before this one (the close chase counts them all).
  // Only time worked BEFORE the paying period is "from earlier periods" (MONEY-7) — the API counts it;
  // everything pending minus the period also took in the next period's hours.
  const earlierPending = cycle?.hours.pendingBefore ?? 0;
  const block = usePayrollBlock(cycle);
  const fixTo = block ? `/payroll/schedules/${block.scheduleId}` : null;
  const booked = !!data.cash?.opening && data.cash.opening.onFile !== false;

  return (
    <Card className="relative h-full overflow-hidden border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]"
      />
      <CardContent className="relative flex h-full flex-col">
        {missed && missed.count > 0 && (
          <Link
            to={fixTo ?? missed.path}
            data-testid="missed-paydays"
            className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm font-medium text-alert hover:bg-alert/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{t('fin.missedLine', { count: missed.count })}</span>
            <span className="inline-flex shrink-0 items-center gap-1 underline underline-offset-2">
              {/* Blocked, the way out is the schedule, not a run that can't start. */}
              {block ? t('fin.missedFix') : t('fin.missedRun', { count: missed.count })}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </Link>
        )}
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
          <Banknote className="h-3.5 w-3.5" aria-hidden="true" />
          {t('fin.payday')}
        </span>
        {payday ? (
          <>
            <div className="mt-2 text-4xl font-bold tracking-tight tabular-nums text-white md:text-5xl">{fmtDateOnly(payday.date, { weekday: true, year: 'auto' })}</div>
            <p className="mt-1.5 text-sm text-silver tabular-nums">
              <span className="font-semibold text-gold">
                {daysToPayday === 0 ? t('fin.paydayToday') : daysToPayday === 1 ? t('fin.paydayTomorrow') : t('fin.paydayIn', { days: daysToPayday ?? 0 })}
              </span>
              <span className="text-silver/60"> · {payday.schedule}</span>
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-silver">{t('fin.paydayNone')}</p>
        )}

        {cycle && <PayCycleSteps cycle={cycle} today={today} earlierPending={earlierPending} block={block} />}

        {/* On a phone the hero is the payday line and the two steps that need
            someone; the cash line and last payday are on the cards below. */}
        {data.cash && data.cash.weeks.length > 0 && <CashLine weeks={data.cash.weeks} booked={booked} />}

        {data.payday.lastDisbursed && (
          <p className="mt-auto hidden pt-4 text-xs text-silver/60 tabular-nums sm:block">
            {t('fin.lastPay', {
              gross: fmtMoney(data.payday.lastDisbursed.totalGross),
              date: fmtDateOnly(data.payday.lastDisbursed.periodEnd, { year: 'auto' }),
            })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PayCycleSteps({ cycle, today, earlierPending = 0, block = null }: { cycle: PayCycle; today: string; earlierPending?: number; block?: PayrollBlock | null }) {
  const { t } = useI18n();
  const periodDays = daysBetween(cycle.periodStart, cycle.periodEnd) + 1;
  const periodOver = today > cycle.periodEnd;
  const day = Math.min(periodDays, Math.max(1, daysBetween(cycle.periodStart, today) + 1));
  const total = cycle.hours.approved + cycle.hours.pending;
  const approvedPct = total > 0 ? (cycle.hours.approved / total) * 100 : 0;
  const run = cycle.run;
  const paid = run?.status === 'DISBURSED';

  const hoursState: StepState = cycle.hours.pending === 0 ? (periodOver ? 'done' : 'current') : periodOver ? 'warn' : 'current';
  const runState: StepState = block && periodOver ? 'warn' : !run ? (periodOver ? 'current' : 'todo') : run.status === 'DRAFT' ? 'current' : 'done';

  return (
    <ol className="mt-5 grid grid-cols-2 gap-x-3 gap-y-4 border-t border-gold/20 pt-4 md:flex md:gap-3" aria-label={t('fin.cycle.title')}>
      <Step
        className="hidden md:block"
        state={periodOver ? 'done' : 'current'}
        label={t('fin.cycle.period')}
        value={fmtDateOnlyRange(cycle.periodStart, cycle.periodEnd)}
        sub={periodOver ? t('fin.cycle.ended', { date: `${wd(cycle.periodEnd)} ${md(cycle.periodEnd)}` }) : t('fin.cycle.dayOf', { day, days: periodDays })}
      >
        {!periodOver && <Bar pct={(day / periodDays) * 100} />}
      </Step>
      <Step
        state={total === 0 ? (earlierPending > 0 ? 'warn' : 'todo') : hoursState}
        label={t('fin.cycle.hours')}
        value={
          total === 0 ? (
            // Honest zero: "0h of 0h · all approved" read as done.
            <span className="font-normal text-silver">{t('fin.cycle.hoursNone')}</span>
          ) : (
            t('fin.cycle.hoursOf', { approved: hrs1(cycle.hours.approved), total: hrs1(total) })
          )
        }
        sub={
          total === 0 ? undefined : cycle.hours.pending > 0 ? (
            <span className={cn(periodOver && 'text-warning')}>{t('fin.cycle.hoursWaiting', { hours: hrs1(cycle.hours.pending) })}</span>
          ) : (
            t('fin.cycle.hoursAll')
          )
        }
      >
        {total > 0 && <Bar pct={approvedPct} tone={cycle.hours.pending > 0 && periodOver ? 'bg-warning' : 'bg-success'} />}
        {earlierPending > 0 && (
          <Link
            to="/timesheets"
            data-testid="hours-earlier"
            className="mt-1 inline-block text-xs tabular-nums text-warning underline underline-offset-2 hover:text-gold-bright"
          >
            {t('fin.cycle.hoursEarlier', { hours: hrs1(earlierPending) })}
          </Link>
        )}
      </Step>
      <Step
        state={runState}
        label={t('fin.runLabel')}
        value={
          run ? (
            <span className={cn(run.status === 'FINALIZED' && 'text-gold-bright')}>
              <CountUpValue value={fmtMoney(run.totalGross)} />
            </span>
          ) : block ? (
            <span className="text-warning">{t('fin.cycle.runBlocked')}</span>
          ) : (
            <span className="text-silver">{t('fin.cycle.runNone')}</span>
          )
        }
        sub={
          run
            ? t(`fin.status.${run.status}` as MessageKey)
            : block
              ? // The blocker, said where "ready to run" used to be.
                block.peopleOnNoSchedule > 0
                ? t('fin.cycle.noSchedule', { count: block.peopleOnNoSchedule })
                : t('fin.cycle.runBlockedEmpty', { schedule: block.scheduleName })
              : periodOver
                ? t('fin.cycle.runReady')
                : t('fin.cycle.runAfter', { date: md(cycle.periodEnd) })
        }
      >
        <Link
          to={run ? `/payroll/runs/${run.id}/close` : block ? `/payroll/schedules/${block.scheduleId}` : '/payroll'}
          data-testid="hero-run-link"
          className="mt-1 inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright"
        >
          {run ? t('fin.guidedClose') : block ? (block.peopleOnNoSchedule > 0 ? t('fin.cycle.fix') : t('fin.cycle.addPeople')) : t('fin.goPayroll')}
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </Step>
      {/* The headline already says when payday is; this step says only whether it's paid. */}
      <Step
        className="hidden md:block"
        state={paid ? 'done' : 'todo'}
        label={t('fin.cycle.paidStep')}
        value={paid ? t('fin.cycle.paidOn', { date: `${wd(cycle.payDate)}, ${md(cycle.payDate)}` }) : <span className="font-normal text-silver">{t('fin.cycle.notPaid')}</span>}
      />
    </ol>
  );
}

/**
 * The hero's one line about money moving: the next four weeks, net, with the
 * low point — the low point only against a real bank balance. With none on
 * file the running total starts at $0, and its "low point" of −$15.9k read
 * as an overdraft (F500 audit 2026-10-26).
 */
function CashLine({ weeks, booked }: { weeks: CashWeek[]; booked: boolean }) {
  const { t } = useI18n();
  const net = weeks.reduce((s, w) => s + w.net, 0);
  const low = booked ? Math.min(...weeks.map((w) => w.balance ?? w.cumulative)) : 0;
  return (
    <Link
      to="/finance/cash-forecast"
      className="mt-4 hidden flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-gold/20 pt-3 text-xs tabular-nums text-silver hover:text-gold sm:flex"
    >
      <span className="flex items-center gap-1.5 font-medium uppercase tracking-wider text-gold">
        <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
        {t('fin.cashTitle')}
      </span>
      <span>
        {t('fin.cashNet')}{' '}
        <span className="font-semibold text-ink">{fmtMoney(net)}</span>
      </span>
      {low < 0 && (
        <span>
          {t('fin.cashLow')} <span className="font-semibold text-alert">{fmtMoney(low)}</span>
        </span>
      )}
      <ArrowRight className="h-3 w-3" aria-hidden="true" />
    </Link>
  );
}

/** Four weeks of cash, as bars in and out with the running total. */
export function CashForecastCard({ cash }: { cash: FinanceOverview['cash'] }) {
  const { t } = useI18n();
  if (!cash) return null;
  // A balance line only from a real balance: with none on file the line started at
  // $0 and its "low point" looked like an overdraft (F500 audit 2026-10-26).
  const booked = !!cash.opening && cash.opening.onFile !== false;
  return (
    <Card className="animate-enter" style={enterStagger(5)}>
      <CardContent>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <TrendingUp className="h-4 w-4 text-gold" aria-hidden="true" />
            {t('fin.cashTitle')}
          </h3>
          <Link to="/finance/cash-forecast" className="inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright">
            {t('fin.cashOpen')}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
        <p className="mt-1 text-xs text-silver">{t('fin.cashSub')}</p>
        {!booked ? (
          <p className="mt-2 text-sm text-silver" data-testid="cash-no-balance">
            {t('fin.cashAddBalance')}{' '}
            <Link to="/books/accounts" className="text-gold underline underline-offset-2 hover:text-gold-bright">
              {t('fin.cashSet')}
            </Link>
          </p>
        ) : cash.opening && (
          <p className="mt-2 text-sm text-ink tabular-nums">
            {t('fin.cashToday', { amount: fmtMoney(cash.opening.balance) })}
            {cash.lowest && (
              <span className={cn('ml-2 text-xs', cash.lowest.belowMinimum || cash.lowest.balance < 0 ? 'text-alert' : 'text-silver')}>
                {t('fin.cashLowAt', { amount: fmtMoney(cash.lowest.balance), date: md(cash.lowest.weekStart) })}
              </span>
            )}
          </p>
        )}
        {/* An overdrawn account, which "Cash today" nets away (MONEY-18). */}
        {booked &&
          (cash.opening?.overdrawn ?? []).map((a) => (
            <p key={a.id} className="mt-1 flex items-center gap-1.5 text-xs text-alert" data-testid="cash-overdrawn">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <Link to={`/books/accounts/${a.id}`} className="underline underline-offset-2">
                {t('fin.cashOverdrawn', { account: a.name, amount: fmtMoney(-a.balance) })}
              </Link>
            </p>
          ))}
        {cash.weeks.every((w) => w.inflow === 0 && w.outflow === 0) ? (
          <p className="mt-3 text-sm text-silver">{t('fin.cashEmpty')}</p>
        ) : (
          <>
            <div
              role="img"
              aria-label={`${t('fin.cashTitle')}: ${cash.weeks.map((w) => `${md(w.weekStart)} ${t('fin.cashIn')} ${fmtMoney(w.inflow)}, ${t('fin.cashOut')} ${fmtMoney(w.outflow)}${booked ? `, ${t('fin.cashBalance')} ${fmtMoney(w.balance ?? w.cumulative)}` : ''}`).join('; ')}`}
              className="mt-3 h-40"
            >
              <CashFlowChart weeks={cash.weeks} compact withBalance={booked} line={booked} minimumCash={booked ? (cash.minimumCash ?? null) : null} />
            </div>
            <DetailsTable
              label={t('fin.cashDetails')}
              columns={[t('fin.cashWeekCol'), t('fin.cashIn'), t('fin.cashOut'), booked ? t('fin.cashBalance') : t('fin.cashNet')]}
              rows={cash.weeks.map((w) => [md(w.weekStart), fmtMoney(w.inflow), fmtMoney(w.outflow), fmtMoney(booked ? (w.balance ?? w.cumulative) : w.net)])}
            />
          </>
        )}
        <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-navy-secondary bg-navy-secondary/60 text-center">
          {/* Money is ink: more out than in over four weeks is a fact, not an alarm. */}
          <Money label={t('fin.cashIn')} value={cash.totals.inflow} tone="text-ink" />
          <Money label={t('fin.cashOut')} value={cash.totals.outflow} tone="text-ink" />
          <Money label={t('fin.cashNet')} value={cash.totals.net} tone="text-ink" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Today                                                               */
/* ------------------------------------------------------------------ */

export interface FinanceTask {
  key: string;
  tone: 'alert' | 'warning' | 'gold' | 'silver';
  icon: ComponentType<{ className?: string }>;
  title: string;
  sub?: string;
  to: string;
}

/** Everything waiting on finance, most urgent first. */
export function financeTasks(
  data: FinanceOverview,
  t: ReturnType<typeof useI18n>['t'],
  now: number,
  // Client statements and receivables exist only where there are clients
  // to bill (clientPortal + billRates); a direct employer never sees them.
  // `inbox`: the /me/inbox sources, so a queue the Inbox counts (paydays
  // that passed with no run) is the same item here, with the same link.
  // `block`: payroll can't run this period (usePayrollBlock) — the run task names the fix.
  opts: { statements?: boolean; inbox?: ReadonlyArray<Pick<InboxSource, 'key' | 'count' | 'description' | 'path'>>; block?: PayrollBlock | null } = {},
): FinanceTask[] {
  const statements = opts.statements ?? true;
  const tasks: Array<FinanceTask & { rank: number }> = [];
  // People went unpaid: the most urgent thing on the list.
  const missed = opts.inbox?.find((src) => src.key === 'payroll-missed-paydays');
  if (missed && missed.count > 0) {
    tasks.push({
      key: 'missed',
      rank: 0,
      tone: 'alert',
      icon: AlertTriangle,
      title: t('fin.task.missed', { count: missed.count }),
      sub: missed.description,
      to: missed.path,
    });
  }
  const b = data.billing;
  // Rejected ones are the resubmit task's, not this one's.
  const toEnter = b ? b.toEnter - b.rejected : 0;
  if (b && toEnter > 0) {
    const toGo = Date.parse(b.dueAt) - now;
    const late = toGo <= 0;
    tasks.push({
      key: 'enter',
      rank: late ? 0 : toGo < 24 * 3_600_000 ? 1 : 3,
      tone: late ? 'alert' : toGo < 24 * 3_600_000 ? 'warning' : 'gold',
      icon: AlarmClock,
      title: t('fin.task.enter', { count: toEnter }),
      sub: late ? t('fin.task.enterLate', { when: dueWhen(b.dueAt) }) : t('fin.task.enterDue', { when: dueWhen(b.dueAt) }),
      to: `/time-attendance/timesheets?week=${b.weekStart}`,
    });
  }
  const rejected = (b?.rejectedOpen.count ?? 0) + (b?.rejected ?? 0);
  if (rejected > 0) {
    tasks.push({
      key: 'resubmit',
      rank: 2,
      tone: 'alert',
      icon: FileWarning,
      title: t('fin.task.resubmit', { count: rejected }),
      sub: b?.rejectedOpen.amount ? t('fin.task.resubmitSub', { amount: fmtMoney(b.rejectedOpen.amount) }) : undefined,
      to: b ? `/time-attendance/timesheets?week=${b.weekStart}` : '/time-attendance/timesheets',
    });
  }
  const queue = data.fieldglassQueueTotal ?? data.fieldglassQueue.length;
  if (queue > 0) {
    const unbilled = data.fieldglassQueue.reduce((s, r) => s + (r.hoursUnbilled ?? 0), 0);
    tasks.push({
      key: 'register',
      rank: unbilled > 0 ? 2 : 5,
      tone: unbilled > 0 ? 'alert' : 'gold',
      icon: UserCheck,
      title: t('fin.task.register', { count: queue }),
      sub: unbilled > 0 ? t('fin.task.registerSub', { hours: hrs1(unbilled) }) : t('fin.task.registerSubNone'),
      to: '/fieldglass',
    });
  }
  const cycle = data.payCycle;
  if (cycle) {
    const periodOver = todayYmd() > cycle.periodEnd;
    const daysToPay = daysBetween(todayYmd(), cycle.payDate);
    const sub = t('fin.task.runSub', { start: md(cycle.periodStart), end: md(cycle.periodEnd), date: `${wd(cycle.payDate)} ${md(cycle.payDate)}` });
    const block = opts.block ?? null;
    if (periodOver && !cycle.run && block) {
      tasks.push({
        key: 'run',
        rank: daysToPay <= 3 ? 1 : 3,
        tone: 'warning',
        icon: Wallet,
        title: t('fin.task.runBlocked'),
        sub: block.peopleOnNoSchedule > 0 ? t('fin.task.runBlockedSub', { count: block.peopleOnNoSchedule }) : t('fin.task.runBlockedEmpty', { schedule: block.scheduleName }),
        to: `/payroll/schedules/${block.scheduleId}`,
      });
    } else if (periodOver && !cycle.run) {
      tasks.push({ key: 'run', rank: daysToPay <= 3 ? 1 : 4, tone: daysToPay <= 3 ? 'warning' : 'gold', icon: Wallet, title: t('fin.task.runStart'), sub, to: '/payroll' });
    } else if (cycle.run?.status === 'DRAFT' && periodOver) {
      tasks.push({ key: 'run', rank: daysToPay <= 3 ? 1 : 4, tone: daysToPay <= 3 ? 'warning' : 'gold', icon: Wallet, title: t('fin.task.runFinalize'), sub, to: '/payroll' });
    } else if (cycle.run?.status === 'FINALIZED') {
      tasks.push({ key: 'run', rank: daysToPay <= 1 ? 0 : 3, tone: daysToPay <= 1 ? 'alert' : 'gold', icon: Wallet, title: t('fin.task.runDisburse'), sub, to: '/payroll' });
    }
  }
  if (data.close.pendingEntries > 0) {
    tasks.push({
      key: 'chase',
      rank: 4,
      tone: 'warning',
      icon: ClockAlert,
      title: t('fin.task.chase', { hours: hrs1(data.close.pendingHours) }),
      sub: data.close.oldestDay
        ? t('fin.task.chaseSub', { count: data.close.pendingEntries, date: fmtDateOnly(data.close.oldestDay, { year: 'auto' }) })
        : undefined,
      to: '/timesheets',
    });
  }
  const aging = data.receivables.aging;
  // Past due = everything but "not yet due" (lib/books/aging, the one definition).
  const pastDue = aging ? aging.days1to30 + aging.days31to60 + aging.days61to90 + aging.over90 : 0;
  if (statements && pastDue > 0) {
    tasks.push({
      key: 'collect',
      rank: 5,
      tone: aging && aging.over90 > 0 ? 'alert' : 'warning',
      icon: Scale,
      title: t('fin.task.collect', { amount: fmtMoney(pastDue) }),
      sub: data.receivables.oldestDays !== null ? oldestText(t, data.receivables.oldestDays) : undefined,
      to: '/clients/statements',
    });
  }
  if (data.settlements.count > 0) {
    tasks.push({
      key: 'settle',
      rank: 6,
      tone: 'gold',
      icon: Receipt,
      title: t('fin.task.settle', { count: data.settlements.count }),
      sub: fmtMoney(data.settlements.total),
      to: '/reimbursements',
    });
  }
  if (statements && data.receivables.draftStatements > 0) {
    tasks.push({
      key: 'statements',
      rank: 6,
      tone: 'gold',
      icon: ClipboardCheck,
      title: t('fin.task.statements', { count: data.receivables.draftStatements }),
      to: '/clients/statements',
    });
  }
  // Finance's hold queue: payroll won't pay into these accounts until
  // someone calls the number that was on file.
  const fc = data.financialChanges;
  if (fc && fc.open > 0) {
    tasks.push({
      key: 'verify',
      rank: fc.held > 0 ? 1 : 3,
      tone: fc.held > 0 ? 'alert' : 'warning',
      icon: ShieldCheck,
      title: t('fin.task.verify', { count: fc.open }),
      sub: t('fin.task.verifySub', { held: fc.held }),
      to: '/payroll/financial-changes',
    });
  }
  if (data.payrollCases.assignedToMe > 0) {
    tasks.push({
      key: 'cases',
      rank: 5,
      tone: 'warning',
      icon: Inbox,
      title: t('fin.task.cases', { count: data.payrollCases.assignedToMe }),
      to: '/hr-cases',
    });
  }
  return tasks.sort((a, b2) => a.rank - b2.rank).map(({ rank: _rank, ...task }) => task);
}

const TONE: Record<FinanceTask['tone'], string> = {
  alert: 'text-alert',
  warning: 'text-warning',
  gold: 'text-gold',
  silver: 'text-silver',
};

/** `headless`: the home titles the section ("Needs you"); the card keeps only its list. */
export function TodayList({ data, headless = false }: { data: FinanceOverview; headless?: boolean }) {
  const { t } = useI18n();
  const tenant = useTenant();
  const now = useNow();
  const inbox = useInbox();
  const block = usePayrollBlock(data.payCycle);
  const tasks = financeTasks(data, t, now, { statements: tenant.moduleOn('clientPortal') && tenant.moduleOn('billRates'), inbox: inbox.data?.sources, block });
  return (
    <Card className="animate-enter" style={enterStagger(1)}>
      <CardContent>
        {!headless && (
          <h2 className="flex items-baseline justify-between gap-2 text-sm font-medium text-white">
            {t('fin.today')}
            <span className="text-xs font-normal text-silver/60">{tasks.length > 0 ? t('fin.todaySub') : null}</span>
          </h2>
        )}
        {tasks.length === 0 ? (
          <p className={headless ? 'flex items-center gap-2 text-sm text-success' : 'mt-4 flex items-center gap-2 text-sm text-success'}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {t('fin.todayClear')}
          </p>
        ) : (
          <ul className={headless ? 'divide-y divide-navy-secondary/60' : 'mt-3 divide-y divide-navy-secondary/60'} aria-label={t('fin.today')}>
            {tasks.map((task) => {
              const Icon = task.icon;
              return (
                <li key={task.key}>
                  <Link
                    to={task.to}
                    className="group -mx-2 flex items-start gap-2.5 rounded-md px-2 py-2.5 hover:bg-navy-secondary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                  >
                    <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE[task.tone])} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-white">{task.title}</span>
                      {task.sub && <span className={cn('block text-xs tabular-nums', task.tone === 'alert' ? 'text-alert' : 'text-silver')}>{task.sub}</span>}
                    </span>
                    <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-silver/50 group-hover:text-gold" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Billing — last week in Fieldglass                                   */
/* ------------------------------------------------------------------ */

function Money({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="bg-navy px-2 py-2">
      <div className={cn('text-base font-semibold tabular-nums', tone)}>{fmtMoney(value)}</div>
      <div className="text-2xs uppercase tracking-wider text-silver/70">{label}</div>
    </div>
  );
}

function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={cn('rounded-full border px-2 py-0.5 text-2xs font-medium tabular-nums', tone)}>{children}</span>;
}

export function BillingWeekCard({ billing }: { billing: BillingWeek | null | undefined }) {
  const { t } = useI18n();
  const now = useNow();
  if (!billing) return null;
  const toGo = Date.parse(billing.dueAt) - now;
  const late = toGo <= 0 && billing.toEnter > 0;
  const closed = toGo <= 0 && billing.toEnter === 0;
  const pct = billing.registered > 0 ? Math.round((billing.entered / billing.registered) * 100) : 0;
  return (
    <Card className={cn('animate-enter', late && 'border-alert/40')} style={enterStagger(3)}>
      <CardContent className="flex flex-col">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-white">{t('fin.billTitle', { date: fmtDateOnly(billing.weekEnding, { weekday: true, year: false }) })}</h2>
          <Link to={`/time-attendance/timesheets?week=${billing.weekStart}`} className="inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright">
            {t('fin.billOpen')}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
        {billing.workers === 0 ? (
          <p className="mt-3 text-sm text-silver">{t('fin.billNone')}</p>
        ) : (
          <>
            <p className={cn('mt-2 flex items-start gap-1.5 text-sm', late ? 'font-medium text-alert' : closed ? 'text-silver' : toGo < 12 * 3_600_000 ? 'font-medium text-warning' : 'text-white')}>
              <AlarmClock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {late
                  ? t('fin.billLate', { when: dueWhen(billing.dueAt) })
                  : closed
                    ? t('fin.billClosed', { when: dueWhen(billing.dueAt) })
                    : t('fin.billDue', { when: dueWhen(billing.dueAt) })}
                {!late && !closed && <span className="font-normal text-silver"> · {t('fin.billLeft', { left: left(toGo) })}</span>}
              </span>
            </p>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-navy-secondary" aria-hidden="true">
                <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs tabular-nums text-silver">{t('fin.billEntered', { entered: billing.entered, registered: billing.registered })}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {billing.approved > 0 && <Chip tone="border-success/30 bg-success/15 text-success">{t('fin.billChipApproved', { count: billing.approved })}</Chip>}
              {billing.submitted > 0 && <Chip tone="border-steel/40 bg-steel/15 text-sky">{t('fin.billChipSubmitted', { count: billing.submitted })}</Chip>}
              {billing.rejected > 0 && <Chip tone="border-alert/30 bg-alert/15 text-alert">{t('fin.billChipRejected', { count: billing.rejected })}</Chip>}
              {billing.notRegistered > 0 && <Chip tone="border-alert/30 bg-alert/15 text-alert">{t('fin.billChipNotIn', { count: billing.notRegistered })}</Chip>}
              {billing.variances > 0 && <Chip tone="border-warning/30 bg-warning/15 text-warning">{t('fin.billChipDiffer', { count: billing.variances })}</Chip>}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-navy-secondary bg-navy-secondary/60 text-center">
              {/* A zero wears no status colour (a green "$0.00 approved" read as good news). */}
              <Money label={t('fin.billApproved')} value={billing.money.approved} tone={billing.money.approved > 0 ? 'text-success' : 'text-ink-muted'} />
              <Money label={t('fin.billAwaiting')} value={billing.money.awaiting} tone={billing.money.awaiting > 0 ? 'text-ink' : 'text-ink-muted'} />
              <Money label={t('fin.billAtRisk')} value={billing.money.atRisk} tone={billing.money.atRisk > 0 ? 'text-alert' : 'text-ink-muted'} />
            </div>
          </>
        )}
        {billing.rejectedOpen.count > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-alert">
            <FileWarning className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('fin.billOlderRejected', { count: billing.rejectedOpen.count, amount: fmtMoney(billing.rejectedOpen.amount) })}
          </p>
        )}
        {billing.unpricedHours > 0 && <p className="mt-1.5 text-2xs text-silver/70">{t('fin.billUnpriced', { hours: hrs1(billing.unpricedHours) })}</p>}
        <div className="flex flex-wrap gap-2 pt-4">
          <Button asChild size="sm" variant={billing.toEnter > 0 ? 'primary' : 'secondary'}>
            <Link to={`/time-attendance/timesheets?week=${billing.weekStart}`}>
              <ClipboardCheck className="h-3.5 w-3.5" />
              {billing.toEnter > 0 ? t('fin.billEnter', { count: billing.toEnter }) : t('fin.billOpen')}
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to="/fieldglass">
              <UserCheck className="h-3.5 w-3.5" />
              {t('fin.fgButton')}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Revenue, wages & margin                                             */
/* ------------------------------------------------------------------ */

export function MarginTrendCard({ margin }: { margin: MarginTrend | null | undefined }) {
  const { t } = useI18n();
  if (!margin) return null;
  const weeks = margin.weeks;
  const any = weeks.some((w) => w.hours > 0);
  const done = weeks.filter((w) => !w.inProgress);
  const totals = done.reduce((s, w) => ({ revenue: s.revenue + w.revenue, wages: s.wages + w.wages }), { revenue: 0, wages: 0 });
  const totalMargin = totals.revenue - totals.wages;
  const unpriced = weeks.reduce((s, w) => s + w.unpricedHours, 0);
  return (
    <Card className="animate-enter" style={enterStagger(4)}>
      <CardContent>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-white">{t('fin.marginTitle')}</h2>
          <span className="text-xs text-silver/60">{t('fin.marginSub', { weeks: weeks.length })}</span>
        </div>
        {!any ? (
          <p className="mt-3 text-sm text-silver">{t('fin.marginEmpty')}</p>
        ) : (
          <>
            <div
              role="img"
              aria-label={`${t('fin.marginTitle')}: ${weeks
                .map(
                  (w) =>
                    `${md(w.weekEnd)}: ${t('fin.marginRevenue')} ${fmtMoney(w.revenue)} · ${t('fin.marginWages')} ${fmtMoney(w.wages)}${
                      w.marginPct !== null ? ` · ${t('fin.marginMargin')} ${Math.round(w.marginPct * 100)}%` : ''
                    }${w.inProgress ? ` (${t('fin.marginSoFar')})` : ''}`,
                )
                .join('; ')}`}
              className="mt-2 h-44"
            >
              <MarginChart weeks={weeks} words={{ revenue: t('fin.marginRevenue'), wages: t('fin.marginWages'), soFar: t('fin.marginSoFar') }} />
            </div>
            <DetailsTable
              label={t('fin.cashDetails')}
              columns={[t('fin.cashWeekCol'), t('fin.marginRevenue'), t('fin.marginWages'), t('fin.marginMargin')]}
              rows={weeks.map((w) => [w.inProgress ? t('fin.marginSoFar') : md(w.weekEnd), fmtMoney(w.revenue), fmtMoney(w.wages), w.marginPct === null ? '—' : `${Math.round(w.marginPct * 100)}%`])}
            />
            <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-navy-secondary bg-navy-secondary/60 text-center">
              <Money label={t('fin.marginRevenue')} value={totals.revenue} tone="text-ink" />
              <Money label={t('fin.marginWages')} value={totals.wages} tone="text-ink" />
              <Money label={t('fin.marginMargin')} value={totalMargin} tone={totalMargin < 0 ? 'text-alert' : 'text-ink'} />
            </div>
            <p className="mt-1.5 text-2xs text-silver/70">
              {t('fin.marginTotal', { weeks: done.length })}
              {totals.revenue > 0 && ` · ${Math.round((totalMargin / totals.revenue) * 100)}% ${t('fin.marginMargin').toLowerCase()}`} · {t('fin.marginNote')}
            </p>
          </>
        )}
        {margin.defaultRateAssociates > 0 && (
          <Link to="/compensation" className="mt-2 flex items-center gap-1.5 text-xs text-warning hover:underline">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('fin.marginDefault', { count: margin.defaultRateAssociates, rate: fmtMoney(margin.defaultRate) })}
          </Link>
        )}
        <Link to="/compensation?tab=changes" className="mt-2 flex items-center gap-1.5 text-xs text-gold underline underline-offset-2 hover:text-gold-bright">
          <ScrollText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t('fin.payChanges')}
        </Link>
        {unpriced > 0 && (
          <Link to="/clients" className="mt-1 flex items-center gap-1.5 text-xs text-silver hover:underline">
            <CalendarRange className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('fin.marginUnpriced', { hours: hrs1(unpriced) })}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Receivables                                                         */
/* ------------------------------------------------------------------ */

export function ReceivablesCard({ receivables }: { receivables: FinanceOverview['receivables'] }) {
  const { t } = useI18n();
  const aging = receivables.aging ?? { current: receivables.outstandingTotal, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
  // The total shown is the sum of its buckets — one source (GET /finance/overview reads the Books aging).
  const total = aging.current + aging.days1to30 + aging.days31to60 + aging.days61to90 + aging.over90;
  // The swatches are the bar's own colours (financeCharts' AGING_COLORS), the same in both themes.
  const buckets: Array<{ key: keyof typeof aging; label: string; amount: number }> = [
    { key: 'current', label: t('fin.arCurrent'), amount: aging.current },
    { key: 'days1to30', label: t('fin.ar1'), amount: aging.days1to30 },
    { key: 'days31to60', label: t('fin.ar31'), amount: aging.days31to60 },
    { key: 'days61to90', label: t('fin.ar61'), amount: aging.days61to90 },
    { key: 'over90', label: t('fin.ar91'), amount: aging.over90 },
  ];
  return (
    <Card className="animate-enter" style={enterStagger(6)} data-testid="receivables-card">
      <CardContent>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
            <Scale className="h-4 w-4 text-gold" aria-hidden="true" />
            {t('fin.receivables')}
          </h2>
          <Link to="/clients/statements" className="inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright">
            {t('fin.goStatements')}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
        {total <= 0 ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {t('fin.arClean')}
          </p>
        ) : (
          <>
            <div className="mt-2 font-display text-3xl tabular-nums text-white">{fmtMoney(total)}</div>
            <p className="text-xs text-silver tabular-nums">
              {[
                t('fin.arLine', { count: receivables.outstandingCount }),
                receivables.avgDaysToPay !== null && t('fin.arDso', { count: receivables.avgDaysToPay }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <div className="mt-3" aria-hidden="true">
              <AgingBar buckets={buckets} />
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
              {buckets.map((b) => (
                <div key={b.key}>
                  <dt className="flex items-center gap-1 text-silver/70">
                    <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: AGING_COLORS[b.key] }} aria-hidden="true" />
                    {b.label}
                  </dt>
                  <dd className={cn('tabular-nums', b.amount > 0 ? 'text-white' : 'text-silver/40')}>{fmtMoney(b.amount)}</dd>
                </div>
              ))}
            </dl>
            {(receivables.byClient ?? []).length > 0 && (
              <ul className="mt-3 divide-y divide-navy-secondary/60 border-t border-navy-secondary/60">
                {(receivables.byClient ?? []).map((c) => (
                  <li key={c.clientName} className="flex flex-col gap-0.5 py-1.5 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                    <span className="min-w-0 break-words text-white">{c.clientName}</span>
                    <span className="shrink-0 tabular-nums">
                      <span className="text-white">{fmtMoney(c.amount)}</span>
                      <span className={cn('ml-2 text-xs', c.oldestDays > 60 ? 'text-alert' : c.oldestDays > 30 ? 'text-warning' : 'text-silver/60')}>
                        {oldestText(t, c.oldestDays)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {receivables.draftStatements > 0 && (
          <p className="mt-2 text-xs text-silver">{t('fin.arDrafts', { count: receivables.draftStatements })}</p>
        )}
      </CardContent>
    </Card>
  );
}
