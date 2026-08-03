import { useEffect, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import {
  CalendarDays,
  Download,
  FileSpreadsheet,
  HeartPulse,
  Plus,
  ShieldOff,
} from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import {
  createCobra,
  createOpenEnrollment,
  createQle,
  decideQle,
  electCobra,
  get1095c,
  listCobra,
  listOpenEnrollment,
  listQles,
  openEnrollmentClose,
  openEnrollmentOpen,
  waiveCobra,
  type AcaEmployeeMonths,
  type CobraOffer,
  type OpenEnrollmentWindow,
  type Qle,
  type QleKind,
} from '@/lib/benefitsLifecycle92Api';
import { useClients } from '@/lib/useClients';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
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
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { toast } from 'sonner';

type Tab = 'oe' | 'qle' | 'cobra' | 'aca';

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

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

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

export function BenefitsLifecycle() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'process:payroll') : false;
  const [tab, setTab] = useState<Tab>('oe');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Benefits lifecycle"
        subtitle="Open enrollment, qualifying life events, COBRA offers, and ACA 1095-C reporting."
        breadcrumbs={[{ label: 'Benefits' }, { label: 'Lifecycle' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="oe">
            <CalendarDays className="mr-2 h-4 w-4" /> Open enrollment
          </TabsTrigger>
          <TabsTrigger value="qle">
            <HeartPulse className="mr-2 h-4 w-4" /> QLE
          </TabsTrigger>
          <TabsTrigger value="cobra">
            <ShieldOff className="mr-2 h-4 w-4" /> COBRA
          </TabsTrigger>
          <TabsTrigger value="aca">
            <FileSpreadsheet className="mr-2 h-4 w-4" /> ACA / 1095-C
          </TabsTrigger>
        </TabsList>
        <TabsContent value="oe"><OeTab canManage={canManage} /></TabsContent>
        <TabsContent value="qle"><QleTab canManage={canManage} /></TabsContent>
        <TabsContent value="cobra"><CobraTab canManage={canManage} /></TabsContent>
        <TabsContent value="aca"><AcaTab /></TabsContent>
      </Tabs>
    </div>
  );
}

const OE_BADGE: Record<OpenEnrollmentWindow['status'], 'pending' | 'success' | 'default'> = {
  DRAFT: 'default',
  OPEN: 'success',
  CLOSED: 'default',
};

const OE_STATUS_LABELS: Record<OpenEnrollmentWindow['status'], string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  CLOSED: 'Closed',
};

function OeTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<OpenEnrollmentWindow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    setError(null);
    listOpenEnrollment()
      .then((r) => setRows(r.windows))
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load open enrollment windows.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Window</TableHead>
                  <TableHead className="hidden md:table-cell">Client</TableHead>
                  <TableHead className="hidden sm:table-cell">Period</TableHead>
                  <TableHead className="hidden lg:table-cell">Effective</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{w.name}</div>
                      {/* Phone-only secondary line replacing the hidden cells. */}
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {w.clientName}
                      </div>
                      <div className="sm:hidden text-2xs text-silver/80 tabular-nums">
                        {fmtYmd(w.startsOn)} → {fmtYmd(w.endsOn)}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{w.clientName}</TableCell>
                    <TableCell className="hidden sm:table-cell tabular-nums">
                      {fmtYmd(w.startsOn)} → {fmtYmd(w.endsOn)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell tabular-nums">{fmtYmd(w.effectiveOn)}</TableCell>
                    <TableCell>
                      <Badge variant={OE_BADGE[w.status]}>{OE_STATUS_LABELS[w.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
          <Label htmlFor="bl-oe-client">Client</Label>
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

const QLE_BADGE: Record<Qle['status'], 'pending' | 'success' | 'destructive' | 'default'> = {
  PENDING: 'pending',
  APPROVED: 'success',
  DENIED: 'destructive',
  EXPIRED: 'destructive',
};

const QLE_STATUS_LABELS: Record<Qle['status'], string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  EXPIRED: 'Expired',
};

function QleTab({ canManage }: { canManage: boolean }) {
  const prompt = usePrompt();
  const [rows, setRows] = useState<Qle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    setError(null);
    listQles()
      .then((r) => setRows(r.qles))
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load qualifying life events.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const onApprove = async (q: Qle) => {
    try {
      await decideQle(q.id, 'APPROVED');
      toast.success(`${q.associateName}'s QLE approved.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not approve the QLE.');
    }
  };

  const onDeny = async (q: Qle) => {
    const reason = await prompt({
      title: `Deny ${q.associateName}'s QLE?`,
      description:
        'The associate will be notified that their qualifying life event was denied, along with this reason.',
      reasonLabel: 'Denial reason',
      reasonPlaceholder: 'Missing documentation, event outside the window, …',
      confirmLabel: 'Deny QLE',
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
      toast.success(`${q.associateName}'s QLE denied.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not deny the QLE.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> Submit QLE
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
              title="No QLEs"
              description="Major life events like marriage, birth, or loss of coverage trigger a 30-day change window."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead className="hidden sm:table-cell">Kind</TableHead>
                  <TableHead className="hidden md:table-cell">Event</TableHead>
                  <TableHead className="hidden md:table-cell">Window ends</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="font-medium text-white">
                      <div className="truncate"><AssociateLink associateId={q.associateId}>{q.associateName}</AssociateLink></div>
                      {/* Phone-only stack collapsing the hidden cells.
                          Kind first (the why), then a single date line
                          (event → window-close). Mirrors the OE-windows
                          table pattern above. */}
                      <div className="sm:hidden text-xs2 text-silver/70 truncate">
                        {QLE_KIND_LABEL[q.kind]}
                      </div>
                      <div className="md:hidden text-2xs text-silver/80 tabular-nums">
                        {fmtYmd(q.eventDate)} → {fmtYmd(q.allowedUntil)}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{QLE_KIND_LABEL[q.kind]}</TableCell>
                    <TableCell className="hidden md:table-cell tabular-nums">{fmtYmd(q.eventDate)}</TableCell>
                    <TableCell className="hidden md:table-cell tabular-nums">{fmtYmd(q.allowedUntil)}</TableCell>
                    <TableCell>
                      <Badge variant={QLE_BADGE[q.status]}>{QLE_STATUS_LABELS[q.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && q.status === 'PENDING' && (
                        <>
                          <Button size="sm" onClick={() => onApprove(q)}>
                            Approve
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => onDeny(q)}>
                            Deny
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
      toast.error('Pick an associate.');
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
      toast.success('QLE submitted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not submit the QLE.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Submit a QLE</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate</Label>
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

const COBRA_BADGE: Record<CobraOffer['status'], 'pending' | 'success' | 'default' | 'destructive'> = {
  NOTIFIED: 'pending',
  ELECTED: 'success',
  WAIVED: 'default',
  EXPIRED: 'destructive',
  TERMINATED: 'default',
};

const COBRA_STATUS_LABELS: Record<CobraOffer['status'], string> = {
  NOTIFIED: 'Notified',
  ELECTED: 'Elected',
  WAIVED: 'Waived',
  EXPIRED: 'Expired',
  TERMINATED: 'Terminated',
};

function CobraTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<CobraOffer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    setError(null);
    listCobra()
      .then((r) => setRows(r.offers))
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load COBRA offers.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead className="hidden sm:table-cell">QE</TableHead>
                  <TableHead className="hidden md:table-cell">QE date</TableHead>
                  <TableHead className="hidden lg:table-cell">Election by</TableHead>
                  <TableHead className="hidden md:table-cell">Premium/mo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium text-white">
                      <div className="truncate"><AssociateLink associateId={c.associateId}>{c.associateName}</AssociateLink></div>
                      {/* Phone-only stack: QE description first, then the
                          two most-load-bearing numbers (premium + when
                          they have to decide by). The QE-date itself
                          drops off mobile — admins use this view to act,
                          not audit. */}
                      <div className="sm:hidden text-xs2 text-silver/70 truncate">
                        {c.qualifyingEvent}
                      </div>
                      <div className="md:hidden text-2xs text-silver/80 tabular-nums">
                        {c.premiumPerMonth ? `${fmtMoney(c.premiumPerMonth)}/mo` : '—'}
                        {' · elect by '}
                        {fmtYmd(c.electionDeadline)}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{c.qualifyingEvent}</TableCell>
                    <TableCell className="hidden md:table-cell tabular-nums">{fmtYmd(c.qeDate)}</TableCell>
                    <TableCell className="hidden lg:table-cell tabular-nums">{fmtYmd(c.electionDeadline)}</TableCell>
                    <TableCell className="hidden md:table-cell tabular-nums">{fmtMoney(c.premiumPerMonth)}</TableCell>
                    <TableCell>
                      <Badge variant={COBRA_BADGE[c.status]}>{COBRA_STATUS_LABELS[c.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && c.status === 'NOTIFIED' && (
                        <>
                          <Button size="sm" onClick={() => onElect(c)}>
                            Elect
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => onWaive(c)}>
                            Waive
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

function NewCobraDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
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
      toast.error('Pick an associate.');
      return;
    }
    if (!qeDate) {
      toast.error('QE date required.');
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
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        <div>
          <Label htmlFor="bl-qualifying-event">Qualifying event</Label>
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
          <Label>QE date</Label>
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

function formatAcaCell(m: AcaEmployeeMonths['months'][number]): string {
  if (!m) return '—';
  const offer = m.offerOfCoverage?.replace('CODE_', '') ?? '—';
  const safe = m.safeHarbor ?? '—';
  return `${offer}/${safe}`;
}

/** An employee is "missing codes" when any month has no row or no offer code. */
function hasMissingCodes(e: AcaEmployeeMonths): boolean {
  return e.months.some((m) => !m || !m.offerOfCoverage);
}

function AcaTab() {
  // Last 5 completed-ish tax years — 1095-C reporting is for the prior year.
  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 5 }, (_, i) => String(currentYear - 1 - i));
  const [year, setYear] = useState(yearOptions[0]);
  const [employees, setEmployees] = useState<AcaEmployeeMonths[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameFilter, setNameFilter] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);

  const refresh = async () => {
    setEmployees(null);
    setError(null);
    try {
      const r = await get1095c(Number(year));
      setEmployees(r.employees);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load the 1095-C grid.',
      );
    }
  };

  const filtered = (employees ?? []).filter(
    (e) =>
      e.associateName.toLowerCase().includes(nameFilter.trim().toLowerCase()) &&
      (!missingOnly || hasMissingCodes(e)),
  );

  const exportCsv = () => {
    downloadCsv(`1095c-${year}.csv`, [
      ['Associate', ...MONTHS_SHORT],
      ...filtered.map((e) => [
        e.associateName,
        ...e.months.map((m) => (m ? formatAcaCell(m) : '')),
      ]),
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <Label htmlFor="bl-aca-year">Tax year</Label>
          <Select
            id="bl-aca-year"
            className="mt-1 w-32"
            value={year}
            onChange={(e) => setYear(e.target.value)}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={refresh}>Load grid</Button>
        {employees !== null && employees.length > 0 && (
          <>
            <div className="flex-1 min-w-[10rem]">
              <Label htmlFor="bl-aca-filter">Associate</Label>
              <Input
                id="bl-aca-filter"
                className="mt-1"
                placeholder="Filter by name…"
                value={nameFilter}
                onChange={(e) => setNameFilter(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 pb-2.5 text-sm text-silver whitespace-nowrap">
              <input
                type="checkbox"
                checked={missingOnly}
                onChange={(e) => setMissingOnly(e.target.checked)}
              />
              Missing codes only
            </label>
            <Button variant="secondary" onClick={exportCsv}>
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </Button>
          </>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
          {error !== null ? (
            <LoadError message={error} onRetry={refresh} />
          ) : employees === null ? (
            <div className="p-6 text-sm text-silver">
              Choose a year and click Load grid.
            </div>
          ) : employees.length === 0 ? (
            <EmptyState
              icon={FileSpreadsheet}
              title={`No 1095-C data for ${year}`}
              description="Nothing has been imported for this tax year yet. Monthly coverage codes show up here after the year-end ACA import runs for your clients — pick a different year, or retry once the import has landed."
              action={
                <Button variant="secondary" onClick={refresh}>
                  Retry load
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={FileSpreadsheet}
              title="No associates match"
              description={
                missingOnly
                  ? 'Every associate matching your filter has a full set of codes.'
                  : 'No associate names match your filter.'
              }
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setNameFilter('');
                    setMissingOnly(false);
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              {/* Desktop: 13-column table — month-across, employee-per-row.
                  This is the IRS 1094/1095-C mental model so HR auditors
                  can scan a year horizontally before drilling into a row. */}
              <div className="hidden md:block overflow-x-auto">
                <table className="min-w-max text-xs">
                  <thead className="text-silver">
                    <tr>
                      <th className="text-left px-3 py-2">Associate</th>
                      {MONTHS_SHORT.map((mo) => (
                        <th key={mo} className="text-left px-2 py-2">
                          {mo}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-white">
                    {filtered.map((e) => (
                      <tr key={e.associateId} className="border-t border-navy-secondary">
                        <td className="px-3 py-2 font-medium"><AssociateLink associateId={e.associateId}>{e.associateName}</AssociateLink></td>
                        {e.months.map((m, i) => (
                          <td key={i} className="px-2 py-2 font-mono">
                            {formatAcaCell(m)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile: card per associate — same data, rotated into a
                  4×3 month grid so all twelve months stay on-screen
                  without horizontal scroll. */}
              <ul className="md:hidden divide-y divide-navy-secondary">
                {filtered.map((e) => (
                  <li key={e.associateId} className="p-4">
                    <div className="font-medium text-white text-sm mb-3 truncate">
                      {e.associateName}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {e.months.map((m, i) => (
                        <div
                          key={i}
                          className="rounded border border-navy-secondary bg-navy-secondary/30 px-2 py-1.5"
                        >
                          <div className="text-2xs uppercase tracking-wider text-silver">
                            {MONTHS_SHORT[i]}
                          </div>
                          <div className="font-mono text-xs text-white truncate">
                            {formatAcaCell(m)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
