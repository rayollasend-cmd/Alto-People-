import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Banknote, ClockAlert, Receipt, Scale } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate, fmtHours, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The Finance cockpit — FINANCE_ACCOUNTANT's landing page, built around
 * the finance charter's operating loop: payday (sacred, the gold hero),
 * the hours-approval chase that gates the close, reimbursements waiting
 * on settlement, receivables discipline (staffing companies die of cash),
 * and a billed-vs-paid sanity line for the last closed week.
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

export function FinanceDashboard() {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['finance', 'overview'],
    queryFn: () => apiFetch<FinanceOverview>('/finance/overview'),
    refetchInterval: 120_000,
  });
  const data = query.data;

  if (query.isError) {
    return (
      <div className="mx-auto">
        <PageHeader title={t('fin.title')} subtitle={t('fin.subtitle')} />
        <ErrorBanner
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
        <Skeleton className="h-44" />
        <Skeleton className="h-56" />
      </div>
    );
  }

  const payday = data.payday.next;
  const daysToPayday = payday
    ? Math.max(0, Math.ceil((new Date(payday.date).getTime() - Date.now()) / DAY_MS))
    : null;
  const chaseHot = data.close.pendingHours > 0;

  return (
    <div className="mx-auto space-y-4">
      <PageHeader title={t('fin.title')} subtitle={t('fin.subtitle')} />

      {/* ---- Payday — sacred ------------------------------------------ */}
      <Link to="/payroll" className="block group">
        <Card className="relative overflow-hidden border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter transition-colors group-hover:border-gold/50">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-gold)/0.14),transparent_55%)]"
          />
          <CardContent className="relative p-5">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
              <Banknote className="h-3.5 w-3.5" aria-hidden="true" />
              {t('fin.payday')}
            </span>
            {payday ? (
              <>
                <div className="mt-2 text-4xl md:text-5xl font-bold tracking-tight tabular-nums text-white">
                  {fmtDate(payday.date)}
                </div>
                <p className="mt-1.5 text-sm text-silver tabular-nums">
                  {daysToPayday === 0
                    ? t('fin.paydayToday')
                    : daysToPayday === 1
                      ? t('fin.paydayTomorrow')
                      : t('fin.paydayIn', { days: daysToPayday ?? 0 })}
                  <span className="text-silver/60"> · {payday.schedule}</span>
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-silver">{t('fin.paydayNone')}</p>
            )}
            {data.payday.inFlight ? (
              <p className="mt-2 text-sm tabular-nums">
                <span className="font-semibold text-gold">
                  {t('fin.runInFlight', {
                    status: t(
                      `fin.status.${data.payday.inFlight.status}` as MessageKey,
                    ),
                    start: fmtDate(data.payday.inFlight.periodStart),
                    end: fmtDate(data.payday.inFlight.periodEnd),
                    gross: fmtMoney(data.payday.inFlight.totalGross),
                  })}
                </span>
              </p>
            ) : (
              data.payday.lastDisbursed && (
                <p className="mt-2 text-sm text-silver/70 tabular-nums">
                  {t('fin.lastPay', {
                    gross: fmtMoney(data.payday.lastDisbursed.totalGross),
                    date: fmtDate(data.payday.lastDisbursed.periodEnd),
                  })}
                </p>
              )
            )}
          </CardContent>
        </Card>
      </Link>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* ---- The close chase ---------------------------------------- */}
        <Link to="/time-attendance" className="block group">
          <Card
            className={cn(
              'h-full animate-enter transition-colors',
              chaseHot && 'border-warning/40',
            )}
            style={enterStagger(1)}
          >
            <CardContent className="p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <ClockAlert
                  className={cn('h-4 w-4', chaseHot ? 'text-warning' : 'text-gold')}
                  aria-hidden="true"
                />
                {t('fin.close')}
              </h2>
              {chaseHot ? (
                <>
                  <div className="mt-2 text-3xl font-bold tracking-tight tabular-nums text-warning">
                    {fmtHours(data.close.pendingHours)}
                  </div>
                  <p className="mt-1 text-sm text-silver tabular-nums">
                    {t('fin.closePending', {
                      hours: fmtHours(data.close.pendingHours),
                      count: data.close.pendingEntries,
                    })}
                    {data.close.oldestDay && (
                      <span className="text-silver/60">
                        {' '}· {t('fin.closeOldest', {
                          date: fmtDate(data.close.oldestDay),
                        })}
                      </span>
                    )}
                  </p>
                  <ul className="mt-2 space-y-0.5 text-xs text-silver/80 tabular-nums">
                    {data.close.byClient.slice(0, 3).map((c) => (
                      <li key={c.clientName} className="truncate">
                        {c.clientName} · {fmtHours(c.hours)}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mt-3 text-sm text-success">{t('fin.closeClean')}</p>
              )}
            </CardContent>
          </Card>
        </Link>

        {/* ---- Settlements --------------------------------------------- */}
        <Link to="/reimbursements" className="block group">
          <Card className="h-full animate-enter" style={enterStagger(2)}>
            <CardContent className="p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <Receipt className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('fin.settle')}
              </h2>
              {data.settlements.count > 0 ? (
                <>
                  <div className="mt-2 text-3xl font-bold tracking-tight tabular-nums text-white">
                    {fmtMoney(data.settlements.total)}
                  </div>
                  <p className="mt-1 text-sm text-silver tabular-nums">
                    {t('fin.settleLine', {
                      count: data.settlements.count,
                      total: fmtMoney(data.settlements.total),
                    })}
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm text-success">{t('fin.settleClean')}</p>
              )}
            </CardContent>
          </Card>
        </Link>

        {/* ---- Receivables (DSO discipline) ----------------------------- */}
        <Link to="/clients/statements" className="block group">
          <Card
            className={cn(
              'h-full animate-enter',
              data.receivables.outstandingCount > 0 && 'border-alert/30',
            )}
            style={enterStagger(3)}
          >
            <CardContent className="p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <Scale className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('fin.receivables')}
              </h2>
              {data.receivables.outstandingCount > 0 ? (
                <>
                  <div className="mt-2 text-3xl font-bold tracking-tight tabular-nums text-white">
                    {fmtMoney(data.receivables.outstandingTotal)}
                  </div>
                  <p className="mt-1 text-sm text-silver tabular-nums">
                    {t('fin.arLine', { count: data.receivables.outstandingCount })}
                    {data.receivables.oldestDays !== null && (
                      <span className="text-alert">
                        {' '}· {t('fin.arOldest', { days: data.receivables.oldestDays })}
                      </span>
                    )}
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm text-success">{t('fin.arClean')}</p>
              )}
              <p className="mt-1.5 text-xs text-silver/60 tabular-nums">
                {[
                  data.receivables.avgDaysToPay !== null &&
                    t('fin.arDso', { days: data.receivables.avgDaysToPay }),
                  data.receivables.draftStatements > 0 &&
                    t('fin.arDrafts', { count: data.receivables.draftStatements }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* ---- Billed vs paid — the reconciliation nudge ------------------ */}
      {data.billedVsPaid && (
        <Card className="animate-enter" style={enterStagger(4)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('fin.bvp')}</h2>
            <p className="mt-2 text-sm text-silver tabular-nums">
              {t('fin.bvpLine', {
                billed: fmtMoney(data.billedVsPaid.billed),
                paid: fmtMoney(data.billedVsPaid.paidGross),
                v: fmtMoney(data.billedVsPaid.variance),
              })}
            </p>
            <p className="mt-1 text-xs text-silver/60">{t('fin.bvpNote')}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
