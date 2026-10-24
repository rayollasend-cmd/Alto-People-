import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Copy, ShieldAlert, ShieldCheck, ShieldQuestion } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtCount, fmtDateTime, fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Brief 2-3 step 4 — the audit trail's integrity, said as STATUS first
 * (F500 G4): one line over the log ("Chain verified · 798 rows · checked
 * 9:21 AM [Check now]"), and the configuration — how long rows are kept,
 * the archive, the SIEM stream — in a Settings section at the foot of the
 * page, where it no longer pushes the log a screen down.
 */

export interface Integrity {
  checks: Array<{ id: string; ok: boolean; rows: number; headSeq: string | null; checkedAt: string; breaks: Array<{ seq: string; reason: string }> }>;
  retentionYears: number;
  minRetentionYears: number;
  archives: Array<{ id: string; rows: number; createdAt: string }>;
  sink: null | { url: string; enabled: boolean; cursorSeq: string; failures: number; lastDeliveredAt: string | null; lastError: string | null };
}

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong.');
const KEY = ['audit', 'integrity'] as const;

function useIntegrity() {
  return useQuery({ queryKey: KEY, queryFn: () => apiFetch<Integrity>('/audit/integrity') });
}

/** "Today" reads as a time; any other day as a date and time. */
function checkedWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? fmtTime(iso) : fmtDateTime(iso);
}

/** The chain's state in one line, with the one action it invites. */
export function AuditIntegrityLine() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const q = useIntegrity();
  const [checking, setChecking] = useState(false);
  if (q.isPending) return <Skeleton className="h-11 w-full rounded-lg" />;
  if (!q.data) return null;
  const last = q.data.checks[0];
  const broken = !!last && !last.ok;
  const Icon = !last ? ShieldQuestion : broken ? ShieldAlert : ShieldCheck;
  const check = async () => {
    setChecking(true);
    try {
      const r = await apiFetch<{ ok: boolean; rows: number }>('/audit/integrity/verify', { method: 'POST' });
      if (r.ok) toast.success(`Chain verified: ${fmtCount(r.rows, 'row')}.`);
      else toast.error('The chain is broken. The rows are listed on this page.');
      void qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      toast.error(message(err));
    } finally {
      setChecking(false);
    }
  };
  return (
    <div
      role="status"
      data-testid="audit-integrity"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-sm',
        broken ? 'border-alert/40 bg-alert/[0.06]' : 'border-line bg-surface',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', broken ? 'text-alert' : last ? 'text-success' : 'text-ink-muted')} aria-hidden="true" />
      <span className="min-w-0 flex-1 text-ink">
        {!last ? (
          'Every new row is chained to the one before it. The first check runs with tonight’s controls.'
        ) : broken ? (
          <>
            <span className="font-medium">Chain broken</span> at {last.breaks.slice(0, 3).map((b) => `#${b.seq} (${b.reason})`).join(', ')} · found {checkedWhen(last.checkedAt)}. Check again; if it is still broken, contact support.
          </>
        ) : (
          <>
            <span className="font-medium">Chain verified</span>
            <span className="text-ink-muted"> · {fmtCount(last.rows, 'row')} · checked {checkedWhen(last.checkedAt)}</span>
          </>
        )}
      </span>
      {canManage && (
        <Button size="sm" variant="outline" onClick={() => void check()} loading={checking}>
          Check now
        </Button>
      )}
    </div>
  );
}

/**
 * The trail's settings: retention, the archive and the SIEM stream. Closed
 * by default — it is set once, read by auditors, and changed rarely.
 */
export function AuditSettings() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const q = useIntegrity();
  const [open, setOpen] = useState(false);
  const [years, setYears] = useState<string>('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      refresh();
    } catch (err) {
      toast.error(message(err));
    }
  };
  if (!q.data) return null;
  const d = q.data;
  const archived = d.archives.reduce((a, x) => a + x.rows, 0);
  const siem = d.sink ? (!d.sink.enabled ? 'Off' : d.sink.failures ? `Failing (${d.sink.failures})` : 'On') : 'Not set up';
  return (
    <section aria-labelledby="audit-settings-title" className="rounded-lg border border-line bg-surface">
      <h2 id="audit-settings-title" className="m-0">
        <button
          type="button"
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-lg"
          aria-expanded={open}
          aria-controls="audit-settings-body"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="text-base font-medium text-ink">Settings</span>
          <span className="min-w-0 flex-1 text-sm text-ink-muted">
            Kept {d.retentionYears} years · {archived ? `${fmtCount(archived, 'row')} archived` : 'nothing archived yet'} · SIEM stream {siem.toLowerCase()}
          </span>
          <ChevronDown className={cn('h-4 w-4 shrink-0 text-ink-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </button>
      </h2>
      {open && (
        <div id="audit-settings-body" className="space-y-4 border-t border-line px-4 py-4">
          <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)] md:items-start">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Keep rows for (years)" hint={`Then they move to the encrypted archive. Never under ${d.minRetentionYears}; nothing is deleted.`}>
                {(p) => <Input {...p} type="number" min={d.minRetentionYears} max={50} className="w-28" value={years || String(d.retentionYears)} onChange={(e) => setYears(e.target.value)} disabled={!canManage} />}
              </Field>
              {canManage && years && Number(years) !== d.retentionYears && (
                <Button size="sm" className="mb-6" onClick={() => void run(() => apiFetch('/audit/integrity/retention', { method: 'PUT', body: { years: Number(years) } }), 'Saved.').then(() => setYears(''))}>
                  Save
                </Button>
              )}
            </div>
            <div className="text-sm text-ink-muted md:pt-7">
              <span className="text-2xs uppercase tracking-[0.18em]">Archive</span>
              <div className="mt-1 text-ink">{d.archives.length ? `${fmtCount(archived, 'row')} archived in ${fmtCount(d.archives.length, 'file')}.` : 'Nothing archived yet.'}</div>
            </div>
          </div>

          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
              SIEM stream
              <Badge variant={!d.sink ? 'outline' : !d.sink.enabled ? 'default' : d.sink.failures ? 'destructive' : 'success'}>{siem}</Badge>
            </div>
            {d.sink && (
              <p className="text-xs text-ink-muted break-all">
                {d.sink.url} · through row #{d.sink.cursorSeq}
                {d.sink.lastDeliveredAt ? ` · last sent ${fmtDateTime(d.sink.lastDeliveredAt)}` : ''}
                {d.sink.lastError ? ` · last error: ${d.sink.lastError}` : ''}
              </p>
            )}
            {canManage && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Endpoint (https)" hint="Signed JSON lines, in order, retried until delivered." className="min-w-0 w-full sm:w-80">
                  {(p) => <Input {...p} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://siem.example.com/ingest" />}
                </Field>
                <Button
                  size="sm"
                  className="mb-6"
                  disabled={!url.startsWith('https://')}
                  onClick={() =>
                    void run(async () => {
                      const r = await apiFetch<{ secret: string }>('/audit/integrity/sink', { method: 'PUT', body: { url: url.trim() } });
                      setSecret(r.secret);
                      setUrl('');
                    }, 'Stream configured.')
                  }
                >
                  {d.sink ? 'Re-key' : 'Start stream'}
                </Button>
                {d.sink?.enabled && (
                  <Button size="sm" variant="ghost" className="mb-6" onClick={() => void run(() => apiFetch('/audit/integrity/sink/disable', { method: 'POST' }), 'Stream stopped.')}>
                    Stop
                  </Button>
                )}
              </div>
            )}
            {secret && (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-raised p-2 text-xs text-ink">
                Signing secret (shown once): <code className="break-all">{secret}</code>
                <Button size="sm" variant="ghost" aria-label="Copy the signing secret" onClick={() => void navigator.clipboard.writeText(secret).then(() => toast.success('Copied.'))}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
