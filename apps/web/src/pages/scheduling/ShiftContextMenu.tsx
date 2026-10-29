import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth';
import {
  Clock,
  Copy as CopyIcon,
  Pencil,
  UserRound,
  Trash2,
  UserMinus,
  UserPlus,
  UsersRound,
  CalendarPlus,
  Send,
  FileText,
} from '@/components/ui/icons';
import { wentUnfilled, type AutoFillCandidate, type Shift } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import type { QuickActions } from './ShiftHoverCard';
import { oneWeekLater, shiftActions } from './shiftHistory';

/**
 * Right-click context menu on shift chips.
 *
 * Pattern: parent owns the open state via `useShiftContextMenu()`, chip
 * fires `onContextMenu={menu.openFor(shift, e)}`. Menu mounts to body
 * via portal so grid `overflow-hidden` doesn't clip it; closes on
 * Escape, outside click, or any action.
 *
 * dnd-kit's PointerSensor only listens to left-button by default, so
 * right-click doesn't fight with drag. The chip's left-button drag
 * grip and the right-click menu coexist cleanly.
 */

interface UseMenuReturn {
  active: { shift: Shift; x: number; y: number } | null;
  openFor: (shift: Shift, e: React.MouseEvent) => void;
  close: () => void;
}

export function useShiftContextMenu(): UseMenuReturn {
  const [active, setActive] = useState<{ shift: Shift; x: number; y: number } | null>(null);

  const openFor = (shift: Shift, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActive({ shift, x: e.clientX, y: e.clientY });
  };
  const close = () => setActive(null);

  return { active, openFor, close };
}

interface Props {
  active: { shift: Shift; x: number; y: number };
  onClose: () => void;
  canManage: boolean;
  actions: QuickActions;
}

const MENU_WIDTH = 200;
const MENU_ITEM_HEIGHT = 32;

export function ShiftContextMenu({ active, onClose, canManage, actions }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const { can } = useAuth();
  const canSeePeople = can('view:org');
  const canSeeTime = can('view:time');

  // Top-ranked candidate for an OPEN (unassigned) shift — the one-click
  // "Assign → <name>" item. undefined = loading, null = none available.
  // An OPEN shift that already ended went unfilled — history, not a hole.
  // Nobody is assigned to a shift that is over, so the Assign items stay
  // off and the shift reads "Went unfilled" (role walk, ops 6).
  const unfilled = wentUnfilled(active.shift);
  const wantTopCandidate =
    canManage &&
    !unfilled &&
    active.shift.status === 'OPEN' &&
    active.shift.assignedAssociateId === null &&
    !!actions.getTopCandidates &&
    !!actions.onAssignCandidate;
  // `actions` is rebuilt by the parent every render; the shift id is the
  // real identity of this lookup (results are short-TTL cached upstream).
  const topQuery = useQuery({
    queryKey: ['scheduling', 'top-candidate', active.shift],
    queryFn: () => actions.getTopCandidates!(active.shift),
    enabled: wantTopCandidate,
    staleTime: 30_000,
    retry: false,
  });
  // undefined = loading, null = none available.
  const topCandidate: AutoFillCandidate | null | undefined = !wantTopCandidate
    ? null
    : topQuery.isError
      ? null
      : topQuery.data === undefined
        ? undefined
        : (topQuery.data[0] ?? null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    // Capture-phase so we close before any chip click handler fires.
    window.addEventListener('mousedown', onClick, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick, true);
    };
  }, [onClose]);

  const items: Array<
    | { kind: 'item'; label: string; icon: typeof Pencil; onClick: () => void; danger?: boolean; disabled?: boolean }
    | { kind: 'sep' }
  > = [];

  // "Who is this, and did they clock in?" used to mean a search in People
  // or Time: the person and their timesheet are one click from the chip.
  if (active.shift.assignedAssociateId && canSeePeople) {
    const who = active.shift.assignedAssociateName ?? 'this person';
    const id = active.shift.assignedAssociateId;
    items.push({
      kind: 'item',
      label: `Open ${who}`,
      icon: UserRound,
      onClick: () => {
        navigate(`/people/${id}`);
        onClose();
      },
    });
    if (canSeeTime) {
      items.push({
        kind: 'item',
        label: 'View their time',
        icon: Clock,
        onClick: () => {
          navigate(`/time-attendance?associate=${id}&name=${encodeURIComponent(who)}`);
          onClose();
        },
      });
    }
    items.push({ kind: 'sep' });
  }

  if (canManage) {
    // One rule with the phone sheet and the hover card (FLOOR-18): a shift
    // that is over offers a copy one week on, and nothing that rewrites it.
    const acts = shiftActions(active.shift, canManage);
    if (acts.edit) {
      items.push({
        kind: 'item',
        label: 'Edit',
        // Pencil, not Edit3 — the one edit glyph used app-wide (see the
        // admin toolbar + mobile action sheet).
        icon: Pencil,
        onClick: () => {
          actions.onEdit(active.shift);
          onClose();
        },
      });
    }
    if (unfilled) {
      items.push({
        kind: 'item',
        label: 'Went unfilled',
        icon: UserMinus,
        disabled: true,
        onClick: () => undefined,
      });
    } else if (acts.readOnly) {
      items.push({
        kind: 'item',
        label: 'Shift ended · read-only',
        icon: Clock,
        disabled: true,
        onClick: () => undefined,
      });
    } else if (active.shift.assignedAssociateId === null) {
      // One-click best-fit assign. Loading shows a compact disabled stub;
      // "no candidates" hides the item entirely (nothing useful to click).
      if (wantTopCandidate && topCandidate !== null) {
        items.push({
          kind: 'item',
          label:
            topCandidate === undefined
              ? 'Assign → …'
              : `Assign → ${topCandidate.associateName}`,
          icon: UserPlus,
          disabled: topCandidate === undefined,
          onClick: () => {
            if (!topCandidate) return;
            const shift = active.shift;
            // Close first — the assign flow may open confirm prompts or
            // fall back into the AssignDialog; errors surface via toasts
            // from the handler itself.
            onClose();
            void actions.onAssignCandidate!(shift, topCandidate);
          },
        });
      }
      if (acts.assign) {
        items.push({
          kind: 'item',
          label: 'Assign…',
          icon: UserPlus,
          onClick: () => {
            actions.onAssign(active.shift);
            onClose();
          },
        });
      }
    } else if (acts.unassign) {
      items.push({
        kind: 'item',
        label: 'Unassign',
        icon: UserMinus,
        onClick: async () => {
          await actions.onUnassign(active.shift);
          onClose();
        },
      });
    }
    if (acts.duplicate) {
      items.push({
        kind: 'item',
        label: 'Duplicate',
        icon: CopyIcon,
        onClick: async () => {
          await actions.onDuplicate(active.shift);
          onClose();
        },
      });
      items.push({
        kind: 'item',
        label: 'Duplicate to associate…',
        icon: UsersRound,
        onClick: () => {
          actions.onDuplicateToEmployee(active.shift);
          onClose();
        },
      });
    }
    if (acts.copyNextWeek) {
      items.push({
        kind: 'item',
        label: 'Copy to next week',
        icon: CalendarPlus,
        onClick: async () => {
          // Same shift one week later, at its store's wall clock (DST-safe).
          // onDuplicate only reads the data fields (clientId, position,
          // times, rates) — the id on this copy is ignored.
          await actions.onDuplicate({ ...active.shift, ...oneWeekLater(active.shift) });
          onClose();
        },
      });
    }
    // Publish / un-publish a single shift. DRAFT → publish; published →
    // move back to draft. Not shown on COMPLETED/CANCELLED (terminal).
    if (acts.publish) {
      items.push({
        kind: 'item',
        label: 'Publish shift',
        icon: Send,
        onClick: async () => {
          await actions.onPublish(active.shift);
          onClose();
        },
      });
    } else if (acts.unpublish) {
      items.push({
        kind: 'item',
        label: 'Move to draft',
        icon: FileText,
        onClick: async () => {
          await actions.onUnpublish(active.shift);
          onClose();
        },
      });
    }
    if (acts.cancel || acts.delete) items.push({ kind: 'sep' });
    if (acts.cancel) {
      items.push({
        kind: 'item',
        label: 'Cancel shift',
        icon: Trash2,
        danger: true,
        onClick: async () => {
          await actions.onCancel(active.shift);
          onClose();
        },
      });
    }
    // Cancel and Delete share the Trash2 glyph deliberately — both are
    // destructive and read as such; the LABEL ("Cancel shift" keeps a
    // CANCELLED record, "Delete shift" removes it) carries the difference,
    // not a subtle icon variant nobody can tell apart at 14px.
    if (acts.delete) {
      items.push({
        kind: 'item',
        label: 'Delete shift',
        icon: Trash2,
        danger: true,
        onClick: async () => {
          await actions.onDelete(active.shift);
          onClose();
        },
      });
    }
  } else {
    items.push({
      kind: 'item',
      label: 'View details',
      icon: Pencil,
      onClick: () => {
        actions.onEdit(active.shift);
        onClose();
      },
    });
  }

  // Bound to viewport; flip up/left if it would clip.
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const heightEstimate = items.length * MENU_ITEM_HEIGHT + 8;
  const left = Math.min(active.x, viewportW - MENU_WIDTH - 8);
  const top = Math.min(active.y, viewportH - heightEstimate - 8);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        top,
        left,
        width: MENU_WIDTH,
        zIndex: 110,
      }}
      className="rounded-md border border-navy-secondary bg-navy elev-3 py-1 animate-zoom-in"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.kind === 'sep' ? (
          <div key={i} className="my-1 border-t border-navy-secondary/60" />
        ) : (
          <button
            key={i}
            type="button"
            onClick={it.onClick}
            disabled={it.disabled}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-1.5 coarse:py-2.5 text-sm text-left transition-colors',
              it.danger
                ? 'text-alert hover:bg-alert/10'
                : 'text-silver hover:bg-navy-secondary/60 hover:text-white',
              it.disabled && 'opacity-40 cursor-not-allowed',
            )}
          >
            <it.icon className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 min-w-0 truncate">{it.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
