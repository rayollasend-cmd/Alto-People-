import { useState } from 'react';
import { CheckCircle2, Copy as CopyIcon, Send, Trash2, X } from 'lucide-react';
import type { Shift } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import {
  cancelShift,
  createShift,
  unassignShift,
  updateShift,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { toast } from '@/components/ui/Toaster';
import { useConfirm } from '@/lib/confirm';

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
  const [busy, setBusy] = useState<null | 'publish' | 'cancel' | 'unassign' | 'duplicate'>(null);

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

  const onDuplicate = async () => {
    setBusy('duplicate');
    try {
      await runBatch<Shift>(async (s) => {
        return createShift({
          clientId: s.clientId,
          position: s.position,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          ...(s.location ? { location: s.location } : {}),
          ...(s.hourlyRate != null ? { hourlyRate: s.hourlyRate } : {}),
          ...(s.payRate != null ? { payRate: s.payRate } : {}),
          ...(s.notes ? { notes: s.notes } : {}),
        });
      }, 'Duplicated');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-40 no-print bottom-[max(1.5rem,calc(env(safe-area-inset-bottom)+0.5rem))]">
      <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-navy border border-gold/40 shadow-2xl">
        <CheckCircle2 className="h-4 w-4 text-gold" />
        <span className="text-sm text-white tabular-nums">
          {selected.length} selected
        </span>
        <span className="text-silver/50">·</span>
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
          onClick={onDuplicate}
          loading={busy === 'duplicate'}
          disabled={busy !== null}
        >
          <CopyIcon className="h-3.5 w-3.5" />
          Duplicate
        </Button>
        <Button
          variant="ghost"
          onClick={onCancel}
          loading={busy === 'cancel'}
          disabled={cancellableCount === 0 || busy !== null}
          className="text-alert hover:text-alert"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Cancel
        </Button>
        <span className="text-silver/40">·</span>
        <button
          type="button"
          onClick={onClear}
          className="text-silver/60 hover:text-silver p-1"
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
