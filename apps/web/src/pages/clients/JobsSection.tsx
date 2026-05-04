import { useCallback, useEffect, useState } from 'react';
import { Briefcase, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Job } from '@alto-people/shared';
import { createJob, deleteJob, listJobs, updateJob } from '@/lib/jobsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
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
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

const fmtRate = (n: number | null) =>
  n === null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

interface Props {
  clientId: string;
}

/**
 * Phase 37 — per-client job catalog. Jobs carry default billRate (revenue)
 * and payRate (cost) that shifts inherit when not overridden. Visibility:
 * anyone in /clients can see; mutation requires manage:scheduling (same
 * capability as creating shifts, since these data drive shift defaults).
 */
export function JobsSection({ clientId }: Props) {
  const { can } = useAuth();
  const canManage = can('manage:scheduling');

  const [items, setItems] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);

  const [editing, setEditing] = useState<Job | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listJobs({ clientId, includeInactive });
      setItems(res.jobs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load jobs.');
    }
  }, [clientId, includeInactive]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onArchive = async (job: Job) => {
    setBusy(true);
    try {
      await deleteJob(job.id);
      toast.success(`Archived ${job.name}`);
      setConfirmDelete(null);
      refresh();
    } catch (err) {
      toast.error('Could not archive', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-gold" />
              Jobs
            </CardTitle>
            <CardDescription>
              Per-client job types with default bill (revenue) and pay (cost)
              rates. Shifts inherit these unless overridden.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label className="text-xs text-silver inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="rounded border-navy-secondary"
              />
              Show archived
            </label>
            {canManage && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                New job
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error && <ErrorBanner className="m-4">{error}</ErrorBanner>}
        {!items && (
          <div className="p-4 space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {items && items.length === 0 && (
          <p className="text-sm text-silver p-6 text-center">
            No jobs configured for this client.
            {canManage && ' Click "New job" to add the first.'}
          </p>
        )}
        {items && items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Bill rate</TableHead>
                <TableHead className="text-right">Pay rate</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="text-white">{j.name}</TableCell>
                  <TableCell className="text-right tabular-nums text-silver">
                    {fmtRate(j.billRate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-silver">
                    {fmtRate(j.payRate)}
                  </TableCell>
                  <TableCell>
                    {j.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="outline">Archived</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(j)}
                          aria-label="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {j.isActive && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDelete(j)}
                            aria-label="Archive"
                          >
                            <Trash2 className="h-4 w-4 text-alert" />
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <JobDialog
        open={creating || editing !== null}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(false);
            setEditing(null);
          }
        }}
        clientId={clientId}
        existing={editing}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          refresh();
        }}
      />

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(v) => !v && setConfirmDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive this job?</DialogTitle>
            <DialogDescription>
              {confirmDelete && (
                <>
                  Archiving <strong className="text-white">{confirmDelete.name}</strong>{' '}
                  hides it from new shift creation but preserves history on
                  existing shifts and time entries.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => confirmDelete && onArchive(confirmDelete)}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface JobDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clientId: string;
  existing: Job | null;
  onSaved: () => void;
}

function JobDialog({ open, onOpenChange, clientId, existing, onSaved }: JobDialogProps) {
  const [name, setName] = useState(existing?.name ?? '');
  const [billRate, setBillRate] = useState(existing?.billRate?.toString() ?? '');
  const [payRate, setPayRate] = useState(existing?.payRate?.toString() ?? '');
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed when the dialog opens for a different job (or for a new one).
  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? '');
    setBillRate(existing?.billRate?.toString() ?? '');
    setPayRate(existing?.payRate?.toString() ?? '');
    setIsActive(existing?.isActive ?? true);
  }, [open, existing]);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast.error('Name is required');
      return;
    }
    const billN = billRate.trim() ? Number(billRate) : null;
    const payN = payRate.trim() ? Number(payRate) : null;
    if (billN !== null && !Number.isFinite(billN)) {
      toast.error('Bill rate must be numeric');
      return;
    }
    if (payN !== null && !Number.isFinite(payN)) {
      toast.error('Pay rate must be numeric');
      return;
    }

    setSubmitting(true);
    try {
      if (existing) {
        await updateJob(existing.id, {
          name: trimmed,
          billRate: billN,
          payRate: payN,
          isActive,
        });
        toast.success('Job updated');
      } else {
        await createJob({
          clientId,
          name: trimmed,
          // Create-input schema is `optional` (omit, not null); skip the
          // field entirely when the user left the input blank.
          ...(billN !== null ? { billRate: billN } : {}),
          ...(payN !== null ? { payRate: payN } : {}),
        });
        toast.success('Job created');
      }
      onSaved();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'job_name_taken') {
        toast.error('A job with that name already exists for this client');
      } else {
        toast.error('Could not save', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit job' : 'New job'}</DialogTitle>
          <DialogDescription>
            Defaults that shifts inherit. Override per-shift when needed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name" required>
            {(p) => (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Server, Bartender, Housekeeper…"
                autoFocus
                {...p}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bill rate (USD/hr)" hint="What the client is invoiced.">
              {(p) => (
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={billRate}
                  onChange={(e) => setBillRate(e.target.value)}
                  placeholder="35.00"
                  {...p}
                />
              )}
            </Field>
            <Field label="Pay rate (USD/hr)" hint="What the associate is paid.">
              {(p) => (
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={payRate}
                  onChange={(e) => setPayRate(e.target.value)}
                  placeholder="22.00"
                  {...p}
                />
              )}
            </Field>
          </div>
          {existing && (
            <label className="text-sm text-silver inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="rounded border-navy-secondary"
              />
              Active (uncheck to hide from new shifts)
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            {existing ? 'Save changes' : 'Create job'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
