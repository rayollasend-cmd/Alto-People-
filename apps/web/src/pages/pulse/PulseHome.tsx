import { useEffect, useState } from 'react';
import { Plus, BarChart3, Download, MessageSquare, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  closePulseSurvey,
  createPulseSurvey,
  deletePulseSurvey,
  getPulseResults,
  listMyOpenSurveys,
  listPulseSurveys,
  submitPulseResponse,
  type PulseAudience,
  type PulseResults,
  type PulseScale,
  type PulseSurveyAdmin,
  type PulseSurveyOpen,
} from '@/lib/pulseSurveys109Api';
import { listDepartments } from '@/lib/orgApi';
import { useClients } from '@/lib/useClients';
import type { Department } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import { downloadCsv } from '@/lib/csv';
import { fmtDateTime, ymdLocal } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  FilterChip,
  Input,
  PageHeader,
  SegmentedControl,
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

/**
 * "Closes in 3d" / "Closes in 7h" chip copy for respondents. Days once
 * we're past 48h so the label matches how people reason about deadlines.
 */
function closesInLabel(openUntil: string): string {
  const msLeft = new Date(openUntil).getTime() - Date.now();
  if (msLeft <= 0) return 'Closing now';
  const hours = Math.max(1, Math.round(msLeft / 3_600_000));
  if (hours >= 48) return `Closes in ${Math.round(hours / 24)}d`;
  return `Closes in ${hours}h`;
}

/** YES_NO responses store 0/1 — label the buckets like the answer buttons. */
function bucketLabel(scale: PulseScale, key: string): string {
  if (scale !== 'YES_NO') return key;
  if (key === '1') return 'Yes';
  if (key === '0') return 'No';
  return key;
}

type Tab = 'me' | 'admin';

export function PulseHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const [tab, setTab] = useState<Tab>('me');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pulse"
        subtitle="One-question check-ins. Anonymous — only the score and comment are stored, never the responder."
        breadcrumbs={[{ label: 'Pulse' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="me">For me</TabsTrigger>
          {canManage && <TabsTrigger value="admin">Admin</TabsTrigger>}
        </TabsList>
        <TabsContent value="me"><MyPulseTab /></TabsContent>
        {canManage && <TabsContent value="admin"><AdminPulseTab /></TabsContent>}
      </Tabs>
    </div>
  );
}

function MyPulseTab() {
  const [rows, setRows] = useState<PulseSurveyOpen[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setRows(null);
    setError(null);
    listMyOpenSurveys()
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

  if (error) {
    return (
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={refresh}>
            Retry
          </Button>
        }
      >
        {error}
      </ErrorBanner>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-silver flex items-center gap-1.5">
        <Lock className="h-3 w-3" /> Your responses are anonymous. We can't tell who answered.
      </div>
      {rows === null ? (
        <Card><CardContent><SkeletonRows count={2} /></CardContent></Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={MessageSquare}
              title="No surveys"
              description="When HR sends a pulse, it'll show up here."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((s) => (
            <RespondCard
              key={s.id}
              survey={s}
              onAnswered={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RespondCard({
  survey,
  onAnswered,
}: {
  survey: PulseSurveyOpen;
  onAnswered: () => void;
}) {
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (score === null) {
      toast.error('Pick a score first.');
      return;
    }
    setSubmitting(true);
    try {
      await submitPulseResponse(survey.id, {
        scoreValue: score,
        comment: comment.trim() || null,
      });
      toast.success('Thanks for sharing.');
      onAnswered();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not submit your response.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="text-lg text-white">{survey.question}</div>
          <Badge variant="pending" className="shrink-0">
            {closesInLabel(survey.openUntil)}
          </Badge>
        </div>
        {survey.scale === 'SCORE_1_5' ? (
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setScore(n)}
                className={`flex-1 py-3 rounded-md border transition-colors ${
                  score === n
                    ? 'bg-gold border-gold text-navy'
                    : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex gap-3">
            <button
              onClick={() => setScore(1)}
              className={`flex-1 py-3 rounded-md border transition-colors ${
                score === 1
                  ? 'bg-success border-success text-white'
                  : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
              }`}
            >
              Yes
            </button>
            <button
              onClick={() => setScore(0)}
              className={`flex-1 py-3 rounded-md border transition-colors ${
                score === 0
                  ? 'bg-alert border-alert text-white'
                  : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
              }`}
            >
              No
            </button>
          </div>
        )}
        <div>
          <Label>Comment (optional)</Label>
          <Textarea
            className="mt-1 h-20"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            placeholder="Anything else you'd like HR to know?"
          />
        </div>
        <div className="flex justify-end">
          <Button onClick={submit} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AdminPulseTab() {
  const confirm = useConfirm();
  const [rows, setRows] = useState<PulseSurveyAdmin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [resultsFor, setResultsFor] = useState<PulseSurveyAdmin | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PulseSurveyAdmin | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');

  const refresh = () => {
    setRows(null);
    setError(null);
    listPulseSurveys()
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

  const closeNow = async (s: PulseSurveyAdmin) => {
    const ok = await confirm({
      title: 'Close this survey now?',
      description:
        'It stops accepting responses immediately. All responses collected so far are kept and stay visible in Results.',
      confirmLabel: 'Close survey',
    });
    if (!ok) return;
    setClosingId(s.id);
    try {
      await closePulseSurvey(s.id);
      toast.success('Survey closed.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not close the survey.');
    } finally {
      setClosingId(null);
    }
  };

  const filtered = (rows ?? []).filter((s) => {
    if (filter === 'open') return s.isOpen;
    if (filter === 'closed') return !s.isOpen;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-1.5">
          {(['all', 'open', 'closed'] as const).map((f) => (
            <FilterChip
              key={f}
              active={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Closed (history)'}
            </FilterChip>
          ))}
        </div>
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New survey
        </Button>
      </div>
      {error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      <Card>
        <CardContent className="p-0">
          {error ? null : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title={
                filter === 'closed'
                  ? 'No closed surveys yet'
                  : filter === 'open'
                    ? 'No surveys are currently open'
                    : 'No surveys'
              }
              description={
                filter === 'all'
                  ? 'Send a pulse to gauge how the team is doing.'
                  : 'Switch filters to see other surveys.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Question</TableHead>
                  <TableHead className="hidden lg:table-cell">Scale</TableHead>
                  <TableHead className="hidden md:table-cell">Audience</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Closes</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">Responses</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s) => (
                  <TableRow key={s.id} className="group">
                    <TableCell className="font-medium text-white max-w-md">
                      <div className="truncate">{s.question}</div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {s.audienceLabel ?? '—'}
                        <span className="sm:hidden tabular-nums">
                          {' · '}
                          {s.responseCount} responses
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{s.scale === 'SCORE_1_5' ? '1-5' : 'Yes/No'}</TableCell>
                    <TableCell className="text-xs hidden md:table-cell">{s.audienceLabel ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={s.isOpen ? 'success' : 'default'}>
                        {s.isOpen ? 'Open' : 'Closed'}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-silver">
                      {fmtDateTime(s.openUntil)}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-right tabular-nums">
                      {s.responseCount}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setResultsFor(s)}
                      >
                        <BarChart3 className="mr-1 h-3 w-3" /> Results
                      </Button>
                      {s.isOpen && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={closingId === s.id}
                          onClick={() => void closeNow(s)}
                        >
                          Close now
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteTarget(s)}
                        className="opacity-60 group-hover:opacity-100 hover:text-alert"
                      >
                        Delete
                      </Button>
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
      {resultsFor && (
        <ResultsDrawer
          surveyId={resultsFor.id}
          onClose={() => setResultsFor(null)}
        />
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete survey"
        description={
          deleteTarget
            ? `Delete "${deleteTarget.question.slice(0, 80)}${deleteTarget.question.length > 80 ? '…' : ''}"? Delete is for mistakes only — it permanently destroys the survey AND all ${deleteTarget.responseCount} responses. To stop collecting but keep the results, use Close now instead.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleting(true);
          try {
            await deletePulseSurvey(deleteTarget.id);
            toast.success('Deleted.');
            setDeleteTarget(null);
            refresh();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : 'Could not delete the survey.');
          } finally {
            setDeleting(false);
          }
        }}
      />
    </div>
  );
}

function NewSurveyDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [scale, setScale] = useState<PulseScale>('SCORE_1_5');
  const [audience, setAudience] = useState<PulseAudience>('ALL');
  const [audienceId, setAudienceId] = useState('');
  const [openHours, setOpenHours] = useState(72);
  const [saving, setSaving] = useState(false);
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [departmentsError, setDepartmentsError] = useState<string | null>(null);
  // Shared react-query cache; only fetched once a BY_CLIENT audience is
  // picked (most surveys go to everyone, so don't fetch upfront).
  const {
    clients,
    isLoading: clientsLoading,
    isError: clientsError,
    refetch: refetchClients,
  } = useClients({ enabled: audience === 'BY_CLIENT' });

  const loadDepartments = () => {
    setDepartments(null);
    setDepartmentsError(null);
    listDepartments()
      .then((r) => setDepartments(r.departments))
      .catch((err) =>
        setDepartmentsError(
          err instanceof ApiError ? err.message : 'Could not load departments.',
        ),
      );
  };

  // Lazy-load the picker source the first time the user picks a non-ALL
  // audience. Most surveys go to everyone, so don't fetch upfront.
  useEffect(() => {
    if (audience === 'BY_DEPARTMENT' && departments === null && !departmentsError) {
      loadDepartments();
    }
    // Reset selection when the audience type changes.
    setAudienceId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience]);

  const submit = async () => {
    if (question.trim().length < 5) {
      toast.error('Question must be at least 5 characters.');
      return;
    }
    if (audience !== 'ALL' && !audienceId) {
      toast.error(
        audience === 'BY_DEPARTMENT'
          ? 'Pick a department.'
          : 'Pick a client.',
      );
      return;
    }
    setSaving(true);
    try {
      await createPulseSurvey({
        question: question.trim(),
        scale,
        audience,
        audienceDepartmentId: audience === 'BY_DEPARTMENT' ? audienceId : null,
        audienceClientId: audience === 'BY_CLIENT' ? audienceId : null,
        openHours,
      });
      toast.success('Survey sent — the audience has been notified.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the survey.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New pulse survey</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Question</Label>
          <Textarea
            className="mt-1 h-20"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How are you feeling about your work this week?"
          />
        </div>
        <div>
          <Label>Scale</Label>
          <Select
            className="mt-1"
            value={scale}
            onChange={(e) => setScale(e.target.value as PulseScale)}
          >
            <option value="SCORE_1_5">1-5 score</option>
            <option value="YES_NO">Yes / No</option>
          </Select>
        </div>
        <div>
          <Label>Audience</Label>
          <Select
            className="mt-1"
            value={audience}
            onChange={(e) => setAudience(e.target.value as PulseAudience)}
          >
            <option value="ALL">Everyone</option>
            <option value="BY_DEPARTMENT">By department</option>
            <option value="BY_CLIENT">By client</option>
          </Select>
        </div>
        {audience === 'BY_DEPARTMENT' && (
          <div>
            <Label>Department</Label>
            {departmentsError ? (
              <ErrorBanner
                className="mt-1"
                action={
                  <Button size="sm" variant="secondary" onClick={loadDepartments}>
                    Retry
                  </Button>
                }
              >
                {departmentsError}
              </ErrorBanner>
            ) : (
              <>
                <Select
                  className="mt-1"
                  value={audienceId}
                  onChange={(e) => setAudienceId(e.target.value)}
                  disabled={departments === null}
                >
                  <option value="">
                    {departments === null ? 'Loading departments…' : 'Select a department…'}
                  </option>
                  {(departments ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
                {departments !== null && departments.length === 0 && (
                  <div className="text-xs text-silver mt-1">
                    No departments defined yet.
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {audience === 'BY_CLIENT' && (
          <div>
            <Label>Client</Label>
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
                className="mt-1"
                value={audienceId}
                onChange={(e) => setAudienceId(e.target.value)}
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
        )}
        <div>
          <Label>Open for (hours)</Label>
          <div className="mt-1 mb-2">
            <SegmentedControl<number>
              ariaLabel="How long the survey stays open"
              value={openHours}
              onChange={setOpenHours}
              options={[
                { value: 24, label: '24h' },
                { value: 72, label: '72h' },
                { value: 168, label: '1 week' },
              ]}
            />
          </div>
          <Input
            type="number"
            min={1}
            className="text-right tabular-nums"
            value={openHours}
            onChange={(e) => setOpenHours(Number(e.target.value) || 72)}
          />
          <div className="text-xs text-silver mt-1">
            Closes {fmtDateTime(new Date(Date.now() + openHours * 3_600_000))}
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Sending…' : 'Send'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function ResultsDrawer({
  surveyId,
  onClose,
}: {
  surveyId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<PulseResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setData(null);
    setError(null);
    getPulseResults(surveyId)
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
  }, [surveyId]);

  const exportCsv = () => {
    if (!data) return;
    downloadCsv(`pulse-results-${ymdLocal()}.csv`, [
      ['Question', data.survey.question],
      [],
      ['Bucket', 'Count'],
      ...Object.entries(data.distribution).map(([k, v]) => [
        bucketLabel(data.survey.scale, k),
        v,
      ]),
      [],
      ['Comment', 'Submitted at'],
      ...data.comments.map((c) => [c.comment, fmtDateTime(c.submittedAt)]),
    ]);
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Results</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {error ? (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={load}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        ) : !data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="text-lg text-white">{data.survey.question}</div>
            <div className="flex items-center gap-4 text-sm text-silver">
              <div className="tabular-nums">{data.responseCount} responses</div>
              {data.average !== null && (
                <div>
                  Average:{' '}
                  <span className="text-white tabular-nums">{data.average}</span>
                </div>
              )}
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={exportCsv}
                disabled={data.responseCount === 0}
              >
                <Download className="mr-1 h-3 w-3" /> Export CSV
              </Button>
            </div>
            <div className="space-y-2">
              {Object.entries(data.distribution).map(([k, v]) => {
                const max = Math.max(1, ...Object.values(data.distribution));
                return (
                  <div key={k} className="flex items-center gap-3">
                    <div className="w-8 text-xs text-silver">
                      {bucketLabel(data.survey.scale, k)}
                    </div>
                    <div className="flex-1 h-3 rounded bg-navy-secondary/40 overflow-hidden">
                      <div
                        className="h-full bg-gold"
                        style={{ width: `${(v / max) * 100}%` }}
                      />
                    </div>
                    <div className="w-10 text-right text-xs tabular-nums">{v}</div>
                  </div>
                );
              })}
            </div>
            {data.comments.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-navy-secondary">
                <div className="text-sm uppercase tracking-wider text-silver">Comments</div>
                {data.comments.map((c, i) => (
                  <div key={i} className="text-sm text-white bg-navy-secondary/40 rounded p-2">
                    "{c.comment}"
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
