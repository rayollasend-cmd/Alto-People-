import { TechnicalDetail } from '../providers/providerShared';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FlaskConical, Pause, Pencil, Play, RefreshCw, Trash2 } from '@/components/ui/icons';
import { INTEGRATION_CAPABILITY_LABELS, type IntegrationCapability, type IntegrationSyncRunSummary } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useUrlParam } from '@/lib/useUrlState';
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
import { DataGrid } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { FilterBar, FilterChip } from '@/components/ui/FilterBar';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ConnectDrawer } from './ConnectDrawer';
import { connectionStatus, runStatus } from './shared';

/**
 * One connection: its state in four numbers, the actions (sandbox test,
 * sync now, pause, edit, disconnect), and the sync log — every run with
 * its counts, and the per-record errors of a run behind a click.
 */
const RUN_FILTERS = ['all', 'FAILED', 'PARTIAL', 'SUCCEEDED'] as const;
type RunFilter = (typeof RUN_FILTERS)[number];
const RUN_FILTER_LABELS: Record<RunFilter, string> = { all: 'All runs', FAILED: 'Failed', PARTIAL: 'Partial', SUCCEEDED: 'Succeeded' };

const triggerLabel = (r: IntegrationSyncRunSummary) => (r.trigger === 'sandbox-test' ? 'Sandbox test' : r.trigger === 'event' ? `Event · ${r.eventType ?? ''}` : r.trigger === 'schedule' ? 'Schedule' : 'Manual');

/**
 * One connection (Brief 3-5; F500 G4): its state in four numbers, the one
 * action that matters — Sync now — with the sandbox test beside it and the
 * rest (pause, edit, disconnect) in More, and the sync log as a list you
 * can filter to the runs that failed. Every run's per-record errors are a
 * click away.
 */
export function ConnectionPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:integrations') : false;
  const q = useQuery({ queryKey: ['integrations', 'connection', id], queryFn: () => getIntegrationConnection(id), enabled: !!id });
  const [editing, setEditing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorsFor, setErrorsFor] = useState<IntegrationSyncRunSummary | null>(null);
  const [runFilter, setRunFilter] = useUrlParam<RunFilter>('runs', 'all', RUN_FILTERS);

  const c = q.data?.connection ?? null;
  const vendor = q.data?.vendor ?? null;
  const runs = useMemo(() => q.data?.runs ?? [], [q.data]);
  const shownRuns = useMemo(() => (runFilter === 'all' ? runs : runs.filter((r) => r.status === runFilter)), [runs, runFilter]);
  const caps = vendor?.capabilities ?? [];

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
  const syncNow = (capability: IntegrationCapability) => {
    if (!c) return;
    void act('sync', () => syncIntegrationConnection(c.id, { capability }), `${INTEGRATION_CAPABILITY_LABELS[capability]} ran.`);
  };

  const title = c?.name ?? 'Connection';
  const status = c ? connectionStatus(c) : null;
  const rejected = runs.slice(0, 10).reduce((a, r) => a + r.failed, 0);

  return (
    <ListTemplate
      title={title}
      subtitle={c && vendor ? `${vendor.label} · ${c.sandbox ? 'sandbox: the vendor is never called' : 'live'}${c.hasCredentials ? ' · credentials on file' : ''}` : undefined}
      status={status ? <Badge variant={status.variant}>{status.label}</Badge> : undefined}
      actions={
        c && canManage
          ? [
              {
                label: 'Sync now',
                icon: RefreshCw,
                primary: true,
                loading: busy === 'sync',
                disabled: caps.length === 0 || c.status === 'PAUSED',
                hint: c.status === 'PAUSED' ? 'Resume the connection first.' : undefined,
                onSelect: () => (caps.length === 1 ? syncNow(caps[0]!) : setChoosing(true)),
              },
              { label: 'Sandbox test', icon: FlaskConical, loading: busy === 'test', onSelect: () => void act('test', () => testIntegrationConnection(c.id), 'Sandbox test ran; the log is below.') },
              {
                label: c.status === 'PAUSED' ? 'Resume' : 'Pause',
                icon: c.status === 'PAUSED' ? Play : Pause,
                overflow: true,
                onSelect: () => void act('pause', () => patchIntegrationConnection(c.id, { status: c.status === 'PAUSED' ? 'CONNECTED' : 'PAUSED' }), c.status === 'PAUSED' ? 'Resumed.' : 'Paused.'),
              },
              { label: 'Edit', icon: Pencil, overflow: true, onSelect: () => setEditing(true) },
              {
                label: 'Disconnect',
                icon: Trash2,
                destructive: true,
                confirm: { title: `Disconnect ${c.name}?`, description: 'The sync log goes with it. The vendor keeps what was already sent.', confirmLabel: 'Disconnect', destructive: true },
                onSelect: () =>
                  void act('delete', () => deleteIntegrationConnection(c.id), 'Disconnected.').then(() => navigate('/integrations')),
              },
            ]
          : undefined
      }
      summary={
        c ? (
          <div className="space-y-2">
          <MetricStrip label="Connection at a glance">
            <MetricCard label="Last sync" value={c.lastSyncAt ? fmtDateTime(c.lastSyncAt) : 'Never'} hint={c.lastRun ? `${INTEGRATION_CAPABILITY_LABELS[c.lastRun.capability]} · ${runStatus(c.lastRun.status).label}` : 'No run yet'} compact />
            <MetricCard label="Next sync" value={c.nextSyncAt && c.status === 'CONNECTED' ? fmtDateTime(c.nextSyncAt) : '—'} hint={c.scheduleMinutes ? `Every ${c.scheduleMinutes >= 60 ? `${c.scheduleMinutes / 60} h` : `${c.scheduleMinutes} min`}` : c.eventDriven ? 'On events only' : 'Manual only'} compact />
            <MetricCard label="Rejected · last 10 runs" value={rejected} tone={rejected > 0 ? 'alert' : 'neutral'} hint={rejected ? 'Filter to the failed runs below' : 'Every record accepted'} onClick={rejected ? () => setRunFilter('FAILED') : undefined} compact />
            <MetricCard label="Latest error" value={c.lastError ? 'Yes' : 'None'} tone={c.lastError ? 'alert' : 'neutral'} hint={c.lastError ?? 'The last run reported no error'} compact />
          </MetricStrip>
          {/* The plain sentence is on the tile; the system's own words sit behind "Technical details" (F500 2026-10-26). */}
          <TechnicalDetail detail={c.lastErrorDetail} />
          </div>
        ) : undefined
      }
      filters={
        runs.length > 0 ? (
          <FilterBar urlKey="runs" onClearFilters={() => setRunFilter('all')}>
            {RUN_FILTERS.map((f) => (
              <FilterChip key={f} active={runFilter === f} onClick={() => setRunFilter(f)} count={f === 'all' ? runs.length : runs.filter((r) => r.status === f).length}>
                {RUN_FILTER_LABELS[f]}
              </FilterChip>
            ))}
          </FilterBar>
        ) : undefined
      }
      drawer={
        <>
          {c && vendor && <ConnectDrawer open={editing} onOpenChange={setEditing} vendors={[vendor]} existing={c} onSaved={() => q.refetch()} />}
          <RunErrorsDrawer run={errorsFor} onClose={() => setErrorsFor(null)} />
          <SyncChooser open={choosing} capabilities={caps} onClose={() => setChoosing(false)} onRun={(cap) => { setChoosing(false); syncNow(cap); }} />
        </>
      }
    >
      {q.isError ? (
        <QueryError what="this connection" query={q} />
      ) : !c ? (
        <Card><CardContent><SkeletonRows count={4} /></CardContent></Card>
      ) : (
        <DataGrid<IntegrationSyncRunSummary>
          id="sync-log"
          caption="Sync log"
          noun={{ one: 'run', many: 'runs' }}
          rows={shownRuns}
          rowKey={(r) => r.id}
          search={false}
          urlState={false}
          exportCsv={false}
          activeFilters={runFilter === 'all' ? 0 : 1}
          onClearFilters={() => setRunFilter('all')}
          empty={{ icon: RefreshCw, title: 'No runs yet', description: 'Run the sandbox test, or sync now. Every run leaves a row here with what it sent and what the vendor rejected.' }}
          onRowClick={(r) => (r.failed > 0 ? setErrorsFor(r) : undefined)}
          rowActionLabel={(r) => `${INTEGRATION_CAPABILITY_LABELS[r.capability]}, ${fmtDateTime(r.startedAt)}`}
          columns={[
            { key: 'when', header: 'When', accessor: (r) => r.startedAt, sortable: true, className: 'whitespace-nowrap tabular-nums text-ink-muted', cell: (r) => fmtDateTime(r.startedAt) },
            {
              key: 'what',
              header: 'What',
              accessor: (r) => INTEGRATION_CAPABILITY_LABELS[r.capability],
              primary: true,
              cell: (r) => {
                const note = runNote(r.summary ?? {});
                return (
                  <span className="block min-w-0">
                    <span className="block text-ink">{INTEGRATION_CAPABILITY_LABELS[r.capability]}</span>
                    {note && <span className="block text-xs text-ink-muted">{note}</span>}
                  </span>
                );
              },
            },
            { key: 'trigger', header: 'Trigger', accessor: (r) => triggerLabel(r), cardMeta: true, className: 'text-ink-muted' },
            { key: 'records', header: 'Records', accessor: (r) => r.total, align: 'right', cell: (r) => <span className="tabular-nums"><span className="text-ink">{r.succeeded}</span><span className="text-ink-muted"> / {r.total}</span></span> },
            {
              key: 'result',
              header: 'Result',
              accessor: (r) => runStatus(r.status).label,
              sortable: true,
              cardMeta: true,
              cell: (r) => {
                const st = runStatus(r.status);
                return (
                  <span className="inline-flex items-center gap-2">
                    <Badge variant={st.variant} size="sm">{st.label}</Badge>
                    {r.failed > 0 && <span className="text-xs text-alert underline underline-offset-2">{r.failed} rejected</span>}
                  </span>
                );
              },
            },
          ]}
        />
      )}
    </ListTemplate>
  );
}

/** Which capability to run now, when the vendor offers more than one. */
function SyncChooser({ open, capabilities, onClose, onRun }: { open: boolean; capabilities: IntegrationCapability[]; onClose: () => void; onRun: (c: IntegrationCapability) => void }) {
  const [cap, setCap] = useState<IntegrationCapability | ''>('');
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sync now</DialogTitle>
          <DialogDescription>Run one of the vendor’s capabilities now. The run lands in the sync log with what it sent and what was rejected.</DialogDescription>
        </DialogHeader>
        <Field label="What to run">
          {(fp) => (
            <Select {...fp} value={cap} onChange={(e) => setCap(e.target.value as IntegrationCapability | '')}>
              <option value="">Choose…</option>
              {capabilities.map((k) => (
                <option key={k} value={k}>{INTEGRATION_CAPABILITY_LABELS[k]}</option>
              ))}
            </Select>
          )}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!cap} onClick={() => cap && onRun(cap)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
