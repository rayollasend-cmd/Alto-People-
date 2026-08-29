import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
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
  fmtDateTz,
  fmtTimeTz,
  fmtWeekdayTz,
  zonedDayKey,
  zonedMinutesOfDay,
  zonedWallTimeToUtc,
} from '@/lib/format';
import { addDays, paidShiftMinutes, sameDay, shiftMinutes, startOfDay, ymd } from './calendarDates';
import { VirtualizedRows } from './VirtualizedRows';
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
import {
  GRIP_HIT,
  GRIP_ICON,
  RESIZE_RAIL_Y,
  SHIFT_STATUS_LABEL,
  ShiftTouchMenuButton,
  StatusMark,
  statusLabelClass,
  statusTileClass,
} from './shiftTile';

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

// Shared empty-cell fallback: `byCell.get(key) ?? EMPTY_SHIFTS` hands every
// empty cell the SAME array identity, so memo'd TimeCells with no shifts see
// referentially-equal props and skip re-rendering.
const EMPTY_SHIFTS: Shift[] = [];

function fmtTime(d: Date, timeZone?: string | null): string {
  return fmtTimeTz(d, timeZone);
}

function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

/** Minutes → hours label with at most one decimal ("38.5", "40"). */
function fmtHours(min: number): string {
  return String(Math.round((min / 60) * 10) / 10);
}

interface Props {
  shifts: Shift[];
  associates: AssociateLite[];
  weekStart: Date;
  /** Number of day columns to render (the start→end range). Default 7. */
  dayCount?: number;
  /** Work-site zone to bucket/position shifts in. null = browser-local
   *  (mixed/same-zone schedules, unchanged behavior). */
  displayTimeZone?: string | null;
  canManage: boolean;
  onShiftClick: (s: Shift, e: React.MouseEvent) => void;
  onCellCreate: (start: Date, associateId: string | null) => void;
  /** Drag a vertical range in an empty cell → create with those exact
   *  times prefilled (no 4h-guess to fix afterwards). */
  onCellCreateRange?: (start: Date, end: Date, associateId: string | null) => void;
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
  /** Per-associate availability fit, keyed by associateId. `dows` = weekday
   *  numbers (0=Sun) with ANY weekly availability window; `blocked` = local
   *  "YYYY-MM-DD" day keys vetoed by approved PTO / one-off exceptions.
   *  Absent map or absent associate entry → no shading (unknown ≠ unavailable). */
  availabilityFit?: Map<string, { dows: Set<number>; blocked: Set<string> }> | null;
}

export function TimeGridWeekView({
  shifts,
  associates,
  weekStart,
  dayCount = 7,
  displayTimeZone = null,
  canManage,
  onShiftClick,
  onCellCreate,
  onCellCreateRange,
  onShiftMove,
  onShiftResize,
  quickActions,
  selectedIds,
  onTemplateDrop,
  showAllAssociates,
  availabilityFit = null,
}: Props) {
  const hover = useShiftHoverCard();
  const ctxMenu = useShiftContextMenu();
  // hover.bind / ctxMenu.openFor are recreated by their hooks on every
  // render; route them through refs so the memo'd TimeCells below receive
  // stable handler identities (they only close over setState + refs, so
  // any render's copy behaves identically).
  const hoverBindFnRef = useRef(hover.bind);
  hoverBindFnRef.current = hover.bind;
  const hoverBind = useCallback(
    (s: Shift) => hoverBindFnRef.current(s),
    [],
  );
  const ctxOpenFnRef = useRef(ctxMenu.openFor);
  ctxOpenFnRef.current = ctxMenu.openFor;
  const openContextMenu = useCallback(
    (s: Shift, e: React.MouseEvent) => ctxOpenFnRef.current(s, e),
    [],
  );
  const days = useMemo(
    () => Array.from({ length: dayCount }).map((_, i) => addDays(weekStart, i)),
    [weekStart, dayCount],
  );
  // The 7 (or dayCount) "YYYY-MM-DD" column keys, computed ONCE per render
  // instead of re-deriving ymd(d) inside every per-associate loop below.
  const dayKeys = useMemo(() => days.map(ymd), [days]);

  const byCell = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const s of shifts) {
      // Bucket by the shift's day IN THE GRID's zone so a late-night shift
      // files under its store-local column, not the viewer's. zonedDayKey
      // with a null zone === the browser-local calendar date (unchanged).
      const day = zonedDayKey(s.startsAt, displayTimeZone);
      const key = `${s.assignedAssociateId ?? UNASSIGNED_ROW_ID}_${day}`;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return map;
  }, [shifts, displayTimeZone]);

  // Scheduled minutes per associate across the visible range — same bucketing
  // rule as byCell (day key in the grid's zone must fall inside `days`), so the
  // rail total always agrees with what the cells actually show.
  const minutesByAssociate = useMemo(() => {
    const daySet = new Set(dayKeys);
    const map = new Map<string, number>();
    for (const s of shifts) {
      if (s.status === 'CANCELLED') continue;
      if (!s.assignedAssociateId) continue;
      if (!daySet.has(zonedDayKey(s.startsAt, displayTimeZone))) continue;
      map.set(
        s.assignedAssociateId,
        (map.get(s.assignedAssociateId) ?? 0) + paidShiftMinutes(s),
      );
    }
    return map;
  }, [shifts, dayKeys, displayTimeZone]);

  // Per-day footer totals: shift count + scheduled minutes (CANCELLED
  // excluded) and how many of them are unassigned OPEN shifts.
  const dayTotals = useMemo(() => {
    const map = new Map<string, { count: number; minutes: number; open: number }>();
    for (const s of shifts) {
      if (s.status === 'CANCELLED') continue;
      const key = zonedDayKey(s.startsAt, displayTimeZone);
      const t = map.get(key) ?? { count: 0, minutes: 0, open: 0 };
      t.count += 1;
      t.minutes += paidShiftMinutes(s);
      if (!s.assignedAssociateId && s.status === 'OPEN') t.open += 1;
      map.set(key, t);
    }
    return map;
  }, [shifts, displayTimeZone]);

  const visibleAssociates = useMemo(() => {
    if (showAllAssociates) return associates;
    // Membership-checked (visible columns only) so an associate whose only
    // shift sits on a padded fetch day doesn't get a phantom empty row.
    const daySet = new Set(dayKeys);
    const withShifts = new Set<string>();
    for (const s of shifts) {
      if (!s.assignedAssociateId) continue;
      if (!daySet.has(zonedDayKey(s.startsAt, displayTimeZone))) continue;
      withShifts.add(s.assignedAssociateId);
    }
    return associates.filter((a) => withShifts.has(a.id));
  }, [associates, shifts, showAllAssociates, dayKeys, displayTimeZone]);

  const sensors = useSensors(
    // Mouse: 6px activation distance so chip clicks don't start drags.
    // Touch: a hold delay so a finger SCROLLING the grid never picks a
    // shift up — 6px of drift while panning used to move shifts.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
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
    const dayMinutes = zonedMinutesOfDay(dragStart, displayTimeZone);
    const durationMs = dragEnd.getTime() - dragStart.getTime();
    // Predict the dropped instant in the grid's zone (null zone →
    // browser-local, identical to the old setHours math). The predicted
    // instant depends only on the DAY, so it's computed once per column
    // here, not once per associate × day.
    const dayDrops = dayKeys.map((key) => {
      const [yy, mm, dd] = key.split('-').map(Number);
      const target = zonedWallTimeToUtc(
        yy, mm, dd,
        Math.floor(dayMinutes / 60), dayMinutes % 60,
        displayTimeZone,
      );
      return { key, target, targetEnd: new Date(target.getTime() + durationMs) };
    });
    for (const a of visibleAssociates) {
      for (const { key, target, targetEnd } of dayDrops) {
        const cell = byCell.get(`${a.id}_${key}`);
        if (!cell) continue;
        const conflict = cell.some((s) => {
          if (s.id === activeDrag.id) return false;
          return (
            new Date(s.startsAt) < targetEnd && new Date(s.endsAt) > target
          );
        });
        if (conflict) out.add(`${a.id}_${key}`);
      }
    }
    return out;
  }, [activeDrag, visibleAssociates, dayKeys, byCell, displayTimeZone]);

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
    // Compare days in the grid's zone (null → browser-local, unchanged).
    if (
      (shift.assignedAssociateId ?? null) === associateId &&
      zonedDayKey(shift.startsAt, displayTimeZone) === ymd(dayStart)
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

  // 200px sticky associate rail + 40px hour gutter + dayCount day columns.
  // Day columns flex to fill the available width (minmax(0, 1fr)) so the whole
  // selected range fits on screen without horizontal scrolling. minWidth only
  // forces a scroller once columns would fall below a ~100px readable floor
  // (very wide ranges or a small viewport) — a normal 7-day week always fits.
  //
  // The column template lives on EACH row group (not one board-wide grid):
  // identical templates on full-width siblings align perfectly, and
  // independent block-level rows are what lets VirtualizedRows window the
  // roster — the single-grid version mounted every associate × day droppable
  // at once, so drag latency scaled with roster size (same disease the
  // pivot week view fixed).
  const colStyle = {
    gridTemplateColumns: `200px 40px repeat(${dayCount}, minmax(0, 1fr))`,
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveDrag(null)}
    >
      <div className="rounded-md border border-navy-secondary bg-navy/40 overflow-x-auto overscroll-x-contain">
        <div style={{ minWidth: `${200 + 40 + dayCount * 100}px` }}>
          {/* Header */}
          <div className="grid" style={colStyle}>
          <div className="sticky left-0 z-20 bg-navy/95 backdrop-blur border-b border-r border-navy-secondary px-3 py-2 text-2xs uppercase tracking-wider text-silver">
            Schedule
          </div>
          <div className="border-b border-r border-navy-secondary bg-navy/95" />
          {days.map((d) => {
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
                    'text-2xs uppercase tracking-wider',
                    isToday ? 'text-gold' : 'text-silver',
                  )}
                >
                  {/* Derive the weekday from the date itself — the range can
                      start on any day, so a fixed Mon-first list would mislabel. */}
                  {fmtWeekdayTz(d)}
                </div>
                <div
                  className={cn(
                    'text-sm tabular-nums',
                    isToday ? 'text-white font-medium' : 'text-silver',
                  )}
                >
                  {fmtDateTz(d)}
                </div>
              </div>
            );
          })}

          </div>

          {/* Unassigned row */}
          <div className="grid" style={colStyle}>
          <RailCell
            label="Unassigned"
            sublabel="OPEN shifts"
            tone="warning"
          />
          <HourGutter />
          {days.map((d, i) => (
            <TimeCell
              key={`u_${d.getTime()}`}
              cellId={`tg-cell:${UNASSIGNED_ROW_ID}:${d.getTime()}`}
              shifts={byCell.get(`${UNASSIGNED_ROW_ID}_${dayKeys[i]}`) ?? EMPTY_SHIFTS}
              dayStart={d}
              displayTimeZone={displayTimeZone}
              isToday={sameDay(d, today)}
              canManage={canManage}
              onShiftClick={onShiftClick}
              onCreate={onCellCreate}
              onCreateRange={onCellCreateRange}
              onShiftResize={onShiftResize}
              hoverBind={hoverBind}
              onContextMenu={openContextMenu}
              movingShiftId={movingShiftId}
              selectedIds={selectedIds}
              isConflictTarget={false}
              variant="unassigned"
              associateId={null}
              onTemplateDrop={onTemplateDrop}
            />
          ))}
          </div>

          {/* Associate rows — windowed past 60 so an org-wide roster doesn't
              mount hundreds of hour-grid cells and droppables at once. */}
          {visibleAssociates.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-silver/70">
              No associates have shifts in this range.
            </div>
          )}
          <VirtualizedRows
            count={visibleAssociates.length}
            estimateRowPx={TOTAL_HEIGHT + 2}
            renderRow={(index) => {
            const a = visibleAssociates[index];
            const initials = `${a.firstName[0] ?? ''}${a.lastName[0] ?? ''}`.toUpperCase();
            const fit = availabilityFit?.get(a.id);
            return (
              <Row
                key={a.id}
                colStyle={colStyle}
                initials={initials}
                firstName={a.firstName}
                lastName={a.lastName}
                scheduledMinutes={minutesByAssociate.get(a.id) ?? 0}
              >
                <HourGutter />
                {days.map((d, i) => {
                  const dayKey = dayKeys[i];
                  // Availability fit for this cell. PTO/exception veto beats
                  // the weekly-pattern miss; an associate with NO windows at
                  // all gets no shading (absence of data ≠ unavailable).
                  let fitStatus: 'blocked' | 'unavailable' | null = null;
                  if (fit) {
                    if (fit.blocked.has(dayKey)) fitStatus = 'blocked';
                    else if (fit.dows.size > 0 && !fit.dows.has(d.getDay())) {
                      fitStatus = 'unavailable';
                    }
                  }
                  return (
                    <TimeCell
                      key={`${a.id}_${d.getTime()}`}
                      cellId={`tg-cell:${a.id}:${d.getTime()}`}
                      shifts={byCell.get(`${a.id}_${dayKey}`) ?? EMPTY_SHIFTS}
                      dayStart={d}
                      displayTimeZone={displayTimeZone}
                      isToday={sameDay(d, today)}
                      canManage={canManage}
                      onShiftClick={onShiftClick}
                      onCreate={onCellCreate}
                      onCreateRange={onCellCreateRange}
                      onShiftResize={onShiftResize}
                      hoverBind={hoverBind}
                      onContextMenu={openContextMenu}
                      movingShiftId={movingShiftId}
                      selectedIds={selectedIds}
                      isConflictTarget={conflictCellKeys.has(`${a.id}_${dayKey}`)}
                      variant="default"
                      associateId={a.id}
                      onTemplateDrop={onTemplateDrop}
                      fitStatus={fitStatus}
                    />
                  );
                })}
              </Row>
            );
          }}
          />

          {/* Daily totals footer */}
          <div className="grid" style={colStyle}>
          <div className="sticky left-0 z-10 bg-navy/95 backdrop-blur border-t border-b border-r border-navy-secondary px-3 py-1.5 text-2xs uppercase tracking-wider text-silver/70 flex items-center">
            Daily totals
          </div>
          <div className="border-t border-b border-r border-navy-secondary bg-navy/95" />
          {days.map((d, i) => {
            const t = dayTotals.get(dayKeys[i]);
            return (
              <div
                key={`total_${d.getTime()}`}
                className="border-t border-b border-r border-navy-secondary px-1 py-1.5 text-center text-2xs tabular-nums text-silver/70"
              >
                {t ? (
                  <>
                    <span>
                      {t.count} · {fmtHours(t.minutes)}h
                    </span>
                    {t.open > 0 && (
                      <span className="text-warning"> · {t.open} open</span>
                    )}
                  </>
                ) : (
                  <span>—</span>
                )}
              </div>
            );
          })}
          </div>
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

const Row = memo(function Row({
  initials,
  firstName,
  lastName,
  scheduledMinutes,
  colStyle,
  children,
}: {
  initials: string;
  firstName: string;
  lastName: string;
  /** Scheduled (non-CANCELLED) minutes within the visible range. */
  scheduledMinutes: number;
  /** The board's shared column template — each row is its own grid so the
   *  roster can be windowed (identical templates align across siblings). */
  colStyle: React.CSSProperties;
  children: React.ReactNode;
}) {
  const hours = scheduledMinutes / 60;
  // Weekly-hours tone: at/over 40h reads as overtime, 36h+ as approaching it.
  const tone =
    hours >= 40 ? 'text-alert' : hours >= 36 ? 'text-warning' : 'text-silver/70';
  const otLabel = hours >= 40 ? 'OT' : hours >= 36 ? 'near OT' : null;
  return (
    <div className="grid" style={colStyle}>
      <div className="sticky left-0 z-10 bg-navy/95 backdrop-blur border-b border-r border-navy-secondary px-3 py-2 flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-full bg-gold/15 text-gold text-2xs font-semibold flex items-center justify-center shrink-0">
          {initials || '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-white truncate">
            {firstName} {lastName}
          </div>
          <div className={cn('text-2xs tabular-nums truncate', tone)}>
            {fmtHours(scheduledMinutes)}h
            {otLabel && (
              <span className="ml-1 uppercase tracking-wider">{otLabel}</span>
            )}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
});

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
        <div className="text-2xs uppercase tracking-wider text-silver/70">
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
          className="absolute right-1.5 text-3xs text-silver/70 tabular-nums"
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

const TimeCell = memo(function TimeCell({
  cellId,
  shifts,
  dayStart,
  displayTimeZone,
  isToday,
  canManage,
  onShiftClick,
  onContextMenu,
  onCreate,
  onCreateRange,
  onShiftResize,
  hoverBind,
  movingShiftId,
  selectedIds,
  isConflictTarget,
  variant,
  associateId,
  onTemplateDrop,
  fitStatus = null,
}: {
  cellId: string;
  shifts: Shift[];
  dayStart: Date;
  displayTimeZone: string | null;
  isToday: boolean;
  canManage: boolean;
  onShiftClick: (s: Shift, e: React.MouseEvent) => void;
  onContextMenu: (s: Shift, e: React.MouseEvent) => void;
  onCreate: (start: Date, associateId: string | null) => void;
  onCreateRange?: (start: Date, end: Date, associateId: string | null) => void;
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
  onTemplateDrop: (templateId: string, dayStart: Date, associateId: string | null) => void;
  /** Availability shading: 'blocked' = approved PTO/exception vetoes the day,
   *  'unavailable' = outside the associate's weekly windows. Lowest-priority
   *  background — never shown over drag/conflict/template tints. */
  fitStatus?: 'blocked' | 'unavailable' | null;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: cellId });
  const [tplOver, setTplOver] = useState(false);
  // Mouse drag-a-range → create a shift with those exact times. Anchor
  // lives in a ref (no re-render per move); the highlight rect is state.
  const dragAnchor = useRef<number | null>(null);
  const dragHandled = useRef(false);
  const [dragRange, setDragRange] = useState<{ a: number; b: number } | null>(null);

  const minuteAtPointer = (e: React.PointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const raw = snap(y / PX_PER_MIN + DAY_START_HOUR * 60);
    return Math.min(DAY_END_HOUR * 60, Math.max(DAY_START_HOUR * 60, raw));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canManage || !onCreateRange) return;
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    dragAnchor.current = minuteAtPointer(e);
    dragHandled.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragAnchor.current === null) return;
    const cur = minuteAtPointer(e);
    if (cur !== dragAnchor.current || dragRange) {
      setDragRange({
        a: Math.min(dragAnchor.current, cur),
        b: Math.max(dragAnchor.current, cur),
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragAnchor.current === null) return;
    const anchor = dragAnchor.current;
    const cur = minuteAtPointer(e);
    dragAnchor.current = null;
    setDragRange(null);
    const lo = Math.min(anchor, cur);
    const hi = Math.max(anchor, cur);
    if (hi - lo >= SNAP_MIN && onCreateRange) {
      // A real drag — suppress the click that follows pointerup.
      dragHandled.current = true;
      const start = new Date(dayStart);
      start.setHours(0, 0, 0, 0);
      start.setMinutes(start.getMinutes() + lo);
      const end = new Date(dayStart);
      end.setHours(0, 0, 0, 0);
      end.setMinutes(end.getMinutes() + hi);
      onCreateRange(start, end, associateId);
    }
  };
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
    onTemplateDrop(tplId, dayStart, associateId);
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canManage) return;
    if (dragHandled.current) {
      // The pointerup of a drag-create already handled this gesture.
      dragHandled.current = false;
      return;
    }
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const min = snap(y / PX_PER_MIN + DAY_START_HOUR * 60);
    const start = new Date(dayStart);
    start.setHours(0, 0, 0, 0);
    start.setMinutes(start.getMinutes() + min);
    onCreate(start, associateId);
  };

  // Keyboard equivalent of click-to-create. The pointer path derives the time
  // from Y position, which a keyboard user doesn't have, so Enter/Space opens
  // creation at the start of the visible day and the dialog sets the real
  // time. Without this the whole grid was mouse-only.
  const onCreateKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canManage) return;
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const start = new Date(dayStart);
    start.setHours(0, 0, 0, 0);
    start.setMinutes(start.getMinutes() + DAY_START_HOUR * 60);
    onCreate(start, associateId);
  };

  return (
    <div
      ref={setNodeRef}
      onClick={onClick}
      {...(canManage
        ? {
            role: 'button' as const,
            tabIndex: 0,
            // fmtWeekdayTz/fmtDateTz rather than toLocaleDateString so the
            // date reads identically to every other surface (and satisfies
            // the design-system lint rule).
            'aria-label': `Add a shift on ${fmtWeekdayTz(dayStart)}, ${fmtDateTz(dayStart)}`,
            onKeyDown: onCreateKeyDown,
          }
        : {})}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDragOver={onNativeDragOver}
      onDragLeave={onNativeDragLeave}
      onDrop={onNativeDrop}
      title={
        fitStatus === 'blocked'
          ? 'Approved time off / unavailable this day'
          : fitStatus === 'unavailable'
            ? 'Outside weekly availability'
            : undefined
      }
      className={cn(
        'relative border-b border-r border-navy-secondary cursor-pointer',
        // Focusable now that it's keyboard-operable — it needs a visible ring.
        canManage &&
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-inset',
        isToday && 'bg-gold/[0.03]',
        // Availability fit — lowest-priority tint. Listed before (and gated
        // against) the drag/conflict/template backgrounds so those always win.
        fitStatus === 'blocked' && !isOver && !isConflictTarget && !tplOver && 'bg-alert/[0.07]',
        fitStatus === 'unavailable' && !isOver && !isConflictTarget && !tplOver && 'bg-silver/[0.05]',
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
      {dragRange && (
        <div
          aria-hidden
          className="absolute left-0.5 right-0.5 z-10 rounded-sm border border-gold/60 bg-gold/20 pointer-events-none"
          style={{
            top: (dragRange.a - DAY_START_HOUR * 60) * PX_PER_MIN,
            height: Math.max(2, (dragRange.b - dragRange.a) * PX_PER_MIN),
          }}
        />
      )}
      {shifts.map((s) => (
        <TimeChip
          key={s.id}
          shift={s}
          displayTimeZone={displayTimeZone}
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
});

function TimeChip({
  shift,
  displayTimeZone,
  onClick,
  onContextMenu,
  onResize,
  canManage,
  isMoving,
  isSelected,
  hoverHandlers,
}: {
  shift: Shift;
  displayTimeZone: string | null;
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
  // Position by the shift's store-local minutes so the chip lands on the hour
  // gridline its label reads (null zone → browser-local, unchanged).
  const startMin = Math.max(
    0,
    zonedMinutesOfDay(startsAt, displayTimeZone) - DAY_START_HOUR * 60,
  );
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

  // Clip at the grid bottom so an overnight shift (e.g. 10pm–7am) doesn't
  // render a chip taller than the visible day and spill into the rows below.
  const rawHeight = Math.max(
    MIN_DURATION_MIN * PX_PER_MIN,
    baseHeight + (resizeDeltaPx ?? 0),
  );
  const clippedAtBottom = top + rawHeight > TOTAL_HEIGHT;
  const height = Math.max(
    MIN_DURATION_MIN * PX_PER_MIN,
    Math.min(rawHeight, TOTAL_HEIGHT - top),
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
        statusTileClass(shift.status),
        isDragging && 'elev-3 ring-2 ring-gold/60 opacity-90',
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
          className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-gold text-navy flex items-center justify-center text-3xs font-bold z-10"
        >
          ✓
        </div>
      )}
      <div
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-1"
        style={{ backgroundColor: color.accent }}
      />
      {clippedAtBottom && (
        <div
          aria-hidden
          className="absolute bottom-0 left-0 right-0 h-3.5 bg-gradient-to-t from-navy/80 to-transparent flex items-end justify-center pointer-events-none"
          title="Continues overnight"
        >
          <span className="text-3xs leading-none text-white mb-0.5">⌄ overnight</span>
        </div>
      )}
      {!compact && (
        <div
          {...listeners}
          {...attributes}
          className={cn('absolute right-0 top-0', GRIP_HIT)}
          aria-label={`Move ${shift.position}`}
        >
          <GripVertical className={GRIP_ICON} />
        </div>
      )}
      {compact ? (
        // Tight 1-line layout for short shifts
        <button
          type="button"
          onClick={onClick}
          {...(compact ? { ...listeners, ...attributes } : {})}
          className="w-full h-full text-left pl-2 pr-1 flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          title={`${fmtTime(startsAt, shift.timezone)}–${fmtTime(previewEndsAt, shift.timezone)} · ${shift.position} · ${SHIFT_STATUS_LABEL[shift.status]}`}
        >
          <span className="text-2xs text-silver tabular-nums truncate">
            {fmtTime(startsAt, shift.timezone)}
          </span>
          <span
            className={cn(
              'text-xs2 text-white truncate flex-1 min-w-0',
              statusLabelClass(shift.status),
            )}
          >
            {shift.position}
          </span>
          <StatusMark status={shift.status} />
        </button>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="w-full h-full text-left pl-2 pr-6 pt-1 pb-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          title={`${fmtTime(startsAt, shift.timezone)}–${fmtTime(previewEndsAt, shift.timezone)} · ${shift.position} · ${SHIFT_STATUS_LABEL[shift.status]}`}
        >
          <div className="flex items-center gap-1.5">
            <div className="text-xs2 text-silver tabular-nums truncate">
              {fmtTime(startsAt, shift.timezone)}–{fmtTime(previewEndsAt, shift.timezone)}
            </div>
            <StatusMark status={shift.status} className="ml-auto" />
          </div>
          <div
            className={cn(
              'text-xs text-white font-medium truncate leading-tight',
              statusLabelClass(shift.status),
            )}
          >
            {shift.position}
          </div>
          {shift.assignedAssociateName && baseHeight > 50 && (
            <div className="text-2xs text-silver/70 truncate">
              {shift.assignedAssociateName}
            </div>
          )}
        </button>
      )}
      {/* Compact (very short) tiles clip a 28px control against
          overflow-hidden — those fall back to tap → edit dialog. */}
      {!compact && (
        <ShiftTouchMenuButton
          onOpen={onContextMenu}
          label={`${shift.position} shift actions`}
        />
      )}
      {canManage && !compact && (
        <div
          onMouseDown={onResizeMouseDown}
          className={RESIZE_RAIL_Y}
          title="Drag to resize duration"
          aria-hidden="true"
        >
          {/* Mouse-only drag affordance — keyboard/AT users adjust times in
              the edit dialog, so this is decoration to AT (role="slider"
              here was a lie: no value, no keyboard operation). */}
          <div className="w-6 h-0.5 rounded-full bg-silver/30 group-hover:bg-gold" />
        </div>
      )}
    </div>
  );
}
