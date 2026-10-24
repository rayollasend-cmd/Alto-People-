import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUrlParam } from '@/lib/useUrlState';
import { QueryError } from '@/components/ui/QueryError';
import { FilterBar } from '@/components/ui/FilterBar';
import { ViewToggle } from '@/components/ui/ViewToggle';
import { GoalCascade } from './GoalCascade';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarPlus, Download, Heart, Network, Plus, Rows3, Target } from '@/components/ui/icons';
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
import { useAuth, useTerm } from '@/lib/auth';
import { pickOne } from '@/lib/validationCopy';
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
import { CADENCE_LABEL, OneOnOneDrawer } from './OneOnOneDrawer';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
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

const TABS: readonly Tab[] = ['goals', 'kudos', 'one-on-ones', 'pips', 'reviews360', 'timeline'];

/** Plain names for each tab — "PIPs", "360s" and "OKRs" were jargon — and its primary action. */
const TAB_LABEL: Record<Tab, string> = {
  goals: 'Goals',
  kudos: 'Recognition',
  'one-on-ones': '1:1s',
  pips: 'Improvement plans',
  reviews360: '360 reviews',
  timeline: 'Timeline',
};

export function PerformanceExtras() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  // The tab lives in the URL (?tab=pips), so a view can be linked to and Back returns to it.
  const [tab, setTab] = useUrlParam<Tab>('tab', 'goals', TABS, { history: 'push' });
  // The header's primary action follows the tab; a bump opens that tab's form.
  const [createTick, setCreateTick] = useState<{ tab: Tab; n: number }>({ tab, n: 0 });
  const signal = (t: Tab) => (createTick.tab === t ? createTick.n : 0);
  const create = (t: Tab) => () => setCreateTick((c) => ({ tab: t, n: c.tab === t ? c.n + 1 : 1 }));
  const primary: Partial<Record<Tab, { label: string; manageOnly: boolean }>> = {
    goals: { label: 'New goal', manageOnly: false },
    kudos: { label: 'Send kudo', manageOnly: false },
    'one-on-ones': { label: 'Schedule 1:1', manageOnly: true },
    pips: { label: 'New improvement plan', manageOnly: true },
    reviews360: { label: 'New 360 review', manageOnly: true },
  };
  const action = primary[tab];

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Goals, 1:1s & feedback"
      subtitle="Goals from the company down to each person, 1:1s, recognition, improvement plans and 360 reviews."
      related={[
        { label: 'Reviews', to: '/performance' },
        ...(canManage ? [{ label: 'Calibration', to: '/performance/calibration' }] : []),
      ]}
      actions={action && (!action.manageOnly || canManage) ? [{ key: 'create', label: action.label, icon: Plus, primary: true, onSelect: create(tab) }] : undefined}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {TAB_LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="goals"><GoalsTab createSignal={signal('goals')} /></TabsContent>
        <TabsContent value="kudos"><KudosTab createSignal={signal('kudos')} /></TabsContent>
        <TabsContent value="one-on-ones"><OneOnOnesTab createSignal={signal('one-on-ones')} /></TabsContent>
        <TabsContent value="pips"><PipsTab canManage={canManage} createSignal={signal('pips')} /></TabsContent>
        <TabsContent value="reviews360"><Reviews360Tab canManage={canManage} createSignal={signal('reviews360')} /></TabsContent>
        <TabsContent value="timeline"><TimelineTab /></TabsContent>
      </Tabs>
    </ListTemplate>
  );
}

/** Opens a tab's form each time the header's primary action bumps the signal. */
function useCreateSignal(signal: number | undefined, open: () => void) {
  useEffect(() => {
    if (signal) open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);
}

const GOAL_FILTERS = ['ALL', 'DRAFT', 'ACTIVE', 'AT_RISK', 'COMPLETED', 'CANCELLED'] as const;
type GoalFilter = (typeof GOAL_FILTERS)[number];

// ============ Goals ============

type GoalDraft = {
  /** PERSON (default) | TEAM | COMPANY. */
  scope: 'PERSON' | 'TEAM' | 'COMPANY';
  parentGoalId: string | null;
  associate: PickedAssociate | null;
  kind: 'GOAL' | 'OBJECTIVE';
  title: string;
  description: string;
  periodStart: string;
  periodEnd: string;
};

function GoalsTab({ createSignal }: { createSignal?: number }) {
  const { user } = useAuth();
  const term = useTerm();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [pipDraft, setPipDraft] = useState<PipDraft | null>(null);
  const [assocFilter, setAssocFilter] = useState('');
  // The status filter and the layout live in the URL, so Back and a shared link keep them.
  const [statusFilter, setStatusFilter] = useUrlParam<GoalFilter>('goalStatus', 'ALL', GOAL_FILTERS);
  const [krGoalId, setKrGoalId] = useState<string | null>(null);
  const [view, setView] = useUrlParam<'cascade' | 'table'>('goalView', 'cascade', ['cascade', 'table']);

  const q = useQuery({
    queryKey: perfKeys.goals(),
    queryFn: async () => (await listGoals()).goals,
  });
  const rows = q.data ?? null;
  const loadError = queryErrorMessage(q.error, 'Could not load goals.');

  const filtered = useMemo(() => {
    if (!rows) return null;
    const needle = assocFilter.trim().toLowerCase();
    return rows.filter(
      (g) =>
        (statusFilter === 'ALL' || g.status === statusFilter) &&
        (!needle || `${g.associateName ?? ''} ${g.ownerName ?? ''} ${g.title}`.toLowerCase().includes(needle)),
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
      [term('worker'), 'Kind', 'Title', 'Period start', 'Period end', 'Status', 'Progress %'],
      ...filtered.map((g) => [
        g.associateName ?? '',
        g.kind === 'OBJECTIVE' ? 'Objective' : 'Goal',
        g.title,
        g.periodStart,
        g.periodEnd,
        GOAL_STATUS_LABELS[g.status],
        goalProgress(g),
      ]),
    ]);
  };

  const newGoal = () =>
    setDraft({
      scope: 'PERSON',
      parentGoalId: null,
      associate: null,
      kind: 'GOAL',
      title: '',
      description: '',
      periodStart: todayYmd(),
      periodEnd: `${new Date().getFullYear()}-12-31`,
    });
  useCreateSignal(createSignal, newGoal);
  const counts = useMemo(() => {
    const c: Record<GoalFilter, number> = { ALL: rows?.length ?? 0, DRAFT: 0, ACTIVE: 0, AT_RISK: 0, COMPLETED: 0, CANCELLED: 0 };
    for (const g of rows ?? []) c[g.status] += 1;
    return c;
  }, [rows]);

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
      {/* One filter row: search, the status chips (in a sheet on a phone),
          and the layout toggle; the tab's primary action is in the header. */}
      {rows && rows.length > 0 && (
        <FilterBar
          search={
            <SearchInput
              value={assocFilter}
              onChange={(e) => setAssocFilter(e.target.value)}
              placeholder="Name or title…"
              aria-label="Filter goals by person or title"
            />
          }
          activeFilters={statusFilter === 'ALL' ? 0 : 1}
          onClearFilters={() => setStatusFilter('ALL')}
          actions={
            <>
              <ViewToggle<'cascade' | 'table'>
                value={view}
                onChange={setView}
                ariaLabel="How to show goals"
                options={[
                  { value: 'cascade', label: 'Cascade', icon: Network },
                  { value: 'table', label: 'Table', icon: Rows3 },
                ]}
              />
              <Button variant="outline" size="sm" onClick={onExportCsv} disabled={!filtered || filtered.length === 0} aria-label="Export goals as CSV">
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Export CSV</span>
              </Button>
            </>
          }
        >
          {GOAL_FILTERS.map((st) => (
            <FilterChip key={st} active={statusFilter === st} onClick={() => setStatusFilter(st)} count={counts[st]}>
              {st === 'ALL' ? 'All' : GOAL_STATUS_LABELS[st]}
            </FilterChip>
          ))}
        </FilterBar>
      )}
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6"><QueryError what="goals" query={q} /></div>
          ) : filtered === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Target}
              title={rows && rows.length > 0 ? 'No goals match your filters' : 'No goals yet'}
              description={
                rows && rows.length > 0
                  ? 'Try a different status or name.'
                  : 'Start with a company goal, align team goals under it, and give each person goals that ladder up — each with measurable key results.'
              }
              action={
                rows && rows.length > 0 ? (
                  <Button variant="outline" onClick={() => { setStatusFilter('ALL'); setAssocFilter(''); }}>
                    Clear filters
                  </Button>
                ) : (
                  <Button onClick={newGoal}>
                    <Plus className="mr-2 h-4 w-4" /> New goal
                  </Button>
                )
              }
            />
          ) : view === 'cascade' ? (
            <GoalCascade goals={filtered} onOpen={(g) => setKrGoalId(g.id)} />
          ) : (
            <DataGrid<NonNullable<typeof filtered>[number]>
              id="goals"
              caption="Goals"
              rows={filtered}
              rowKey={(g) => g.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'goals' }}
              columns={[
                { key: 'title', header: 'Title', accessor: (g) => g.title, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'associate', header: term('worker'), accessor: (g) => g.associateName, sortable: true, cardMeta: true, cell: (g) => g.associateName ?? '—' },
                { key: 'kind', header: 'Kind', accessor: (g) => (g.kind === 'OBJECTIVE' ? 'Objective' : 'Goal'), sortable: true, cardMeta: true },
                { key: 'period', header: 'Period', accessor: (g) => g.periodStart, csv: (g) => `${fmtYmd(g.periodStart)} – ${fmtYmd(g.periodEnd)}`, sortable: true, searchable: false, className: 'whitespace-nowrap', cell: (g) => `${fmtYmd(g.periodStart)} – ${fmtYmd(g.periodEnd)}` },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (g) => GOAL_STATUS_LABELS[g.status],
                  sortable: true,
                  stopRowClick: true,
                  cell: (g) => (
                    <div className="inline-block">
                      <Select size="sm" value={g.status} onChange={(e) => onStatus(g, e.target.value as GoalStatus)} aria-label={`Status of ${g.title}`}>
                        {(['DRAFT', 'ACTIVE', 'AT_RISK', 'COMPLETED', 'CANCELLED'] as const).map((st) => (
                          <option key={st} value={st}>
                            {GOAL_STATUS_LABELS[st]}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ),
                },
                {
                  key: 'progress',
                  header: 'Progress',
                  accessor: (g) => (g.keyResults.length > 0 ? goalProgress(g) : g.progressPct),
                  csv: (g) => `${g.keyResults.length > 0 ? goalProgress(g) : g.progressPct}%`,
                  sortable: true,
                  searchable: false,
                  align: 'right',
                  cardMeta: true,
                  stopRowClick: true,
                  cell: (g) =>
                    g.keyResults.length > 0 ? (
                      <span className="tabular-nums" title={`Derived from ${g.keyResults.length} key result${g.keyResults.length === 1 ? '' : 's'}`}>
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
                          aria-label={`Progress of ${g.title}`}
                          onBlur={(e) => onProgress(g, Number(e.target.value))}
                        />
                        %
                      </>
                    ),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (g) => (
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
                              toast.error(err instanceof ApiError ? err.message : 'Could not prefill a PIP from this goal.');
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
                  ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <Drawer
        open={pipDraft !== null}
        onOpenChange={(o) => !o && setPipDraft(null)}
        confirmDiscard={() => !!pipDraft && (pipDraft.reason.trim().length > 0 || pipDraft.expectations.trim().length > 0 || pipDraft.supportPlan.trim().length > 0)}
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
      <Drawer
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        confirmDiscard={() => !!draft && (draft.associate !== null || draft.title.trim().length > 0 || draft.description.trim().length > 0)}
      >
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
  const term = useTerm();
  const [saving, setSaving] = useState(false);
  // Any company or team goal can be aligned to; people's goals are leaves.
  const goalsQ = useQuery({ queryKey: perfKeys.goals(), queryFn: async () => (await listGoals()).goals });
  const alignable = goalsQ.data?.filter((g) => (g.scope === 'COMPANY' || g.scope === 'TEAM') && g.status !== 'CANCELLED');
  const onSubmit = async () => {
    if (draft.scope === 'PERSON' && !draft.associate) {
      toast.error(pickOne(term));
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
        scope: draft.scope,
        associateId: draft.scope === 'PERSON' ? (draft.associate?.id ?? null) : null,
        parentGoalId: draft.parentGoalId,
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
          <Label htmlFor="goal-scope">Whose goal</Label>
          <Select
            id="goal-scope"
            className="mt-1"
            value={draft.scope}
            onChange={(e) => setDraft({ ...draft, scope: e.target.value as GoalDraft['scope'], associate: null })}
          >
            <option value="PERSON">A person’s</option>
            <option value="TEAM">A team’s (you own it)</option>
            <option value="COMPANY">The company’s</option>
          </Select>
        </div>
        {draft.scope === 'PERSON' && (
          <div>
            <Label>{term('worker')}</Label>
            <div className="mt-1">
              <AssociatePicker
                value={draft.associate}
                onChange={(a) => setDraft({ ...draft, associate: a })}
              />
            </div>
          </div>
        )}
        <div>
          <Label htmlFor="goal-parent">Aligns to</Label>
          <Select
            id="goal-parent"
            className="mt-1"
            value={draft.parentGoalId ?? ''}
            onChange={(e) => setDraft({ ...draft, parentGoalId: e.target.value || null })}
          >
            <option value="">Doesn’t align to another goal</option>
            {(alignable ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.scope === 'COMPANY' ? 'Company: ' : g.scope === 'TEAM' ? 'Team: ' : ''}
                {g.title}
              </option>
            ))}
          </Select>
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

function KudosTab({ createSignal }: { createSignal?: number }) {
  const qc = useQueryClient();
  const [showCompose, setShowCompose] = useState(false);
  useCreateSignal(createSignal, () => setShowCompose(true));
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
      {loadError ? (
        <Card>
          <CardContent className="p-0">
            <div className="p-6"><QueryError what="recognition" query={q} /></div>
          </CardContent>
        </Card>
      ) : rows === null ? (
        <Card><CardContent><SkeletonRows count={3} /></CardContent></Card>
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
              <CardContent>
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
      <Drawer open={showCompose} onOpenChange={setShowCompose} confirmDiscard={() => toAssociate !== null || message.trim().length > 0 || tags.trim().length > 0}>
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

function OneOnOnesTab({ createSignal }: { createSignal?: number }) {
  const { user } = useAuth();
  const term = useTerm();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [showSchedule, setShowSchedule] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useCreateSignal(createSignal, () => setShowSchedule(true));

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
      const r = await updateOneOnOne(m.id, { status });
      toast.success(
        status === 'COMPLETED' ? (r.nextId ? '1:1 completed — the next one is booked.' : '1:1 marked completed.') : '1:1 cancelled.',
      );
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
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6"><QueryError what="1:1s" query={q} /></div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={CalendarPlus}
              title="No 1:1s scheduled"
              description="Schedule a repeating 1:1 with each direct report — completing one books the next and carries open action items onto it."
              action={scheduleButton}
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="one-on-ones"
              caption="1:1 meetings"
              rows={rows}
              rowKey={(m) => m.id}
              search={{ placeholder: `${term('worker')}, manager…` }}
              urlState={false}
              exportCsv={{ filename: 'one-on-ones' }}
              onRowClick={(m) => setOpenId(m.id)}
              columns={[
                { key: 'associate', header: term('worker'), accessor: (m) => m.associateName, sortable: true, primary: true, className: 'font-medium text-white', cell: (m) => m.associateName ?? '—' },
                { key: 'manager', header: 'Manager', accessor: (m) => m.managerEmail, sortable: true, cardMeta: true, cell: (m) => m.managerEmail ?? '—' },
                { key: 'scheduled', header: 'Scheduled', accessor: (m) => m.scheduledFor, sortable: true, searchable: false, cardMeta: true, cell: (m) => fmtDateTime(m.scheduledFor) },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (m) => ONE_ON_ONE_STATUS_LABELS[m.status],
                  sortable: true,
                  cell: (m) => <Badge variant={m.status === 'COMPLETED' ? 'success' : m.status === 'CANCELLED' ? 'destructive' : 'info'}>{ONE_ON_ONE_STATUS_LABELS[m.status]}</Badge>,
                },
                { key: 'repeats', header: 'Repeats', accessor: (m) => (m.cadence ? CADENCE_LABEL[m.cadence] : ''), sortable: true, cardMeta: true, cell: (m) => (m.cadence ? CADENCE_LABEL[m.cadence] : '—') },
                { key: 'agenda', header: 'Agenda', accessor: (m) => m.agenda, className: 'max-w-md truncate', cell: (m) => m.agenda ?? '—' },
                {
                  key: 'items',
                  header: 'Open items',
                  accessor: (m) => (m.actionItems ?? []).filter((i) => !i.doneAt).length,
                  sortable: true,
                  searchable: false,
                  align: 'right',
                  cell: (m) => {
                    const n = (m.actionItems ?? []).filter((i) => !i.doneAt).length;
                    return n > 0 ? n : '—';
                  },
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (m) =>
                    canManage && m.status === 'SCHEDULED' ? (
                      <div className="inline-flex gap-1">
                        <Button size="sm" variant="secondary" onClick={() => onSetStatus(m, 'COMPLETED')}>
                          Complete
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onSetStatus(m, 'CANCELLED')}>
                          Cancel
                        </Button>
                      </div>
                    ) : null,
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {openId && rows?.find((m) => m.id === openId) && (
        <OneOnOneDrawer
          meeting={rows.find((m) => m.id === openId)!}
          canManage={canManage}
          queryKey={perfKeys.oneOnOnes()}
          onClose={() => setOpenId(null)}
        />
      )}
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
  const term = useTerm();
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [when, setWhen] = useState('');
  const [agenda, setAgenda] = useState('');
  const [cadence, setCadence] = useState<'WEEKLY' | 'BIWEEKLY' | ''>('WEEKLY');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!associate) {
      toast.error(pickOne(term));
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
        cadence: cadence || null,
      });
      toast.success(cadence ? `1:1 scheduled — repeats ${cadence === 'WEEKLY' ? 'weekly' : 'every two weeks'}.` : '1:1 scheduled.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not schedule the 1:1.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-lg" confirmDiscard={() => associate !== null || when.length > 0 || agenda.trim().length > 0}>
      <DrawerHeader>
        <DrawerTitle>Schedule 1:1</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{term('worker')}</Label>
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
          <Label>Repeats</Label>
          <Select className="mt-1" value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)}>
            <option value="WEEKLY">Weekly</option>
            <option value="BIWEEKLY">Every two weeks</option>
            <option value="">Just this once</option>
          </Select>
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

function PipsTab({ canManage, createSignal }: { canManage: boolean; createSignal?: number }) {
  const qc = useQueryClient();
  const term = useTerm();
  const prompt = usePrompt();
  const navigate = useNavigate();
  const [showNew, setShowNew] = useState(false);
  useCreateSignal(createSignal, () => setShowNew(true));
  const [assocFilter, setAssocFilter] = useState('');
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: perfKeys.pips(),
    queryFn: async () => (await listPips()).pips,
  });
  const rows = q.data ?? null;
  const loadError = queryErrorMessage(q.error, 'Could not load improvement plans.');

  const filtered = useMemo(() => {
    if (!rows) return null;
    const needle = assocFilter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((p) => (p.associateName ?? '').toLowerCase().includes(needle));
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
      {rows && rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SearchInput
            wrapperClassName="w-52 max-w-full"
            value={assocFilter}
            onChange={(e) => setAssocFilter(e.target.value)}
            placeholder="Filter by associate…"
            aria-label="Filter improvement plans by associate"
          />
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6"><QueryError what="improvement plans" query={q} /></div>
          ) : filtered === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={rows && rows.length > 0 ? 'No improvement plans match your filter' : 'No active improvement plans'}
              description={
                rows && rows.length > 0
                  ? 'Try a different associate name.'
                  : 'Performance Improvement Plans give associates a structured chance to remediate.'
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof filtered>[number]>
              id="pips"
              caption="Performance improvement plans"
              rows={filtered}
              rowKey={(pip) => pip.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'pips' }}
              columns={[
                { key: 'associate', header: term('worker'), accessor: (pip) => pip.associateName, sortable: true, primary: true, className: 'font-medium text-white', cell: (pip) => pip.associateName ?? '—' },
                { key: 'period', header: 'Period', accessor: (pip) => pip.startDate, csv: (pip) => `${fmtYmd(pip.startDate)} – ${fmtYmd(pip.endDate)}`, sortable: true, searchable: false, cardMeta: true, cell: (pip) => `${fmtYmd(pip.startDate)} – ${fmtYmd(pip.endDate)}` },
                { key: 'reason', header: 'Reason', accessor: (pip) => pip.reason, cardMeta: true, className: 'max-w-md truncate' },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (pip) => PIP_STATUS_LABELS[pip.status],
                  sortable: true,
                  cell: (pip) => <Badge variant={pip.status === 'PASSED' ? 'success' : pip.status === 'FAILED' ? 'destructive' : pip.status === 'ACTIVE' ? 'accent' : 'default'}>{PIP_STATUS_LABELS[pip.status]}</Badge>,
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (pip) => (
                    <>
                      {canManage && pip.status === 'ACTIVE' && (
                        <div className="inline-flex gap-1">
                          <Button size="sm" variant="secondary" onClick={() => onDecide(pip, 'PASSED')}>
                            Pass
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => onDecide(pip, 'FAILED')}>
                            Fail
                          </Button>
                        </div>
                      )}
                      {canManage && (pip.status === 'PASSED' || pip.status === 'FAILED') && (
                        <Button size="sm" variant="outline" onClick={() => onWriteReview(pip)} disabled={reviewBusyId === pip.id}>
                          {reviewBusyId === pip.id ? 'Creating…' : 'Write review'}
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
      {showNew && <PipDrawer onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); invalidatePips(); }} />}
    </div>
  );
}

function PipDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const term = useTerm();
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
      toast.error(pickOne(term));
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
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-lg" confirmDiscard={() => associate !== null || reason.trim().length > 0 || expectations.trim().length > 0 || supportPlan.trim().length > 0}>
      <DrawerHeader>
        <DrawerTitle>New PIP</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{term('worker')}</Label>
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

function Reviews360Tab({ canManage, createSignal }: { canManage: boolean; createSignal?: number }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  useCreateSignal(createSignal, () => setShowNew(true));
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
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6"><QueryError what="360 reviews" query={q} /></div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No 360 reviews"
              description="Collect anonymous feedback from peers, reports, and skip-levels for a holistic view."
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="reviews-360"
              caption="360 reviews"
              rows={rows}
              rowKey={(r) => r.id}
              search={{ placeholder: 'Subject…' }}
              urlState={false}
              exportCsv={{ filename: '360-reviews' }}
              columns={[
                { key: 'subject', header: 'Subject', accessor: (r) => r.subjectAssociateName ?? r.subjectAssociateId, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'period', header: 'Period', accessor: (r) => r.periodStart, csv: (r) => `${fmtYmd(r.periodStart)} – ${fmtYmd(r.periodEnd)}`, sortable: true, searchable: false, cardMeta: true, cell: (r) => `${fmtYmd(r.periodStart)} – ${fmtYmd(r.periodEnd)}` },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (r) => REVIEW360_STATUS_LABELS[r.status],
                  sortable: true,
                  cell: (r) => <Badge variant={r.status === 'COMPLETED' ? 'success' : r.status === 'CANCELLED' ? 'destructive' : 'accent'}>{REVIEW360_STATUS_LABELS[r.status]}</Badge>,
                },
                { key: 'feedback', header: 'Feedback', accessor: (r) => r.feedbackCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (r) => (
                    <div className="inline-flex gap-1">
                      {r.status === 'COLLECTING' && (
                        <Button size="sm" variant="secondary" onClick={() => setFeedbackFor(r)}>
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
                  ),
                },
              ]}
            />
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
  const term = useTerm();
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
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-lg" confirmDiscard={() => rating !== '' || strengths.trim().length > 0 || improvements.trim().length > 0}>
      <DrawerHeader>
        <DrawerTitle>
          Feedback for {review.subjectAssociateName ?? term('worker').toLowerCase()}
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
              <EmptyState size="sm" title={"No feedback submitted yet."} />
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
  const term = useTerm();
  const [subject, setSubject] = useState<PickedAssociate | null>(null);
  const [periodStart, setStart] = useState(() => {
    const d = new Date();
    return ymd(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1));
  });
  const [periodEnd, setEnd] = useState(todayYmd());
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!subject) {
      toast.error(pickOne(term));
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
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} confirmDiscard={() => subject !== null}>
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
  const term = useTerm();
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
        <CardContent>
          <Label>{term('worker')}</Label>
          <div className="mt-1">
            <AssociatePicker value={associate} onChange={setAssociate} />
          </div>
          {!associate && (
            <p className="mt-2 text-xs text-silver">
              {pickOne(term).replace(/\.$/, '')} to see their goals, PIPs, and reviews on one timeline.
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
