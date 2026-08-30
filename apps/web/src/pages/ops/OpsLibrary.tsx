import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Camera,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Hash,
  MessageSquare,
  Pencil,
  Plus,
  ShieldCheck,
  Thermometer,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { DEPT_FALLBACK_ICON, DEPT_ICON, DEPT_TONE } from './opsVisuals';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { CountUpValue } from '@/components/ui/MetricCard';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { useConfirm } from '@/lib/confirm';
import {
  addOpsTemplateTask,
  createOpsTemplate,
  deleteOpsTemplateTask,
  getOpsLibrary,
  METRIC_LABEL,
  patchOpsTemplate,
  patchOpsTemplateTask,
  type OpsLibraryTemplate,
  type OpsPeriod,
  type OpsResponseType,
} from '@/lib/opsApi';

/**
 * The standard itself — the constitution every floor runs on. Editable by
 * leadership only (operations, HR admin, the chairman: this page is the
 * exec portal's ONE write). Supervisors run these; they never edit them.
 * "Delete" is retire — every already-run shift keeps its checklist as
 * executed, so the record never rewrites.
 */

const PERIODS: { value: OpsPeriod; label: string; short: string }[] = [
  { value: 'MORNING', label: 'Morning / opening', short: 'Morning' },
  { value: 'EVENING', label: 'Evening / recovery', short: 'Evening' },
  { value: 'CLOSING', label: 'Closing', short: 'Closing' },
  { value: 'OVERNIGHT', label: 'Overnight', short: 'Overnight' },
];

const RESPONSE_TYPES: { value: OpsResponseType; label: string }[] = [
  { value: 'CHECK', label: 'Checkmark' },
  { value: 'YES_NO', label: 'Yes / No' },
  { value: 'YES_NO_PARTIAL', label: 'Yes / No / Partial' },
  { value: 'TEXT', label: 'Written response' },
  { value: 'NUMBER', label: 'Number' },
  { value: 'TEMPERATURE', label: 'Temperature (with bounds)' },
  { value: 'PHOTO', label: 'Photo required' },
];

const RESPONSE_ICON: Partial<Record<OpsResponseType, LucideIcon>> = {
  TEMPERATURE: Thermometer,
  PHOTO: Camera,
  NUMBER: Hash,
  TEXT: MessageSquare,
};

export function OpsLibrary() {
  const [library, setLibrary] = useState<{
    departments: string[];
    templates: OpsLibraryTemplate[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newOpen, setNewOpen] = useState(false);
  const confirm = useConfirm();

  const load = useCallback(() => {
    getOpsLibrary()
      .then(setLibrary)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the library.'),
      );
  }, []);
  useEffect(() => load(), [load]);

  // After "New SOP": once the reloaded library contains the fresh
  // template (already added to `expanded`), scroll it into view so "add
  // its tasks" points somewhere instead of a collapsed row far below.
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingFocusId || !library?.templates.some((t) => t.id === pendingFocusId)) {
      return;
    }
    document
      .getElementById(`ops-template-${pendingFocusId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setPendingFocusId(null);
  }, [pendingFocusId, library]);

  const stats = useMemo(() => {
    if (!library) return null;
    const tasks = library.templates.flatMap((t) => t.tasks);
    return {
      sops: library.templates.length,
      tasks: tasks.length,
      temps: tasks.filter((t) => t.responseType === 'TEMPERATURE').length,
      photos: tasks.filter((t) => t.photoRequired || t.responseType === 'PHOTO').length,
      runs: library.templates.reduce((n, t) => n + t.runs28d, 0),
    };
  }, [library]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!library || !stats) return <Skeleton className="h-64" />;

  const byDepartment = new Map<string, OpsLibraryTemplate[]>();
  for (const dept of library.departments) byDepartment.set(dept, []);
  for (const tpl of library.templates) {
    const list = byDepartment.get(tpl.department) ?? [];
    list.push(tpl);
    byDepartment.set(tpl.department, list);
  }

  return (
    <div className="space-y-4">
      {/* ===== Hero: the constitution's vital signs ===== */}
      <div className="relative overflow-hidden rounded-lg border border-navy-secondary bg-gradient-to-br from-navy-secondary/60 via-navy to-navy p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-gold/10 blur-3xl"
        />
        <div className="relative flex flex-wrap items-center gap-x-8 gap-y-4">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-gold" aria-hidden="true" />
              <span className="text-2xs uppercase tracking-[0.2em] text-gold">
                The operating standard
              </span>
            </div>
            <div className="mt-1 text-xl font-medium text-white">
              One playbook, every floor, every shift
            </div>
            <div className="mt-0.5 max-w-prose text-xs text-silver/70">
              Edits apply to future shifts only — every shift already run keeps its
              checklist exactly as executed.
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-8 gap-y-3">
            <HeroStat label="Active SOPs" value={<CountUpValue value={stats.sops} />} />
            <HeroStat label="Standard tasks" value={<CountUpValue value={stats.tasks} />} />
            <HeroStat
              label="Temp checks"
              value={<CountUpValue value={stats.temps} />}
              tone="text-teal"
            />
            <HeroStat
              label="Photo proofs"
              value={<CountUpValue value={stats.photos} />}
              tone="text-sky"
            />
            <HeroStat
              label="Runs · 28d"
              value={<CountUpValue value={stats.runs} />}
              tone="text-success"
            />
          </div>
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" />
            New SOP
          </Button>
        </div>
      </div>

      {/* ===== Coverage matrix — where the standard reaches ===== */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Coverage — department × shift period
            <span className="ml-2 text-xs font-normal text-silver/60">
              a dark cell is an uncovered period
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <div
              className="grid min-w-[560px] gap-1.5"
              style={{ gridTemplateColumns: '200px repeat(4, 1fr)' }}
            >
              <div />
              {PERIODS.map((p) => (
                <div
                  key={p.value}
                  className="text-center text-2xs uppercase tracking-wider text-silver/60"
                >
                  {p.short}
                </div>
              ))}
              {library.departments.map((dept) => {
                const Icon = DEPT_ICON[dept] ?? DEPT_FALLBACK_ICON;
                return [
                  <div key={dept} className="flex items-center gap-2 pr-2">
                    <Icon
                      className={cn('h-4 w-4 shrink-0', DEPT_TONE[dept] ?? 'text-gold')}
                      aria-hidden="true"
                    />
                    <span className="truncate text-xs text-white">{dept}</span>
                  </div>,
                  ...PERIODS.map((p) => {
                    const tpl = library.templates.find(
                      (t) => t.department === dept && t.period === p.value,
                    );
                    return (
                      <div
                        key={`${dept}|${p.value}`}
                        className={cn(
                          'flex h-9 items-center justify-center rounded-md border text-2xs tabular-nums transition-colors',
                          tpl
                            ? tpl.avgSopPct != null && tpl.avgSopPct < 70
                              ? 'border-warning/50 bg-warning/10 text-warning'
                              : 'border-success/30 bg-success/[0.08] text-success'
                            : 'border-navy-secondary bg-navy-secondary/30 text-silver/30',
                        )}
                        title={
                          tpl
                            ? `${tpl.name} · ${tpl.taskCount} tasks${tpl.runs28d > 0 ? ` · ${tpl.runs28d} runs, ${tpl.avgSopPct ?? '—'}% avg` : ' · not run yet'}`
                            : `${dept} has no ${p.short.toLowerCase()} SOP — add one if this period is worked.`
                        }
                      >
                        {tpl
                          ? tpl.runs28d > 0
                            ? `${tpl.avgSopPct ?? '—'}%`
                            : `${tpl.taskCount} tasks`
                          : '—'}
                      </div>
                    );
                  }),
                ];
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ===== Department libraries ===== */}
      {[...byDepartment.entries()]
        .filter(([, templates]) => templates.length > 0)
        .map(([department, templates]) => {
          const Icon = DEPT_ICON[department] ?? DEPT_FALLBACK_ICON;
          const deptTasks = templates.reduce((n, t) => n + t.taskCount, 0);
          const deptRuns = templates.reduce((n, t) => n + t.runs28d, 0);
          return (
            <Card key={department}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <Icon
                    className={cn('mr-2 inline h-5 w-5', DEPT_TONE[department] ?? 'text-gold')}
                    aria-hidden="true"
                  />
                  {department}
                  <span className="ml-2 text-xs font-normal text-silver/60 tabular-nums">
                    {templates.length} SOP{templates.length === 1 ? '' : 's'} · {deptTasks}{' '}
                    tasks{deptRuns > 0 ? ` · ${deptRuns} runs in 28d` : ''}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {templates.map((tpl) => {
                  const isOpen = expanded.has(tpl.id);
                  return (
                    <div
                      key={tpl.id}
                      id={`ops-template-${tpl.id}`}
                      className={cn(
                        'scroll-mt-16 rounded-lg border transition-colors',
                        isOpen
                          ? 'border-gold/40 bg-navy-secondary/10'
                          : 'border-navy-secondary hover:border-gold/25',
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(tpl.id)) next.delete(tpl.id);
                              else next.add(tpl.id);
                              return next;
                            })
                          }
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-gold" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-silver/60" />
                          )}
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-white">
                                {tpl.name}
                              </span>
                              <span className="rounded-full border border-navy-secondary px-2 py-0.5 text-2xs text-silver/70">
                                {PERIODS.find((p) => p.value === tpl.period)?.short ??
                                  tpl.period}
                              </span>
                            </div>
                            {tpl.description && (
                              <div className="mt-0.5 truncate text-xs text-silver/60">
                                {tpl.description}
                              </div>
                            )}
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center gap-4">
                          {/* Standard → execution: proof it's actually run. */}
                          <div className="text-right">
                            <div
                              className={cn(
                                'text-sm font-semibold tabular-nums',
                                tpl.runs28d === 0
                                  ? 'text-silver/40'
                                  : (tpl.avgSopPct ?? 0) >= 90
                                    ? 'text-success'
                                    : (tpl.avgSopPct ?? 0) >= 70
                                      ? 'text-gold'
                                      : 'text-warning',
                              )}
                            >
                              {tpl.runs28d === 0 ? 'not run yet' : `${tpl.avgSopPct ?? '—'}%`}
                            </div>
                            <div className="text-2xs text-silver/50 tabular-nums">
                              {tpl.runs28d === 0
                                ? 'last 28 days'
                                : `${tpl.runs28d} run${tpl.runs28d === 1 ? '' : 's'} · 28d`}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-semibold tabular-nums text-white">
                              {tpl.taskCount}
                            </div>
                            <div className="text-2xs text-silver/50">tasks</div>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Retire "${tpl.name}"?`,
                                description:
                                  'It disappears from future shifts. Every shift already run keeps its checklist as executed — history never changes.',
                                confirmLabel: 'Retire',
                                destructive: true,
                              });
                              if (!ok) return;
                              try {
                                await patchOpsTemplate(tpl.id, { retire: true });
                                toast.success('Retired.');
                                load();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError
                                    ? err.message
                                    : 'Could not retire.',
                                );
                              }
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Retire
                          </Button>
                        </div>
                      </div>
                      {isOpen && <TemplateTasks tpl={tpl} onChanged={load} />}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}

      <NewTemplateDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        departments={library.departments}
        onCreated={(id) => {
          // Expand the newborn and walk the editor to it.
          setExpanded((prev) => new Set(prev).add(id));
          setPendingFocusId(id);
          load();
        }}
      />
    </div>
  );
}

function HeroStat({
  label,
  value,
  tone = 'text-white',
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div>
      <div className={cn('text-xl font-semibold leading-none tabular-nums', tone)}>{value}</div>
      <div className="mt-1 text-2xs uppercase tracking-wider text-silver/60">{label}</div>
    </div>
  );
}

function TemplateTasks({
  tpl,
  onChanged,
}: {
  tpl: OpsLibraryTemplate;
  onChanged: () => void;
}) {
  const [section, setSection] = useState('');
  const [title, setTitle] = useState('');
  const [responseType, setResponseType] = useState<OpsResponseType>('CHECK');
  const [tempMin, setTempMin] = useState('');
  const [tempMax, setTempMax] = useState('');
  const [busy, setBusy] = useState(false);
  const [editTask, setEditTask] = useState<OpsLibraryTemplate['tasks'][number] | null>(null);

  const sections = [...new Set(tpl.tasks.map((t) => t.section))];

  return (
    <div className="border-t border-navy-secondary p-3 space-y-3">
      {sections.map((sec, secIdx) => {
        const rows = tpl.tasks.filter((t) => t.section === sec);
        return (
          <div key={sec}>
            <div className="flex items-center gap-2">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-gold/15 text-2xs font-semibold tabular-nums text-gold">
                {secIdx + 1}
              </span>
              <span className="text-2xs uppercase tracking-wider text-silver/70">{sec}</span>
              <span className="text-2xs text-silver/40 tabular-nums">{rows.length}</span>
              <span className="h-px flex-1 bg-navy-secondary" aria-hidden="true" />
            </div>
            <ul className="mt-1.5 space-y-1">
              {rows.map((task) => {
                const RIcon = RESPONSE_ICON[task.responseType];
                return (
                  <li
                    key={task.id}
                    className="group flex items-center justify-between gap-2 rounded-md bg-navy-secondary/20 px-2.5 py-1.5 text-sm hover:bg-navy-secondary/40"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ClipboardCheck
                        className="h-3.5 w-3.5 shrink-0 text-silver/30"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 truncate text-white">{task.title}</span>
                      {RIcon && (
                        <span
                          className={cn(
                            'inline-flex shrink-0 items-center gap-1 rounded-full border border-navy-secondary px-1.5 py-0.5 text-2xs',
                            task.responseType === 'TEMPERATURE'
                              ? 'text-teal'
                              : task.responseType === 'PHOTO'
                                ? 'text-sky'
                                : 'text-silver/70',
                          )}
                        >
                          <RIcon className="h-3 w-3" aria-hidden="true" />
                          {task.responseType === 'TEMPERATURE' &&
                          task.tempMin != null &&
                          task.tempMax != null ? (
                            <span className="tabular-nums">
                              {task.tempMin}–{task.tempMax}°F
                            </span>
                          ) : task.responseType === 'PHOTO' || task.photoRequired ? (
                            'proof'
                          ) : task.responseType === 'NUMBER' ? (
                            (task.unit ?? 'count')
                          ) : (
                            'note'
                          )}
                        </span>
                      )}
                      {task.photoRequired && task.responseType !== 'PHOTO' && (
                        <Camera className="h-3 w-3 shrink-0 text-sky" aria-hidden="true" />
                      )}
                      {task.followUpOn && (
                        <span
                          className="shrink-0 rounded-full border border-warning/40 px-1.5 py-0.5 text-2xs text-warning"
                          title={
                            task.followUpOn === 'OUT_OF_RANGE'
                              ? 'Out-of-range readings spawn a re-check task automatically.'
                              : 'A No answer spawns an explain-and-correct task automatically.'
                          }
                        >
                          loop
                        </span>
                      )}
                      {!task.required && (
                        <span className="shrink-0 text-2xs text-silver/40">optional</span>
                      )}
                    </span>
                    {/* Reality annotation: how this LINE performs (28d). */}
                    {task.stats.runs >= 3 && (
                      <span className="ml-auto flex shrink-0 items-center gap-2 text-2xs tabular-nums">
                        <span
                          className={cn(
                            Math.round((task.stats.done / task.stats.runs) * 100) >= 90
                              ? 'text-success'
                              : Math.round((task.stats.done / task.stats.runs) * 100) >= 60
                                ? 'text-silver/60'
                                : 'text-warning',
                          )}
                          title={`Completed on ${task.stats.done} of ${task.stats.runs} shifts in 28 days.`}
                        >
                          {Math.round((task.stats.done / task.stats.runs) * 100)}%
                        </span>
                        {task.stats.noCount + task.stats.partialCount > 0 && (
                          <span
                            className="text-warning"
                            title={`${task.stats.noCount} No, ${task.stats.partialCount} Partial in 28 days.`}
                          >
                            {task.stats.noCount + task.stats.partialCount} flagged
                          </span>
                        )}
                        {task.stats.outOfRange > 0 && (
                          <span
                            className="text-alert"
                            title={`${task.stats.outOfRange} out-of-range reading${task.stats.outOfRange === 1 ? '' : 's'} in 28 days.`}
                          >
                            {task.stats.outOfRange}⚠
                          </span>
                        )}
                      </span>
                    )}
                    {/* Always visible — hover-reveal hid these entirely on
                        iPads (no hover exists there). */}
                    <span className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        className="rounded p-1 coarse:p-1.5 text-silver/40 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                        aria-label={`Edit "${task.title}"`}
                        title="Edit this task (past shifts keep their version)."
                        onClick={() => setEditTask(task)}
                      >
                        <Pencil className="h-3.5 w-3.5 coarse:h-4 coarse:w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 coarse:p-1.5 text-silver/40 hover:text-alert focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                        aria-label={`Remove "${task.title}" from this SOP`}
                        title="Remove from the standard (past shifts keep it)."
                        onClick={async () => {
                          try {
                            await deleteOpsTemplateTask(task.id);
                            onChanged();
                          } catch (err) {
                            toast.error(
                              err instanceof ApiError ? err.message : 'Could not remove.',
                            );
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 coarse:h-4 coarse:w-4" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      {editTask && (
        <EditTaskDialog
          task={editTask}
          sections={sections}
          onClose={() => setEditTask(null)}
          onSaved={() => {
            setEditTask(null);
            onChanged();
          }}
        />
      )}

      {/* Add-task composer. */}
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-navy-secondary bg-navy-secondary/10 p-2.5">
        <div className="w-36">
          <Label className="text-xs">Section</Label>
          <Input
            value={section}
            onChange={(e) => setSection(e.target.value)}
            placeholder={sections[0] ?? 'Opening'}
            list={`sections-${tpl.id}`}
          />
          <datalist id={`sections-${tpl.id}`}>
            {sections.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div className="min-w-[200px] flex-1">
          <Label className="text-xs">Task</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Verify cooler door seals"
          />
        </div>
        <div className="w-44">
          <Label className="text-xs">Response</Label>
          <Select
            value={responseType}
            onChange={(e) => setResponseType(e.target.value as OpsResponseType)}
          >
            {RESPONSE_TYPES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
        {responseType === 'TEMPERATURE' && (
          <>
            <div className="w-20">
              <Label className="text-xs">Min °F</Label>
              <Input
                inputMode="decimal"
                value={tempMin}
                onChange={(e) => setTempMin(e.target.value)}
              />
            </div>
            <div className="w-20">
              <Label className="text-xs">Max °F</Label>
              <Input
                inputMode="decimal"
                value={tempMax}
                onChange={(e) => setTempMax(e.target.value)}
              />
            </div>
          </>
        )}
        <Button
          size="sm"
          loading={busy}
          disabled={!title.trim() || !(section.trim() || sections[0])}
          onClick={async () => {
            setBusy(true);
            try {
              await addOpsTemplateTask(tpl.id, {
                section: section.trim() || sections[0] || 'Tasks',
                title: title.trim(),
                responseType,
                photoRequired: responseType === 'PHOTO',
                ...(responseType === 'TEMPERATURE' && tempMin !== ''
                  ? { tempMin: Number(tempMin) }
                  : {}),
                ...(responseType === 'TEMPERATURE' && tempMax !== ''
                  ? { tempMax: Number(tempMax) }
                  : {}),
              });
              setTitle('');
              onChanged();
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Could not add.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}

function EditTaskDialog({
  task,
  sections,
  onClose,
  onSaved,
}: {
  task: OpsLibraryTemplate['tasks'][number];
  sections: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [section, setSection] = useState(task.section);
  const [instructions, setInstructions] = useState(task.instructions ?? '');
  const [responseType, setResponseType] = useState<OpsResponseType>(task.responseType);
  const [required, setRequired] = useState(task.required);
  const [tempMin, setTempMin] = useState(task.tempMin != null ? String(task.tempMin) : '');
  const [tempMax, setTempMax] = useState(task.tempMax != null ? String(task.tempMax) : '');
  const [tempLabel, setTempLabel] = useState(task.tempLabel ?? '');
  const [metricKey, setMetricKey] = useState(task.metricKey ?? '');
  const [unit, setUnit] = useState(task.unit ?? '');
  const [followUpOn, setFollowUpOn] = useState<string>(task.followUpOn ?? '');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
          <DialogDescription>
            Changes apply to future shifts only — every shift already run keeps
            this task exactly as it was executed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Task</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[150px] flex-1">
              <Label className="text-xs">Section</Label>
              <Input
                value={section}
                onChange={(e) => setSection(e.target.value)}
                list={`edit-sections-${task.id}`}
              />
              <datalist id={`edit-sections-${task.id}`}>
                {sections.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="min-w-[180px] flex-1">
              <Label className="text-xs">Response</Label>
              <Select
                value={responseType}
                onChange={(e) => setResponseType(e.target.value as OpsResponseType)}
              >
                {RESPONSE_TYPES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {responseType === 'TEMPERATURE' && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[140px] flex-1">
                <Label className="text-xs">Reading label</Label>
                <Input
                  value={tempLabel}
                  onChange={(e) => setTempLabel(e.target.value)}
                  placeholder="e.g. Cooler °F"
                />
              </div>
              <div className="w-24">
                <Label className="text-xs">Min °F</Label>
                <Input
                  inputMode="decimal"
                  value={tempMin}
                  onChange={(e) => setTempMin(e.target.value)}
                />
              </div>
              <div className="w-24">
                <Label className="text-xs">Max °F</Label>
                <Input
                  inputMode="decimal"
                  value={tempMax}
                  onChange={(e) => setTempMax(e.target.value)}
                />
              </div>
            </div>
          )}
          {responseType === 'NUMBER' && (
            <div className="flex flex-wrap gap-3">
              <div className="min-w-[180px] flex-1">
                <Label className="text-xs">Metric (for reporting)</Label>
                <Select value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
                  <option value="">— unnamed count —</option>
                  {Object.entries(METRIC_LABEL)
                    .filter(([k]) => k !== 'recorded')
                    .map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                </Select>
              </div>
              <div className="w-32">
                <Label className="text-xs">Unit</Label>
                <Input
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="e.g. cases"
                />
              </div>
            </div>
          )}
          {(responseType === 'YES_NO' ||
            responseType === 'YES_NO_PARTIAL' ||
            responseType === 'TEMPERATURE') && (
            <div>
              <Label className="text-xs">Closed loop — spawn a follow-up task when…</Label>
              <Select value={followUpOn} onChange={(e) => setFollowUpOn(e.target.value)}>
                <option value="">Never</option>
                {responseType === 'TEMPERATURE' ? (
                  <option value="OUT_OF_RANGE">The reading is out of range</option>
                ) : (
                  <>
                    <option value="NO">The answer is No</option>
                    {responseType === 'YES_NO_PARTIAL' && (
                      <option value="NO_OR_PARTIAL">The answer is No or Partial</option>
                    )}
                  </>
                )}
              </Select>
              <p className="mt-1 text-2xs text-silver/60">
                Out-of-range spawns a re-check with the same bounds; No spawns an
                explain-and-correct task. Both are required, so an unresolved loop
                shows in the shift record.
              </p>
            </div>
          )}
          <div>
            <Label className="text-xs">Instructions (optional)</Label>
            <Input
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Shown to the supervisor under the task"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-silver">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            Required — closing without it flags the shift incomplete
          </label>
        </div>
        <DialogFooter>
          <Button
            loading={busy}
            disabled={!title.trim() || !section.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await patchOpsTemplateTask(task.id, {
                  title: title.trim(),
                  section: section.trim(),
                  instructions: instructions.trim() || null,
                  responseType,
                  required,
                  photoRequired: responseType === 'PHOTO',
                  metricKey: responseType === 'NUMBER' ? metricKey || null : null,
                  unit: responseType === 'NUMBER' ? unit.trim() || null : null,
                  followUpOn: (followUpOn || null) as
                    | 'NO'
                    | 'NO_OR_PARTIAL'
                    | 'OUT_OF_RANGE'
                    | null,
                  ...(responseType === 'TEMPERATURE'
                    ? {
                        tempLabel: tempLabel.trim() || null,
                        tempMin: tempMin.trim() === '' ? null : Number(tempMin),
                        tempMax: tempMax.trim() === '' ? null : Number(tempMax),
                      }
                    : {}),
                });
                toast.success('Task updated — future shifts pick it up.');
                onSaved();
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Could not save.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewTemplateDialog({
  open,
  onOpenChange,
  departments,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  departments: string[];
  onCreated: (templateId: string) => void;
}) {
  const [name, setName] = useState('');
  const [department, setDepartment] = useState(departments[0] ?? '');
  const [period, setPeriod] = useState<OpsPeriod>('MORNING');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setDepartment(departments[0] ?? '');
      setPeriod('MORNING');
    }
  }, [open, departments]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New SOP</DialogTitle>
          <DialogDescription>
            A reusable checklist for one department and shift period. Add its
            tasks after creating.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Frozen & Dairy — Holiday surge"
              autoFocus
            />
          </div>
          <div>
            <Label className="text-xs">Department</Label>
            <Select value={department} onChange={(e) => setDepartment(e.target.value)}>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label className="text-xs">Shift period</Label>
            <Select value={period} onChange={(e) => setPeriod(e.target.value as OpsPeriod)}>
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            loading={busy}
            disabled={!name.trim() || !department}
            onClick={async () => {
              setBusy(true);
              try {
                const created = await createOpsTemplate({
                  name: name.trim(),
                  department,
                  period,
                });
                toast.success('SOP created — add its tasks.');
                onOpenChange(false);
                onCreated(created.id);
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Could not create.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Create SOP
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
