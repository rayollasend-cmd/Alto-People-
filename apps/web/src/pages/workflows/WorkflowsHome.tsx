import { useEffect, useState } from 'react';
import { Plus, Trash2, Workflow, Zap } from 'lucide-react';
import {
  createWorkflow,
  deleteWorkflow,
  listRuns,
  listWorkflows,
  testWorkflow,
  updateWorkflow,
  type WorkflowAction,
  type WorkflowActionKind,
  type WorkflowDefinition,
  type WorkflowRunSummary,
  type WorkflowTrigger,
} from '@/lib/workflowsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
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

const ACTION_KINDS: WorkflowActionKind[] = [
  'SEND_NOTIFICATION',
  'SET_FIELD',
  'ASSIGN_TASK',
  'CREATE_AUDIT_LOG',
  'WEBHOOK',
];

export function WorkflowsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const [tab, setTab] = useState<'definitions' | 'runs'>('definitions');
  const [defs, setDefs] = useState<WorkflowDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<WorkflowDefinition | 'new' | null>(null);

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

      {error && <p role="alert" className="text-sm text-alert">{error}</p>}

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
          {!defs && <SkeletonRows count={4} rowHeight="h-12" />}
          {defs && defs.length === 0 && (
            <EmptyState
              icon={Workflow}
              title="No workflows yet"
              description="Workflows fire on triggers like ASSOCIATE_HIRED → send a welcome notification, create an onboarding task, post to an audit log."
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Actions</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {defs.map((d) => (
                  <TableRow
                    key={d.id}
                    className="group cursor-pointer"
                    onClick={(e) => {
                      const t = e.target as HTMLElement;
                      if (t.closest('button, a, input, [data-no-row-click]')) return;
                      setDrawerTarget(d);
                    }}
                  >
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{d.trigger}</Badge>
                    </TableCell>
                    <TableCell className="text-silver">{d.actions.length}</TableCell>
                    <TableCell>
                      <Badge variant={d.isActive ? 'success' : 'default'}>
                        {d.isActive ? 'Active' : 'Disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.runCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
          />
        )}
      </Drawer>
    </div>
  );
}

function RunsTab() {
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns()
      .then((r) => setRuns(r.runs))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load runs.'),
      );
  }, []);

  if (error) return <p role="alert" className="text-sm text-alert">{error}</p>;
  if (!runs) return <SkeletonRows count={4} rowHeight="h-12" />;
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="No runs yet"
        description="Once a trigger fires and matches a definition, the run will appear here with its step-by-step result."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Workflow</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Steps</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">{r.definitionName}</TableCell>
            <TableCell>
              <Badge variant="outline">{r.trigger}</Badge>
            </TableCell>
            <TableCell className="text-silver tabular-nums">
              {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
            </TableCell>
            <TableCell className="text-silver tabular-nums">
              {r.stepsCompleted}/{r.stepCount}
              {r.stepsFailed > 0 && (
                <span className="text-alert"> ({r.stepsFailed} failed)</span>
              )}
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  r.status === 'COMPLETED'
                    ? 'success'
                    : r.status === 'FAILED'
                      ? 'destructive'
                      : 'pending'
                }
              >
                {r.status}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DefinitionDrawer({
  target,
  canManage,
  onClose,
  onSaved,
}: {
  target: WorkflowDefinition | 'new';
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
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
  const [actions, setActions] = useState<WorkflowAction[]>(initial?.actions ?? []);
  const [conditionsJson, setConditionsJson] = useState(
    JSON.stringify(initial?.conditions ?? {}, null, 2),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      let conditions: Record<string, unknown> = {};
      try {
        conditions = JSON.parse(conditionsJson || '{}');
      } catch {
        throw new Error('Conditions JSON is not valid.');
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
        toast.success('Workflow created');
      } else {
        await updateWorkflow(initial!.id, payload);
        toast.success('Workflow updated');
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
      toast.success('Workflow deleted');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
      setSubmitting(false);
    }
  };

  const test = async () => {
    if (isNew) {
      toast.error('Save first, then test');
      return;
    }
    setSubmitting(true);
    try {
      const res = await testWorkflow(initial!.id, { test: true });
      toast.success(`Fired ${res.runs.length} run(s)`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed');
      setSubmitting(false);
    }
  };

  const addAction = () => {
    setActions((prev) => [...prev, { kind: 'CREATE_AUDIT_LOG', params: {} }]);
  };

  const removeAction = (idx: number) => {
    setActions((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateAction = (idx: number, updated: WorkflowAction) => {
    setActions((prev) => prev.map((a, i) => (i === idx ? updated : a)));
  };

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
          <div>
            <Label htmlFor="wf-name" required>Name</Label>
            <Input
              id="wf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="wf-desc">Description</Label>
            <Input
              id="wf-desc"
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="wf-trigger">Trigger</Label>
            <select
              id="wf-trigger"
              value={trigger}
              onChange={(e) => setTrigger(e.target.value as WorkflowTrigger)}
              disabled={!canManage}
              className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
            >
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <label className="text-sm text-white flex items-center gap-2">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={!canManage}
            />
            Active (fires on matching trigger events)
          </label>

          <div>
            <Label htmlFor="wf-cond">Conditions (JSON)</Label>
            <textarea
              id="wf-cond"
              value={conditionsJson}
              onChange={(e) => setConditionsJson(e.target.value)}
              disabled={!canManage}
              rows={4}
              className="w-full px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-xs font-mono"
              placeholder='{ "and": [{ "field": "associate.state", "op": "eq", "value": "CA" }] }'
            />
          </div>

          <div className="pt-3 border-t border-navy-secondary">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-widest text-silver/80">
                Actions ({actions.length})
              </div>
              {canManage && (
                <Button size="sm" variant="outline" onClick={addAction}>
                  <Plus className="h-3.5 w-3.5" />
                  Add action
                </Button>
              )}
            </div>
            {actions.length === 0 ? (
              <p className="text-xs text-silver">No actions yet.</p>
            ) : (
              <ol className="space-y-2">
                {actions.map((a, idx) => (
                  <li
                    key={idx}
                    className="rounded border border-navy-secondary p-2 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] tabular-nums text-silver">
                        #{idx + 1}
                      </span>
                      <select
                        value={a.kind}
                        onChange={(e) =>
                          updateAction(idx, { ...a, kind: e.target.value as WorkflowActionKind })
                        }
                        disabled={!canManage}
                        className="h-8 px-2 rounded bg-navy-secondary/40 border border-navy-secondary text-xs text-white"
                      >
                        {ACTION_KINDS.map((k) => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
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
                    <textarea
                      value={JSON.stringify(a.params, null, 2)}
                      onChange={(e) => {
                        try {
                          updateAction(idx, { ...a, params: JSON.parse(e.target.value || '{}') });
                        } catch {
                          // Invalid JSON — ignore until they fix it
                        }
                      }}
                      disabled={!canManage}
                      rows={4}
                      className="w-full px-2 py-1 rounded bg-navy-secondary/40 border border-navy-secondary text-white text-xs font-mono"
                    />
                  </li>
                ))}
              </ol>
            )}
          </div>

          {error && <p role="alert" className="text-sm text-alert">{error}</p>}
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
