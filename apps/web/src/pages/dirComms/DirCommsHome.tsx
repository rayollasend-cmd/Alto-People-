import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Check,
  Copy,
  Download,
  ListPlus,
  Mail,
  Pencil,
  Plus,
  Search,
  Users,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  addSurveyQuestion,
  closeSurvey,
  createBroadcast,
  createSurvey,
  getSurveyAggregate,
  listBroadcasts,
  listSurveyQuestions,
  listSurveys,
  openSurvey,
  searchDirectory,
  sendBroadcast,
  updateBroadcast,
  type Broadcast,
  type Person,
  type Survey,
  type SurveyAggregate,
  type SurveyQuestion,
  type SurveyQuestionKind,
} from '@/lib/dirCommsApi';
import { listClients } from '@/lib/clientsApi';
import { listCostCenters, listDepartments } from '@/lib/orgApi';
import type { CostCenter, Department } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import { downloadCsv } from '@/lib/csv';
import {
  fmtDateTime,
  utcToZonedDatetimeInput,
  ymdLocal,
} from '@/lib/format';
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
import { toast } from 'sonner';

type Tab = 'directory' | 'broadcasts' | 'surveys';

const QUESTION_KIND_LABELS: Record<SurveyQuestionKind, string> = {
  SHORT_TEXT: 'Short text',
  LONG_TEXT: 'Long text',
  SINGLE_CHOICE: 'Single choice',
  MULTI_CHOICE: 'Multiple choice',
  SCALE_1_5: 'Scale 1–5',
  NPS_0_10: 'NPS 0–10',
};

/** Small copy-to-clipboard affordance next to contact links. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex items-center text-silver/60 hover:text-white transition align-middle"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => toast.error('Could not copy.'));
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function RetryBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <ErrorBanner>
      <div className="flex items-center justify-between gap-3">
        <span>{message}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </ErrorBanner>
  );
}

export function DirCommsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:communications') : false;
  const [tab, setTab] = useState<Tab>('directory');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Directory & comms"
        subtitle="Search the people directory, send broadcasts, and run pulse / eNPS surveys."
        breadcrumbs={[{ label: 'Insights' }, { label: 'Directory & comms' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="directory">Directory</TabsTrigger>
          {canManage && <TabsTrigger value="broadcasts">Broadcasts</TabsTrigger>}
          {canManage && <TabsTrigger value="surveys">Surveys</TabsTrigger>}
        </TabsList>
        <TabsContent value="directory"><DirectoryTab /></TabsContent>
        {canManage && (
          <TabsContent value="broadcasts"><BroadcastsTab canManage={canManage} /></TabsContent>
        )}
        {canManage && (
          <TabsContent value="surveys"><SurveysTab canManage={canManage} /></TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function DirectoryTab() {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (term: string) => {
    setPeople(null);
    setError(null);
    try {
      const r = await searchDirectory(term || undefined);
      setPeople(r.people);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load the directory.',
      );
    }
  };

  useEffect(() => {
    refresh('');
  }, []);

  const exportCsv = () => {
    if (!people || people.length === 0) return;
    downloadCsv(`directory-${ymdLocal()}.csv`, [
      ['Name', 'Email', 'Phone', 'Department', 'Title'],
      ...people.map((p) => [
        p.name,
        p.email,
        p.phone ?? '',
        p.department ?? '',
        p.jobTitle ?? '',
      ]),
    ]);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          <Search className="h-4 w-4 text-silver" />
          <Input
            placeholder="Name or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && refresh(q)}
          />
          <Button onClick={() => refresh(q)}>Search</Button>
        </CardContent>
      </Card>
      {error && <RetryBanner message={error} onRetry={() => refresh(q)} />}
      {people !== null && !error && (
        <div className="flex items-center justify-between text-xs text-silver">
          <span>
            {people.length} {people.length === 1 ? 'person' : 'people'}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={exportCsv}
            disabled={people.length === 0}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {error ? null : people === null ? (
            <div className="p-6"><SkeletonRows count={5} /></div>
          ) : people.length === 0 ? (
            <EmptyState icon={Users} title="No matches" description="Try a different name or email." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Email</TableHead>
                  <TableHead className="hidden md:table-cell">Phone</TableHead>
                  <TableHead className="hidden lg:table-cell">Department</TableHead>
                  <TableHead>Title</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{p.name}</div>
                      <div className="md:hidden text-[11px] text-silver/70 truncate">
                        <span className="sm:hidden">
                          <a href={`mailto:${p.email}`} className="hover:underline">
                            {p.email}
                          </a>
                          {' · '}
                        </span>
                        {p.phone ? (
                          <a href={`tel:${p.phone}`} className="hover:underline">
                            {p.phone}
                          </a>
                        ) : (
                          '—'
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="inline-flex items-center gap-1.5">
                        <a
                          href={`mailto:${p.email}`}
                          className="text-steel hover:text-white hover:underline"
                        >
                          {p.email}
                        </a>
                        <CopyButton text={p.email} label={`Copy ${p.email}`} />
                      </span>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {p.phone ? (
                        <span className="inline-flex items-center gap-1.5">
                          <a
                            href={`tel:${p.phone}`}
                            className="text-steel hover:text-white hover:underline"
                          >
                            {p.phone}
                          </a>
                          <CopyButton text={p.phone} label={`Copy ${p.phone}`} />
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{p.department ?? '—'}</TableCell>
                    <TableCell>{p.jobTitle ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BroadcastsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<Broadcast[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Broadcast | null>(null);

  const refresh = () => {
    setRows(null);
    setError(null);
    listBroadcasts()
      .then((r) => setRows(r.broadcasts))
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load broadcasts.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const onSend = async (id: string) => {
    if (!(await confirm({ title: 'Send this broadcast now?' }))) return;
    try {
      const r = await sendBroadcast(id);
      toast.success(`Sent to ${r.recipientCount} associates.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New broadcast
          </Button>
        </div>
      )}
      {error && <RetryBanner message={error} onRetry={refresh} />}
      <Card>
        <CardContent className="p-0">
          {error ? null : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="No broadcasts"
              description="Send announcements to everyone, a department, or a single client."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Channels</TableHead>
                  <TableHead className="hidden md:table-cell">Recipients</TableHead>
                  <TableHead className="hidden sm:table-cell">Sent</TableHead>
                  <TableHead className="w-40 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{b.title}</div>
                      <div className="md:hidden text-[11px] text-silver/70 truncate">
                        <span className="sm:hidden">
                          {b.sentAt ? fmtDateTime(b.sentAt) : 'Not sent'}
                          {' · '}
                        </span>
                        <span className="tabular-nums">{b.receiptCount}</span> recipients
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          b.status === 'SENT'
                            ? 'success'
                            : b.status === 'CANCELLED'
                              ? 'destructive'
                              : 'pending'
                        }
                      >
                        {b.status}
                      </Badge>
                      {b.status === 'SCHEDULED' && b.scheduledFor && (
                        <div className="text-[10px] text-silver/70 mt-0.5">
                          {fmtDateTime(b.scheduledFor)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{b.channels.join(', ')}</TableCell>
                    <TableCell className="hidden md:table-cell">{b.receiptCount}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {b.sentAt ? fmtDateTime(b.sentAt) : '—'}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && b.status === 'DRAFT' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(b)}
                        >
                          <Pencil className="mr-1 h-3 w-3" /> Edit
                        </Button>
                      )}
                      {canManage && b.status !== 'SENT' && b.status !== 'CANCELLED' && (
                        <Button size="sm" onClick={() => onSend(b.id)}>
                          Send
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
      {(showNew || editing) && (
        <BroadcastDrawer
          broadcast={editing}
          onClose={() => {
            setShowNew(false);
            setEditing(null);
          }}
          onSaved={() => {
            setShowNew(false);
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function BroadcastDrawer({
  broadcast,
  onClose,
  onSaved,
}: {
  /** Null = create; a DRAFT broadcast = edit in place. */
  broadcast: Broadcast | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = broadcast !== null;
  const [title, setTitle] = useState(broadcast?.title ?? '');
  const [body, setBody] = useState(broadcast?.body ?? '');
  const [clientId, setClientId] = useState(broadcast?.clientId ?? '');
  const [departmentId, setDepartmentId] = useState(broadcast?.departmentId ?? '');
  const [costCenterId, setCostCenterId] = useState(broadcast?.costCenterId ?? '');
  const [scheduledFor, setScheduledFor] = useState(
    broadcast?.scheduledFor
      ? utcToZonedDatetimeInput(broadcast.scheduledFor)
      : '',
  );
  const [saving, setSaving] = useState(false);

  const [clients, setClients] = useState<{ id: string; name: string }[] | null>(null);
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [costCenters, setCostCenters] = useState<CostCenter[] | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);

  const loadTargets = () => {
    setTargetsError(null);
    setClients(null);
    setDepartments(null);
    setCostCenters(null);
    Promise.all([listClients(), listDepartments(), listCostCenters()])
      .then(([c, d, cc]) => {
        setClients(c.clients.map((x) => ({ id: x.id, name: x.name })));
        setDepartments(d.departments);
        setCostCenters(cc.costCenters);
      })
      .catch((err) =>
        setTargetsError(
          err instanceof ApiError
            ? err.message
            : 'Could not load targeting options.',
        ),
      );
  };
  useEffect(() => {
    loadTargets();
  }, []);

  // Departments / cost centers belong to a client — narrow the pickers when
  // a client is chosen so cross-client combos can't be assembled.
  const visibleDepartments = useMemo(
    () =>
      (departments ?? []).filter((d) => !clientId || d.clientId === clientId),
    [departments, clientId],
  );
  const visibleCostCenters = useMemo(
    () =>
      (costCenters ?? []).filter((c) => !clientId || c.clientId === clientId),
    [costCenters, clientId],
  );

  const onSubmit = async () => {
    if (!title.trim() || !body.trim()) {
      toast.error('Title and body required.');
      return;
    }
    const payload = {
      title: title.trim(),
      body: body.trim(),
      clientId: clientId || null,
      departmentId: departmentId || null,
      costCenterId: costCenterId || null,
      scheduledFor: scheduledFor
        ? new Date(scheduledFor).toISOString()
        : null,
    };
    setSaving(true);
    try {
      if (isEdit && broadcast) {
        await updateBroadcast(broadcast.id, payload);
        toast.success('Broadcast updated.');
      } else {
        await createBroadcast(payload);
        toast.success(
          scheduledFor
            ? `Broadcast scheduled for ${fmtDateTime(payload.scheduledFor)}.`
            : 'Broadcast created (DRAFT).',
        );
      }
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
        <DrawerTitle>{isEdit ? 'Edit broadcast' : 'New broadcast'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Title</Label>
          <Input className="mt-1" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label>Body</Label>
          <Textarea
            className="mt-1 min-h-32"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        {targetsError ? (
          <RetryBanner message={targetsError} onRetry={loadTargets} />
        ) : (
          <>
            <div>
              <Label>Client</Label>
              <Select
                className="mt-1"
                value={clientId}
                disabled={clients === null}
                onChange={(e) => {
                  setClientId(e.target.value);
                  // Narrowing the client invalidates any cross-client picks.
                  setDepartmentId('');
                  setCostCenterId('');
                }}
              >
                <option value="">
                  {clients === null ? 'Loading…' : 'All clients'}
                </option>
                {(clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Department</Label>
                <Select
                  className="mt-1"
                  value={departmentId}
                  disabled={departments === null}
                  onChange={(e) => setDepartmentId(e.target.value)}
                >
                  <option value="">
                    {departments === null ? 'Loading…' : 'All departments'}
                  </option>
                  {visibleDepartments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Cost center</Label>
                <Select
                  className="mt-1"
                  value={costCenterId}
                  disabled={costCenters === null}
                  onChange={(e) => setCostCenterId(e.target.value)}
                >
                  <option value="">
                    {costCenters === null ? 'Loading…' : 'All cost centers'}
                  </option>
                  {visibleCostCenters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </>
        )}
        <div>
          <Label>Schedule (optional)</Label>
          <Input
            type="datetime-local"
            className="mt-1"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
          />
          <div className="text-xs text-silver mt-1">
            {scheduledFor
              ? `Will be scheduled for ${fmtDateTime(new Date(scheduledFor))}.`
              : 'Leave empty to save as a draft you send manually.'}
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function SurveysTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<Survey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [questionsFor, setQuestionsFor] = useState<Survey | null>(null);
  const [resultsFor, setResultsFor] = useState<Survey | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => {
    setRows(null);
    setError(null);
    listSurveys()
      .then((r) => setRows(r.surveys))
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load surveys.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const onOpen = async (s: Survey) => {
    if (s.questionCount === 0) {
      toast.error('Add at least one question before opening.');
      return;
    }
    setBusyId(s.id);
    try {
      await openSurvey(s.id);
      toast.success('Survey is now open for responses.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusyId(null);
    }
  };

  const onCloseSurvey = async (s: Survey) => {
    const ok = await confirm({
      title: 'Close this survey?',
      description:
        'It stops accepting responses immediately. Responses collected so far are kept.',
      confirmLabel: 'Close survey',
    });
    if (!ok) return;
    setBusyId(s.id);
    try {
      await closeSurvey(s.id);
      toast.success('Survey closed.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New survey
          </Button>
        </div>
      )}
      {error && <RetryBanner message={error} onRetry={refresh} />}
      <Card>
        <CardContent className="p-0">
          {error ? null : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No surveys"
              description="Run pulse, eNPS, or open-ended polls. Anonymous mode hides respondent IDs."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Anonymous</TableHead>
                  <TableHead className="hidden sm:table-cell">Questions</TableHead>
                  <TableHead>Responses</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{s.title}</div>
                      <div className="md:hidden text-[11px] text-silver/70 truncate">
                        <span className="sm:hidden tabular-nums">
                          {s.questionCount} questions
                          {' · '}
                        </span>
                        {s.isAnonymous ? 'Anonymous' : 'Named'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          s.status === 'CLOSED'
                            ? 'default'
                            : s.status === 'OPEN'
                              ? 'success'
                              : 'pending'
                        }
                      >
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{s.isAnonymous ? 'Yes' : 'No'}</TableCell>
                    <TableCell className="hidden sm:table-cell">{s.questionCount}</TableCell>
                    <TableCell>{s.responseCount}</TableCell>
                    <TableCell className="text-right space-x-1 whitespace-nowrap">
                      {canManage && s.status === 'DRAFT' && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setQuestionsFor(s)}
                          >
                            <ListPlus className="mr-1 h-3 w-3" /> Questions
                          </Button>
                          <Button
                            size="sm"
                            disabled={busyId === s.id}
                            onClick={() => void onOpen(s)}
                          >
                            Open
                          </Button>
                        </>
                      )}
                      {canManage && s.status === 'OPEN' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId === s.id}
                          onClick={() => void onCloseSurvey(s)}
                        >
                          Close
                        </Button>
                      )}
                      {s.status !== 'DRAFT' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setResultsFor(s)}
                        >
                          <BarChart3 className="mr-1 h-3 w-3" /> Results
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
        <NewSurveyDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {questionsFor && (
        <QuestionsDrawer
          survey={questionsFor}
          onClose={() => setQuestionsFor(null)}
          onChanged={refresh}
        />
      )}
      {resultsFor && (
        <SurveyResultsDrawer
          survey={resultsFor}
          onClose={() => setResultsFor(null)}
        />
      )}
    </div>
  );
}

function NewSurveyDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!title.trim()) {
      toast.error('Title required.');
      return;
    }
    setSaving(true);
    try {
      await createSurvey({
        title: title.trim(),
        description: description.trim() || null,
        isAnonymous,
      });
      toast.success('Survey created (DRAFT). Add questions and OPEN it.');
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
        <DrawerTitle>New survey</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Title</Label>
          <Input className="mt-1" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label>Description (optional)</Label>
          <Textarea
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={isAnonymous}
            onChange={(e) => setIsAnonymous(e.target.checked)}
          />
          Anonymous responses
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save draft'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

const CHOICE_KINDS: SurveyQuestionKind[] = ['SINGLE_CHOICE', 'MULTI_CHOICE'];

function QuestionsDrawer({
  survey,
  onClose,
  onChanged,
}: {
  survey: Survey;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [questions, setQuestions] = useState<SurveyQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<SurveyQuestionKind>('SCALE_1_5');
  const [prompt, setPrompt] = useState('');
  const [choicesText, setChoicesText] = useState('');
  const [isRequired, setIsRequired] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = () => {
    setQuestions(null);
    setError(null);
    listSurveyQuestions(survey.id)
      .then((r) => setQuestions(r.questions))
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load questions.',
        ),
      );
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [survey.id]);

  const addQuestion = async () => {
    if (!prompt.trim()) {
      toast.error('Prompt required.');
      return;
    }
    const choices = choicesText
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (CHOICE_KINDS.includes(kind) && choices.length < 2) {
      toast.error('Choice questions need at least two comma-separated choices.');
      return;
    }
    setAdding(true);
    try {
      await addSurveyQuestion(survey.id, {
        kind,
        prompt: prompt.trim(),
        choices: CHOICE_KINDS.includes(kind) ? choices : undefined,
        isRequired,
        sortOrder: questions?.length ?? 0,
      });
      toast.success('Question added.');
      setPrompt('');
      setChoicesText('');
      load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setAdding(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Questions — {survey.title}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {error ? (
          <RetryBanner message={error} onRetry={load} />
        ) : questions === null ? (
          <SkeletonRows count={3} />
        ) : questions.length === 0 ? (
          <div className="text-sm text-silver italic">
            No questions yet. Add the first one below.
          </div>
        ) : (
          <div className="space-y-2">
            {questions.map((qq, i) => (
              <div
                key={qq.id}
                className="rounded border border-navy-secondary p-3 text-sm"
              >
                <div className="text-white">
                  {i + 1}. {qq.prompt}
                </div>
                <div className="text-xs text-silver mt-1 flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px]">
                    {QUESTION_KIND_LABELS[qq.kind]}
                  </Badge>
                  {qq.isRequired && <span>Required</span>}
                  {Array.isArray(qq.choices) && qq.choices.length > 0 && (
                    <span>{qq.choices.join(' / ')}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3 pt-3 border-t border-navy-secondary">
          <div className="text-sm font-medium text-white">Add question</div>
          <div>
            <Label>Type</Label>
            <Select
              className="mt-1"
              value={kind}
              onChange={(e) => setKind(e.target.value as SurveyQuestionKind)}
            >
              {(Object.keys(QUESTION_KIND_LABELS) as SurveyQuestionKind[]).map(
                (k) => (
                  <option key={k} value={k}>
                    {QUESTION_KIND_LABELS[k]}
                  </option>
                ),
              )}
            </Select>
          </div>
          <div>
            <Label>Prompt</Label>
            <Input
              className="mt-1"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="How likely are you to recommend working here?"
            />
          </div>
          {CHOICE_KINDS.includes(kind) && (
            <div>
              <Label>Choices (comma-separated)</Label>
              <Input
                className="mt-1"
                value={choicesText}
                onChange={(e) => setChoicesText(e.target.value)}
                placeholder="Morning, Afternoon, Night"
              />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-white">
            <input
              type="checkbox"
              checked={isRequired}
              onChange={(e) => setIsRequired(e.target.checked)}
            />
            Required
          </label>
          <Button size="sm" onClick={() => void addQuestion()} disabled={adding}>
            {adding ? 'Adding…' : 'Add question'}
          </Button>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Done</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function SurveyResultsDrawer({
  survey,
  onClose,
}: {
  survey: Survey;
  onClose: () => void;
}) {
  const [data, setData] = useState<SurveyAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setData(null);
    setError(null);
    getSurveyAggregate(survey.id)
      .then(setData)
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load results.',
        ),
      );
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [survey.id]);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Results — {survey.title}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {error ? (
          <RetryBanner message={error} onRetry={load} />
        ) : !data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="text-sm text-silver">
              {data.responseCount}{' '}
              {data.responseCount === 1 ? 'response' : 'responses'}
              {data.survey.isAnonymous ? ' · anonymous' : ''}
            </div>
            {data.byQuestion.map((qq) => {
              const choiceLabels = Array.isArray(qq.choices)
                ? (qq.choices as string[])
                : null;
              return (
                <div
                  key={qq.questionId}
                  className="rounded border border-navy-secondary p-3 space-y-2"
                >
                  <div className="text-sm text-white">{qq.prompt}</div>
                  <div className="text-xs text-silver">
                    {QUESTION_KIND_LABELS[qq.kind]} · {qq.count}{' '}
                    {qq.count === 1 ? 'answer' : 'answers'}
                    {qq.avg !== undefined && qq.avg !== null && (
                      <>
                        {' · avg '}
                        <span className="text-white">
                          {Math.round(qq.avg * 100) / 100}
                        </span>
                      </>
                    )}
                  </div>
                  {qq.tally && (
                    <div className="space-y-1">
                      {Object.entries(qq.tally).map(([idx, count]) => {
                        const max = Math.max(
                          1,
                          ...Object.values(qq.tally ?? {}),
                        );
                        const label =
                          choiceLabels?.[Number(idx)] ?? `Option ${idx}`;
                        return (
                          <div key={idx} className="flex items-center gap-2">
                            <div className="w-32 truncate text-xs text-silver">
                              {label}
                            </div>
                            <div className="flex-1 h-2.5 rounded bg-navy-secondary/40 overflow-hidden">
                              <div
                                className="h-full bg-gold"
                                style={{ width: `${(count / max) * 100}%` }}
                              />
                            </div>
                            <div className="w-8 text-right text-xs">{count}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {qq.samples && qq.samples.length > 0 && (
                    <div className="space-y-1.5">
                      {qq.samples.filter(Boolean).map((s, i) => (
                        <div
                          key={i}
                          className="text-sm text-white bg-navy-secondary/40 rounded p-2"
                        >
                          "{s}"
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
