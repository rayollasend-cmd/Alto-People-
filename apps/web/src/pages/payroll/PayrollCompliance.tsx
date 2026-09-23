import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileText, Landmark, Scale, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import {
  downloadNewHireReportCsv,
  downloadRemittanceAdvice,
  downloadTaxDepositWorksheet,
  getNewHireReport,
  listGarnishmentRemittances,
  listTaxDeposits,
  markNewHiresReported,
  markRemittanceSent,
  markTaxDepositPaid,
  type GarnishmentRemittance,
  type NewHireRow,
  type TaxDeposit,
} from '@/lib/payrollApi';
import { fmtDate, fmtMoney, parseYmd } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  Select,
  CardContent,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SkeletonRows,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

/**
 * Tier-1 compliance cockpit — the three deadline-driven queues that used
 * to exist only as API endpoints: federal tax deposits (trust-fund money
 * on IRS deadlines), garnishment remittances owed to agencies, and state
 * new-hire reporting (20-day rule). Everything overdue is loud.
 */

const money = fmtMoney;

type Tab = 'deposits' | 'remittances' | 'newhire';

export function PayrollCompliance() {
  const [tab, setTab] = useState<Tab>('deposits');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Payroll compliance"
        subtitle="Federal tax deposits, garnishment remittances, and state new-hire reporting — every deadline in one place."
        breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Compliance' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="deposits">
            <Landmark className="mr-2 h-4 w-4" /> Tax deposits
          </TabsTrigger>
          <TabsTrigger value="remittances">
            <Scale className="mr-2 h-4 w-4" /> Garnishment remittances
          </TabsTrigger>
          <TabsTrigger value="newhire">
            <UserPlus className="mr-2 h-4 w-4" /> New-hire reporting
          </TabsTrigger>
        </TabsList>
        <TabsContent value="deposits">
          <TaxDepositsTab />
        </TabsContent>
        <TabsContent value="remittances">
          <RemittancesTab />
        </TabsContent>
        <TabsContent value="newhire">
          <NewHireTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ===== Tax deposits ======================================================= */

function TaxDepositsTab() {
  const prompt = usePrompt();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [deposits, setDeposits] = useState<TaxDeposit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = useCallback(() => {
    setDeposits(null);
    setError(null);
    setSelectedIds(new Set());
    listTaxDeposits(year)
      .then((r) => setDeposits(r.deposits))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load tax deposits.'),
      );
  }, [year]);
  useEffect(refresh, [refresh]);

  const overdueCount = deposits?.filter((d) => d.overdue).length ?? 0;
  const pendingTotal = useMemo(
    () =>
      (deposits ?? [])
        .filter((d) => d.status === 'PENDING')
        .reduce((s, d) => s + d.amount, 0),
    [deposits],
  );

  const onMarkPaid = async (d: TaxDeposit) => {
    const ack = await prompt({
      title: `Mark ${money(d.amount)} deposit paid`,
      description:
        'Pay through EFTPS (or your bank) first, then record the acknowledgment number here. This is the trust-fund audit trail.',
      reasonLabel: 'EFTPS acknowledgment number',
      reasonPlaceholder: 'e.g. 270123456789012',
      required: false,
    });
    if (ack === null) return;
    setBusyId(d.id);
    try {
      await markTaxDepositPaid(d.id, ack.trim() || null);
      toast.success('Deposit marked paid.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to mark paid.');
    } finally {
      setBusyId(null);
    }
  };


  const selectedPending = (deposits ?? []).filter(
    (d) => d.status === 'PENDING' && selectedIds.has(d.id),
  );

  const onBulkMarkPaid = async () => {
    if (bulkBusy || selectedPending.length === 0) return;
    const n = selectedPending.length;
    const ack = await prompt({
      title: `Mark ${n} deposit${n === 1 ? '' : 's'} paid`,
      description:
        'Pay through EFTPS (or your bank) first. One acknowledgment reference is recorded on every selected deposit — leave it blank to record none.',
      reasonLabel: 'EFTPS acknowledgment number (applied to all selected)',
      reasonPlaceholder: 'e.g. 270123456789012',
      required: false,
    });
    if (ack === null) return;
    setBulkBusy(true);
    let done = 0;
    let firstError: string | null = null;
    for (const d of selectedPending) {
      setBusyId(d.id);
      try {
        await markTaxDepositPaid(d.id, ack.trim() || null);
        done += 1;
      } catch (err) {
        if (!firstError) {
          firstError = err instanceof ApiError ? err.message : 'Request failed.';
        }
      }
    }
    setBusyId(null);
    setBulkBusy(false);
    if (firstError) {
      toast.error(
        `${done} of ${n} deposit${n === 1 ? '' : 's'} marked paid — first failure: ${firstError}`,
      );
    } else {
      toast.success(`${done} deposit${done === 1 ? '' : 's'} marked paid.`);
    }
    refresh();
  };

  return (
    <Card>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-sm text-silver">
            <label htmlFor="deposit-year" className="font-medium">
              Year
            </label>
            <Select
              id="deposit-year"
              className="w-28"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {[0, 1, 2].map((back) => {
                const y = new Date().getFullYear() - back;
                return (
                  <option key={y} value={y}>
                    {y}
                  </option>
                );
              })}
            </Select>
            {deposits && (
              <span>
                {money(pendingTotal)} pending
                {overdueCount > 0 && (
                  <Badge variant="destructive" className="ml-2">
                    {overdueCount} overdue
                  </Badge>
                )}
              </span>
            )}
          </div>
          {selectedPending.length > 0 && (
            <Button size="sm" onClick={onBulkMarkPaid} loading={bulkBusy} disabled={bulkBusy}>
              <CheckCircle2 className="h-4 w-4" />
              Mark {selectedPending.length} selected paid
            </Button>
          )}
        </div>
        {error && (
          <ErrorBanner
            className="mb-3"
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        )}
        {!deposits && !error && <SkeletonRows count={4} rowHeight="h-12" />}
        {deposits && deposits.length === 0 && (
          <EmptyState
            icon={Landmark}
            title="No deposit obligations yet"
            description="Deposits accrue automatically when a payroll run disburses — FIT plus both halves of FICA and Medicare, on the IRS deposit schedule."
          />
        )}
        {deposits && deposits.length > 0 && (
          <div className="p-3">
            {/* The page keeps the selection — its bulk "Mark paid" reads it —
                so the grid is told which deposits are chosen and draws no
                bar of its own. Only a pending deposit can be chosen. */}
            <DataGrid<TaxDeposit>
              id="tax-deposits"
              caption="Federal tax deposits"
              rows={deposits}
              rowKey={(d) => d.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'federal-tax-deposits' }}
              selectable={{
                disabled: (d) => d.status !== 'PENDING',
                selection: { selected: selectedIds, onChange: setSelectedIds },
              }}
              columns={[
                {
                  key: 'kind',
                  header: 'Kind',
                  accessor: (d) => (d.kind === 'FED_941' ? 'Form 941' : 'FUTA'),
                  sortable: true,
                  primary: true,
                  cell: (d) => (
                    <>
                      <div className="font-medium text-white">{d.kind === 'FED_941' ? 'Form 941' : 'FUTA'}</div>
                      <div className="text-xs text-silver">{d.periodLabel}</div>
                    </>
                  ),
                },
                {
                  key: 'liability',
                  header: 'Liability',
                  accessor: (d) => d.liabilityDate,
                  sortable: true,
                  searchable: false,
                  className: 'text-silver whitespace-nowrap',
                  cell: (d) => fmtDate(parseYmd(d.liabilityDate)),
                },
                {
                  key: 'due',
                  header: 'Due',
                  accessor: (d) => d.dueDate,
                  sortable: true,
                  searchable: false,
                  cardMeta: true,
                  className: 'whitespace-nowrap',
                  cell: (d) => (
                    <>
                      <span className={d.overdue ? 'font-medium text-alert' : undefined}>{fmtDate(parseYmd(d.dueDate))}</span>
                      {d.overdue && (
                        <Badge variant="destructive" className="ml-2">
                          Overdue
                        </Badge>
                      )}
                    </>
                  ),
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  accessor: (d) => Number(d.amount),
                  csv: (d) => money(d.amount),
                  sortable: true,
                  searchable: false,
                  align: 'right',
                  className: 'tabular-nums text-white',
                  cell: (d) => money(d.amount),
                },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (d) => (d.status === 'PAID' ? 'Paid' : 'Pending'),
                  sortable: true,
                  cell: (d) => <Badge variant={d.status === 'PAID' ? 'success' : 'pending'}>{d.status === 'PAID' ? 'Paid' : 'Pending'}</Badge>,
                },
                {
                  key: 'confirmation',
                  header: 'Confirmation',
                  accessor: (d) => d.confirmationNumber,
                  sortable: true,
                  className: 'text-xs text-silver',
                  cell: (d) => d.confirmationNumber ?? '—',
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (d) => (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          downloadTaxDepositWorksheet(d.id).catch((err) =>
                            toast.error(err instanceof Error ? err.message : 'Download failed.'),
                          )
                        }
                        title="EFTPS keying worksheet"
                      >
                        <FileText className="h-4 w-4" />
                        Worksheet
                      </Button>
                      {d.status === 'PENDING' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busyId === d.id}
                          disabled={busyId === d.id || bulkBusy}
                          onClick={() => onMarkPaid(d)}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          Mark paid
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ===== Garnishment remittances =========================================== */

function RemittancesTab() {
  const prompt = usePrompt();
  const [remittances, setRemittances] = useState<GarnishmentRemittance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showSent, setShowSent] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = useCallback(() => {
    setRemittances(null);
    setError(null);
    setSelectedIds(new Set());
    listGarnishmentRemittances()
      .then((r) => setRemittances(r.remittances))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load remittances.'),
      );
  }, []);
  useEffect(refresh, [refresh]);

  const visible = (remittances ?? []).filter((r) => showSent || r.status === 'PENDING');
  const pendingTotal = (remittances ?? [])
    .filter((r) => r.status === 'PENDING')
    .reduce((s, r) => s + r.amount, 0);

  const onMarkSent = async (r: GarnishmentRemittance) => {
    const reference = await prompt({
      title: `Mark ${money(r.amount)} to ${r.payeeName} as sent`,
      description:
        'Send the payment first (check or agency portal), then record the check number or portal confirmation here.',
      reasonLabel: 'Payment reference',
      reasonPlaceholder: 'e.g. check #1042 / portal conf. 88213',
      required: false,
    });
    if (reference === null) return;
    setBusyId(r.id);
    try {
      await markRemittanceSent(r.id, reference.trim() || null);
      toast.success('Remittance marked sent.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to mark sent.');
    } finally {
      setBusyId(null);
    }
  };


  const selectedPending = (remittances ?? []).filter(
    (r) => r.status === 'PENDING' && selectedIds.has(r.id),
  );

  const onBulkMarkSent = async () => {
    if (bulkBusy || selectedPending.length === 0) return;
    const n = selectedPending.length;
    const reference = await prompt({
      title: `Mark ${n} remittance${n === 1 ? '' : 's'} sent`,
      description:
        'Send the payments first (check or agency portal). One payment reference is recorded on every selected remittance — leave it blank to record none.',
      reasonLabel: 'Payment reference (applied to all selected)',
      reasonPlaceholder: 'e.g. check batch #1042 / portal conf. 88213',
      required: false,
    });
    if (reference === null) return;
    setBulkBusy(true);
    let done = 0;
    let firstError: string | null = null;
    for (const r of selectedPending) {
      setBusyId(r.id);
      try {
        await markRemittanceSent(r.id, reference.trim() || null);
        done += 1;
      } catch (err) {
        if (!firstError) {
          firstError = err instanceof ApiError ? err.message : 'Request failed.';
        }
      }
    }
    setBusyId(null);
    setBulkBusy(false);
    if (firstError) {
      toast.error(
        `${done} of ${n} remittance${n === 1 ? '' : 's'} marked sent — first failure: ${firstError}`,
      );
    } else {
      toast.success(`${done} remittance${done === 1 ? '' : 's'} marked sent.`);
    }
    refresh();
  };

  return (
    <Card>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm text-silver">
          <div>
            {remittances && (
              <>
                <span className="font-medium text-white">{money(pendingTotal)}</span> withheld and
                not yet remitted
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            {selectedPending.length > 0 && (
              <Button size="sm" onClick={onBulkMarkSent} loading={bulkBusy} disabled={bulkBusy}>
                <CheckCircle2 className="h-4 w-4" />
                Mark {selectedPending.length} selected sent
              </Button>
            )}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showSent}
                onChange={(e) => setShowSent(e.target.checked)}
              />
              Show sent
            </label>
          </div>
        </div>
        {error && (
          <ErrorBanner
            className="mb-3"
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        )}
        {!remittances && !error && <SkeletonRows count={4} rowHeight="h-12" />}
        {remittances && visible.length === 0 && (
          <EmptyState
            icon={Scale}
            title={showSent ? 'No remittances yet' : 'Nothing waiting to be sent'}
            description="Remittances accrue when a run with garnishment deductions disburses — one per payee, with the advice sheet the agency needs."
          />
        )}
        {remittances && visible.length > 0 && (
          <div className="p-3">
            <DataGrid<GarnishmentRemittance>
              id="garnishment-remittances"
              caption="Garnishment remittances"
              rows={visible}
              rowKey={(r) => r.id}
              search={{ placeholder: 'Payee, reference…' }}
              urlState={false}
              exportCsv={{ filename: 'garnishment-remittances' }}
              selectable={{
                disabled: (r) => r.status !== 'PENDING',
                selection: { selected: selectedIds, onChange: setSelectedIds },
              }}
              columns={[
                {
                  key: 'payee',
                  header: 'Payee',
                  accessor: (r) => r.payeeName,
                  sortable: true,
                  primary: true,
                  cell: (r) => (
                    <>
                      <div className="font-medium text-white">{r.payeeName}</div>
                      <div className="text-xs text-silver">
                        {r.deductionCount} deduction{r.deductionCount === 1 ? '' : 's'}
                        {r.reference ? ` · ref ${r.reference}` : ''}
                      </div>
                    </>
                  ),
                },
                {
                  key: 'period',
                  header: 'Pay period',
                  accessor: (r) => r.period.start,
                  csv: (r) => `${r.period.start} – ${r.period.end}`,
                  sortable: true,
                  searchable: false,
                  cardMeta: true,
                  className: 'text-silver whitespace-nowrap',
                  cell: (r) => `${fmtDate(parseYmd(r.period.start))} – ${fmtDate(parseYmd(r.period.end))}`,
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  accessor: (r) => Number(r.amount),
                  csv: (r) => money(r.amount),
                  sortable: true,
                  searchable: false,
                  align: 'right',
                  className: 'tabular-nums text-white',
                  cell: (r) => money(r.amount),
                },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (r) => (r.status === 'SENT' ? 'Sent' : 'Pending'),
                  sortable: true,
                  cell: (r) => <Badge variant={r.status === 'SENT' ? 'success' : 'pending'}>{r.status === 'SENT' ? 'Sent' : 'Pending'}</Badge>,
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (r) => (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          downloadRemittanceAdvice(r.id).catch((err) =>
                            toast.error(err instanceof Error ? err.message : 'Download failed.'),
                          )
                        }
                        title="Advice sheet listing each employee and case number"
                      >
                        <Download className="h-4 w-4" />
                        Advice
                      </Button>
                      {r.status === 'PENDING' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busyId === r.id}
                          disabled={busyId === r.id || bulkBusy}
                          onClick={() => onMarkSent(r)}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          Mark sent
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ===== New-hire reporting ================================================ */

function NewHireTab() {
  const confirm = useConfirm();
  // The CSV carries SSNs, so it moved to export:payroll-pii (HR + Finance)
  // while the tab itself stays on process:payroll (six roles). The other
  // four can still SEE who is unreported — names and hire dates, no PII —
  // which is the half of this tab that tells an ops manager to go chase
  // someone. They just cannot pull the file.
  const canExport = useAuth().can('export:payroll-pii');
  const [rows, setRows] = useState<NewHireRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setRows(null);
    setError(null);
    getNewHireReport()
      .then((r) => setRows(r.unreported))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load new-hire report.'),
      );
  }, []);
  useEffect(refresh, [refresh]);

  const reportable = (rows ?? []).filter((r) => r.reportable);
  const overdue = (rows ?? []).filter((r) => r.overdue);

  const onExportAndMark = async () => {
    if (reportable.length === 0) return;
    const ok = await confirm({
      title: `Export ${reportable.length} hire${reportable.length === 1 ? '' : 's'} and mark reported?`,
      description:
        'Downloads the multistate CSV (it contains SSNs — upload it to the state portal, then delete the local copy). Confirming marks these associates as reported.',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await downloadNewHireReportCsv();
      await markNewHiresReported(reportable.map((r) => r.associateId));
      toast.success(`${reportable.length} new hire${reportable.length === 1 ? '' : 's'} marked reported.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-silver">
            {rows && (
              <>
                <span className="font-medium text-white">{rows.length}</span> unreported hire
                {rows.length === 1 ? '' : 's'}
                {overdue.length > 0 && (
                  <Badge variant="destructive" className="ml-2">
                    <AlertTriangle className="mr-1 h-3 w-3" />
                    {overdue.length} past the 20-day deadline
                  </Badge>
                )}
              </>
            )}
          </div>
          {canExport ? (
            <Button
              size="sm"
              onClick={onExportAndMark}
              loading={busy}
              disabled={busy || reportable.length === 0}
            >
              <Download className="h-4 w-4" />
              Export CSV & mark reported
            </Button>
          ) : (
            // Not a disabled button: nothing they can do here makes it
            // clickable, so say who to ask instead of leaving them
            // hovering over a dead control.
            <span className="text-xs text-silver">
              Filing the CSV is restricted to HR and Finance.
            </span>
          )}
        </div>
        {error && (
          <ErrorBanner
            className="mb-3"
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        )}
        {!rows && !error && <SkeletonRows count={4} rowHeight="h-12" />}
        {rows && rows.length === 0 && (
          <EmptyState
            icon={UserPlus}
            title="All caught up"
            description="Every hire with a hire date has been reported to the state directory."
          />
        )}
        {rows && rows.length > 0 && (
          <div className="p-3">
            <DataGrid<NewHireRow>
              id="new-hire-reporting"
              caption="Unreported new hires"
              rows={rows}
              rowKey={(r) => r.associateId}
              search={{ placeholder: 'Name, state…' }}
              urlState={false}
              exportCsv={{ filename: 'unreported-new-hires' }}
              columns={[
                { key: 'name', header: 'Associate', accessor: (r) => r.name, sortable: true, primary: true, className: 'font-medium text-white' },
                {
                  key: 'hireDate',
                  header: 'Hire date',
                  accessor: (r) => r.hireDate,
                  sortable: true,
                  searchable: false,
                  cardMeta: true,
                  className: 'text-silver whitespace-nowrap',
                  cell: (r) => (r.hireDate ? fmtDate(parseYmd(r.hireDate)) : '—'),
                },
                { key: 'state', header: 'State', accessor: (r) => r.state, sortable: true, cardMeta: true, className: 'text-silver', cell: (r) => r.state ?? '—' },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (r) => (r.overdue ? 'overdue' : !r.reportable ? 'missing data' : 'ready'),
                  sortable: true,
                  cell: (r) => (
                    <div className="flex flex-wrap gap-1">
                      {r.overdue && <Badge variant="destructive">Overdue</Badge>}
                      {!r.reportable && (
                        <Badge variant="pending" title="Needs SSN, address, and state on file before the state can match the report">
                          Missing data
                        </Badge>
                      )}
                      {r.reportable && !r.overdue && <Badge variant="default">Ready</Badge>}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
