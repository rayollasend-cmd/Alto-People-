import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Copy as CopyIcon,
  Edit3,
  Trash2,
  UserMinus,
  UserPlus,
  CalendarPlus,
} from 'lucide-react';
import type { Shift } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import type { QuickActions } from './ShiftHoverCard';

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
    | { kind: 'item'; label: string; icon: typeof Edit3; onClick: () => void; danger?: boolean; disabled?: boolean }
    | { kind: 'sep' }
  > = [];

  if (canManage) {
    items.push({
      kind: 'item',
      label: 'Edit',
      icon: Edit3,
      onClick: () => {
        actions.onEdit(active.shift);
        onClose();
      },
    });
    if (active.shift.assignedAssociateId === null) {
      items.push({
        kind: 'item',
        label: 'Assign…',
        icon: UserPlus,
        onClick: () => {
          actions.onAssign(active.shift);
          onClose();
        },
      });
    } else {
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
      label: 'Copy to next week',
      icon: CalendarPlus,
      onClick: async () => {
        // Reuse Duplicate for now but offset by 7 days; SchedulingView's
        // onDuplicate doesn't support offsetting yet, so we approximate
        // here. A future tightening pass can plumb this through.
        const offset = 7 * 24 * 60 * 60 * 1000;
        const fakeShift: Shift = {
          ...active.shift,
          startsAt: new Date(new Date(active.shift.startsAt).getTime() + offset).toISOString(),
          endsAt: new Date(new Date(active.shift.endsAt).getTime() + offset).toISOString(),
        };
        await actions.onDuplicate(fakeShift);
        onClose();
      },
    });
    items.push({ kind: 'sep' });
    if (active.shift.status !== 'CANCELLED' && active.shift.status !== 'COMPLETED') {
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
  } else {
    items.push({
      kind: 'item',
      label: 'View details',
      icon: Edit3,
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
      className="rounded-md border border-navy-secondary bg-navy shadow-2xl py-1"
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
              'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors',
              it.danger
                ? 'text-alert hover:bg-alert/10'
                : 'text-silver hover:bg-navy-secondary/60 hover:text-white',
              it.disabled && 'opacity-40 cursor-not-allowed',
            )}
          >
            <it.icon className="h-3.5 w-3.5" />
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
