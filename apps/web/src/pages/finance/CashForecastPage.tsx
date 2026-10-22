import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Banknote, FileText, HeartPulse, Landmark, PiggyBank, Receipt, Scale } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { fmtDate, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { CashFlowChart, cashRows } from './financeCharts';
import type { CashForecast, CashLine, CashWeek } from './financeTypes';

/**
 * The cash forecast, every line: where the cash stands today (the Books
 * balance), payroll, deposits, retirement plan contributions, benefit
 * carrier premiums and vendor bills going out, statements coming
 * in on their terms — week by week with the projected balance, the low
 * point marked, and the cash floor from Settings shaded. A payday is never
 * dropped: with nobody on the schedule it shows at the last run's net,
 * flagged as an estimate.
 */

const KIND_ICON: Record<CashLine['kind'], typeof Banknote> = {
  PAYROLL: Banknote,
  TAX_DEPOSIT: Landmark,
  GARNISHMENT: Scale,
  RECEIVABLE: Receipt,
  BILL: FileText,
  RETIREMENT: PiggyBank,
  BENEFITS: HeartPulse,
};

const KIND_LABEL: Record<CashLine['kind'], string> = {
  PAYROLL: 'Payroll',
  TAX_DEPOSIT: 'Tax deposit',
  GARNISHMENT: 'Garnishment remittance',
  RECEIVABLE: 'Client payment',
  BILL: 'Vendor bill',
  RETIREMENT: 'Retirement plan',
  BENEFITS: 'Benefit carrier',
};

const CONFIDENCE_LABEL: Record<CashLine['confidence'], string> = {
  scheduled: 'Scheduled',
  estimated: 'Estimated',
  overdue: 'Past due',
};

export function CashForecastPage() {
  const { t } = useI18n();
  const [weeks, setWeeks] = useState<'4' | '8' | '13'>('4');
  const q = useQuery({
    queryKey: ['finance', 'cash-forecast', weeks],
    queryFn: () => apiFetch<CashForecast>(`/finance/cash-forecast?weeks=${weeks}`),
  });
  const data = q.data;

  return (
    <ListTemplate
      title="Cash forecast"
      topbarTitle="Cash forecast"
      subtitle={t('fin.cashSub')}
      breadcrumbs={[{ label: t('fin.title'), to: '/' }, { label: 'Cash forecast' }]}
      secondaryActions={
        <SegmentedControl
          ariaLabel="Horizon"
          value={weeks}
          onChange={(v) => setWeeks(v as typeof weeks)}
          options={[
            { value: '4', label: '4 weeks' },
            { value: '8', label: '8 weeks' },
            { value: '13', label: '13 weeks' },
          ]}
        />
      }
      summary={
        data ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Cash today"
              value={data.opening ? fmtMoney(data.opening.balance) : '—'}
              tone="text-ink"
              hint={data.opening ? <Link to="/books/bank" className="hover:text-accent hover:underline">From the books · {data.opening.accounts} bank and card {data.opening.accounts === 1 ? 'account' : 'accounts'}</Link> : <Link to="/books" className="hover:text-accent hover:underline">No bank account in the books yet — movement only</Link>}
            />
            <Stat label={t('fin.cashIn')} value={fmtMoney(data.totals.inflow)} tone="text-success" />
            <Stat label={t('fin.cashOut')} value={fmtMoney(data.totals.outflow)} tone="text-ink" />
            <Stat
              label={data.opening ? 'Low point' : t('fin.cashNet')}
              value={data.opening && data.lowest ? fmtMoney(data.lowest.balance) : fmtMoney(data.totals.net)}
              tone={(data.opening && data.lowest ? data.lowest.balance < 0 || data.lowest.belowMinimum : data.totals.net < 0) ? 'text-alert' : 'text-success'}
              hint={
                data.opening && data.lowest
                  ? `Week of ${fmtDate(data.lowest.weekStart)}${data.minimumCash !== null ? (data.lowest.belowMinimum ? ` · under the ${fmtMoney(data.minimumCash)} floor` : ` · above the ${fmtMoney(data.minimumCash)} floor`) : ''}`
                  : undefined
              }
            />
          </div>
        ) : (
          <Skeleton className="h-20" />
        )
      }
    >
      {q.isError && (
        <EmptyState
          title="Could not load the forecast"
          action={
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        />
      )}
      {data && (
        <div className="space-y-4">
          {data.lowest?.belowMinimum && data.minimumCash !== null && (
            <p className="flex items-start gap-2 rounded-lg border border-alert/30 bg-alert/[0.06] px-3 py-2 text-sm text-ink" role="status">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
              Cash dips to {fmtMoney(data.lowest.balance)} in the week of {fmtDate(data.lowest.weekStart)} — under the {fmtMoney(data.minimumCash)} floor.
            </p>
          )}
          <CashChart weeks={data.weeks} withBalance={!!data.opening} minimumCash={data.minimumCash} />
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-2xs uppercase tracking-wider text-ink-muted">
                  <tr>
                    <th className="px-4 py-2 text-left">Week</th>
                    <th className="px-4 py-2 text-right">{t('fin.cashIn')}</th>
                    <th className="px-4 py-2 text-right">{t('fin.cashOut')}</th>
                    <th className="px-4 py-2 text-right">{t('fin.cashNet')}</th>
                    <th className="px-4 py-2 text-right">{data.opening ? t('fin.cashBalance') : t('fin.cashRunning')}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {data.weeks.map((w) => (
                    <tr key={w.weekStart} className="border-t border-line">
                      <td className="px-4 py-2 text-ink">{t('fin.cashWeek', { date: fmtDate(w.weekStart) })}</td>
                      <td className="px-4 py-2 text-right text-success">{w.inflow ? fmtMoney(w.inflow) : '—'}</td>
                      <td className="px-4 py-2 text-right text-ink">{w.outflow ? fmtMoney(w.outflow) : '—'}</td>
                      <td className={cn('px-4 py-2 text-right', w.net >= 0 ? 'text-success' : 'text-alert')}>{fmtMoney(w.net)}</td>
                      {(() => {
                        const shown = data.opening ? (w.balance ?? w.cumulative) : w.cumulative;
                        const under = shown < 0 || (data.opening !== null && data.minimumCash !== null && shown < data.minimumCash);
                        return <td className={cn('px-4 py-2 text-right font-medium', under ? 'text-alert' : 'text-ink')}>{fmtMoney(shown)}</td>;
                      })()}
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </CardContent>
          </Card>

          {data.lines.length === 0 ? (
            <EmptyState title={t('fin.cashEmpty')} />
          ) : (
            <Card>
              <CardContent className="p-0">
                <ul className="divide-y divide-line" aria-label={t('fin.cashOpen')}>
                  {data.lines.map((l, i) => {
                    const Icon = KIND_ICON[l.kind];
                    return (
                      <li key={`${l.date}-${l.kind}-${i}`}>
                        <Link to={l.linkUrl} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised">
                          <Icon className={cn('h-4 w-4 shrink-0', l.amount > 0 ? 'text-success' : 'text-ink-muted')} aria-hidden="true" />
                          <span className="w-24 shrink-0 text-xs tabular-nums text-ink-muted">{fmtDate(l.date)}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-ink">{l.label}</span>
                            <span className="block text-2xs text-ink-muted">
                              {KIND_LABEL[l.kind]} · {CONFIDENCE_LABEL[l.confidence]}
                              {l.warning && <span className="text-warning"> · {l.warning}</span>}
                            </span>
                          </span>
                          <span className={cn('shrink-0 text-sm tabular-nums', l.amount > 0 ? 'text-success' : 'text-ink', l.confidence === 'overdue' && 'text-alert')}>
                            {l.amount > 0 ? '+' : '−'}
                            {fmtMoney(Math.abs(l.amount))}
                          </span>
                          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-muted group-hover:text-accent" aria-hidden="true" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </ListTemplate>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone: string; hint?: React.ReactNode }) {
  return (
    <Card>
      <CardContent>
        <div className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">{label}</div>
        <div className={cn('mt-2 font-display text-2xl leading-none tabular-nums', tone)}>{value}</div>
        {hint && <div className="mt-2 text-xs text-ink-muted">{hint}</div>}
      </CardContent>
    </Card>
  );
}

/* ---- Running balance over money in and out ------------------------------ */

function CashChart({ weeks, withBalance, minimumCash }: { weeks: CashWeek[]; withBalance: boolean; minimumCash: number | null }) {
  if (weeks.length === 0) return null;
  const val = (w: CashWeek) => (withBalance ? (w.balance ?? w.cumulative) : w.cumulative);
  const low = weeks.reduce((m, w) => (val(w) < val(m) ? w : m), weeks[0]!);
  const end = weeks[weeks.length - 1]!;
  const what = withBalance ? 'Cash' : 'The running total';
  const floor = withBalance && minimumCash !== null ? minimumCash : 0;
  const summary =
    val(low) < floor
      ? `${what} dips to ${fmtMoney(val(low))} in the week of ${fmtDate(low.weekStart)}${floor > 0 ? `, under the ${fmtMoney(floor)} floor,` : ''} and ends at ${fmtMoney(val(end))}.`
      : `${what} stays above ${floor > 0 ? `the ${fmtMoney(floor)} floor` : 'zero'}, lowest at ${fmtMoney(val(low))} in the week of ${fmtDate(low.weekStart)}, ending at ${fmtMoney(val(end))} after ${weeks.length} weeks.`;
  return (
    <ChartFrame
      title="Week by week"
      description={withBalance ? 'Money in above the line, money out below, and the cash balance across the horizon.' : 'Money in above the line, money out below, and the running total across the horizon.'}
      summary={summary}
      columns={[
        { key: 'weekStart', label: 'Week of', format: (v) => fmtDate(v as string) },
        { key: 'inflow', label: 'Money in', numeric: true, format: (v) => fmtMoney(v as number) },
        { key: 'outflow', label: 'Money out', numeric: true, format: (v) => fmtMoney(v as number) },
        { key: 'net', label: 'Net', numeric: true, format: (v) => fmtMoney(v as number) },
        { key: withBalance ? 'balance' : 'cumulative', label: withBalance ? 'Cash balance' : 'Running total', numeric: true, format: (v) => fmtMoney(v as number) },
      ]}
      rows={cashRows(weeks)}
      csvName="cash-forecast"
      height={280}
    >
      <CashFlowChart weeks={weeks} withBalance={withBalance} minimumCash={withBalance ? minimumCash : null} />
    </ChartFrame>
  );
}
