import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import type { PayrollConfig, PayrollConfigBracket } from '@alto-people/shared';
import { getPayrollConfig } from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { DataGrid } from '@/components/ui/DataGrid';

import { fmtDateTime, fmtMoney, fmtPercent } from '@/lib/format';

const fmtPct = (rate: number) => fmtPercent(rate, { fromFraction: true, decimals: 2 });

/**
 * Read-only view of the payroll_config row driving the federal withholding
 * engine right now. Lets HR sanity-check what's loaded without reading
 * migration SQL. Edits go through a database migration — yearly federal
 * tables come from IRS Pub 15-T, so this UI is intentionally display-only.
 */
export function PayrollConfigView() {

  const configQuery = useQuery({
    queryKey: ['PayrollConfigView', 'config'],
    queryFn: () => getPayrollConfig(),
  });
  const config: PayrollConfig | null = configQuery.data ?? null;
  const error = configQuery.error ? configQuery.error instanceof ApiError ? configQuery.error.message : 'Could not load payroll config.' : null;

  return (
    <div className="mx-auto">
      <PageHeader
        title="Payroll tax config"
        subtitle="Reference data driving the federal withholding engine. Read-only."
      />

      {error && (
        <ErrorBanner className="mb-4">
          <span className="font-medium">{error}</span>
          {' '}
          <span className="text-silver/80">
            Insert a payroll_config row for the current year via migration.
          </span>
        </ErrorBanner>
      )}

      {!config && !error && <ConfigSkeleton />}

      {config && (
        <>
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="text-base">Wage caps & thresholds</CardTitle>
              <CardDescription>
                Federal payroll tax constants for tax year {config.year}. Source: IRS Pub 15-T,
                SSA wage-base announcement.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <dt className="text-xs text-silver">Social Security wage base</dt>
                  <dd className="text-2xl text-white">{fmtMoney(config.ssWageBase)}</dd>
                  <p className="text-xs text-silver/70 mt-1">
                    Wages above this in YTD are not subject to the 6.2% Social Security tax.
                  </p>
                </div>
                <div>
                  <dt className="text-xs text-silver">Medicare surcharge threshold</dt>
                  <dd className="text-2xl text-white">
                    {fmtMoney(config.medicareSurchargeThreshold)}
                  </dd>
                  <p className="text-xs text-silver/70 mt-1">
                    Additional 0.9% Medicare withholding applies above this YTD threshold.
                  </p>
                </div>
              </dl>
            </CardContent>
          </Card>

          <BracketCard
            title="Federal — Single / Married Filing Separately"
            data={config.fedBracketsSingle}
          />
          <BracketCard
            title="Federal — Married Filing Jointly"
            data={config.fedBracketsMfj}
          />
          <BracketCard
            title="Federal — Head of Household"
            data={config.fedBracketsHoh}
          />

          <p className="text-xs text-silver/70 mt-6 flex items-start gap-2">
            <ShieldAlert className="h-3 w-3 mt-0.5 flex-shrink-0" />
            <span>
              Last updated {fmtDateTime(config.updatedAt)}. Edits go through a database
              migration — see <code className="text-silver">prisma/migrations/*_add_payroll_config</code>.
            </span>
          </p>
        </>
      )}
    </div>
  );
}

function BracketCard({ title, data }: { title: string; data: PayrollConfigBracket[] }) {
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          Annual percentage method. The engine annualizes per-cycle gross, picks the row, divides
          back per period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataGrid<PayrollConfigBracket>
          id={`tax-brackets-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
          caption={title}
          rows={data}
          rowKey={(row) => String(row.over)}
          search={false}
          urlState={false}
          exportCsv={false}
          columnChooser={false}
          columns={[
            { key: 'over', header: 'Over', accessor: (row) => row.over, csv: (row) => fmtMoney(row.over), sortable: true, searchable: false, primary: true, className: 'tabular-nums', cell: (row) => fmtMoney(row.over) },
            { key: 'flat', header: 'Flat', accessor: (row) => row.flat, csv: (row) => fmtMoney(row.flat), sortable: true, searchable: false, cardMeta: true, className: 'tabular-nums', cell: (row) => fmtMoney(row.flat) },
            { key: 'rate', header: 'Marginal rate', accessor: (row) => row.rate, csv: (row) => fmtPct(row.rate), sortable: true, searchable: false, cardMeta: true, className: 'tabular-nums', cell: (row) => fmtPct(row.rate) },
          ]}
        />
      </CardContent>
    </Card>
  );
}

function ConfigSkeleton() {
  return (
    <>
      <Card className="mb-4">
        <CardContent className="pt-5">
          <Skeleton className="h-3 w-1/3 mb-3" />
          <Skeleton className="h-8 w-1/2 mb-2" />
          <Skeleton className="h-3 w-2/3" />
        </CardContent>
      </Card>
      <Card className="mb-4">
        <CardContent className="pt-5">
          <Skeleton className="h-32" />
        </CardContent>
      </Card>
    </>
  );
}
