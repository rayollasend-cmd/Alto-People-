import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileText, Landmark, Scale, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
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
import {
  Badge,
  Button,
  Card,
  Select,
  CardContent,
  EmptyState,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

/**
 * Tier-1 compliance cockpit — the three deadline-driven queues that used
 * to exist only as API endpoints: federal tax deposits (trust-fund money
 * on IRS deadlines), garnishment remittances owed to agencies, and state
 * new-hire reporting (20-day rule). Everything overdue is loud.
 */

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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

  const refresh = useCallback(() => {
    setDeposits(null);
    setError(null);
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
        </div>
        {error && (
          <div role="alert" className="mb-3 rounded-md border border-alert/40 bg-alert/10 p-2 text-sm text-alert">
            {error}
          </div>
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
          <div className="overflow-x-auto">
            <Table caption="Federal tax deposits">
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Liability</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Confirmation</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deposits.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <div className="font-medium text-white">
                        {d.kind === 'FED_941' ? 'Form 941' : 'FUTA'}
                      </div>
                      <div className="text-xs text-silver">{d.periodLabel}</div>
                    </TableCell>
                    <TableCell className="text-silver">{d.liabilityDate}</TableCell>
                    <TableCell>
                      <span className={d.overdue ? 'font-medium text-alert' : undefined}>
                        {d.dueDate}
                      </span>
                      {d.overdue && (
                        <Badge variant="destructive" className="ml-2">
                          Overdue
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-white">
                      {money(d.amount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={d.status === 'PAID' ? 'success' : 'pending'}>
                        {d.status === 'PAID' ? 'Paid' : 'Pending'}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-silver">
                      {d.confirmationNumber ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
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
                            disabled={busyId !== null}
                            onClick={() => onMarkPaid(d)}
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            Mark paid
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

  const refresh = useCallback(() => {
    setRemittances(null);
    setError(null);
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
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showSent}
              onChange={(e) => setShowSent(e.target.checked)}
            />
            Show sent
          </label>
        </div>
        {error && (
          <div role="alert" className="mb-3 rounded-md border border-alert/40 bg-alert/10 p-2 text-sm text-alert">
            {error}
          </div>
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
          <div className="overflow-x-auto">
            <Table caption="Garnishment remittances">
              <TableHeader>
                <TableRow>
                  <TableHead>Payee</TableHead>
                  <TableHead className="hidden md:table-cell">Pay period</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="font-medium text-white">{r.payeeName}</div>
                      <div className="text-xs text-silver">
                        {r.deductionCount} deduction{r.deductionCount === 1 ? '' : 's'}
                        {r.reference ? ` · ref ${r.reference}` : ''}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-silver">
                      {r.period.start} – {r.period.end}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-white">
                      {money(r.amount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === 'SENT' ? 'success' : 'pending'}>
                        {r.status === 'SENT' ? 'Sent' : 'Pending'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
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
                            disabled={busyId !== null}
                            onClick={() => onMarkSent(r)}
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            Mark sent
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ===== New-hire reporting ================================================ */

function NewHireTab() {
  const confirm = useConfirm();
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
          <Button
            size="sm"
            onClick={onExportAndMark}
            loading={busy}
            disabled={busy || reportable.length === 0}
          >
            <Download className="h-4 w-4" />
            Export CSV & mark reported
          </Button>
        </div>
        {error && (
          <div role="alert" className="mb-3 rounded-md border border-alert/40 bg-alert/10 p-2 text-sm text-alert">
            {error}
          </div>
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
          <div className="overflow-x-auto">
            <Table caption="Unreported new hires">
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead>Hire date</TableHead>
                  <TableHead className="hidden md:table-cell">State</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.associateId}>
                    <TableCell className="font-medium text-white">{r.name}</TableCell>
                    <TableCell className="text-silver">{r.hireDate ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell text-silver">
                      {r.state ?? '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {r.overdue && <Badge variant="destructive">Overdue</Badge>}
                        {!r.reportable && (
                          <Badge
                            variant="pending"
                            title="Needs SSN, address, and state on file before the state can match the report"
                          >
                            Missing data
                          </Badge>
                        )}
                        {r.reportable && !r.overdue && <Badge variant="default">Ready</Badge>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
