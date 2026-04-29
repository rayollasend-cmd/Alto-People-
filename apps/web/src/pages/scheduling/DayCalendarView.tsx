import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { GripVertical, Plus } from 'lucide-react';
import type { AssociateLite, Shift, ShiftStatus } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { colorForPosition } from '@/lib/positionColor';
import {
  ShiftHoverCard,
  useShiftHoverCard,
  type QuickActions,
} from './ShiftHoverCard';
import {
  ShiftContextMenu,
  useShiftContextMenu,
} from './ShiftContextMenu';

const STATUS_VARIANT: Record<
  ShiftStatus,
  'success' | 'pending' | 'destructive' | 'default' | 'accent'
> = {
  OPEN: 'pending',
  ASSIGNED: 'success',
  DRAFT: 'default',
  COMPLETED: 'success',
  CANCELLED: 'destructive',
};

const UNASSIGNED_ROW_ID = '__unassigned__';

// Time grid runs 6:00 → 24:00 (an 18-hour day fits the hourly-workforce
// shape we care about). Override here when we need night-shift coverage.
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 24;
const HOURS_VISIBLE = DAY_END_HOUR - DAY_START_HOUR;
const PX_PER_HOUR = 56; // tall enough to drop two ~30min chips legibly
const PX_PER_MIN = PX_PER_HOUR / 60;
// Drag-to-resize snaps to 15-minute increments to match standard payroll
// rounding (and keeps the chip readable as it moves).
const SNAP_MIN = 15;

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function shiftMinutes(s: Shift): number {
  return Math.max(
    0,
    Math.round(
      (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 60_000
    )
  );
}

/** Minutes from DAY_START_HOUR to the given Date (clamped at zero). */
function minutesFromGridStart(d: Date, dayAnchor: Date): number {
  const ms = d.getTime() - dayAnchor.getTime();
  const min = Math.round(ms / 60_000);
  return min - DAY_START_HOUR * 60;
}

function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

interface Props {
  shifts: Shift[];
  associates: AssociateLite[];
  dayAnchor: Date; // 00:00 local of the day we're viewing
  canManage: boolean;
  showAllAssociates: boolean;
  onShiftClick: (s: Shift) => void;
  onCellCreate: (dayStart: Date, associateId: string | null) => void;
  onShiftMove: (
    s: Shift,
    target: { associateId: string | null; dayStart: Date }
  ) => Promise<void>;
  onShiftResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  quickActions: QuickActions;
}

/**
 * Phase 53 — day view. Vertical hour grid with absolutely-positioned
 * shift chips per associate column. Drag a chip's bottom handle to
 * resize duration (snapped to 15 min); drag the body to reassign or
 * unassign.
 *
 * Like the week view, this is a pivot — columns are people, rows are
 * hours. The unassigned column is pinned to the left of the associate
 * columns so OPEN shifts stay visible even when you scroll.
 */
export function DayCalendarView({
  shifts,
  associates,
  dayAnchor,
  canManage,
  showAllAssociates,
  onShiftClick,
  onCellCreate,
  onShiftMove,
  onShiftResize,
  quickActions,
}: Props) {
  const hover = useShiftHoverCard();
  const ctxMenu = useShiftContextMenu();
  // Filter to shifts that actually fall on `dayAnchor`. The parent already
  // requested ≤24h of data, but cross-day overlap can leak in.
  const todayShifts = useMemo(() => {
    const start = dayAnchor.getTime();
    const end = new Date(dayAnchor.getTime() + 24 * 60 * 60 * 1000).getTime();
    return shifts.filter((s) => {
      const t = new Date(s.startsAt).getTime();
      return t >= start && t < end;
    });
  }, [shifts, dayAnchor]);

  // Bucket by associate id (or 'unassigned').
  const byAssociate = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const s of todayShifts) {
      const k = s.assignedAssociateId ?? UNASSIGNED_ROW_ID;
      const list = map.get(k) ?? [];
      list.push(s);
      map.set(k, list);
    }
    return map;
  }, [todayShifts]);

  const visibleAssociates = useMemo(() => {
    if (showAllAssociates) return associates;
    const withShifts = new Set<string>();
    for (const s of todayShifts) {
      if (s.assignedAssociateId) withShifts.add(s.assignedAssociateId);
    }
    return associates.filter((a) => withShifts.has(a.id));
  }, [associates, todayShifts, showAllAssociates]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const handleDragEnd = async (e: DragEndEvent) => {
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || !overId.startsWith('day-col:')) return;
    const associateRaw = overId.slice('day-col:'.length);
    const associateId =
      associateRaw === UNASSIGNED_ROW_ID ? null : associateRaw;
    const shiftId = String(e.active.id);
    const shift = todayShifts.find((s) => s.id === shiftId);
    if (!shift) return;
    if ((shift.assignedAssociateId ?? null) === associateId) return;
    await onShiftMove(shift, { associateId, dayStart: dayAnchor });
  };

  const totalHeight = HOURS_VISIBLE * PX_PER_HOUR;
  const hourLabels = Array.from({ length: HOURS_VISIBLE }).map(
    (_, i) => DAY_START_HOUR + i
  );

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="rounded-md border border-navy-secondary bg-navy/40 overflow-x-auto">
        <div className="flex min-w-[700px]">
          {/* Hour gutter */}
          <div className="sticky left-0 z-20 bg-navy/95 backdrop-blur w-16 border-r border-navy-secondary">
            <div className="h-12 border-b border-navy-secondary" />
            <div className="relative" style={{ height: totalHeight }}>
              {hourLabels.map((h, i) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 px-2 text-[10px] text-silver/60 tabular-nums"
                  style={{ top: i * PX_PER_HOUR - 6 }}
                >
                  {h % 12 === 0 ? 12 : h % 12}
                  {h >= 12 ? 'p' : 'a'}
                </div>
              ))}
            </div>
          </div>

          {/* Unassigned column */}
          <DayColumn
            colId={`day-col:${UNASSIGNED_ROW_ID}`}
            header={
              <div className="px-2 py-2 text-xs font-medium text-warning border-b border-navy-secondary bg-warning/10 h-12 flex flex-col justify-center">
                Unassigned
                <div className="text-[10px] uppercase tracking-wider text-silver/70 font-normal">
                  OPEN shifts
                </div>
              </div>
            }
            shifts={byAssociate.get(UNASSIGNED_ROW_ID) ?? []}
            dayAnchor={dayAnchor}
            canManage={canManage}
            onShiftClick={onShiftClick}
            onCreate={(t) => {
              const d = new Date(dayAnchor);
              d.setMinutes(d.getMinutes() + t);
              onCellCreate(d, null);
            }}
            onShiftResize={onShiftResize}
            hoverBind={hover.bind}
            onContextMenu={ctxMenu.openFor}
            tone="warning"
          />

          {/* Associate columns */}
          {visibleAssociates.length === 0 ? (
            <div className="flex-1 px-4 py-6 text-center text-sm text-silver/60">
              No associates have shifts today.
            </div>
          ) : (
            visibleAssociates.map((a) => (
              <DayColumn
                key={a.id}
                colId={`day-col:${a.id}`}
                header={
                  <div className="px-2 py-2 border-b border-navy-secondary h-12 flex items-center gap-2 bg-navy/95">
                    <div className="h-7 w-7 rounded-full bg-gold/15 text-gold text-[10px] font-semibold flex items-center justify-center shrink-0">
                      {a.firstName[0]}
                      {a.lastName[0]}
                    </div>
                    <div className="text-xs text-white truncate">
                      {a.firstName} {a.lastName}
                    </div>
                  </div>
                }
                shifts={byAssociate.get(a.id) ?? []}
                dayAnchor={dayAnchor}
                canManage={canManage}
                onShiftClick={onShiftClick}
                onCreate={(t) => {
                  const d = new Date(dayAnchor);
                  d.setMinutes(d.getMinutes() + t);
                  onCellCreate(d, a.id);
                }}
                onShiftResize={onShiftResize}
                hoverBind={hover.bind}
                onContextMenu={ctxMenu.openFor}
              />
            ))
          )}
        </div>
      </div>
      {hover.active && (
        <ShiftHoverCard
          shift={hover.active.shift}
          anchorRect={hover.active.rect}
          onClose={hover.close}
          onPointerEnterCard={hover.onCardEnter}
          onPointerLeaveCard={hover.onCardLeave}
          canManage={canManage}
          actions={{
            onEdit: (s) => {
              hover.close();
              quickActions.onEdit(s);
            },
            onAssign: (s) => {
              hover.close();
              quickActions.onAssign(s);
            },
            onUnassign: async (s) => {
              await quickActions.onUnassign(s);
              hover.close();
            },
            onCancel: async (s) => {
              await quickActions.onCancel(s);
              hover.close();
            },
            onDuplicate: async (s) => {
              await quickActions.onDuplicate(s);
              hover.close();
            },
          }}
        />
      )}
      {ctxMenu.active && (
        <ShiftContextMenu
          active={ctxMenu.active}
          onClose={ctxMenu.close}
          canManage={canManage}
          actions={quickActions}
        />
      )}
    </DndContext>
  );
}

function DayColumn({
  colId,
  header,
  shifts,
  dayAnchor,
  canManage,
  onShiftClick,
  onCreate,
  onShiftResize,
  hoverBind,
  onContextMenu,
  tone,
}: {
  colId: string;
  header: React.ReactNode;
  shifts: Shift[];
  dayAnchor: Date;
  canManage: boolean;
  onShiftClick: (s: Shift) => void;
  onCreate: (gridMinutes: number) => void;
  onShiftResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  hoverBind: (s: Shift) => {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  onContextMenu: (s: Shift, e: React.MouseEvent) => void;
  tone?: 'warning';
}) {
  const { isOver, setNodeRef } = useDroppable({ id: colId });
  const totalHeight = HOURS_VISIBLE * PX_PER_HOUR;

  // Click-to-create at the y position the user clicked (snapped).
  const onColumnClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canManage) return;
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const min = snap(y / PX_PER_MIN + DAY_START_HOUR * 60);
    onCreate(min);
  };

  return (
    <div className="flex-1 min-w-[160px] border-r border-navy-secondary">
      {header}
      <div
        ref={setNodeRef}
        onClick={onColumnClick}
        className={cn(
          'relative cursor-pointer',
          isOver && 'bg-gold/15 outline outline-1 outline-gold/40 -outline-offset-1',
          tone === 'warning' && !isOver && 'bg-warning/[0.04]'
        )}
        style={{
          height: totalHeight,
          backgroundImage:
            'linear-gradient(to bottom, transparent calc(100% - 1px), rgba(255,255,255,0.05) 100%)',
          backgroundSize: `100% ${PX_PER_HOUR}px`,
        }}
      >
        {shifts.map((s) => (
          <DayShiftChip
            key={s.id}
            shift={s}
            dayAnchor={dayAnchor}
            onClick={() => onShiftClick(s)}
            onContextMenu={(e) => onContextMenu(s, e)}
            onResize={onShiftResize}
            canManage={canManage}
            hoverHandlers={hoverBind(s)}
          />
        ))}
        {shifts.length === 0 && canManage && (
          <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-4 text-silver/30 text-[11px]">
            <Plus className="h-3 w-3 mr-1 mt-0.5" /> click to add
          </div>
        )}
      </div>
    </div>
  );
}

function DayShiftChip({
  shift,
  dayAnchor,
  onClick,
  onContextMenu,
  onResize,
  canManage,
  hoverHandlers,
}: {
  shift: Shift;
  dayAnchor: Date;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  canManage: boolean;
  hoverHandlers: {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: shift.id,
  });

  // Local optimistic height during resize. Cleared after the parent
  // re-renders with the new shift data.
  const [resizeDeltaPx, setResizeDeltaPx] = useState<number | null>(null);
  const startYRef = useRef<number | null>(null);

  const startsAt = new Date(shift.startsAt);
  const endsAt = new Date(shift.endsAt);
  const startMinFromGrid = Math.max(0, minutesFromGridStart(startsAt, dayAnchor));
  const baseDuration = shiftMinutes(shift);
  const top = startMinFromGrid * PX_PER_MIN;
  const baseHeight = baseDuration * PX_PER_MIN;
  const height = Math.max(20, baseHeight + (resizeDeltaPx ?? 0));

  // Resize handler — manual mouse events (not dnd-kit) since this is an
  // axis-locked snap-to-grid edit, not a free drop target.
  useEffect(() => {
    if (resizeDeltaPx === null) return;

    const onMove = (ev: MouseEvent) => {
      if (startYRef.current === null) return;
      const delta = ev.clientY - startYRef.current;
      setResizeDeltaPx(delta);
    };
    const onUp = (_ev: MouseEvent) => {
      const delta = resizeDeltaPx ?? 0;
      const newDurationMin = snap(baseDuration + delta / PX_PER_MIN);
      const clamped = Math.max(SNAP_MIN, newDurationMin);
      const newEnds = new Date(startsAt.getTime() + clamped * 60_000);
      // Only fire if it actually changed.
      if (newEnds.getTime() !== endsAt.getTime()) {
        onResize(shift, newEnds);
      }
      setResizeDeltaPx(null);
      startYRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizeDeltaPx, baseDuration, shift, startsAt, endsAt, onResize]);

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    startYRef.current = e.clientY;
    setResizeDeltaPx(0);
  };

  const dragStyle: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        zIndex: 50,
      }
    : {};

  // Live time labels reflect the optimistic resize.
  const previewEnds = resizeDeltaPx !== null
    ? new Date(
        startsAt.getTime() +
          Math.max(SNAP_MIN, snap(baseDuration + resizeDeltaPx / PX_PER_MIN)) *
            60_000
      )
    : endsAt;

  const color = colorForPosition(shift.position);
  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'absolute',
        top,
        left: 4,
        right: 4,
        height,
        backgroundColor: color.bg,
        borderColor: color.border,
        ...dragStyle,
      }}
      className={cn(
        'rounded border transition-colors hover:brightness-125',
        isDragging && 'shadow-2xl ring-2 ring-gold/60 opacity-90',
        resizeDeltaPx !== null && 'ring-2 ring-gold/70'
      )}
      onPointerEnter={hoverHandlers.onPointerEnter}
      onPointerLeave={hoverHandlers.onPointerLeave}
      onContextMenu={onContextMenu}
    >
      <div
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-1 rounded-l"
        style={{ backgroundColor: color.accent }}
      />
      <div
        {...listeners}
        {...attributes}
        className="absolute left-1.5 top-1 text-silver/40 hover:text-gold cursor-grab active:cursor-grabbing no-print"
        aria-label={`Move ${shift.position}`}
      >
        <GripVertical className="h-3 w-3" />
      </div>
      <button
        type="button"
        onClick={onClick}
        className="w-full h-full text-left px-1.5 pl-5 pt-1 pb-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
      >
        <div className="flex items-center justify-between gap-1">
          <div className="text-[10px] text-silver tabular-nums truncate">
            {fmtTime(startsAt)}–{fmtTime(previewEnds)}
          </div>
          <Badge
            variant={STATUS_VARIANT[shift.status] ?? 'default'}
            className="text-[9px] px-1 py-0 shrink-0"
            data-status={shift.status}
          >
            {shift.status === 'ASSIGNED'
              ? '✓'
              : shift.status === 'OPEN'
                ? '○'
                : shift.status[0]}
          </Badge>
        </div>
        <div className="text-[11px] text-white font-medium truncate">
          {shift.position}
        </div>
        {shift.clientName && (
          <div className="text-[10px] text-silver/70 truncate">
            {shift.clientName}
          </div>
        )}
      </button>
      {canManage && (
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize hover:bg-gold/40 group no-print"
          aria-label="Drag to resize duration"
          role="slider"
          tabIndex={-1}
        >
          <div className="mx-auto w-8 h-0.5 mt-0.5 rounded-full bg-silver/30 group-hover:bg-gold" />
        </div>
      )}
    </div>
  );
}
