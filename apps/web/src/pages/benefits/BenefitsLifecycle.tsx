import { useEffect, useState } from 'react';
import { CalendarDays, FileSpreadsheet, HeartPulse, Plus, ShieldOff } from 'lucide-react';
import { ApiError } from '@/lib/api';
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
import { useAuth } from '@/lib/auth';
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
  Input,
  PageHeader,
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
import { toast } from 'sonner';

type Tab = 'oe' | 'qle' | 'cobra' | 'aca';

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
  DRAFT: 'pending',
  OPEN: 'success',
  CLOSED: 'default',
};

function OeTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<OpenEnrollmentWindow[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listOpenEnrollment()
      .then((r) => setRows(r.windows))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

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
          {rows === null ? (
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
                      <div className="md:hidden text-[11px] text-silver/70 truncate">
                        {w.clientName}
                      </div>
                      <div className="sm:hidden text-[10px] text-silver/80 tabular-nums">
                        {w.startsOn} → {w.endsOn}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{w.clientName}</TableCell>
                    <TableCell className="hidden sm:table-cell tabular-nums">
                      {w.startsOn} → {w.endsOn}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell tabular-nums">{w.effectiveOn}</TableCell>
                    <TableCell>
                      <Badge variant={OE_BADGE[w.status]}>{w.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && w.status === 'DRAFT' && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            await openEnrollmentOpen(w.id);
                            refresh();
                          }}
                        >
                          Open
                        </Button>
                      )}
                      {canManage && w.status === 'OPEN' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            await openEnrollmentClose(w.id);
                            refresh();
                          }}
                        >
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
  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [effectiveOn, setEffectiveOn] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          <Label>Client ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
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
        <Button onClick={onSubmit} disabled={saving}>
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
  EXPIRED: 'default',
};

function QleTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Qle[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listQles()
      .then((r) => setRows(r.qles))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onDecide = async (id: string, decision: 'APPROVED' | 'DENIED') => {
    try {
      await decideQle(id, decision);
      toast.success(`QLE ${decision.toLowerCase()}.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          {rows === null ? (
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
                  <TableHead>Kind</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Window ends</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="font-medium text-white">
                      {q.associateName}
                    </TableCell>
                    <TableCell>{QLE_KIND_LABEL[q.kind]}</TableCell>
                    <TableCell>{q.eventDate}</TableCell>
                    <TableCell>{q.allowedUntil}</TableCell>
                    <TableCell>
                      <Badge variant={QLE_BADGE[q.status]}>{q.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && q.status === 'PENDING' && (
                        <>
                          <Button size="sm" onClick={() => onDecide(q.id, 'APPROVED')}>
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onDecide(q.id, 'DENIED')}
                          >
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
  const [associateId, setAssociateId] = useState('');
  const [kind, setKind] = useState<QleKind>('MARRIAGE');
  const [eventDate, setEventDate] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!associateId || !eventDate) {
      toast.error('Associate and event date required.');
      return;
    }
    setSaving(true);
    try {
      await createQle({
        associateId: associateId.trim(),
        kind,
        eventDate,
        evidenceUrl: evidenceUrl.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success('QLE submitted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
          />
        </div>
        <div>
          <Label>Event kind</Label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={kind}
            onChange={(e) => setKind(e.target.value as QleKind)}
          >
            {(Object.keys(QLE_KIND_LABEL) as QleKind[]).map((k) => (
              <option key={k} value={k}>
                {QLE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Event date</Label>
          <Input
            type="date"
            className="mt-1"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
          />
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

function CobraTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<CobraOffer[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listCobra()
      .then((r) => setRows(r.offers))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

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
          {rows === null ? (
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
                  <TableHead>QE</TableHead>
                  <TableHead>QE date</TableHead>
                  <TableHead>Election by</TableHead>
                  <TableHead>Premium/mo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium text-white">
                      {c.associateName}
                    </TableCell>
                    <TableCell>{c.qualifyingEvent}</TableCell>
                    <TableCell>{c.qeDate}</TableCell>
                    <TableCell>{c.electionDeadline}</TableCell>
                    <TableCell>{c.premiumPerMonth ? `$${c.premiumPerMonth}` : '—'}</TableCell>
                    <TableCell>
                      <Badge variant={COBRA_BADGE[c.status]}>{c.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && c.status === 'NOTIFIED' && (
                        <>
                          <Button
                            size="sm"
                            onClick={async () => {
                              await electCobra(c.id);
                              refresh();
                            }}
                          >
                            Elect
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              await waiveCobra(c.id);
                              refresh();
                            }}
                          >
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
  const [associateId, setAssociateId] = useState('');
  const [qualifyingEvent, setQualifyingEvent] = useState('TERMINATION');
  const [qeDate, setQeDate] = useState('');
  const [premium, setPremium] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!associateId || !qeDate) {
      toast.error('Associate and QE date required.');
      return;
    }
    setSaving(true);
    try {
      await createCobra({
        associateId: associateId.trim(),
        qualifyingEvent: qualifyingEvent.trim(),
        qeDate,
        premiumPerMonth: premium ? Number(premium) : null,
      });
      toast.success('COBRA notified.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
          />
        </div>
        <div>
          <Label>Qualifying event</Label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={qualifyingEvent}
            onChange={(e) => setQualifyingEvent(e.target.value)}
          >
            <option value="TERMINATION">Termination</option>
            <option value="REDUCTION_OF_HOURS">Reduction of hours</option>
            <option value="DEATH">Death</option>
            <option value="DIVORCE">Divorce</option>
            <option value="MEDICARE">Medicare entitlement</option>
          </select>
        </div>
        <div>
          <Label>QE date</Label>
          <Input
            type="date"
            className="mt-1"
            value={qeDate}
            onChange={(e) => setQeDate(e.target.value)}
          />
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

function AcaTab() {
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [employees, setEmployees] = useState<AcaEmployeeMonths[] | null>(null);

  const refresh = async () => {
    setEmployees(null);
    try {
      const r = await get1095c(Number(year));
      setEmployees(r.employees);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
      setEmployees([]);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div>
          <Label>Tax year</Label>
          <Input
            type="number"
            className="mt-1 w-32"
            value={year}
            onChange={(e) => setYear(e.target.value)}
          />
        </div>
        <Button onClick={refresh}>Load grid</Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {employees === null ? (
            <div className="p-6 text-sm text-silver">
              Choose a year and click Load grid.
            </div>
          ) : employees.length === 0 ? (
            <EmptyState
              icon={FileSpreadsheet}
              title="No ACA data"
              description="Upsert AcaMonth rows via /aca/months or wait for the year-end importer."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-max text-xs">
                <thead className="text-silver">
                  <tr>
                    <th className="text-left px-3 py-2">Associate</th>
                    {Array.from({ length: 12 }, (_, i) => (
                      <th key={i} className="text-left px-2 py-2">
                        {new Date(0, i).toLocaleString('en-US', { month: 'short' })}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="text-white">
                  {employees.map((e) => (
                    <tr key={e.associateId} className="border-t border-navy-secondary">
                      <td className="px-3 py-2 font-medium">{e.associateName}</td>
                      {e.months.map((m, i) => (
                        <td key={i} className="px-2 py-2 font-mono">
                          {m
                            ? `${m.offerOfCoverage?.replace('CODE_', '') ?? '—'}/${m.safeHarbor ?? '—'}`
                            : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
