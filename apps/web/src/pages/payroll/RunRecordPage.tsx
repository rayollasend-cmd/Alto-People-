import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Ban, Download, ExternalLink, FileText, Pencil } from '@/components/ui/icons';
import type { PayrollRunDetail } from '@alto-people/shared';
import { getPayrollRun } from '@/lib/payrollApi';
import { getPayrollReviewStatus } from '@/lib/payrollReviewApi';
import { fmtDateOnly, fmtDateOnlyRange, fmtDateTime, fmtHours, fmtMoney } from '@/lib/format';
import { RecordTemplate, type RecordTab } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { RunStatusStepper } from '@/components/payroll/RunStatusStepper';
import { RunTotalsMismatch } from '@/components/payroll/RunTotalsMismatch';
import { RunTaxBreakdown } from '@/components/payroll/RunTaxBreakdown';
import { RunStatusBadge, paycheckStatusLabel, paycheckStatusTone } from '@/lib/payrollRunStatus';
import { PayrollReviewPage } from './PayrollReviewPage';
import { PayrollClosePage } from './PayrollClosePage';
import { PayrollChecksPage } from './PayrollChecksPage';
import { PayChecksPage } from './PayChecksPage';

/**
 * One payroll run, as one record (F500 G3: "a run lives in four places" —
 * the drawer on /payroll, /runs/:id/review, /runs/:id/close and
 * /runs/:id/checks, plus /payroll/pay-checks?run=, none linking back to the
 * others). The header says which run it is, how it stands and what it
 * moved; its next step is the primary; each part is a tab:
 *
 *   Overview        where the run stands, the money, the taxes by place
 *   Paychecks       every paycheck in it
 *   Review          the review report and its sign-off
 *   Close           the guided close, step by step
 *   Paper checks    the checks printed for it
 *   Confirmations   who confirmed their paycheck before payday
 *
 * The tab is the path (/payroll/runs/:id/review), so every link that
 * already pointed at /review, /close or /checks lands on its tab. The
 * payroll home's drawer stays the quick look, with "Open run" to here; the
 * actions that move money (finalize, pay, void, amend) live there.
 */

export type RunTab = 'overview' | 'paychecks' | 'review' | 'close' | 'checks' | 'confirmations';
export const RUN_TABS: readonly RunTab[] = ['overview', 'paychecks', 'review', 'close', 'checks', 'confirmations'];

export const runPath = (id: string, tab: RunTab = 'overview') => (tab === 'overview' ? `/payroll/runs/${id}` : `/payroll/runs/${id}/${tab}`);

/** "Aug 29 – Sep 11, 2026 run": what the run is called everywhere. */
export const runTitle = (r: Pick<PayrollRunDetail, 'periodStart' | 'periodEnd' | 'kind'>) =>
  `${fmtDateOnlyRange(r.periodStart, r.periodEnd)} ${r.kind === 'OFF_CYCLE' ? 'off-cycle run' : r.kind === 'AMENDMENT' ? 'amendment' : 'run'}`;

const KIND_LABEL: Record<string, string> = { OFF_CYCLE: 'Off-cycle', AMENDMENT: 'Amendment', DAILY: 'Daily pay', MANUAL: 'Manual check' };

export function RunRecordPage() {
  const { id = '', tab: tabParam } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const tab: RunTab = (RUN_TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as RunTab) : 'overview';
  const q = useQuery({ queryKey: ['payroll', 'run', id], queryFn: () => getPayrollRun(id), enabled: !!id });
  const run = q.data;
  const crumbs = [{ label: 'Payroll', to: '/payroll' }];

  if (q.isError || !run) {
    // The shell stays: title and trail while it loads, or when it can't (F500 G3).
    return (
      <RecordTemplate
        breadcrumbs={crumbs}
        title="Payroll run"
        tabs={[
          {
            key: 'overview',
            label: 'Overview',
            content: q.isError ? <QueryError what="this payroll run" query={q} /> : <Skeleton className="h-64" />,
          },
        ]}
      />
    );
  }

  const open = run.status === 'DRAFT' || run.status === 'FINALIZED';
  const next = run.nextStep && run.nextStep.key !== 'done' && run.nextStep.key !== 'cancelled' ? run.nextStep : null;
  const tabs: RecordTab[] = [
    { key: 'overview', label: 'Overview', content: <RunOverview run={run} /> },
    { key: 'paychecks', label: 'Paychecks', count: run.items.length, content: <RunPaychecks run={run} /> },
    { key: 'review', label: 'Review', content: <PayrollReviewPage runId={run.id} embedded /> },
    { key: 'close', label: 'Close', content: <PayrollClosePage runId={run.id} embedded /> },
    { key: 'checks', label: 'Paper checks', content: <PayrollChecksPage runId={run.id} embedded /> },
    { key: 'confirmations', label: 'Confirmations', content: <PayChecksPage runId={run.id} embedded /> },
  ];

  return (
    <RecordTemplate
      breadcrumbs={crumbs}
      title={runTitle(run)}
      status={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <RunStatusBadge status={run.status} />
          {run.kind !== 'REGULAR' && <Badge variant="info">{KIND_LABEL[run.kind] ?? run.kind}</Badge>}
        </span>
      }
      subtitle={[run.payrollScheduleName, run.clientName ?? 'All clients'].filter(Boolean).join(' · ')}
      facts={[
        { label: 'Payday', value: run.payDate ? fmtDateOnly(run.payDate, { weekday: true }) : null },
        { label: 'Gross', value: fmtMoney(run.totalGross) },
        { label: 'Net', value: fmtMoney(run.totalNet) },
        { label: 'Taxes withheld', value: fmtMoney(run.totalTax) },
        { label: 'Employer taxes', value: fmtMoney(run.totalEmployerTax), hint: 'Social Security and Medicare match, FUTA, SUTA' },
        { label: 'Paychecks', value: String(run.items.length), to: runPath(run.id, 'paychecks') },
        { label: 'Pay schedule', value: run.payrollScheduleName ?? null, to: run.payrollScheduleId ? `/payroll/schedules/${run.payrollScheduleId}` : undefined },
      ]}
      actions={[
        // The run's next step is the header's one primary.
        ...(next ? [{ key: 'next', label: next.label, to: next.to, primary: true, hint: next.waitingOn ? `Waiting on ${next.waitingOn}` : undefined }] : []),
        // Finalizing, paying, voiding and amending live in the payroll home's drawer, with their checks and ceremonies.
        { key: 'drawer', label: open ? 'Finalize or pay' : 'Open in payroll', icon: ExternalLink, to: `/payroll?run=${run.id}` },
        {
          key: 'zip',
          label: 'Download all paystubs',
          icon: Download,
          href: `/api/payroll/runs/${run.id}/paystubs.zip`,
          download: true,
          overflow: true,
          hidden: run.items.length === 0 || (run.status !== 'FINALIZED' && run.status !== 'DISBURSED'),
        },
      ]}
      tabs={tabs}
      activeTab={tab}
      // A tab is a place: its own address, and Back returns to the last one.
      onTabChange={(k) => navigate(runPath(run.id, k as RunTab))}
    />
  );
}

/* ----- Overview ------------------------------------------------------------------- */

function RunOverview({ run }: { run: PayrollRunDetail }) {
  const review = useQuery({
    queryKey: ['payroll', 'review-status', run.id],
    queryFn: () => getPayrollReviewStatus(run.id),
    enabled: run.status === 'DRAFT' || run.status === 'FINALIZED',
  });
  return (
    <div className="space-y-[var(--d-stack)]">
      {/* The stored totals checked against the paychecks: first, because it changes how every number reads. */}
      <RunTotalsMismatch check={{ ...run, paychecks: run.paychecks ?? run.items.length }} />
      {run.status === 'CANCELLED' && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-alert/40 bg-alert/5 p-3 text-sm">
          <Ban className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-ink">Run voided{run.cancelledAt ? ` ${fmtDateTime(run.cancelledAt)}` : ''}</p>
            {run.cancelReason && <p className="text-ink-muted">Reason: {run.cancelReason}</p>}
          </div>
        </div>
      )}
      {run.kind === 'AMENDMENT' && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
          <Pencil className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-ink">Amendment</p>
            {run.amendmentReason && <p className="text-ink-muted">Reason: {run.amendmentReason}</p>}
            {run.amendsRunId && (
              <Link to={runPath(run.amendsRunId)} className="text-accent underline underline-offset-2">
                Open the run it amends
              </Link>
            )}
          </div>
        </div>
      )}
      {/* The next step is the header's primary; the stepper doesn't say it twice. */}
      <RunStatusStepper status={run.status} lifecycle={run} signedOff={!!review.data?.signoff?.current} showNext={false} />
      {/* State and local taxes by jurisdiction (lib/taxEngine). */}
      <RunTaxBreakdown runId={run.id} />
      {run.notes && (
        <p className="flex items-start gap-2 text-sm text-ink-muted">
          <FileText className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {run.notes}
        </p>
      )}
    </div>
  );
}

/* ----- Paychecks ------------------------------------------------------------------ */

type Item = PayrollRunDetail['items'][number];

function RunPaychecks({ run }: { run: PayrollRunDetail }) {
  const columns: GridColumn<Item>[] = useMemo(
    () => [
      { key: 'name', header: 'Person', accessor: (i) => i.associateName ?? '', primary: true, sortable: true, cell: (i) => <span className="font-medium text-ink">{i.associateName ?? 'Unknown'}</span> },
      {
        key: 'status',
        header: 'Status',
        accessor: (i) => paycheckStatusLabel(i.status),
        sortable: true,
        cardMeta: true,
        cell: (i) => (
          <span className="inline-flex flex-col items-start gap-0.5">
            <Badge variant={paycheckStatusTone(i.status)}>{paycheckStatusLabel(i.status)}</Badge>
            {i.failureReason && <span className="text-xs text-alert">{i.failureReason}</span>}
          </span>
        ),
      },
      { key: 'hours', header: 'Hours', accessor: (i) => i.hoursWorked, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (i) => fmtHours(i.hoursWorked) },
      { key: 'gross', header: 'Gross', accessor: (i) => i.grossPay, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (i) => fmtMoney(i.grossPay), csv: (i) => i.grossPay },
      {
        key: 'taxes',
        header: 'Taxes',
        accessor: (i) => i.federalWithholding + i.fica + i.medicare + i.stateWithholding,
        sortable: true,
        searchable: false,
        align: 'right',
        className: 'tabular-nums',
        cell: (i) => fmtMoney(i.federalWithholding + i.fica + i.medicare + i.stateWithholding),
      },
      { key: 'net', header: 'Net', accessor: (i) => i.netPay, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums text-gold', cell: (i) => fmtMoney(i.netPay), csv: (i) => i.netPay },
      { key: 'state', header: 'Tax state', accessor: (i) => i.taxState ?? '', sortable: true, defaultHidden: true, cell: (i) => i.taxState ?? '—' },
    ],
    [],
  );
  return (
    <DataGrid<Item>
      id="run-paychecks"
      caption="Paychecks in this run"
      noun={{ one: 'paycheck', many: 'paychecks' }}
      rows={run.items}
      columns={columns}
      rowKey={(i) => i.id}
      urlKey="pay"
      defaultSort={{ key: 'name', direction: 'asc' }}
      search={{ placeholder: 'Search people' }}
      exportCsv={{ filename: `paychecks-${run.periodStart}-${run.periodEnd}` }}
      empty={{
        title: 'No paychecks in this run',
        description:
          run.totalsAgree === false
            ? 'The run records money but has no paychecks behind it; see the alert on Overview.'
            : run.status === 'DRAFT'
              ? 'Add earnings to it, or no approved time fell in its period.'
              : 'It paid no one.',
      }}
    />
  );
}
