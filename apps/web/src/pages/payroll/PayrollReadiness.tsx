import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Download, XCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  getPayrollReadiness,
  type PayrollReadinessResponse,
  type PayrollReadinessRow,
} from '@/lib/payrollApi';
import { downloadPayrollCensus } from '@/lib/orgApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
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
import { toast } from '@/components/ui/Toaster';

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
        secondaryActions={<CensusExportDialog />}
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
                      <TableHead className="text-center hidden md:table-cell">W-4 / TIN</TableHead>
                      <TableHead className="text-center hidden md:table-cell">Tax state</TableHead>
                      <TableHead className="text-center hidden md:table-cell">Payout</TableHead>
                      <TableHead className="text-center hidden md:table-cell">Schedule</TableHead>
                      <TableHead className="text-center hidden md:table-cell">User</TableHead>
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
        {!row.ready && (
          <div className="md:hidden text-[11px] text-silver/70 truncate">
            Missing:{' '}
            {[
              !row.flags.w4OnFile &&
                (row.employmentType === 'W2_EMPLOYEE' ? 'W-4' : 'TIN'),
              !row.flags.taxStateSet && 'tax state',
              !row.flags.payoutMethodOnFile && 'payout',
              !row.flags.payScheduleAssigned && 'schedule',
              !row.flags.userLinked && 'user',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={row.employmentType === 'W2_EMPLOYEE' ? 'default' : 'pending'}>
          {row.employmentType === 'W2_EMPLOYEE' ? 'W-2' : '1099'}
        </Badge>
      </TableCell>
      <Flag ok={row.flags.w4OnFile} href={profileUrl} title={w4Label} className="hidden md:table-cell" />
      <Flag ok={row.flags.taxStateSet} href={profileUrl} title="Tax state missing or unsupported" className="hidden md:table-cell" />
      <Flag
        ok={row.flags.payoutMethodOnFile}
        href={profileUrl}
        title="No Branch card or bank account on file"
        className="hidden md:table-cell"
      />
      <Flag
        ok={row.flags.payScheduleAssigned}
        href={profileUrl}
        title="No pay schedule assigned"
        className="hidden md:table-cell"
      />
      <Flag ok={row.flags.userLinked} href={profileUrl} title="No user account linked" className="hidden md:table-cell" />
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

function Flag({
  ok,
  href,
  title,
  className,
}: {
  ok: boolean;
  href: string;
  title: string;
  className?: string;
}) {
  if (ok) {
    return (
      <TableCell className={`text-center ${className ?? ''}`}>
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
    <TableCell className={`text-center ${className ?? ''}`}>
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

/**
 * Bulk census export for onboarding a new payroll provider. The button lives
 * here because this page is already the "is everyone ready to be paid" surface
 * and is gated on process:payroll — the same capability the export requires.
 *
 * The dialog forces a written reason before the download because the file it
 * produces holds every active associate's full SSN + bank account. The server
 * logs that reason and the exact roster to /audit; the copy here makes the
 * sensitivity explicit so nobody pulls it casually.
 */
function CensusExportDialog() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const reasonOk = reason.trim().length >= 8;

  async function handleExport() {
    if (!reasonOk || busy) return;
    setBusy(true);
    try {
      const { rowCount, decryptFailures } = await downloadPayrollCensus(reason.trim());
      if (decryptFailures > 0) {
        toast.warning(
          `Exported ${rowCount} associate${rowCount === 1 ? '' : 's'}, but ${decryptFailures} record${
            decryptFailures === 1 ? '' : 's'
          } could not be decrypted (marked DECRYPT_ERROR). Have those associates re-enter their details.`,
        );
      } else {
        toast.success(
          `Exported ${rowCount} active associate${rowCount === 1 ? '' : 's'}. Upload it to your provider's secure portal, then delete the file.`,
        );
      }
      setOpen(false);
      setReason('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Download className="h-4 w-4" aria-hidden="true" />
        Export census
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export payroll census</DialogTitle>
          <DialogDescription>
            Downloads a CSV of every <strong>active</strong> associate&rsquo;s full SSN,
            address, and bank routing/account number — for handing to a payroll provider.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          This file contains unencrypted SSNs and bank accounts. Upload it to the
          provider&rsquo;s secure portal — never email it — and delete your copy once the
          import is confirmed. This export is logged to the audit trail with your reason
          and the full list of associates included.
        </div>

        <div className="space-y-1.5">
          <label htmlFor="census-reason" className="text-sm font-medium text-white">
            Reason for this export
          </label>
          <textarea
            id="census-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Trial import for Acme Payroll — new provider evaluation"
            className="w-full rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm text-white placeholder:text-silver/50 focus:outline-none focus:ring-2 focus:ring-gold-bright"
          />
          <p className="text-xs text-silver">
            Recorded in the audit log. Minimum 8 characters.
          </p>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="primary"
            size="sm"
            onClick={handleExport}
            disabled={!reasonOk || busy}
            loading={busy}
          >
            Download CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Default export so the route file can lazy-import without a named binding.
export default PayrollReadiness;
