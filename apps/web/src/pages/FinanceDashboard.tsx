import { useState } from 'react';
import { useGreeting, greetingName } from '@/lib/greeting';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import { LiveNow } from '@/components/ui/LiveNow';
import { EmptyState } from '@/components/ui/EmptyState';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  BarChart3,
  ChevronDown,
  ClipboardCheck,
  ClockAlert,
  DollarSign,
  FileSpreadsheet,
  Inbox,
  ShieldAlert,
  Scale,
  Wallet,
} from '@/components/ui/icons';
import { apiFetch } from '@/lib/api';
import { FieldglassQueueList } from './fieldglass/FieldglassQueue';
import type { FinanceOverview } from './finance/financeTypes';
import { BillingWeekCard, CashForecastCard, MarginTrendCard, PayCycleHero, ReceivablesCard, TodayList, financeTasks } from './finance/FinanceCockpit';
import { useAuth, useTenant } from '@/lib/auth';
import { useInbox } from '@/lib/inboxApi';
import { useI18n } from '@/lib/i18n';
import { fmtHours, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { usePersistentState } from '@/lib/usePersistentState';
import { Card, CardContent } from '@/components/ui/Card';
import { useClockParts } from '@/components/ClockStrip';
import { HomeMeta } from '@/components/home/HomeMeta';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { NextFundingCard } from '@/pages/payrollBanking/FundingCard';

/**
 * The Finance cockpit, v2 — an operations console in the admin-dashboard
 * grammar (display-face gold numerals, gold-accent KPI tiles, CountUp),
 * built around the finance charter's loop:
 *
 *   PAYDAY hero (sacred) → the four operating counters (chase / settle /
 *   AR / DSO) → the per-client chase list as bars → billed-vs-paid as
 *   paired bars → one row of the four actions the day actually needs.
 */


export function FinanceDashboard() {
  const { t } = useI18n();
  const { user } = useAuth();
  const clockParts = useClockParts();
  // Receivables are a staffing company's concern — a direct employer bills
  // no one, so the AR tile, the aging card and the statements door go away
  // together when either client statements or bill rates are off.
  const { moduleOn } = useTenant();
  const receivablesOn = moduleOn('clientPortal') && moduleOn('billRates');
  const query = useQuery({
    queryKey: ['finance', 'overview'],
    queryFn: () => apiFetch<FinanceOverview>('/finance/overview'),
    refetchInterval: 120_000,
  });
  const data = query.data;
  // The Inbox's sources: "Needs you" counts the same queues it lists (paydays with no run).
  const inbox = useInbox();
  // Which chase bar's Nudge is in flight ('all' | clientId | 'none').
  const [nudging, setNudging] = useState<string | null>(null);
  // Whole-section collapse, persisted per browser — the count stays
  // visible on the collapsed header so nothing hides silently.
  const [fgCollapsed, setFgCollapsed] = usePersistentState<boolean>(
    'fin.fgCollapsed',
    false,
  );

  // The chase, without the phone call: ping the field leaders who own
  // these approvals. The API dedupes to one nudge per client per day.
  const nudge = async (clientId: string | null) => {
    setNudging(clientId ?? 'none');
    try {
      const r = await apiFetch<{ notified: number; deduped: boolean }>(
        '/finance/close/nudge',
        { method: 'POST', body: { clientId } },
      );
      if (r.deduped) toast.info(t('fin.nudgeDeduped'));
      else if (r.notified === 0) toast.info(t('fin.nudgeNoOne'));
      else toast.success(t('fin.nudgeSent', { count: r.notified }));
    } catch {
      toast.error(t('fin.nudgeFailed'));
    } finally {
      setNudging(null);
    }
  };

  const greet = useGreeting();
  const name = greetingName(user, '');
  const greeting = (
    <>
      <LiveNow render={(now) => greet(now.getHours())} />
      {name && <>, <span className="text-accent">{name}</span></>}.
    </>
  );

  if (query.isError) {
    return (
      <HomeTemplate
        title={greeting}
        topbarTitle={t('fin.title')}
        subtitle={t('fin.subtitle')}
        hero={
          <EmptyState
            title={t('fin.title')}
            description={t('common.wentWrong')}
            action={
              <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        }
      />
    );
  }
  if (!data) {
    return (
      <HomeTemplate title={greeting} topbarTitle={t('fin.title')} subtitle={t('fin.subtitle')} hero={<Skeleton className="h-40" />}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28 hidden lg:block" />
          <Skeleton className="h-28 hidden lg:block" />
        </div>
      </HomeTemplate>
    );
  }

  const chaseHot = data.close.pendingHours > 0;
  const maxChase = data.close.byClient[0]?.hours ?? 0;
  const lastWeek = data.margin?.weeks.filter((w) => !w.inProgress).at(-1) ?? null;
  const atRisk = (data.billing?.money.atRisk ?? 0) + (data.billing?.rejectedOpen.amount ?? 0);
  const aging = data.receivables.aging;
  const pastDue = aging ? aging.days1to30 + aging.days31to60 + aging.days61to90 + aging.over90 : 0;
  const tasksToday = financeTasks(data, t, Date.now(), { statements: receivablesOn, inbox: inbox.data?.sources }).length;
  // The doors the day needs (plus the payroll case desk below): statements
  // only when the tenant bills clients.
  const doors = (
    [
      ['/payroll', 'fin.goPayroll', DollarSign],
      ['/timesheets', 'fin.goSheets', FileSpreadsheet],
      ...(receivablesOn ? ([['/clients/statements', 'fin.goStatements', Wallet]] as const) : []),
      ['/labor-costs', 'fin.goLabor', BarChart3],
    ] as const
  );

  return (
    // Design system §4.1 (UX upgrade step 6, the sweep): the Home template.
    // Payday is the hero, what needs finance today "Needs you" (counted),
    // the four numbers and the rest beneath.
    <HomeTemplate
      title={greeting}
      topbarTitle={t('fin.title')}
      // The subtitle is a motto; on a phone the first screen goes to the day.
      subtitle={<span className="hidden sm:inline">{t('fin.subtitle')}</span>}
      meta={
        <HomeMeta
          items={[
            <span key="live" className="inline-flex items-center gap-1.5">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              {t('fin.live')}
            </span>,
            ...clockParts,
          ]}
        />
      }
      hero={<PayCycleHero data={data} />}
      decisions={{ title: t('fin.today'), count: tasksToday, content: <TodayList data={data} headless /> }}
      assistant={<HugoSeat />}
    >
      {/* ---- Payroll funding: the next run's money, when payroll runs on our own ACH ---- */}
      <NextFundingCard />

      {/* ---- The four numbers that matter: one tile kit (MetricStrip:
          two across on a phone, four from lg, no orphan) ------------- */}
      <MetricStrip label={t('fin.title')}>
        <MetricCard
          href="/labor-costs"
          label={t('fin.kpiRevenue')}
          value={lastWeek ? fmtMoney(lastWeek.revenue) : '—'}
          icon={DollarSign}
          hint={lastWeek ? t('fin.kpiRevenueHint', { hours: fmtHours(lastWeek.hours - lastWeek.unpricedHours) }) : undefined}
        />
        <MetricCard
          href="/labor-costs"
          label={t('fin.kpiMargin')}
          value={lastWeek?.marginPct != null ? `${Math.round(lastWeek.marginPct * 100)}%` : '—'}
          tone={lastWeek?.marginPct != null && lastWeek.marginPct < 0 ? 'alert' : lastWeek?.marginPct != null && lastWeek.marginPct < 0.1 ? 'warning' : 'default'}
          icon={BarChart3}
          hint={lastWeek ? t('fin.kpiMarginHint', { amount: fmtMoney(lastWeek.margin) }) : undefined}
        />
        <MetricCard
          href={data.billing ? `/time-attendance/timesheets?week=${data.billing.weekStart}` : '/time-attendance/timesheets'}
          label={t('fin.kpiRisk')}
          value={fmtMoney(atRisk)}
          tone={atRisk > 0 ? 'alert' : 'default'}
          icon={ShieldAlert}
          hint={atRisk > 0 ? t('fin.kpiRiskHint') : t('fin.kpiRiskClean')}
        />
        {receivablesOn && (
          <MetricCard
            href="/clients/statements?status=UNPAID"
            label={t('fin.kpiAr')}
            value={fmtMoney(data.receivables.outstandingTotal)}
            tone={pastDue > 0 ? 'alert' : 'default'}
            icon={Scale}
            hint={
              data.receivables.outstandingCount > 0
                ? [
                    t('fin.arLine', { count: data.receivables.outstandingCount }),
                    data.receivables.oldestDays !== null && t('fin.arOldest', { days: data.receivables.oldestDays }),
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : t('fin.arClean')
            }
          />
        )}
      </MetricStrip>

      {/* ---- Getting paid: last week in Fieldglass, and the margin ----- */}
      {/* items-start: a long Billing card no longer stretches the margin card beside it (finance walk 14). */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <BillingWeekCard billing={data.billing} />
        <MarginTrendCard margin={data.margin} />
      </div>

      {/* ---- Cash: the next four weeks in and out ----------------------- */}
      {data.cash && <CashForecastCard cash={data.cash} />}

      {/* ---- Fieldglass setup queue ----------------------------------- */}
      <Card
        className={cn(
          'animate-enter',
          data.fieldglassQueue.length > 0 && 'border-gold/30',
        )}
        style={enterStagger(5)}
      >
        <CardContent>
          <button
            type="button"
            onClick={() => setFgCollapsed(!fgCollapsed)}
            aria-expanded={!fgCollapsed}
            className="flex w-full items-center justify-between gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
          >
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <ClipboardCheck className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('fin.fg')}
              {/* The count never hides — a collapsed section must still
                  say how many workers are waiting. */}
              {data.fieldglassQueue.length > 0 && (
                <span className="rounded-full bg-gold/15 px-2 py-0.5 text-xs font-medium text-gold tabular-nums">
                  {t('fin.fgWaiting', { count: data.fieldglassQueueTotal ?? data.fieldglassQueue.length })}
                </span>
              )}
            </h2>
            <span className="flex items-center gap-2">
              {!fgCollapsed && data.fieldglassQueue.length > 0 && (
                <span className="hidden sm:inline text-xs text-silver/60">
                  {t('fin.fgSub')}
                </span>
              )}
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'h-4 w-4 shrink-0 text-silver/60 transition-transform',
                  !fgCollapsed && 'rotate-180',
                )}
              />
            </span>
          </button>
          {fgCollapsed ? null : data.fieldglassQueue.length === 0 ? (
            <p className="mt-3 text-sm text-success">{t('fin.fgEmpty')}</p>
          ) : (
            <div className="mt-3">
              <FieldglassQueueList queue={data.fieldglassQueue} returnTo="/" />
              {(data.fieldglassQueueTotal ?? data.fieldglassQueue.length) > data.fieldglassQueue.length && (
                <Link
                  to="/fieldglass"
                  className="mt-2 inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright"
                >
                  {t('fin.fgMore', { count: (data.fieldglassQueueTotal ?? 0) - data.fieldglassQueue.length })}
                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {/* ---- The chase list, as bars -------------------------------- */}
        {chaseHot && (
          <Card className="animate-enter border-warning/30" style={enterStagger(5)}>
            <CardContent>
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <ClockAlert className="h-4 w-4 text-warning" aria-hidden="true" />
                {t('fin.close')}
              </h2>
              <p className="mt-1 text-sm text-silver tabular-nums">
                {t('fin.closePending', {
                  hours: fmtHours(data.close.pendingHours),
                  count: data.close.pendingEntries,
                })}
              </p>
              <ul className="mt-3 space-y-2.5">
                {data.close.byClient.map((c) => (
                  <li key={c.clientName}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="truncate text-white">{c.clientName}</span>
                      <span className="flex shrink-0 items-baseline gap-2">
                        <span className="tabular-nums text-silver">
                          {fmtHours(c.hours)}
                        </span>
                        <Button
                          size="xs"
                          variant="secondary"
                          loading={nudging === (c.clientId ?? 'none')}
                          onClick={() => void nudge(c.clientId)}
                        >
                          {t('fin.nudge')}
                        </Button>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-navy-secondary/50">
                      <div
                        className="h-full rounded-full bg-warning/80"
                        style={{
                          width: `${Math.max(6, (c.hours / Math.max(maxChase, 0.1)) * 100)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* ---- Who owes us, and for how long --------------------------- */}
        {receivablesOn && (
          <div className={cn(!chaseHot && 'lg:col-span-2')}>
            <ReceivablesCard receivables={data.receivables} />
          </div>
        )}
      </div>

      {/* ---- The actions the day needs -------------------------------- */}
      {/* Each door is at least 10rem wide and its label wraps to two lines, never cut off ("Run pay…"). */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2 md:gap-3">
        {doors.map(([to, key, Icon]) => (
          <Link
            key={to}
            to={to}
            className="group flex min-h-12 items-center gap-2 rounded-md border border-navy-secondary bg-navy px-3 py-3 text-sm text-white transition-colors hover:border-gold/50 hover:bg-navy/80 active:border-gold/50 active:bg-navy-secondary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Icon
              className="h-4 w-4 text-silver transition-colors group-hover:text-gold"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 break-words leading-tight">{t(key)}</span>
            <ArrowRight
              className="h-3.5 w-3.5 text-silver/70 transition-colors group-hover:text-gold"
              aria-hidden="true"
            />
          </Link>
        ))}
        {/* The payroll case desk — PAYROLL-category HR cases routed to
            Finance; the pill is the "assigned to you" count. */}
        <Link
          to="/hr-cases?tab=queue&category=PAYROLL&mine=1"
          className="group flex min-h-12 items-center gap-2 rounded-md border border-navy-secondary bg-navy px-3 py-3 text-sm text-white transition-colors hover:border-gold/50 hover:bg-navy/80 active:border-gold/50 active:bg-navy-secondary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <Inbox
            className="h-4 w-4 text-silver transition-colors group-hover:text-gold"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 break-words leading-tight">{t('fin.goCases')}</span>
          {data.payrollCases.open > 0 && (
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums',
                data.payrollCases.assignedToMe > 0
                  ? 'bg-alert/15 text-alert'
                  : 'bg-warning/15 text-warning',
              )}
            >
              {data.payrollCases.open}
            </span>
          )}
          <ArrowRight
            className="h-3.5 w-3.5 text-silver/70 transition-colors group-hover:text-gold"
            aria-hidden="true"
          />
        </Link>
      </div>
    </HomeTemplate>
  );
}
