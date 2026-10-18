import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Banknote, Landmark, Receipt, Scale } from 'lucide-react';
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
import type { CashForecast, CashLine } from './financeTypes';

/**
 * The cash forecast, every line: payroll and deposits going out, statements
 * coming in on their terms, week by week with a running total. There is no
 * bank balance in the product, so the page is movement, not position.
 */

const KIND_ICON: Record<CashLine['kind'], typeof Banknote> = {
  PAYROLL: Banknote,
  TAX_DEPOSIT: Landmark,
  GARNISHMENT: Scale,
  RECEIVABLE: Receipt,
};

const KIND_LABEL: Record<CashLine['kind'], string> = {
  PAYROLL: 'Payroll',
  TAX_DEPOSIT: 'Tax deposit',
  GARNISHMENT: 'Garnishment remittance',
  RECEIVABLE: 'Client payment',
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
          <div className="grid grid-cols-3 gap-3">
            <Stat label={t('fin.cashIn')} value={fmtMoney(data.totals.inflow)} tone="text-success" />
            <Stat label={t('fin.cashOut')} value={fmtMoney(data.totals.outflow)} tone="text-ink" />
            <Stat label={t('fin.cashNet')} value={fmtMoney(data.totals.net)} tone={data.totals.net >= 0 ? 'text-success' : 'text-alert'} />
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
                    <th className="px-4 py-2 text-right">{t('fin.cashRunning')}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {data.weeks.map((w) => (
                    <tr key={w.weekStart} className="border-t border-line">
                      <td className="px-4 py-2 text-ink">{t('fin.cashWeek', { date: fmtDate(w.weekStart) })}</td>
                      <td className="px-4 py-2 text-right text-success">{w.inflow ? fmtMoney(w.inflow) : '—'}</td>
                      <td className="px-4 py-2 text-right text-ink">{w.outflow ? fmtMoney(w.outflow) : '—'}</td>
                      <td className={cn('px-4 py-2 text-right', w.net >= 0 ? 'text-success' : 'text-alert')}>{fmtMoney(w.net)}</td>
                      <td className={cn('px-4 py-2 text-right font-medium', w.cumulative >= 0 ? 'text-ink' : 'text-alert')}>{fmtMoney(w.cumulative)}</td>
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

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <Card>
      <CardContent>
        <div className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">{label}</div>
        <div className={cn('mt-2 font-display text-2xl leading-none tabular-nums', tone)}>{value}</div>
      </CardContent>
    </Card>
  );
}
