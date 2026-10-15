import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, ShieldCheck, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

/**
 * Brief 2-3 step 4 — the audit trail's integrity: the hash chain's last
 * checks (and a check now), how long rows are kept before the encrypted
 * archive takes them (never under 7 years, nothing deleted), the SIEM
 * stream, and the full export.
 */

interface Integrity {
  checks: Array<{ id: string; ok: boolean; rows: number; headSeq: string | null; checkedAt: string; breaks: Array<{ seq: string; reason: string }> }>;
  retentionYears: number;
  minRetentionYears: number;
  archives: Array<{ id: string; rows: number; createdAt: string }>;
  sink: null | { url: string; enabled: boolean; cursorSeq: string; failures: number; lastDeliveredAt: string | null; lastError: string | null };
}

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong.');

export function AuditIntegrity() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['audit', 'integrity'], queryFn: () => apiFetch<Integrity>('/audit/integrity') });
  const [years, setYears] = useState<string>('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['audit', 'integrity'] });
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
  const last = d.checks[0];
  return (
    <Card className="mb-4">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base text-white">
            {last && !last.ok ? <ShieldAlert className="h-4 w-4 text-alert" /> : <ShieldCheck className="h-4 w-4 text-success" />}
            Integrity
          </h2>
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <Button size="sm" variant="secondary" onClick={() => void run(() => apiFetch('/audit/integrity/verify', { method: 'POST' }), 'Chain checked.')}>
                Check the chain now
              </Button>
            )}
            {canManage && (
              <Button asChild size="sm" variant="ghost">
                <a href="/api/audit/export.csv" download>
                  <Download className="h-4 w-4" /> Full export
                </a>
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-silver">
          {last
            ? last.ok
              ? `Hash chain verified: ${last.rows} rows, last checked ${fmtDateTime(last.checkedAt)}.`
              : `Hash chain BROKEN at ${last.breaks.slice(0, 3).map((b) => `#${b.seq} (${b.reason})`).join(', ')}, found ${fmtDateTime(last.checkedAt)}.`
            : 'Every new row is chained to the one before it. The first check runs with tonight’s controls.'}
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Keep rows for (years)" hint={`Then they move to the encrypted archive. Never under ${d.minRetentionYears}; nothing is deleted.`}>
            {(p) => <Input {...p} type="number" min={d.minRetentionYears} max={50} className="w-28" value={years || String(d.retentionYears)} onChange={(e) => setYears(e.target.value)} disabled={!canManage} />}
          </Field>
          {canManage && years && Number(years) !== d.retentionYears && (
            <Button size="sm" onClick={() => void run(() => apiFetch('/audit/integrity/retention', { method: 'PUT', body: { years: Number(years) } }), 'Saved.').then(() => setYears(''))}>
              Save
            </Button>
          )}
          <span className="pb-2 text-xs text-silver">{d.archives.length ? `${d.archives.reduce((a, x) => a + x.rows, 0)} rows archived in ${d.archives.length} file${d.archives.length === 1 ? '' : 's'}.` : 'Nothing archived yet.'}</span>
        </div>

        <div className="space-y-2 border-t border-navy-secondary/60 pt-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-white">
            SIEM stream
            {d.sink ? (
              <Badge variant={!d.sink.enabled ? 'default' : d.sink.failures ? 'destructive' : 'success'}>{!d.sink.enabled ? 'Off' : d.sink.failures ? `Failing (${d.sink.failures})` : 'On'}</Badge>
            ) : (
              <Badge variant="default">Not set</Badge>
            )}
          </div>
          {d.sink && (
            <p className="text-xs text-silver">
              {d.sink.url} · through row #{d.sink.cursorSeq}
              {d.sink.lastDeliveredAt ? ` · last sent ${fmtDateTime(d.sink.lastDeliveredAt)}` : ''}
              {d.sink.lastError ? ` · last error: ${d.sink.lastError}` : ''}
            </p>
          )}
          {canManage && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Endpoint (https)" hint="Signed JSON lines, in order, retried until delivered.">
                {(p) => <Input {...p} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://siem.example.com/alto" className="w-80" />}
              </Field>
              <Button
                size="sm"
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
                <Button size="sm" variant="ghost" onClick={() => void run(() => apiFetch('/audit/integrity/sink/disable', { method: 'POST' }), 'Stream stopped.')}>
                  Stop
                </Button>
              )}
            </div>
          )}
          {secret && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-navy-secondary/40 p-2 text-xs text-white">
              Signing secret (shown once): <code className="break-all">{secret}</code>
              <Button size="sm" variant="ghost" aria-label="Copy the signing secret" onClick={() => void navigator.clipboard.writeText(secret).then(() => toast.success('Copied.'))}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
