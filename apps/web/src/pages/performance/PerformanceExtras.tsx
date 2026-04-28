import { useEffect, useState } from 'react';
import { Heart, Plus, Target } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  closeReview360,
  createGoal,
  createKudo,
  createPip,
  createReview360,
  deleteGoal,
  listGoals,
  listKudos,
  listOneOnOnes,
  listPips,
  listReviews360,
  updateGoal,
  updatePip,
  type Goal,
  type GoalStatus,
  type Kudo,
  type OneOnOne,
  type Pip,
  type Review360,
} from '@/lib/perf84Api';
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

type Tab = 'goals' | 'kudos' | 'one-on-ones' | 'pips' | 'reviews360';

export function PerformanceExtras() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const [tab, setTab] = useState<Tab>('goals');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Performance"
        subtitle="Goals & OKRs, 1:1 meetings, kudos, performance improvement plans, and 360 reviews."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Performance' }]}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="goals">Goals & OKRs</TabsTrigger>
          <TabsTrigger value="kudos">Kudos</TabsTrigger>
          <TabsTrigger value="one-on-ones">1:1s</TabsTrigger>
          <TabsTrigger value="pips">PIPs</TabsTrigger>
          <TabsTrigger value="reviews360">360s</TabsTrigger>
        </TabsList>
        <TabsContent value="goals"><GoalsTab /></TabsContent>
        <TabsContent value="kudos"><KudosTab /></TabsContent>
        <TabsContent value="one-on-ones"><OneOnOnesTab /></TabsContent>
        <TabsContent value="pips"><PipsTab canManage={canManage} /></TabsContent>
        <TabsContent value="reviews360"><Reviews360Tab canManage={canManage} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ============ Goals ============

type GoalDraft = {
  associateId: string;
  kind: 'GOAL' | 'OBJECTIVE';
  title: string;
  description: string;
  periodStart: string;
  periodEnd: string;
};

function GoalsTab() {
  const confirm = useConfirm();
  const [rows, setRows] = useState<Goal[] | null>(null);
  const [draft, setDraft] = useState<GoalDraft | null>(null);

  const refresh = async () => {
    setRows(null);
    try {
      const r = await listGoals();
      setRows(r.goals);
    } catch {
      setRows([]);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const onProgress = async (g: Goal, pct: number) => {
    try {
      await updateGoal(g.id, { progressPct: Math.max(0, Math.min(100, pct)) });
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onStatus = async (g: Goal, status: GoalStatus) => {
    try {
      await updateGoal(g.id, { status });
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this goal?', destructive: true }))) return;
    try {
      await deleteGoal(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          onClick={() =>
            setDraft({
              associateId: '',
              kind: 'GOAL',
              title: '',
              description: '',
              periodStart: '',
              periodEnd: '',
            })
          }
        >
          <Plus className="mr-2 h-4 w-4" /> New goal
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Target}
              title="No goals yet"
              description="Track personal goals or company-aligned OKRs with measurable key results."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium text-white">{g.title}</TableCell>
                    <TableCell>{g.kind === 'OBJECTIVE' ? 'OKR' : 'Goal'}</TableCell>
                    <TableCell>
                      {g.periodStart} – {g.periodEnd}
                    </TableCell>
                    <TableCell>
                      <select
                        className="h-8 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-xs text-white"
                        value={g.status}
                        onChange={(e) => onStatus(g, e.target.value as GoalStatus)}
                      >
                        {(['DRAFT', 'ACTIVE', 'AT_RISK', 'COMPLETED', 'CANCELLED'] as const).map(
                          (s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ),
                        )}
                      </select>
                    </TableCell>
                    <TableCell>
                      <Input
                        className="h-8 w-20"
                        type="number"
                        min={0}
                        max={100}
                        defaultValue={g.progressPct}
                        onBlur={(e) => onProgress(g, Number(e.target.value))}
                      />
                      %
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => onDelete(g.id)}>
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
      <Drawer open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        {draft && (
          <GoalDrawer
            draft={draft}
            setDraft={setDraft}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              refresh();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function GoalDrawer({
  draft,
  setDraft,
  onClose,
  onSaved,
}: {
  draft: GoalDraft;
  setDraft: (d: GoalDraft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!draft.associateId) {
      toast.error('Associate ID required (paste UUID).');
      return;
    }
    if (!draft.title.trim()) {
      toast.error('Title required.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(draft.periodEnd)) {
      toast.error('Dates must be YYYY-MM-DD.');
      return;
    }
    setSaving(true);
    try {
      await createGoal({
        associateId: draft.associateId,
        kind: draft.kind,
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
      });
      toast.success('Goal created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>New goal</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={draft.associateId}
            onChange={(e) => setDraft({ ...draft, associateId: e.target.value })}
            placeholder="UUID"
          />
        </div>
        <div>
          <Label>Kind</Label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'GOAL' | 'OBJECTIVE' })}
          >
            <option value="GOAL">Personal goal</option>
            <option value="OBJECTIVE">OKR / objective</option>
          </select>
        </div>
        <div>
          <Label>Title</Label>
          <Input
            className="mt-1"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            className="mt-1"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Period start</Label>
            <Input
              className="mt-1"
              value={draft.periodStart}
              onChange={(e) => setDraft({ ...draft, periodStart: e.target.value })}
              placeholder="2026-01-01"
            />
          </div>
          <div>
            <Label>Period end</Label>
            <Input
              className="mt-1"
              value={draft.periodEnd}
              onChange={(e) => setDraft({ ...draft, periodEnd: e.target.value })}
              placeholder="2026-12-31"
            />
          </div>
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
    </>
  );
}

// ============ Kudos ============

function KudosTab() {
  const [rows, setRows] = useState<Kudo[] | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [toAssociateId, setToAssociateId] = useState('');
  const [message, setMessage] = useState('');
  const [tags, setTags] = useState('');

  const refresh = async () => {
    setRows(null);
    try {
      const r = await listKudos({ onlyPublic: true });
      setRows(r.kudos);
    } catch {
      setRows([]);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const onSend = async () => {
    if (!toAssociateId.trim() || !message.trim()) {
      toast.error('Recipient and message required.');
      return;
    }
    try {
      await createKudo({
        toAssociateId: toAssociateId.trim(),
        message: message.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        isPublic: true,
      });
      toast.success('Kudo sent.');
      setShowCompose(false);
      setMessage('');
      setTags('');
      setToAssociateId('');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowCompose(true)}>
          <Heart className="mr-2 h-4 w-4" /> Send kudo
        </Button>
      </div>
      {rows === null ? (
        <Card><CardContent className="p-6"><SkeletonRows count={3} /></CardContent></Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Heart}
          title="No public kudos yet"
          description="Send a kudo to someone — recognize a job well done, a value lived, or a clutch save."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((k) => (
            <Card key={k.id}>
              <CardContent className="p-4">
                <div className="text-sm text-silver mb-1">
                  <span className="text-white">{k.fromUserEmail}</span> →{' '}
                  <span className="text-white">{k.toAssociateName}</span>
                </div>
                <div className="text-white">{k.message}</div>
                {k.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {k.tags.map((t) => (
                      <Badge key={t} variant="accent">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-xs text-silver">
                  {new Date(k.createdAt).toLocaleString()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Drawer open={showCompose} onOpenChange={setShowCompose}>
        <DrawerHeader>
          <DrawerTitle>Send kudo</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <div>
            <Label>Recipient associate ID</Label>
            <Input
              className="mt-1 font-mono text-xs"
              value={toAssociateId}
              onChange={(e) => setToAssociateId(e.target.value)}
              placeholder="UUID"
            />
          </div>
          <div>
            <Label>Message</Label>
            <Textarea
              className="mt-1"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <div>
            <Label>Tags (comma-separated)</Label>
            <Input
              className="mt-1"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="ownership, craft"
            />
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" onClick={() => setShowCompose(false)}>
            Cancel
          </Button>
          <Button onClick={onSend}>Send</Button>
        </DrawerFooter>
      </Drawer>
    </div>
  );
}

// ============ 1:1s ============

function OneOnOnesTab() {
  const [rows, setRows] = useState<OneOnOne[] | null>(null);
  useEffect(() => {
    listOneOnOnes()
      .then((r) => setRows(r.meetings))
      .catch(() => setRows([]));
  }, []);

  return (
    <Card>
      <CardContent className="p-0">
        {rows === null ? (
          <div className="p-6"><SkeletonRows count={3} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No 1:1s scheduled"
            description="Managers schedule recurring 1:1s with each direct report."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scheduled</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Agenda</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{new Date(m.scheduledFor).toLocaleString()}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        m.status === 'COMPLETED'
                          ? 'success'
                          : m.status === 'CANCELLED'
                            ? 'destructive'
                            : 'pending'
                      }
                    >
                      {m.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-md truncate">{m.agenda ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ============ PIPs ============

function PipsTab({ canManage }: { canManage: boolean }) {
  const prompt = usePrompt();
  const [rows, setRows] = useState<Pip[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listPips()
      .then((r) => setRows(r.pips))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onDecide = async (p: Pip, status: 'PASSED' | 'FAILED') => {
    const note = await prompt({
      title: status === 'PASSED' ? 'Mark PIP passed' : 'Mark PIP failed',
      reasonLabel: 'Outcome note (optional)',
      confirmLabel: status === 'PASSED' ? 'Mark passed' : 'Mark failed',
      destructive: status === 'FAILED',
      required: false,
    });
    if (note === null) return;
    try {
      await updatePip(p.id, { status, outcomeNote: note });
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
            <Plus className="mr-2 h-4 w-4" /> New PIP
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No active PIPs"
              description="Performance Improvement Plans give associates a structured chance to remediate."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right w-44">Decide</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.startDate} – {p.endDate}</TableCell>
                    <TableCell className="max-w-md truncate">{p.reason}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          p.status === 'PASSED'
                            ? 'success'
                            : p.status === 'FAILED'
                              ? 'destructive'
                              : 'pending'
                        }
                      >
                        {p.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && p.status === 'ACTIVE' && (
                        <div className="inline-flex gap-1">
                          <Button size="sm" variant="secondary" onClick={() => onDecide(p, 'PASSED')}>
                            Pass
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => onDecide(p, 'FAILED')}>
                            Fail
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && <PipDrawer onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refresh(); }} />}
    </div>
  );
}

function PipDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [associateId, setAssociateId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [expectations, setExpectations] = useState('');
  const [supportPlan, setSupportPlan] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!associateId.trim() || !reason.trim() || !expectations.trim()) {
      toast.error('Associate, reason, and expectations are required.');
      return;
    }
    setSaving(true);
    try {
      await createPip({
        associateId: associateId.trim(),
        startDate,
        endDate,
        reason: reason.trim(),
        expectations: expectations.trim(),
        supportPlan: supportPlan.trim() || null,
      });
      toast.success('PIP created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>New PIP</DrawerTitle>
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
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Start</Label>
            <Input className="mt-1" value={startDate} onChange={(e) => setStartDate(e.target.value)} placeholder="2026-04-27" />
          </div>
          <div>
            <Label>End</Label>
            <Input className="mt-1" value={endDate} onChange={(e) => setEndDate(e.target.value)} placeholder="2026-07-27" />
          </div>
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div>
          <Label>Expectations</Label>
          <Textarea
            className="mt-1"
            value={expectations}
            onChange={(e) => setExpectations(e.target.value)}
          />
        </div>
        <div>
          <Label>Support plan (optional)</Label>
          <Textarea
            className="mt-1"
            value={supportPlan}
            onChange={(e) => setSupportPlan(e.target.value)}
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

// ============ 360 reviews ============

function Reviews360Tab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<Review360[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listReviews360()
      .then((r) => setRows(r.reviews))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onClose = async (id: string) => {
    if (!(await confirm({ title: 'Close this review?', description: 'No more feedback will be accepted.', destructive: true }))) return;
    try {
      await closeReview360(id);
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
            <Plus className="mr-2 h-4 w-4" /> New 360
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No 360 reviews"
              description="Collect anonymous feedback from peers, reports, and skip-levels for a holistic view."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Feedback</TableHead>
                  <TableHead className="w-32 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.subjectAssociateId}</TableCell>
                    <TableCell>{r.periodStart} – {r.periodEnd}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          r.status === 'COMPLETED'
                            ? 'success'
                            : r.status === 'CANCELLED'
                              ? 'destructive'
                              : 'pending'
                        }
                      >
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{r.feedbackCount}</TableCell>
                    <TableCell className="text-right">
                      {canManage && r.status === 'COLLECTING' && (
                        <Button size="sm" variant="ghost" onClick={() => onClose(r.id)}>
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
      {showNew && <NewReview360Drawer onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refresh(); }} />}
    </div>
  );
}

function NewReview360Drawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [subjectAssociateId, setSubject] = useState('');
  const [periodStart, setStart] = useState('');
  const [periodEnd, setEnd] = useState('');
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!subjectAssociateId.trim()) {
      toast.error('Subject required.');
      return;
    }
    setSaving(true);
    try {
      await createReview360({
        subjectAssociateId: subjectAssociateId.trim(),
        periodStart,
        periodEnd,
      });
      toast.success('360 review created.');
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
        <DrawerTitle>New 360 review</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Subject associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={subjectAssociateId}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Period start</Label>
            <Input className="mt-1" value={periodStart} onChange={(e) => setStart(e.target.value)} placeholder="2026-01-01" />
          </div>
          <div>
            <Label>Period end</Label>
            <Input className="mt-1" value={periodEnd} onChange={(e) => setEnd(e.target.value)} placeholder="2026-12-31" />
          </div>
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
