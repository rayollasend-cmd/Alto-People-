import { useEffect, useMemo, useState } from 'react';
import { FileText, Lock, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientStatement } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate } from '@/lib/format';
import {
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

const money = (v: number) =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

export function StatementsSection({ clientId }: { clientId: string }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const months = useMemo(monthOptions, []);
  const [monthKey, setMonthKey] = useState(months[1]?.key ?? months[0].key);
  const [rows, setRows] = useState<ClientStatement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const canBill = can('process:payroll');

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
            <Button size="sm" onClick={generate} loading={busy === 'generate'}>
              <RefreshCw className="h-3.5 w-3.5" />
              Generate / refresh draft
            </Button>
          </div>
        </div>
        <p className="text-xs text-silver">
          Approved hours at SOW rates with the weekly 40h overtime split, plus
          fill rate, on-time %, and no-shows — the letterheaded artifact for the
          client&apos;s records. Drafts recompute; finalized statements never change.
        </p>
      </CardHeader>
      <CardContent>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!rows && !error && <Skeleton className="h-16" />}
        {rows && rows.length === 0 && (
          <p className="text-sm text-silver">
            No statements yet — pick a month and generate the first draft.
          </p>
        )}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-navy-secondary/60">
            {rows.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm text-white">
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
                  <div className="text-xs tabular-nums text-silver">
                    {s.snapshot.totals.hours.toFixed(1)} h ·{' '}
                    {money(s.snapshot.totals.amount)}
                    {s.snapshot.totals.otHours > 0 &&
                      ` (incl. ${s.snapshot.totals.otHours.toFixed(1)} h OT)`}
                    {s.snapshot.sla.fillRatePct !== null &&
                      ` · fill ${s.snapshot.sla.fillRatePct}%`}
                    {s.snapshot.sla.pendingEntries > 0 && (
                      <span className="text-warning">
                        {' '}
                        · {s.snapshot.sla.pendingEntries} entries still pending approval
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" asChild>
                    <a href={clientStatementPdfUrl(clientId, s.id)} download>
                      <FileText className="h-3.5 w-3.5" />
                      PDF
                    </a>
                  </Button>
                  {s.status === 'DRAFT' && (
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
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
