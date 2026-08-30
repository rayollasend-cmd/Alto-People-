import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileText, Lock, ReceiptText } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientStatement } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useSelection } from '@/lib/useSelection';
import {
  clientStatementPdfUrl,
  finalizeClientStatement,
  generateDueStatements,
  listClients,
  listClientStatements,
  markClientStatementPaid,
} from '@/lib/clientsApi';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { FilterBar, FilterChip } from '@/components/ui/FilterBar';
import { downloadStatementFile, MarkPaidDialog } from './statementsShared';

/**
 * The weekly-close roll-up: every client's recent statements in one table.
 * Previously closing the week meant opening each client's detail page and
 * finalizing statements one by one (~22 clicks across 4 page loads); here
 * it's generate → select drafts → finalize, with one confirm.
 *
 * Same audience as ClientDetail's StatementsSection: executives read
 * (list + PDF), drafting/finalizing/marking-paid stay with payroll.
 */

/** A statement plus the client name the per-client API response omits. */
type RollupRow = ClientStatement & { clientName: string };

type StatusFilter = 'ALL' | 'DRAFT' | 'UNPAID' | 'PAID';

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'DRAFT', label: 'Drafts' },
  { value: 'UNPAID', label: 'Final · unpaid' },
  { value: 'PAID', label: 'Paid' },
];

/** Most recent periods per client — the weekly close never needs deep
 *  history, and an unbounded table would bury this week's drafts. */
const PERIODS_PER_CLIENT = 12;

/** Deep-link flash ring — matches the approvals queue treatment. */
const FLASH_ROW_CLASS = 'ring-2 ring-gold bg-gold/10';

export function ClientStatementsRollup() {
  const { can } = useAuth();
  const canFinalize = can('process:payroll');

  const [rows, setRows] = useState<RollupRow[] | null>(null);
  const [loadFailures, setLoadFailures] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [payTarget, setPayTarget] = useState<RollupRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const clients = (await listClients()).clients;
      // No cross-client statements endpoint exists — fan out the per-client
      // list and settle; one broken client must not blank the whole close.
      const settled = await Promise.allSettled(
        clients.map((c) => listClientStatements(c.id)),
      );
      const collected: RollupRow[] = [];
      const failures: string[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          const recent = [...r.value.statements]
            .sort((a, b) => b.periodStart.localeCompare(a.periodStart))
            .slice(0, PERIODS_PER_CLIENT);
          for (const s of recent) {
            collected.push({ ...s, clientName: clients[i].name });
          }
        } else {
          failures.push(clients[i].name);
        }
      });
      collected.sort(
        (a, b) =>
          b.periodStart.localeCompare(a.periodStart) ||
          a.clientName.localeCompare(b.clientName),
      );
      setRows(collected);
      setLoadFailures(failures);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load statements.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
    <div className="mx-auto">
      <PageHeader
        title="Weekly close — statements"
        subtitle="Every client's recent statements in one place: generate the week's drafts, finalize in bulk, and record payments."
        breadcrumbs={[
          { label: 'Clients', to: '/clients' },
          { label: 'Statements' },
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
      />

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
      {loadFailures.length > 0 && (
        <ErrorBanner className="mb-4">
          Statements could not be loaded for: {loadFailures.join(', ')}. The
          table below is missing those clients.
        </ErrorBanner>
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
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {canFinalize && (
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all draft statements"
                        checked={sel.allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = sel.someSelected;
                        }}
                        onChange={sel.toggleAll}
                        disabled={draftIds.length === 0}
                      />
                    </TableHead>
                  )}
                  <TableHead>Client</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">
                    Hours
                  </TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((s) => (
                  <TableRow
                    key={s.id}
                    id={`statement-${s.id}`}
                    className={cn(flashId === s.id && FLASH_ROW_CLASS)}
                  >
                    {canFinalize && (
                      <TableCell className="w-8">
                        {s.status === 'DRAFT' && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${s.clientName}'s ${fmtDate(s.periodStart)} draft`}
                            checked={sel.isSelected(s.id)}
                            onChange={() => sel.toggle(s.id)}
                          />
                        )}
                      </TableCell>
                    )}
                    <TableCell className="font-medium text-white">
                      {s.clientName}
                    </TableCell>
                    <TableCell className="text-silver whitespace-nowrap">
                      {fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {s.status === 'FINAL' ? (
                          <Badge variant="success" withDot={false}>
                            <Lock className="mr-1 h-3 w-3" />
                            No. {String(s.number).padStart(4, '0')}
                          </Badge>
                        ) : (
                          <Badge variant="pending">Draft</Badge>
                        )}
                        {s.status === 'FINAL' &&
                          (s.paidAt ? (
                            <Badge variant="success">Paid {fmtDate(s.paidAt)}</Badge>
                          ) : (
                            <Badge variant="pending">Unpaid</Badge>
                          ))}
                        {s.snapshot.sla.pendingEntries > 0 &&
                          s.status === 'DRAFT' && (
                            <span
                              className="text-2xs text-warning"
                              title="Time entries in this period are still awaiting approval — finalizing now locks the figures without them."
                            >
                              {s.snapshot.sla.pendingEntries} pending
                            </span>
                          )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums hidden sm:table-cell text-silver">
                      {s.snapshot.totals.hours.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-white">
                      {fmtMoney(s.snapshot.totals.amount)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap space-x-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void downloadStatementFile(
                            clientStatementPdfUrl(s.clientId, s.id),
                            `statement-${s.periodStart}.pdf`,
                          )
                        }
                      >
                        <FileText className="h-3.5 w-3.5" />
                        PDF
                      </Button>
                      {canFinalize && s.status === 'FINAL' && !s.paidAt && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPayTarget(s)}
                          loading={busy === `paid-${s.id}`}
                          disabled={busy !== null}
                        >
                          Mark paid
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
    </div>
  );
}
