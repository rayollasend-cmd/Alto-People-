import { useEffect, useState } from 'react';
import { Plus, BarChart3, MessageSquare, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
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
import { listClients } from '@/lib/clientsApi';
import type { Department } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

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

  const refresh = () => {
    setRows(null);
    listMyOpenSurveys()
      .then((r) => setRows(r.surveys))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="text-lg text-white">{survey.question}</div>
        {survey.scale === 'SCORE_1_5' ? (
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setScore(n)}
                className={`flex-1 py-3 rounded-md border transition ${
                  score === n
                    ? 'bg-cyan-600 border-cyan-500 text-white'
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
              className={`flex-1 py-3 rounded-md border transition ${
                score === 1
                  ? 'bg-emerald-600 border-emerald-500 text-white'
                  : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
              }`}
            >
              Yes
            </button>
            <button
              onClick={() => setScore(0)}
              className={`flex-1 py-3 rounded-md border transition ${
                score === 0
                  ? 'bg-rose-600 border-rose-500 text-white'
                  : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
              }`}
            >
              No
            </button>
          </div>
        )}
        <div>
          <Label>Comment (optional)</Label>
          <textarea
            className="mt-1 w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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
  const [rows, setRows] = useState<PulseSurveyAdmin[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [resultsFor, setResultsFor] = useState<PulseSurveyAdmin | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PulseSurveyAdmin | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');

  const refresh = () => {
    setRows(null);
    listPulseSurveys()
      .then((r) => setRows(r.surveys))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const filtered = (rows ?? []).filter((s) => {
    if (filter === 'open') return s.isOpen;
    if (filter === 'closed') return !s.isOpen;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['all', 'open', 'closed'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'primary' : 'ghost'}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Closed (history)'}
            </Button>
          ))}
        </div>
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New survey
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
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
                  <TableHead>Scale</TableHead>
                  <TableHead>Audience</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Responses</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s) => (
                  <TableRow key={s.id} className="group">
                    <TableCell className="font-medium text-white max-w-md truncate">
                      {s.question}
                    </TableCell>
                    <TableCell>{s.scale === 'SCORE_1_5' ? '1-5' : 'Yes/No'}</TableCell>
                    <TableCell className="text-xs">{s.audienceLabel ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={s.isOpen ? 'success' : 'pending'}>
                        {s.isOpen ? 'Open' : 'Closed'}
                      </Badge>
                    </TableCell>
                    <TableCell>{s.responseCount}</TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setResultsFor(s)}
                      >
                        <BarChart3 className="mr-1 h-3 w-3" /> Results
                      </Button>
                      <button
                        onClick={() => setDeleteTarget(s)}
                        className="opacity-60 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
                      >
                        Delete
                      </button>
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
            ? `Delete "${deleteTarget.question.slice(0, 80)}${deleteTarget.question.length > 80 ? '…' : ''}"? All ${deleteTarget.responseCount} responses will be permanently removed.`
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
            toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
  const [clients, setClients] = useState<{ id: string; name: string }[] | null>(null);

  // Lazy-load the picker source the first time the user picks a non-ALL
  // audience. Most surveys go to everyone, so don't fetch upfront.
  useEffect(() => {
    if (audience === 'BY_DEPARTMENT' && departments === null) {
      listDepartments()
        .then((r) => setDepartments(r.departments))
        .catch(() => setDepartments([]));
    }
    if (audience === 'BY_CLIENT' && clients === null) {
      listClients()
        .then((r) =>
          setClients(r.clients.map((c) => ({ id: c.id, name: c.name }))),
        )
        .catch(() => setClients([]));
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
      toast.success('Survey sent.');
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
        <DrawerTitle>New pulse survey</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Question</Label>
          <textarea
            className="mt-1 w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How are you feeling about your work this week?"
          />
        </div>
        <div>
          <Label>Scale</Label>
          <select
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded-md p-2 text-white"
            value={scale}
            onChange={(e) => setScale(e.target.value as PulseScale)}
          >
            <option value="SCORE_1_5">1-5 score</option>
            <option value="YES_NO">Yes / No</option>
          </select>
        </div>
        <div>
          <Label>Audience</Label>
          <select
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded-md p-2 text-white"
            value={audience}
            onChange={(e) => setAudience(e.target.value as PulseAudience)}
          >
            <option value="ALL">Everyone</option>
            <option value="BY_DEPARTMENT">By department</option>
            <option value="BY_CLIENT">By client</option>
          </select>
        </div>
        {audience === 'BY_DEPARTMENT' && (
          <div>
            <Label>Department</Label>
            <select
              className="mt-1 w-full bg-midnight border border-navy-secondary rounded-md p-2 text-white"
              value={audienceId}
              onChange={(e) => setAudienceId(e.target.value)}
              disabled={departments === null}
            >
              <option value="">
                {departments === null ? 'Loading…' : 'Select a department…'}
              </option>
              {(departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {departments !== null && departments.length === 0 && (
              <div className="text-xs text-silver mt-1">
                No departments defined yet.
              </div>
            )}
          </div>
        )}
        {audience === 'BY_CLIENT' && (
          <div>
            <Label>Client</Label>
            <select
              className="mt-1 w-full bg-midnight border border-navy-secondary rounded-md p-2 text-white"
              value={audienceId}
              onChange={(e) => setAudienceId(e.target.value)}
              disabled={clients === null}
            >
              <option value="">
                {clients === null ? 'Loading…' : 'Select a client…'}
              </option>
              {(clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <Label>Open for (hours)</Label>
          <Input
            type="number"
            className="mt-1"
            value={openHours}
            onChange={(e) => setOpenHours(Number(e.target.value) || 72)}
          />
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
  useEffect(() => {
    getPulseResults(surveyId)
      .then(setData)
      .catch(() => setData(null));
  }, [surveyId]);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Results</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="text-lg text-white">{data.survey.question}</div>
            <div className="flex items-center gap-4 text-sm text-silver">
              <div>{data.responseCount} responses</div>
              {data.average !== null && (
                <div>Average: <span className="text-white">{data.average}</span></div>
              )}
            </div>
            <div className="space-y-2">
              {Object.entries(data.distribution).map(([k, v]) => {
                const max = Math.max(1, ...Object.values(data.distribution));
                return (
                  <div key={k} className="flex items-center gap-3">
                    <div className="w-8 text-xs text-silver">{k}</div>
                    <div className="flex-1 h-3 rounded bg-navy-secondary/40 overflow-hidden">
                      <div
                        className="h-full bg-cyan-500"
                        style={{ width: `${(v / max) * 100}%` }}
                      />
                    </div>
                    <div className="w-10 text-right text-xs">{v}</div>
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
