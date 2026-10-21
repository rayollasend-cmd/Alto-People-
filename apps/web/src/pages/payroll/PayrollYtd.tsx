import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { getPayrollYtd, type PayrollYtdMonth, type PayrollYtdResponse } from '@/lib/payrollApi';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { StackedBarChart } from '@/components/ui/charts';
import { ApiError } from '@/lib/api';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { DataGrid } from '@/components/ui/DataGrid';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { fmtMoney, fmtMoneyCompact, fmtMonthShortYear } from '@/lib/format';
import { useTerm } from '@/lib/auth';
import { MetricCard } from '@/components/ui/MetricCard';

const fmt = fmtMoney;

export function PayrollYtd() {
  const term = useTerm();
  const currentYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(currentYear);
  const [q, setQ] = useState('');

  const dataQuery = useQuery({
    queryKey: ['PayrollYtd', 'data', year],
    queryFn: () => getPayrollYtd(year),
  });
  const data: PayrollYtdResponse | null = dataQuery.data ? dataQuery.data : null;
  const error = dataQuery.error ? dataQuery.error instanceof ApiError ? dataQuery.error.message : "Couldn't load YTD report." : null;

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.rows;
    return data.rows.filter((r) =>
      `${r.firstName} ${r.lastName} ${r.email}`.toLowerCase().includes(needle),
    );
  }, [data, q]);

  return (
    // `print-area` opts this page into the global print stylesheet's
    // allowlist (index.css @media print hides everything else). Without
    // it the Print button produced a blank page.
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        className="print:max-w-none print-area"
        title={`Year-to-date payroll report — ${year}`}
        subtitle="Per-associate gross, withholding, and net pay aggregated across all disbursed runs in the tax year."
        breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'YTD report' }]}
        primaryAction={
          <div className="flex items-center gap-2 print:hidden">
            <Input
              type="number"
              min={2020}
              max={currentYear}
              value={year}
              onChange={(e) => setYear(Number(e.target.value) || currentYear)}
              className="w-24"
              aria-label="Tax year"
            />
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer className="h-4 w-4" />
              Print
            </Button>
          </div>
        }
      >

      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}

      {!data && !error && (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}

      {data && (
        <>
          <Card className="mb-4">
            <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm py-4">
              <Stat label={term('workers')} value={String(data.totals.associateCount)} />
              <Stat label="Paystubs" value={String(data.totals.paystubCount)} />
              <Stat label="Gross" value={fmt(data.totals.gross)} />
              <Stat label="Net" value={fmt(data.totals.net)} />
              <Stat label="Federal income tax" value={fmt(data.totals.fit)} />
              <Stat label="FICA" value={fmt(data.totals.fica)} />
              <Stat label="Medicare" value={fmt(data.totals.medicare)} />
              <Stat label="State income tax" value={fmt(data.totals.sit)} />
            </CardContent>
          </Card>

          {data.monthly && <MonthlyChart months={data.monthly} year={year} />}

          <div className="mb-3 print:hidden">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or email…"
              className="max-w-sm"
            />
          </div>

          <Card>
            <CardContent className="p-0">
              <DataGrid<(typeof filtered)[number]>
                id="payroll-ytd"
                caption={`Year-to-date payroll by ${term('worker').toLowerCase()}, ${year}`}
                rows={filtered}
                rowKey={(r) => r.associateId}
                search={false}
                urlState={false}
                exportCsv={{ filename: `payroll-ytd-${year}` }}
                empty={{ title: q ? 'No matches.' : `No disbursed paystubs for ${year} yet.` }}
                columns={[
                  {
                    key: 'associate',
                    header: term('worker'),
                    accessor: (r) => `${r.firstName} ${r.lastName}`,
                    sortable: true,
                    primary: true,
                    cell: (r) => (
                      <>
                        <Link to={`/people?associateId=${r.associateId}`} className="hover:underline">
                          {r.firstName} {r.lastName}
                        </Link>
                        <div className="text-xs text-silver/70">{r.email}</div>
                      </>
                    ),
                  },
                  { key: 'paystubs', header: 'Paystubs', accessor: (r) => r.paystubCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                  { key: 'gross', header: 'Gross', accessor: (r) => Number(r.gross), csv: (r) => fmt(r.gross), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (r) => fmt(r.gross) },
                  { key: 'fit', header: 'FIT', accessor: (r) => Number(r.fit), csv: (r) => fmt(r.fit), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmt(r.fit) },
                  { key: 'fica', header: 'FICA', accessor: (r) => Number(r.fica), csv: (r) => fmt(r.fica), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmt(r.fica) },
                  { key: 'medicare', header: 'Medicare', accessor: (r) => Number(r.medicare), csv: (r) => fmt(r.medicare), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmt(r.medicare) },
                  { key: 'sit', header: 'SIT', accessor: (r) => Number(r.sit), csv: (r) => fmt(r.sit), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmt(r.sit) },
                  { key: 'preTax', header: 'Pre-tax', accessor: (r) => Number(r.preTax), csv: (r) => fmt(r.preTax), sortable: true, searchable: false, align: 'right', defaultHidden: true, className: 'tabular-nums', cell: (r) => fmt(r.preTax) },
                  { key: 'postTax', header: 'Post-tax', accessor: (r) => Number(r.postTax), csv: (r) => fmt(r.postTax), sortable: true, searchable: false, align: 'right', defaultHidden: true, className: 'tabular-nums', cell: (r) => fmt(r.postTax) },
                  { key: 'net', header: 'Net', accessor: (r) => Number(r.net), csv: (r) => fmt(r.net), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums font-medium', cell: (r) => fmt(r.net) },
                ]}
              />
            </CardContent>
          </Card>
        </>
      )}
    </ListTemplate>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <MetricCard label={label} value={value} />;
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
          format={fmtMoneyCompact}
          yLabel="Dollars"
        />
      </ChartFrame>
    </div>
  );
}
