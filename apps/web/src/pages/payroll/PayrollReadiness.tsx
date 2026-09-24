import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, Download, XCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
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
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { DataGrid } from '@/components/ui/DataGrid';
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
  // "Action required only" lens — the working view when the list is long
  // and only the red rows matter.
  const [actionOnly, setActionOnly] = useState(false);

  const dataQuery = useQuery({
    queryKey: ['PayrollReadiness', 'data'],
    queryFn: () => getPayrollReadiness(),
  });
  const data: PayrollReadinessResponse | null = dataQuery.data ? dataQuery.data : null;
  const error = dataQuery.error ? dataQuery.error instanceof ApiError ? dataQuery.error.message : 'Failed to load.' : null;

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
          <CardContent className="py-4">
            <ErrorBanner>{error}</ErrorBanner>
          </CardContent>
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
          <ReadinessSummary
            data={data}
            actionOnly={actionOnly}
            onToggleActionOnly={() => setActionOnly((v) => !v)}
          />
          {data.rows.length === 0 ? (
            <Card>
              <CardContent className="py-6">
                <EmptyState
                  title="No active associates"
                  description="Once associates are added and not soft-deleted, they appear here."
                />
              </CardContent>
            </Card>
          ) : (() => {
            const rows = actionOnly ? data.rows.filter((r) => !r.ready) : data.rows;
            return rows.length === 0 ? (
              <Card>
                <CardContent className="py-6">
                  <EmptyState
                    title="Everyone is ready"
                    description="No associate needs action — clear the filter to see the full roster."
                    action={
                      <Button variant="outline" size="sm" onClick={() => setActionOnly(false)}>
                        Show everyone
                      </Button>
                    }
                  />
                </CardContent>
              </Card>
            ) : (
            <Card>
              <CardContent className="p-0">
                <DataGrid<PayrollReadinessRow>
                  id="payroll-readiness"
                  caption="Payroll readiness by associate"
                  rows={rows}
                  rowKey={(row) => row.associateId}
                  search={{ placeholder: 'Name, email…' }}
                  urlState={false}
                  exportCsv={{ filename: 'payroll-readiness' }}
                  columns={[
                    {
                      key: 'associate',
                      header: 'Associate',
                      accessor: (row) => `${row.firstName} ${row.lastName}`,
                      sortable: true,
                      primary: true,
                      className: 'font-medium text-white',
                      cell: (row) => (
                        <>
                          {row.firstName} {row.lastName}
                          <div className="text-xs text-silver">{row.email}</div>
                        </>
                      ),
                    },
                    {
                      key: 'type',
                      header: 'Type',
                      accessor: (row) => (row.employmentType === 'W2_EMPLOYEE' ? 'W-2' : '1099'),
                      sortable: true,
                      cardMeta: true,
                      cell: (row) => <Badge variant={row.employmentType === 'W2_EMPLOYEE' ? 'default' : 'pending'}>{row.employmentType === 'W2_EMPLOYEE' ? 'W-2' : '1099'}</Badge>,
                    },
                    {
                      key: 'w4',
                      header: 'W-4 / TIN',
                      accessor: (row) => (row.flags.w4OnFile ? 'Yes' : 'No'),
                      sortable: true,
                      searchable: false,
                      align: 'center',
                      stopRowClick: true,
                      cell: (row) => <Flag ok={row.flags.w4OnFile} href={`/people?associateId=${row.associateId}&tab=documents`} title={row.employmentType === 'W2_EMPLOYEE' ? 'W-4 missing' : 'W-9 / TIN missing'} />,
                    },
                    {
                      key: 'taxState',
                      header: 'Tax state',
                      accessor: (row) => (row.flags.taxStateSet ? 'Yes' : 'No'),
                      sortable: true,
                      searchable: false,
                      align: 'center',
                      stopRowClick: true,
                      cell: (row) => <Flag ok={row.flags.taxStateSet} href={`/people?associateId=${row.associateId}`} title="Tax state missing or unsupported" />,
                    },
                    {
                      key: 'payout',
                      header: 'Payout',
                      accessor: (row) => (row.flags.payoutMethodOnFile ? 'Yes' : 'No'),
                      sortable: true,
                      searchable: false,
                      align: 'center',
                      stopRowClick: true,
                      cell: (row) => <Flag ok={row.flags.payoutMethodOnFile} href={`/people?associateId=${row.associateId}&tab=documents`} title="No Branch card or bank account on file" />,
                    },
                    {
                      key: 'schedule',
                      header: 'Schedule',
                      accessor: (row) => (row.flags.payScheduleAssigned ? 'Yes' : 'No'),
                      sortable: true,
                      searchable: false,
                      align: 'center',
                      stopRowClick: true,
                      cell: (row) => <Flag ok={row.flags.payScheduleAssigned} href={`/people?associateId=${row.associateId}`} title="No pay schedule assigned" />,
                    },
                    {
                      key: 'user',
                      header: 'User',
                      accessor: (row) => (row.flags.userLinked ? 'Yes' : 'No'),
                      sortable: true,
                      searchable: false,
                      align: 'center',
                      stopRowClick: true,
                      cell: (row) => <Flag ok={row.flags.userLinked} href={`/people?associateId=${row.associateId}`} title="No user account linked" />,
                    },
                    {
                      key: 'ready',
                      header: 'Ready',
                      accessor: (row) => (row.ready ? 'Ready' : 'Action required'),
                      sortable: true,
                      align: 'center',
                      cardMeta: true,
                      cell: (row) => (row.ready ? <Badge variant="success">Ready</Badge> : <Badge variant="destructive">Action required</Badge>),
                    },
                  ]}
                />
              </CardContent>
            </Card>
            );
          })()}
        </>
      )}
    </div>
  );
}

function ReadinessSummary({
  data,
  actionOnly,
  onToggleActionOnly,
}: {
  data: PayrollReadinessResponse;
  actionOnly: boolean;
  onToggleActionOnly: () => void;
}) {
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
        <div className="ml-auto">
          <Button
            size="sm"
            variant={actionOnly ? 'secondary' : 'ghost'}
            aria-pressed={actionOnly}
            onClick={onToggleActionOnly}
          >
            <XCircle className="h-3.5 w-3.5 text-alert" aria-hidden="true" />
            Action required only
            {data.missingCount > 0 ? ` (${data.missingCount})` : ''}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Flag({ ok, href, title }: { ok: boolean; href: string; title: string }) {
  if (ok) {
    return <CheckCircle2 className="mx-auto h-5 w-5 text-success" aria-label="Complete" role="img" />;
  }
  // Red — clickable link to the associate profile so HR can fix the gap.
  // Opens in a NEW TAB so this readiness list (and its filter) survives
  // the fix; come back and the row is still where you left it.
  return (
    <Link
      to={href}
      target="_blank"
      rel="noreferrer"
      title={`${title} — opens the profile in a new tab`}
      aria-label={title}
      className="inline-flex items-center justify-center rounded hover:bg-alert/10 focus:outline-none focus:ring-2 focus:ring-alert"
    >
      <XCircle className="h-5 w-5 text-alert" />
    </Link>
  );
}

/**
 * Bulk census export for onboarding a new payroll provider. The button lives
 * here because this page is already the "is everyone ready to be paid" surface.
 *
 * The page is gated on process:payroll, which six roles hold; the export is
 * gated on export:payroll-pii, which two do. It renders nothing for the other
 * four rather than handing them a button that 403s.
 *
 * The dialog forces a written reason before the download because the file it
 * produces holds every active associate's full SSN + bank account. The server
 * logs that reason and the exact roster to /audit; the copy here makes the
 * sensitivity explicit so nobody pulls it casually.
 */
function CensusExportDialog() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const reasonOk = reason.trim().length >= 8;

  if (!can('export:payroll-pii')) return null;

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
            Export CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Default export so the route file can lazy-import without a named binding.
export default PayrollReadiness;
