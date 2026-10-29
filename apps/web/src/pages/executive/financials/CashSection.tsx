import { Link } from 'react-router-dom';
import type { ExecFinancials } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { EmptyState } from '@/components/ui/EmptyState';
import { Landmark } from '@/components/ui/icons';
import { fmtMoneyAxis } from '@/components/ui/charts/axes';
import { PALETTE, TrendLineChart, isSparseTrend } from '@/components/ui/charts';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { fmtDateOnly } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { FinFigure } from './FinFigure';
import { signedExact } from './MarginWaterfall';

type Cash = NonNullable<ExecFinancials['cash']>;
type T = ReturnType<typeof useI18n>['t'];

/** The low point in a sentence: when, how much, and how far from the minimum. */
export function lowPointSentence(cash: Cash, t: T): string | null {
  const low = cash.lowPoint;
  if (!low) return null;
  const vars = { amount: fmtExecMoney(low.balance), date: fmtDateOnly(low.weekStart, { year: 'auto' }) };
  if (cash.minimum === null) return t('execPortal.fin.cash.lowPlain', vars);
  const gap = fmtExecMoney(Math.abs(low.balance - cash.minimum));
  return t(low.belowMinimum ? 'execPortal.fin.cash.lowBelow' : 'execPortal.fin.cash.lowAbove', { ...vars, gap });
}

/**
 * Cash: what is in the bank today, the thirteen-week forecast against the
 * minimum the company keeps, and the week it runs lowest — said in a
 * sentence and ringed on the line. With no bank in the books, it says so.
 */
export function CashSection({ cash }: { cash: ExecFinancials['cash'] }) {
  const { t } = useI18n();
  if (!cash) {
    return (
      <Card>
        <CardContent className="p-4 md:p-5">
          <EmptyState
            icon={Landmark}
            title={t('execPortal.fin.cash.connectTitle')}
            description={t('execPortal.fin.cash.connectBody')}
            action={
              <Button asChild size="sm" variant="secondary">
                <Link to="/books/bank">{t('execPortal.fin.cash.connectAction')}</Link>
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }
  const low = cash.lowPoint;
  const sentence = lowPointSentence(cash, t);
  const rows = cash.forecast.map((f) => ({ week: f.weekStart, balance: f.balance }));
  const sparse = isSparseTrend(rows, [{ key: 'balance' }]);
  const positive = rows.every((r) => r.balance >= 0) && (cash.minimum ?? 0) >= 0;
  return (
    <div className="space-y-4">
      <Card className="min-w-0">
        <CardContent className="grid grid-cols-2 gap-4 p-4 md:grid-cols-3 md:p-5">
          <FinFigure
            label={t('execPortal.fin.cash.today')}
            value={fmtExecMoney(cash.today)}
            exact={cash.today === null ? undefined : fmtExecExact(cash.today, 'money')}
            sub={cash.today === null ? t('execPortal.fin.cash.noBalance') : t('execPortal.fin.cash.accounts', { count: cash.accounts })}
            testId="exec-fin-cash-today"
          />
          <FinFigure
            label={t('execPortal.fin.cash.minimum')}
            value={cash.minimum === null ? '—' : fmtExecMoney(cash.minimum)}
            exact={cash.minimum === null ? undefined : fmtExecExact(cash.minimum, 'money')}
            sub={cash.minimum === null ? t('execPortal.fin.cash.noMinimum') : t('execPortal.fin.cash.minimumSub')}
          />
          {low && (
            <FinFigure
              className="col-span-2 md:col-span-1"
              label={t('execPortal.fin.cash.low')}
              value={fmtExecMoney(low.balance)}
              exact={fmtExecExact(low.balance, 'money')}
              sub={
                <span className="inline-flex flex-wrap items-center gap-x-1.5">
                  {t('execPortal.fin.cash.lowWeek', { date: fmtDateOnly(low.weekStart, { year: 'auto' }) })}
                  {cash.minimum !== null && (
                    <span className={cn('inline-flex items-center gap-1 font-medium', low.belowMinimum ? 'text-negative-800' : 'text-positive-800')}>
                      <span className={cn('h-2 w-2 rounded-full', low.belowMinimum ? 'bg-negative-700' : 'bg-positive-700')} aria-hidden="true" />
                      {t(low.belowMinimum ? 'execPortal.fin.cash.belowMin' : 'execPortal.fin.cash.aboveMin')}
                    </span>
                  )}
                </span>
              }
              testId="exec-fin-cash-low"
            />
          )}
        </CardContent>
      </Card>
      <div className="min-w-0">
        <ChartFrame
          title={t('execPortal.fin.cash.forecastTitle')}
          description={sentence ?? t('execPortal.fin.cash.forecastDesc')}
          summary={sentence ?? t('execPortal.fin.cash.noForecast')}
          columns={[
            { key: 'week', label: t('execPortal.fin.weeks.week'), format: (v) => fmtDateOnly(String(v), { year: 'auto' }) },
            { key: 'balance', label: t('execPortal.fin.cash.balance'), numeric: true, format: (v) => signedExact(Number(v)) },
          ]}
          rows={rows}
          csvName="cash-forecast"
          height={sparse ? 112 : 260}
          zerosMeaningful
          empty={
            <EmptyState
              size="sm"
              title={t('execPortal.fin.cash.noForecast')}
              description={
                <>
                  {t('execPortal.fin.cash.noForecastBody')}{' '}
                  <Link to="/finance/cash-forecast" className="text-accent underline-offset-4 hover:underline">
                    {t('execPortal.fin.cash.openForecast')}
                  </Link>
                </>
              }
            />
          }
        >
          <TrendLineChart
            data={rows}
            x="week"
            xDates="week"
            series={[{ key: 'balance', name: t('execPortal.fin.cash.balance'), color: PALETTE.secondary, area: true }]}
            format={fmtMoneyAxis}
            zeroBased={positive}
            target={cash.minimum !== null ? { value: cash.minimum, label: t('execPortal.fin.cash.minLine') } : undefined}
            mark={low ? { x: low.weekStart, label: t('execPortal.fin.cash.lowMark') } : undefined}
            sparseNote={t('execPortal.fin.cash.sparse', { count: rows.length })}
          />
        </ChartFrame>
      </div>
    </div>
  );
}
