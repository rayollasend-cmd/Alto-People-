import { useState } from 'react';
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
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { FieldglassQueueList } from './fieldglass/FieldglassQueue';
import type { FinanceOverview } from './finance/financeTypes';
import { BillingWeekCard, MarginTrendCard, PayCycleHero, ReceivablesCard, TodayList } from './finance/FinanceCockpit';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtHours, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { usePersistentState } from '@/lib/usePersistentState';
import { Card, CardContent } from '@/components/ui/Card';
import { ClockStrip } from '@/components/ClockStrip';
import { CountUpValue } from '@/components/ui/MetricCard';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The Finance cockpit, v2 — an operations console in the admin-dashboard
 * grammar (display-face gold numerals, gold-accent KPI tiles, CountUp),
 * built around the finance charter's loop:
 *
 *   PAYDAY hero (sacred) → the four operating counters (chase / settle /
 *   AR / DSO) → the per-client chase list as bars → billed-vs-paid as
 *   paired bars → one row of the four actions the day actually needs.
 */


function greetKey(hour: number): MessageKey {
  if (hour < 12) return 'fin.morning';
  if (hour < 17) return 'fin.afternoon';
  return 'fin.evening';
}

export function FinanceDashboard() {
  const { t } = useI18n();
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['finance', 'overview'],
    queryFn: () => apiFetch<FinanceOverview>('/finance/overview'),
    refetchInterval: 120_000,
  });
  const data = query.data;
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

  const firstName = user?.firstName || (user?.email?.split('@')[0] ?? '');

  if (query.isError) {
    return (
      <div className="mx-auto">
        <h1 className="font-display text-3xl text-white">{t('fin.title')}</h1>
        <ErrorBanner
          className="mt-4"
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('common.wentWrong')}
        </ErrorBanner>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-40" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28 hidden lg:block" />
          <Skeleton className="h-28 hidden lg:block" />
        </div>
      </div>
    );
  }

  const chaseHot = data.close.pendingHours > 0;
  const maxChase = data.close.byClient[0]?.hours ?? 0;
  const lastWeek = data.margin?.weeks.filter((w) => !w.inProgress).at(-1) ?? null;
  const atRisk = (data.billing?.money.atRisk ?? 0) + (data.billing?.rejectedOpen.amount ?? 0);
  const aging = data.receivables.aging;
  const pastDue = aging ? aging.d31 + aging.d61 + aging.d91 : 0;

  return (
    <div className="mx-auto space-y-5">
      {/* ---- Greeting ------------------------------------------------- */}
      <div className="animate-enter">
        <h1 className="font-display text-3xl md:text-4xl text-white">
          {t(greetKey(new Date().getHours()))}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-silver">
          {t('fin.subtitle')}
          <span className="flex items-center gap-1.5 text-xs text-silver/60">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            {t('fin.live')}
          </span>
        </p>
        <ClockStrip className="mt-1.5" />
      </div>

      {/* ---- Payday — sacred — and what needs finance today ----------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <PayCycleHero data={data} />
        </div>
        <TodayList data={data} />
      </div>

      {/* ---- The four numbers that matter ----------------------------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <FinKpi
          to="/labor-costs"
          label={t('fin.kpiRevenue')}
          value={lastWeek ? fmtMoney(lastWeek.revenue) : '—'}
          icon={DollarSign}
          hint={lastWeek ? t('fin.kpiRevenueHint', { hours: fmtHours(lastWeek.hours - lastWeek.unpricedHours) }) : undefined}
          stagger={1}
        />
        <FinKpi
          to="/labor-costs"
          label={t('fin.kpiMargin')}
          value={lastWeek?.marginPct != null ? `${Math.round(lastWeek.marginPct * 100)}%` : '—'}
          hot={lastWeek?.marginPct != null && lastWeek.marginPct < 0.1}
          hotTone={lastWeek?.marginPct != null && lastWeek.marginPct < 0 ? 'alert' : 'warning'}
          icon={BarChart3}
          hint={lastWeek ? t('fin.kpiMarginHint', { amount: fmtMoney(lastWeek.margin) }) : undefined}
          stagger={2}
        />
        <FinKpi
          to={data.billing ? `/time-attendance/timesheets?week=${data.billing.weekStart}` : '/time-attendance/timesheets'}
          label={t('fin.kpiRisk')}
          value={fmtMoney(atRisk)}
          hot={atRisk > 0}
          hotTone="alert"
          icon={ShieldAlert}
          hint={atRisk > 0 ? t('fin.kpiRiskHint') : t('fin.kpiRiskClean')}
          stagger={3}
        />
        <FinKpi
          to="/clients/statements"
          label={t('fin.kpiAr')}
          value={fmtMoney(data.receivables.outstandingTotal)}
          hot={pastDue > 0}
          hotTone="alert"
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
          stagger={4}
        />
      </div>

      {/* ---- Getting paid: last week in Fieldglass, and the margin ----- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BillingWeekCard billing={data.billing} />
        <MarginTrendCard margin={data.margin} />
      </div>

      {/* ---- Fieldglass setup queue ----------------------------------- */}
      <Card
        className={cn(
          'animate-enter',
          data.fieldglassQueue.length > 0 && 'border-gold/30',
        )}
        style={enterStagger(5)}
      >
        <CardContent className="p-5">
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
                  {(data.fieldglassQueueTotal ?? 0) - data.fieldglassQueue.length} more on Fieldglass setup
                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ---- The chase list, as bars -------------------------------- */}
        {chaseHot && (
          <Card className="animate-enter border-warning/30" style={enterStagger(5)}>
            <CardContent className="p-5">
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
        <div className={cn(!chaseHot && 'lg:col-span-2')}>
          <ReceivablesCard receivables={data.receivables} />
        </div>
      </div>

      {/* ---- The actions the day needs -------------------------------- */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5 md:gap-3">
        {(
          [
            ['/payroll', 'fin.goPayroll', DollarSign],
            ['/timesheets', 'fin.goSheets', FileSpreadsheet],
            ['/clients/statements', 'fin.goStatements', Wallet],
            ['/labor-costs', 'fin.goLabor', BarChart3],
          ] as const
        ).map(([to, key, Icon]) => (
          <Link
            key={to}
            to={to}
            className="group flex min-h-12 items-center gap-2 rounded-md border border-navy-secondary bg-navy px-3 py-3 text-sm text-white transition-colors hover:border-gold/50 hover:bg-navy/80 active:border-gold/50 active:bg-navy-secondary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Icon
              className="h-4 w-4 text-silver transition-colors group-hover:text-gold"
              aria-hidden="true"
            />
            <span className="flex-1 truncate">{t(key)}</span>
            <ArrowRight
              className="h-3.5 w-3.5 text-silver/70 transition-colors group-hover:text-gold"
              aria-hidden="true"
            />
          </Link>
        ))}
        {/* The payroll case desk — PAYROLL-category HR cases routed to
            Finance; the pill is the "assigned to you" count. */}
        <Link
          to="/hr-cases"
          className="group flex min-h-12 items-center gap-2 rounded-md border border-navy-secondary bg-navy px-3 py-3 text-sm text-white transition-colors hover:border-gold/50 hover:bg-navy/80 active:border-gold/50 active:bg-navy-secondary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <Inbox
            className="h-4 w-4 text-silver transition-colors group-hover:text-gold"
            aria-hidden="true"
          />
          <span className="flex-1 truncate">{t('fin.goCases')}</span>
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
    </div>
  );
}

/** Gold-accent KPI tile — the AdminDashboard canon: 2px gold left rail,
 *  display-face numeral counting up, quiet hint. `hot` warms the numeral. */
function FinKpi({
  to,
  label,
  value,
  hint,
  icon: Icon,
  hot = false,
  hotTone = 'warning',
  stagger,
}: {
  to: string;
  label: string;
  value: string;
  hint?: string;
  icon: typeof ClockAlert;
  hot?: boolean;
  hotTone?: 'warning' | 'alert';
  stagger: number;
}) {
  return (
    <Link to={to} className="group block" style={enterStagger(stagger)}>
      <Card
        interactive
        className="h-full animate-enter border-l-2 border-l-gold/40 transition-colors group-hover:border-l-gold"
      >
        <CardContent className="pt-5">
          <div className="flex items-center justify-between">
            <div className="text-2xs font-medium uppercase tracking-[0.14em] text-silver/70">
              {label}
            </div>
            <Icon className="h-3.5 w-3.5 text-gold/70" aria-hidden="true" />
          </div>
          <div
            className={cn(
              'mt-3 font-display text-3xl leading-none tabular-nums',
              hot
                ? hotTone === 'alert'
                  ? 'text-alert'
                  : 'text-warning'
                : 'text-gold-bright',
            )}
          >
            <CountUpValue value={value} />
          </div>
          {hint && (
            <div className="mt-2 truncate text-xs text-silver">{hint}</div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
