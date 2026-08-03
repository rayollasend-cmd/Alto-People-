import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2, Workflow, X, Zap } from 'lucide-react';
import {
  createWorkflow,
  deleteWorkflow,
  getRun,
  listRuns,
  listWorkflows,
  testWorkflow,
  updateWorkflow,
  type WorkflowAction,
  type WorkflowActionKind,
  type WorkflowDefinition,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
  type WorkflowTrigger,
} from '@/lib/workflowsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import { fmtDateTime } from '@/lib/format';
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Field,
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
import { toast } from 'sonner';

const TRIGGERS: WorkflowTrigger[] = [
  'ASSOCIATE_HIRED',
  'ASSOCIATE_TERMINATED',
  'TIME_OFF_REQUESTED',
  'TIME_OFF_APPROVED',
  'TIME_OFF_DENIED',
  'POSITION_OPENED',
  'POSITION_FILLED',
  'PAYROLL_FINALIZED',
  'ONBOARDING_COMPLETED',
  'COMPLIANCE_EXPIRING',
];

const TRIGGER_LABELS: Record<WorkflowTrigger, string> = {
  ASSOCIATE_HIRED: 'Associate hired',
  ASSOCIATE_TERMINATED: 'Associate terminated',
  TIME_OFF_REQUESTED: 'Time off requested',
  TIME_OFF_APPROVED: 'Time off approved',
  TIME_OFF_DENIED: 'Time off denied',
  POSITION_OPENED: 'Position opened',
  POSITION_FILLED: 'Position filled',
  PAYROLL_FINALIZED: 'Payroll finalized',
  ONBOARDING_COMPLETED: 'Onboarding completed',
  COMPLIANCE_EXPIRING: 'Compliance expiring',
};

const ACTION_KINDS: WorkflowActionKind[] = [
  'SEND_NOTIFICATION',
  'SET_FIELD',
  'ASSIGN_TASK',
  'CREATE_AUDIT_LOG',
  'WEBHOOK',
];

const ACTION_KIND_LABELS: Record<WorkflowActionKind, string> = {
  SEND_NOTIFICATION: 'Send notification',
  SET_FIELD: 'Set field',
  ASSIGN_TASK: 'Assign task',
  CREATE_AUDIT_LOG: 'Create audit log',
  WEBHOOK: 'Webhook',
};

const RUN_STATUSES: WorkflowRunSummary['status'][] = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

const RUN_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/** Badge variant per run/step status — RUNNING is in-flight gold per the
 *  status contract; CANCELLED is neutral. */
function runStatusVariant(
  status: string,
): 'success' | 'destructive' | 'accent' | 'default' | 'pending' {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'FAILED':
      return 'destructive';
    case 'RUNNING':
      return 'accent';
    case 'CANCELLED':
      return 'default';
    default:
      return 'pending';
  }
}

export function WorkflowsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const [tab, setTab] = useState<'definitions' | 'runs'>('definitions');
  const [defs, setDefs] = useState<WorkflowDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<WorkflowDefinition | 'new' | null>(null);
  const [defSearch, setDefSearch] = useState('');
  const [defTrigger, setDefTrigger] = useState<'' | WorkflowTrigger>('');

  const refresh = async () => {
    try {
      setError(null);
      const res = await listWorkflows();
      setDefs(res.definitions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const filteredDefs = useMemo(() => {
    if (!defs) return [];
    const q = defSearch.trim().toLowerCase();
    return defs.filter((d) => {
      if (q && !d.name.toLowerCase().includes(q)) return false;
      if (defTrigger && d.trigger !== defTrigger) return false;
      return true;
    });
  }, [defs, defSearch, defTrigger]);

  const toggleActive = async (d: WorkflowDefinition) => {
    try {
      await updateWorkflow(d.id, { isActive: !d.isActive });
      toast.success(d.isActive ? 'Workflow deactivated.' : 'Workflow activated.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update.');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Workflows"
        subtitle="Trigger-condition-action automation. Replaces hard-coded chains in route handlers — define once, fire on every matching event."
        breadcrumbs={[{ label: 'Settings' }, { label: 'Workflows' }]}
        primaryAction={
          canManage ? (
            <Button onClick={() => setDrawerTarget('new')}>
              <Plus className="h-4 w-4" />
              New workflow
            </Button>
          ) : undefined
        }
      />

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

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="definitions">
            <Workflow className="h-3.5 w-3.5" />
            Definitions
          </TabsTrigger>
          <TabsTrigger value="runs">
            <Zap className="h-3.5 w-3.5" />
            Run history
          </TabsTrigger>
        </TabsList>

        <TabsContent value="definitions">
          {!defs && !error && <SkeletonRows count={4} rowHeight="h-12" />}
          {defs && defs.length === 0 && (
            <EmptyState
              icon={Workflow}
              title="No workflows yet"
              description='Workflows fire on triggers like "Associate hired" → send a welcome notification, create an onboarding task, post to an audit log.'
              action={
                canManage ? (
                  <Button onClick={() => setDrawerTarget('new')} size="sm">
                    <Plus className="h-4 w-4" />
                    New workflow
                  </Button>
                ) : undefined
              }
            />
          )}
          {defs && defs.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="max-w-xs h-8 text-xs"
                  placeholder="Search workflows by name…"
                  value={defSearch}
                  onChange={(e) => setDefSearch(e.target.value)}
                  aria-label="Search workflows"
                />
                <div className="w-56">
                  <Select
                    size="sm"
                    value={defTrigger}
                    onChange={(e) => setDefTrigger(e.target.value as '' | WorkflowTrigger)}
                    aria-label="Filter by trigger"
                  >
                    <option value="">All triggers</option>
                    {TRIGGERS.map((t) => (
                      <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>
                    ))}
                  </Select>
                </div>
              </div>
              {filteredDefs.length === 0 ? (
                <p className="text-sm text-silver p-3">
                  No workflows match the current search / filter.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead className="hidden md:table-cell">Actions</TableHead>
                      <TableHead>Active</TableHead>
                      <TableHead className="text-right hidden md:table-cell">Runs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDefs.map((d) => (
                      <TableRow
                        key={d.id}
                        className="group cursor-pointer"
                        onClick={(e) => {
                          const t = e.target as HTMLElement;
                          if (t.closest('button, a, input, label, [data-no-row-click]')) return;
                          setDrawerTarget(d);
                        }}
                      >
                        <TableCell className="font-medium">
                          {d.name}
                          <div className="md:hidden text-xs2 text-silver/70 truncate">
                            {d.actions.length} action{d.actions.length === 1 ? '' : 's'} · {d.runCount} run{d.runCount === 1 ? '' : 's'}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{TRIGGER_LABELS[d.trigger]}</Badge>
                        </TableCell>
                        <TableCell className="text-silver hidden md:table-cell">{d.actions.length}</TableCell>
                        <TableCell>
                          {canManage ? (
                            <label
                              data-no-row-click
                              className="inline-flex items-center gap-2 text-xs text-silver cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={d.isActive}
                                onChange={() => toggleActive(d)}
                                aria-label={`Toggle "${d.name}" active`}
                              />
                              {d.isActive ? 'Active' : 'Disabled'}
                            </label>
                          ) : (
                            <Badge variant={d.isActive ? 'success' : 'default'}>
                              {d.isActive ? 'Active' : 'Disabled'}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums hidden md:table-cell">
                          {d.runCount}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="runs">
          <RunsTab />
        </TabsContent>
      </Tabs>

      <Drawer
        open={drawerTarget !== null}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-2xl"
      >
        {drawerTarget && (
          <DefinitionDrawer
            target={drawerTarget}
            canManage={canManage}
            onClose={() => setDrawerTarget(null)}
            onSaved={() => {
              setDrawerTarget(null);
              refresh();
            }}
            onTested={() => {
              // Land the operator on the run history so the freshly fired
              // run is the first thing they see.
              setDrawerTarget(null);
              refresh();
              setTab('runs');
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function RunsTab() {
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | WorkflowRunSummary['status']>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<
    Record<string, WorkflowRunDetail | 'loading' | 'error'>
  >({});

  const load = (status: '' | WorkflowRunSummary['status']) => {
    setRuns(null);
    setError(null);
    listRuns(status ? { status } : {})
      .then((r) => setRuns(r.runs))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load runs.'),
      );
  };

  useEffect(() => {
    load(statusFilter);
  }, [statusFilter]);

  const loadDetail = (id: string) => {
    setDetails((d) => ({ ...d, [id]: 'loading' }));
    getRun(id)
      .then((r) => setDetails((d) => ({ ...d, [id]: r.run })))
      .catch(() => setDetails((d) => ({ ...d, [id]: 'error' })));
  };

  const toggleExpand = (id: string) => {
    const next = expandedId === id ? null : id;
    setExpandedId(next);
    if (next && details[id] === undefined) loadDetail(id);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <Select
            size="sm"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as '' | WorkflowRunSummary['status'])
            }
            aria-label="Filter runs by status"
          >
            <option value="">All statuses</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>{RUN_STATUS_LABELS[s]}</option>
            ))}
          </Select>
        </div>
        <Button size="sm" variant="outline" onClick={() => load(statusFilter)}>
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {error ? (
        <ErrorBanner
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => load(statusFilter)}
            >
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      ) : !runs ? (
        <SkeletonRows count={4} rowHeight="h-12" />
      ) : runs.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No runs yet"
          description="Once a trigger fires and matches a definition, the run will appear here with its step-by-step result."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead className="hidden md:table-cell">Trigger</TableHead>
              <TableHead>Started</TableHead>
              <TableHead className="hidden md:table-cell">Steps</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <Fragment key={r.id}>
                <TableRow
                  className="cursor-pointer"
                  onClick={() => toggleExpand(r.id)}
                  aria-expanded={expandedId === r.id}
                >
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {expandedId === r.id ? (
                        <ChevronDown className="h-3.5 w-3.5 text-silver shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-silver shrink-0" />
                      )}
                      {r.definitionName}
                    </span>
                    <div className="md:hidden text-xs2 text-silver/70 truncate">
                      {TRIGGER_LABELS[r.trigger]} · <span className="tabular-nums">{r.stepsCompleted}/{r.stepCount}</span> steps
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant="outline">{TRIGGER_LABELS[r.trigger]}</Badge>
                  </TableCell>
                  <TableCell className="text-silver tabular-nums">
                    {fmtDateTime(r.startedAt)}
                  </TableCell>
                  <TableCell className="text-silver tabular-nums hidden md:table-cell">
                    {r.stepsCompleted}/{r.stepCount}
                    {r.stepsFailed > 0 && (
                      <span className="text-alert"> ({r.stepsFailed} failed)</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={runStatusVariant(r.status)}>
                      {RUN_STATUS_LABELS[r.status] ?? r.status}
                    </Badge>
                  </TableCell>
                </TableRow>
                {expandedId === r.id && (
                  <TableRow>
                    <TableCell colSpan={5} className="bg-navy-secondary/20">
                      <RunDetailPanel
                        detail={details[r.id]}
                        onRetry={() => loadDetail(r.id)}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function RunDetailPanel({
  detail,
  onRetry,
}: {
  detail: WorkflowRunDetail | 'loading' | 'error' | undefined;
  onRetry: () => void;
}) {
  if (detail === undefined || detail === 'loading') {
    return (
      <div className="py-2">
        <SkeletonRows count={2} rowHeight="h-8" />
      </div>
    );
  }
  if (detail === 'error') {
    return (
      <div className="py-2">
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          Failed to load run detail.
        </ErrorBanner>
      </div>
    );
  }
  return (
    <div className="py-2 space-y-3 text-xs">
      {detail.failureReason && <ErrorBanner>{detail.failureReason}</ErrorBanner>}
      <div className="text-silver">
        Entity{' '}
        <span className="font-mono text-white">
          {detail.entityType} / {detail.entityId}
        </span>
        {' · '}Started <span className="tabular-nums">{fmtDateTime(detail.startedAt)}</span>
        {' · '}Completed <span className="tabular-nums">{fmtDateTime(detail.completedAt)}</span>
      </div>
      {detail.steps.length === 0 ? (
        <p className="text-silver">No steps recorded for this run.</p>
      ) : (
        <ol className="space-y-2">
          {detail.steps.map((s) => (
            <li key={s.id} className="rounded border border-navy-secondary p-2 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-silver">#{s.ordinal + 1}</span>
                <Badge variant="outline">
                  {ACTION_KIND_LABELS[s.kind as WorkflowActionKind] ?? s.kind}
                </Badge>
                <Badge variant={runStatusVariant(s.status)}>
                  {RUN_STATUS_LABELS[s.status] ?? s.status}
                </Badge>
                <span className="ml-auto text-silver tabular-nums">
                  {fmtDateTime(s.completedAt)}
                </span>
              </div>
              {s.failureReason && <div className="text-alert">{s.failureReason}</div>}
              {s.result !== null && s.result !== undefined && (
                <pre className="font-mono text-xs2 text-silver whitespace-pre-wrap break-all bg-navy-secondary/30 rounded p-2 overflow-x-auto">
                  {JSON.stringify(s.result, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ----- Conditions builder -------------------------------------------------

// Operators match the server-side evaluator (apps/api/src/lib/workflow.ts
// evalLeaf): eq, neq, in, nin, exists. Anything else would silently never
// match, so the builder only offers what the engine understands.
type CondOp = 'eq' | 'neq' | 'in' | 'nin' | 'exists';

interface CondRow {
  field: string;
  op: CondOp;
  value: string;
}

const COND_OPS: { value: CondOp; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'in', label: 'in (comma-separated)' },
  { value: 'nin', label: 'not in (comma-separated)' },
  { value: 'exists', label: 'exists' },
];

/**
 * Attempt to represent a conditions object as simple builder rows.
 * Returns null when the shape is anything richer than `{}` or
 * `{ and: [leaf, …] }` with string(-array) values — those stay in the
 * advanced JSON editor so nothing is silently dropped.
 */
function condsToRows(conds: Record<string, unknown>): CondRow[] | null {
  const keys = Object.keys(conds ?? {});
  if (keys.length === 0) return [];
  const and = (conds as { and?: unknown }).and;
  if (keys.length !== 1 || !Array.isArray(and)) return null;
  const rows: CondRow[] = [];
  for (const leaf of and) {
    if (typeof leaf !== 'object' || leaf === null) return null;
    const l = leaf as Record<string, unknown>;
    const op = l.op;
    if (
      typeof l.field !== 'string' ||
      typeof op !== 'string' ||
      !COND_OPS.some((o) => o.value === op) ||
      Object.keys(l).some((k) => !['field', 'op', 'value'].includes(k))
    ) {
      return null;
    }
    if (op === 'exists') {
      if (l.value !== undefined) return null;
      rows.push({ field: l.field, op, value: '' });
    } else if (op === 'in' || op === 'nin') {
      if (!Array.isArray(l.value) || l.value.some((v) => typeof v !== 'string')) return null;
      rows.push({ field: l.field, op, value: (l.value as string[]).join(', ') });
    } else if (typeof l.value === 'string') {
      rows.push({ field: l.field, op: op as CondOp, value: l.value });
    } else {
      // Non-string scalar (number/bool) — round-tripping through the
      // builder would corrupt the type. Keep it in JSON mode.
      return null;
    }
  }
  return rows;
}

function rowsToConds(rows: CondRow[]): Record<string, unknown> {
  const leaves = rows
    .filter((r) => r.field.trim())
    .map((r) => {
      const field = r.field.trim();
      if (r.op === 'exists') return { field, op: r.op };
      if (r.op === 'in' || r.op === 'nin') {
        return {
          field,
          op: r.op,
          value: r.value.split(',').map((v) => v.trim()).filter(Boolean),
        };
      }
      return { field, op: r.op, value: r.value };
    });
  return leaves.length > 0 ? { and: leaves } : {};
}

// ----- Definition drawer --------------------------------------------------

interface ActionRowState {
  kind: WorkflowActionKind;
  paramsText: string;
  paramsError: string | null;
}

/** null when the text parses to a JSON object (or is blank = `{}`). */
function paramsProblem(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'Params must be a JSON object.';
    }
    return null;
  } catch {
    return 'Invalid JSON.';
  }
}

function DefinitionDrawer({
  target,
  canManage,
  onClose,
  onSaved,
  onTested,
}: {
  target: WorkflowDefinition | 'new';
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
  onTested: () => void;
}) {
  const confirm = useConfirm();
  const isNew = target === 'new';
  const initial = isNew ? null : target;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [trigger, setTrigger] = useState<WorkflowTrigger>(
    initial?.trigger ?? 'ASSOCIATE_HIRED',
  );
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [actionRows, setActionRows] = useState<ActionRowState[]>(
    (initial?.actions ?? []).map((a) => ({
      kind: a.kind,
      paramsText: JSON.stringify(a.params, null, 2),
      paramsError: null,
    })),
  );
  const [condMode, setCondMode] = useState<'builder' | 'json'>(() =>
    condsToRows(initial?.conditions ?? {}) !== null ? 'builder' : 'json',
  );
  const [condRows, setCondRows] = useState<CondRow[]>(
    () => condsToRows(initial?.conditions ?? {}) ?? [],
  );
  const [conditionsJson, setConditionsJson] = useState(
    JSON.stringify(initial?.conditions ?? {}, null, 2),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchToJson = () => {
    setConditionsJson(JSON.stringify(rowsToConds(condRows), null, 2));
    setCondMode('json');
  };

  const switchToBuilder = () => {
    try {
      const parsed = JSON.parse(conditionsJson || '{}') as Record<string, unknown>;
      const rows = condsToRows(parsed);
      if (rows === null) {
        toast.error(
          'These conditions are too complex for the simple builder — keep editing as JSON.',
        );
        return;
      }
      setCondRows(rows);
      setCondMode('builder');
    } catch {
      toast.error('Fix the conditions JSON before switching to the builder.');
    }
  };

  const submit = async () => {
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      // Actions — every params draft must parse. Nothing is silently
      // dropped: invalid drafts block the save with an inline error.
      const problems = actionRows.map((a) => paramsProblem(a.paramsText));
      const firstBad = problems.findIndex((p) => p !== null);
      if (firstBad >= 0) {
        setActionRows((rows) =>
          rows.map((a, i) => ({ ...a, paramsError: problems[i] })),
        );
        throw new Error(`Action #${firstBad + 1}: ${problems[firstBad]}`);
      }
      const actions: WorkflowAction[] = actionRows.map((a) => ({
        kind: a.kind,
        params: a.paramsText.trim()
          ? (JSON.parse(a.paramsText) as Record<string, unknown>)
          : {},
      }));

      let conditions: Record<string, unknown>;
      if (condMode === 'builder') {
        conditions = rowsToConds(condRows);
      } else {
        try {
          conditions = JSON.parse(conditionsJson || '{}');
        } catch {
          throw new Error('Conditions JSON is not valid.');
        }
      }
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        trigger,
        isActive,
        actions,
        conditions,
      };
      if (isNew) {
        await createWorkflow(payload);
        toast.success('Workflow created.');
      } else {
        await updateWorkflow(initial!.id, payload);
        toast.success('Workflow updated.');
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (isNew) return;
    if (!(await confirm({ title: `Delete workflow "${initial!.name}"?`, destructive: true }))) return;
    setSubmitting(true);
    try {
      await deleteWorkflow(initial!.id);
      toast.success('Workflow deleted.');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
      setSubmitting(false);
    }
  };

  const test = async () => {
    if (isNew) {
      toast.error('Save first, then test.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await testWorkflow(initial!.id, { test: true });
      toast.success(
        `Fired ${res.runs.length} run${res.runs.length === 1 ? '' : 's'}.`,
      );
      onTested();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed.');
      setSubmitting(false);
    }
  };

  const addAction = () => {
    setActionRows((prev) => [
      ...prev,
      { kind: 'CREATE_AUDIT_LOG', paramsText: '{}', paramsError: null },
    ]);
  };

  const removeAction = (idx: number) => {
    setActionRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const patchAction = (idx: number, patch: Partial<ActionRowState>) => {
    setActionRows((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  };

  const addCondRow = () =>
    setCondRows((rows) => [...rows, { field: '', op: 'eq', value: '' }]);

  const patchCondRow = (idx: number, patch: Partial<CondRow>) =>
    setCondRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const removeCondRow = (idx: number) =>
    setCondRows((rows) => rows.filter((_, i) => i !== idx));

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{isNew ? 'New workflow' : initial!.name}</DrawerTitle>
        <DrawerDescription>
          {isNew
            ? 'Choose a trigger, optionally restrict via conditions, then add ordered actions.'
            : `${initial!.runCount} run${initial!.runCount === 1 ? '' : 's'}`}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3">
          <Field label="Name" required>
            {(p) => (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Description">
            {(p) => (
              <Input
                value={description ?? ''}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Trigger">
            {(p) => (
              <Select
                value={trigger}
                onChange={(e) => setTrigger(e.target.value as WorkflowTrigger)}
                disabled={!canManage}
                {...p}
              >
                {TRIGGERS.map((t) => (
                  <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>
                ))}
              </Select>
            )}
          </Field>
          <label className="text-sm text-white flex items-center gap-2">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={!canManage}
            />
            Active (fires on matching trigger events)
          </label>

          <div className="pt-3 border-t border-navy-secondary">
            <div className="flex items-center justify-between mb-2">
              <div className="text-2xs uppercase tracking-widest text-silver/80">
                Conditions
              </div>
              <Button
                size="xs"
                variant="ghost"
                onClick={condMode === 'builder' ? switchToJson : switchToBuilder}
              >
                {condMode === 'builder' ? 'Advanced JSON' : 'Simple builder'}
              </Button>
            </div>

            {condMode === 'builder' ? (
              <div className="space-y-2">
                {condRows.length === 0 ? (
                  <p className="text-xs text-silver">
                    No conditions — the workflow fires on every matching trigger event.
                  </p>
                ) : (
                  <>
                    <p className="text-xs2 text-silver/80">
                      All conditions must match (AND).
                    </p>
                    {condRows.map((r, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <Input
                          className="flex-1 h-8 text-xs font-mono"
                          value={r.field}
                          onChange={(e) => patchCondRow(i, { field: e.target.value })}
                          placeholder="associate.state"
                          disabled={!canManage}
                          aria-label={`Condition ${i + 1} field`}
                        />
                        <div className="w-44">
                          <Select
                            size="sm"
                            value={r.op}
                            onChange={(e) => patchCondRow(i, { op: e.target.value as CondOp })}
                            disabled={!canManage}
                            aria-label={`Condition ${i + 1} operator`}
                          >
                            {COND_OPS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </Select>
                        </div>
                        {r.op !== 'exists' && (
                          <Input
                            className="flex-1 h-8 text-xs"
                            value={r.value}
                            onChange={(e) => patchCondRow(i, { value: e.target.value })}
                            placeholder={r.op === 'in' || r.op === 'nin' ? 'CA, NY, TX' : 'CA'}
                            disabled={!canManage}
                            aria-label={`Condition ${i + 1} value`}
                          />
                        )}
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => removeCondRow(i)}
                            className="text-silver hover:text-alert p-1 coarse:p-2.5"
                            title="Remove condition"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </>
                )}
                {canManage && (
                  <Button size="sm" variant="outline" onClick={addCondRow}>
                    <Plus className="h-3.5 w-3.5" />
                    Add condition
                  </Button>
                )}
              </div>
            ) : (
              <Field label="Conditions (JSON)">
                {(p) => (
                  <Textarea
                    value={conditionsJson}
                    onChange={(e) => setConditionsJson(e.target.value)}
                    disabled={!canManage}
                    rows={4}
                    className="text-xs font-mono"
                    placeholder='{ "and": [{ "field": "associate.state", "op": "eq", "value": "CA" }] }'
                    {...p}
                  />
                )}
              </Field>
            )}
          </div>

          <div className="pt-3 border-t border-navy-secondary">
            <div className="flex items-center justify-between mb-2">
              <div className="text-2xs uppercase tracking-widest text-silver/80">
                Actions ({actionRows.length})
              </div>
              {canManage && (
                <Button size="sm" variant="outline" onClick={addAction}>
                  <Plus className="h-3.5 w-3.5" />
                  Add action
                </Button>
              )}
            </div>
            {actionRows.length === 0 ? (
              <p className="text-xs text-silver">No actions yet.</p>
            ) : (
              <ol className="space-y-2">
                {actionRows.map((a, idx) => (
                  <li
                    key={idx}
                    className="rounded border border-navy-secondary p-2 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-2xs tabular-nums text-silver">
                        #{idx + 1}
                      </span>
                      <Select
                        size="sm"
                        value={a.kind}
                        onChange={(e) =>
                          patchAction(idx, { kind: e.target.value as WorkflowActionKind })
                        }
                        disabled={!canManage}
                      >
                        {ACTION_KINDS.map((k) => (
                          <option key={k} value={k}>{ACTION_KIND_LABELS[k]}</option>
                        ))}
                      </Select>
                      {canManage && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeAction(idx)}
                          className="text-alert hover:text-alert ml-auto"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    <Textarea
                      value={a.paramsText}
                      onChange={(e) => {
                        const text = e.target.value;
                        // Keep every keystroke; only clear the error once
                        // the JSON becomes valid again.
                        patchAction(idx, {
                          paramsText: text,
                          paramsError: paramsProblem(text) ? a.paramsError : null,
                        });
                      }}
                      onBlur={() =>
                        patchAction(idx, { paramsError: paramsProblem(a.paramsText) })
                      }
                      disabled={!canManage}
                      rows={4}
                      className="text-xs font-mono"
                      aria-invalid={a.paramsError ? true : undefined}
                    />
                    {a.paramsError && (
                      <p role="alert" className="text-xs text-alert">
                        {a.paramsError}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>

          {error && <ErrorBanner>{error}</ErrorBanner>}
        </div>
      </DrawerBody>
      <DrawerFooter className="justify-between">
        {!isNew && canManage ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={test} disabled={submitting}>
              <Zap className="h-3.5 w-3.5" />
              Test fire
            </Button>
            <Button
              variant="ghost"
              onClick={remove}
              disabled={submitting}
              className="text-alert hover:text-alert"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>
        ) : (
          <span />
        )}
        <div className="flex gap-2 ml-auto">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button
              onClick={submit}
              loading={submitting}
              disabled={!name.trim()}
            >
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </>
  );
}
