import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlarmClock,
  AlertTriangle,
  ArrowRight,
  Banknote,
  CalendarRange,
  Check,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  ClockAlert,
  FileWarning,
  Inbox,
  Receipt,
  Scale,
  UserCheck,
  Wallet,
} from 'lucide-react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate, fmtDateTz, fmtHours, fmtMoney, fmtTimeTz, fmtWeekdayTz } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { CountUpValue } from '@/components/ui/MetricCard';
import type { BillingWeek, FinanceOverview, MarginTrend, PayCycle } from './financeTypes';

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

function Step({ state, label, value, sub, children }: { state: StepState; label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative min-w-0 flex-1">
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
          {state === 'done' ? <Check className="h-3.5 w-3.5" /> : state === 'warn' ? <AlertTriangle className="h-3 w-3" /> : <Circle className="h-2 w-2 fill-current" />}
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

  return (
    <Card className="relative h-full overflow-hidden border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]"
      />
      <CardContent className="relative flex h-full flex-col p-5">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
          <Banknote className="h-3.5 w-3.5" aria-hidden="true" />
          {t('fin.payday')}
        </span>
        {payday ? (
          <>
            <div className="mt-2 text-4xl font-bold tracking-tight tabular-nums text-white md:text-5xl">{fmtDate(payday.date)}</div>
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

        {cycle && <PayCycleSteps cycle={cycle} today={today} />}

        {data.payday.lastDisbursed && (
          <p className="mt-auto pt-4 text-xs text-silver/60 tabular-nums">
            {t('fin.lastPay', {
              gross: fmtMoney(data.payday.lastDisbursed.totalGross),
              date: fmtDate(data.payday.lastDisbursed.periodEnd),
            })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PayCycleSteps({ cycle, today }: { cycle: PayCycle; today: string }) {
  const { t } = useI18n();
  const periodDays = daysBetween(cycle.periodStart, cycle.periodEnd) + 1;
  const periodOver = today > cycle.periodEnd;
  const day = Math.min(periodDays, Math.max(1, daysBetween(cycle.periodStart, today) + 1));
  const total = cycle.hours.approved + cycle.hours.pending;
  const approvedPct = total > 0 ? (cycle.hours.approved / total) * 100 : 0;
  const run = cycle.run;
  const paid = run?.status === 'DISBURSED';

  const hoursState: StepState = cycle.hours.pending === 0 ? (periodOver ? 'done' : 'current') : periodOver ? 'warn' : 'current';
  const runState: StepState = !run ? (periodOver ? 'current' : 'todo') : run.status === 'DRAFT' ? 'current' : 'done';

  return (
    <ol className="mt-5 grid grid-cols-2 gap-x-3 gap-y-4 border-t border-gold/20 pt-4 md:flex md:gap-3" aria-label={t('fin.cycle.title')}>
      <Step
        state={periodOver ? 'done' : 'current'}
        label={t('fin.cycle.period')}
        value={`${md(cycle.periodStart)} – ${md(cycle.periodEnd)}`}
        sub={periodOver ? t('fin.cycle.ended', { date: `${wd(cycle.periodEnd)} ${md(cycle.periodEnd)}` }) : t('fin.cycle.dayOf', { day, days: periodDays })}
      >
        {!periodOver && <Bar pct={(day / periodDays) * 100} />}
      </Step>
      <Step
        state={hoursState}
        label={t('fin.cycle.hours')}
        value={t('fin.cycle.hoursOf', { approved: fmtHours(cycle.hours.approved), total: fmtHours(total) })}
        sub={
          cycle.hours.pending > 0 ? (
            <span className={cn(periodOver && 'text-warning')}>{t('fin.cycle.hoursWaiting', { hours: fmtHours(cycle.hours.pending) })}</span>
          ) : (
            t('fin.cycle.hoursAll')
          )
        }
      >
        <Bar pct={approvedPct} tone={cycle.hours.pending > 0 && periodOver ? 'bg-warning' : 'bg-success'} />
      </Step>
      <Step
        state={runState}
        label={t('fin.runLabel')}
        value={
          run ? (
            <span className={cn(run.status === 'FINALIZED' && 'text-gold-bright')}>
              <CountUpValue value={fmtMoney(run.totalGross)} />
            </span>
          ) : (
            <span className="text-silver">{t('fin.cycle.runNone')}</span>
          )
        }
        sub={run ? t(`fin.status.${run.status}` as MessageKey) : periodOver ? t('fin.cycle.runReady') : t('fin.cycle.runAfter', { date: md(cycle.periodEnd) })}
      >
        <Link to="/payroll" className="mt-1 inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright">
          {run?.status === 'FINALIZED' ? t('fin.disburse') : t('fin.goPayroll')}
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </Step>
      <Step
        state={paid ? 'done' : 'todo'}
        label={t('fin.payday')}
        value={`${wd(cycle.payDate)}, ${md(cycle.payDate)}`}
        sub={paid ? t('fin.cycle.paid') : cycle.schedule}
      />
    </ol>
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
export function financeTasks(data: FinanceOverview, t: ReturnType<typeof useI18n>['t'], now: number): FinanceTask[] {
  const tasks: Array<FinanceTask & { rank: number }> = [];
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
      sub: unbilled > 0 ? t('fin.task.registerSub', { hours: fmtHours(unbilled) }) : t('fin.task.registerSubNone'),
      to: '/fieldglass',
    });
  }
  const cycle = data.payCycle;
  if (cycle) {
    const periodOver = todayYmd() > cycle.periodEnd;
    const daysToPay = daysBetween(todayYmd(), cycle.payDate);
    const sub = t('fin.task.runSub', { start: md(cycle.periodStart), end: md(cycle.periodEnd), date: `${wd(cycle.payDate)} ${md(cycle.payDate)}` });
    if (periodOver && !cycle.run) {
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
      title: t('fin.task.chase', { hours: fmtHours(data.close.pendingHours) }),
      sub: data.close.oldestDay
        ? t('fin.task.chaseSub', { count: data.close.pendingEntries, date: fmtDate(data.close.oldestDay) })
        : undefined,
      to: '/timesheets',
    });
  }
  const aging = data.receivables.aging;
  const pastDue = aging ? aging.d31 + aging.d61 + aging.d91 : 0;
  if (pastDue > 0) {
    tasks.push({
      key: 'collect',
      rank: 5,
      tone: aging && aging.d91 > 0 ? 'alert' : 'warning',
      icon: Scale,
      title: t('fin.task.collect', { amount: fmtMoney(pastDue) }),
      sub: data.receivables.oldestDays !== null ? t('fin.arOldest', { days: data.receivables.oldestDays }) : undefined,
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
  if (data.receivables.draftStatements > 0) {
    tasks.push({
      key: 'statements',
      rank: 6,
      tone: 'gold',
      icon: ClipboardCheck,
      title: t('fin.task.statements', { count: data.receivables.draftStatements }),
      to: '/clients/statements',
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

export function TodayList({ data }: { data: FinanceOverview }) {
  const { t } = useI18n();
  const now = useNow();
  const tasks = financeTasks(data, t, now);
  return (
    <Card className="h-full animate-enter" style={enterStagger(1)}>
      <CardContent className="p-5">
        <h2 className="flex items-baseline justify-between gap-2 text-sm font-medium text-white">
          {t('fin.today')}
          <span className="text-xs font-normal text-silver/60">{tasks.length > 0 ? t('fin.todaySub') : null}</span>
        </h2>
        {tasks.length === 0 ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {t('fin.todayClear')}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-navy-secondary/60" aria-label={t('fin.today')}>
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
    <Card className={cn('h-full animate-enter', late && 'border-alert/40')} style={enterStagger(3)}>
      <CardContent className="flex h-full flex-col p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-white">{t('fin.billTitle', { date: billing.weekEnding })}</h2>
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
              <Money label={t('fin.billApproved')} value={billing.money.approved} tone="text-success" />
              <Money label={t('fin.billAwaiting')} value={billing.money.awaiting} tone="text-white" />
              <Money label={t('fin.billAtRisk')} value={billing.money.atRisk} tone={billing.money.atRisk > 0 ? 'text-alert' : 'text-silver'} />
            </div>
          </>
        )}
        {billing.rejectedOpen.count > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-alert">
            <FileWarning className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('fin.billOlderRejected', { count: billing.rejectedOpen.count, amount: fmtMoney(billing.rejectedOpen.amount) })}
          </p>
        )}
        {billing.unpricedHours > 0 && <p className="mt-1.5 text-2xs text-silver/70">{t('fin.billUnpriced', { hours: fmtHours(billing.unpricedHours) })}</p>}
        <div className="mt-auto flex flex-wrap gap-2 pt-4">
          <Button asChild size="sm" variant={billing.toEnter > 0 ? 'primary' : 'secondary'}>
            <Link to={`/time-attendance/timesheets?week=${billing.weekStart}`}>
              <ClipboardCheck className="h-3.5 w-3.5" />
              {billing.toEnter > 0 ? t('fin.billEnter', { count: billing.toEnter }) : t('fin.billOpen')}
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to="/fieldglass">
              <UserCheck className="h-3.5 w-3.5" />
              {t('fin.fg')}
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
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.revenue, w.wages)));
  const done = weeks.filter((w) => !w.inProgress);
  const totals = done.reduce((s, w) => ({ revenue: s.revenue + w.revenue, wages: s.wages + w.wages }), { revenue: 0, wages: 0 });
  const totalMargin = totals.revenue - totals.wages;
  const unpriced = weeks.reduce((s, w) => s + w.unpricedHours, 0);
  return (
    <Card className="h-full animate-enter" style={enterStagger(4)}>
      <CardContent className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-white">{t('fin.marginTitle')}</h2>
          <span className="text-xs text-silver/60">{t('fin.marginSub', { weeks: weeks.length })}</span>
        </div>
        {!any ? (
          <p className="mt-3 text-sm text-silver">{t('fin.marginEmpty')}</p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-silver">
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-gold" aria-hidden="true" />
                {t('fin.marginRevenue')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-silver/50" aria-hidden="true" />
                {t('fin.marginWages')}
              </span>
              <span className="inline-flex items-center gap-1 text-success">% {t('fin.marginMargin')}</span>
            </div>
            <div className="mt-2 flex h-36 items-end gap-2" role="list" aria-label={t('fin.marginTitle')}>
              {weeks.map((w) => {
                const label = `${md(w.weekEnd)}: ${t('fin.marginRevenue')} ${fmtMoney(w.revenue)} · ${t('fin.marginWages')} ${fmtMoney(w.wages)}${
                  w.marginPct !== null ? ` · ${t('fin.marginMargin')} ${Math.round(w.marginPct * 100)}%` : ''
                }${w.inProgress ? ` (${t('fin.marginSoFar')})` : ''}`;
                return (
                  <div key={w.weekStart} role="listitem" aria-label={label} title={label} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                    <div
                      className={cn(
                        'mb-1 text-center text-2xs font-semibold tabular-nums',
                        w.marginPct === null ? 'text-silver/40' : w.marginPct < 0.1 ? 'text-warning' : 'text-success',
                      )}
                    >
                      {w.marginPct === null ? '—' : `${Math.round(w.marginPct * 100)}%`}
                    </div>
                    <div className={cn('flex flex-1 items-end justify-center gap-0.5', w.inProgress && 'opacity-60')}>
                      <div className="w-1/2 max-w-[18px] rounded-t-sm bg-gold" style={{ height: `${(w.revenue / max) * 100}%`, minHeight: w.revenue > 0 ? 2 : 0 }} />
                      <div className="w-1/2 max-w-[18px] rounded-t-sm bg-silver/50" style={{ height: `${(w.wages / max) * 100}%`, minHeight: w.wages > 0 ? 2 : 0 }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex gap-2 border-t border-navy-secondary pt-1">
              {weeks.map((w) => (
                <div key={w.weekStart} className="min-w-0 flex-1 truncate text-center text-2xs tabular-nums text-silver/60">
                  {w.inProgress ? t('fin.marginSoFar') : `${Number(w.weekEnd.slice(5, 7))}/${Number(w.weekEnd.slice(8, 10))}`}
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-navy-secondary bg-navy-secondary/60 text-center">
              <Money label={t('fin.marginRevenue')} value={totals.revenue} tone="text-gold-bright" />
              <Money label={t('fin.marginWages')} value={totals.wages} tone="text-white" />
              <Money label={t('fin.marginMargin')} value={totalMargin} tone={totalMargin >= 0 ? 'text-success' : 'text-alert'} />
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
        {unpriced > 0 && (
          <Link to="/clients" className="mt-1 flex items-center gap-1.5 text-xs text-silver hover:underline">
            <CalendarRange className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('fin.marginUnpriced', { hours: fmtHours(unpriced) })}
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
  const aging = receivables.aging ?? { current: receivables.outstandingTotal, d31: 0, d61: 0, d91: 0 };
  const total = aging.current + aging.d31 + aging.d61 + aging.d91;
  const buckets: Array<{ key: string; label: string; amount: number; tone: string }> = [
    { key: 'current', label: t('fin.arCurrent'), amount: aging.current, tone: 'bg-success/80' },
    { key: 'd31', label: t('fin.ar31'), amount: aging.d31, tone: 'bg-warning/80' },
    { key: 'd61', label: t('fin.ar61'), amount: aging.d61, tone: 'bg-alert/60' },
    { key: 'd91', label: t('fin.ar91'), amount: aging.d91, tone: 'bg-alert' },
  ];
  return (
    <Card className="h-full animate-enter" style={enterStagger(6)}>
      <CardContent className="p-5">
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
                receivables.avgDaysToPay !== null && t('fin.arDso', { days: receivables.avgDaysToPay }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-navy-secondary" aria-hidden="true">
              {buckets
                .filter((b) => b.amount > 0)
                .map((b) => (
                  <div key={b.key} className={b.tone} style={{ width: `${(b.amount / total) * 100}%` }} />
                ))}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              {buckets.map((b) => (
                <div key={b.key}>
                  <dt className="flex items-center gap-1 text-silver/70">
                    <span className={cn('h-2 w-2 rounded-sm', b.tone)} aria-hidden="true" />
                    {b.label}
                  </dt>
                  <dd className={cn('tabular-nums', b.amount > 0 ? 'text-white' : 'text-silver/40')}>{fmtMoney(b.amount)}</dd>
                </div>
              ))}
            </dl>
            {(receivables.byClient ?? []).length > 0 && (
              <ul className="mt-3 divide-y divide-navy-secondary/60 border-t border-navy-secondary/60">
                {(receivables.byClient ?? []).map((c) => (
                  <li key={c.clientName} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                    <span className="truncate text-white">{c.clientName}</span>
                    <span className="shrink-0 tabular-nums">
                      <span className="text-white">{fmtMoney(c.amount)}</span>
                      <span className={cn('ml-2 text-xs', c.oldestDays > 60 ? 'text-alert' : c.oldestDays > 30 ? 'text-warning' : 'text-silver/60')}>
                        {t('fin.arOldest', { days: c.oldestDays })}
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
