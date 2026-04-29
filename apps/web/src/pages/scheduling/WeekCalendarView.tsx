import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Plus, GripVertical } from 'lucide-react';
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
import { TEMPLATE_MIME } from './TemplatesRail';

// Week-view chips have no time axis to drag against, so resize maps
// pointer-x-pixels to minutes at a comfortable 1.5px per minute (so a
// 45px drag = 30 min). Snapped to 15-minute increments to match payroll
// rounding everywhere else.
const RESIZE_PX_PER_MIN = 1.5;
const RESIZE_SNAP_MIN = 15;
const RESIZE_MIN_DURATION_MIN = 15;

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

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const UNASSIGNED_ROW_ID = '__unassigned__';

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatCost(n: number): string {
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function shiftMinutes(s: Shift): number {
  return Math.max(
    0,
    Math.round(
      (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 60_000
    )
  );
}

interface Props {
  shifts: Shift[];
  associates: AssociateLite[];
  weekStart: Date; // Monday at 00:00 local
  canManage: boolean;
  /** Click on a chip. Parent inspects modifier keys to decide between
   *  selection-toggle and open-edit-dialog. */
  onShiftClick: (s: Shift, e: React.MouseEvent) => void;
  /** Set of currently-selected shift ids (for bulk actions). */
  selectedIds: Set<string>;
  /** Click "+" in a cell. associateId is null for the Unassigned row. */
  onCellCreate: (dayStart: Date, associateId: string | null) => void;
  /**
   * Drop a shift on a different cell.
   *  - same row, different day  → patch startsAt/endsAt by the day delta
   *  - different row, any day   → assign / unassign / reassign + patch date
   *  - drop on Unassigned row   → unassign
   */
  onShiftMove: (
    s: Shift,
    target: { associateId: string | null; dayStart: Date }
  ) => Promise<void>;
  /** Drag the right edge of a chip to change duration (snapped 15 min). */
  onShiftResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  /** Hover-card quick actions (assign / unassign / cancel / duplicate / edit). */
  quickActions: QuickActions;
  /** Apply a dragged-from-rail template to a specific cell. */
  onTemplateDrop: (templateId: string, dayStart: Date, associateId: string | null) => void;
  /** When true, render every associate as a row (Sling default); otherwise only those with shifts. */
  showAllAssociates: boolean;
}

/**
 * Phase 53 — Sling-style pivot week view.
 *
 * Layout: a CSS grid where the X axis is 7 days (Mon-Sun) and the Y axis
 * is associates, with a pinned "Unassigned" row at the top for OPEN
 * (un-staffed) shifts. Sticky left column shows employee + weekly hours.
 *
 * Interactions:
 *  - Click a shift chip   → open edit/assign dialog
 *  - Click "+" in a cell  → create shift pre-filled with that day + associate
 *  - Drag a chip to a different cell → reassign / re-date in one motion
 *
 * Drag-to-resize (changing duration) lives in the day view, where there's
 * a vertical hour axis to drag against. In the week view, durations are
 * text labels — there's no spatial dimension to map a drag onto.
 */
export function WeekCalendarView({
  shifts,
  associates,
  weekStart,
  canManage,
  onShiftClick,
  onCellCreate,
  onShiftMove,
  onShiftResize,
  quickActions,
  selectedIds,
  onTemplateDrop,
  showAllAssociates,
}: Props) {
  const hover = useShiftHoverCard();
  const ctxMenu = useShiftContextMenu();
  const days = useMemo(
    () => Array.from({ length: 7 }).map((_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  // Bucket shifts by associateId × local-day. Index by `${associateId|unassigned}_${dayMs}`.
  const byCell = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const s of shifts) {
      const day = startOfDay(new Date(s.startsAt)).getTime();
      const key = `${s.assignedAssociateId ?? UNASSIGNED_ROW_ID}_${day}`;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
      );
    }
    return map;
  }, [shifts]);

  // Per-day totals: shift count + scheduled minutes + projected cost.
  // Powers the footer row under each day column.
  const dayTotals = useMemo(() => {
    const out = new Map<number, { count: number; minutes: number; cost: number }>();
    for (const d of [] as Date[]) void d; // (eslint scope)
    const dayKeys = Array.from({ length: 7 }).map((_, i) =>
      addDays(weekStart, i).getTime(),
    );
    for (const k of dayKeys) {
      out.set(k, { count: 0, minutes: 0, cost: 0 });
    }
    const weekStartMs = weekStart.getTime();
    const weekEndMs = addDays(weekStart, 7).getTime();
    for (const s of shifts) {
      if (s.status === 'CANCELLED') continue;
      const t = new Date(s.startsAt).getTime();
      if (t < weekStartMs || t >= weekEndMs) continue;
      const day = startOfDay(new Date(s.startsAt)).getTime();
      const entry = out.get(day);
      if (!entry) continue;
      const mins = shiftMinutes(s);
      entry.count += 1;
      entry.minutes += mins;
      if (s.payRate != null) {
        entry.cost += (s.payRate * mins) / 60;
      }
    }
    return out;
  }, [shifts, weekStart]);

  // Per-associate weekly minutes (only counting shifts in the visible week).
  const weeklyMinutes = useMemo(() => {
    const out = new Map<string, number>();
    const weekEnd = addDays(weekStart, 7).getTime();
    const weekStartMs = weekStart.getTime();
    for (const s of shifts) {
      if (!s.assignedAssociateId) continue;
      const t = new Date(s.startsAt).getTime();
      if (t < weekStartMs || t >= weekEnd) continue;
      out.set(
        s.assignedAssociateId,
        (out.get(s.assignedAssociateId) ?? 0) + shiftMinutes(s)
      );
    }
    return out;
  }, [shifts, weekStart]);

  // Decide which associate rows to render.
  // Default = those with shifts in the week (compact view).
  // showAllAssociates = the full roster (Sling default for managers).
  const visibleAssociates = useMemo(() => {
    if (showAllAssociates) return associates;
    const withShifts = new Set<string>();
    for (const s of shifts) {
      if (s.assignedAssociateId) withShifts.add(s.assignedAssociateId);
    }
    return associates.filter((a) => withShifts.has(a.id));
  }, [associates, shifts, showAllAssociates]);

  const today = startOfDay(new Date());

  const sensors = useSensors(
    // 6px activation distance — chip clicks shouldn't accidentally start a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const [movingShiftId, setMovingShiftId] = useState<string | null>(null);
  // Tracks which chip is currently being dragged so cells can render a
  // live conflict overlay (red tint) where dropping would create an
  // overlap with that associate's existing shifts on that day.
  const [activeDragShift, setActiveDragShift] = useState<Shift | null>(null);

  const handleDragStart = (e: DragStartEvent) => {
    const shiftId = String(e.active.id);
    const s = shifts.find((x) => x.id === shiftId) ?? null;
    setActiveDragShift(s);
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveDragShift(null);
    const shiftId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || !overId.startsWith('cell:')) return;
    const [, associateRaw, dayMsRaw] = overId.split(':');
    const associateId = associateRaw === UNASSIGNED_ROW_ID ? null : associateRaw;
    const dayStart = new Date(Number(dayMsRaw));

    const shift = shifts.find((s) => s.id === shiftId);
    if (!shift) return;

    // No-op if dropped on the cell it already lived in.
    const currentDay = startOfDay(new Date(shift.startsAt)).getTime();
    if (
      (shift.assignedAssociateId ?? null) === associateId &&
      currentDay === dayStart.getTime()
    ) {
      return;
    }
    setMovingShiftId(shiftId);
    try {
      await onShiftMove(shift, { associateId, dayStart });
    } finally {
      setMovingShiftId(null);
    }
  };

  // 200px sticky rail + 7 day columns. min-w on the column lets the grid
  // overflow into a horizontal scroller on narrow screens rather than
  // crushing the chips.
  const gridStyle = {
    gridTemplateColumns: `200px repeat(7, minmax(150px, 1fr))`,
  };

  // Compute the set of (associateId|unassigned)_dayMs cells that would be
  // conflicts for the currently-dragged shift. Using a Set keeps per-cell
  // lookup O(1) during the drag.
  const conflictCellKeys = useMemo(() => {
    if (!activeDragShift) return new Set<string>();
    const out = new Set<string>();
    const dragStart = new Date(activeDragShift.startsAt);
    const dragEnd = new Date(activeDragShift.endsAt);
    const dayMinutes = dragStart.getHours() * 60 + dragStart.getMinutes();
    const durationMs = dragEnd.getTime() - dragStart.getTime();

    // For each visible associate × day, simulate the drop and check for
    // overlap with that associate's other shifts on that same day. The
    // dragged shift itself is excluded so dropping it back onto its own
    // cell never lights up red.
    for (const a of visibleAssociates) {
      for (const d of days) {
        const target = new Date(d);
        target.setHours(0, 0, 0, 0);
        target.setMinutes(target.getMinutes() + dayMinutes);
        const targetEnd = new Date(target.getTime() + durationMs);
        const cellShifts = byCell.get(`${a.id}_${d.getTime()}`) ?? [];
        const conflict = cellShifts.some((s) => {
          if (s.id === activeDragShift.id) return false;
          const sStart = new Date(s.startsAt);
          const sEnd = new Date(s.endsAt);
          return sStart < targetEnd && sEnd > target;
        });
        if (conflict) out.add(`${a.id}_${d.getTime()}`);
      }
    }
    return out;
  }, [activeDragShift, visibleAssociates, days, byCell]);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDragShift(null)}
    >
      <div className="rounded-md border border-navy-secondary bg-navy/40 overflow-x-auto">
        <div className="grid min-w-[1200px]" style={gridStyle}>
          {/* ===== Header row ===== */}
          <div className="sticky left-0 z-20 bg-navy/95 backdrop-blur border-b border-r border-navy-secondary px-3 py-2 text-[10px] uppercase tracking-wider text-silver">
            Schedule
          </div>
          {days.map((d, i) => {
            const isToday = sameDay(d, today);
            return (
              <div
                key={d.toISOString()}
                className={cn(
                  'border-b border-navy-secondary px-2 py-2 sticky top-0 z-10 bg-navy/95 backdrop-blur',
                  isToday && 'bg-gold/10'
                )}
              >
                <div
                  className={cn(
                    'text-[10px] uppercase tracking-wider',
                    isToday ? 'text-gold' : 'text-silver'
                  )}
                >
                  {DAY_LABELS[i]}
                </div>
                <div
                  className={cn(
                    'text-sm tabular-nums',
                    isToday ? 'text-white font-medium' : 'text-silver'
                  )}
                >
                  {d.toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </div>
              </div>
            );
          })}

          {/* ===== Unassigned row ===== */}
          <RailCell
            label="Unassigned"
            sublabel="OPEN shifts"
            tone="warning"
          />
          {days.map((d) => (
            <Cell
              key={`u_${d.getTime()}`}
              cellId={`cell:${UNASSIGNED_ROW_ID}:${d.getTime()}`}
              shifts={byCell.get(`${UNASSIGNED_ROW_ID}_${d.getTime()}`) ?? []}
              dayStart={d}
              isToday={sameDay(d, today)}
              canManage={canManage}
              onShiftClick={onShiftClick}
              onCreate={() => onCellCreate(d, null)}
              onShiftResize={onShiftResize}
              hoverBind={hover.bind}
              onContextMenu={ctxMenu.openFor}
              movingShiftId={movingShiftId}
              selectedIds={selectedIds}
              isConflictTarget={false}
              variant="unassigned"
              onTemplateDrop={(tplId) => onTemplateDrop(tplId, d, null)}
            />
          ))}

          {/* ===== Associate rows ===== */}
          {visibleAssociates.length === 0 && (
            <div className="col-span-8 px-4 py-6 text-center text-sm text-silver/60">
              No associates have shifts this week.
            </div>
          )}
          {visibleAssociates.map((a) => {
            const mins = weeklyMinutes.get(a.id) ?? 0;
            const overTime = mins > 40 * 60;
            return (
              <Row key={a.id} associate={a} minutes={mins} overTime={overTime}>
                {days.map((d) => (
                  <Cell
                    key={`${a.id}_${d.getTime()}`}
                    cellId={`cell:${a.id}:${d.getTime()}`}
                    shifts={byCell.get(`${a.id}_${d.getTime()}`) ?? []}
                    dayStart={d}
                    isToday={sameDay(d, today)}
                    canManage={canManage}
                    onShiftClick={onShiftClick}
                    onCreate={() => onCellCreate(d, a.id)}
                    onShiftResize={onShiftResize}
                    hoverBind={hover.bind}
                    onContextMenu={ctxMenu.openFor}
                    movingShiftId={movingShiftId}
                    selectedIds={selectedIds}
                    isConflictTarget={conflictCellKeys.has(`${a.id}_${d.getTime()}`)}
                    variant="default"
                    onTemplateDrop={(tplId) => onTemplateDrop(tplId, d, a.id)}
                  />
                ))}
              </Row>
            );
          })}

          {/* ===== Day totals footer ===== */}
          <div className="sticky left-0 z-10 bg-navy/95 backdrop-blur border-t border-r border-navy-secondary px-3 py-2 text-[10px] uppercase tracking-wider text-silver/70">
            Daily total
          </div>
          {days.map((d) => {
            const t = dayTotals.get(d.getTime());
            const count = t?.count ?? 0;
            const hrs = (t?.minutes ?? 0) / 60;
            const cost = t?.cost ?? 0;
            const isToday = sameDay(d, today);
            return (
              <div
                key={`total_${d.getTime()}`}
                className={cn(
                  'border-t border-r border-navy-secondary px-2 py-2',
                  isToday && 'bg-gold/[0.03]',
                )}
              >
                {count === 0 ? (
                  <div className="text-[11px] text-silver/40">—</div>
                ) : (
                  <div className="flex items-baseline gap-2 text-[11px] tabular-nums">
                    <span className="text-white font-medium">{count}</span>
                    <span className="text-silver/60">·</span>
                    <span className="text-silver">{hrs.toFixed(1)}h</span>
                    {cost > 0 && (
                      <>
                        <span className="text-silver/60">·</span>
                        <span className="text-silver">{formatCost(cost)}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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

/* ===== Subcomponents ====================================================== */

function Row({
  associate,
  minutes,
  overTime,
  children,
}: {
  associate: AssociateLite;
  minutes: number;
  overTime: boolean;
  children: React.ReactNode;
}) {
  const initials = `${associate.firstName[0] ?? ''}${associate.lastName[0] ?? ''}`.toUpperCase();
  return (
    <>
      <div className="sticky left-0 z-10 bg-navy/95 backdrop-blur border-b border-r border-navy-secondary px-3 py-3 flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-full bg-gold/15 text-gold text-xs font-semibold flex items-center justify-center shrink-0">
          {initials || '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-white truncate">
            {associate.firstName} {associate.lastName}
          </div>
          <div className="text-[10px] tabular-nums">
            <span className={overTime ? 'text-warning' : 'text-silver/60'}>
              {(minutes / 60).toFixed(1)}h
              {overTime && ' • OT'}
            </span>
          </div>
        </div>
      </div>
      {children}
    </>
  );
}

function RailCell({
  label,
  sublabel,
  tone,
}: {
  label: string;
  sublabel?: string;
  tone?: 'warning';
}) {
  return (
    <div
      className={cn(
        'sticky left-0 z-10 backdrop-blur border-b border-r border-navy-secondary px-3 py-3',
        tone === 'warning' ? 'bg-warning/10' : 'bg-navy/95'
      )}
    >
      <div
        className={cn(
          'text-xs font-medium',
          tone === 'warning' ? 'text-warning' : 'text-white'
        )}
      >
        {label}
      </div>
      {sublabel && (
        <div className="text-[10px] uppercase tracking-wider text-silver/70">
          {sublabel}
        </div>
      )}
    </div>
  );
}

function Cell({
  cellId,
  shifts,
  dayStart: _dayStart,
  isToday,
  canManage,
  onShiftClick,
  onContextMenu,
  onCreate,
  onShiftResize,
  hoverBind,
  movingShiftId,
  selectedIds,
  isConflictTarget,
  variant,
  onTemplateDrop,
}: {
  cellId: string;
  shifts: Shift[];
  dayStart: Date;
  isToday: boolean;
  canManage: boolean;
  onShiftClick: (s: Shift, e: React.MouseEvent) => void;
  onContextMenu: (s: Shift, e: React.MouseEvent) => void;
  onCreate: () => void;
  onShiftResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  hoverBind: (s: Shift) => {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  movingShiftId: string | null;
  selectedIds: Set<string>;
  isConflictTarget: boolean;
  variant: 'default' | 'unassigned';
  onTemplateDrop: (templateId: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: cellId });
  // Native HTML5 drag from the templates rail. Independent of dnd-kit's
  // shift-move drag because the events use different APIs.
  const [tplOver, setTplOver] = useState(false);
  const onNativeDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canManage) return;
    if (!e.dataTransfer.types.includes(TEMPLATE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!tplOver) setTplOver(true);
  };
  const onNativeDragLeave = () => setTplOver(false);
  const onNativeDrop = (e: React.DragEvent<HTMLDivElement>) => {
    setTplOver(false);
    const tplId = e.dataTransfer.getData(TEMPLATE_MIME);
    if (!tplId) return;
    e.preventDefault();
    onTemplateDrop(tplId);
  };

  return (
    <div
      ref={setNodeRef}
      onDragOver={onNativeDragOver}
      onDragLeave={onNativeDragLeave}
      onDrop={onNativeDrop}
      className={cn(
        'group relative border-b border-r border-navy-secondary p-1.5 min-h-[88px]',
        'flex flex-col gap-1.5',
        isToday && 'bg-gold/[0.03]',
        // Conflict tint shows under the hover/drop highlight so the manager
        // can still see the gold "you're hovering here" outline on top.
        isConflictTarget && !isOver && 'bg-alert/15',
        isConflictTarget && isOver && 'bg-alert/30 outline outline-1 outline-alert/60 -outline-offset-1',
        !isConflictTarget && isOver && 'bg-gold/15 outline outline-1 outline-gold/40 -outline-offset-1',
        tplOver && 'bg-gold/20 outline-2 outline outline-gold/70 -outline-offset-1',
        variant === 'unassigned' && !isOver && !isConflictTarget && !tplOver && 'bg-warning/[0.04]'
      )}
    >
      {shifts.length === 0 ? (
        canManage ? (
          <button
            type="button"
            onClick={onCreate}
            className="absolute inset-0 flex items-center justify-center text-silver/30 hover:text-gold hover:bg-gold/5 transition-colors opacity-60 group-hover:opacity-100"
            aria-label="Add shift"
          >
            <Plus className="h-4 w-4" />
          </button>
        ) : null
      ) : (
        <>
          {shifts.map((s) => (
            <ShiftChip
              key={s.id}
              shift={s}
              onClick={(e) => onShiftClick(s, e)}
              onContextMenu={(e) => onContextMenu(s, e)}
              onResize={onShiftResize}
              canManage={canManage}
              isMoving={movingShiftId === s.id}
              isSelected={selectedIds.has(s.id)}
              hoverHandlers={hoverBind(s)}
            />
          ))}
          {canManage && (
            <button
              type="button"
              onClick={onCreate}
              className="text-[10px] text-silver/40 hover:text-gold inline-flex items-center justify-center gap-1 mt-auto opacity-60 group-hover:opacity-100 transition-opacity"
              aria-label="Add another shift"
            >
              <Plus className="h-3 w-3" />
              add
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ShiftChip({
  shift,
  onClick,
  onContextMenu,
  onResize,
  canManage,
  isMoving,
  isSelected,
  hoverHandlers,
}: {
  shift: Shift;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  canManage: boolean;
  isMoving: boolean;
  isSelected: boolean;
  hoverHandlers: {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: shift.id,
  });

  // Resize state. resizeDeltaPx===null = idle; otherwise we're tracking
  // the live drag and the chip shows a previewed end time.
  const [resizeDeltaPx, setResizeDeltaPx] = useState<number | null>(null);
  const startXRef = useRef<number | null>(null);

  const startsAt = new Date(shift.startsAt);
  const endsAt = new Date(shift.endsAt);
  const baseDurationMin = Math.max(
    0,
    Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000),
  );

  const previewEndsAt = useMemo(() => {
    if (resizeDeltaPx === null) return endsAt;
    const newDurationMin = Math.max(
      RESIZE_MIN_DURATION_MIN,
      Math.round(
        (baseDurationMin + resizeDeltaPx / RESIZE_PX_PER_MIN) /
          RESIZE_SNAP_MIN,
      ) * RESIZE_SNAP_MIN,
    );
    return new Date(startsAt.getTime() + newDurationMin * 60_000);
    // startsAt/endsAt are derived from shift fields; safe to depend on the raw inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizeDeltaPx, baseDurationMin, shift.startsAt]);

  // Window-level move/up so the user can drag past the chip's right edge
  // without losing the gesture.
  useEffect(() => {
    if (resizeDeltaPx === null) return;

    const onMove = (ev: MouseEvent) => {
      if (startXRef.current === null) return;
      setResizeDeltaPx(ev.clientX - startXRef.current);
    };
    const onUp = () => {
      const finalEnds = previewEndsAt;
      if (finalEnds.getTime() !== endsAt.getTime()) {
        void onResize(shift, finalEnds);
      }
      setResizeDeltaPx(null);
      startXRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizeDeltaPx, previewEndsAt, endsAt, onResize, shift]);

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    startXRef.current = e.clientX;
    setResizeDeltaPx(0);
  };

  const style: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        zIndex: 50,
      }
    : {};
  const isResizing = resizeDeltaPx !== null;
  const color = colorForPosition(shift.position);
  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        backgroundColor: color.bg,
        borderColor: color.border,
      }}
      className={cn(
        'relative rounded border transition-colors hover:brightness-125',
        isDragging && 'shadow-2xl ring-2 ring-gold/60 opacity-90',
        isResizing && 'ring-2 ring-gold/70',
        isSelected && 'ring-2 ring-gold ring-offset-1 ring-offset-navy',
        isMoving && 'opacity-50'
      )}
      onPointerEnter={hoverHandlers.onPointerEnter}
      onPointerLeave={hoverHandlers.onPointerLeave}
      onContextMenu={onContextMenu}
    >
      {isSelected && (
        <div
          aria-hidden
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-gold text-navy flex items-center justify-center text-[10px] font-bold"
        >
          ✓
        </div>
      )}
      {/* Position color accent bar — left edge, full height */}
      <div
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-1 rounded-l"
        style={{ backgroundColor: color.accent }}
      />
      {/* Drag grip — visually subtle, mouse-down here starts the drag */}
      <div
        {...listeners}
        {...attributes}
        className="absolute left-1.5 top-1.5 text-silver/40 hover:text-gold cursor-grab active:cursor-grabbing no-print"
        aria-label={`Move ${shift.position}`}
      >
        <GripVertical className="h-3 w-3" />
      </div>
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left p-1.5 pl-5 pr-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
      >
        <div className="flex items-center justify-between gap-1">
          <div className="text-[11px] text-silver tabular-nums">
            {fmtTime(shift.startsAt)}–{fmtTime(previewEndsAt.toISOString())}
          </div>
          <Badge
            variant={STATUS_VARIANT[shift.status] ?? 'default'}
            className="text-[9px] px-1 py-0"
            data-status={shift.status}
          >
            {shift.status === 'ASSIGNED'
              ? '✓'
              : shift.status === 'OPEN'
                ? '○'
                : shift.status[0]}
          </Badge>
        </div>
        <div className="text-xs text-white font-medium truncate mt-0.5">
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
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-gold/40 group no-print"
          aria-label="Drag to resize duration"
          role="slider"
          tabIndex={-1}
        >
          <div className="my-auto w-0.5 h-8 ml-0.5 mt-2 rounded-full bg-silver/30 group-hover:bg-gold" />
        </div>
      )}
    </div>
  );
}

/* ===== Week-navigation helpers (exported for the parent page) ============ */

/** Get the Monday at 00:00 local for the week containing `d`. */
export function startOfWeekMonday(d: Date): Date {
  const x = startOfDay(d);
  const dayOfWeek = (x.getDay() + 6) % 7; // Mon=0 ... Sun=6
  return addDays(x, -dayOfWeek);
}

export function endOfWeekMonday(weekStart: Date): Date {
  return addDays(weekStart, 7);
}

export function shiftWeek(weekStart: Date, weeks: number): Date {
  return addDays(weekStart, weeks * 7);
}
