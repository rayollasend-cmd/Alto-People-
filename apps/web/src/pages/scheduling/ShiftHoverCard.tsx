import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, Clock, MapPin, StickyNote, User, X } from 'lucide-react';
import type { Shift } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { colorForPosition } from '@/lib/positionColor';

/**
 * Hover-card preview for shift chips.
 *
 * Shows full shift details + quick actions without requiring the manager
 * to open the assign/edit dialog. Mounts to document.body via portal so
 * it can escape grid `overflow-hidden` clipping; positioned via fixed
 * coordinates from the trigger's getBoundingClientRect.
 *
 * Open state lives at the parent (calendar view) so multiple chips don't
 * fight to be the active hover; the parent owns "which shift's card is
 * currently shown."
 */

export interface QuickActions {
  onEdit: (s: Shift) => void;
  onAssign: (s: Shift) => void;
  onUnassign: (s: Shift) => Promise<void> | void;
  onCancel: (s: Shift) => Promise<void> | void;
  onDuplicate: (s: Shift) => Promise<void> | void;
}

interface Props {
  shift: Shift;
  anchorRect: DOMRect;
  onClose: () => void;
  /** Keep the card open while the pointer is inside it. */
  onPointerEnterCard: () => void;
  onPointerLeaveCard: () => void;
  canManage: boolean;
  actions: QuickActions;
}

function fmtTimeRange(s: Shift): string {
  const a = new Date(s.startsAt);
  const b = new Date(s.endsAt);
  const date = a.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const t1 = a.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const t2 = b.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${t1} – ${t2}`;
}

function fmtDuration(s: Shift): string {
  const mins = Math.max(
    0,
    Math.round((new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 60_000),
  );
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

const STATUS_LABEL: Record<Shift['status'], { label: string; cls: string }> = {
  OPEN: { label: 'Open', cls: 'bg-warning/15 text-warning border-warning/40' },
  ASSIGNED: { label: 'Assigned', cls: 'bg-success/15 text-success border-success/40' },
  DRAFT: { label: 'Draft', cls: 'bg-silver/10 text-silver border-silver/30' },
  COMPLETED: { label: 'Completed', cls: 'bg-success/15 text-success border-success/40' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-alert/15 text-alert border-alert/40' },
};

const CARD_WIDTH = 320;
const CARD_GAP = 8;
const CARD_MAX_HEIGHT = 360;

export function ShiftHoverCard({
  shift,
  anchorRect,
  onClose,
  onPointerEnterCard,
  onPointerLeaveCard,
  canManage,
  actions,
}: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [acting, setActing] = useState<null | string>(null);

  // Close on Escape; let the parent handle outside-click (the card stays
  // open when you click into a button inside it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Smart placement: prefer right of chip, flip to left if it would clip.
  // Vertically: align with anchor top, but bound to viewport.
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;

  let left = anchorRect.right + CARD_GAP;
  if (left + CARD_WIDTH > viewportW - 8) {
    left = anchorRect.left - CARD_WIDTH - CARD_GAP;
  }
  if (left < 8) left = 8;

  let top = anchorRect.top;
  if (top + CARD_MAX_HEIGHT > viewportH - 8) {
    top = Math.max(8, viewportH - CARD_MAX_HEIGHT - 8);
  }
  if (top < 8) top = 8;

  const color = colorForPosition(shift.position);
  const status = STATUS_LABEL[shift.status];

  const wrap = (key: string, fn: () => Promise<void> | void) => async () => {
    setActing(key);
    try {
      await fn();
    } finally {
      setActing(null);
    }
  };

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Shift details: ${shift.position}`}
      onPointerEnter={onPointerEnterCard}
      onPointerLeave={onPointerLeaveCard}
      style={{
        position: 'fixed',
        top,
        left,
        width: CARD_WIDTH,
        maxHeight: CARD_MAX_HEIGHT,
        zIndex: 100,
      }}
      className="rounded-lg border border-navy-secondary bg-navy shadow-2xl overflow-hidden flex flex-col"
    >
      {/* Header — colored accent bar + position + status badge */}
      <div className="relative px-4 pt-3 pb-2 border-b border-navy-secondary">
        <div
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-1"
          style={{ backgroundColor: color.accent }}
        />
        <button
          onClick={onClose}
          className="absolute right-2 top-2 text-silver/50 hover:text-silver"
          aria-label="Close"
          type="button"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="text-sm text-white font-medium pr-6 truncate">
          {shift.position}
        </div>
        {shift.clientName && (
          <div className="text-xs text-silver/70 truncate">
            {shift.clientName}
          </div>
        )}
        <div className="mt-2">
          <span
            className={cn(
              'inline-flex items-center text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border',
              status.cls,
            )}
          >
            {status.label}
          </span>
          {shift.publishedAt === null && (
            <span className="ml-1.5 inline-flex items-center text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-silver/30 text-silver/70">
              Unpublished
            </span>
          )}
        </div>
      </div>

      {/* Body — facts list */}
      <div className="px-4 py-3 space-y-2 text-sm overflow-auto">
        <Fact icon={Calendar} text={fmtTimeRange(shift)} />
        <Fact icon={Clock} text={fmtDuration(shift)} />
        {shift.location && <Fact icon={MapPin} text={shift.location} />}
        <Fact
          icon={User}
          text={
            shift.assignedAssociateName ?? (
              <span className="text-warning">Unassigned</span>
            )
          }
        />
        {shift.notes && (
          <div className="flex items-start gap-2 text-xs text-silver/80">
            <StickyNote className="h-3.5 w-3.5 text-silver/50 mt-0.5 shrink-0" />
            <div className="whitespace-pre-wrap">{shift.notes}</div>
          </div>
        )}
        {shift.payRate != null && (
          <div className="text-xs text-silver/60 tabular-nums">
            ${shift.payRate.toFixed(2)}/hr · projected $
            {(
              (shift.payRate * (shift.scheduledMinutes ?? 0)) /
              60
            ).toFixed(2)}
          </div>
        )}
      </div>

      {/* Actions */}
      {canManage && shift.status !== 'CANCELLED' && shift.status !== 'COMPLETED' && (
        <div className="border-t border-navy-secondary p-2 flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            onClick={() => actions.onEdit(shift)}
            className="flex-1 min-w-[88px] justify-center"
          >
            Edit
          </Button>
          {shift.assignedAssociateId === null ? (
            <Button
              variant="secondary"
              onClick={() => actions.onAssign(shift)}
              className="flex-1 min-w-[88px] justify-center"
            >
              Assign
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={wrap('unassign', () => actions.onUnassign(shift))}
              loading={acting === 'unassign'}
              className="flex-1 min-w-[88px] justify-center"
            >
              Unassign
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={wrap('duplicate', () => actions.onDuplicate(shift))}
            loading={acting === 'duplicate'}
            className="flex-1 min-w-[88px] justify-center"
          >
            Duplicate
          </Button>
          <Button
            variant="ghost"
            onClick={wrap('cancel', () => actions.onCancel(shift))}
            loading={acting === 'cancel'}
            className="flex-1 min-w-[88px] justify-center text-alert hover:text-alert"
          >
            Cancel
          </Button>
        </div>
      )}
    </div>,
    document.body,
  );
}

function Fact({
  icon: Icon,
  text,
}: {
  icon: typeof Calendar;
  text: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-silver">
      <Icon className="h-3.5 w-3.5 text-silver/50 shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  );
}

/**
 * Hook that wires hover-open / leave-close with the right delays. Returns
 * { activeShift, anchorRect, bind, openFor, close, onCardEnter, onCardLeave }
 *  - bind(shiftId)  → spread on the trigger element to start hover timers
 *  - openFor(shift, rect) → force-open (e.g. on focus or context-click)
 */
export function useShiftHoverCard() {
  const [active, setActive] = useState<{ shift: Shift; rect: DOMRect } | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clear = () => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  useEffect(() => () => clear(), []);

  const openFor = (shift: Shift, rect: DOMRect) => {
    clear();
    setActive({ shift, rect });
  };

  const close = () => {
    clear();
    setActive(null);
  };

  const bind = (shift: Shift) => ({
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      // Ignore touch — touch users get the click-to-dialog flow instead;
      // a touch "hover" with no leave event traps the card on screen.
      if (e.pointerType === 'touch') return;
      const target = e.currentTarget;
      clear();
      openTimer.current = window.setTimeout(() => {
        setActive({ shift, rect: target.getBoundingClientRect() });
      }, 300);
    },
    onPointerLeave: () => {
      if (openTimer.current) {
        window.clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      // Tiny delay so a hop from chip → card doesn't flicker shut.
      closeTimer.current = window.setTimeout(() => setActive(null), 120);
    },
  });

  const onCardEnter = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const onCardLeave = () => {
    closeTimer.current = window.setTimeout(() => setActive(null), 120);
  };

  return { active, bind, openFor, close, onCardEnter, onCardLeave };
}
