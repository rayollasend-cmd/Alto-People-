import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, Download, FileText, Lock, RefreshCw } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { ClientStatement } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtMoney, fmtMonthYearTz, fmtRelativeDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  clientServiceReportUrl,
  clientStatementCsvUrl,
  clientStatementPdfUrl,
  finalizeClientStatement,
  generateDueStatements,
  listClientStatements,
  markClientStatementPaid,
  upsertClientStatement,
  getClientDunning,
  pauseClientDunning,
  resumeClientDunning,
  updateClientBillingTerms,
  updateClientStatementTerms,
} from '@/lib/clientsApi';
import { usePrompt } from '@/lib/confirm';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { downloadStatementFile, MarkPaidDialog } from './statementsShared';
import { serviceReportWeekOptions } from './ClientsHome';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Monthly billing/SLA statements. Generate (or refresh) a DRAFT for a
 * month, review the totals inline, download the letterheaded PDF, and
 * FINALIZE to lock the snapshot with the next sequential number.
 * Gated on process:payroll — hidden entirely for everyone else.
 */

// Delegates to the shared formatter — private money formatters drift.
const money = (v: number) => fmtMoney(v);

/** Last 12 month options as {label, start, end} in YYYY-MM-DD. */
function monthOptions(): Array<{ key: string; label: string; start: string; end: string }> {
  const out = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0));
    out.push({
      key: start.toISOString().slice(0, 7),
      label: fmtMonthYearTz(start, 'UTC'),
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    });
  }
  return out;
}

/** Inline statement viewer — the PDF's contents without the download. */
function StatementDetail({ s }: { s: ClientStatement }) {
  const snap = s.snapshot;
  return (
    <div className="ml-6 mt-3 space-y-4 rounded-md border border-navy-secondary bg-navy/50 p-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b border-navy-secondary text-2xs uppercase tracking-wider text-silver/60">
              <th className="py-1 pr-3 text-left font-medium">Service</th>
              <th className="py-1 px-2 text-right font-medium">Hours</th>
              <th className="py-1 px-2 text-right font-medium">Rate</th>
              <th className="py-1 pl-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-secondary/50">
            {snap.lines.map((l) => (
              <tr key={l.label} className="text-white">
                <td className="py-1 pr-3">{l.label}</td>
                <td className="py-1 px-2 text-right">{l.hours.toFixed(2)}</td>
                <td className="py-1 px-2 text-right">{money(l.rate)}</td>
                <td className="py-1 pl-2 text-right">{money(l.amount)}</td>
              </tr>
            ))}
            <tr className="font-semibold text-white">
              <td className="py-1.5 pr-3">
                Total — {snap.totals.regularHours.toFixed(2)} reg +{' '}
                {snap.totals.otHours.toFixed(2)} OT
                {(snap.totals.doubleTimeHours ?? 0) > 0 && ` + ${snap.totals.doubleTimeHours!.toFixed(2)} DT`}
              </td>
              <td className="py-1.5 px-2 text-right">{snap.totals.hours.toFixed(2)}</td>
              <td />
              <td className="py-1.5 pl-2 text-right">{money(snap.totals.amount)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {snap.stores.length > 1 && (
        <div className="text-xs text-silver">
          {snap.stores.map((st) => (
            <span key={st.locationName} className="mr-4 tabular-nums">
              {st.locationName}: {st.hours.toFixed(1)} h · {money(st.amount)}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-silver">
        <span>
          Fill rate:{' '}
          <span className="text-white tabular-nums">
            {snap.sla.fillRatePct !== null ? `${snap.sla.fillRatePct}%` : '—'}
          </span>{' '}
          ({snap.sla.assignedShifts}/{snap.sla.publishedShifts} shifts)
        </span>
        <span>
          On-time:{' '}
          <span className="text-white tabular-nums">
            {snap.sla.punctualPct !== null ? `${snap.sla.punctualPct}%` : '—'}
          </span>
        </span>
        <span>
          No-shows: <span className="text-white tabular-nums">{snap.sla.noShows}</span>
        </span>
      </div>
    </div>
  );
}

export function StatementsSection({ clientId }: { clientId: string }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const months = useMemo(monthOptions, []);
  const [monthKey, setMonthKey] = useState(months[1]?.key ?? months[0].key);
  // Service reports are strictly per org week (Sat–Fri) while statements
  // here can span a month, so the report gets its own week picker instead
  // of inheriting a statement row's period. Defaults to the last completed
  // week — the endpoint's own default.
  const reportWeeks = useMemo(serviceReportWeekOptions, []);
  const [reportWeek, setReportWeek] = useState(reportWeeks[0].value);
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [payTarget, setPayTarget] = useState<ClientStatement | null>(null);

  // Executives read statements (list + PDF/CSV); drafting and finalizing
  // stay with payroll.
  const canFinalize = can('process:payroll');
  const canBill = canFinalize || can('view:executive');
  const prompt = usePrompt();
  const todayKey = new Date().toISOString().slice(0, 10);

  // Keyed by client, so switching clients is a different cache entry (the
  // old effect reset rows by hand) and Back to a client is instant.
  const statementsQuery = useQuery({
    queryKey: ['clients', clientId, 'statements'],
    queryFn: () => listClientStatements(clientId),
    enabled: canBill,
  });
  const rows = statementsQuery.data?.statements ?? null;
  const error = statementsQuery.error
    ? statementsQuery.error instanceof ApiError
      ? statementsQuery.error.message
      : 'Could not load statements.'
    : null;
  const load = () => statementsQuery.refetch();

  if (!canBill) return null;

  const generate = async () => {
    const m = months.find((x) => x.key === monthKey)!;
    setBusy('generate');
    try {
      await upsertClientStatement(clientId, m.start, m.end);
      toast.success(`Draft statement for ${m.label} is ready.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not generate.');
    } finally {
      setBusy(null);
    }
  };

  const generateAllDue = async () => {
    setBusy('generate-all');
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

  const markPaid = async (s: ClientStatement, ref: string | undefined) => {
    setBusy(`paid-${s.id}`);
    try {
      await markClientStatementPaid(clientId, s.id, ref);
      toast.success('Payment recorded — statement moved out of receivables.');
      setPayTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record payment.');
    } finally {
      setBusy(null);
    }
  };

  const download = downloadStatementFile;

  const editTerms = async (s: ClientStatement) => {
    const po = await prompt({
      title: 'Purchase order for this statement',
      description: 'Prints on the statement and its reminders. Leave empty to use the client\u2019s standing PO.',
      reasonLabel: 'PO number',
      reasonMaxLength: 60,
      required: false,
      confirmLabel: 'Next',
    });
    if (po === null) return;
    let dueAt: string | null | undefined;
    if (s.status === 'FINAL') {
      const d = await prompt({
        title: 'Due date',
        description: 'YYYY-MM-DD. Reminders restart from the new date.',
        reasonLabel: 'Due date',
        reasonPlaceholder: s.dueAt ?? '2026-11-30',
        reasonMaxLength: 10,
        required: false,
        confirmLabel: 'Save',
      });
      if (d === null) return;
      dueAt = d.trim() ? d.trim() : undefined;
    }
    setBusy(`terms-${s.id}`);
    try {
      await updateClientStatementTerms(clientId, s.id, { poNumber: po.trim() || null, ...(dueAt !== undefined ? { dueAt } : {}) });
      toast.success('Statement terms saved.');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the terms.');
    } finally {
      setBusy(null);
    }
  };

  const finalize = async (s: ClientStatement) => {
    if (
      !(await confirm({
        title: `Finalize the ${fmtDate(s.periodStart)} statement?`,
        description:
          'It receives the next statement number and its figures NEVER change again — even if time entries in the period are edited later.',
        destructive: false,
      }))
    ) {
      return;
    }
    setBusy(s.id);
    try {
      const updated = await finalizeClientStatement(clientId, s.id);
      toast.success(`Finalized as statement No. ${String(updated.number).padStart(4, '0')}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not finalize.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <CardTitle>Statements</CardTitle>
            <Link
              to="/clients/statements"
              className="text-xs text-gold hover:text-gold-bright"
            >
              All clients →
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <Select
              size="sm"
              aria-label="Service report week"
              title="Org week (Sat–Fri) the service report covers"
              value={reportWeek}
              onChange={(e) => setReportWeek(e.target.value)}
            >
              {reportWeeks.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void download(
                  clientServiceReportUrl(clientId, reportWeek),
                  `service-report-${reportWeek}.pdf`,
                )
              }
              title="The client-facing weekly report: coverage, day-by-day fill, reliability, roster, next-week readiness, and billing status — ready to hand to the store manager. Covers the selected week."
            >
              <FileText className="h-3.5 w-3.5" />
              Service report (PDF)
            </Button>
            <Select
              size="sm"
              aria-label="Statement month"
              value={monthKey}
              onChange={(e) => setMonthKey(e.target.value)}
            >
              {months.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </Select>
            {canFinalize && (
              <Button
                size="sm"
                onClick={generate}
                loading={busy === 'generate'}
                disabled={busy !== null}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Generate / refresh draft
              </Button>
            )}
            {canFinalize && (
              <Button
                size="sm"
                variant="secondary"
                onClick={generateAllDue}
                loading={busy === 'generate-all'}
                disabled={busy !== null}
                title="Draft (or refresh) last week's statement for EVERY active client in one run. Finalized periods are left alone."
              >
                <FileText className="h-3.5 w-3.5" />
                Generate all clients (last week)
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-silver">
          Approved hours at SOW rates with the weekly 40h overtime split, plus
          fill rate, on-time %, and no-shows — the letterheaded artifact for the
          client&apos;s records. Drafts recompute; finalized statements never change.
        </p>
      </CardHeader>
      <CardContent>
        <BillingTermsBar clientId={clientId} canEdit={canFinalize} />
        {error && (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={() => void load()}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        )}
        {!rows && !error && <Skeleton className="h-16" />}
        {rows && rows.length === 0 && (
          <p className="text-sm text-silver">
            No statements yet — pick a month and generate the first draft.
          </p>
        )}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-navy-secondary/60">
            {rows.map((s) => {
              const open = openId === s.id;
              return (
                <li key={s.id} className="py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : s.id)}
                      aria-expanded={open}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-2 text-sm text-white">
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 shrink-0 text-silver/60 transition-transform',
                            open && 'rotate-180',
                          )}
                        />
                        {fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)}
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
                          ) : s.dueAt && s.dueAt < todayKey ? (
                            <Badge variant="destructive">Past due since {fmtDate(s.dueAt)}</Badge>
                          ) : s.dueAt ? (
                            <Badge variant="pending">Due {fmtDate(s.dueAt)}</Badge>
                          ) : (
                            <Badge variant="pending">Unpaid</Badge>
                          ))}
                        {s.poNumber && <span className="text-2xs text-silver">PO {s.poNumber}</span>}
                      </div>
                      <div className="pl-6 text-xs tabular-nums text-silver">
                        {s.snapshot.totals.hours.toFixed(1)} h ·{' '}
                        {money(s.snapshot.totals.amount)}
                        {s.snapshot.totals.otHours > 0 &&
                          ` (incl. ${s.snapshot.totals.otHours.toFixed(1)} h OT)`}
                        {s.snapshot.sla?.fillRatePct != null &&
                          ` · fill ${s.snapshot.sla.fillRatePct}%`}
                        {s.status === 'DRAFT' && s.snapshot.generatedAt && (
                          <span className="text-silver/60">
                            {' '}
                            · computed {fmtRelativeDate(s.snapshot.generatedAt)}
                          </span>
                        )}
                        {(s.snapshot.sla?.pendingEntries ?? 0) > 0 && (
                          <span className="text-warning">
                            {' '}
                            · {s.snapshot.sla.pendingEntries} entries still pending approval
                          </span>
                        )}
                      </div>
                    </button>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void download(
                            clientStatementPdfUrl(clientId, s.id),
                            `statement-${s.periodStart}.pdf`,
                          )
                        }
                      >
                        <FileText className="h-3.5 w-3.5" />
                        PDF
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void download(
                            clientStatementCsvUrl(clientId, s.id),
                            `statement-${s.periodStart}.csv`,
                          )
                        }
                      >
                        <Download className="h-3.5 w-3.5" />
                        CSV
                      </Button>
                      {canFinalize && s.status === 'DRAFT' && (
                        <Button
                          size="sm"
                          onClick={() => void finalize(s)}
                          loading={busy === s.id}
                          disabled={busy !== null}
                        >
                          Finalize
                        </Button>
                      )}
                      {canFinalize && !s.paidAt && (
                        <Button size="sm" variant="ghost" onClick={() => void editTerms(s)} disabled={busy !== null} title="The PO this statement bills against, and once final, its due date">
                          Terms
                        </Button>
                      )}
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
                    </div>
                  </div>
                  {open && <StatementDetail s={s} />}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <MarkPaidDialog
        open={payTarget !== null}
        onOpenChange={(o) => !o && setPayTarget(null)}
        statementLabel={
          payTarget
            ? `${fmtDate(payTarget.periodStart)} – ${fmtDate(payTarget.periodEnd)}`
            : ''
        }
        busy={busy !== null && busy.startsWith('paid-')}
        onConfirm={(ref) => {
          if (payTarget) void markPaid(payTarget, ref);
        }}
      />
    </Card>
  );
}

/**
 * The client's invoicing terms and where the reminder cadence stands:
 * standing PO, net days, and the pause Finance throws when a client is
 * disputing a statement or the check is in the mail.
 */
function BillingTermsBar({ clientId, canEdit }: { clientId: string; canEdit: boolean }) {
  const q = useQuery({ queryKey: ['clients', clientId, 'dunning'], queryFn: () => getClientDunning(clientId) });
  const prompt = usePrompt();
  const [editing, setEditing] = useState(false);
  const [po, setPo] = useState('');
  const [days, setDays] = useState('30');
  // Sales tax on this client's statements (audit 2026-10-21 #17): taxable, at what rate.
  const [taxable, setTaxable] = useState(false);
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const d = q.data;
  if (!d) return null;
  const startEdit = () => {
    setPo(d.poNumber ?? '');
    setDays(String(d.paymentTermsDays));
    setTaxable(!!d.salesTaxable);
    setRate(d.salesTaxRatePct != null ? String(d.salesTaxRatePct) : '');
    setEditing(true);
  };
  const save = async () => {
    if (taxable && !(Number(rate) > 0)) {
      toast.error('A taxable client needs a sales tax rate above zero.');
      return;
    }
    setBusy(true);
    try {
      await updateClientBillingTerms(clientId, { poNumber: po.trim() || null, paymentTermsDays: Number(days), salesTaxable: taxable, salesTaxRatePct: taxable ? Number(rate) : null });
      toast.success('Billing terms saved.');
      setEditing(false);
      await q.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  const togglePause = async () => {
    setBusy(true);
    try {
      if (d.paused) {
        await resumeClientDunning(clientId);
        toast.success('Reminders resumed.');
      } else {
        const note = await prompt({
          title: 'Pause payment reminders?',
          description: 'No reminders go to this client until you resume. Say why, so whoever picks this up knows.',
          reasonLabel: 'Why',
          reasonPlaceholder: 'Disputing the overtime line on No. 0042',
          reasonMaxLength: 500,
          confirmLabel: 'Pause reminders',
        });
        if (!note) return;
        await pauseClientDunning(clientId, note);
        toast.success('Reminders paused.');
      }
      await q.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change reminders.');
    } finally {
      setBusy(false);
    }
  };
  const lastReminder = d.reminders[0];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-navy-secondary bg-navy-secondary/30 px-3 py-2 text-xs text-silver">
      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Standing PO
            <Input className="mt-1 h-8 w-36" value={po} maxLength={60} onChange={(e) => setPo(e.target.value)} />
          </label>
          <label>
            Net days
            <Input className="mt-1 h-8 w-20" type="number" min="0" max="365" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <label className="flex items-center gap-1.5 self-center pt-4">
            <input type="checkbox" className="h-4 w-4 accent-gold" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
            Charge sales tax
          </label>
          {taxable && (
            <label>
              Rate %
              <Input className="mt-1 h-8 w-24" type="number" min="0" max="100" step="0.001" value={rate} onChange={(e) => setRate(e.target.value)} />
            </label>
          )}
          <Button size="sm" type="submit" loading={busy}>
            Save
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <span>
            Terms <span className="font-medium text-ink">net {d.paymentTermsDays}</span>
          </span>
          <span>
            PO <span className="font-medium text-ink">{d.poNumber ?? 'none on file'}</span>
          </span>
          <span>
            Sales tax <span className="font-medium text-ink">{d.salesTaxable && d.salesTaxRatePct ? `${d.salesTaxRatePct}%` : 'none'}</span>
          </span>
          <span>
            Reminders{' '}
            {d.paused ? (
              <span className="font-medium text-warning" title={d.paused.note ?? undefined}>
                paused {fmtDate(d.paused.at)}
                {d.paused.note ? ` — ${d.paused.note}` : ''}
              </span>
            ) : (
              <span className="font-medium text-ink">on{lastReminder ? ` · last sent ${fmtDate(lastReminder.sentAt)}` : ''}</span>
            )}
          </span>
          {canEdit && (
            <span className="ml-auto flex gap-2">
              <Button size="xs" variant="ghost" onClick={startEdit}>
                Edit terms
              </Button>
              <Button size="xs" variant="ghost" onClick={() => void togglePause()} loading={busy}>
                {d.paused ? 'Resume reminders' : 'Pause reminders'}
              </Button>
            </span>
          )}
        </>
      )}
    </div>
  );
}
