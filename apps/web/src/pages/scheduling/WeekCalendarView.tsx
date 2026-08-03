import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useVirtualizer } from '@tanstack/react-virtual';
import { Plus, GripVertical } from 'lucide-react';
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
import { addDays, sameDay, shiftMinutes, startOfDay, ymd } from './calendarDates';
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
  RESIZE_RAIL_X,
  SHIFT_STATUS_LABEL,
  StatusMark,
  statusLabelClass,
  statusTileClass,
  useTileDensity,
} from './shiftTile';

// Week-view chips have no time axis to drag against, so resize maps
// pointer-x-pixels to minutes at a comfortable 1.5px per minute (so a
// 45px drag = 30 min). Snapped to 15-minute increments to match payroll
// rounding everywhere else.
const RESIZE_PX_PER_MIN = 1.5;
const RESIZE_SNAP_MIN = 15;
const RESIZE_MIN_DURATION_MIN = 15;

// Status is rendered by <StatusMark> (shape + screen-reader label) rather
// than a coloured letter badge — see shiftTile.tsx for why.

const UNASSIGNED_ROW_ID = '__unassigned__';

// Shared empty-cell fallback: `byCell.get(key) ?? EMPTY_SHIFTS` hands every
// empty cell the SAME array identity, so memo'd Cells with no shifts see
// referentially-equal props and skip re-rendering.
const EMPTY_SHIFTS: Shift[] = [];

function fmtTime(iso: string, timeZone?: string | null): string {
  return fmtTimeTz(iso, timeZone);
}

/**
 * Ultra-compact time for the dense Sling-style bars: "10p", "9:30a". Built
 * from Intl parts in the shift's timezone (so it respects the store zone).
 * Minutes are dropped when :00 so "10:00 PM" → "10p".
 */
function compactClock(iso: string, timeZone?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '12';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const period = (parts.find((p) => p.type === 'dayPeriod')?.value ?? 'AM')
    .toLowerCase()
    .startsWith('p')
    ? 'p'
    : 'a';
  return minute === '00' ? `${hour}${period}` : `${hour}:${minute}${period}`;
}

/** "10p–7a" — compact range for the dense week bars. */
function compactRange(
  startIso: string,
  endIso: string,
  timeZone?: string | null,
): string {
  return `${compactClock(startIso, timeZone)}–${compactClock(endIso, timeZone)}`;
}

function formatCost(n: number): string {
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

interface Props {
  shifts: Shift[];
  associates: AssociateLite[];
  weekStart: Date; // first day shown, 00:00 local (any weekday)
  /** Number of day columns to render (the start→end range). Default 7. */
  dayCount?: number;
  /** Work-site zone to bucket shifts in. null = browser-local (unchanged). */
  displayTimeZone?: string | null;
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
  /**
   * Availability/PTO shading per associate.
   *  - `dows`: day-of-week numbers (0=Sun) where the associate has ANY
   *    weekly availability window. Empty set = no data → no shading.
   *  - `blocked`: local "YYYY-MM-DD" day keys vetoed by approved PTO /
   *    availability exceptions.
   */
  availabilityFit?: Map<string, { dows: Set<number>; blocked: Set<string> }> | null;
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
  dayCount = 7,
  displayTimeZone = null,
  canManage,
  onShiftClick,
  onCellCreate,
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
  // render; route them through refs so the memo'd Cells below receive
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
    [weekStart, dayCount]
  );
  // The 7 (or dayCount) "YYYY-MM-DD" column keys, computed ONCE per render
  // instead of re-deriving ymd(d) inside every per-associate loop below.
  const dayKeys = useMemo(() => days.map(ymd), [days]);

  // Bucket shifts by associateId × store-local day. Index by
  // `${associateId|unassigned}_${YYYY-MM-DD}` (null zone → browser-local).
  const byCell = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const s of shifts) {
      const day = zonedDayKey(s.startsAt, displayTimeZone);
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
  }, [shifts, displayTimeZone]);

  // Per-day totals: shift count + scheduled minutes + projected cost.
  // Powers the footer row under each day column.
  const dayTotals = useMemo(() => {
    const out = new Map<string, { count: number; minutes: number; cost: number }>();
    for (const k of dayKeys) {
      out.set(k, { count: 0, minutes: 0, cost: 0 });
    }
    for (const s of shifts) {
      if (s.status === 'CANCELLED') continue;
      // Bucket by store-local day and let the grid's own day-set decide
      // membership (entry is undefined for days outside the visible range).
      const day = zonedDayKey(s.startsAt, displayTimeZone);
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
  }, [shifts, dayKeys, displayTimeZone]);

  // Per-associate weekly minutes (only counting shifts in the visible range).
  const weeklyMinutes = useMemo(() => {
    const out = new Map<string, number>();
    const weekEnd = addDays(weekStart, dayCount).getTime();
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
  }, [shifts, weekStart, dayCount]);

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

    // No-op if dropped on the cell it already lived in (compare in grid zone).
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

  // 200px sticky rail + N day columns. Columns flex to fill the available
  // width (minmax(0, 1fr)) so the whole selected range fits on screen without
  // horizontal scrolling; minWidth only forces a scroller once columns would
  // drop below a ~100px readable floor (very wide ranges or a small viewport),
  // so a normal 7-day week always fits.
  //
  // The grid used to be ONE element with every rail cell and day cell as a
  // direct child. That made a row unmeasurable — a row was N sibling
  // elements, not one box — which is exactly what a virtualizer needs. Rows
  // are now their own grids sharing this column template, so header, body
  // and footer still line up while each row is a single measurable element.
  const colsStyle = {
    gridTemplateColumns: `200px repeat(${dayCount}, minmax(0, 1fr))`,
  };
  const minWidthStyle = { minWidth: `${200 + dayCount * 100}px` };

  // Compute the set of (associateId|unassigned)_dayMs cells that would be
  // conflicts for the currently-dragged shift. Using a Set keeps per-cell
  // lookup O(1) during the drag.
  const conflictCellKeys = useMemo(() => {
    if (!activeDragShift) return new Set<string>();
    const out = new Set<string>();
    const dragStart = new Date(activeDragShift.startsAt);
    const dragEnd = new Date(activeDragShift.endsAt);
    const dayMinutes = zonedMinutesOfDay(dragStart, displayTimeZone);
    const durationMs = dragEnd.getTime() - dragStart.getTime();

    // For each visible associate × day, simulate the drop and check for
    // overlap with that associate's other shifts on that same day. The
    // dragged shift itself is excluded so dropping it back onto its own
    // cell never lights up red. Predict the drop in the grid's zone (null →
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
        const cellShifts = byCell.get(`${a.id}_${key}`);
        if (!cellShifts) continue;
        const conflict = cellShifts.some((s) => {
          if (s.id === activeDragShift.id) return false;
          const sStart = new Date(s.startsAt);
          const sEnd = new Date(s.endsAt);
          return sStart < targetEnd && sEnd > target;
        });
        if (conflict) out.add(`${a.id}_${key}`);
      }
    }
    return out;
  }, [activeDragShift, visibleAssociates, dayKeys, byCell, displayTimeZone]);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDragShift(null)}
    >
      <div className="rounded-md border border-navy-secondary bg-navy/40 overflow-x-auto">
        <div style={minWidthStyle}>
          {/* ===== Header row ===== */}
          <div className="grid" style={colsStyle}>
          <div className="sticky left-0 z-20 bg-navy/95 backdrop-blur border-b border-r border-navy-secondary px-3 py-2 text-2xs uppercase tracking-wider text-silver">
            Schedule
          </div>
          {days.map((d) => {
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
                    'text-2xs uppercase tracking-wider',
                    isToday ? 'text-gold' : 'text-silver'
                  )}
                >
                  {/* Derive the weekday from the date itself — the range can
                      start on any day, so a fixed Mon-first list would mislabel. */}
                  {fmtWeekdayTz(d)}
                </div>
                <div
                  className={cn(
                    'text-sm tabular-nums',
                    isToday ? 'text-white font-medium' : 'text-silver'
                  )}
                >
                  {fmtDateTz(d)}
                </div>
              </div>
            );
          })}
          </div>

          {/* ===== Unassigned row ===== */}
          <div className="grid" style={colsStyle}>
          <RailCell
            label="Unassigned"
            sublabel="OPEN shifts"
            tone="warning"
          />
          {days.map((d, i) => (
            <Cell
              key={`u_${d.getTime()}`}
              cellId={`cell:${UNASSIGNED_ROW_ID}:${d.getTime()}`}
              shifts={byCell.get(`${UNASSIGNED_ROW_ID}_${dayKeys[i]}`) ?? EMPTY_SHIFTS}
              dayStart={d}
              associateId={null}
              isToday={sameDay(d, today)}
              canManage={canManage}
              onShiftClick={onShiftClick}
              onCellCreate={onCellCreate}
              onShiftResize={onShiftResize}
              hoverBind={hoverBind}
              onContextMenu={openContextMenu}
              movingShiftId={movingShiftId}
              selectedIds={selectedIds}
              isConflictTarget={false}
              variant="unassigned"
              onTemplateDrop={onTemplateDrop}
            />
          ))}
          </div>

          {/* ===== Associate rows ===== */}
          {visibleAssociates.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-silver/70">
              No associates have shifts in this range.
            </div>
          )}
          <VirtualizedRows
            count={visibleAssociates.length}
            renderRow={(index) => {
            const a = visibleAssociates[index];
            const mins = weeklyMinutes.get(a.id) ?? 0;
            const overTime = mins > 40 * 60;
            const nearOT = !overTime && mins >= 36 * 60;
            const fit = availabilityFit?.get(a.id);
            return (
              <Row
                key={a.id}
                associate={a}
                minutes={mins}
                overTime={overTime}
                nearOT={nearOT}
                colsStyle={colsStyle}
              >
                {days.map((d, i) => {
                  const dayKey = dayKeys[i];
                  // Availability shading: PTO-blocked days beat
                  // outside-weekly-availability days. Zero windows = no
                  // data, not "unavailable everywhere" → no shading.
                  const shade: 'blocked' | 'outside' | null = fit
                    ? fit.blocked.has(dayKey)
                      ? 'blocked'
                      : fit.dows.size > 0 && !fit.dows.has(d.getDay())
                        ? 'outside'
                        : null
                    : null;
                  return (
                    <Cell
                      key={`${a.id}_${d.getTime()}`}
                      cellId={`cell:${a.id}:${d.getTime()}`}
                      shifts={byCell.get(`${a.id}_${dayKey}`) ?? EMPTY_SHIFTS}
                      dayStart={d}
                      associateId={a.id}
                      isToday={sameDay(d, today)}
                      canManage={canManage}
                      onShiftClick={onShiftClick}
                      onCellCreate={onCellCreate}
                      onShiftResize={onShiftResize}
                      hoverBind={hoverBind}
                      onContextMenu={openContextMenu}
                      movingShiftId={movingShiftId}
                      selectedIds={selectedIds}
                      isConflictTarget={conflictCellKeys.has(`${a.id}_${dayKey}`)}
                      variant="default"
                      onTemplateDrop={onTemplateDrop}
                      availabilityShade={shade}
                    />
                  );
                })}
              </Row>
            );
          }}
          />

          {/* ===== Day totals footer ===== */}
          <div className="grid" style={colsStyle}>
          <div className="sticky left-0 z-10 bg-navy/95 backdrop-blur border-t border-r border-navy-secondary px-3 py-2 text-2xs uppercase tracking-wider text-silver/70">
            Daily total
          </div>
          {days.map((d, i) => {
            const t = dayTotals.get(dayKeys[i]);
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
                  <div className="text-xs2 text-silver/70">—</div>
                ) : (
                  <div className="flex items-baseline gap-2 text-xs2 tabular-nums">
                    <span className="text-white font-medium">{count}</span>
                    <span className="text-silver/70">·</span>
                    <span className="text-silver">{hrs.toFixed(1)}h</span>
                    {cost > 0 && (
                      <>
                        <span className="text-silver/70">·</span>
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
  associate,
  minutes,
  overTime,
  nearOT,
  colsStyle,
  children,
}: {
  associate: AssociateLite;
  minutes: number;
  overTime: boolean;
  /** 36h ≤ weekly hours ≤ 40h — approaching overtime. */
  nearOT: boolean;
  /** Shared column template — every row grid matches the header's. */
  colsStyle: React.CSSProperties;
  children: React.ReactNode;
}) {
  const initials = `${associate.firstName[0] ?? ''}${associate.lastName[0] ?? ''}`.toUpperCase();
  return (
    <div className="grid" style={colsStyle}>
      <div className="sticky left-0 z-10 bg-navy/95 backdrop-blur border-b border-r border-navy-secondary px-3 py-3 flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-full bg-gold/15 text-gold text-xs font-semibold flex items-center justify-center shrink-0">
          {initials || '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-white truncate">
            {associate.firstName} {associate.lastName}
          </div>
          <div className="text-2xs tabular-nums">
            <span
              className={
                overTime || nearOT ? 'text-warning' : 'text-silver/70'
              }
              title={nearOT ? 'Near OT — 36–40h scheduled this week' : undefined}
            >
              {(minutes / 60).toFixed(1)}h
              {overTime && ' • OT'}
            </span>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
});

/**
 * Roster rows, windowed once the roster gets big.
 *
 * The grid renders one droppable per associate × day, so an org-wide view
 * at the server's 500-row page cap was mounting ~3,500 `useDroppable`
 * registrations — and dnd-kit runs collision detection against every
 * registered droppable on each drag move, so drag latency scaled with
 * roster size rather than with what's on screen.
 *
 * Below the threshold nothing changes: the plain path keeps the page as the
 * scroller, which is the familiar behaviour for a normal-sized team. Past it
 * the body becomes its own scroll container and only the visible window is
 * mounted. Rows are genuinely variable height (a day with three shifts is
 * ~3× a day with one), so each row is measured via `measureElement` rather
 * than assumed — a fixed estimate would drift the scrollbar on dense weeks.
 */
const VIRTUALIZE_ROWS_THRESHOLD = 60;
const ROW_ESTIMATE_PX = 56;
const ROW_OVERSCAN = 6;
const ROWS_CONTAINER_MAX_VH = 'max-h-[calc(100vh-320px)]';

function VirtualizedRows({
  count,
  renderRow,
}: {
  count: number;
  renderRow: (index: number) => React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: ROW_OVERSCAN,
  });

  if (count <= VIRTUALIZE_ROWS_THRESHOLD) {
    return <>{Array.from({ length: count }, (_, i) => renderRow(i))}</>;
  }

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const padTop = items.length > 0 ? items[0].start : 0;
  const padBottom =
    items.length > 0 ? totalSize - items[items.length - 1].end : 0;

  return (
    // overflow-x-clip is load-bearing, same reason as Layout.tsx:147 —
    // overflow-y:auto silently computes overflow-x to auto, which would make
    // this a horizontal scroll container too. The rail column is
    // `sticky left-0` and resolves against the nearest horizontal scroller,
    // so that would pin the rail to THIS box instead of the outer
    // overflow-x-auto and the names would stop tracking the day columns.
    // `clip` doesn't create a scroll container, so sticky still resolves out.
    <div
      ref={scrollRef}
      className={cn('overflow-y-auto overflow-x-clip', ROWS_CONTAINER_MAX_VH)}
    >
      {padTop > 0 && <div aria-hidden style={{ height: padTop }} />}
      {items.map((v) => (
        <div
          key={v.key}
          data-index={v.index}
          ref={virtualizer.measureElement}
        >
          {renderRow(v.index)}
        </div>
      ))}
      {padBottom > 0 && <div aria-hidden style={{ height: padBottom }} />}
    </div>
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
        <div className="text-2xs uppercase tracking-wider text-silver/70">
          {sublabel}
        </div>
      )}
    </div>
  );
}

const Cell = memo(function Cell({
  cellId,
  shifts,
  dayStart,
  associateId,
  isToday,
  canManage,
  onShiftClick,
  onContextMenu,
  onCellCreate,
  onShiftResize,
  hoverBind,
  movingShiftId,
  selectedIds,
  isConflictTarget,
  variant,
  onTemplateDrop,
  availabilityShade = null,
}: {
  cellId: string;
  shifts: Shift[];
  dayStart: Date;
  /** Row owner — null for the Unassigned row. */
  associateId: string | null;
  isToday: boolean;
  canManage: boolean;
  onShiftClick: (s: Shift, e: React.MouseEvent) => void;
  onContextMenu: (s: Shift, e: React.MouseEvent) => void;
  onCellCreate: (dayStart: Date, associateId: string | null) => void;
  onShiftResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  hoverBind: (s: Shift) => {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  movingShiftId: string | null;
  selectedIds: Set<string>;
  isConflictTarget: boolean;
  variant: 'default' | 'unassigned';
  onTemplateDrop: (templateId: string, dayStart: Date, associateId: string | null) => void;
  /** Availability tint (associate rows only): PTO-blocked or outside windows. */
  availabilityShade?: 'blocked' | 'outside' | null;
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
    onTemplateDrop(tplId, dayStart, associateId);
  };
  const onCreate = () => onCellCreate(dayStart, associateId);
  const cellDensity = useTileDensity();

  return (
    <div
      ref={setNodeRef}
      onDragOver={onNativeDragOver}
      onDragLeave={onNativeDragLeave}
      onDrop={onNativeDrop}
      title={
        availabilityShade === 'blocked'
          ? 'Approved time off / unavailable this day'
          : availabilityShade === 'outside'
            ? 'Outside weekly availability'
            : undefined
      }
      className={cn(
        'group relative border-b border-r border-navy-secondary p-1 min-h-[44px]',
        'flex flex-col',
        cellDensity.gap,
        isToday && 'bg-gold/[0.03]',
        // Availability/PTO tint — a passive background layer. Wins over the
        // faint "today" tint but is suppressed whenever a hover/drop/conflict
        // highlight is active so interaction states keep visual priority
        // (cn's tailwind-merge lets the last bg-* utility win).
        availabilityShade === 'blocked' &&
          !isOver && !isConflictTarget && !tplOver &&
          'bg-alert/[0.07]',
        availabilityShade === 'outside' &&
          !isOver && !isConflictTarget && !tplOver &&
          'bg-silver/[0.05]',
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
          {/* "Add another" used to be a flow child, so every occupied cell
              paid ~18px for an affordance that's only relevant on hover —
              more vertical space than a third of the shift tile it sat under.
              As an overlay it costs nothing until wanted, and the reclaimed
              room is what pays for the taller tiles. */}
          {canManage && (
            <button
              type="button"
              onClick={onCreate}
              className="absolute bottom-0.5 right-0.5 h-6 w-6 rounded-full flex items-center justify-center bg-navy-secondary/80 backdrop-blur text-silver/70 hover:text-gold hover:bg-navy-secondary opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright transition-opacity no-print"
              aria-label="Add another shift"
              title="Add another shift"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      )}
    </div>
  );
});

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
  const density = useTileDensity();
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
        density.minH,
        statusTileClass(shift.status),
        isDragging && 'elev-3 ring-2 ring-gold/60 opacity-90',
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
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-gold text-navy flex items-center justify-center text-2xs font-bold"
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
      {/* Drag grip — small icon inside a 24px hit box (WCAG 2.2 SC 2.5.8). */}
      <div
        {...listeners}
        {...attributes}
        className={cn('absolute left-0.5 top-1/2 -translate-y-1/2', GRIP_HIT)}
        aria-label={`Move ${shift.position}`}
      >
        <GripVertical className={GRIP_ICON} />
      </div>
      {/* Single-line bar: time + position, status shape pushed right. The
          client/sub-zone live in the hover card so the row stays rectangular. */}
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'w-full h-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded',
          density.padY,
          density.padX,
        )}
        title={`${fmtTime(shift.startsAt, shift.timezone)}–${fmtTime(previewEndsAt.toISOString(), shift.timezone)} · ${shift.position} · ${SHIFT_STATUS_LABEL[shift.status]}${shift.clientName ? ` · ${shift.clientName}` : ''}`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              'text-silver/90 tabular-nums shrink-0',
              density.time,
            )}
          >
            {compactRange(
              shift.startsAt,
              previewEndsAt.toISOString(),
              shift.timezone,
            )}
          </span>
          <span
            className={cn(
              'flex-1 min-w-0 text-white font-medium truncate',
              density.label,
              statusLabelClass(shift.status),
            )}
          >
            {shift.position}
          </span>
          <StatusMark status={shift.status} />
        </div>
      </button>
      {canManage && (
        <div
          onMouseDown={onResizeMouseDown}
          className={RESIZE_RAIL_X}
          title="Drag to resize duration"
          aria-hidden="true"
        >
          {/* Mouse-only drag affordance — keyboard/AT users adjust times in
              the edit dialog, so this is decoration to AT (role="slider"
              here was a lie: no value, no keyboard operation). Grip line
              scales to the bar height so it never overflows. */}
          <div className="w-0.5 h-1/2 max-h-4 rounded-full bg-silver/30 group-hover:bg-gold" />
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
