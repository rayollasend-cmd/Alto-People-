import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Download, FileText, Lock, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientStatement } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtMoney, fmtRelativeDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  clientStatementCsvUrl,
  clientStatementPdfUrl,
  finalizeClientStatement,
  listClientStatements,
  upsertClientStatement,
} from '@/lib/clientsApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
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
      label: start.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
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
  const [rows, setRows] = useState<ClientStatement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Executives read statements (list + PDF/CSV); drafting and finalizing
  // stay with payroll.
  const canFinalize = can('process:payroll');
  const canBill = canFinalize || can('view:executive');

  const load = async () => {
    setError(null);
    try {
      setRows((await listClientStatements(clientId)).statements);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load statements.');
    }
  };
  useEffect(() => {
    if (!canBill) return;
    setRows(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, canBill]);

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

  // Fetch-then-save instead of a bare <a download>: an auth failure or 500
  // on a raw link dumps the user on a JSON error page with no way back.
  const download = async (url: string, fallbackName: string) => {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const m = /filename="([^"]+)"/.exec(cd);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = m?.[1] ?? fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch {
      toast.error('Download failed — try again.');
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
          <CardTitle>Statements</CardTitle>
          <div className="flex items-center gap-2">
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
          </div>
        </div>
        <p className="text-xs text-silver">
          Approved hours at SOW rates with the weekly 40h overtime split, plus
          fill rate, on-time %, and no-shows — the letterheaded artifact for the
          client&apos;s records. Drafts recompute; finalized statements never change.
        </p>
      </CardHeader>
      <CardContent>
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
                      </div>
                      <div className="pl-6 text-xs tabular-nums text-silver">
                        {s.snapshot.totals.hours.toFixed(1)} h ·{' '}
                        {money(s.snapshot.totals.amount)}
                        {s.snapshot.totals.otHours > 0 &&
                          ` (incl. ${s.snapshot.totals.otHours.toFixed(1)} h OT)`}
                        {s.snapshot.sla.fillRatePct !== null &&
                          ` · fill ${s.snapshot.sla.fillRatePct}%`}
                        {s.status === 'DRAFT' && s.snapshot.generatedAt && (
                          <span className="text-silver/60">
                            {' '}
                            · computed {fmtRelativeDate(s.snapshot.generatedAt)}
                          </span>
                        )}
                        {s.snapshot.sla.pendingEntries > 0 && (
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
                    </div>
                  </div>
                  {open && <StatementDetail s={s} />}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
