import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  Banknote,
  BarChart3,
  ChevronDown,
  ClipboardCheck,
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
import { usePersistentState } from '@/lib/usePersistentState';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
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
  fieldglassQueue: Array<{
    associateId: string;
    name: string;
    clientName: string | null;
    position: string;
    firstShiftAt: string;
    approvedAt: string | null;
    email: string | null;
    phone: string | null;
    hireDate: string | null;
  }>;
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
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['finance', 'overview'],
    queryFn: () => apiFetch<FinanceOverview>('/finance/overview'),
    refetchInterval: 120_000,
  });
  const data = query.data;
  const [fgBusy, setFgBusy] = useState<string | null>(null);
  // Which queue row is unfolded to show its Fieldglass entry facts.
  const [fgOpen, setFgOpen] = useState<string | null>(null);
  // Whole-section collapse, persisted per browser — the count stays
  // visible on the collapsed header so nothing hides silently.
  const [fgCollapsed, setFgCollapsed] = usePersistentState<boolean>(
    'fin.fgCollapsed',
    false,
  );

  const refreshOverview = () =>
    queryClient.invalidateQueries({ queryKey: ['finance', 'overview'] });

  // Mark added → row leaves the queue; the toast carries a real Undo.
  const markFieldglass = async (associateId: string) => {
    setFgBusy(associateId);
    try {
      await apiFetch(`/finance/fieldglass/${associateId}/done`, { method: 'POST' });
      void refreshOverview();
      toast.success(t('fin.fgMarked'), {
        action: {
          label: t('fin.fgUndo'),
          onClick: () => {
            void apiFetch(`/finance/fieldglass/${associateId}/done`, {
              method: 'DELETE',
            }).then(() => refreshOverview());
          },
        },
      });
    } catch {
      toast.error(t('fin.fgFailed'));
    } finally {
      setFgBusy(null);
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
                  {t('fin.fgWaiting', { count: data.fieldglassQueue.length })}
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
            <ul className="mt-3 divide-y divide-navy-secondary/60">
              {data.fieldglassQueue.map((w) => {
                const soon =
                  new Date(w.firstShiftAt).getTime() - Date.now() <
                  48 * 3600_000;
                const open = fgOpen === w.associateId;
                return (
                  <li key={w.associateId} className="py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar
                        src={`/api/associates/${w.associateId}/photo`}
                        name={w.name}
                        email=""
                        size="md"
                      />
                      {/* Tap unfolds the entry facts — the whole Fieldglass
                          entry happens here, no navigation round trip. */}
                      <button
                        type="button"
                        onClick={() => setFgOpen(open ? null : w.associateId)}
                        aria-expanded={open}
                        className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-white">
                            {w.name}
                            {w.clientName && (
                              <span className="font-normal text-silver/80">
                                {' '}· {w.clientName}
                              </span>
                            )}
                          </span>
                          <ChevronDown
                            aria-hidden="true"
                            className={cn(
                              'h-3.5 w-3.5 shrink-0 text-silver/50 transition-transform',
                              open && 'rotate-180',
                            )}
                          />
                        </div>
                        <div className="text-xs text-silver tabular-nums">
                          <span className={cn(soon && 'font-medium text-warning')}>
                            {t('fin.fgFirstShift', { date: fmtDate(w.firstShiftAt) })}
                          </span>
                          <span className="text-silver/60"> · {w.position}</span>
                          {w.approvedAt && (
                            <span className="text-silver/60">
                              {' '}· {t('fin.fgApprovedOn', { date: fmtDate(w.approvedAt) })}
                            </span>
                          )}
                        </div>
                      </button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="shrink-0"
                        loading={fgBusy === w.associateId}
                        disabled={fgBusy !== null}
                        onClick={() => void markFieldglass(w.associateId)}
                      >
                        {t('fin.fgMark')}
                      </Button>
                    </div>
                    {open && (
                      <div className="grid animate-unfold">
                        <div className="overflow-hidden">
                          <div className="ml-[52px] mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                            {w.email && (
                              <div>
                                <span className="text-silver/60">{t('fin.fgEmail')}: </span>
                                {/* select-all: one tap selects the value for
                                    copying straight into Fieldglass. */}
                                <span className="select-all text-white">{w.email}</span>
                              </div>
                            )}
                            {w.phone && (
                              <div>
                                <span className="text-silver/60">{t('fin.fgPhone')}: </span>
                                <span className="select-all text-white tabular-nums">
                                  {w.phone}
                                </span>
                              </div>
                            )}
                            {w.hireDate && (
                              <div>
                                <span className="text-silver/60">{t('fin.fgStart')}: </span>
                                <span className="select-all text-white tabular-nums">
                                  {fmtDate(w.hireDate)}
                                </span>
                              </div>
                            )}
                            <div>
                              <span className="text-silver/60">{t('fin.fgClient')}: </span>
                              <span className="select-all text-white">
                                {w.clientName ?? '—'}
                              </span>
                            </div>
                          </div>
                          <Link
                            to={`/people?associateId=${w.associateId}&return=${encodeURIComponent('/')}`}
                            className="ml-[52px] mt-2 inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-9"
                          >
                            {t('fin.fgFullRecord')}
                            <ArrowRight className="h-3 w-3" aria-hidden="true" />
                          </Link>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
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
