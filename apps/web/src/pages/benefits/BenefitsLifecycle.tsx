import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { CalendarDays, HeartPulse, Plus, ShieldOff } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import {
  createCobra,
  createOpenEnrollment,
  createQle,
  decideQle,
  electCobra,
  listCobra,
  listOpenEnrollment,
  listQles,
  openEnrollmentClose,
  openEnrollmentOpen,
  waiveCobra,
  type CobraOffer,
  type OpenEnrollmentWindow,
  type Qle,
  type QleKind,
} from '@/lib/benefitsLifecycle92Api';
import { useClients } from '@/lib/useClients';
import { fmtDate, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { useAuth, useTerm } from '@/lib/auth';
import { useUrlParam } from '@/lib/useUrlState';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import { StatusBadge } from '@/lib/status';
import {
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { Label } from '@/components/ui/Label';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { ListTemplate } from '@/components/templates';
import { toast } from 'sonner';
import { pickOne } from '@/lib/validationCopy';

type Tab = 'oe' | 'qle' | 'cobra';
/** 'auto' = no ?tab: open on the first tab with work pending. */
type TabParam = Tab | 'auto';
const TAB_PARAMS: TabParam[] = ['auto', 'oe', 'qle', 'cobra'];

// Format a date-only "YYYY-MM-DD" string via the shared formatter. Parsing
// through parseYmd keeps the day stable west of UTC (new Date('YYYY-MM-DD')
// is UTC midnight and renders a day early there).
const fmtYmd = (s: string | null | undefined) => fmtDate(parseYmd(s));

// Add n days to a YYYY-MM-DD string (local calendar math).
function addDaysYmd(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  d.setDate(d.getDate() + days);
  return ymdLocal(d);
}

/** Shared "section failed to load" body with a Retry affordance. */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-6">
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {message}
      </ErrorBanner>
    </div>
  );
}

/**
 * What each tab has waiting on someone: windows to open (drafts) or to
 * close (open past their end), life events nobody has decided, COBRA offers
 * the person hasn't answered. The tabs read the same queries, so a count
 * and its rows never disagree.
 */
export function lifecyclePending(data: { windows?: OpenEnrollmentWindow[]; qles?: Qle[]; offers?: CobraOffer[] }, today: string = ymdLocal()) {
  return {
    oe: data.windows?.filter((w) => w.status === 'DRAFT' || (w.status === 'OPEN' && w.endsOn < today)).length,
    qle: data.qles?.filter((q) => q.status === 'PENDING').length,
    cobra: data.offers?.filter((c) => c.status === 'NOTIFIED').length,
  };
}

/** The first tab, in order, with something waiting; else Open enrollment. */
export function firstPendingTab(p: { oe?: number; qle?: number; cobra?: number }): Tab {
  return (['oe', 'qle', 'cobra'] as const).find((k) => (p[k] ?? 0) > 0) ?? 'oe';
}

export function BenefitsLifecycle() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'process:payroll') : false;
  const [params] = useSearchParams();
  const [tabParam, setTab] = useUrlParam<TabParam>('tab', 'auto', TAB_PARAMS, { history: 'push' });
  const oe = useQuery({ queryKey: ['OeTab', 'rows'], queryFn: () => listOpenEnrollment() });
  const qle = useQuery({ queryKey: ['QleTab', 'rows'], queryFn: () => listQles() });
  const cobra = useQuery({ queryKey: ['CobraTab', 'rows'], queryFn: () => listCobra() });
  const pending = lifecyclePending({ windows: oe.data?.windows, qles: qle.data?.qles, offers: cobra.data?.offers });
  // Opened without a tab: wait for the counts, then land where the work is.
  const settled = !oe.isPending && !qle.isPending && !cobra.isPending;
  const tab: Tab = tabParam !== 'auto' ? tabParam : firstPendingTab(pending);

  // The 1095-C filing moved to ACA hours (Annual filing); old links land there.
  if (params.get('tab') === 'aca') return <Navigate to="/benefits/aca?tab=filing" replace />;

  const count = (n: number | undefined) => (n ? <span className="ml-1.5 text-xs tabular-nums text-ink-muted">({n})</span> : null);
  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Benefits lifecycle"
        subtitle="Open enrollment, life events and COBRA offers. The 1095-C filing is on ACA hours."
        related={[{ label: 'ACA hours & filing', to: '/benefits/aca' }]}
    >
      {tabParam === 'auto' && !settled ? (
        <SkeletonRows count={4} />
      ) : (
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="oe" className="inline-flex items-center">
            <CalendarDays className="mr-2 hidden h-4 w-4 sm:inline-block" aria-hidden="true" /> Open enrollment
            {count(pending.oe)}
          </TabsTrigger>
          <TabsTrigger value="qle" className="inline-flex items-center">
            <HeartPulse className="mr-2 hidden h-4 w-4 sm:inline-block" aria-hidden="true" /> Life events
            {count(pending.qle)}
          </TabsTrigger>
          <TabsTrigger value="cobra" className="inline-flex items-center">
            <ShieldOff className="mr-2 hidden h-4 w-4 sm:inline-block" aria-hidden="true" /> COBRA
            {count(pending.cobra)}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="oe"><OeTab canManage={canManage} /></TabsContent>
        <TabsContent value="qle"><QleTab canManage={canManage} /></TabsContent>
        <TabsContent value="cobra"><CobraTab canManage={canManage} /></TabsContent>
      </Tabs>
      )}
    </ListTemplate>
  );
}

function OeTab({ canManage }: { canManage: boolean }) {
  const term = useTerm();
  const [showNew, setShowNew] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['OeTab', 'rows'],
    queryFn: () => listOpenEnrollment(),
  });
  const rows: OpenEnrollmentWindow[] | null = refreshQuery.data?.windows ?? null;
  const error = refreshQuery.error ? refreshQuery.error instanceof ApiError
            ? refreshQuery.error.message
            : 'Could not load open enrollment windows.' : null;
  const refresh = () => void refreshQuery.refetch();

  const onOpen = async (w: OpenEnrollmentWindow) => {
    try {
      await openEnrollmentOpen(w.id);
      toast.success(`${w.name} is now open for elections.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not open the window.');
    }
  };

  const onCloseWindow = async (w: OpenEnrollmentWindow) => {
    try {
      await openEnrollmentClose(w.id);
      toast.success(`${w.name} closed.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not close the window.');
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New window
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {error !== null ? (
            <LoadError message={error} onRetry={refresh} />
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="No open enrollment windows"
              description="Open a window so associates can elect benefits for the next plan year."
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="oe-windows"
              caption="Open enrollment windows"
              rows={rows}
              rowKey={(w) => w.id}
              search={{ placeholder: 'Window, client…' }}
              urlState={false}
              exportCsv={{ filename: 'open-enrollment-windows' }}
              columns={[
                { key: 'window', header: 'Window', accessor: (w) => w.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'client', header: term('label.client'), accessor: (w) => w.clientName, sortable: true, cardMeta: true },
                { key: 'period', header: 'Period', accessor: (w) => w.startsOn, csv: (w) => `${fmtYmd(w.startsOn)} → ${fmtYmd(w.endsOn)}`, sortable: true, searchable: false, cardMeta: true, className: 'tabular-nums', cell: (w) => `${fmtYmd(w.startsOn)} → ${fmtYmd(w.endsOn)}` },
                { key: 'effective', header: 'Effective', accessor: (w) => w.effectiveOn, sortable: true, searchable: false, className: 'tabular-nums', cell: (w) => fmtYmd(w.effectiveOn) },
                { key: 'status', header: 'Status', accessor: (w) => w.status, sortable: true, cell: (w) => <StatusBadge status={w.status} /> },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'space-x-2',
                  cell: (w) => (
                    <>
                      {canManage && w.status === 'DRAFT' && (
                        <Button size="sm" onClick={() => onOpen(w)}>
                          Open
                        </Button>
                      )}
                      {canManage && w.status === 'OPEN' && (
                        <Button size="sm" variant="ghost" onClick={() => onCloseWindow(w)}>
                          Close
                        </Button>
                      )}
                    </>
                  ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewOeDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewOeDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const term = useTerm();
  const [clientId, setClientId] = useState('');
  // Shared react-query cache — fetched at most once per 5 minutes app-wide.
  const {
    clients,
    isLoading: clientsLoading,
    isError: clientsError,
    refetch: refetchClients,
  } = useClients();
  const [name, setName] = useState('');
  // Defaults: a 30-day window starting today, coverage effective next Jan 1
  // (the typical plan-year boundary). All editable.
  const [startsOn, setStartsOn] = useState(ymdLocal());
  const [endsOn, setEndsOn] = useState(addDaysYmd(ymdLocal(), 30));
  const [effectiveOn, setEffectiveOn] = useState(
    `${new Date().getFullYear() + 1}-01-01`,
  );
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (clientsError || clientsLoading) {
      toast.error('The client list failed to load — retry it before creating a window.');
      return;
    }
    if (!clientId || !name || !startsOn || !endsOn || !effectiveOn) {
      toast.error('All fields required.');
      return;
    }
    setSaving(true);
    try {
      await createOpenEnrollment({
        clientId: clientId.trim(),
        name: name.trim(),
        startsOn,
        endsOn,
        effectiveOn,
      });
      toast.success('Window created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the window.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New OE window</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label htmlFor="bl-oe-client">{term('label.client')}</Label>
          {clientsError ? (
            <ErrorBanner
              className="mt-1"
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void refetchClients()}
                >
                  Retry
                </Button>
              }
            >
              Could not load the client list.
            </ErrorBanner>
          ) : (
            <Select
              id="bl-oe-client"
              className="mt-1"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={clientsLoading}
            >
              <option value="">
                {clientsLoading ? 'Loading clients…' : 'Select a client…'}
              </option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        <div>
          <Label>Window name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="2026 Open Enrollment"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Starts on</Label>
            <Input
              type="date"
              className="mt-1"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
            />
          </div>
          <div>
            <Label>Ends on</Label>
            <Input
              type="date"
              className="mt-1"
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Coverage effective on</Label>
          <Input
            type="date"
            className="mt-1"
            value={effectiveOn}
            onChange={(e) => setEffectiveOn(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={onSubmit}
          disabled={saving || clients === null || clientsError !== null}
        >
          {saving ? 'Saving…' : 'Create'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

const QLE_KIND_LABEL: Record<QleKind, string> = {
  MARRIAGE: 'Marriage',
  DIVORCE: 'Divorce',
  BIRTH: 'Birth',
  ADOPTION: 'Adoption',
  DEATH_OF_DEPENDENT: 'Death of dependent',
  LOSS_OF_COVERAGE: 'Loss of coverage',
  GAIN_OF_COVERAGE: 'Gain of coverage',
  RELOCATION: 'Relocation',
  OTHER: 'Other',
};

function QleTab({ canManage }: { canManage: boolean }) {
  const term = useTerm();
  const prompt = usePrompt();
  const [showNew, setShowNew] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['QleTab', 'rows'],
    queryFn: () => listQles(),
  });
  const rows: Qle[] | null = refreshQuery.data?.qles ?? null;
  const error = refreshQuery.error ? refreshQuery.error instanceof ApiError
            ? refreshQuery.error.message
            : 'Could not load life events.' : null;
  const refresh = () => void refreshQuery.refetch();

  const onApprove = async (q: Qle) => {
    try {
      await decideQle(q.id, 'APPROVED');
      toast.success(`${q.associateName}'s life event approved — their change window is open.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not approve the life event.');
    }
  };

  const onDeny = async (q: Qle) => {
    const reason = await prompt({
      title: `Deny ${q.associateName}'s life event?`,
      description:
        'They are told the life event was denied, with this reason.',
      reasonLabel: 'Denial reason',
      reasonPlaceholder: 'Missing documentation, event outside the window, …',
      confirmLabel: 'Deny life event',
      destructive: true,
    });
    if (reason === null) return;
    try {
      // decideQle() doesn't carry a reason; POST directly so the API can
      // include it in the associate's denial notification.
      await apiFetch<{ ok: true }>(`/qles/${q.id}/decide`, {
        method: 'POST',
        body: { decision: 'DENIED', reason },
      });
      toast.success(`${q.associateName}'s life event denied.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not deny the life event.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Record a life event
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {error !== null ? (
            <LoadError message={error} onRetry={refresh} />
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={HeartPulse}
              title="No life events"
              description="A marriage, a birth or a lost coverage opens a 30-day window to change benefits. Record one here when someone tells you."
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="qualifying-life-events"
              caption="Life events"
              rows={rows}
              rowKey={(q) => q.id}
              search={{ placeholder: `${term('worker')}, kind…` }}
              urlState={false}
              exportCsv={{ filename: 'life-events' }}
              columns={[
                {
                  key: 'associate',
                  header: term('worker'),
                  accessor: (q) => q.associateName,
                  sortable: true,
                  primary: true,
                  className: 'font-medium text-white',
                  cell: (q) => <AssociateLink associateId={q.associateId}>{q.associateName}</AssociateLink>,
                },
                { key: 'kind', header: 'Kind', accessor: (q) => QLE_KIND_LABEL[q.kind], sortable: true, cardMeta: true },
                { key: 'event', header: 'Event', accessor: (q) => q.eventDate, sortable: true, searchable: false, cardMeta: true, className: 'tabular-nums', cell: (q) => fmtYmd(q.eventDate) },
                { key: 'windowEnds', header: 'Window ends', accessor: (q) => q.allowedUntil, sortable: true, searchable: false, className: 'tabular-nums', cell: (q) => fmtYmd(q.allowedUntil) },
                { key: 'status', header: 'Status', accessor: (q) => q.status, sortable: true, cell: (q) => <StatusBadge status={q.status} /> },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'space-x-2',
                  cell: (q) =>
                    canManage && q.status === 'PENDING' ? (
                      <>
                        <Button size="sm" onClick={() => onApprove(q)}>
                          Approve
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onDeny(q)}>
                          Deny
                        </Button>
                      </>
                    ) : null,
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewQleDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewQleDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const term = useTerm();
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [kind, setKind] = useState<QleKind>('MARRIAGE');
  const [eventDate, setEventDate] = useState(ymdLocal());
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Live deadline hint: standard 30-day special-enrollment window from the
  // event date. Pure client-side math — the server computes the canonical
  // allowedUntil on create.
  const eventParsed = parseYmd(eventDate);
  const electionCloses = eventParsed
    ? new Date(eventParsed.getFullYear(), eventParsed.getMonth(), eventParsed.getDate() + 30)
    : null;

  const onSubmit = async () => {
    if (!assoc) {
      toast.error(pickOne(term));
      return;
    }
    if (!eventDate) {
      toast.error('Event date required.');
      return;
    }
    setSaving(true);
    try {
      await createQle({
        associateId: assoc.id,
        kind,
        eventDate,
        evidenceUrl: evidenceUrl.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success('Life event recorded.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the life event.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Record a life event</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{term('worker')}</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        <div>
          <Label htmlFor="bl-event-kind">Event kind</Label>
          <Select
            id="bl-event-kind"
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as QleKind)}
          >
            {(Object.keys(QLE_KIND_LABEL) as QleKind[]).map((k) => (
              <option key={k} value={k}>
                {QLE_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Event date</Label>
          <Input
            type="date"
            className="mt-1"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
          />
          {electionCloses && (
            <p className="mt-1 text-xs text-silver">
              Election window closes {fmtDate(electionCloses)}
            </p>
          )}
        </div>
        <div>
          <Label>Evidence URL (optional)</Label>
          <Input
            className="mt-1"
            value={evidenceUrl}
            onChange={(e) => setEvidenceUrl(e.target.value)}
            placeholder="https://..."
          />
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea
            className="mt-1"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Submit'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// COBRA-only codes the shared vocabulary doesn't carry: NOTIFIED is the
// awaiting-election state; ELECTED is this domain's terminal-good.
const COBRA_STATUS_TONES = { NOTIFIED: 'pending', ELECTED: 'success' } as const;

function CobraTab({ canManage }: { canManage: boolean }) {
  const term = useTerm();
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['CobraTab', 'rows'],
    queryFn: () => listCobra(),
  });
  const rows: CobraOffer[] | null = refreshQuery.data?.offers ?? null;
  const error = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Could not load COBRA offers.' : null;
  const refresh = () => void refreshQuery.refetch();

  const onElect = async (c: CobraOffer) => {
    if (
      !(await confirm({
        title: `Record COBRA election for ${c.associateName}?`,
        description: `Marks this offer as elected — continuation coverage runs through ${fmtYmd(c.coverageEndsOn)}.`,
        confirmLabel: 'Record election',
      }))
    ) {
      return;
    }
    try {
      await electCobra(c.id);
      toast.success(`COBRA election recorded for ${c.associateName}.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the election.');
    }
  };

  const onWaive = async (c: CobraOffer) => {
    if (
      !(await confirm({
        title: `Waive COBRA for ${c.associateName}?`,
        description:
          'Marks this offer as waived. The associate declines continuation coverage — this closes their election window.',
        confirmLabel: 'Waive coverage',
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await waiveCobra(c.id);
      toast.success(`COBRA waived for ${c.associateName}.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not waive the offer.');
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> Notify COBRA
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {error !== null ? (
            <LoadError message={error} onRetry={refresh} />
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ShieldOff}
              title="No COBRA offers"
              description="On termination or hours reduction, generate a continuation-coverage offer."
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="cobra-offers"
              caption="COBRA offers"
              rows={rows}
              rowKey={(c) => c.id}
              search={{ placeholder: `${term('worker')}, event…` }}
              urlState={false}
              exportCsv={{ filename: 'cobra-offers' }}
              columns={[
                {
                  key: 'associate',
                  header: term('worker'),
                  accessor: (c) => c.associateName,
                  sortable: true,
                  primary: true,
                  className: 'font-medium text-white',
                  cell: (c) => <AssociateLink associateId={c.associateId}>{c.associateName}</AssociateLink>,
                },
                { key: 'qe', header: 'Event', accessor: (c) => COBRA_EVENT_LABEL[c.qualifyingEvent] ?? c.qualifyingEvent, sortable: true, cardMeta: true },
                { key: 'qeDate', header: 'Event date', accessor: (c) => c.qeDate, sortable: true, searchable: false, className: 'tabular-nums', cell: (c) => fmtYmd(c.qeDate) },
                { key: 'electBy', header: 'Election by', accessor: (c) => c.electionDeadline, sortable: true, searchable: false, cardMeta: true, className: 'tabular-nums', cell: (c) => fmtYmd(c.electionDeadline) },
                { key: 'premium', header: 'Premium/mo', accessor: (c) => (c.premiumPerMonth ? Number(c.premiumPerMonth) : null), csv: (c) => fmtMoney(c.premiumPerMonth), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (c) => fmtMoney(c.premiumPerMonth) },
                { key: 'status', header: 'Status', accessor: (c) => c.status, sortable: true, cell: (c) => <StatusBadge status={c.status} overrides={COBRA_STATUS_TONES} /> },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'space-x-2',
                  cell: (c) =>
                    canManage && c.status === 'NOTIFIED' ? (
                      <>
                        <Button size="sm" onClick={() => onElect(c)}>
                          Elect
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onWaive(c)}>
                          Waive
                        </Button>
                      </>
                    ) : null,
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewCobraDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

const COBRA_EVENT_LABEL: Record<string, string> = {
  TERMINATION: 'Termination',
  REDUCTION_OF_HOURS: 'Reduction of hours',
  DEATH: 'Death',
  DIVORCE: 'Divorce',
  MEDICARE: 'Medicare entitlement',
};

function NewCobraDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const term = useTerm();
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [qualifyingEvent, setQualifyingEvent] = useState('TERMINATION');
  const [qeDate, setQeDate] = useState(ymdLocal());
  const [premium, setPremium] = useState('');
  const [saving, setSaving] = useState(false);

  // Live hint: standard COBRA continuation runs 18 months from the
  // qualifying event. Display-only — the server owns the real dates.
  const qeParsed = parseYmd(qeDate);
  const coverageThrough = qeParsed
    ? new Date(qeParsed.getFullYear(), qeParsed.getMonth() + 18, qeParsed.getDate())
    : null;

  const onSubmit = async () => {
    if (!assoc) {
      toast.error(pickOne(term));
      return;
    }
    if (!qeDate) {
      toast.error('Enter the date of the event.');
      return;
    }
    setSaving(true);
    try {
      await createCobra({
        associateId: assoc.id,
        qualifyingEvent: qualifyingEvent.trim(),
        qeDate,
        premiumPerMonth: premium ? Number(premium) : null,
      });
      toast.success('COBRA notified.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the COBRA notice.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Notify COBRA</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{term('worker')}</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        <div>
          <Label htmlFor="bl-qualifying-event">Event</Label>
          <Select
            id="bl-qualifying-event"
            className="mt-1"
            value={qualifyingEvent}
            onChange={(e) => setQualifyingEvent(e.target.value)}
          >
            <option value="TERMINATION">Termination</option>
            <option value="REDUCTION_OF_HOURS">Reduction of hours</option>
            <option value="DEATH">Death</option>
            <option value="DIVORCE">Divorce</option>
            <option value="MEDICARE">Medicare entitlement</option>
          </Select>
        </div>
        <div>
          <Label>Event date</Label>
          <Input
            type="date"
            className="mt-1"
            value={qeDate}
            onChange={(e) => setQeDate(e.target.value)}
          />
          {coverageThrough && (
            <p className="mt-1 text-xs text-silver">
              Coverage can run through {fmtDate(coverageThrough)}
            </p>
          )}
        </div>
        <div>
          <Label>Monthly premium ($) — optional</Label>
          <Input
            type="number"
            step="0.01"
            className="mt-1"
            value={premium}
            onChange={(e) => setPremium(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Notify'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
