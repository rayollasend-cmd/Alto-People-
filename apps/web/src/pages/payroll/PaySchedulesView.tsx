// Wave 1.1 — Pay schedules management UI.
//
// HR/finance creates and edits the schedules the Run-payroll wizard pulls
// from. Each schedule shows its computed "next period" + "next pay date"
// so finance can see at a glance which payroll is up next.

import { useCallback, useEffect, useState } from 'react';
import { Calendar, Pencil, Plus, Trash2, Users } from 'lucide-react';
import type {
  PayrollFrequency,
  PayrollSchedule,
} from '@alto-people/shared';
import {
  createPayrollSchedule,
  deletePayrollSchedule,
  listPayrollSchedules,
  updatePayrollSchedule,
} from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
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
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';

const FREQ_LABEL: Record<PayrollFrequency, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Biweekly',
  SEMIMONTHLY: 'Semi-monthly',
  MONTHLY: 'Monthly',
};

const FREQ_HINT: Record<PayrollFrequency, string> = {
  WEEKLY: '52 pay periods/year',
  BIWEEKLY: '26 pay periods/year',
  SEMIMONTHLY: '24 pay periods/year (1st & 16th)',
  MONTHLY: '12 pay periods/year',
};

interface Props {
  canProcess: boolean;
}

export function PaySchedulesView({ canProcess }: Props) {
  const [schedules, setSchedules] = useState<PayrollSchedule[] | null>(null);
  const [editing, setEditing] = useState<PayrollSchedule | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PayrollSchedule | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await listPayrollSchedules({ includeInactive });
      setSchedules(res.schedules);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load schedules.');
    }
  }, [includeInactive]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deletePayrollSchedule(confirmDelete.id);
      toast.success('Schedule deleted.');
      setConfirmDelete(null);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Delete failed.');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-2 text-xs text-silver/70">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="accent-gold"
            />
            Show inactive
          </label>
        </div>
        {canProcess && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New schedule
          </Button>
        )}
      </div>

      {!schedules && (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      )}

      {schedules && schedules.length === 0 && (
        <EmptyState
          icon={Calendar}
          title="No pay schedules yet"
          description={
            canProcess
              ? 'Create one to anchor your pay periods. The Run-payroll wizard pulls its "next period" suggestion from here.'
              : 'No pay schedules have been defined yet.'
          }
          action={
            canProcess ? (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                Create first schedule
              </Button>
            ) : undefined
          }
        />
      )}

      {schedules && schedules.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {schedules.map((s) => (
            <Card key={s.id} className={cn(!s.isActive && 'opacity-60')}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
                <div className="min-w-0">
                  <CardTitle className="text-base truncate">{s.name}</CardTitle>
                  <div className="text-xs text-silver/60 mt-0.5">
                    {FREQ_LABEL[s.frequency]} · {FREQ_HINT[s.frequency]}
                  </div>
                </div>
                {canProcess && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" onClick={() => setEditing(s)} title="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setConfirmDelete(s)}
                      title="Delete"
                      disabled={s.associateCount > 0}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <MetaRow label="Scope">
                  {s.clientName ?? (
                    <span className="text-silver/80 italic">All clients</span>
                  )}
                </MetaRow>
                <MetaRow label="Anchor date">{s.anchorDate}</MetaRow>
                <MetaRow label="Next period">
                  {s.nextPeriodStart} → {s.nextPeriodEnd}
                </MetaRow>
                <MetaRow label="Next pay date">
                  <span className="text-gold">{s.nextPayDate}</span>
                  <span className="text-silver/50 ml-1">
                    (+{s.payDateOffsetDays}d after period end)
                  </span>
                </MetaRow>
                <MetaRow label="Assigned associates">
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {s.associateCount}
                  </span>
                </MetaRow>
                {!s.isActive && (
                  <div className="text-[10px] uppercase tracking-widest text-silver/40 mt-2">
                    Inactive
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ScheduleFormDialog
        open={creating || !!editing}
        existing={editing}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(false);
            setEditing(null);
          }
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          refresh();
        }}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(v) => !v && setConfirmDelete(null)}
        title={`Delete "${confirmDelete?.name}"?`}
        description="This soft-deletes the schedule. Past payroll runs are unaffected; future runs won't see it as an option."
        confirmLabel="Delete"
        destructive
        onConfirm={onDelete}
      />
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-silver/50 text-[10px] uppercase tracking-widest">{label}</span>
      <span className="text-silver tabular-nums">{children}</span>
    </div>
  );
}

function ScheduleFormDialog({
  open,
  existing,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  existing: PayrollSchedule | null;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [frequency, setFrequency] = useState<PayrollFrequency>('BIWEEKLY');
  const [anchorDate, setAnchorDate] = useState('');
  const [payOffset, setPayOffset] = useState('5');
  const [notes, setNotes] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (existing) {
      setName(existing.name);
      setFrequency(existing.frequency);
      setAnchorDate(existing.anchorDate);
      setPayOffset(String(existing.payDateOffsetDays));
      setNotes(existing.notes ?? '');
      setIsActive(existing.isActive);
    } else {
      setName('');
      setFrequency('BIWEEKLY');
      setAnchorDate(new Date().toISOString().slice(0, 10));
      setPayOffset('5');
      setNotes('');
      setIsActive(true);
    }
    setSubmitting(false);
  }, [open, existing]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      if (existing) {
        await updatePayrollSchedule(existing.id, {
          name,
          frequency,
          anchorDate,
          payDateOffsetDays: Number(payOffset) || 0,
          isActive,
          notes: notes || null,
        });
        toast.success('Schedule updated.');
      } else {
        await createPayrollSchedule({
          name,
          frequency,
          anchorDate,
          payDateOffsetDays: Number(payOffset) || 0,
          notes: notes || undefined,
        });
        toast.success('Schedule created.');
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit pay schedule' : 'New pay schedule'}</DialogTitle>
          <DialogDescription>
            Drives the wizard's "next period" suggestion and FIT annualization.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Name" required>
            {(p) => (
              <Input
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Hourly biweekly"
                {...p}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Frequency" required hint={FREQ_HINT[frequency]}>
              {(p) => (
                <Select
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as PayrollFrequency)}
                  {...p}
                >
                  {(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY'] as PayrollFrequency[]).map((f) => (
                    <option key={f} value={f}>{FREQ_LABEL[f]}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Anchor date"
              required
              hint="For weekly/biweekly: any date inside the first period. For semi-monthly/monthly: just used as a tiebreaker."
            >
              {(p) => (
                <Input
                  type="date"
                  value={anchorDate}
                  onChange={(e) => setAnchorDate(e.target.value)}
                  {...p}
                />
              )}
            </Field>
          </div>
          <Field label="Pay date offset (days after period end)">
            {(p) => (
              <Input
                type="number"
                min={0}
                max={31}
                value={payOffset}
                onChange={(e) => setPayOffset(e.target.value)}
                {...p}
              />
            )}
          </Field>
          <Field label="Notes">
            {(p) => (
              <Textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                {...p}
              />
            )}
          </Field>
          {existing && (
            <label className="inline-flex items-center gap-2 text-sm text-silver">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="accent-gold"
              />
              Active (uncheck to hide from the run wizard without deleting)
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {existing ? 'Save' : 'Create schedule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
