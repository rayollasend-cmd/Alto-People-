import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { getPayrollYtd, type PayrollYtdResponse } from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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
    <div className="max-w-7xl mx-auto print:max-w-none">
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Associate</TableHead>
                    <TableHead className="text-right">Paystubs</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">FIT</TableHead>
                    <TableHead className="text-right">FICA</TableHead>
                    <TableHead className="text-right">Medicare</TableHead>
                    <TableHead className="text-right">SIT</TableHead>
                    <TableHead className="text-right">Pre-tax</TableHead>
                    <TableHead className="text-right">Post-tax</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-silver/70">
                        {q
                          ? 'No matches.'
                          : `No disbursed paystubs for ${year} yet.`}
                      </TableCell>
                    </TableRow>
                  )}
                  {filtered.map((r) => (
                    <TableRow key={r.associateId}>
                      <TableCell>
                        <Link
                          to={`/people?associateId=${r.associateId}`}
                          className="hover:underline"
                        >
                          {r.firstName} {r.lastName}
                        </Link>
                        <div className="text-xs text-silver/70">{r.email}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.paystubCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(r.gross)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(r.fit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(r.fica)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt(r.medicare)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(r.sit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(r.preTax)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(r.postTax)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {fmt(r.net)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
      <div className="text-[10px] uppercase tracking-widest text-silver/70">{label}</div>
      <div className="text-sm text-silver tabular-nums">{value}</div>
    </div>
  );
}
