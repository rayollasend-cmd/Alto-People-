import { useQuery } from '@tanstack/react-query';
import { fmtMoneyAxis } from '@/components/ui/charts/axes';
import { Link } from 'react-router-dom';
import { AlertTriangle, Printer } from '@/components/ui/icons';
import { getPayrollYtd, type PayrollYtdMonth, type PayrollYtdResponse } from '@/lib/payrollApi';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { StackedBarChart } from '@/components/ui/charts';
import { ListTemplate } from '@/components/templates';
import { DataGrid } from '@/components/ui/DataGrid';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { TaxYearSelect } from '@/components/ui/TaxYearSelect';
import { fmtDateOnlyRange, fmtMoney, fmtMonthShortYear } from '@/lib/format';
import { useTerm } from '@/lib/auth';
import { urlNumber, useUrlState } from '@/lib/useUrlState';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';

const fmt = fmtMoney;

const YEAR_CODEC = urlNumber({ min: 2000, max: 2100, integer: true });

export function PayrollYtd() {
  const term = useTerm();
  const currentYear = new Date().getUTCFullYear();
  // The year is in the URL (?year=2025): Year-end links here for its tax year.
  const [year, setYear] = useUrlState<number>('year', currentYear, YEAR_CODEC);

  const dataQuery = useQuery({
    queryKey: ['PayrollYtd', 'data', year],
    queryFn: () => getPayrollYtd(year),
  });
  const data: PayrollYtdResponse | null = dataQuery.data ? dataQuery.data : null;
  const missing = data?.notInReport ?? [];

  return (
    // `print-area` opts this page into the global print stylesheet's
    // allowlist (index.css @media print hides everything else). Without
    // it the Print button produced a blank page.
    <ListTemplate
        className="print:max-w-none print-area"
        title={`Year-to-date payroll · ${year}`}
        subtitle={`Each ${term('worker').toLowerCase()}’s pay and withholding for the tax year, from every paycheck paid in it.`}
        actions={[{ key: 'print', label: 'Print', icon: Printer, onSelect: () => window.print() }]}
        filters={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <span className="text-sm text-ink-muted">Tax year</span>
            <TaxYearSelect value={year} onChange={setYear} since={2020} span={5} />
          </div>
        }
      >

      {dataQuery.isError && <QueryError what="the year-to-date report" query={dataQuery} />}

      {!data && !dataQuery.isError && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-12" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}

      {data && (
        <>
          {/* A paid run whose paychecks don't back its totals isn't in a report built from paychecks: said, not a silent $0. */}
          {missing.length > 0 && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-alert/40 bg-alert/[0.06] p-3 text-sm" data-testid="ytd-not-in-report">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  {missing.length === 1
                    ? `1 paid run isn’t in these numbers: it records ${fmt(missing[0]!.totalGross)} gross with ${missing[0]!.paychecks === 0 ? 'no paychecks' : 'paychecks that don’t add up to it'}.`
                    : `${missing.length} paid runs aren’t in these numbers: their recorded totals (${fmt(missing.reduce((a, r) => a + r.totalGross, 0))} gross) have no matching paychecks.`}
                </p>
                <ul className="mt-1 flex flex-wrap gap-x-3 text-xs">
                  {missing.slice(0, 5).map((r) => (
                    <li key={r.id}>
                      <Link to={`/payroll/runs/${r.id}`} className="text-accent underline underline-offset-2">
                        {fmtDateOnlyRange(r.periodStart, r.periodEnd)} run
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <MetricStrip label={`Year-to-date ${year}`}>
            <MetricCard label={term('workers')} value={String(data.totals.associateCount)} />
            <MetricCard label="Paystubs" value={String(data.totals.paystubCount)} />
            <MetricCard label="Gross" value={fmt(data.totals.gross)} />
            <MetricCard label="Net" value={fmt(data.totals.net)} />
            <MetricCard label="Federal income tax" value={fmt(data.totals.fit)} />
            {/* The API's "fica" is the Social Security share alone (Medicare is its own figure). */}
            <MetricCard label="Social Security" value={fmt(data.totals.fica)} />
            <MetricCard label="Medicare" value={fmt(data.totals.medicare)} />
            <MetricCard label="State income tax" value={fmt(data.totals.sit)} />
          </MetricStrip>

          {data.monthly && <MonthlyChart months={data.monthly} year={year} />}

              <DataGrid<PayrollYtdResponse['rows'][number]>
                id="payroll-ytd"
                caption={`Year-to-date payroll by ${term('worker').toLowerCase()}, ${year}`}
                noun={{ one: term('worker').toLowerCase(), many: term('workers').toLowerCase() }}
                rows={data.rows}
                rowKey={(r) => r.associateId}
                search={{ placeholder: 'Search by name or email' }}
                urlKey="ytd"
                exportCsv={{ filename: `payroll-ytd-${year}` }}
                empty={{ title: `No paychecks paid in ${year} yet`, description: missing.length > 0 ? 'The paid run above has no paychecks to count.' : 'People appear here once a run pays them.' }}
                columns={[
                  {
                    key: 'associate',
                    header: term('worker'),
                    accessor: (r) => `${r.firstName} ${r.lastName} ${r.email}`,
                    sortable: true,
                    primary: true,
                    cell: (r) => (
                      <>
                        <Link to={`/people?associateId=${r.associateId}`} className="hover:underline">
                          {r.firstName} {r.lastName}
                        </Link>
                        <div className="text-xs text-ink-muted">{r.email}</div>
                      </>
                    ),
                  },
                  { key: 'paystubs', header: 'Paystubs', accessor: (r) => r.paystubCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                  { key: 'gross', header: 'Gross', accessor: (r) => Number(r.gross), csv: (r) => fmt(r.gross), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (r) => fmt(r.gross) },
                  { key: 'fit', header: 'Federal income tax', accessor: (r) => Number(r.fit), csv: (r) => fmt(r.fit), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmt(r.fit) },
                  { key: 'fica', header: 'Social Security', accessor: (r) => Number(r.fica), csv: (r) => fmt(r.fica), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmt(r.fica) },
                  { key: 'medicare', header: 'Medicare', accessor: (r) => Number(r.medicare), csv: (r) => fmt(r.medicare), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmt(r.medicare) },
                  { key: 'sit', header: 'State income tax', accessor: (r) => Number(r.sit), csv: (r) => fmt(r.sit), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmt(r.sit) },
                  { key: 'preTax', header: 'Pre-tax', accessor: (r) => Number(r.preTax), csv: (r) => fmt(r.preTax), sortable: true, searchable: false, align: 'right', defaultHidden: true, className: 'tabular-nums', cell: (r) => fmt(r.preTax) },
                  { key: 'postTax', header: 'Post-tax', accessor: (r) => Number(r.postTax), csv: (r) => fmt(r.postTax), sortable: true, searchable: false, align: 'right', defaultHidden: true, className: 'tabular-nums', cell: (r) => fmt(r.postTax) },
                  { key: 'net', header: 'Net', accessor: (r) => Number(r.net), csv: (r) => fmt(r.net), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums font-medium', cell: (r) => fmt(r.net) },
                ]}
              />
        </>
      )}
    </ListTemplate>
  );
}

/** Month by month: each column is the month's gross, split into take-home, taxes and deductions. */
function MonthlyChart({ months, year }: { months: PayrollYtdMonth[]; year: number }) {
  const now = new Date();
  const through = year < now.getUTCFullYear() ? 12 : year > now.getUTCFullYear() ? 0 : now.getUTCMonth() + 1;
  const rows = months.slice(0, through).map((m) => ({
    ...m,
    label: fmtMonthShortYear(new Date(year, Number(m.month.slice(5, 7)) - 1, 15)),
  }));
  if (!rows.some((r) => r.gross > 0)) return null;
  const peak = rows.reduce((a, b) => (b.gross > a.gross ? b : a), rows[0]!);
  return (
    <div className="mb-4 print:break-inside-avoid">
      <ChartFrame
        title="Month by month"
        description="Gross pay by payout month, split into take-home pay, taxes withheld and other deductions."
        summary={`${year} so far: the biggest month was ${peak.label} at ${fmtMoney(peak.gross)} gross.`}
        columns={[
          { key: 'label', label: 'Month' },
          { key: 'runs', label: 'Runs', numeric: true },
          { key: 'gross', label: 'Gross', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'tax', label: 'Taxes withheld', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'deductions', label: 'Other deductions', numeric: true, format: (v) => fmtMoney(v as number) },
          { key: 'net', label: 'Net', numeric: true, format: (v) => fmtMoney(v as number) },
        ]}
        rows={rows}
        csvName={`payroll-monthly-${year}`}
        height={240}
      >
        <StackedBarChart
          data={rows}
          x="label"
          series={[
            { key: 'net', name: 'Take-home pay' },
            { key: 'tax', name: 'Taxes withheld' },
            { key: 'deductions', name: 'Other deductions' },
          ]}
          format={fmtMoneyAxis}
          yLabel="Dollars"
        />
      </ChartFrame>
    </div>
  );
}
