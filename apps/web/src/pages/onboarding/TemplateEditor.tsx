import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  ClientSummary,
  OnboardingTemplate,
  OnboardingTrack,
  TaskKind,
  TemplateTaskInput,
  TemplateUpsertInput,
} from '@alto-people/shared';
import {
  createTemplate,
  listClients,
  listTemplates,
  updateTemplate,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

const TEXTAREA_CX =
  'w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm ' +
  'focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold';

const TRACK_OPTIONS: Array<{ value: OnboardingTrack; label: string }> = [
  { value: 'STANDARD', label: 'Standard' },
  { value: 'J1', label: 'J-1' },
  { value: 'CLIENT_SPECIFIC', label: 'Client-specific' },
];

const TASK_KIND_OPTIONS: Array<{ value: TaskKind; label: string }> = [
  { value: 'PROFILE_INFO', label: 'Profile information' },
  { value: 'DOCUMENT_UPLOAD', label: 'Document upload' },
  { value: 'E_SIGN', label: 'E-signature' },
  { value: 'BACKGROUND_CHECK', label: 'Background check' },
  { value: 'W4', label: 'W-4 tax withholding' },
  { value: 'DIRECT_DEPOSIT', label: 'Direct deposit' },
  { value: 'POLICY_ACK', label: 'Policy acknowledgment' },
  { value: 'J1_DOCS', label: 'J-1 documents' },
  { value: 'I9_VERIFICATION', label: 'I-9 verification' },
];

interface DraftTask extends TemplateTaskInput {
  // Local-only key for stable React iteration during reorder. Not sent
  // to the server — server assigns real ids.
  _key: string;
}

const blankTask = (): DraftTask => ({
  _key: `t_${Math.random().toString(36).slice(2, 10)}`,
  kind: 'PROFILE_INFO',
  title: 'Profile information',
  description: '',
});

export function TemplateEditor() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';

  const { can } = useAuth();
  const canManage = can('manage:onboarding');

  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [loadedTemplate, setLoadedTemplate] = useState<OnboardingTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [track, setTrack] = useState<OnboardingTrack>('STANDARD');
  const [clientId, setClientId] = useState<string>(''); // '' = global
  const [tasks, setTasks] = useState<DraftTask[]>([blankTask()]);
  const [saving, setSaving] = useState(false);

  // Load clients (always) + template (when editing) on mount.
  useEffect(() => {
    let cancelled = false;
    listClients()
      .then((r) => !cancelled && setClients(r.clients))
      .catch(() => !cancelled && setClients([]));
    if (!isNew && id) {
      // No GET /templates/:id endpoint — list and pick. Cheap; only HR
      // hits this and templates are tens, not thousands.
      listTemplates()
        .then((r) => {
          if (cancelled) return;
          const t = r.templates.find((x) => x.id === id);
          if (!t) {
            setError('Template not found');
            return;
          }
          setLoadedTemplate(t);
          setName(t.name);
          setTrack(t.track);
          setClientId(t.clientId ?? '');
          setTasks(
            t.tasks.map((tk) => ({
              _key: tk.id,
              kind: tk.kind,
              title: tk.title,
              description: tk.description ?? '',
              order: tk.order,
            }))
          );
        })
        .catch((err) =>
          !cancelled &&
          setError(err instanceof ApiError ? err.message : 'Failed to load.')
        );
    }
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  const updateTask = (i: number, patch: Partial<DraftTask>) => {
    setTasks((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  };

  const moveTask = (i: number, dir: -1 | 1) => {
    setTasks((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const removeTask = (i: number) => {
    setTasks((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  };

  const addTask = () => {
    setTasks((prev) => [...prev, blankTask()]);
  };

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Template name is required');
      return;
    }
    if (track === 'CLIENT_SPECIFIC' && !clientId) {
      toast.error('Client-specific templates need a client');
      return;
    }
    if (tasks.length === 0) {
      toast.error('At least one task is required');
      return;
    }
    if (tasks.some((t) => !t.title.trim())) {
      toast.error('Every task needs a title');
      return;
    }
    setSaving(true);
    try {
      const body: TemplateUpsertInput = {
        name: name.trim(),
        track,
        clientId: clientId || null,
        tasks: tasks.map((t, i) => ({
          kind: t.kind,
          title: t.title.trim(),
          description: t.description?.trim() || null,
          order: i,
        })),
      };
      if (isNew) {
        const created = await createTemplate(body);
        toast.success(`Created "${created.name}"`);
        navigate('/onboarding/templates');
      } else if (id) {
        await updateTemplate(id, body);
        toast.success(`Saved "${body.name}"`);
        navigate('/onboarding/templates');
      }
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Save failed';
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'template_track_taken') {
        toast.error('Track already used', { description: msg });
      } else {
        toast.error('Could not save', { description: msg });
      }
    } finally {
      setSaving(false);
    }
  };

  if (!canManage) {
    return (
      <div className="max-w-3xl mx-auto">
        <ErrorBanner>
          You don't have permission to manage onboarding templates.
        </ErrorBanner>
      </div>
    );
  }

  if (!isNew && !loadedTemplate && !error) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-4">
        <Link
          to="/onboarding/templates"
          className="text-sm text-silver hover:text-gold inline-block"
        >
          ← Templates
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="font-display text-3xl md:text-4xl text-white mb-1.5 leading-tight">
          {isNew ? 'New onboarding template' : `Edit: ${loadedTemplate?.name ?? '…'}`}
        </h1>
        <p className="text-silver text-sm">
          The task list HR picks from when inviting an associate. Order here is
          the order the associate sees.
        </p>
      </header>

      {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

      <Card className="p-5 mb-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Name" required>
            {(p) => (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Standard restaurant onboarding"
                maxLength={80}
                autoFocus
                {...p}
              />
            )}
          </Field>
          <Field
            label="Track"
            required
            hint="One template per (client, track) pair. STANDARD/J-1 are usually global; CLIENT_SPECIFIC always needs a client."
          >
            {(p) => (
              <Select
                value={track}
                onChange={(e) => setTrack(e.target.value as OnboardingTrack)}
                {...p}
              >
                {TRACK_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Client"
            required={track === 'CLIENT_SPECIFIC'}
            className="md:col-span-2"
          >
            {(p) => (
              <Select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={clients === null}
                {...p}
              >
                <option value="">{clients === null ? 'Loading…' : 'Global (all clients)'}</option>
                {clients?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.state ? ` · ${c.state}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-silver">
          Checklist tasks{' '}
          <span className="ml-1 tabular-nums text-silver/60">{tasks.length}</span>
        </h2>
        <Button variant="secondary" size="sm" onClick={addTask}>
          <Plus className="h-3.5 w-3.5" />
          Add task
        </Button>
      </div>

      <div className="space-y-2.5 mb-6">
        {tasks.map((t, i) => (
          <Card key={t._key} className="p-3">
            <div className="flex items-start gap-2.5">
              <div className="flex flex-col items-center pt-1.5 text-silver/60">
                <button
                  type="button"
                  onClick={() => moveTask(i, -1)}
                  disabled={i === 0}
                  className="hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Move task up"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <GripVertical className="h-3 w-3 my-0.5 opacity-50" />
                <button
                  type="button"
                  onClick={() => moveTask(i, 1)}
                  disabled={i === tasks.length - 1}
                  className="hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Move task down"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <Field label="Kind">
                  {(p) => (
                    <Select
                      value={t.kind}
                      onChange={(e) =>
                        updateTask(i, { kind: e.target.value as TaskKind })
                      }
                      {...p}
                    >
                      {TASK_KIND_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Title" required>
                  {(p) => (
                    <Input
                      value={t.title}
                      onChange={(e) => updateTask(i, { title: e.target.value })}
                      maxLength={120}
                      {...p}
                    />
                  )}
                </Field>
                <Field label="Description" className="md:col-span-2">
                  {(p) => (
                    <textarea
                      value={t.description ?? ''}
                      onChange={(e) => updateTask(i, { description: e.target.value })}
                      rows={2}
                      maxLength={500}
                      className={TEXTAREA_CX}
                      placeholder="What the associate should know about this step (optional)"
                      {...p}
                    />
                  )}
                </Field>
              </div>
              <button
                type="button"
                onClick={() => removeTask(i)}
                disabled={tasks.length === 1}
                className="text-alert hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed pt-1.5"
                aria-label="Remove task"
                title={
                  tasks.length === 1
                    ? "A template needs at least one task"
                    : "Remove task"
                }
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </Card>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2 sticky bottom-0 -mx-2 px-2 py-3 bg-navy/90 backdrop-blur border-t border-navy-secondary">
        <Link to="/onboarding/templates">
          <Button variant="ghost">
            <X className="h-4 w-4" />
            Cancel
          </Button>
        </Link>
        <Button onClick={submit} loading={saving}>
          <Save className="h-4 w-4" />
          {isNew ? 'Create template' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
