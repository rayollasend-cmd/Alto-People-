import { Link } from 'react-router-dom';
import type { ExecFinancials } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { HandCoins } from '@/components/ui/icons';
import { PALETTE, TrendLineChart, isSparseTrend } from '@/components/ui/charts';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { fmtDateOnly, fmtMonth, ymdLocal } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { FinFigure } from './FinFigure';
import { AGING_FILL, agingSlices, daysPastDue, pastDue, pct1, type AgingSlice } from './finMath';

type Ar = ExecFinancials['receivables'];
type OpenRow = Ar['open'][number];
type T = ReturnType<typeof useI18n>['t'];

/**
 * Receivables, the chairman's way: the total open, how much of it is late,
 * one bar split by age (a bucket at zero takes no colour and no width),
 * the statements that matter most, and how long clients take to pay.
 */
export function Receivables({ ar }: { ar: Ar }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <AgingCard ar={ar} />
        <DsoChart months={ar.dsoByMonth} t={t} />
      </div>
      <OpenStatements rows={ar.open} />
    </div>
  );
}

function AgingCard({ ar }: { ar: Ar }) {
  const { t } = useI18n();
  // The books' receivables are view:books (not every executive role holds it).
  const { can } = useAuth();
  const slices = agingSlices(ar.buckets);
  const late = pastDue(ar.buckets);
  const total = ar.total;
  const word = (s: AgingSlice) => t(`execPortal.fin.ar.bucket.${s.key}`);
  const aria = t('execPortal.fin.ar.agingAria', { list: slices.map((s) => `${word(s)} ${fmtExecMoney(s.amount)}`).join(', ') });
  return (
    <Card className="min-w-0" data-testid="exec-fin-aging">
      <CardContent className="space-y-4 p-4 md:p-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <FinFigure
            label={t('execPortal.fin.ar.total')}
            value={fmtExecMoney(total)}
            exact={fmtExecExact(total, 'money')}
            sub={late > 0 && total > 0 ? t('execPortal.fin.ar.pastDue', { amount: fmtExecMoney(late), pct: pct1((late / total) * 100) }) : t('execPortal.fin.ar.nonePastDue')}
          />
          {can('view:books') && (
            <Link to="/books/receivables" className="text-sm text-accent underline-offset-4 hover:underline coarse:py-3">
              {t('execPortal.fin.ar.openAll')}
            </Link>
          )}
        </div>
        {total > 0 ? (
          <>
            <div role="img" aria-label={aria} className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" data-testid="exec-fin-aging-bar">
              {slices
                .filter((s) => s.amount > 0)
                .map((s) => (
                  <div key={s.key} className={cn('h-full min-w-[3px]', AGING_FILL[s.key])} style={{ flexGrow: s.amount, flexBasis: 0 }} title={`${word(s)}: ${fmtExecExact(s.amount, 'money')}`} data-bucket={s.key} />
                ))}
            </div>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 2xl:grid-cols-5">
              {slices.map((s) => (
                <li key={s.key} className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs2 text-ink-muted">
                    <span aria-hidden="true" className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', s.amount > 0 ? AGING_FILL[s.key] : 'border border-line')} />
                    <span className="truncate">{word(s)}</span>
                  </div>
                  <div className={cn('mt-0.5 text-sm tabular-nums', s.amount > 0 ? 'font-medium text-ink' : 'text-ink-muted')} title={fmtExecExact(s.amount, 'money')}>
                    {fmtExecMoney(s.amount)}
                    {s.amount > 0 && <span className="ml-1.5 text-xs2 font-normal text-ink-muted">{pct1(s.pct)}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-ink-muted">{t('execPortal.fin.ar.nothingOpen')}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** "12 days overdue" · "Due today" · "Not yet due" — a status chip only when it is late. */
export function DueStatus({ dueOn, today, t }: { dueOn: string; today: string; t: T }) {
  const late = daysPastDue(dueOn, today);
  if (late > 0) {
    return (
      <Badge size="sm" variant={late > 60 ? 'destructive' : 'pending'}>
        {t('execPortal.fin.ar.overdue', { count: late })}
      </Badge>
    );
  }
  return <span className="text-xs2 text-ink-muted">{late === 0 ? t('execPortal.fin.ar.dueToday') : t('execPortal.fin.ar.notYetDue')}</span>;
}

function OpenStatements({ rows }: { rows: OpenRow[] }) {
  const { t } = useI18n();
  const today = ymdLocal();
  const columns: GridColumn<OpenRow>[] = [
    { key: 'client', header: t('execPortal.fin.ar.colClient'), accessor: (r) => r.clientName, primary: true, sortable: true, cell: (r) => <span className="font-medium text-ink">{r.clientName}</span> },
    { key: 'number', header: t('execPortal.fin.ar.colNumber'), accessor: (r) => r.number, sortable: true, cardMeta: true, hideBelow: 420, className: 'tabular-nums' },
    { key: 'amount', header: t('execPortal.fin.ar.colAmount'), accessor: (r) => r.amount, csv: (r) => r.amount.toFixed(2), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmtExecExact(r.amount, 'money') },
    { key: 'due', header: t('execPortal.fin.ar.colDue'), accessor: (r) => r.dueOn, sortable: true, searchable: false, hideBelow: 520, cell: (r) => <span className="whitespace-nowrap tabular-nums">{fmtDateOnly(r.dueOn, { year: 'auto' })}</span>, csv: (r) => fmtDateOnly(r.dueOn) },
    { key: 'status', header: t('execPortal.fin.ar.colStatus'), accessor: (r) => daysPastDue(r.dueOn, today), sortable: true, searchable: false, align: 'right', cell: (r) => <DueStatus dueOn={r.dueOn} today={today} t={t} />, csv: (r) => { const d = daysPastDue(r.dueOn, today); return d > 0 ? t('execPortal.fin.ar.overdue', { count: d }) : t('execPortal.fin.ar.notYetDue'); } },
  ];
  return (
    <Card className="min-w-0">
      <CardContent className="space-y-3 p-4 md:p-5">
        <SectionTitle wrap className="mb-0" title={t('execPortal.fin.ar.openTitle')} description={t('execPortal.fin.ar.openDesc')} />
        <DataGrid
          id="exec-fin-open-statements"
          caption={t('execPortal.fin.ar.openTitle')}
          rows={rows}
          columns={columns}
          rowKey={(r) => r.statementId}
          rowHref={() => '/books/receivables'}
          noun={{ one: t('execPortal.fin.ar.nounOne'), many: t('execPortal.fin.ar.nounMany') }}
          search={false}
          urlState={false}
          columnChooser={false}
          exportCsv={{ filename: 'open-statements' }}
          empty={{ icon: HandCoins, title: t('execPortal.fin.ar.openEmpty'), description: t('execPortal.fin.ar.openEmptyBody') }}
        />
      </CardContent>
    </Card>
  );
}

function DsoChart({ months, t }: { months: Ar['dsoByMonth']; t: T }) {
  const rows = months.map((m) => ({ month: fmtMonth(m.month), days: m.days }));
  const known = months.filter((m) => m.days !== null) as Array<{ month: string; days: number }>;
  const last = known[known.length - 1];
  const first = known[0];
  const sparse = isSparseTrend(rows, [{ key: 'days' }]);
  const days = (n: number) => t('execPortal.fin.days', { count: Math.round(n) });
  const summary = !last
    ? t('execPortal.fin.dso.empty')
    : first && first !== last
      ? t('execPortal.fin.dso.move', { from: days(first.days), fromMonth: fmtMonth(first.month), to: days(last.days), toMonth: fmtMonth(last.month) })
      : t('execPortal.fin.dso.one', { days: days(last.days), month: fmtMonth(last.month) });
  return (
    <ChartFrame
      title={t('execPortal.fin.dso.title')}
      description={t('execPortal.fin.dso.desc')}
      summary={summary}
      columns={[
        { key: 'month', label: t('execPortal.fin.dso.month') },
        { key: 'days', label: t('execPortal.fin.dso.days'), numeric: true, format: (v) => (typeof v === 'number' ? String(Math.round(v)) : '—') },
      ]}
      rows={known.length ? rows : []}
      csvName="days-to-collect"
      height={sparse ? 112 : 220}
      empty={<p className="py-6 text-sm text-ink-muted">{t('execPortal.fin.dso.empty')}</p>}
    >
      <TrendLineChart
        data={rows}
        x="month"
        series={[{ key: 'days', name: t('execPortal.fin.dso.title'), color: PALETTE.secondary }]}
        format={(v) => days(v)}
        sparseNote={
          known.length === 1 && last
            ? t('execPortal.fin.dso.sparseOne', { month: fmtMonth(last.month, 'long') })
            : t('execPortal.fin.dso.sparse', { count: known.length })
        }
      />
    </ChartFrame>
  );
}
