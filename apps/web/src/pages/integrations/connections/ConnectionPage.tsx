import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FlaskConical, Pause, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react';
import { INTEGRATION_CAPABILITY_LABELS, type IntegrationCapability, type IntegrationSyncRunSummary } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { fmtDateTime } from '@/lib/format';
import {
  deleteIntegrationConnection,
  getIntegrationConnection,
  listIntegrationRunErrors,
  patchIntegrationConnection,
  syncIntegrationConnection,
  testIntegrationConnection,
} from '@/lib/integrationsApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { StatTile } from '@/pages/portal/portalCharts';
import { ConnectDrawer } from './ConnectDrawer';
import { connectionStatus, runStatus } from './shared';

/**
 * One connection: its state in four numbers, the actions (sandbox test,
 * sync now, pause, edit, disconnect), and the sync log — every run with
 * its counts, and the per-record errors of a run behind a click.
 */
export function ConnectionPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:integrations') : false;
  const q = useQuery({ queryKey: ['integrations', 'connection', id], queryFn: () => getIntegrationConnection(id), enabled: !!id });
  const [editing, setEditing] = useState(false);
  const [capability, setCapability] = useState<IntegrationCapability | ''>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [errorsFor, setErrorsFor] = useState<IntegrationSyncRunSummary | null>(null);

  const c = q.data?.connection ?? null;
  const vendor = q.data?.vendor ?? null;
  const runs = q.data?.runs ?? [];

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await q.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That did not go through.');
    } finally {
      setBusy(null);
    }
  };

  const title = c?.name ?? 'Connection';
  const status = c ? connectionStatus(c) : null;
  const rejected = runs.slice(0, 10).reduce((a, r) => a + r.failed, 0);

  return (
    <ListTemplate
      title={title}
      subtitle={c && vendor ? `${vendor.label} · ${c.sandbox ? 'sandbox' : 'live'}${c.hasCredentials ? ' · credentials on file' : ''}` : ' '}
      breadcrumbs={[{ label: 'Settings' }, { label: 'Integrations', to: '/integrations' }, { label: title }]}
      secondaryActions={
        c && canManage ? (
          <>
            <Button variant="ghost" size="sm" loading={busy === 'test'} onClick={() => void act('test', () => testIntegrationConnection(c.id), 'Sandbox test ran; the log is below.')}>
              <FlaskConical className="h-4 w-4" /> Sandbox test
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={busy === 'pause'}
              onClick={() => void act('pause', () => patchIntegrationConnection(c.id, { status: c.status === 'PAUSED' ? 'CONNECTED' : 'PAUSED' }), c.status === 'PAUSED' ? 'Resumed.' : 'Paused.')}
            >
              {c.status === 'PAUSED' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />} {c.status === 'PAUSED' ? 'Resume' : 'Pause'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-alert hover:bg-alert/10"
              onClick={async () => {
                if (!(await confirm({ title: `Disconnect ${c.name}?`, description: 'The sync log goes with it. The vendor keeps what was already sent.', confirmLabel: 'Disconnect', destructive: true }))) return;
                await act('delete', () => deleteIntegrationConnection(c.id), 'Disconnected.');
                navigate('/integrations');
              }}
            >
              <Trash2 className="h-4 w-4" /> Disconnect
            </Button>
          </>
        ) : undefined
      }
      summary={
        c ? (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatTile label="State" value={<Badge variant={status!.variant}>{status!.label}</Badge>} sub={c.lastError ?? (c.eventDriven ? 'Runs on events' : 'Manual and scheduled only')} />
            <StatTile label="Last sync" value={c.lastSyncAt ? fmtDateTime(c.lastSyncAt) : '—'} sub={c.lastRun ? `${INTEGRATION_CAPABILITY_LABELS[c.lastRun.capability]} · ${runStatus(c.lastRun.status).label}` : 'No run yet'} />
            <StatTile label="Next sync" value={c.nextSyncAt && c.status === 'CONNECTED' ? fmtDateTime(c.nextSyncAt) : '—'} sub={c.scheduleMinutes ? `Every ${c.scheduleMinutes >= 60 ? `${c.scheduleMinutes / 60} h` : `${c.scheduleMinutes} min`}` : 'No schedule'} />
            <StatTile label="Rejected · last 10 runs" value={rejected} sub={rejected ? 'Open a run for the records' : 'Every record accepted'} className={rejected ? 'border-alert/40' : undefined} />
          </div>
        ) : undefined
      }
      filters={
        c && canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select size="sm" aria-label="Capability to run" value={capability} onChange={(e) => setCapability(e.target.value as IntegrationCapability | '')}>
              <option value="">Run now…</option>
              {(vendor?.capabilities ?? []).map((cap) => (
                <option key={cap} value={cap}>{INTEGRATION_CAPABILITY_LABELS[cap]}</option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!capability}
              loading={busy === 'sync'}
              onClick={() => capability && void act('sync', () => syncIntegrationConnection(c.id, { capability }), `${INTEGRATION_CAPABILITY_LABELS[capability]} ran.`)}
            >
              <RefreshCw className="h-4 w-4" /> Sync now
            </Button>
            {c.sandbox && <span className="text-xs text-ink-muted">Sandbox: the vendor is never called.</span>}
          </div>
        ) : undefined
      }
      drawer={
        <>
          {c && vendor && <ConnectDrawer open={editing} onOpenChange={setEditing} vendors={[vendor]} existing={c} onSaved={() => q.refetch()} />}
          <RunErrorsDrawer run={errorsFor} onClose={() => setErrorsFor(null)} />
        </>
      }
    >
      {q.isError ? (
        <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>Couldn’t load this connection.</ErrorBanner>
      ) : !c ? (
        <Card><CardContent className="p-5"><SkeletonRows count={4} /></CardContent></Card>
      ) : runs.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={RefreshCw} title="No runs yet" description="Run the sandbox test, or sync one capability now. Every run leaves a row here with what it sent and what the vendor rejected." />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Sync log</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs2 uppercase tracking-[0.14em] text-ink-muted">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">What</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">Trigger</th>
                  <th className="px-4 py-2 text-right font-medium">Records</th>
                  <th className="px-4 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const s = runStatus(r.status);
                  const summary = r.summary ?? {};
                  const note = runNote(summary);
                  return (
                    <tr key={r.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5 align-top tabular-nums text-ink-muted">{fmtDateTime(r.startedAt)}</td>
                      <td className="px-4 py-2.5 align-top">
                        <span className="block text-ink">{INTEGRATION_CAPABILITY_LABELS[r.capability]}</span>
                        {note && <span className="block text-xs text-ink-muted">{note}</span>}
                      </td>
                      <td className="hidden px-4 py-2.5 align-top text-ink-muted md:table-cell">{r.trigger === 'sandbox-test' ? 'Sandbox test' : r.trigger === 'event' ? `Event · ${r.eventType ?? ''}` : r.trigger === 'schedule' ? 'Schedule' : 'Manual'}</td>
                      <td className="px-4 py-2.5 text-right align-top tabular-nums">
                        <span className="text-ink">{r.succeeded}</span>
                        <span className="text-ink-muted"> / {r.total}</span>
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        {r.failed > 0 ? (
                          <button type="button" className="inline-flex items-center gap-2 text-left" onClick={() => setErrorsFor(r)}>
                            <Badge variant={s.variant} size="sm">{s.label}</Badge>
                            <span className="text-xs text-alert underline underline-offset-2">{r.failed} rejected</span>
                          </button>
                        ) : (
                          <Badge variant={s.variant} size="sm">{s.label}</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </ListTemplate>
  );
}

/** One line under the capability: the period, the reconciliation, the staged count. */
function runNote(summary: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (Array.isArray(summary.period) && summary.period.length === 2) parts.push(`${String(summary.period[0])} to ${String(summary.period[1])}`);
  if (typeof summary.hours === 'number') parts.push(`${summary.hours} h`);
  if (typeof summary.reconciled === 'boolean') parts.push(summary.reconciled ? 'reconciled to the run' : 'totals do not match the run');
  if (typeof summary.staged === 'number') parts.push(`${summary.staged} staged${typeof summary.matched === 'number' ? `, ${summary.matched} known` : ''}`);
  if (typeof summary.error === 'string') parts.push(summary.error);
  return parts.length ? parts.join(' · ') : null;
}

function RunErrorsDrawer({ run, onClose }: { run: IntegrationSyncRunSummary | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['integrations', 'run-errors', run?.id ?? ''], queryFn: () => listIntegrationRunErrors(run!.id), enabled: !!run });
  return (
    <Drawer open={!!run} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>{run ? `${INTEGRATION_CAPABILITY_LABELS[run.capability]} · ${run.failed} rejected` : 'Rejected records'}</DrawerTitle>
        <DrawerDescription>{run ? `${fmtDateTime(run.startedAt)} · the vendor’s reason per record, with the payload around it (identifiers masked).` : ''}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {q.isError ? (
          <ErrorBanner>Couldn’t load the errors.</ErrorBanner>
        ) : !q.data ? (
          <SkeletonRows count={3} />
        ) : (
          <ul className="divide-y divide-line">
            {q.data.errors.map((e) => (
              <li key={e.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <span className="font-mono text-xs text-ink-muted">{e.recordRef}</span>
                </div>
                <p className="mt-0.5 text-sm text-ink">{e.message}</p>
                {e.excerpt && (
                  <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-navy-secondary/40 p-2 text-xs2 text-ink-muted">{JSON.stringify(e.excerpt, null, 2)}</pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </DrawerBody>
    </Drawer>
  );
}
