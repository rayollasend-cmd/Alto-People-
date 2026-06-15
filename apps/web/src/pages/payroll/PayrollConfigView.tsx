import { useEffect, useState } from 'react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const fmtPct = (rate: number) =>
  rate.toLocaleString('en-US', { style: 'percent', maximumFractionDigits: 2 });

/**
 * Read-only view of the payroll_config row driving the federal withholding
 * engine right now. Lets HR sanity-check what's loaded without reading
 * migration SQL. Edits go through a database migration — yearly federal
 * tables come from IRS Pub 15-T, so this UI is intentionally display-only.
 */
export function PayrollConfigView() {
  const [config, setConfig] = useState<PayrollConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    setError(null);
    getPayrollConfig()
      .then((res) => !cancelled && setConfig(res))
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load payroll config.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
                  <dd className="font-display text-2xl text-white">{fmtMoney(config.ssWageBase)}</dd>
                  <p className="text-xs text-silver/70 mt-1">
                    Wages above this in YTD are not subject to the 6.2% Social Security tax.
                  </p>
                </div>
                <div>
                  <dt className="text-xs text-silver">Medicare surcharge threshold</dt>
                  <dd className="font-display text-2xl text-white">
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
              Last updated {new Date(config.updatedAt).toLocaleString()}. Edits go through a database
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/4">Over</TableHead>
              <TableHead className="w-1/4">Flat</TableHead>
              <TableHead className="w-1/4">Marginal rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.over}>
                <TableCell className="tabular-nums">{fmtMoney(row.over)}</TableCell>
                <TableCell className="tabular-nums">{fmtMoney(row.flat)}</TableCell>
                <TableCell className="tabular-nums">{fmtPct(row.rate)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
