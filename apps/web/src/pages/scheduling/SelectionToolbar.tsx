import { useState } from 'react';
import {
  CalendarRange,
  CheckCircle2,
  Copy as CopyIcon,
  Send,
  Trash,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import type { Shift } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import {
  assignShift,
  cancelShift,
  createShift,
  deleteShift,
  unassignShift,
  updateShift,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { toast } from '@/components/ui/Toaster';
import { useConfirm } from '@/lib/confirm';

/** Same instant N calendar days later — setDate keeps wall-clock across DST. */
function plusDaysIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/**
 * Floating action bar that appears when one or more chips are selected.
 *
 * Bulk operations run as sequential per-shift API calls (no batched
 * endpoint in v1) so individual failures don't tank the whole batch —
 * we collect successes and failures, then surface a single summary toast.
 *
 * Publish here is restricted to DRAFT shifts: the per-shift PATCH path
 * goes through the same publish gate as `/scheduling/publish-week` minus
 * the predictive-scheduling guard, so we mirror the manager intent
 * ("flip these N drafts to live") without bypassing fair-workweek.
 */
interface Props {
  selected: Shift[];
  onClear: () => void;
  onAfterAction: () => Promise<void> | void;
}

export function SelectionToolbar({ selected, onClear, onAfterAction }: Props) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState<
    null | 'publish' | 'cancel' | 'unassign' | 'duplicate' | 'delete' | 'reassign' | 'move'
  >(null);
  // Small popover panels above the bar.
  const [panel, setPanel] = useState<null | 'reassign' | 'move'>(null);
  const [reassignTo, setReassignTo] = useState<PickedAssociate | null>(null);
  const [moveDays, setMoveDays] = useState('7');

  if (selected.length === 0) return null;

  const draftCount = selected.filter((s) => s.status === 'DRAFT').length;
  const cancellableCount = selected.filter(
    (s) => s.status !== 'CANCELLED' && s.status !== 'COMPLETED',
  ).length;
  const assignedCount = selected.filter((s) => s.assignedAssociateId !== null).length;

  const runBatch = async <T,>(
    action: (s: Shift) => Promise<T>,
    label: string,
  ): Promise<void> => {
    let ok = 0;
    let fail = 0;
    const failures: string[] = [];
    for (const s of selected) {
      try {
        await action(s);
        ok += 1;
      } catch (err) {
        fail += 1;
        if (failures.length < 3) {
          failures.push(err instanceof ApiError ? err.message : 'Unknown error');
        }
      }
    }
    if (ok > 0 && fail === 0) {
      toast.success(`${label} ${ok} shift${ok === 1 ? '' : 's'}.`);
    } else if (ok > 0 && fail > 0) {
      toast.error(
        `${label} ${ok} succeeded, ${fail} failed${failures.length > 0 ? ` — ${failures[0]}` : ''}.`,
      );
    } else {
      toast.error(`${label} failed${failures.length > 0 ? ` — ${failures[0]}` : ''}.`);
    }
    onClear();
    await onAfterAction();
  };

  const onPublish = async () => {
    if (draftCount === 0) {
      toast.error('No draft shifts in selection.');
      return;
    }
    const ok = await confirm({
      title: `Publish ${draftCount} draft shift${draftCount === 1 ? '' : 's'}?`,
      description:
        'Assigned associates will be notified. Predictive-schedule violations will fail individually.',
      confirmLabel: 'Publish',
    });
    if (!ok) return;
    setBusy('publish');
    try {
      // Filter to DRAFT only — non-drafts pass through as no-ops. The
      // API auto-stamps publishedAt on the DRAFT → OPEN/ASSIGNED transition
      // (see isPublishingTransition in routes/scheduling.ts).
      await runBatch<Shift>(async (s) => {
        if (s.status !== 'DRAFT') return s;
        const next = s.assignedAssociateId ? 'ASSIGNED' : 'OPEN';
        return updateShift(s.id, { status: next });
      }, 'Published');
    } finally {
      setBusy(null);
    }
  };

  const onCancel = async () => {
    const ok = await confirm({
      title: `Cancel ${cancellableCount} shift${cancellableCount === 1 ? '' : 's'}?`,
      description: 'This will notify assigned associates. Cannot be undone.',
      confirmLabel: 'Cancel shifts',
    });
    if (!ok) return;
    setBusy('cancel');
    try {
      await runBatch<Shift>(async (s) => {
        if (s.status === 'CANCELLED' || s.status === 'COMPLETED') return s;
        return cancelShift(s.id, { reason: 'Bulk cancel' });
      }, 'Cancelled');
    } finally {
      setBusy(null);
    }
  };

  const onUnassign = async () => {
    setBusy('unassign');
    try {
      await runBatch<Shift>(async (s) => {
        if (s.assignedAssociateId === null) return s;
        return unassignShift(s.id);
      }, 'Unassigned');
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    const assignedNote = assignedCount > 0
      ? ` ${assignedCount} ${assignedCount === 1 ? 'is' : 'are'} assigned and will be removed from employees’ schedules.`
      : '';
    const ok = await confirm({
      title: `Delete ${selected.length} shift${selected.length === 1 ? '' : 's'}?`,
      description: `Permanently delete the selected shift${selected.length === 1 ? '' : 's'}. This can’t be undone.${assignedNote}`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await runBatch<void>(async (s) => {
        await deleteShift(s.id);
      }, 'Deleted');
    } finally {
      setBusy(null);
    }
  };

  const onDuplicate = async () => {
    setBusy('duplicate');
    try {
      // Copies land ONE WEEK LATER — an exact same-time twin on the same
      // day is almost never the intent and just double-books the slot.
      // locationId carries over so copies keep their geofence + filters.
      await runBatch<Shift>(async (s) => {
        return createShift({
          clientId: s.clientId,
          position: s.position,
          startsAt: plusDaysIso(s.startsAt, 7),
          endsAt: plusDaysIso(s.endsAt, 7),
          ...(s.locationId ? { locationId: s.locationId } : {}),
          ...(s.location ? { location: s.location } : {}),
          ...(s.hourlyRate != null ? { hourlyRate: s.hourlyRate } : {}),
          ...(s.payRate != null ? { payRate: s.payRate } : {}),
          ...(s.notes ? { notes: s.notes } : {}),
        });
      }, 'Duplicated into next week:');
    } finally {
      setBusy(null);
    }
  };

  const onReassign = async () => {
    if (!reassignTo) return;
    setBusy('reassign');
    try {
      await runBatch<Shift>(async (s) => {
        if (s.status === 'CANCELLED' || s.status === 'COMPLETED') return s;
        return assignShift(s.id, { associateId: reassignTo.id });
      }, `Assigned to ${reassignTo.name}:`);
      setPanel(null);
      setReassignTo(null);
    } finally {
      setBusy(null);
    }
  };

  const onMove = async () => {
    const days = Math.trunc(Number(moveDays));
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 90) {
      toast.error('Enter a day offset between -90 and 90 (not 0).');
      return;
    }
    setBusy('move');
    try {
      await runBatch<Shift>(async (s) => {
        if (s.status === 'CANCELLED' || s.status === 'COMPLETED') return s;
        return updateShift(s.id, {
          startsAt: plusDaysIso(s.startsAt, days),
          endsAt: plusDaysIso(s.endsAt, days),
        });
      }, `Moved ${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'}:`);
      setPanel(null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-40 no-print bottom-[max(1.5rem,calc(env(safe-area-inset-bottom)+0.5rem))]">
      {panel === 'reassign' && (
        <div className="mb-2 rounded-lg bg-navy border border-navy-secondary elev-3 p-3 w-80">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-silver">
            Assign all {selected.length} to
          </div>
          <AssociatePicker value={reassignTo} onChange={setReassignTo} />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPanel(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onReassign}
              loading={busy === 'reassign'}
              disabled={!reassignTo || busy !== null}
            >
              Assign
            </Button>
          </div>
        </div>
      )}
      {panel === 'move' && (
        <div className="mb-2 rounded-lg bg-navy border border-navy-secondary elev-3 p-3 w-72">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-silver">
            Move all {selected.length} by (days)
          </div>
          <Input
            type="number"
            min={-90}
            max={90}
            step={1}
            value={moveDays}
            onChange={(e) => setMoveDays(e.target.value)}
            aria-label="Days to move by (negative = earlier)"
          />
          <p className="mt-1 text-[10px] text-silver/60">
            7 = one week later, -1 = a day earlier. Times stay the same.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPanel(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={onMove} loading={busy === 'move'} disabled={busy !== null}>
              Move
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-navy border border-gold/40 elev-3">
        <CheckCircle2 className="h-4 w-4 text-gold" />
        <span className="text-sm text-white tabular-nums">
          {selected.length} selected
        </span>
        <span className="text-silver/70">·</span>
        <Button
          variant="primary"
          onClick={onPublish}
          loading={busy === 'publish'}
          disabled={draftCount === 0 || busy !== null}
          title={draftCount === 0 ? 'No drafts in selection' : `Publish ${draftCount} draft(s)`}
        >
          <Send className="h-3.5 w-3.5" />
          Publish ({draftCount})
        </Button>
        <Button
          variant="ghost"
          onClick={onUnassign}
          loading={busy === 'unassign'}
          disabled={assignedCount === 0 || busy !== null}
          title={assignedCount === 0 ? 'Nothing to unassign' : `Unassign ${assignedCount}`}
        >
          Unassign ({assignedCount})
        </Button>
        <Button
          variant="ghost"
          onClick={() => setPanel(panel === 'reassign' ? null : 'reassign')}
          disabled={busy !== null}
          title="Assign every selected shift to one associate"
        >
          <UserPlus className="h-3.5 w-3.5" />
          Assign to…
        </Button>
        <Button
          variant="ghost"
          onClick={() => setPanel(panel === 'move' ? null : 'move')}
          disabled={busy !== null}
          title="Move every selected shift by N days"
        >
          <CalendarRange className="h-3.5 w-3.5" />
          Move…
        </Button>
        <Button
          variant="ghost"
          onClick={onDuplicate}
          loading={busy === 'duplicate'}
          disabled={busy !== null}
          title="Copy every selected shift to the same time next week"
        >
          <CopyIcon className="h-3.5 w-3.5" />
          Duplicate →1wk
        </Button>
        <Button
          variant="ghost"
          onClick={onCancel}
          loading={busy === 'cancel'}
          disabled={cancellableCount === 0 || busy !== null}
          className="text-alert hover:text-alert"
          title="Cancel — keeps a CANCELLED record"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Cancel ({cancellableCount})
        </Button>
        <Button
          variant="ghost"
          onClick={onDelete}
          loading={busy === 'delete'}
          disabled={busy !== null}
          className="text-alert hover:text-alert"
          title="Delete permanently — removes the shifts entirely"
        >
          <Trash className="h-3.5 w-3.5" />
          Delete
        </Button>
        <span className="text-silver/70">·</span>
        <button
          type="button"
          onClick={onClear}
          className="text-silver/70 hover:text-silver p-1"
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
