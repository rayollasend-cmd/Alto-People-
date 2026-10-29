import { Link } from 'react-router-dom';
import type { ExecFinancials } from '@alto-people/shared';
import { BulletBar } from '@/components/executive/BulletBar';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { BookOpen } from '@/components/ui/icons';
import { fmtMoneyAxis } from '@/components/ui/charts/axes';
import { PALETTE, SparseReading, StackedBarChart, TREND_MIN_POINTS } from '@/components/ui/charts';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney, STATUS_DOT, STATUS_TEXT } from '@/lib/executiveFormat';
import { fmtDateOnly, fmtDateOnlyRange, fmtMonth } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { FinFigure } from './FinFigure';
import { signedExact } from './MarginWaterfall';
import { budgetStatus } from './finMath';

type Run = ExecFinancials['payrollRuns'][number];

/**
 * What each payroll run cost the company — gross pay plus the employer's
 * taxes, one column per run, newest at full strength. Fewer than four runs
 * is a number and a sentence (the sparse rule).
 */
export function PayrollCost({ runs }: { runs: Run[] }) {
  const { t } = useI18n();
  const last = runs[runs.length - 1];
  const period = (r: Run) => fmtDateOnlyRange(r.periodStart, r.periodEnd);
  const summary = last ? t('execPortal.fin.payroll.summary', { period: period(last), cost: fmtExecMoney(last.cost), count: last.people, gross: fmtExecMoney(last.gross), taxes: fmtExecMoney(last.employerTaxes) }) : t('execPortal.fin.payroll.empty');
  const sparse = runs.length < TREND_MIN_POINTS;
  const data = runs.map((r) => ({ end: r.periodEnd, gross: r.gross, employerTaxes: r.employerTaxes }));
  return (
    <ChartFrame
      title={t('execPortal.fin.payroll.title')}
      description={last ? summary : t('execPortal.fin.payroll.desc')}
      summary={summary}
      columns={[
        { key: 'period', label: t('execPortal.fin.payroll.period') },
        { key: 'people', label: t('execPortal.fin.payroll.people'), numeric: true },
        { key: 'gross', label: t('execPortal.fin.payroll.gross'), numeric: true, format: (v) => signedExact(Number(v)) },
        { key: 'employerTaxes', label: t('execPortal.fin.payroll.taxes'), numeric: true, format: (v) => signedExact(Number(v)) },
        { key: 'cost', label: t('execPortal.fin.payroll.cost'), numeric: true, format: (v) => signedExact(Number(v)) },
      ]}
      rows={runs.map((r) => ({ period: period(r), people: r.people, gross: r.gross, employerTaxes: r.employerTaxes, cost: r.cost }))}
      csvName="payroll-cost"
      height={sparse ? 120 : 240}
      empty={<p className="py-6 text-sm text-ink-muted">{t('execPortal.fin.payroll.empty')}</p>}
    >
      {sparse ? (
        last && (
          <SparseReading
            figures={[
              { label: t('execPortal.fin.payroll.cost'), value: fmtExecMoney(last.cost), title: fmtExecExact(last.cost, 'money') },
              { label: t('execPortal.fin.payroll.people'), value: last.people.toLocaleString() },
            ]}
            note={t('execPortal.fin.payroll.sparse', { count: runs.length, period: period(last) })}
          />
        )
      ) : (
        <StackedBarChart
          data={data}
          x="end"
          xDates="day"
          series={[
            { key: 'gross', name: t('execPortal.fin.payroll.gross'), color: PALETTE.secondary },
            { key: 'employerTaxes', name: t('execPortal.fin.payroll.taxes'), color: PALETTE.tertiary },
          ]}
          format={fmtMoneyAxis}
          highlight={last?.periodEnd}
          heading={(end) => {
            const r = runs.find((x) => x.periodEnd === end);
            return r ? period(r) : fmtDateOnly(end);
          }}
        />
      )}
    </ChartFrame>
  );
}

/**
 * Profit from the books: the month so far, and the year to date against the
 * budget — a bullet when a budget exists, the gap in words and its status.
 */
export function ProfitCard({ profit }: { profit: ExecFinancials['profit'] }) {
  const { t } = useI18n();
  if (!profit) {
    return (
      <Card className="min-w-0">
        <CardContent className="p-4 md:p-5">
          <SectionTitle title={t('execPortal.fin.profit.title')} description={t('execPortal.fin.profit.desc')} />
          <EmptyState
            size="sm"
            icon={BookOpen}
            title={t('execPortal.fin.profit.emptyTitle')}
            description={
              <>
                {t('execPortal.fin.profit.emptyBody')}{' '}
                <Link to="/books/reports" className="text-accent underline-offset-4 hover:underline">
                  {t('execPortal.fin.profit.openBooks')}
                </Link>
              </>
            }
          />
        </CardContent>
      </Card>
    );
  }
  const ytd = profit.ytd;
  const status = ytd ? budgetStatus(ytd.actual, ytd.budget) : 'none';
  const gap = ytd ? ytd.actual - ytd.budget : 0;
  return (
    <Card className="min-w-0" data-testid="exec-fin-profit">
      <CardContent className="space-y-4 p-4 md:p-5">
        <SectionTitle className="mb-0" title={t('execPortal.fin.profit.title')} description={t('execPortal.fin.profit.desc')} />
        <div className="grid grid-cols-2 gap-4">
          <FinFigure label={t('execPortal.fin.profit.mtd', { month: fmtMonth(profit.month, 'long') })} value={fmtExecMoney(profit.mtdNetIncome)} exact={fmtExecExact(profit.mtdNetIncome, 'money')} sub={t('execPortal.fin.profit.netIncome')} />
          <FinFigure
            label={t('execPortal.fin.profit.ytd')}
            value={ytd ? fmtExecMoney(ytd.actual) : '—'}
            exact={ytd ? fmtExecExact(ytd.actual, 'money') : undefined}
            sub={ytd ? t('execPortal.fin.profit.budget', { amount: fmtExecMoney(ytd.budget) }) : t('execPortal.fin.profit.noBudget')}
          />
        </div>
        {ytd ? (
          <div className="space-y-2">
            <BulletBar value={ytd.actual} target={ytd.budget} status={status} label={t('execPortal.fin.profit.bulletAria', { actual: fmtExecMoney(ytd.actual), budget: fmtExecMoney(ytd.budget) })} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs2">
              <span className={cn('inline-flex items-center gap-1.5 font-medium', STATUS_TEXT[status])}>
                <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} aria-hidden="true" />
                {Math.abs(gap) < 0.5 ? t('execPortal.fin.profit.onBudget') : t(gap > 0 ? 'execPortal.fin.profit.ahead' : 'execPortal.fin.profit.behind', { amount: fmtExecMoney(Math.abs(gap)) })}
              </span>
              {profit.budgetName && <span className="truncate text-ink-muted">{t('execPortal.fin.profit.budgetName', { name: profit.budgetName })}</span>}
            </div>
          </div>
        ) : (
          <Button asChild size="sm" variant="secondary">
            <Link to="/books/budgets">{t('execPortal.fin.profit.setBudget')}</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
