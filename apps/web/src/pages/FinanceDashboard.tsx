import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Banknote,
  BarChart3,
  ClockAlert,
  DollarSign,
  FileSpreadsheet,
  Receipt,
  Scale,
  Wallet,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate, fmtHours, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { Card, CardContent } from '@/components/ui/Card';
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

interface FinanceOverview {
  generatedAt: string;
  payday: {
    next: { date: string; schedule: string } | null;
    inFlight: {
      id: string;
      status: 'DRAFT' | 'FINALIZED';
      periodStart: string;
      periodEnd: string;
      totalGross: number;
    } | null;
    lastDisbursed: { periodEnd: string; totalGross: number } | null;
  };
  close: {
    pendingEntries: number;
    pendingHours: number;
    oldestDay: string | null;
    byClient: Array<{ clientName: string; entries: number; hours: number }>;
  };
  settlements: { count: number; total: number };
  receivables: {
    outstandingTotal: number;
    outstandingCount: number;
    oldestDays: number | null;
    avgDaysToPay: number | null;
    draftStatements: number;
  };
  billedVsPaid: {
    weekStart: string;
    billed: number;
    paidGross: number;
    variance: number;
  } | null;
}

const DAY_MS = 86_400_000;

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

  const payday = data.payday.next;
  const daysToPayday = payday
    ? Math.max(0, Math.ceil((new Date(payday.date).getTime() - Date.now()) / DAY_MS))
    : null;
  const run = data.payday.inFlight;
  const chaseHot = data.close.pendingHours > 0;
  const maxChase = data.close.byClient[0]?.hours ?? 0;
  const bvp = data.billedVsPaid;
  const bvpMax = bvp ? Math.max(bvp.billed, bvp.paidGross, 1) : 1;

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
      </div>

      {/* ---- Payday — sacred ------------------------------------------ */}
      <Card className="relative overflow-hidden border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]"
        />
        <CardContent className="relative p-5">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
            <div className="min-w-0">
              <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
                <Banknote className="h-3.5 w-3.5" aria-hidden="true" />
                {t('fin.payday')}
              </span>
              {payday ? (
                <>
                  <div className="mt-2 text-5xl md:text-6xl font-bold tracking-tight tabular-nums text-white">
                    {fmtDate(payday.date)}
                  </div>
                  <p className="mt-1.5 text-sm text-silver tabular-nums">
                    <span className="font-semibold text-gold">
                      {daysToPayday === 0
                        ? t('fin.paydayToday')
                        : daysToPayday === 1
                          ? t('fin.paydayTomorrow')
                          : t('fin.paydayIn', { days: daysToPayday ?? 0 })}
                    </span>
                    <span className="text-silver/60"> · {payday.schedule}</span>
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm text-silver">{t('fin.paydayNone')}</p>
              )}
              {data.payday.lastDisbursed && (
                <p className="mt-2 text-xs text-silver/60 tabular-nums">
                  {t('fin.lastPay', {
                    gross: fmtMoney(data.payday.lastDisbursed.totalGross),
                    date: fmtDate(data.payday.lastDisbursed.periodEnd),
                  })}
                </p>
              )}
            </div>
            {/* The run in flight — money in the display face, admin canon. */}
            {run && (
              <div className="text-left sm:text-right">
                <div className="text-2xs font-medium uppercase tracking-[0.14em] text-silver/70">
                  {t('fin.runLabel')} · {t(`fin.status.${run.status}` as MessageKey)}
                </div>
                <div className="mt-1.5 font-display text-3xl md:text-hero leading-none text-gold-bright tabular-nums">
                  <CountUpValue value={fmtMoney(run.totalGross)} />
                </div>
                <div className="mt-1.5 text-xs text-silver tabular-nums">
                  {fmtDate(run.periodStart)} – {fmtDate(run.periodEnd)}
                </div>
                <Link
                  to="/payroll"
                  className={cn(
                    'mt-2 inline-flex items-center gap-1 text-sm underline underline-offset-2 coarse:min-h-11',
                    run.status === 'FINALIZED'
                      ? 'font-medium text-gold hover:text-gold-bright'
                      : 'text-silver hover:text-white',
                  )}
                >
                  {t('fin.disburse')}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---- The four operating counters ------------------------------ */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <FinKpi
          to="/timesheets"
          label={t('fin.kpiChase')}
          value={chaseHot ? fmtHours(data.close.pendingHours) : '0h'}
          hot={chaseHot}
          icon={ClockAlert}
          hint={
            chaseHot
              ? data.close.oldestDay
                ? t('fin.closeOldest', { date: fmtDate(data.close.oldestDay) })
                : undefined
              : t('fin.closeClean')
          }
          stagger={1}
        />
        <FinKpi
          to="/reimbursements"
          label={t('fin.settle')}
          value={fmtMoney(data.settlements.total)}
          icon={Receipt}
          hint={
            data.settlements.count > 0
              ? t('fin.settleLine', {
                  count: data.settlements.count,
                  total: fmtMoney(data.settlements.total),
                })
              : t('fin.clear')
          }
          stagger={2}
        />
        <FinKpi
          to="/clients/statements"
          label={t('fin.kpiAr')}
          value={fmtMoney(data.receivables.outstandingTotal)}
          hot={data.receivables.outstandingCount > 0}
          hotTone="alert"
          icon={Scale}
          hint={
            data.receivables.outstandingCount > 0
              ? [
                  t('fin.arLine', { count: data.receivables.outstandingCount }),
                  data.receivables.oldestDays !== null &&
                    t('fin.arOldest', { days: data.receivables.oldestDays }),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : t('fin.arClean')
          }
          stagger={3}
        />
        <FinKpi
          to="/clients/statements"
          label={t('fin.kpiDso')}
          value={
            data.receivables.avgDaysToPay !== null
              ? `${data.receivables.avgDaysToPay}d`
              : '—'
          }
          icon={BarChart3}
          hint={
            data.receivables.draftStatements > 0
              ? t('fin.arDrafts', { count: data.receivables.draftStatements })
              : undefined
          }
          stagger={4}
        />
      </div>

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
                      <span className="shrink-0 tabular-nums text-silver">
                        {fmtHours(c.hours)}
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

        {/* ---- Billed vs paid, as paired bars -------------------------- */}
        {bvp && (
          <Card
            className={cn('animate-enter', !chaseHot && 'lg:col-span-2')}
            style={enterStagger(6)}
          >
            <CardContent className="p-5">
              <h2 className="text-sm font-medium text-white">{t('fin.bvp')}</h2>
              <div className="mt-3 space-y-2.5">
                <BvpBar
                  label={t('fin.bvpBilled')}
                  amount={bvp.billed}
                  max={bvpMax}
                  barClass="bg-gold/80"
                />
                <BvpBar
                  label={t('fin.bvpPaid')}
                  amount={bvp.paidGross}
                  max={bvpMax}
                  barClass="bg-silver/50"
                />
              </div>
              <p className="mt-3 text-sm tabular-nums">
                <span
                  className={cn(
                    'font-semibold',
                    bvp.variance >= 0 ? 'text-success' : 'text-alert',
                  )}
                >
                  {bvp.variance >= 0 ? '+' : ''}
                  {fmtMoney(bvp.variance)}
                </span>
                <span className="text-silver/60"> · {t('fin.bvpNote')}</span>
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ---- The four actions the day needs --------------------------- */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
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

function BvpBar({
  label,
  amount,
  max,
  barClass,
}: {
  label: string;
  amount: number;
  max: number;
  barClass: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-silver">{label}</span>
        <span className="tabular-nums text-white">{fmtMoney(amount)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-navy-secondary/50">
        <div
          className={cn('h-full rounded-full', barClass)}
          style={{ width: `${Math.max(2, (amount / max) * 100)}%` }}
        />
      </div>
    </div>
  );
}
