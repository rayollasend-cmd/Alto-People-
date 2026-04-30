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
import { GripVertical } from 'lucide-react';
import type { AssociateLite, Shift } from '@alto-people/shared';
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

/**
 * Phase 53.8 — time-grid week view (Sling/Outlook style).
 *
 * Difference from `WeekCalendarView`: chips are absolutely positioned
 * along a vertical hour axis instead of stacked text in a uniform-height
 * cell. The schedule reads as proportional bars — a 4h shift looks half
 * the size of an 8h shift, exactly the way managers think about coverage.
 *
 * Layout:
 *   - rows: associates (Unassigned pinned on top)
 *   - cols: 7 days
 *   - inside each day×associate cell: vertical hour ticks 6:00 → 24:00
 *   - chips: absolutely positioned by start time, sized by duration
 *
 * Interactions:
 *   - click chip      → assign/edit dialog (parent decides)
 *   - hover chip      → quick-action popover (shared with WeekCalendarView)
 *   - drag chip       → move to (associate × day), keeps time-of-day
 *   - drag bottom edge → resize duration, snaps to 15-min, vertical
 *   - click empty space in a cell → create at clicked time, snapped
 */

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Default visible window 6:00 → 24:00. Override via prop if a client runs
// 24/7 shifts. Same hour density as DayCalendarView so muscle memory
// transfers between the two views.
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 24;
const HOURS_VISIBLE = DAY_END_HOUR - DAY_START_HOUR;
// Tighter than DayCalendarView (56px/hr) — week view shows 7 days × 50
// rows so we lean toward density. 24px/hr is enough to see hour gridlines
// and accommodate a 1h chip without text clipping.
const PX_PER_HOUR = 24;
const PX_PER_MIN = PX_PER_HOUR / 60;
const TOTAL_HEIGHT = HOURS_VISIBLE * PX_PER_HOUR;
const SNAP_MIN = 15;
const MIN_DURATION_MIN = 15;
const UNASSIGNED_ROW_ID = '__unassigned__';

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
      (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 60_000,
    ),
  );
}

/** Minutes from DAY_START_HOUR (in local time) to the given Date. */
function minutesFromGridStart(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() - DAY_START_HOUR * 60;
}

function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

interface Props {
  shifts: Shift[];
  associates: AssociateLite[];
  weekStart: Date;
  canManage: boolean;
  onShiftClick: (s: Shift, e: React.MouseEvent) => void;
  onCellCreate: (start: Date, associateId: string | null) => void;
  selectedIds: Set<string>;
  onShiftMove: (
    s: Shift,
    target: { associateId: string | null; dayStart: Date },
  ) => Promise<void>;
  onShiftResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  quickActions: QuickActions;
  /** Apply a dragged-from-rail template to a specific cell. */
  onTemplateDrop: (templateId: string, dayStart: Date, associateId: string | null) => void;
  showAllAssociates: boolean;
}

export function TimeGridWeekView({
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
    [weekStart],
  );

  const byCell = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const s of shifts) {
      const day = startOfDay(new Date(s.startsAt)).getTime();
      const key = `${s.assignedAssociateId ?? UNASSIGNED_ROW_ID}_${day}`;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return map;
  }, [shifts]);

  const visibleAssociates = useMemo(() => {
    if (showAllAssociates) return associates;
    const withShifts = new Set<string>();
    for (const s of shifts) {
      if (s.assignedAssociateId) withShifts.add(s.assignedAssociateId);
    }
    return associates.filter((a) => withShifts.has(a.id));
  }, [associates, shifts, showAllAssociates]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const [movingShiftId, setMovingShiftId] = useState<string | null>(null);
  const [activeDrag, setActiveDrag] = useState<Shift | null>(null);

  const today = startOfDay(new Date());

  // Conflict overlay during drag — same logic as WeekCalendarView, just
  // checking different bucketed shifts. Only flags double-booking; PTO and
  // availability would require additional API data.
  const conflictCellKeys = useMemo(() => {
    if (!activeDrag) return new Set<string>();
    const out = new Set<string>();
    const dragStart = new Date(activeDrag.startsAt);
    const dragEnd = new Date(activeDrag.endsAt);
    const dayMinutes = dragStart.getHours() * 60 + dragStart.getMinutes();
    const durationMs = dragEnd.getTime() - dragStart.getTime();
    for (const a of visibleAssociates) {
      for (const d of days) {
        const target = new Date(d);
        target.setHours(0, 0, 0, 0);
        target.setMinutes(target.getMinutes() + dayMinutes);
        const targetEnd = new Date(target.getTime() + durationMs);
        const cell = byCell.get(`${a.id}_${d.getTime()}`) ?? [];
        const conflict = cell.some((s) => {
          if (s.id === activeDrag.id) return false;
          return (
            new Date(s.startsAt) < targetEnd && new Date(s.endsAt) > target
          );
        });
        if (conflict) out.add(`${a.id}_${d.getTime()}`);
      }
    }
    return out;
  }, [activeDrag, visibleAssociates, days, byCell]);

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveDrag(shifts.find((s) => s.id === id) ?? null);
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveDrag(null);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || !overId.startsWith('tg-cell:')) return;
    const [, associateRaw, dayMs] = overId.split(':');
    const associateId = associateRaw === UNASSIGNED_ROW_ID ? null : associateRaw;
    const dayStart = new Date(Number(dayMs));
    const shiftId = String(e.active.id);
    const shift = shifts.find((s) => s.id === shiftId);
    if (!shift) return;
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

  // 200px sticky associate rail + 40px hour gutter + 7 day columns.
  const gridStyle = {
    gridTemplateColumns: `200px 40px repeat(7, minmax(140px, 1fr))`,
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <div className="rounded-md border border-navy-secondary bg-navy/40 overflow-x-auto overscroll-x-contain">
        <div className="grid min-w-[1200px]" style={gridStyle}>
          {/* Header */}
          <div className="sticky left-0 z-20 bg-navy/95 backdrop-blur border-b border-r border-navy-secondary px-3 py-2 text-[10px] uppercase tracking-wider text-silver">
            Schedule
          </div>
          <div className="border-b border-r border-navy-secondary bg-navy/95" />
          {days.map((d, i) => {
            const isToday = sameDay(d, today);
            return (
              <div
                key={d.toISOString()}
                className={cn(
                  'border-b border-r border-navy-secondary px-2 py-2 sticky top-0 z-10 bg-navy/95 backdrop-blur',
                  isToday && 'bg-gold/10',
                )}
              >
                <div
                  className={cn(
                    'text-[10px] uppercase tracking-wider',
                    isToday ? 'text-gold' : 'text-silver',
                  )}
                >
                  {DAY_LABELS[i]}
                </div>
                <div
                  className={cn(
                    'text-sm tabular-nums',
                    isToday ? 'text-white font-medium' : 'text-silver',
                  )}
                >
                  {d.toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </div>
              </div>
            );
          })}

          {/* Unassigned row */}
          <RailCell
            label="Unassigned"
            sublabel="OPEN shifts"
            tone="warning"
          />
          <HourGutter />
          {days.map((d) => (
            <TimeCell
              key={`u_${d.getTime()}`}
              cellId={`tg-cell:${UNASSIGNED_ROW_ID}:${d.getTime()}`}
              shifts={byCell.get(`${UNASSIGNED_ROW_ID}_${d.getTime()}`) ?? []}
              dayStart={d}
              isToday={sameDay(d, today)}
              canManage={canManage}
              onShiftClick={onShiftClick}
              onCreate={onCellCreate}
              onShiftResize={onShiftResize}
              hoverBind={hover.bind}
              onContextMenu={ctxMenu.openFor}
              movingShiftId={movingShiftId}
              selectedIds={selectedIds}
              isConflictTarget={false}
              variant="unassigned"
              associateId={null}
              onTemplateDrop={(tplId) => onTemplateDrop(tplId, d, null)}
            />
          ))}

          {/* Associate rows */}
          {visibleAssociates.length === 0 && (
            <div className="col-span-9 px-4 py-6 text-center text-sm text-silver/60">
              No associates have shifts this week.
            </div>
          )}
          {visibleAssociates.map((a) => {
            const initials = `${a.firstName[0] ?? ''}${a.lastName[0] ?? ''}`.toUpperCase();
            return (
              <Row key={a.id} initials={initials} firstName={a.firstName} lastName={a.lastName}>
                <HourGutter />
                {days.map((d) => (
                  <TimeCell
                    key={`${a.id}_${d.getTime()}`}
                    cellId={`tg-cell:${a.id}:${d.getTime()}`}
                    shifts={byCell.get(`${a.id}_${d.getTime()}`) ?? []}
                    dayStart={d}
                    isToday={sameDay(d, today)}
                    canManage={canManage}
                    onShiftClick={onShiftClick}
                    onCreate={onCellCreate}
                    onShiftResize={onShiftResize}
                    hoverBind={hover.bind}
                    onContextMenu={ctxMenu.openFor}
                    movingShiftId={movingShiftId}
                    selectedIds={selectedIds}
                    isConflictTarget={conflictCellKeys.has(`${a.id}_${d.getTime()}`)}
                    variant="default"
                    associateId={a.id}
                    onTemplateDrop={(tplId) => onTemplateDrop(tplId, d, a.id)}
                  />
                ))}
              </Row>
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
  initials,
  firstName,
  lastName,
  children,
}: {
  initials: string;
  firstName: string;
  lastName: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="sticky left-0 z-10 bg-navy/95 backdrop-blur border-b border-r border-navy-secondary px-3 py-2 flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-full bg-gold/15 text-gold text-[10px] font-semibold flex items-center justify-center shrink-0">
          {initials || '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-white truncate">
            {firstName} {lastName}
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
        'sticky left-0 z-10 backdrop-blur border-b border-r border-navy-secondary px-3 py-2',
        tone === 'warning' ? 'bg-warning/10' : 'bg-navy/95',
      )}
    >
      <div
        className={cn(
          'text-xs font-medium',
          tone === 'warning' ? 'text-warning' : 'text-white',
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

function HourGutter() {
  const hours = Array.from({ length: HOURS_VISIBLE + 1 }).map(
    (_, i) => DAY_START_HOUR + i,
  );
  return (
    <div className="border-b border-r border-navy-secondary bg-navy/95 relative" style={{ height: TOTAL_HEIGHT }}>
      {hours.map((h, i) => (
        <div
          key={h}
          className="absolute right-1.5 text-[9px] text-silver/50 tabular-nums"
          style={{ top: i * PX_PER_HOUR - 5 }}
        >
          {i === 0 || i === hours.length - 1
            ? null
            : `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? 'p' : 'a'}`}
        </div>
      ))}
    </div>
  );
}

function TimeCell({
  cellId,
  shifts,
  dayStart,
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
  associateId,
  onTemplateDrop,
}: {
  cellId: string;
  shifts: Shift[];
  dayStart: Date;
  isToday: boolean;
  canManage: boolean;
  onShiftClick: (s: Shift, e: React.MouseEvent) => void;
  onContextMenu: (s: Shift, e: React.MouseEvent) => void;
  onCreate: (start: Date, associateId: string | null) => void;
  onShiftResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  hoverBind: (s: Shift) => {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  movingShiftId: string | null;
  selectedIds: Set<string>;
  isConflictTarget: boolean;
  variant: 'default' | 'unassigned';
  associateId: string | null;
  onTemplateDrop: (templateId: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: cellId });
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

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canManage) return;
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const min = snap(y / PX_PER_MIN + DAY_START_HOUR * 60);
    const start = new Date(dayStart);
    start.setHours(0, 0, 0, 0);
    start.setMinutes(start.getMinutes() + min);
    onCreate(start, associateId);
  };

  return (
    <div
      ref={setNodeRef}
      onClick={onClick}
      onDragOver={onNativeDragOver}
      onDragLeave={onNativeDragLeave}
      onDrop={onNativeDrop}
      className={cn(
        'relative border-b border-r border-navy-secondary cursor-pointer',
        isToday && 'bg-gold/[0.03]',
        isConflictTarget && !isOver && 'bg-alert/15',
        isConflictTarget && isOver && 'bg-alert/30 outline outline-1 outline-alert/60 -outline-offset-1',
        !isConflictTarget && isOver && 'bg-gold/15 outline outline-1 outline-gold/40 -outline-offset-1',
        tplOver && 'bg-gold/20 outline-2 outline outline-gold/70 -outline-offset-1',
        variant === 'unassigned' && !isOver && !isConflictTarget && !tplOver && 'bg-warning/[0.04]',
      )}
      style={{
        height: TOTAL_HEIGHT,
        backgroundImage:
          'linear-gradient(to bottom, transparent calc(100% - 1px), rgba(255,255,255,0.04) 100%)',
        backgroundSize: `100% ${PX_PER_HOUR}px`,
      }}
    >
      {shifts.map((s) => (
        <TimeChip
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
    </div>
  );
}

function TimeChip({
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

  const startsAt = new Date(shift.startsAt);
  const endsAt = new Date(shift.endsAt);
  const baseDuration = shiftMinutes(shift);
  const startMin = Math.max(0, minutesFromGridStart(startsAt));
  const top = startMin * PX_PER_MIN;
  const baseHeight = baseDuration * PX_PER_MIN;

  // Vertical resize against the hour axis. Mirrors DayCalendarView so
  // muscle memory transfers; same SNAP_MIN, same min-duration clamp.
  const [resizeDeltaPx, setResizeDeltaPx] = useState<number | null>(null);
  const startYRef = useRef<number | null>(null);

  const previewEndsAt = useMemo(() => {
    if (resizeDeltaPx === null) return endsAt;
    const newDur = Math.max(
      MIN_DURATION_MIN,
      snap(baseDuration + resizeDeltaPx / PX_PER_MIN),
    );
    return new Date(startsAt.getTime() + newDur * 60_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizeDeltaPx, baseDuration, shift.startsAt]);

  useEffect(() => {
    if (resizeDeltaPx === null) return;
    const onMove = (ev: MouseEvent) => {
      if (startYRef.current === null) return;
      setResizeDeltaPx(ev.clientY - startYRef.current);
    };
    const onUp = () => {
      const finalEnds = previewEndsAt;
      if (finalEnds.getTime() !== endsAt.getTime()) {
        void onResize(shift, finalEnds);
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
  }, [resizeDeltaPx, previewEndsAt, endsAt, onResize, shift]);

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    startYRef.current = e.clientY;
    setResizeDeltaPx(0);
  };

  const height = Math.max(
    MIN_DURATION_MIN * PX_PER_MIN,
    baseHeight + (resizeDeltaPx ?? 0),
  );

  const dragStyle: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        zIndex: 50,
      }
    : {};

  const color = colorForPosition(shift.position);
  const isResizing = resizeDeltaPx !== null;
  const compact = baseHeight < 30;

  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'absolute',
        top,
        left: 2,
        right: 2,
        height,
        backgroundColor: color.bg,
        borderColor: color.border,
        ...dragStyle,
      }}
      className={cn(
        'rounded border transition-colors hover:brightness-125 overflow-hidden',
        isDragging && 'shadow-2xl ring-2 ring-gold/60 opacity-90',
        isResizing && 'ring-2 ring-gold/70',
        isSelected && 'ring-2 ring-gold ring-offset-1 ring-offset-navy',
        isMoving && 'opacity-50',
      )}
      onPointerEnter={hoverHandlers.onPointerEnter}
      onPointerLeave={hoverHandlers.onPointerLeave}
      onContextMenu={onContextMenu}
    >
      {isSelected && (
        <div
          aria-hidden
          className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-gold text-navy flex items-center justify-center text-[9px] font-bold z-10"
        >
          ✓
        </div>
      )}
      <div
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-1"
        style={{ backgroundColor: color.accent }}
      />
      {!compact && (
        <div
          {...listeners}
          {...attributes}
          className="absolute right-0.5 top-0.5 text-silver/30 hover:text-gold cursor-grab active:cursor-grabbing no-print"
          aria-label={`Move ${shift.position}`}
        >
          <GripVertical className="h-3 w-3" />
        </div>
      )}
      {compact ? (
        // Tight 1-line layout for short shifts
        <button
          type="button"
          onClick={onClick}
          {...(compact ? { ...listeners, ...attributes } : {})}
          className="w-full h-full text-left pl-2 pr-1 flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <span className="text-[10px] text-silver tabular-nums truncate">
            {fmtTime(startsAt)}
          </span>
          <span className="text-[10px] text-white truncate">
            {shift.position}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="w-full h-full text-left pl-2 pr-4 pt-1 pb-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <div className="text-[10px] text-silver tabular-nums">
            {fmtTime(startsAt)}–{fmtTime(previewEndsAt)}
          </div>
          <div className="text-[11px] text-white font-medium truncate leading-tight">
            {shift.position}
          </div>
          {shift.assignedAssociateName && baseHeight > 50 && (
            <div className="text-[10px] text-silver/70 truncate">
              {shift.assignedAssociateName}
            </div>
          )}
        </button>
      )}
      {canManage && !compact && (
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize hover:bg-gold/40 group no-print"
          aria-label="Drag to resize duration"
          role="slider"
          tabIndex={-1}
        >
          <div className="mx-auto w-6 h-0.5 mt-0.5 rounded-full bg-silver/30 group-hover:bg-gold" />
        </div>
      )}
    </div>
  );
}
