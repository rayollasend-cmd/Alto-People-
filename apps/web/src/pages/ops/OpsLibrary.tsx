import { useCallback, useEffect, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
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
  patchOpsTemplate,
  type OpsLibraryTemplate,
  type OpsPeriod,
  type OpsResponseType,
} from '@/lib/opsApi';

/**
 * The SOP standard, editable by leadership only (operations, HR admin,
 * the chairman). Supervisors run these; they never edit them. "Delete"
 * on a template is a retire — every already-run shift keeps its
 * checklist exactly as executed.
 */

const PERIODS: { value: OpsPeriod; label: string }[] = [
  { value: 'MORNING', label: 'Morning / opening' },
  { value: 'EVENING', label: 'Evening / recovery' },
  { value: 'CLOSING', label: 'Closing' },
  { value: 'OVERNIGHT', label: 'Overnight' },
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

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!library) return <Skeleton className="h-64" />;

  const byDepartment = new Map<string, OpsLibraryTemplate[]>();
  for (const tpl of library.templates) {
    const list = byDepartment.get(tpl.department) ?? [];
    list.push(tpl);
    byDepartment.set(tpl.department, list);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-silver/70 max-w-prose">
          The standard your supervisors run. Edits apply to <em>future</em> shifts
          only — every shift already run keeps its checklist exactly as executed,
          so the record stays honest.
        </p>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New SOP
        </Button>
      </div>

      {[...byDepartment.entries()].map(([department, templates]) => (
        <Card key={department}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              <BookOpen className="mr-2 inline h-4 w-4 text-gold" aria-hidden="true" />
              {department}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {templates.map((tpl) => {
              const isOpen = expanded.has(tpl.id);
              return (
                <div key={tpl.id} className="rounded-md border border-navy-secondary">
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
                      className="flex min-w-0 items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-silver/60" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-silver/60" />
                      )}
                      <span className="truncate text-sm text-white">{tpl.name}</span>
                      <Badge variant="default">
                        {PERIODS.find((p) => p.value === tpl.period)?.label ?? tpl.period}
                      </Badge>
                      <span className="text-2xs text-silver/60 tabular-nums">
                        {tpl.taskCount} task{tpl.taskCount === 1 ? '' : 's'}
                      </span>
                    </button>
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
                            err instanceof ApiError ? err.message : 'Could not retire.',
                          );
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Retire
                    </Button>
                  </div>
                  {isOpen && <TemplateTasks tpl={tpl} onChanged={load} />}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      <NewTemplateDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        departments={library.departments}
        onCreated={load}
      />
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

  const sections = [...new Set(tpl.tasks.map((t) => t.section))];

  return (
    <div className="border-t border-navy-secondary p-3 space-y-3">
      {sections.map((sec) => (
        <div key={sec}>
          <div className="text-2xs uppercase tracking-wider text-silver/60">{sec}</div>
          <ul className="mt-1 space-y-1">
            {tpl.tasks
              .filter((t) => t.section === sec)
              .map((task) => (
                <li
                  key={task.id}
                  className="flex items-center justify-between gap-2 rounded bg-navy-secondary/20 px-2 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate text-white">
                    {task.title}
                    <span className="ml-2 text-2xs text-silver/60">
                      {RESPONSE_TYPES.find((r) => r.value === task.responseType)?.label}
                      {task.responseType === 'TEMPERATURE' &&
                        task.tempMin != null &&
                        task.tempMax != null && (
                          <span className="tabular-nums">
                            {' '}
                            {task.tempMin}–{task.tempMax}°F
                          </span>
                        )}
                      {task.photoRequired && ' · photo'}
                      {!task.required && ' · optional'}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-silver/40 hover:text-alert"
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
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}

      {/* Add-task composer. */}
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-navy-secondary bg-navy-secondary/20 p-2">
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

function NewTemplateDialog({
  open,
  onOpenChange,
  departments,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  departments: string[];
  onCreated: () => void;
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
                await createOpsTemplate({ name: name.trim(), department, period });
                toast.success('SOP created — add its tasks.');
                onOpenChange(false);
                onCreated();
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
