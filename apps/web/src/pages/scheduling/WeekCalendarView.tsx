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
import { VirtualizedRows } from './VirtualizedRows';
import { AlertTriangle, Plus, GripVertical, UserMinus } from 'lucide-react';
import type { AssociateLite, Shift } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { colorForPosition } from '@/lib/positionColor';
import {
  fmtDateTz,
  fmtMoneyCompact,
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
  ShiftTouchMenuButton,
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
  /** Move an associate's ROW above/below its visible neighbor (the saved
   *  whiteboard order). Undefined = reordering unavailable in this view
   *  state. `neighborId` is the row currently adjacent in the direction
   *  of travel — the anchor for the server-side move. */
  onReorderRow?: (associateId: string, neighborId: string, dir: -1 | 1) => void;
  /** Remove this associate from the ACTIVE crew filter (membership only —
   *  never touches their shifts or roster spot). Undefined = no crew
   *  filter, so rows show no remove control. */
  onRemoveFromCrew?: (associateId: string) => void;
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
  /**
   * Shifts in the loaded window that a client-side filter (position) is
   * hiding. Cells show a "N hidden" hint from these so a filtered cell
   * never reads as empty — a hidden shift still blocks the overlap check.
   */
  hiddenShifts?: Shift[];
  /** Expected concurrent floor headcount for the filtered site(s). When
   *  set, each day's footer shows peak-scheduled vs target and flags
   *  short days. */
  coverageTarget?: number | null;
  /** Tap the shortfall in a day's footer → create that many open shifts. */
  onCoverageGap?: (dayStart: Date, gap: number) => void;
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
  hiddenShifts,
  coverageTarget = null,
  onCoverageGap,
  onReorderRow,
  onRemoveFromCrew,
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

  // Short-rest ("clopen") flags: a shift starting under 10h after the same
  // associate's previous shift ends wears a fatigue marker. Client-side
  // over the loaded window — the ±1-day fetch padding covers week edges.
  const shortRestIds = useMemo(() => {
    const REST_MS = 10 * 60 * 60 * 1000;
    const byAssociate = new Map<string, Shift[]>();
    for (const s of shifts) {
      if (!s.assignedAssociateId || s.status === 'CANCELLED') continue;
      const list = byAssociate.get(s.assignedAssociateId) ?? [];
      list.push(s);
      byAssociate.set(s.assignedAssociateId, list);
    }
    const out = new Set<string>();
    for (const list of byAssociate.values()) {
      list.sort(
        (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      );
      for (let i = 1; i < list.length; i++) {
        const gap =
          new Date(list[i].startsAt).getTime() -
          new Date(list[i - 1].endsAt).getTime();
        if (gap > 0 && gap < REST_MS) out.add(list[i].id);
      }
    }
    return out;
  }, [shifts]);

  // Peak concurrent scheduled heads per day column — compared against the
  // site's floor-headcount target in the footer.
  const dayPeaks = useMemo(() => {
    const out = new Map<string, number>();
    if (coverageTarget == null) return out;
    for (const key of dayKeys) out.set(key, 0);
    const byDay = new Map<string, { at: number; delta: number }[]>();
    for (const s of shifts) {
      if (s.status === 'CANCELLED') continue;
      const key = zonedDayKey(s.startsAt, displayTimeZone);
      if (!out.has(key)) continue;
      const events = byDay.get(key) ?? [];
      events.push({ at: new Date(s.startsAt).getTime(), delta: 1 });
      events.push({ at: new Date(s.endsAt).getTime(), delta: -1 });
      byDay.set(key, events);
    }
    for (const [key, events] of byDay) {
      events.sort((a, b) => a.at - b.at || a.delta - b.delta);
      let cur = 0;
      let peak = 0;
      for (const e of events) {
        cur += e.delta;
        if (cur > peak) peak = cur;
      }
      out.set(key, peak);
    }
    return out;
  }, [shifts, dayKeys, displayTimeZone, coverageTarget]);

  // Per-cell count of filter-hidden shifts, same keying as byCell.
  const hiddenByCell = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of hiddenShifts ?? []) {
      const day = zonedDayKey(s.startsAt, displayTimeZone);
      const key = `${s.assignedAssociateId ?? UNASSIGNED_ROW_ID}_${day}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [hiddenShifts, displayTimeZone]);

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
      // effectivePayRate = explicit shift rate, else the (client, position)
      // default — so the footer lights up for shifts priced by defaults.
      const rate = s.effectivePayRate ?? s.payRate;
      if (rate != null) {
        entry.cost += (rate * mins) / 60;
      }
    }
    return out;
  }, [shifts, dayKeys, displayTimeZone]);

  // Per-associate weekly minutes — SAME membership rule as dayTotals and the
  // cells (store-zone day key inside the visible columns), so the rail badge
  // and the 36–40h overtime tint always agree with the chips on screen. The
  // old browser-local-ms window missed store-zone edge shifts that the grid
  // renders (and, since the fetch window is padded, counted padding days).
  const weeklyMinutes = useMemo(() => {
    const daySet = new Set(dayKeys);
    const out = new Map<string, number>();
    for (const s of shifts) {
      if (!s.assignedAssociateId) continue;
      if (s.status === 'CANCELLED') continue;
      if (!daySet.has(zonedDayKey(s.startsAt, displayTimeZone))) continue;
      out.set(
        s.assignedAssociateId,
        (out.get(s.assignedAssociateId) ?? 0) + shiftMinutes(s)
      );
    }
    return out;
  }, [shifts, dayKeys, displayTimeZone]);

  // Decide which associate rows to render.
  // Default = those with shifts in the VISIBLE week (compact view) — the
  // membership check keeps an associate whose only shift sits on a padded
  // fetch day from getting a phantom empty row.
  // showAllAssociates = the full roster (Sling default for managers).
  const visibleAssociates = useMemo(() => {
    if (showAllAssociates) return associates;
    const daySet = new Set(dayKeys);
    const withShifts = new Set<string>();
    for (const s of shifts) {
      if (!s.assignedAssociateId) continue;
      if (!daySet.has(zonedDayKey(s.startsAt, displayTimeZone))) continue;
      withShifts.add(s.assignedAssociateId);
    }
    return associates.filter((a) => withShifts.has(a.id));
  }, [associates, shifts, showAllAssociates, dayKeys, displayTimeZone]);

  const today = startOfDay(new Date());

  const sensors = useSensors(
    // 6px activation distance — chip clicks shouldn't accidentally start a drag.
    // Mouse: 6px activation distance so chip clicks don't start drags.
    // Touch: a hold delay so a finger SCROLLING the grid never picks a
    // shift up — 6px of drift while panning used to move shifts.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } })
  );

  const [movingShiftId, setMovingShiftId] = useState<string | null>(null);
  // Tracks which chip is currently being dragged so cells can render a
  // live conflict overlay (red tint) where dropping would create an
  // overlap with that associate's existing shifts on that day.
  const [activeDragShift, setActiveDragShift] = useState<Shift | null>(null);
  // Row-reorder drag in flight — enables the per-row drop targets (kept
  // disabled otherwise so shift drags can never land on a row by mistake).
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);

  const handleDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    if (id.startsWith('rowmove:')) {
      setDraggingRowId(id.slice('rowmove:'.length));
      return;
    }
    const s = shifts.find((x) => x.id === id) ?? null;
    setActiveDragShift(s);
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveDragShift(null);
    const activeId = String(e.active.id);
    if (activeId.startsWith('rowmove:')) {
      // Row reorder: drop anywhere on the target row — its name cell OR any
      // of its day cells (the cell id carries the associate id) — and the
      // move lands above/below that row depending on travel direction.
      setDraggingRowId(null);
      if (!onReorderRow) return;
      const moveId = activeId.slice('rowmove:'.length);
      const overId = e.over ? String(e.over.id) : null;
      if (!overId) return;
      const targetId = overId.startsWith('rowdrop:')
        ? overId.slice('rowdrop:'.length)
        : overId.startsWith('cell:')
          ? overId.split(':')[1]
          : null;
      if (!targetId || targetId === UNASSIGNED_ROW_ID || targetId === moveId) return;
      const from = visibleAssociates.findIndex((a) => a.id === moveId);
      const to = visibleAssociates.findIndex((a) => a.id === targetId);
      if (from === -1 || to === -1) return;
      onReorderRow(moveId, targetId, from < to ? 1 : -1);
      return;
    }
    const shiftId = activeId;
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
    // 248px, not 200: the always-visible reorder controls + avatar +
    // (crew ✕) squeezed long names into a ~60px sliver — the supervisor
    // couldn't tell WHO they were scheduling. The rail pays for identity.
    gridTemplateColumns: `248px repeat(${dayCount}, minmax(0, 1fr))`,
  };
  const minWidthStyle = { minWidth: `${248 + dayCount * 100}px` };

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
      onDragCancel={() => {
        setActiveDragShift(null);
        setDraggingRowId(null);
      }}
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
              hiddenCount={hiddenByCell.get(`${UNASSIGNED_ROW_ID}_${dayKeys[i]}`) ?? 0}
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
                reorderArmed={!!onReorderRow}
                rowDragActive={draggingRowId !== null}
                onRemoveFromCrew={
                  onRemoveFromCrew ? () => onRemoveFromCrew(a.id) : undefined
                }
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
                      hiddenCount={hiddenByCell.get(`${a.id}_${dayKey}`) ?? 0}
                      shortRestIds={shortRestIds}
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
                        <span className="text-silver">{fmtMoneyCompact(cost)}</span>
                      </>
                    )}
                  </div>
                )}
                {coverageTarget != null && coverageTarget > 0 && (() => {
                  const peak = dayPeaks.get(dayKeys[i]) ?? 0;
                  const gap = coverageTarget - peak;
                  return gap > 0 ? (
                    <button
                      type="button"
                      onClick={
                        onCoverageGap ? () => onCoverageGap(d, gap) : undefined
                      }
                      className="mt-0.5 text-xs2 tabular-nums text-alert hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright no-print"
                      title={`Peak ${peak} scheduled vs a floor target of ${coverageTarget} — tap to post ${gap} open shift${gap === 1 ? '' : 's'} for this day.`}
                    >
                      {peak} / {coverageTarget} · {gap} short
                    </button>
                  ) : (
                    <div
                      className="mt-0.5 text-xs2 tabular-nums text-success/80"
                      title={`Peak ${peak} scheduled vs a floor target of ${coverageTarget}.`}
                    >
                      {peak} / {coverageTarget} ✓
                    </div>
                  );
                })()}
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
  reorderArmed = false,
  rowDragActive = false,
  onRemoveFromCrew,
}: {
  associate: AssociateLite;
  minutes: number;
  overTime: boolean;
  /** 36h ≤ weekly hours ≤ 40h — approaching overtime. */
  nearOT: boolean;
  /** Shared column template — every row grid matches the header's. */
  colsStyle: React.CSSProperties;
  children: React.ReactNode;
  /** Reordering available in this view state — shows the drag grip. */
  reorderArmed?: boolean;
  /** A row drag is in flight somewhere — arms this row's drop target. */
  rowDragActive?: boolean;
  /** Remove this row's associate from the active crew filter. */
  onRemoveFromCrew?: () => void;
}) {
  const initials = `${associate.firstName[0] ?? ''}${associate.lastName[0] ?? ''}`.toUpperCase();
  // Row-reorder drag: the grip is the draggable, the name cell the drop
  // target. The droppable stays DISABLED unless a row drag is in flight so
  // shift-chip drags can never resolve onto a row target by accident.
  const rowDrag = useDraggable({
    id: `rowmove:${associate.id}`,
    disabled: !reorderArmed,
  });
  const rowDrop = useDroppable({
    id: `rowdrop:${associate.id}`,
    disabled: !rowDragActive,
  });
  const dragStyle: React.CSSProperties = rowDrag.transform
    ? {
        // Vertical-only: a roster row can move up or down, never sideways.
        transform: `translate3d(0, ${rowDrag.transform.y}px, 0)`,
        zIndex: 60,
        position: 'relative',
      }
    : {};
  return (
    <div
      className={cn('grid', rowDrag.isDragging && 'opacity-90')}
      style={{ ...colsStyle, ...dragStyle }}
    >
      <div
        ref={rowDrop.setNodeRef}
        className={cn(
          'group/row sticky left-0 z-10 bg-navy/95 backdrop-blur border-b border-r border-navy-secondary px-2.5 py-3 flex items-center gap-2',
          rowDrag.isDragging && 'ring-1 ring-gold/60',
          rowDrop.isOver && rowDragActive &&
            'bg-gold/15 outline outline-1 outline-gold/50 -outline-offset-1',
        )}
      >
        {/* The grip alone — drag is the one reorder gesture (arrows were
            redundant chrome once dragging landed, and names need the room). */}
        {reorderArmed && (
          <div
            ref={rowDrag.setNodeRef}
            {...rowDrag.listeners}
            {...rowDrag.attributes}
            className={cn(GRIP_HIT, 'shrink-0 touch-none coarse:p-1.5')}
            aria-label={`Drag to reorder ${associate.firstName} ${associate.lastName}`}
            title="Drag to reorder this row"
          >
            <GripVertical className={GRIP_ICON} />
          </div>
        )}
        <div className="h-7 w-7 rounded-full bg-gold/15 text-gold text-xs font-semibold flex items-center justify-center shrink-0">
          {initials || '?'}
        </div>
        <div className="min-w-0 flex-1">
          {/* Two lines + full-name tooltip: "Adolfo Fernando Reinoso
              Hernadez" must be identifiable, not a 6-character sliver. */}
          <div
            className="text-sm text-white leading-tight line-clamp-2 break-words"
            title={`${associate.firstName} ${associate.lastName}`}
          >
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
        {/* Crew membership: one tap takes them off the filtered crew —
            their shifts and roster spot survive; only membership changes. */}
        {onRemoveFromCrew && (
          <button
            type="button"
            onClick={onRemoveFromCrew}
            aria-label={`Remove ${associate.firstName} ${associate.lastName} from this crew`}
            title="Remove from this crew — their shifts and roster spot are untouched."
            className="shrink-0 rounded p-1 coarse:p-1.5 text-silver/40 hover:text-alert focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright no-print"
          >
            <UserMinus className="h-3.5 w-3.5 coarse:h-4 coarse:w-4" aria-hidden="true" />
          </button>
        )}
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
  hiddenCount = 0,
  shortRestIds,
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
  /** Shifts here that the position filter is hiding — never render as empty. */
  hiddenCount?: number;
  /** Shift ids with <10h rest after the associate's previous shift. */
  shortRestIds?: Set<string>;
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
        // Near-zero inset: a lone shift tile stretches to paint the whole
        // cell (flex-1 on the chip), so the cell border is the only frame.
        // Split shifts / doubles are still legal — two chips just share the
        // height in equal slices.
        'group relative border-b border-r border-navy-secondary p-0.5 min-h-[44px]',
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
        <>
          {canManage && (
            <button
              type="button"
              onClick={onCreate}
              className="absolute inset-0 flex items-center justify-center text-silver/30 hover:text-gold hover:bg-gold/5 transition-colors can-hover:opacity-60 group-hover:opacity-100"
              aria-label="Add shift"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
          {hiddenCount > 0 && <HiddenShiftsHint count={hiddenCount} />}
        </>
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
              shortRest={shortRestIds?.has(s.id) ?? false}
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
              className="absolute bottom-0.5 right-0.5 h-6 w-6 coarse:h-9 coarse:w-9 rounded-full flex items-center justify-center bg-navy-secondary/80 backdrop-blur text-silver/70 hover:text-gold hover:bg-navy-secondary can-hover:opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright transition-opacity no-print"
              aria-label="Add another shift"
              title="Add another shift"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
          {hiddenCount > 0 && <HiddenShiftsHint count={hiddenCount} />}
        </>
      )}
    </div>
  );
});

/**
 * "N hidden" marker for cells where the position filter is concealing real
 * shifts. Without it a filtered cell reads as free while the server still
 * (correctly) rejects new shifts there as overlapping — the classic
 * "the day is empty but it says Adolfo has a shift" confusion.
 */
function HiddenShiftsHint({ count }: { count: number }) {
  // Tap-to-expand: the title tooltip is unreachable on touch, so tapping
  // the marker swaps in the explanation inline (tap again to collapse).
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setExpanded((v) => !v);
      }}
      className="relative z-[1] flex w-full items-center justify-center py-0.5 text-2xs italic text-silver/50 cursor-help text-center"
      title={`${count} shift${count === 1 ? '' : 's'} hidden by the position filter — clear the filter to see ${count === 1 ? 'it' : 'them'}.`}
    >
      {expanded
        ? `${count} hidden by the position filter`
        : `${count} hidden`}
    </button>
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
  shortRest = false,
  hoverHandlers,
}: {
  shift: Shift;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onResize: (s: Shift, newEndsAt: Date) => Promise<void>;
  canManage: boolean;
  isMoving: boolean;
  isSelected: boolean;
  /** <10h rest after this associate's previous shift — fatigue marker. */
  shortRest?: boolean;
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
        // Claim the cell: a single chip fills it; stacked chips split it.
        'flex-1 flex flex-col',
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
          'w-full flex-1 flex items-center text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded',
          density.padY,
          density.padX,
          // Clear the ⋯ touch-menu trigger, which only renders sans hover.
          '[@media(hover:none)]:pr-8',
        )}
        title={`${fmtTime(shift.startsAt, shift.timezone)}–${fmtTime(previewEndsAt.toISOString(), shift.timezone)} · ${shift.position} · ${SHIFT_STATUS_LABEL[shift.status]}${shift.clientName ? ` · ${shift.clientName}` : ''}`}
      >
        <div className="w-full flex items-center gap-1.5 min-w-0">
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
          {shortRest && (
            <span
              className="shrink-0 text-warning"
              title="Short rest: under 10 hours after this associate's previous shift."
            >
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">Short rest before this shift</span>
            </span>
          )}
          <StatusMark status={shift.status} />
        </div>
      </button>
      <ShiftTouchMenuButton
        onOpen={onContextMenu}
        label={`${shift.position} shift actions`}
      />
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

/** Start of the ORG workweek (Saturday 00:00 local) containing `d` — the
 *  same Sat→Fri week payroll, the Fieldglass timesheet, and the OT math
 *  run on. The grid defaults to the week supervisors actually plan; the
 *  exported name is kept to avoid churning every caller. */
export function startOfWeekMonday(d: Date): Date {
  const x = startOfDay(d);
  const dayOfWeek = (x.getDay() + 1) % 7; // Sat=0 ... Fri=6
  return addDays(x, -dayOfWeek);
}

export function endOfWeekMonday(weekStart: Date): Date {
  return addDays(weekStart, 7);
}

export function shiftWeek(weekStart: Date, weeks: number): Date {
  return addDays(weekStart, weeks * 7);
}
