import { useQuery } from '@tanstack/react-query';
import { Info } from '@/components/ui/icons';
import type { PayrollConfig, PayrollConfigBracket } from '@alto-people/shared';
import { getPayrollConfig } from '@/lib/payrollApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { DataGrid } from '@/components/ui/DataGrid';
import { fmtDate, fmtMoney, fmtPercent } from '@/lib/format';

const fmtPct = (rate: number) => fmtPercent(rate, { fromFraction: true, decimals: 2 });

/**
 * Tax tables › Federal: the federal tables payroll withholds by this year —
 * the Social Security wage base, the extra Medicare threshold and the
 * income tax brackets — read-only, because Alto updates them each January
 * from IRS Publication 15-T. (It was its own page, "Payroll tax config",
 * at /payroll/config, with a footer about database migrations — F500 G3.)
 */
export function FederalTaxTables() {
  const q = useQuery({ queryKey: ['PayrollConfigView', 'config'], queryFn: () => getPayrollConfig() });
  const config: PayrollConfig | null = q.data ?? null;

  if (q.isError) return <QueryError what="the federal tax tables" query={q} />;
  if (!config) return <ConfigSkeleton />;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{`Wage limits for ${config.year}`}</CardTitle>
          <CardDescription>From the IRS (Publication 15-T) and the Social Security Administration.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-ink-muted">Social Security wage base</dt>
              <dd className="text-2xl tabular-nums text-ink">{fmtMoney(config.ssWageBase)}</dd>
              <p className="mt-1 text-xs text-ink-muted">Pay above this in a year has no 6.2% Social Security tax withheld.</p>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Extra Medicare threshold</dt>
              <dd className="text-2xl tabular-nums text-ink">{fmtMoney(config.medicareSurchargeThreshold)}</dd>
              <p className="mt-1 text-xs text-ink-muted">An extra 0.9% Medicare is withheld on pay above this in a year.</p>
            </div>
          </dl>
        </CardContent>
      </Card>

      <BracketCard title="Single or married filing separately" data={config.fedBracketsSingle} />
      <BracketCard title="Married filing jointly" data={config.fedBracketsMfj} />
      <BracketCard title="Head of household" data={config.fedBracketsHoh} />

      <p className="flex items-start gap-2 text-xs text-ink-muted">
        <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{`Updated each January from the IRS tables. Last updated ${fmtDate(config.updatedAt)}.`}</span>
      </p>
    </div>
  );
}

function BracketCard({ title, data }: { title: string; data: PayrollConfigBracket[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{`Federal income tax: ${title}`}</CardTitle>
        <CardDescription>A yearly table: each paycheck is scaled to a year, the tax is read from the row it falls in, then divided back across the year’s paychecks.</CardDescription>
      </CardHeader>
      <CardContent>
        <DataGrid<PayrollConfigBracket>
          id={`tax-brackets-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
          caption={`Federal income tax: ${title}`}
          rows={data}
          rowKey={(row) => String(row.over)}
          search={false}
          urlState={false}
          exportCsv={false}
          columnChooser={false}
          columns={[
            { key: 'over', header: 'Yearly pay over', accessor: (row) => row.over, csv: (row) => fmtMoney(row.over), sortable: true, searchable: false, primary: true, className: 'tabular-nums', cell: (row) => fmtMoney(row.over) },
            { key: 'flat', header: 'Tax on the amount below', accessor: (row) => row.flat, csv: (row) => fmtMoney(row.flat), sortable: true, searchable: false, cardMeta: true, className: 'tabular-nums', cell: (row) => fmtMoney(row.flat) },
            { key: 'rate', header: 'Plus, on the rest', accessor: (row) => row.rate, csv: (row) => fmtPct(row.rate), sortable: true, searchable: false, cardMeta: true, className: 'tabular-nums', cell: (row) => fmtPct(row.rate) },
          ]}
        />
      </CardContent>
    </Card>
  );
}

function ConfigSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Card>
        <CardContent>
          <Skeleton className="mb-3 h-3 w-1/3" />
          <Skeleton className="mb-2 h-8 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <Skeleton className="h-32" />
        </CardContent>
      </Card>
    </div>
  );
}
