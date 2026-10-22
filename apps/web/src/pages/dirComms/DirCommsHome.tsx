import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Check,
  Copy,
  CopyPlus,
  Download,
  ListPlus,
  Mail,
  Pencil,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';
import { BroadcastDrawer, channelPhrase, useSendBroadcast } from './BroadcastDrawer';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  addSurveyQuestion,
  closeSurvey,
  createSurvey,
  getSurveyAggregate,
  deleteBroadcast,
  deliveryLines,
  duplicateBroadcast,
  listBroadcasts,
  listBroadcastTemplates,
  listSurveyQuestions,
  listSurveys,
  openSurvey,
  searchDirectory,
  type Broadcast,
  type Person,
  type Survey,
  type SurveyAggregate,
  type SurveyQuestion,
  type SurveyQuestionKind,
} from '@/lib/dirCommsApi';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import { StatusBadge } from '@/lib/status';
import { downloadCsv } from '@/lib/csv';
import {
  fmtDateTime,
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
  SearchInput,
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
import { ListTemplate } from '@/components/templates';
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
    <ErrorBanner
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {message}
    </ErrorBanner>
  );
}

export function DirCommsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:communications') : false;
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab = canManage && (requested === 'broadcasts' || requested === 'surveys') ? requested : 'directory';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'directory') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Directory & comms"
        subtitle="Search the people directory, send broadcasts, and run pulse / eNPS surveys."
        breadcrumbs={[{ label: 'Communications' }, { label: 'Directory & comms' }]}
    >
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
    </ListTemplate>
  );
}

// Render cap for the directory table — the endpoint has no limit param,
// and painting a whole 1000-person org into one table froze the tab on
// first open. The CSV export still covers the full result.
const DIRECTORY_RENDER_CAP = 200;

function DirectoryTab() {
  const [q, setQ] = useState('');
  // The term the list answers — set by Search / Enter, not by typing.
  const [term, setTerm] = useState('');
  const directoryQuery = useQuery({
    queryKey: ['dirComms', 'directory', term],
    queryFn: () => searchDirectory(term || undefined),
  });
  const people: Person[] | null = directoryQuery.data?.people ?? null;
  const error = directoryQuery.error
    ? directoryQuery.error instanceof ApiError
      ? directoryQuery.error.message
      : 'Could not load the directory.'
    : null;
  const refresh = (next: string) => {
    if (next === term) void directoryQuery.refetch();
    else setTerm(next);
  };

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
        <CardContent className="flex items-center gap-3">
          <div className="flex-1">
            <SearchInput
              aria-label="Search the directory"
              placeholder="Name or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && refresh(q)}
            />
          </div>
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
            <DataGrid<NonNullable<typeof people>[number]>
              id="dir-comms-directory"
              caption="People directory"
              rows={people.slice(0, DIRECTORY_RENDER_CAP)}
              rowKey={(pe) => pe.id}
              search={false}
              urlState={false}
              exportCsv={false}
              columns={[
                { key: 'name', header: 'Name', accessor: (pe) => pe.name, sortable: true, primary: true, className: 'font-medium text-white' },
                {
                  key: 'email',
                  header: 'Email',
                  accessor: (pe) => pe.email,
                  sortable: true,
                  cardMeta: true,
                  stopRowClick: true,
                  cell: (pe) => (
                    <span className="inline-flex items-center gap-1.5">
                      <a href={`mailto:${pe.email}`} className="text-gold hover:text-gold-bright hover:underline">
                        {pe.email}
                      </a>
                      <CopyButton text={pe.email} label={`Copy ${pe.email}`} />
                    </span>
                  ),
                },
                {
                  key: 'phone',
                  header: 'Phone',
                  accessor: (pe) => pe.phone,
                  sortable: true,
                  cardMeta: true,
                  stopRowClick: true,
                  cell: (pe) =>
                    pe.phone ? (
                      <span className="inline-flex items-center gap-1.5">
                        <a href={`tel:${pe.phone}`} className="text-gold hover:text-gold-bright hover:underline">
                          {pe.phone}
                        </a>
                        <CopyButton text={pe.phone} label={`Copy ${pe.phone}`} />
                      </span>
                    ) : (
                      '—'
                    ),
                },
                { key: 'department', header: 'Department', accessor: (pe) => pe.department, sortable: true, cell: (pe) => pe.department ?? '—' },
                { key: 'title', header: 'Title', accessor: (pe) => pe.jobTitle, sortable: true, cell: (pe) => pe.jobTitle ?? '—' },
              ]}
            />
          )}
          {people !== null && people.length > DIRECTORY_RENDER_CAP && (
            <div className="border-t border-navy-secondary px-4 py-2.5 text-xs text-silver">
              Showing the first {DIRECTORY_RENDER_CAP} of {people.length} —
              search to narrow the list. The CSV export includes everyone.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BroadcastsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const send = useSendBroadcast();
  const [params, setParams] = useSearchParams();
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Broadcast | null>(null);

  const broadcastsQuery = useQuery({ queryKey: ['dirComms', 'broadcasts'], queryFn: () => listBroadcasts() });
  const templatesQuery = useQuery({ queryKey: ['dirComms', 'broadcast-templates'], queryFn: () => listBroadcastTemplates() });
  const rows: Broadcast[] | null = broadcastsQuery.data?.broadcasts ?? null;
  const error = broadcastsQuery.error
    ? broadcastsQuery.error instanceof ApiError
      ? broadcastsQuery.error.message
      : 'Could not load broadcasts.'
    : null;
  const refresh = () => {
    void broadcastsQuery.refetch();
    void templatesQuery.refetch();
  };

  // ?broadcast=<id> (the "announcement to review" notification) opens that draft.
  const linked = params.get('broadcast');
  useEffect(() => {
    if (!linked || !rows) return;
    const b = rows.find((x) => x.id === linked);
    if (b && b.status !== 'SENT') setEditing(b);
    const next = new URLSearchParams(params);
    next.delete('broadcast');
    setParams(next, { replace: true });
  }, [linked, rows, params, setParams]);

  const onDuplicate = async (b: Broadcast) => {
    try {
      await duplicateBroadcast(b.id);
      toast.success(`“${b.title}” copied to a new draft.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not duplicate it.');
    }
  };
  const onDelete = async (b: Broadcast, what: 'draft' | 'template') => {
    if (!(await confirm({ title: `Delete the ${what} “${b.templateName ?? b.title}”?`, destructive: true, confirmLabel: 'Delete' }))) return;
    try {
      await deleteBroadcast(b.id);
      toast.success(what === 'template' ? 'Template deleted.' : 'Draft deleted.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete it.');
    }
  };
  const templates = templatesQuery.data?.broadcasts ?? [];

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
            <DataGrid<NonNullable<typeof rows>[number]>
              id="broadcasts"
              caption="Broadcasts"
              rows={rows}
              rowKey={(b) => b.id}
              search={{ placeholder: 'Title…' }}
              urlState={false}
              exportCsv={{ filename: 'broadcasts' }}
              columns={[
                {
                  key: 'title',
                  header: 'Title',
                  accessor: (b) => b.title,
                  sortable: true,
                  primary: true,
                  cell: (b) => (
                    <span className="min-w-0">
                      <span className="font-medium text-ink">{b.title}</span>
                      {b.status !== 'SENT' && b.createdByRole === 'MARKETING_MANAGER' && (
                        <span className="block text-2xs text-ink-muted">Drafted by Marketing — review and send</span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (b) => b.status,
                  sortable: true,
                  cardMeta: true,
                  cell: (b) => (
                    <>
                      <StatusBadge status={b.status} />
                      {b.status === 'SCHEDULED' && b.scheduledFor && <div className="text-2xs text-ink-muted mt-0.5">{fmtDateTime(b.scheduledFor)}</div>}
                    </>
                  ),
                },
                {
                  key: 'channels',
                  header: 'Channels',
                  accessor: (b) => channelPhrase(b.channels),
                  sortable: true,
                  cell: (b) => (
                    <span className="block min-w-0">
                      <span>{channelPhrase(b.channels)}</span>
                      {b.status === 'SENT' &&
                        deliveryLines(b.delivery).map((l) => (
                          <span key={l.channel} className={cn('block text-2xs', l.problem ? 'text-warning' : 'text-ink-muted')}>
                            {l.text}
                          </span>
                        ))}
                    </span>
                  ),
                },
                { key: 'recipients', header: 'Recipients', accessor: (b) => b.receiptCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                { key: 'sent', header: 'Sent', accessor: (b) => b.sentAt, sortable: true, searchable: false, cardMeta: true, cell: (b) => (b.sentAt ? fmtDateTime(b.sentAt) : '—') },
                {
                  key: 'actions',
                  header: 'Action',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'space-x-1 whitespace-nowrap',
                  cell: (b) => (
                    <>
                      {canManage && b.status === 'DRAFT' && (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(b)}>
                          <Pencil className="mr-1 h-3 w-3" /> Edit
                        </Button>
                      )}
                      {canManage && (
                        <Button size="sm" variant="ghost" onClick={() => void onDuplicate(b)} aria-label={`Duplicate ${b.title}`}>
                          <CopyPlus className="mr-1 h-3 w-3" /> Duplicate
                        </Button>
                      )}
                      {canManage && b.status === 'DRAFT' && (
                        <Button size="sm" variant="ghost" onClick={() => void onDelete(b, 'draft')} aria-label={`Delete ${b.title}`}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                      {canManage && b.status !== 'SENT' && b.status !== 'CANCELLED' && (
                        <Button size="sm" onClick={() => void send(b).then((ok) => ok && refresh())}>
                          Send…
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
      {canManage && templates.length > 0 && (
        <Card>
          <CardContent className="space-y-2">
            <h3 className="text-sm font-medium text-ink">Templates</h3>
            <ul className="divide-y divide-line">
              {templates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{t.templateName}</span>
                    <span className="block truncate text-xs text-ink-muted">{t.title}</span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void onDuplicate(t)}>
                    Use
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void onDelete(t, 'template')} aria-label={`Delete template ${t.templateName}`}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
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

function SurveysTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [questionsFor, setQuestionsFor] = useState<Survey | null>(null);
  const [resultsFor, setResultsFor] = useState<Survey | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const surveysQuery = useQuery({ queryKey: ['dirComms', 'surveys'], queryFn: () => listSurveys() });
  const rows: Survey[] | null = surveysQuery.data?.surveys ?? null;
  const error = surveysQuery.error
    ? surveysQuery.error instanceof ApiError
      ? surveysQuery.error.message
      : 'Could not load surveys.'
    : null;
  const refresh = () => void surveysQuery.refetch();

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
      toast.error(err instanceof ApiError ? err.message : 'Could not open the survey.');
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
      toast.error(err instanceof ApiError ? err.message : 'Could not close the survey.');
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
            <DataGrid<NonNullable<typeof rows>[number]>
              id="dir-surveys"
              caption="Surveys"
              rows={rows}
              rowKey={(sv) => sv.id}
              search={{ placeholder: 'Title…' }}
              urlState={false}
              exportCsv={{ filename: 'surveys' }}
              columns={[
                { key: 'title', header: 'Title', accessor: (sv) => sv.title, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'status', header: 'Status', accessor: (sv) => sv.status, sortable: true, cardMeta: true, cell: (sv) => <StatusBadge status={sv.status} /> },
                { key: 'anonymous', header: 'Anonymous', accessor: (sv) => (sv.isAnonymous ? 'Yes' : 'No'), sortable: true, searchable: false, cardMeta: true },
                { key: 'questions', header: 'Questions', accessor: (sv) => sv.questionCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                { key: 'responses', header: 'Responses', accessor: (sv) => sv.responseCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'space-x-1 whitespace-nowrap',
                  cell: (sv) => (
                    <>
                      {canManage && sv.status === 'DRAFT' && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setQuestionsFor(sv)}>
                            <ListPlus className="mr-1 h-3 w-3" /> Questions
                          </Button>
                          <Button size="sm" disabled={busyId === sv.id} onClick={() => void onOpen(sv)}>
                            Open
                          </Button>
                        </>
                      )}
                      {canManage && sv.status === 'OPEN' && (
                        <Button size="sm" variant="ghost" disabled={busyId === sv.id} onClick={() => void onCloseSurvey(sv)}>
                          Close
                        </Button>
                      )}
                      {sv.status !== 'DRAFT' && (
                        <Button size="sm" variant="ghost" onClick={() => setResultsFor(sv)}>
                          <BarChart3 className="mr-1 h-3 w-3" /> Results
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
      toast.success('Survey draft created. Add questions, then open it.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the survey.');
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

  const [kind, setKind] = useState<SurveyQuestionKind>('SCALE_1_5');
  const [prompt, setPrompt] = useState('');
  const [choicesText, setChoicesText] = useState('');
  const [isRequired, setIsRequired] = useState(true);
  const [adding, setAdding] = useState(false);

  const questionsQuery = useQuery({
    queryKey: ['dirComms', 'survey-questions', survey.id],
    queryFn: () => listSurveyQuestions(survey.id),
  });
  const questions: SurveyQuestion[] | null = questionsQuery.data?.questions ?? null;
  const error = questionsQuery.error
    ? questionsQuery.error instanceof ApiError
      ? questionsQuery.error.message
      : 'Could not load questions.'
    : null;
  const load = () => void questionsQuery.refetch();

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
      toast.error(err instanceof ApiError ? err.message : 'Could not add the question.');
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
                  <Badge variant="outline" className="text-2xs">
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
  const resultsQuery = useQuery({
    queryKey: ['dirComms', 'survey-results', survey.id],
    queryFn: () => getSurveyAggregate(survey.id),
  });
  const data: SurveyAggregate | null = resultsQuery.data ?? null;
  const load = () => void resultsQuery.refetch();
  const error = resultsQuery.error
    ? resultsQuery.error instanceof ApiError
      ? resultsQuery.error.message
      : 'Could not load results.'
    : null;

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
