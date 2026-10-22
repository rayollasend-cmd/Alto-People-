import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarX2, FileText, HandCoins, Lock, ReceiptText } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtHours, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useSelection } from '@/lib/useSelection';
import {
  clientStatementPdfUrl,
  finalizeClientStatement,
  generateDueStatements,
  getStatementsRollup,
  markClientStatementPaid,
  type StatementRollupRow,
} from '@/lib/clientsApi';
import { RECEIVABLES_KEY, getReceivablesAging } from '@/lib/books/receivablesApi';
import { PaymentDialog } from '@/pages/books/receivables/receivablesKit';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  SkeletonRows,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { FilterBar, FilterChip } from '@/components/ui/FilterBar';
import { ListTemplate } from '@/components/templates';
import { downloadStatementFile, MarkPaidDialog } from './statementsShared';

/**
 * The weekly-close roll-up: every client's recent statements in one table,
 * with what deciding needs (finance walk 6): when each falls due and how
 * late it is, the change in hours and dollars against the client's last
 * statement (over 20% is flagged), and the weeks with billable time no
 * statement covers. Generate → finalize (in bulk, or the row's own
 * button) → record the payment in the Books payment dialog, from the row.
 *
 * Same audience as ClientDetail's StatementsSection: executives read
 * (list + PDF), drafting/finalizing/recording payments stay with payroll.
 */

type RollupRow = StatementRollupRow;

/** The change against the previous statement, and whether it is big enough to look at (over 20%). */
export function deltaOf(cur: number, prev: number | null | undefined): { diff: number; pct: number | null; flag: boolean } | null {
  if (prev === null || prev === undefined) return null;
  const diff = Math.round((cur - prev) * 100) / 100;
  const pct = prev !== 0 ? diff / prev : null;
  return { diff, pct, flag: pct === null ? diff !== 0 : Math.abs(pct) > 0.2 };
}

function Delta({ d, format }: { d: ReturnType<typeof deltaOf>; format: (n: number) => string }) {
  if (!d || d.diff === 0) return null;
  const sign = d.diff > 0 ? '+' : '−';
  return (
    <span className={cn('block text-2xs', d.flag ? 'font-medium text-warning' : 'text-silver')} title={d.flag ? 'More than 20% off the last statement' : undefined}>
      {sign}
      {format(Math.abs(d.diff))}
      {d.pct !== null ? ` (${sign}${Math.round(Math.abs(d.pct) * 100)}%)` : ''}
    </span>
  );
}

type StatusFilter = 'ALL' | 'DRAFT' | 'UNPAID' | 'PAID';

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'DRAFT', label: 'Drafts' },
  { value: 'UNPAID', label: 'Final · unpaid' },
  { value: 'PAID', label: 'Paid' },
];

/** Deep-link flash ring — matches the approvals queue treatment. */
const FLASH_ROW_CLASS = 'ring-2 ring-gold bg-gold/10';

export function ClientStatementsRollup() {
  const { can } = useAuth();
  const canFinalize = can('process:payroll');
  // Recording a payment goes through the books (manage:books); without it the old "Mark paid".
  const canRecord = can('manage:books');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [recording, setRecording] = useState<RollupRow | null>(null);
  const agingForPay = useQuery({ queryKey: [...RECEIVABLES_KEY, 'aging'], queryFn: () => getReceivablesAging(), enabled: !!recording });

  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [payTarget, setPayTarget] = useState<RollupRow | null>(null);

  // One call: every client in reach, its last statements, and the weeks no statement covers.
  const rollupQuery = useQuery({
    queryKey: ['clients', 'statements', 'rollup'],
    queryFn: getStatementsRollup,
  });
  const rows = rollupQuery.data?.statements ?? null;
  const missingWeeks = rollupQuery.data?.missingWeeks ?? [];
  const error = rollupQuery.error
    ? rollupQuery.error instanceof ApiError
      ? rollupQuery.error.message
      : 'Could not load statements.'
    : null;
  const load = () => rollupQuery.refetch();

  const visible = useMemo(() => {
    if (!rows) return null;
    switch (filter) {
      case 'DRAFT':
        return rows.filter((r) => r.status === 'DRAFT');
      case 'UNPAID':
        return rows.filter((r) => r.status === 'FINAL' && !r.paidAt);
      case 'PAID':
        return rows.filter((r) => r.status === 'FINAL' && !!r.paidAt);
      default:
        return rows;
    }
  }, [rows, filter]);

  // Selection covers the drafts currently on screen — the only rows a
  // bulk finalize can act on.
  const draftIds = useMemo(
    () => (visible ?? []).filter((r) => r.status === 'DRAFT').map((r) => r.id),
    [visible],
  );
  const sel = useSelection(canFinalize ? draftIds : []);
  const { clear: clearSelection } = sel;
  // A filter change swaps the visible rows out from under the selection —
  // drop it rather than finalizing rows no longer on screen.
  useEffect(() => {
    clearSelection();
  }, [filter, clearSelection]);

  /* ---- ?statement=<id> deep link: consume once, scroll + flash ---------- */
  const [searchParams, setSearchParams] = useSearchParams();
  const [flashId, setFlashId] = useState<string | null>(null);
  const target = searchParams.get('statement');
  useEffect(() => {
    if (!target || rows === null) return;
    const next = new URLSearchParams(searchParams);
    next.delete('statement');
    setSearchParams(next, { replace: true });
    if (!rows.some((r) => r.id === target)) {
      toast.info('That statement is outside the recent periods shown here.');
      return;
    }
    setFlashId(target);
    // Let the row paint before scrolling to it.
    requestAnimationFrame(() => {
      document
        .getElementById(`statement-${target}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    window.setTimeout(() => setFlashId(null), 2000);
    // searchParams/setSearchParams change identity on the consume above;
    // target going null ends the cycle, so they're deliberately not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, rows]);

  /* ---- actions ---------------------------------------------------------- */

  const generateAllDue = async () => {
    setBusy('generate');
    try {
      const r = await generateDueStatements();
      toast.success(
        `Last week (${r.periodStart} → ${r.periodEnd}): ${r.generated} drafted, ${r.refreshed} refreshed${r.skippedFinal > 0 ? `, ${r.skippedFinal} already final` : ''}.`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not generate.');
    } finally {
      setBusy(null);
    }
  };

  const finalizeSelected = async () => {
    const targets = (visible ?? []).filter((r) => sel.selected.has(r.id));
    if (targets.length === 0) return;
    setBusy('finalize');
    const results = await Promise.allSettled(
      targets.map((r) => finalizeClientStatement(r.clientId, r.id)),
    );
    let ok = 0;
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        ok++;
      } else {
        const row = targets[i];
        toast.error(
          `${row.clientName} — ${fmtDate(row.periodStart)}: ${
            res.reason instanceof ApiError
              ? res.reason.message
              : 'could not finalize.'
          }`,
        );
      }
    });
    if (ok > 0) toast.success(`Finalized ${ok} statement${ok === 1 ? '' : 's'}.`);
    setConfirmFinalize(false);
    sel.clear();
    setBusy(null);
    await load();
  };

  // The row's own Finalize: one draft, one confirm.
  const finalizeOne = async (row: RollupRow) => {
    const ok = await confirm({
      title: `Finalize ${row.clientName}, ${fmtDate(row.periodStart)} – ${fmtDate(row.periodEnd)}?`,
      description: 'It takes the next statement number, falls due on the client’s terms, and its figures never change again.',
      confirmLabel: 'Finalize',
    });
    if (!ok) return;
    setBusy(`final-${row.id}`);
    try {
      const st = await finalizeClientStatement(row.clientId, row.id);
      toast.success(`${row.clientName} finalized — No. ${String(st.number).padStart(4, '0')}, due ${st.dueAt ? fmtDate(st.dueAt) : 'on receipt'}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not finalize.');
    } finally {
      setBusy(null);
    }
  };

  const markPaid = async (row: RollupRow, ref: string | undefined) => {
    setBusy(`paid-${row.id}`);
    try {
      await markClientStatementPaid(row.clientId, row.id, ref);
      toast.success(
        `${row.clientName} paid — statement moved out of receivables.`,
      );
      setPayTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record payment.');
    } finally {
      setBusy(null);
    }
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Client statements"
        subtitle="The weekly close: every client's recent statements in one place — generate the week's drafts, finalize in bulk, and record payments."
        breadcrumbs={[
          { label: 'Clients', to: '/clients' },
          { label: 'Client statements' },
        ]}
        primaryAction={
          canFinalize ? (
            <Button
              onClick={generateAllDue}
              loading={busy === 'generate'}
              disabled={busy !== null}
              title="Draft (or refresh) last week's statement for EVERY active client in one run. Finalized periods are left alone."
            >
              <FileText className="h-4 w-4" />
              Generate due statements
            </Button>
          ) : undefined
        }
    >

      {error && (
        <ErrorBanner
          className="mb-4"
          action={
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {missingWeeks.length > 0 && (
        <div className="mb-4 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-sm text-ink" role="status">
          <p className="flex items-center gap-2 font-medium">
            <CalendarX2 className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            Missing weeks: {missingWeeks.length} {missingWeeks.length === 1 ? 'week has' : 'weeks have'} approved time on no statement
          </p>
          <ul className="mt-1 space-y-0.5 pl-6 text-xs text-silver">
            {missingWeeks.slice(0, 6).map((m) => (
              <li key={`${m.clientId}-${m.weekStart}`}>
                <Link to={`/clients/${m.clientId}?tab=statements`} className="text-ink hover:text-gold hover:underline">
                  {m.clientName}
                </Link>{' '}
                · week of {fmtDate(m.weekStart)} · {fmtHours(m.hours)}
              </li>
            ))}
            {missingWeeks.length > 6 && <li>and {missingWeeks.length - 6} more</li>}
          </ul>
        </div>
      )}

      <FilterBar className="mb-4">
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </FilterChip>
        ))}
        <span className="ml-auto text-2xs text-silver/80 tabular-nums">
          {visible ? `${visible.length} statement${visible.length === 1 ? '' : 's'}` : ''}
        </span>
      </FilterBar>

      {!visible && !error && (
        <Card>
          <div className="p-4">
            <SkeletonRows count={5} rowHeight="h-12" />
          </div>
        </Card>
      )}

      {visible && visible.length === 0 && (
        <EmptyState
          icon={ReceiptText}
          title={filter === 'ALL' ? 'No statements yet' : 'Nothing matches this filter'}
          description={
            filter === 'ALL'
              ? canFinalize
                ? 'Run "Generate due statements" to draft last week for every active client.'
                : 'Statements appear here once billing drafts them.'
              : 'Switch to a different status filter.'
          }
        />
      )}

      {visible && visible.length > 0 && (
        <Card>
          <CardContent>
            <DataGrid<NonNullable<typeof visible>[number]>
              id="client-statements-rollup"
              caption="Client statements"
              rows={visible}
              rowKey={(st) => st.id}
              rowId={(st) => `statement-${st.id}`}
              rowClassName={(st) => (flashId === st.id ? FLASH_ROW_CLASS : undefined)}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'client-statements' }}
              selectable={canFinalize ? { disabled: (st) => st.status !== 'DRAFT', selectAllLabel: 'Select all draft statements', selection: { selected: sel.selected, onChange: sel.replace } } : undefined}
              columns={[
                { key: 'client', header: 'Client', accessor: (st) => st.clientName, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'period', header: 'Period', accessor: (st) => st.periodStart, csv: (st) => `${fmtDate(st.periodStart)} – ${fmtDate(st.periodEnd)}`, sortable: true, searchable: false, cardMeta: true, className: 'text-silver whitespace-nowrap', cell: (st) => `${fmtDate(st.periodStart)} – ${fmtDate(st.periodEnd)}` },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (st) => (st.status === 'FINAL' ? (st.paidAt ? 'Paid' : 'Unpaid') : 'Draft'),
                  sortable: true,
                  cardMeta: true,
                  cell: (st) => (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {st.status === 'FINAL' ? (
                        <Badge variant="success" withDot={false}>
                          <Lock className="mr-1 h-3 w-3" />
                          No. {String(st.number).padStart(4, '0')}
                        </Badge>
                      ) : (
                        <Badge variant="pending">Draft</Badge>
                      )}
                      {st.status === 'FINAL' && (st.paidAt ? <Badge variant="success">Paid {fmtDate(st.paidAt)}</Badge> : <Badge variant="pending">Unpaid</Badge>)}
                      {(st.snapshot.sla?.pendingEntries ?? 0) > 0 && st.status === 'DRAFT' && (
                        <span className="text-2xs text-warning" title="Time entries in this period are still awaiting approval — finalizing now locks the figures without them.">
                          {st.snapshot.sla.pendingEntries} pending
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'hours',
                  header: 'Hours',
                  accessor: (st) => st.snapshot.totals.hours,
                  csv: (st) => st.snapshot.totals.hours.toFixed(1),
                  sortable: true,
                  searchable: false,
                  align: 'right',
                  className: 'tabular-nums text-silver',
                  cell: (st) => (
                    <>
                      {st.snapshot.totals.hours.toFixed(1)}
                      <Delta d={deltaOf(st.snapshot.totals.hours, st.previous?.hours)} format={(n) => `${n.toFixed(1)}h`} />
                    </>
                  ),
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  accessor: (st) => st.snapshot.totals.amount,
                  csv: (st) => fmtMoney(st.snapshot.totals.amount),
                  sortable: true,
                  searchable: false,
                  align: 'right',
                  cardMeta: true,
                  className: 'tabular-nums text-white',
                  cell: (st) => (
                    <>
                      {fmtMoney(st.snapshot.totals.amount)}
                      <Delta d={deltaOf(st.snapshot.totals.amount, st.previous?.amount)} format={(n) => fmtMoney(n)} />
                    </>
                  ),
                },
                { key: 'due', header: 'Due', accessor: (st) => st.dueOn ?? '', csv: (st) => (st.dueOn ? fmtDate(st.dueOn) : ''), sortable: true, searchable: false, className: 'whitespace-nowrap text-silver', cell: (st) => (st.dueOn ? fmtDate(st.dueOn) : '—') },
                {
                  key: 'late',
                  header: 'Days late',
                  accessor: (st) => st.daysLate,
                  sortable: true,
                  searchable: false,
                  align: 'right',
                  cell: (st) => (st.daysLate > 0 ? <Badge variant={st.daysLate > 60 ? 'destructive' : 'pending'}>{st.daysLate}</Badge> : <span className="text-silver">—</span>),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'whitespace-nowrap space-x-2',
                  cell: (st) => (
                    <>
                      <Button size="sm" variant="outline" onClick={() => void downloadStatementFile(clientStatementPdfUrl(st.clientId, st.id), `statement-${st.periodStart}.pdf`)}>
                        <FileText className="h-3.5 w-3.5" />
                        PDF
                      </Button>
                      {canFinalize && st.status === 'DRAFT' && (
                        <Button size="sm" variant="outline" onClick={() => void finalizeOne(st)} loading={busy === `final-${st.id}`} disabled={busy !== null}>
                          <Lock className="h-3.5 w-3.5" />
                          Finalize
                        </Button>
                      )}
                      {canFinalize && st.status === 'FINAL' && !st.paidAt && (
                        <Button size="sm" variant="outline" onClick={() => (canRecord ? setRecording(st) : setPayTarget(st))} loading={busy === `paid-${st.id}`} disabled={busy !== null}>
                          <HandCoins className="h-3.5 w-3.5" />
                          {canRecord ? 'Record payment' : 'Mark paid'}
                        </Button>
                      )}
                    </>
                  ),
                },
              ]}
            />
          </CardContent>
        </Card>
      )}

      {canFinalize && sel.count > 0 && (
        <div className="sticky bottom-4 z-20 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-navy-secondary bg-navy p-3 elev-2">
          <span className="text-sm text-silver tabular-nums">
            {sel.count} draft{sel.count === 1 ? '' : 's'} selected
          </span>
          <Button
            size="sm"
            onClick={() => setConfirmFinalize(true)}
            loading={busy === 'finalize'}
            disabled={busy !== null}
          >
            <Lock className="h-3.5 w-3.5" />
            Finalize selected ({sel.count})
          </Button>
          <Button size="sm" variant="ghost" onClick={sel.clear} disabled={busy !== null}>
            Clear
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmFinalize}
        onOpenChange={(o) => !o && setConfirmFinalize(false)}
        title={`Finalize ${sel.count} draft statement${sel.count === 1 ? '' : 's'}?`}
        description="Each receives the next sequential statement number and its figures NEVER change again — even if time entries in the period are edited later."
        confirmLabel="Finalize"
        busy={busy === 'finalize'}
        onConfirm={finalizeSelected}
      />

      {recording && agingForPay.data && (
        <PaymentDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setRecording(null);
              void load();
              void qc.invalidateQueries({ queryKey: ['books'] });
            }
          }}
          initialClientId={recording.clientId}
          initialStatementId={recording.id}
          rows={agingForPay.data.rows}
          statements={agingForPay.data.statements}
        />
      )}

      <MarkPaidDialog
        open={payTarget !== null}
        onOpenChange={(o) => !o && setPayTarget(null)}
        statementLabel={
          payTarget
            ? `${payTarget.clientName} — ${fmtDate(payTarget.periodStart)} – ${fmtDate(payTarget.periodEnd)}`
            : ''
        }
        busy={busy !== null && busy.startsWith('paid-')}
        onConfirm={(ref) => {
          if (payTarget) void markPaid(payTarget, ref);
        }}
      />
    </ListTemplate>
  );
}
