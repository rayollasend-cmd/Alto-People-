import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, FileSignature, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { ChecklistTask } from '@alto-people/shared';
import {
  createEsignAgreement,
  listEsignAgreements,
  type EsignAgreement,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

interface Props {
  applicationId: string;
  canManage: boolean;
  /** Used to populate the "attach to task" picker. */
  esignTasks: ChecklistTask[];
}

/**
 * Phase 36 — HR-side composer + listing for Phase 19 e-sign agreements.
 * One section on ApplicationDetail. HR drafts an agreement (title + body
 * with optional E_SIGN-task link); the associate signs it via the
 * existing /onboarding/me/.../tasks/e_sign flow.
 */
export function EsignSection({ applicationId, canManage, esignTasks }: Props) {
  const [items, setItems] = useState<EsignAgreement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCreate, setOpenCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listEsignAgreements(applicationId);
      setItems(res.agreements);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load.');
    }
  }, [applicationId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileSignature className="h-4 w-4 text-gold" />
              E-signatures
            </CardTitle>
            <CardDescription>
              Drafted by HR, signed by the associate. Each signature renders an
              audit-stamped PDF stored in the document vault.
            </CardDescription>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setOpenCreate(true)}>
              <Plus className="h-4 w-4" />
              New agreement
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
        {!items && (
          <div className="space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {items && items.length === 0 && (
          <p className="text-sm text-silver">
            No agreements yet.
            {canManage && ' Click "New agreement" to draft one.'}
          </p>
        )}
        {items && items.length > 0 && (
          <ul className="divide-y divide-navy-secondary/60 -my-2">
            {items.map((a) => (
              <li key={a.id} className="py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate font-medium">
                    {a.title}
                  </div>
                  <div className="text-xs text-silver/70 mt-0.5">
                    Drafted {new Date(a.createdAt).toLocaleDateString()}
                    {a.taskId && ' · linked to a checklist task'}
                  </div>
                </div>
                {a.signedAt ? (
                  <span className="inline-flex items-center gap-1 text-xs text-success">
                    <CheckCircle2 className="h-3 w-3" />
                    Signed {new Date(a.signedAt).toLocaleDateString()}
                  </span>
                ) : (
                  <span className="text-xs text-silver/70">Awaiting signature</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <CreateAgreementDialog
        open={openCreate}
        onOpenChange={setOpenCreate}
        applicationId={applicationId}
        esignTasks={esignTasks}
        onCreated={() => {
          setOpenCreate(false);
          refresh();
        }}
      />
    </Card>
  );
}

interface CreateProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  applicationId: string;
  esignTasks: ChecklistTask[];
  onCreated: () => void;
}

function CreateAgreementDialog({
  open,
  onOpenChange,
  applicationId,
  esignTasks,
  onCreated,
}: CreateProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [taskId, setTaskId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setTitle('');
    setBody('');
    setTaskId('');
  };

  const submit = async () => {
    const t = title.trim();
    const b = body.trim();
    if (t.length === 0 || b.length === 0) {
      toast.error('Title and body are required');
      return;
    }
    setSubmitting(true);
    try {
      await createEsignAgreement(applicationId, {
        title: t,
        body: b,
        taskId: taskId || null,
      });
      toast.success('Agreement drafted — associate can now sign');
      reset();
      onCreated();
    } catch (err) {
      toast.error('Could not create', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Only show E_SIGN tasks that don't already have an agreement linked? We
  // can't tell from here without joining; keep it simple — just list them.
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Draft a new agreement</DialogTitle>
          <DialogDescription>
            The associate sees and signs this in their onboarding flow. The
            signed PDF is stamped with their typed name, IP, UA, and a
            content hash.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Title" required>
            {(p) => (
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="Housing Agreement, Confidentiality Addendum, etc."
                autoFocus
                {...p}
              />
            )}
          </Field>

          {esignTasks.length > 0 && (
            <Field
              label="Link to checklist task (optional)"
              hint="When linked, signing the agreement also marks the checklist task DONE."
            >
              {(p) => (
                <Select
                  value={taskId}
                  onChange={(e) => setTaskId(e.target.value)}
                  {...p}
                >
                  <option value="">— Standalone (no task link) —</option>
                  {esignTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} {t.status === 'DONE' ? '(already done)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <Field
            label="Body"
            required
            hint="Up to 50,000 chars. Renders in the PDF exactly as typed."
          >
            {(p) => (
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={50_000}
                rows={10}
                placeholder="Paste the full agreement text. Plain text — line breaks are preserved."
                {...p}
              />
            )}
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            Draft agreement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
