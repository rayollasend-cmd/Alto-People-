import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Download, XCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  getPayrollReadiness,
  type PayrollReadinessResponse,
  type PayrollReadinessRow,
  type ReadinessFlagKey,
  type ReadinessRequestItem,
} from '@/lib/payrollApi';
import { requestReadiness } from '@/lib/payrollDeskApi';
import { fmtDate } from '@/lib/format';
import { downloadPayrollCensus } from '@/lib/orgApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
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
import { Skeleton } from '@/components/ui/Skeleton';
import { DataGrid } from '@/components/ui/DataGrid';
import { ListTemplate } from '@/components/templates';
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
  // Many people at once (finance walk 4): pick rows, ask them all, or cover them with a schedule.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [requestOpen, setRequestOpen] = useState(false);
  const navigate = useNavigate();

  const dataQuery = useQuery({
    queryKey: ['PayrollReadiness', 'data'],
    queryFn: () => getPayrollReadiness(),
  });
  const data: PayrollReadinessResponse | null = dataQuery.data ? dataQuery.data : null;
  const error = dataQuery.error ? dataQuery.error instanceof ApiError ? dataQuery.error.message : 'Failed to load.' : null;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Payroll readiness"
        subtitle="Every active associate, with the five data points payroll needs. Fix any red flags before creating a run."
        breadcrumbs={[{ label: 'Payroll' }, { label: 'Readiness' }]}
        secondaryActions={<CensusExportDialog />}
    >

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
            onPickMissing={(flag) => setPicked(new Set(data.rows.filter((r) => !r.flags[flag]).map((r) => r.associateId)))}
          />
          <RequestDialog
            open={requestOpen}
            onOpenChange={setRequestOpen}
            rows={data.rows.filter((r) => picked.has(r.associateId))}
            onDone={() => setPicked(new Set())}
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
                  selectable={{
                    selectAllLabel: 'Select everyone shown',
                    selection: { selected: picked, onChange: setPicked },
                    actions: (ids, clear) => (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" onClick={() => setRequestOpen(true)}>
                          Request from {ids.length}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const noSchedule = ids.filter((id) => !data.rows.find((r) => r.associateId === id)?.flags.payScheduleAssigned);
                            if (noSchedule.length === 0) {
                              toast.info('Everyone picked is already on a pay schedule.');
                              return;
                            }
                            navigate(`/payroll/schedules?view=unassigned&people=${noSchedule.join(',')}`);
                          }}
                        >
                          Cover with a schedule rule
                        </Button>
                        <Button size="sm" variant="ghost" onClick={clear}>
                          Clear
                        </Button>
                      </div>
                    ),
                  }}
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
                      cell: (row) => <Flag ok={row.flags.w4OnFile} href={`/people?associateId=${row.associateId}&tab=documents`} title={row.employmentType === 'W2_EMPLOYEE' ? 'W-4 missing' : 'W-9 / TIN missing'} requested={requestedFor(row, 'w4')} />,
                    },
                    {
                      key: 'taxState',
                      header: 'Tax state',
                      accessor: (row) => (row.flags.taxStateSet ? 'Yes' : 'No'),
                      sortable: true,
                      searchable: false,
                      align: 'center',
                      stopRowClick: true,
                      cell: (row) => <Flag ok={row.flags.taxStateSet} href={`/people?associateId=${row.associateId}`} title="Tax state missing or unsupported" requested={requestedFor(row, 'address')} />,
                    },
                    {
                      key: 'payout',
                      header: 'Payout',
                      accessor: (row) => (row.flags.payoutMethodOnFile ? 'Yes' : 'No'),
                      sortable: true,
                      searchable: false,
                      align: 'center',
                      stopRowClick: true,
                      cell: (row) => <Flag ok={row.flags.payoutMethodOnFile} href={`/people?associateId=${row.associateId}&tab=documents`} title="No Branch card or bank account on file" requested={requestedFor(row, 'payout')} />,
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
    </ListTemplate>
  );
}

const MISSING_CHIPS: Array<{ flag: ReadinessFlagKey; label: string }> = [
  { flag: 'w4OnFile', label: 'W-4 missing' },
  { flag: 'taxStateSet', label: 'Tax state' },
  { flag: 'payoutMethodOnFile', label: 'Pay account' },
  { flag: 'payScheduleAssigned', label: 'Schedule' },
  { flag: 'userLinked', label: 'No sign-in' },
];

/** "Requested Oct 21" when payroll asked this person for the item and it is still missing. */
function requestedFor(row: PayrollReadinessRow, item: ReadinessRequestItem): string | null {
  return row.requested && row.requested.items.includes(item) ? row.requested.at : null;
}

function ReadinessSummary({
  data,
  actionOnly,
  onToggleActionOnly,
  onPickMissing,
}: {
  data: PayrollReadinessResponse;
  actionOnly: boolean;
  onToggleActionOnly: () => void;
  onPickMissing: (flag: ReadinessFlagKey) => void;
}) {
  const missing = MISSING_CHIPS.map((c) => ({ ...c, count: data.rows.filter((r) => !r.flags[c.flag]).length })).filter((c) => c.count > 0);
  return (
    <Card>
      {missing.length > 0 && (
        <CardContent className="flex flex-wrap items-center gap-2 border-b border-line py-2 text-xs" aria-label="What is missing, by column">
          <span className="text-ink-muted">Missing:</span>
          {missing.map((c) => (
            <button key={c.flag} type="button" onClick={() => onPickMissing(c.flag)} className="rounded-md border border-alert/40 bg-alert/5 px-2 py-1 text-alert hover:bg-alert/10" title={`Select the ${c.count} missing it`}>
              {c.label} {c.count}
            </button>
          ))}
        </CardContent>
      )}
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

function Flag({ ok, href, title, requested }: { ok: boolean; href: string; title: string; requested?: string | null }) {
  if (ok) {
    return <CheckCircle2 className="mx-auto h-5 w-5 text-success" aria-label="Complete" role="img" />;
  }
  if (requested) {
    return (
      <Link to={href} target="_blank" rel="noreferrer" title={`${title} — asked for on ${fmtDate(requested)}`} className="inline-flex flex-col items-center text-2xs text-warning">
        <XCircle className="h-4 w-4" aria-hidden="true" />
        Requested {fmtDate(requested)}
      </Link>
    );
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
          <Textarea
            id="census-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Trial import for Acme Payroll — new provider evaluation"
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

const ITEM_LABEL: Record<ReadinessRequestItem, string> = {
  w4: 'W-4 (federal withholding)',
  payout: 'Pay account (bank or pay card)',
  address: 'Home address (decides state taxes)',
};

/**
 * Ask everyone picked for what a paycheck needs, in one send: their W-4,
 * their pay account, their address. Each gets the onboarding task and a
 * notice; people with no sign-in are named, not silently skipped.
 */
function RequestDialog({ open, onOpenChange, rows, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; rows: PayrollReadinessRow[]; onDone: () => void }) {
  const qc = useQueryClient();
  const defaults = (): Set<ReadinessRequestItem> => {
    const s = new Set<ReadinessRequestItem>();
    if (rows.some((r) => !r.flags.w4OnFile)) s.add('w4');
    if (rows.some((r) => !r.flags.payoutMethodOnFile)) s.add('payout');
    if (rows.some((r) => !r.flags.taxStateSet)) s.add('address');
    return s.size ? s : new Set<ReadinessRequestItem>(['w4']);
  };
  const [items, setItems] = useState<Set<ReadinessRequestItem>>(defaults);
  // Each opening starts from what the picked people are missing.
  useEffect(() => {
    if (open) setItems(defaults());
    // defaults reads the rows of this opening; keyed on the opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const send = useMutation({
    mutationFn: () => requestReadiness(rows.map((r) => r.associateId), [...items]),
    onSuccess: (r) => {
      toast.success(`Asked ${r.requested} ${r.requested === 1 ? 'person' : 'people'}.${r.skipped.length ? ` ${r.skipped.length} skipped — ${r.skipped[0]!.reason}` : ''}`);
      void qc.invalidateQueries({ queryKey: ['PayrollReadiness', 'data'] });
      onDone();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not send the requests.'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request from {rows.length} {rows.length === 1 ? 'person' : 'people'}</DialogTitle>
          <DialogDescription>Each gets the task in their onboarding and a notice. The grid shows when you asked.</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="sr-only">What to ask for</legend>
          {(Object.keys(ITEM_LABEL) as ReadinessRequestItem[]).map((it) => (
            <label key={it} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={items.has(it)}
                onChange={(e) => {
                  const next = new Set(items);
                  if (e.target.checked) next.add(it);
                  else next.delete(it);
                  setItems(next);
                }}
              />
              {ITEM_LABEL[it]}
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" onClick={() => send.mutate()} loading={send.isPending} disabled={items.size === 0 || rows.length === 0}>
            Send requests
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Default export so the route file can lazy-import without a named binding.
export default PayrollReadiness;
