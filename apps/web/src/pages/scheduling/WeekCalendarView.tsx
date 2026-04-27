import { useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Plus, GripVertical } from 'lucide-react';
import type { AssociateLite, Shift, ShiftStatus } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

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
  /** Open edit/assign sheet for a shift. */
  onShiftClick: (s: Shift) => void;
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
  showAllAssociates,
}: Props) {
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

  const handleDragEnd = async (e: DragEndEvent) => {
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

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
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
              movingShiftId={movingShiftId}
              variant="unassigned"
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
                    movingShiftId={movingShiftId}
                    variant="default"
                  />
                ))}
              </Row>
            );
          })}
        </div>
      </div>
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
  onCreate,
  movingShiftId,
  variant,
}: {
  cellId: string;
  shifts: Shift[];
  dayStart: Date;
  isToday: boolean;
  canManage: boolean;
  onShiftClick: (s: Shift) => void;
  onCreate: () => void;
  movingShiftId: string | null;
  variant: 'default' | 'unassigned';
}) {
  const { isOver, setNodeRef } = useDroppable({ id: cellId });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'group relative border-b border-r border-navy-secondary p-1.5 min-h-[88px]',
        'flex flex-col gap-1.5',
        isToday && 'bg-gold/[0.03]',
        isOver && 'bg-gold/15 outline outline-1 outline-gold/40 -outline-offset-1',
        variant === 'unassigned' && !isOver && 'bg-warning/[0.04]'
      )}
    >
      {shifts.length === 0 ? (
        canManage ? (
          <button
            type="button"
            onClick={onCreate}
            className="absolute inset-0 flex items-center justify-center text-silver/30 hover:text-gold hover:bg-gold/5 transition-colors opacity-0 group-hover:opacity-100"
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
              onClick={() => onShiftClick(s)}
              isMoving={movingShiftId === s.id}
            />
          ))}
          {canManage && (
            <button
              type="button"
              onClick={onCreate}
              className="text-[10px] text-silver/40 hover:text-gold inline-flex items-center justify-center gap-1 mt-auto opacity-0 group-hover:opacity-100 transition-opacity"
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
  isMoving,
}: {
  shift: Shift;
  onClick: () => void;
  isMoving: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: shift.id,
  });
  const style: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        zIndex: 50,
      }
    : {};
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'relative rounded border bg-navy/70 hover:bg-navy-secondary/40 transition-colors',
        'border-navy-secondary hover:border-silver/40',
        isDragging && 'shadow-2xl ring-2 ring-gold/60 opacity-90',
        isMoving && 'opacity-50'
      )}
    >
      {/* Drag grip — visually subtle, mouse-down here starts the drag */}
      <div
        {...listeners}
        {...attributes}
        className="absolute left-0.5 top-1.5 text-silver/30 hover:text-gold cursor-grab active:cursor-grabbing"
        aria-label={`Move ${shift.position}`}
      >
        <GripVertical className="h-3 w-3" />
      </div>
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left p-1.5 pl-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
      >
        <div className="flex items-center justify-between gap-1">
          <div className="text-[11px] text-silver tabular-nums">
            {fmtTime(shift.startsAt)}–{fmtTime(shift.endsAt)}
          </div>
          <Badge
            variant={STATUS_VARIANT[shift.status] ?? 'default'}
            className="text-[9px] px-1 py-0"
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
