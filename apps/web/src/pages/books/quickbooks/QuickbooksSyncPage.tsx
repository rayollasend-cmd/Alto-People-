import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Info, Link2, Pause, Play, RefreshCcw, Unplug } from 'lucide-react';
import type { QboSyncStatus } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import {
  disconnectQbo,
  getQboStatus,
  pauseQbo,
  QBO_KEY,
  resumeQbo,
  startQboConnect,
  syncQboNow,
} from '@/lib/books/quickbooksApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import type { PageAction } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { ConflictsPanel } from './ConflictsPanel';
import { OutboxPanel } from './OutboxPanel';
import { HistoryPanel } from './HistoryPanel';
import { MappingPanel } from './MappingPanel';
import { SettingsPanel } from './SettingsPanel';
import { errMsg, syncSentence } from './qboWords';

/**
 * Books › QuickBooks sync — the company's own QuickBooks Online kept in step
 * both ways: what went over, what came back, and anything waiting for a
 * person to decide. Before it's connected, the page says what will sync and
 * how; once connected, the status, the decisions, the queue, the history,
 * the account mapping and the settings.
 */

type Tab = 'decisions' | 'waiting' | 'history' | 'mapping' | 'settings';
const TABS: Tab[] = ['decisions', 'waiting', 'history', 'mapping', 'settings'];


export function QuickbooksSyncPage() {
  const { can } = useAuth();
  const manage = can('manage:books');
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = useQuery({ queryKey: [...QBO_KEY, 'status'], queryFn: getQboStatus, refetchInterval: 60_000 });
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'decisions') as Tab;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'decisions') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };

  // Back from Intuit: say how it went, once.
  useEffect(() => {
    if (params.get('connected')) toast.success('QuickBooks is connected. The two charts of accounts are linked; changes now go both ways.');
    if (params.get('error')) toast.error(params.get('error') === 'state' ? 'That sign-in link wasn’t yours or had expired. Try connecting again.' : 'QuickBooks couldn’t be connected. Try again.');
    if (params.get('connected') || params.get('error')) {
      const next = new URLSearchParams(params);
      next.delete('connected');
      next.delete('error');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => qc.invalidateQueries({ queryKey: QBO_KEY });
  const connect = useMutation({
    mutationFn: startQboConnect,
    onSuccess: (r) => window.location.assign(r.authorizeUrl),
    onError: (err) => toast.error(errMsg(err, 'Couldn’t start connecting QuickBooks.')),
  });
  const sync = useMutation({
    mutationFn: syncQboNow,
    onSuccess: (r) => {
      if (r.error) toast.error(`The sync stopped: ${r.error}`);
      else toast.success(syncSentence(r));
      void refresh();
    },
    onError: (err) => toast.error(errMsg(err, 'Couldn’t sync now.')),
  });

  const s = status.data;
  const conn = s?.connection ?? null;
  const paused = conn?.status === 'PAUSED';
  const pause = useMutation({
    mutationFn: () => (paused ? resumeQbo() : pauseQbo()),
    onSuccess: () => {
      toast.success(paused ? 'The sync is running again.' : 'The sync is paused.');
      void refresh();
    },
    onError: (err) => toast.error(errMsg(err)),
  });
  const disconnect = useMutation({
    mutationFn: disconnectQbo,
    onSuccess: () => {
      toast.success('QuickBooks is disconnected.');
      void refresh();
    },
    onError: (err) => toast.error(errMsg(err)),
  });
  // Sync now leads; pause beside it; disconnecting is destructive, so it waits under More behind its confirm.
  const actions: PageAction[] =
    manage && conn
      ? [
          ...(conn.status === 'CONNECTED' ? [{ key: 'sync', label: 'Sync now', icon: RefreshCcw, primary: true, loading: sync.isPending, onSelect: () => sync.mutate() }] : []),
          ...(conn.status !== 'NEEDS_RECONNECT' ? [{ key: 'pause', label: paused ? 'Resume' : 'Pause', icon: paused ? Play : Pause, loading: pause.isPending, onSelect: () => pause.mutate() }] : []),
          {
            key: 'disconnect',
            label: 'Disconnect',
            icon: Unplug,
            destructive: true,
            loading: disconnect.isPending,
            confirm: { title: 'Disconnect QuickBooks?', description: 'Nothing more goes over or comes back. Both sets of books keep what they have; changes waiting to go are dropped. You can connect again any time.', confirmLabel: 'Disconnect', destructive: true },
            onSelect: () => disconnect.mutate(),
          },
        ]
      : [];

  return (
    <ListTemplate
      title="QuickBooks sync"
      subtitle="Your company’s QuickBooks kept in step with the books here, both ways: what’s made here goes over, what your accountant does there comes back."
      actions={actions}
      summary={s && conn ? <Summary s={s} /> : undefined}
    >
      {status.isError ? (
        <QueryError what="the QuickBooks sync" query={status} />
      ) : !s ? (
        <SkeletonRows count={6} />
      ) : !conn ? (
        <NotConnected s={s} manage={manage} onConnect={() => connect.mutate()} connecting={connect.isPending} />
      ) : (
        <div className="space-y-4">
          {conn.status === 'NEEDS_RECONNECT' && (
            <Banner tone="alert" title="QuickBooks needs to be reconnected" body={conn.lastError ?? 'QuickBooks stopped accepting the saved sign-in. Nothing goes over or comes back until it’s reconnected; changes wait in the queue.'}>
              {manage && (
                <Button size="sm" onClick={() => connect.mutate()} loading={connect.isPending}>
                  Reconnect QuickBooks
                </Button>
              )}
            </Banner>
          )}
          {conn.status === 'PAUSED' && <Banner tone="warning" title="The sync is paused" body="Changes made here wait in the queue and nothing is brought in from QuickBooks until it’s resumed." />}
          {conn.status === 'CONNECTED' && conn.lastError && <Banner tone="warning" title="The last sync stopped part way" body={conn.lastError} />}
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <div className="-mx-1 overflow-x-auto px-1">
              <TabsList>
                <TabsTrigger value="decisions">
                  Decisions{s.counts.conflicts ? <Badge size="sm" variant="pending" className="ml-1.5">{s.counts.conflicts}</Badge> : null}
                </TabsTrigger>
                <TabsTrigger value="waiting">
                  Waiting to go{s.counts.failed ? <Badge size="sm" variant="destructive" className="ml-1.5">{s.counts.failed}</Badge> : null}
                </TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
                <TabsTrigger value="mapping">Mapping</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="decisions">
              <ConflictsPanel manage={manage} />
            </TabsContent>
            <TabsContent value="waiting">
              <OutboxPanel manage={manage} />
            </TabsContent>
            <TabsContent value="history">
              <HistoryPanel />
            </TabsContent>
            <TabsContent value="mapping">
              <MappingPanel manage={manage} />
            </TabsContent>
            <TabsContent value="settings">
              <SettingsPanel s={s} manage={manage} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </ListTemplate>
  );
}

/* ---- Connected: who, when, how much ------------------------------------ */

function Summary({ s }: { s: QboSyncStatus }) {
  const c = s.connection!;
  const tone = c.status === 'CONNECTED' ? 'success' : c.status === 'PAUSED' ? 'pending' : 'destructive';
  const label = c.status === 'CONNECTED' ? 'Connected' : c.status === 'PAUSED' ? 'Paused' : 'Needs reconnecting';
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-success/10 text-success" aria-hidden="true">
            <Link2 className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-ink">{c.companyName ?? 'Your QuickBooks company'}</p>
              <Badge size="sm" variant={tone}>
                {label}
              </Badge>
              {s.sandboxOnly && (
                <Badge size="sm" variant="info">
                  Simulated
                </Badge>
              )}
            </div>
            <p className="text-sm text-ink-muted">
              {`Company ${c.realmId} · connected ${fmtDate(c.connectedAt)} · last sent ${c.lastPushAt ? fmtDateTime(c.lastPushAt) : 'not yet'} · last brought in ${c.lastPullAt ? fmtDateTime(c.lastPullAt) : 'not yet'}`}
            </p>
            {c.qboClosingDate && <p className="text-xs text-ink-muted">{`QuickBooks’ books are closed through ${fmtDate(c.qboClosingDate)} — nothing dated on or before it is sent.`}</p>}
          </div>
        </CardContent>
      </Card>
      {s.sandboxOnly && (
        <p className="flex items-start gap-2 text-xs text-ink-muted">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          No Intuit keys are set on this server, so QuickBooks is simulated end to end. Set INTUIT_CLIENT_ID and INTUIT_CLIENT_SECRET to connect the real company.
        </p>
      )}
      <MetricStrip label="The sync at a glance">
        <MetricCard label="Waiting to go" value={s.counts.pending} hint="changes made here, queued for QuickBooks" href="/books/quickbooks?tab=waiting" />
        <MetricCard label="Couldn’t go" value={s.counts.failed} tone={s.counts.failed > 0 ? 'alert' : 'default'} hint="stopped after six tries" href="/books/quickbooks?tab=waiting" />
        <MetricCard label="Waiting for a decision" value={s.counts.conflicts} tone={s.counts.conflicts > 0 ? 'warning' : 'default'} hint="changed on both sides" href="/books/quickbooks" />
        <MetricCard label="Records linked" value={s.counts.linked} hint="accounts, vendors, customers, transactions" href="/books/quickbooks?tab=mapping" />
      </MetricStrip>
    </div>
  );
}

/* ---- Not connected: what will happen ------------------------------------ */

const TO_QBO = ['Your chart of accounts, vendors and clients (as customers)', 'Journal entries: payroll as summary lines, depreciation, accruals, entries made by hand', 'Approved vendor bills and their payments', 'Finalized client statements as invoices, and the payments against them'];
const FROM_QBO = ['Accounts and vendors your accountant adds or changes', 'Expenses, deposits, transfers, journal entries, bills and invoices entered there', 'Edits and deletes — the books here follow them'];

function NotConnected({ s, manage, onConnect, connecting }: { s: QboSyncStatus; manage: boolean; onConnect: () => void; connecting: boolean }) {
  return (
    <Card>
      <CardContent className="space-y-6 py-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gold/10 text-gold" aria-hidden="true">
            <RefreshCcw className="h-6 w-6" />
          </span>
          <SectionTitle
            className="mb-0 min-w-0 flex-1"
            title="Connect your company’s QuickBooks"
            description="Everything in the books here goes to QuickBooks, and everything your accountant does in QuickBooks comes back — within minutes, both ways. Payroll goes over as totals, so people’s pay stays here."
          />
          {manage ? (
            <Button className="shrink-0" onClick={onConnect} loading={connecting}>
              Connect QuickBooks
            </Button>
          ) : (
            <p className="shrink-0 text-sm text-ink-muted">Someone who keeps the books can connect it.</p>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Flow icon={ArrowUpFromLine} title="From here to QuickBooks" items={TO_QBO} />
          <Flow icon={ArrowDownToLine} title="From QuickBooks to here" items={FROM_QBO} />
        </div>
        <ul className="space-y-1.5 text-sm text-ink-muted">
          <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />Each record has one home. Changed on both sides, it waits for a person to pick the version to keep — nothing is overwritten silently.</li>
          <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />A closed month stays closed, on either side.</li>
          <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />On connecting, the two charts of accounts are matched by number and name; you can change any match afterwards.</li>
        </ul>
        {s.sandboxOnly && <p className="text-xs text-ink-muted">No Intuit keys are set on this server, so connecting uses a simulated QuickBooks company.</p>}
      </CardContent>
    </Card>
  );
}

function Flow({ icon: Icon, title, items }: { icon: typeof ArrowUpFromLine; title: string; items: string[] }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <p className="flex items-center gap-2 font-medium text-ink">
        <Icon className="h-4 w-4 text-gold" aria-hidden="true" />
        {title}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

export function Banner({ tone, title, body, children }: { tone: 'alert' | 'warning'; title: string; body: string; children?: React.ReactNode }) {
  return (
    <Card className={tone === 'alert' ? 'border-alert/30 bg-alert/5' : 'border-warning/30 bg-warning/5'}>
      <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
        <AlertTriangle className={`mt-0.5 h-5 w-5 shrink-0 ${tone === 'alert' ? 'text-alert' : 'text-warning'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">{title}</p>
          <p className="text-sm text-ink-muted">{body}</p>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}
