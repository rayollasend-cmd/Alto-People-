import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarPlus, Download, Heart, Plus, Target } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  closeReview360,
  createGoal,
  createKeyResult,
  createKudo,
  createOneOnOne,
  createPip,
  createReview360,
  deleteGoal,
  getAggregate,
  getPerfTimeline,
  listGoals,
  listKudos,
  listOneOnOnes,
  listPips,
  listReviews360,
  prefillPipFromGoal,
  prefillReviewFromPip,
  submitFeedback,
  updateGoal,
  updateKeyResult,
  updateOneOnOne,
  updatePip,
  type Goal,
  type GoalStatus,
  type KeyResult,
  type OneOnOne,
  type OneOnOneStatus,
  type PerfTimelineEntry,
  type Pip,
  type PipStatus,
  type Review360,
  type Review360Status,
} from '@/lib/perf84Api';
import { createReview } from '@/lib/performanceApi';
import { fmtDate, fmtDateTime, parseYmd } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import {
  AssociatePicker,
  type PickedAssociate,
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
  FilterChip,
  Input,
  PageHeader,
  SearchInput,
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

type Tab = 'goals' | 'kudos' | 'one-on-ones' | 'pips' | 'reviews360' | 'timeline';

const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  AT_RISK: 'At risk',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const ONE_ON_ONE_STATUS_LABELS: Record<OneOnOneStatus, string> = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const PIP_STATUS_LABELS: Record<PipStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  PASSED: 'Passed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const REVIEW360_STATUS_LABELS: Record<Review360Status, string> = {
  COLLECTING: 'Collecting',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** Timeline rows mix three sources, so their status strings aren't a single
 *  union — fall back to a de-SCREAMED label for anything unmapped. */
const TIMELINE_STATUS_LABELS: Record<string, string> = {
  ...GOAL_STATUS_LABELS,
  ...PIP_STATUS_LABELS,
  ...REVIEW360_STATUS_LABELS,
  SUBMITTED: 'Submitted',
  ACKNOWLEDGED: 'Acknowledged',
};

function timelineStatusLabel(s: string): string {
  return (
    TIMELINE_STATUS_LABELS[s] ??
    s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ')
  );
}

/** react-query error → message. Without this the tabs render a skeleton
 *  forever on a failed fetch (q.data stays undefined). */
function queryErrorMessage(error: unknown, fallback: string): string | null {
  if (!error) return null;
  return error instanceof ApiError ? error.message : fallback;
}

/** Load failure for a react-query-backed tab: message + Retry. */
function QueryError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
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

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayYmd() {
  return ymd(new Date());
}

/** Render a date-only "YYYY-MM-DD" as "May 13, 2026" (parsed as LOCAL
 *  midnight so it never shifts a day west of UTC). */
function fmtYmd(s: string) {
  return fmtDate(parseYmd(s));
}

/** Displayed goal progress: mean of key-result progress when KRs exist,
 *  otherwise the goal's own manually-tracked progressPct. */
function goalProgress(g: Goal): number {
  if (g.keyResults.length === 0) return g.progressPct;
  return Math.round(
    g.keyResults.reduce((sum, k) => sum + k.progressPct, 0) / g.keyResults.length,
  );
}

function planDaysHint(start: string, end: string) {
  if (!start || !end) return null;
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
  if (!Number.isFinite(days) || days <= 0) return null;
  return <p className="mt-1 text-xs text-silver">{days}-day plan</p>;
}

// Each tab's data sits behind a tuple key so a single mutation can
// invalidate one tab without flushing the others — except timeline,
// which is associate-scoped and refetched per lookup.
const perfKeys = {
  all: ['perf'] as const,
  goals: () => [...perfKeys.all, 'goals'] as const,
  kudos: (onlyPublic: boolean) => [...perfKeys.all, 'kudos', onlyPublic] as const,
  oneOnOnes: () => [...perfKeys.all, 'one-on-ones'] as const,
  pips: () => [...perfKeys.all, 'pips'] as const,
  reviews360: () => [...perfKeys.all, 'reviews360'] as const,
  timeline: (associateId: string) =>
    [...perfKeys.all, 'timeline', associateId] as const,
};

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
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>
        <TabsContent value="goals"><GoalsTab /></TabsContent>
        <TabsContent value="kudos"><KudosTab /></TabsContent>
        <TabsContent value="one-on-ones"><OneOnOnesTab /></TabsContent>
        <TabsContent value="pips"><PipsTab canManage={canManage} /></TabsContent>
        <TabsContent value="reviews360"><Reviews360Tab canManage={canManage} /></TabsContent>
        <TabsContent value="timeline"><TimelineTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ============ Goals ============

type GoalDraft = {
  associate: PickedAssociate | null;
  kind: 'GOAL' | 'OBJECTIVE';
  title: string;
  description: string;
  periodStart: string;
  periodEnd: string;
};

function GoalsTab() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [pipDraft, setPipDraft] = useState<PipDraft | null>(null);
  const [assocFilter, setAssocFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<GoalStatus | 'ALL'>('ALL');
  const [krGoalId, setKrGoalId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: perfKeys.goals(),
    queryFn: async () => (await listGoals()).goals,
  });
  const rows = q.data ?? null;
  const loadError = queryErrorMessage(q.error, 'Could not load goals.');

  const filtered = useMemo(() => {
    if (!rows) return null;
    const term = assocFilter.trim().toLowerCase();
    return rows.filter(
      (g) =>
        (statusFilter === 'ALL' || g.status === statusFilter) &&
        (!term || (g.associateName ?? '').toLowerCase().includes(term)),
    );
  }, [rows, assocFilter, statusFilter]);

  // Drawer target resolved from the live query rows so a KR add/update
  // re-renders the drawer with fresh data after invalidation.
  const krGoal = rows?.find((g) => g.id === krGoalId) ?? null;

  const invalidateGoals = () =>
    qc.invalidateQueries({ queryKey: perfKeys.goals() });

  const onProgress = async (g: Goal, pct: number) => {
    // Round — the schema wants an integer, and "62.5" typed into the
    // number input 400'd with a raw "Expected integer" (the key-result
    // handler already rounds; this one missed it).
    const clamped = Math.round(Math.max(0, Math.min(100, pct)));
    if (!Number.isFinite(clamped) || clamped === g.progressPct) return;
    try {
      await updateGoal(g.id, { progressPct: clamped });
      toast.success('Progress saved.');
      invalidateGoals();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the progress.');
    }
  };

  const onStatus = async (g: Goal, status: GoalStatus) => {
    if (status === g.status) return;
    if (status === 'COMPLETED' || status === 'CANCELLED') {
      const ok = await confirm({
        title: `Mark this goal ${status === 'COMPLETED' ? 'completed' : 'cancelled'}?`,
        description: `"${g.title}" — this is a terminal status.`,
        destructive: status === 'CANCELLED',
      });
      if (!ok) {
        // Snap the (controlled) select back to the server value.
        invalidateGoals();
        return;
      }
    }
    try {
      await updateGoal(g.id, { status });
      toast.success(`Goal marked ${GOAL_STATUS_LABELS[status].toLowerCase()}.`);
      invalidateGoals();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the goal.');
    }
  };

  const onExportCsv = () => {
    if (!filtered || filtered.length === 0) return;
    downloadCsv(`goals-${todayYmd()}.csv`, [
      ['Associate', 'Kind', 'Title', 'Period start', 'Period end', 'Status', 'Progress %'],
      ...filtered.map((g) => [
        g.associateName ?? '',
        g.kind === 'OBJECTIVE' ? 'OKR' : 'Goal',
        g.title,
        g.periodStart,
        g.periodEnd,
        GOAL_STATUS_LABELS[g.status],
        goalProgress(g),
      ]),
    ]);
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this goal?', destructive: true }))) return;
    try {
      await deleteGoal(id);
      invalidateGoals();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the goal.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['ALL', 'DRAFT', 'ACTIVE', 'AT_RISK', 'COMPLETED', 'CANCELLED'] as const).map(
          (s) => (
            <FilterChip
              key={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(s)}
              className="uppercase tracking-wider"
            >
              {s === 'ALL' ? 'All' : GOAL_STATUS_LABELS[s]}
            </FilterChip>
          ),
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SearchInput
            wrapperClassName="w-52 max-w-full"
            value={assocFilter}
            onChange={(e) => setAssocFilter(e.target.value)}
            placeholder="Filter by associate…"
            aria-label="Filter goals by associate"
          />
          <Button
            variant="outline"
            onClick={onExportCsv}
            disabled={!filtered || filtered.length === 0}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
          <Button
            onClick={() =>
              setDraft({
                associate: null,
                kind: 'GOAL',
                title: '',
                description: '',
                periodStart: todayYmd(),
                periodEnd: `${new Date().getFullYear()}-12-31`,
              })
            }
          >
            <Plus className="mr-2 h-4 w-4" /> New goal
          </Button>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <QueryError message={loadError} onRetry={() => void q.refetch()} />
          ) : filtered === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Target}
              title={rows && rows.length > 0 ? 'No goals match your filters' : 'No goals yet'}
              description={
                rows && rows.length > 0
                  ? 'Try a different status chip or associate filter.'
                  : 'Track personal goals or company-aligned OKRs with measurable key results.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Associate</TableHead>
                  <TableHead className="hidden md:table-cell">Kind</TableHead>
                  <TableHead className="hidden md:table-cell">Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Progress</TableHead>
                  <TableHead className="w-44 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{g.title}</div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {g.kind === 'OBJECTIVE' ? 'OKR' : 'Goal'} · {fmtYmd(g.periodStart)} –{' '}
                        {fmtYmd(g.periodEnd)}
                      </div>
                    </TableCell>
                    <TableCell>{g.associateName ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{g.kind === 'OBJECTIVE' ? 'OKR' : 'Goal'}</TableCell>
                    <TableCell className="hidden md:table-cell whitespace-nowrap">
                      {fmtYmd(g.periodStart)} – {fmtYmd(g.periodEnd)}
                    </TableCell>
                    <TableCell>
                      <div className="inline-block">
                        <Select
                          size="sm"
                          value={g.status}
                          onChange={(e) => onStatus(g, e.target.value as GoalStatus)}
                        >
                          {(['DRAFT', 'ACTIVE', 'AT_RISK', 'COMPLETED', 'CANCELLED'] as const).map(
                            (s) => (
                              <option key={s} value={s}>
                                {GOAL_STATUS_LABELS[s]}
                              </option>
                            ),
                          )}
                        </Select>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {g.keyResults.length > 0 ? (
                        <span
                          className="tabular-nums"
                          title={`Derived from ${g.keyResults.length} key result${g.keyResults.length === 1 ? '' : 's'}`}
                        >
                          {goalProgress(g)}%
                          <span className="ml-1 text-xs2 text-silver/70">
                            ({g.keyResults.length} KR{g.keyResults.length === 1 ? '' : 's'})
                          </span>
                        </span>
                      ) : (
                        <>
                          <Input
                            className="h-8 w-20 text-right tabular-nums"
                            type="number"
                            min={0}
                            max={100}
                            defaultValue={g.progressPct}
                            onBlur={(e) => onProgress(g, Number(e.target.value))}
                          />
                          %
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => setKrGoalId(g.id)}>
                          Key results
                        </Button>
                        {g.status === 'AT_RISK' && canManage && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              try {
                                const pre = await prefillPipFromGoal(g.id);
                                setPipDraft({
                                  associateId: pre.associateId,
                                  sourceGoalId: pre.sourceGoalId,
                                  startDate: pre.startDate,
                                  endDate: pre.endDate,
                                  reason: pre.reason,
                                  expectations: pre.expectations,
                                  supportPlan: pre.supportPlan ?? '',
                                });
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError
                                    ? err.message
                                    : 'Could not prefill a PIP from this goal.',
                                );
                              }
                            }}
                          >
                            <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
                            Start PIP
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => onDelete(g.id)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Drawer
        open={pipDraft !== null}
        onOpenChange={(o) => !o && setPipDraft(null)}
      >
        {pipDraft && (
          <PipFromGoalDrawer
            draft={pipDraft}
            setDraft={setPipDraft}
            onClose={() => setPipDraft(null)}
            onSaved={() => {
              setPipDraft(null);
              toast.success('PIP created from goal.');
              invalidateGoals();
              qc.invalidateQueries({ queryKey: perfKeys.pips() });
            }}
          />
        )}
      </Drawer>
      <Drawer open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        {draft && (
          <GoalDrawer
            draft={draft}
            setDraft={setDraft}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              invalidateGoals();
            }}
          />
        )}
      </Drawer>
      <Drawer
        open={krGoal !== null}
        onOpenChange={(o) => !o && setKrGoalId(null)}
        width="max-w-xl"
      >
        {krGoal && (
          <KeyResultsDrawer
            goal={krGoal}
            onClose={() => setKrGoalId(null)}
            onChanged={invalidateGoals}
          />
        )}
      </Drawer>
    </div>
  );
}

function KeyResultsDrawer({
  goal,
  onClose,
  onChanged,
}: {
  goal: Goal;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newTitle, setNewTitle] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [newUnit, setNewUnit] = useState('');
  const [adding, setAdding] = useState(false);

  const saveCurrent = async (k: KeyResult, raw: string) => {
    const val = Number(raw);
    if (!Number.isFinite(val) || raw.trim() === '' || val === Number(k.currentValue)) return;
    // The API stores currentValue and progressPct separately; when a target
    // exists, derive the pct here so the two never disagree.
    const target = k.targetValue !== null ? Number(k.targetValue) : null;
    const progressPct =
      target !== null && target > 0
        ? Math.max(0, Math.min(100, Math.round((val / target) * 100)))
        : undefined;
    try {
      await updateKeyResult(k.id, {
        currentValue: val,
        ...(progressPct !== undefined ? { progressPct } : {}),
      });
      toast.success('Key result saved.');
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the key result.');
    }
  };

  const saveProgress = async (k: KeyResult, raw: string) => {
    const val = Number(raw);
    if (!Number.isFinite(val) || raw.trim() === '' || val === k.progressPct) return;
    try {
      await updateKeyResult(k.id, {
        progressPct: Math.max(0, Math.min(100, Math.round(val))),
      });
      toast.success('Key result saved.');
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the key result.');
    }
  };

  const onAdd = async () => {
    if (!newTitle.trim()) {
      toast.error('Key result title required.');
      return;
    }
    const target = newTarget.trim() === '' ? null : Number(newTarget);
    if (target !== null && !Number.isFinite(target)) {
      toast.error('Target must be a number.');
      return;
    }
    setAdding(true);
    try {
      await createKeyResult(goal.id, {
        title: newTitle.trim(),
        targetValue: target,
        unit: newUnit.trim() || null,
      });
      toast.success('Key result added.');
      setNewTitle('');
      setNewTarget('');
      setNewUnit('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add the key result.');
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>Key results</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <div className="text-sm font-medium text-white truncate">{goal.title}</div>
          <p className="mt-1 text-xs text-silver">
            {goal.keyResults.length > 0
              ? `Goal progress is derived from key results: ${goalProgress(goal)}%.`
              : 'This goal has no key results yet — progress is tracked manually until one is added.'}
          </p>
        </div>
        {goal.keyResults.length > 0 && (
          <div className="space-y-2">
            {goal.keyResults.map((k) => (
              <div
                key={k.id}
                className="rounded-lg border border-navy-secondary bg-navy-secondary/30 p-3"
              >
                <div className="text-sm text-white">{k.title}</div>
                <div className="mt-2 flex flex-wrap items-end gap-3 text-xs text-silver">
                  <label className="block">
                    <span className="block text-2xs uppercase tracking-widest text-silver/70 mb-1">
                      Current
                    </span>
                    <Input
                      className="h-8 w-24"
                      type="number"
                      defaultValue={Number(k.currentValue)}
                      onBlur={(e) => saveCurrent(k, e.target.value)}
                    />
                  </label>
                  <div>
                    <span className="block text-2xs uppercase tracking-widest text-silver/70 mb-1">
                      Target
                    </span>
                    <span className="inline-block py-1.5 tabular-nums">
                      {k.targetValue ?? '—'}
                      {k.unit ? ` ${k.unit}` : ''}
                    </span>
                  </div>
                  {k.targetValue !== null ? (
                    <div>
                      <span className="block text-2xs uppercase tracking-widest text-silver/70 mb-1">
                        Progress
                      </span>
                      <span className="inline-block py-1.5 tabular-nums">{k.progressPct}%</span>
                    </div>
                  ) : (
                    <label className="block">
                      <span className="block text-2xs uppercase tracking-widest text-silver/70 mb-1">
                        Progress %
                      </span>
                      <Input
                        className="h-8 w-20"
                        type="number"
                        min={0}
                        max={100}
                        defaultValue={k.progressPct}
                        onBlur={(e) => saveProgress(k, e.target.value)}
                      />
                    </label>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="rounded-lg border border-dashed border-navy-secondary p-3 space-y-3">
          <div className="text-2xs uppercase tracking-widest text-silver/70">
            Add key result
          </div>
          <div>
            <Label>Title</Label>
            <Input
              className="mt-1"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Close 20 support tickets"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Target (optional)</Label>
              <Input
                className="mt-1"
                type="number"
                value={newTarget}
                onChange={(e) => setNewTarget(e.target.value)}
              />
            </div>
            <div>
              <Label>Unit (optional)</Label>
              <Input
                className="mt-1"
                value={newUnit}
                onChange={(e) => setNewUnit(e.target.value)}
                placeholder="tickets, %, hrs…"
              />
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={onAdd} disabled={adding}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {adding ? 'Adding…' : 'Add key result'}
          </Button>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
    </>
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
    if (!draft.associate) {
      toast.error('Pick an associate.');
      return;
    }
    if (!draft.title.trim()) {
      toast.error('Title required.');
      return;
    }
    if (!draft.periodStart || !draft.periodEnd) {
      toast.error('Period start and end required.');
      return;
    }
    setSaving(true);
    try {
      await createGoal({
        associateId: draft.associate.id,
        kind: draft.kind,
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
      });
      toast.success('Goal created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the goal.');
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
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker
              value={draft.associate}
              onChange={(a) => setDraft({ ...draft, associate: a })}
            />
          </div>
        </div>
        <div>
          <Label>Kind</Label>
          <Select
            className="mt-1"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'GOAL' | 'OBJECTIVE' })}
          >
            <option value="GOAL">Personal goal</option>
            <option value="OBJECTIVE">OKR / objective</option>
          </Select>
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
              type="date"
              value={draft.periodStart}
              onChange={(e) => setDraft({ ...draft, periodStart: e.target.value })}
            />
          </div>
          <div>
            <Label>Period end</Label>
            <Input
              className="mt-1"
              type="date"
              value={draft.periodEnd}
              onChange={(e) => setDraft({ ...draft, periodEnd: e.target.value })}
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

// ============ PIP drawer (shared) ============

type PipDraft = {
  associateId: string;
  sourceGoalId?: string;
  startDate: string;
  endDate: string;
  reason: string;
  expectations: string;
  supportPlan: string;
};

function PipFromGoalDrawer({
  draft,
  setDraft,
  onClose,
  onSaved,
}: {
  draft: PipDraft;
  setDraft: (d: PipDraft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!draft.reason.trim() || !draft.expectations.trim()) {
      toast.error('Reason and expectations required.');
      return;
    }
    setSaving(true);
    try {
      await createPip({
        associateId: draft.associateId,
        startDate: draft.startDate,
        endDate: draft.endDate,
        reason: draft.reason.trim(),
        expectations: draft.expectations.trim(),
        supportPlan: draft.supportPlan.trim() || null,
        sourceGoalId: draft.sourceGoalId,
      });
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the PIP.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>
          {draft.sourceGoalId ? 'Start PIP from goal' : 'New PIP'}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {draft.sourceGoalId && (
          <p className="text-xs text-silver">
            This PIP will be linked to the goal so it appears on the
            performance timeline.
          </p>
        )}
        <div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start date</Label>
              <Input
                className="mt-1"
                type="date"
                value={draft.startDate}
                onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
              />
            </div>
            <div>
              <Label>End date</Label>
              <Input
                className="mt-1"
                type="date"
                value={draft.endDate}
                onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
              />
            </div>
          </div>
          {planDaysHint(draft.startDate, draft.endDate)}
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea
            className="mt-1"
            value={draft.reason}
            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
          />
        </div>
        <div>
          <Label>Expectations</Label>
          <Textarea
            className="mt-1"
            rows={5}
            value={draft.expectations}
            onChange={(e) => setDraft({ ...draft, expectations: e.target.value })}
          />
        </div>
        <div>
          <Label>Support plan (optional)</Label>
          <Textarea
            className="mt-1"
            value={draft.supportPlan}
            onChange={(e) => setDraft({ ...draft, supportPlan: e.target.value })}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create PIP'}
        </Button>
      </DrawerFooter>
    </>
  );
}

// ============ Kudos ============

function KudosTab() {
  const qc = useQueryClient();
  const [showCompose, setShowCompose] = useState(false);
  const [toAssociate, setToAssociate] = useState<PickedAssociate | null>(null);
  const [message, setMessage] = useState('');
  const [tags, setTags] = useState('');

  const q = useQuery({
    queryKey: perfKeys.kudos(true),
    queryFn: async () => (await listKudos({ onlyPublic: true })).kudos,
  });
  const rows = q.data ?? null;
  const loadError = queryErrorMessage(q.error, 'Could not load kudos.');

  const sendM = useMutation({
    mutationFn: createKudo,
    onSuccess: () => {
      toast.success('Kudo sent.');
      setShowCompose(false);
      setMessage('');
      setTags('');
      setToAssociate(null);
      qc.invalidateQueries({ queryKey: perfKeys.kudos(true) });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not send the kudo.'),
  });

  const onSend = () => {
    if (!toAssociate || !message.trim()) {
      toast.error('Recipient and message required.');
      return;
    }
    sendM.mutate({
      toAssociateId: toAssociate.id,
      message: message.trim(),
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      isPublic: true,
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowCompose(true)}>
          <Heart className="mr-2 h-4 w-4" /> Send kudo
        </Button>
      </div>
      {loadError ? (
        <Card>
          <CardContent className="p-0">
            <QueryError message={loadError} onRetry={() => void q.refetch()} />
          </CardContent>
        </Card>
      ) : rows === null ? (
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
                  {fmtDateTime(k.createdAt)}
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
            <Label>Recipient</Label>
            <div className="mt-1">
              <AssociatePicker value={toAssociate} onChange={setToAssociate} />
            </div>
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
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [showSchedule, setShowSchedule] = useState(false);

  const q = useQuery({
    queryKey: perfKeys.oneOnOnes(),
    queryFn: async () => (await listOneOnOnes()).meetings,
  });
  const rows = q.data ?? null;
  const loadError = queryErrorMessage(q.error, 'Could not load 1:1s.');

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: perfKeys.oneOnOnes() });

  const onSetStatus = async (m: OneOnOne, status: 'COMPLETED' | 'CANCELLED') => {
    if (status === 'CANCELLED') {
      const ok = await confirm({
        title: 'Cancel this 1:1?',
        description: `Scheduled for ${fmtDateTime(m.scheduledFor)}.`,
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await updateOneOnOne(m.id, { status });
      toast.success(status === 'COMPLETED' ? '1:1 marked completed.' : '1:1 cancelled.');
      invalidate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the 1:1.');
    }
  };

  const scheduleButton = canManage ? (
    <Button onClick={() => setShowSchedule(true)}>
      <CalendarPlus className="mr-2 h-4 w-4" /> Schedule 1:1
    </Button>
  ) : undefined;

  return (
    <div className="space-y-4">
      {scheduleButton && <div className="flex justify-end">{scheduleButton}</div>}
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <QueryError message={loadError} onRetry={() => void q.refetch()} />
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={CalendarPlus}
              title="No 1:1s scheduled"
              description="Managers schedule recurring 1:1s with each direct report."
              action={scheduleButton}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead className="hidden md:table-cell">Manager</TableHead>
                  <TableHead>Scheduled</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Agenda</TableHead>
                  <TableHead className="w-40 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{m.associateName ?? '—'}</div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {m.managerEmail ?? '—'}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {m.managerEmail ?? '—'}
                    </TableCell>
                    <TableCell>{fmtDateTime(m.scheduledFor)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          m.status === 'COMPLETED'
                            ? 'success'
                            : m.status === 'CANCELLED'
                              ? 'destructive'
                              : 'info'
                        }
                      >
                        {ONE_ON_ONE_STATUS_LABELS[m.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-md truncate hidden md:table-cell">
                      {m.agenda ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && m.status === 'SCHEDULED' && (
                        <div className="inline-flex gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onSetStatus(m, 'COMPLETED')}
                          >
                            Complete
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onSetStatus(m, 'CANCELLED')}
                          >
                            Cancel
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
      {showSchedule && user && (
        <ScheduleOneOnOneDrawer
          managerUserId={user.id}
          onClose={() => setShowSchedule(false)}
          onSaved={() => {
            setShowSchedule(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function ScheduleOneOnOneDrawer({
  managerUserId,
  onClose,
  onSaved,
}: {
  managerUserId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [when, setWhen] = useState('');
  const [agenda, setAgenda] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!associate) {
      toast.error('Pick an associate.');
      return;
    }
    const scheduledFor = when ? new Date(when) : null;
    if (!scheduledFor || Number.isNaN(scheduledFor.getTime())) {
      toast.error('Pick a valid date and time.');
      return;
    }
    setSaving(true);
    try {
      await createOneOnOne({
        associateId: associate.id,
        managerUserId,
        scheduledFor: scheduledFor.toISOString(),
        agenda: agenda.trim() || null,
      });
      toast.success('1:1 scheduled.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not schedule the 1:1.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>Schedule 1:1</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={associate} onChange={setAssociate} />
          </div>
        </div>
        <div>
          <Label>When</Label>
          <Input
            className="mt-1"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </div>
        <div>
          <Label>Agenda (optional)</Label>
          <Textarea
            className="mt-1"
            value={agenda}
            onChange={(e) => setAgenda(e.target.value)}
            placeholder="Topics to cover…"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Schedule'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ============ PIPs ============

function PipsTab({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const navigate = useNavigate();
  const [showNew, setShowNew] = useState(false);
  const [assocFilter, setAssocFilter] = useState('');
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: perfKeys.pips(),
    queryFn: async () => (await listPips()).pips,
  });
  const rows = q.data ?? null;
  const loadError = queryErrorMessage(q.error, 'Could not load PIPs.');

  const filtered = useMemo(() => {
    if (!rows) return null;
    const term = assocFilter.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((p) => (p.associateName ?? '').toLowerCase().includes(term));
  }, [rows, assocFilter]);

  const invalidatePips = () =>
    qc.invalidateQueries({ queryKey: perfKeys.pips() });

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
      invalidatePips();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the PIP outcome.');
    }
  };

  const onWriteReview = async (p: Pip) => {
    setReviewBusyId(p.id);
    try {
      const pre = await prefillReviewFromPip(p.id);
      await createReview({
        associateId: pre.associateId,
        periodStart: pre.periodStart,
        periodEnd: pre.periodEnd,
        overallRating: pre.overallRating,
        summary: pre.summary,
        strengths: pre.strengths ?? undefined,
        improvements: pre.improvements ?? undefined,
        goals: pre.goals ?? undefined,
        sourcePipId: pre.sourcePipId,
      });
      toast.success('Draft review created from this PIP.', {
        action: { label: 'Open reviews', onClick: () => navigate('/performance') },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the review.');
    } finally {
      setReviewBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SearchInput
          wrapperClassName="w-52 max-w-full"
          value={assocFilter}
          onChange={(e) => setAssocFilter(e.target.value)}
          placeholder="Filter by associate…"
          aria-label="Filter PIPs by associate"
        />
        {canManage && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New PIP
          </Button>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <QueryError message={loadError} onRetry={() => void q.refetch()} />
          ) : filtered === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={rows && rows.length > 0 ? 'No PIPs match your filter' : 'No active PIPs'}
              description={
                rows && rows.length > 0
                  ? 'Try a different associate name.'
                  : 'Performance Improvement Plans give associates a structured chance to remediate.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="hidden md:table-cell">Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right w-52">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium text-white">
                      {p.associateName ?? '—'}
                    </TableCell>
                    <TableCell>
                      <div className="truncate">
                        {fmtYmd(p.startDate)} – {fmtYmd(p.endDate)}
                      </div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate max-w-[24ch]">
                        {p.reason}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md truncate hidden md:table-cell">{p.reason}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          p.status === 'PASSED'
                            ? 'success'
                            : p.status === 'FAILED'
                              ? 'destructive'
                              : p.status === 'ACTIVE'
                                ? 'accent'
                                : 'default'
                        }
                      >
                        {PIP_STATUS_LABELS[p.status]}
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
                      {canManage && (p.status === 'PASSED' || p.status === 'FAILED') && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onWriteReview(p)}
                          disabled={reviewBusyId === p.id}
                        >
                          {reviewBusyId === p.id ? 'Creating…' : 'Write review'}
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
      {showNew && <PipDrawer onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); invalidatePips(); }} />}
    </div>
  );
}

function PipDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [startDate, setStartDate] = useState(todayYmd());
  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 90);
    return ymd(d);
  });
  const [reason, setReason] = useState('');
  const [expectations, setExpectations] = useState('');
  const [supportPlan, setSupportPlan] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!associate) {
      toast.error('Pick an associate.');
      return;
    }
    if (!reason.trim() || !expectations.trim()) {
      toast.error('Reason and expectations are required.');
      return;
    }
    setSaving(true);
    try {
      await createPip({
        associateId: associate.id,
        startDate,
        endDate,
        reason: reason.trim(),
        expectations: expectations.trim(),
        supportPlan: supportPlan.trim() || null,
      });
      toast.success('PIP created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the PIP.');
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
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={associate} onChange={setAssociate} />
          </div>
        </div>
        <div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start</Label>
              <Input className="mt-1" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label>End</Label>
              <Input className="mt-1" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          {planDaysHint(startDate, endDate)}
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
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [feedbackFor, setFeedbackFor] = useState<Review360 | null>(null);
  const [resultsFor, setResultsFor] = useState<Review360 | null>(null);

  const q = useQuery({
    queryKey: perfKeys.reviews360(),
    queryFn: async () => (await listReviews360()).reviews,
  });
  const rows = q.data ?? null;
  const loadError = queryErrorMessage(q.error, 'Could not load 360 reviews.');

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: perfKeys.reviews360() });

  const onClose = async (id: string) => {
    if (!(await confirm({ title: 'Close this review?', description: 'No more feedback will be accepted.', destructive: true }))) return;
    try {
      await closeReview360(id);
      invalidate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not close the review.');
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
          {loadError ? (
            <QueryError message={loadError} onRetry={() => void q.refetch()} />
          ) : rows === null ? (
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
                  <TableHead className="hidden md:table-cell">Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell text-right">Feedback</TableHead>
                  <TableHead className="w-64 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium text-white">
                      <div className="truncate">
                        {r.subjectAssociateName ?? r.subjectAssociateId}
                      </div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {fmtYmd(r.periodStart)} – {fmtYmd(r.periodEnd)} · {r.feedbackCount} feedback
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {fmtYmd(r.periodStart)} – {fmtYmd(r.periodEnd)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          r.status === 'COMPLETED'
                            ? 'success'
                            : r.status === 'CANCELLED'
                              ? 'destructive'
                              : 'accent'
                        }
                      >
                        {REVIEW360_STATUS_LABELS[r.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-right tabular-nums">
                      {r.feedbackCount}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        {r.status === 'COLLECTING' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setFeedbackFor(r)}
                          >
                            Give feedback
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setResultsFor(r)}>
                          Results
                        </Button>
                        {canManage && r.status === 'COLLECTING' && (
                          <Button size="sm" variant="ghost" onClick={() => onClose(r.id)}>
                            Close
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && <NewReview360Drawer onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); invalidate(); }} />}
      {feedbackFor && (
        <FeedbackDrawer
          review={feedbackFor}
          onClose={() => setFeedbackFor(null)}
          onSaved={() => {
            setFeedbackFor(null);
            invalidate();
          }}
        />
      )}
      {resultsFor && (
        <AggregateDrawer review={resultsFor} onClose={() => setResultsFor(null)} />
      )}
    </div>
  );
}

function FeedbackDrawer({
  review,
  onClose,
  onSaved,
}: {
  review: Review360;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rating, setRating] = useState('');
  const [strengths, setStrengths] = useState('');
  const [improvements, setImprovements] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!rating && !strengths.trim() && !improvements.trim()) {
      toast.error('Add a rating or some written feedback.');
      return;
    }
    setSaving(true);
    try {
      await submitFeedback(review.id, {
        isAnonymous,
        rating: rating ? Number(rating) : null,
        strengths: strengths.trim() || null,
        improvements: improvements.trim() || null,
      });
      toast.success('Feedback submitted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not submit the feedback.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>
          Feedback for {review.subjectAssociateName ?? 'associate'}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <p className="text-xs text-silver">
          Review period {fmtYmd(review.periodStart)} – {fmtYmd(review.periodEnd)}.
        </p>
        <div>
          <Label>Rating (optional)</Label>
          <Select
            className="mt-1"
            value={rating}
            onChange={(e) => setRating(e.target.value)}
          >
            <option value="">No rating</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={String(n)}>
                {n} / 5
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Strengths</Label>
          <Textarea
            className="mt-1"
            value={strengths}
            onChange={(e) => setStrengths(e.target.value)}
            placeholder="What do they do well?"
          />
        </div>
        <div>
          <Label>Areas to improve</Label>
          <Textarea
            className="mt-1"
            value={improvements}
            onChange={(e) => setImprovements(e.target.value)}
            placeholder="Where could they grow?"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-silver">
          <input
            type="checkbox"
            className="h-4 w-4 accent-gold"
            checked={isAnonymous}
            onChange={(e) => setIsAnonymous(e.target.checked)}
          />
          Submit anonymously
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Submitting…' : 'Submit feedback'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function AggregateDrawer({
  review,
  onClose,
}: {
  review: Review360;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: [...perfKeys.reviews360(), review.id, 'aggregate'] as const,
    queryFn: () => getAggregate(review.id),
  });
  const data = q.data ?? null;
  const error =
    q.error instanceof ApiError
      ? q.error.message
      : q.error
        ? 'Could not load the 360 results.'
        : null;

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      <DrawerHeader>
        <DrawerTitle>
          360 results — {review.subjectAssociateName ?? 'associate'}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <p className="text-xs text-silver">
          {fmtYmd(review.periodStart)} – {fmtYmd(review.periodEnd)} ·{' '}
          {REVIEW360_STATUS_LABELS[review.status]}
        </p>
        {error && (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        )}
        {!data && !error && <SkeletonRows count={3} />}
        {data && (
          <>
            <div className="flex items-center gap-6 rounded-lg border border-navy-secondary bg-navy-secondary/30 p-4">
              <div>
                <div className="text-2xs uppercase tracking-widest text-silver/70">
                  Responses
                </div>
                <div className="text-2xl text-white tabular-nums">
                  {data.count}
                </div>
              </div>
              <div>
                <div className="text-2xs uppercase tracking-widest text-silver/70">
                  Average rating
                </div>
                <div className="text-2xl text-gold tabular-nums">
                  {data.averageRating !== null
                    ? `${Math.round(data.averageRating * 10) / 10}/5`
                    : '—'}
                </div>
              </div>
            </div>
            {data.entries.length === 0 && (
              <p className="text-sm text-silver">No feedback submitted yet.</p>
            )}
            {data.entries.map((f) => (
              <div
                key={f.id}
                className="rounded-lg border border-navy-secondary bg-navy-secondary/30 p-3 space-y-2"
              >
                <div className="flex items-center justify-between text-xs text-silver">
                  <span>{f.isAnonymous ? 'Anonymous' : 'Named respondent'}</span>
                  <span className="tabular-nums">
                    {f.rating !== null ? `${f.rating}/5 · ` : ''}
                    {fmtDateTime(f.submittedAt)}
                  </span>
                </div>
                {f.strengths && (
                  <div>
                    <div className="text-2xs uppercase tracking-widest text-silver/70">
                      Strengths
                    </div>
                    <div className="text-sm text-white whitespace-pre-wrap">{f.strengths}</div>
                  </div>
                )}
                {f.improvements && (
                  <div>
                    <div className="text-2xs uppercase tracking-widest text-silver/70">
                      Areas to improve
                    </div>
                    <div className="text-sm text-white whitespace-pre-wrap">
                      {f.improvements}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function NewReview360Drawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [subject, setSubject] = useState<PickedAssociate | null>(null);
  const [periodStart, setStart] = useState(() => {
    const d = new Date();
    return ymd(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1));
  });
  const [periodEnd, setEnd] = useState(todayYmd());
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!subject) {
      toast.error('Pick an associate.');
      return;
    }
    setSaving(true);
    try {
      await createReview360({
        subjectAssociateId: subject.id,
        periodStart,
        periodEnd,
      });
      toast.success('360 review created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the 360 review.');
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
          <Label>Subject</Label>
          <div className="mt-1">
            <AssociatePicker value={subject} onChange={setSubject} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Period start</Label>
            <Input className="mt-1" type="date" value={periodStart} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <Label>Period end</Label>
            <Input className="mt-1" type="date" value={periodEnd} onChange={(e) => setEnd(e.target.value)} />
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

// ============ Timeline ============

const TIMELINE_KIND_META: Record<
  PerfTimelineEntry['kind'],
  { label: string; tone: string }
> = {
  GOAL: { label: 'Goal', tone: 'bg-steel/15 text-steel border-steel/30' },
  PIP: { label: 'PIP', tone: 'bg-warning/15 text-warning border-warning/30' },
  REVIEW: { label: 'Review', tone: 'bg-success/15 text-success border-success/30' },
};

function TimelineTab() {
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);

  // The picker resolves to a stable {id, name} only when the user selects
  // a result, so the query can key directly off it — no Load button needed.
  const q = useQuery({
    queryKey: perfKeys.timeline(associate?.id ?? ''),
    queryFn: async () => (await getPerfTimeline(associate!.id)).entries,
    enabled: associate !== null,
  });
  const entries = associate !== null ? q.data ?? null : null;
  const error =
    q.error instanceof ApiError
      ? q.error.message
      : q.error
        ? 'Could not load the performance timeline.'
        : null;
  const loading = associate !== null && entries === null && !error;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={associate} onChange={setAssociate} />
          </div>
          {!associate && (
            <p className="mt-2 text-xs text-silver">
              Pick an associate to see their goals, PIPs, and reviews on one timeline.
            </p>
          )}
        </CardContent>
      </Card>
      {error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {loading && <SkeletonRows count={3} />}
      {entries && entries.length === 0 && (
        <EmptyState
          icon={Target}
          title="No performance history"
          description="This associate has no goals, PIPs, or reviews yet."
        />
      )}
      {entries && entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((e) => {
            const meta = TIMELINE_KIND_META[e.kind];
            return (
              <div
                key={`${e.kind}-${e.id}`}
                className="flex items-center gap-3 rounded-lg border border-navy-secondary bg-navy-secondary/30 px-4 py-3"
              >
                <div className="w-28 shrink-0 text-xs tabular-nums text-silver">
                  {fmtYmd(e.date)}
                </div>
                <Badge className={`shrink-0 ${meta.tone}`} variant="outline">
                  {meta.label}
                </Badge>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm text-white">{e.title}</div>
                  <div className="text-xs text-silver">
                    {timelineStatusLabel(e.status)}
                    {e.parentId && (
                      <span className="ml-2 text-silver/70">
                        ↳ linked to {e.parentKind?.toLowerCase()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
