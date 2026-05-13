import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  getPayrollReadiness,
  type PayrollReadinessResponse,
  type PayrollReadinessRow,
} from '@/lib/payrollApi';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
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

/**
 * Payroll readiness dashboard. Read-only.
 *
 * One row per active associate, with five green-check / red-X flags
 * for the data HR needs in place before a payroll run can succeed:
 * W-4 (or TIN for 1099s), tax state, payout method, pay schedule, and
 * a linked user account. Clicking a red flag deep-links to the People
 * directory drawer for that associate so HR can fix the gap before
 * the next run is created.
 */
export function PayrollReadiness() {
  const [data, setData] = useState<PayrollReadinessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPayrollReadiness()
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Failed to load.'));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payroll readiness"
        subtitle="Every active associate, with the five data points payroll needs. Fix any red flags before creating a run."
        breadcrumbs={[{ label: 'Payroll' }, { label: 'Readiness' }]}
      />

      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-alert">{error}</CardContent>
        </Card>
      )}

      {!data && !error && (
        <Card>
          <CardContent className="space-y-2 py-4">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-6 w-2/3" />
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <ReadinessSummary data={data} />
          {data.rows.length === 0 ? (
            <Card>
              <CardContent className="py-6">
                <EmptyState
                  title="No active associates"
                  description="Once associates are added and not soft-deleted, they appear here."
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Associate</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-center">W-4 / TIN</TableHead>
                      <TableHead className="text-center">Tax state</TableHead>
                      <TableHead className="text-center">Payout</TableHead>
                      <TableHead className="text-center">Schedule</TableHead>
                      <TableHead className="text-center">User</TableHead>
                      <TableHead className="text-center">Ready</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((row) => (
                      <ReadinessTableRow key={row.associateId} row={row} />
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function ReadinessSummary({ data }: { data: PayrollReadinessResponse }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 text-sm">
        <div>
          <span className="font-semibold text-white">{data.readyCount}</span>
          <span className="text-silver"> of </span>
          <span className="font-semibold text-white">{data.total}</span>
          <span className="text-silver"> associates are ready to be paid.</span>
        </div>
        <div>
          {data.missingCount > 0 ? (
            <span className="text-warning">
              {data.missingCount} associate{data.missingCount === 1 ? '' : 's'} have missing data —
              action required.
            </span>
          ) : (
            <span className="text-success">All active associates have complete data.</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ReadinessTableRow({ row }: { row: PayrollReadinessRow }) {
  const profileUrl = `/people?associateId=${row.associateId}`;
  const w4Label =
    row.employmentType === 'W2_EMPLOYEE' ? 'W-4 missing' : 'W-9 / TIN missing';
  return (
    <TableRow>
      <TableCell className="font-medium text-white">
        {row.firstName} {row.lastName}
        <div className="text-xs text-silver">{row.email}</div>
      </TableCell>
      <TableCell>
        <Badge variant={row.employmentType === 'W2_EMPLOYEE' ? 'default' : 'pending'}>
          {row.employmentType === 'W2_EMPLOYEE' ? 'W-2' : '1099'}
        </Badge>
      </TableCell>
      <Flag ok={row.flags.w4OnFile} href={profileUrl} title={w4Label} />
      <Flag ok={row.flags.taxStateSet} href={profileUrl} title="Tax state missing or unsupported" />
      <Flag
        ok={row.flags.payoutMethodOnFile}
        href={profileUrl}
        title="No Branch card or bank account on file"
      />
      <Flag
        ok={row.flags.payScheduleAssigned}
        href={profileUrl}
        title="No pay schedule assigned"
      />
      <Flag ok={row.flags.userLinked} href={profileUrl} title="No user account linked" />
      <TableCell className="text-center">
        {row.ready ? (
          <Badge variant="success">Ready</Badge>
        ) : (
          <Badge variant="destructive">Action required</Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

function Flag({ ok, href, title }: { ok: boolean; href: string; title: string }) {
  if (ok) {
    return (
      <TableCell className="text-center">
        <CheckCircle2
          className="mx-auto h-5 w-5 text-success"
          aria-label="Complete"
          role="img"
        />
      </TableCell>
    );
  }
  // Red — clickable link to the associate profile so HR can fix the gap.
  return (
    <TableCell className="text-center">
      <Link
        to={href}
        title={title}
        aria-label={title}
        className="inline-flex items-center justify-center rounded hover:bg-alert/10 focus:outline-none focus:ring-2 focus:ring-alert"
      >
        <XCircle className="h-5 w-5 text-alert" />
      </Link>
    </TableCell>
  );
}

// Default export so the route file can lazy-import without a named binding.
export default PayrollReadiness;
