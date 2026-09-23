import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { getPayrollYtd, type PayrollYtdResponse } from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { DataGrid } from '@/components/ui/DataGrid';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { fmtMoney } from '@/lib/format';

const fmt = fmtMoney;

export function PayrollYtd() {
  const currentYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(currentYear);
  const [data, setData] = useState<PayrollYtdResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getPayrollYtd(year)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : "Couldn't load YTD report.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

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
    <div className="mx-auto print:max-w-none print-area">
      <PageHeader
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
      />

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
              <Stat label="Associates" value={String(data.totals.associateCount)} />
              <Stat label="Paystubs" value={String(data.totals.paystubCount)} />
              <Stat label="Gross" value={fmt(data.totals.gross)} />
              <Stat label="Net" value={fmt(data.totals.net)} />
              <Stat label="Federal income tax" value={fmt(data.totals.fit)} />
              <Stat label="FICA" value={fmt(data.totals.fica)} />
              <Stat label="Medicare" value={fmt(data.totals.medicare)} />
              <Stat label="State income tax" value={fmt(data.totals.sit)} />
            </CardContent>
          </Card>

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
                caption={`Year-to-date payroll by associate, ${year}`}
                rows={filtered}
                rowKey={(r) => r.associateId}
                search={false}
                urlState={false}
                exportCsv={{ filename: `payroll-ytd-${year}` }}
                empty={{ title: q ? 'No matches.' : `No disbursed paystubs for ${year} yet.` }}
                columns={[
                  {
                    key: 'associate',
                    header: 'Associate',
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
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-widest text-silver/70">{label}</div>
      <div className="text-sm text-silver tabular-nums">{value}</div>
    </div>
  );
}
