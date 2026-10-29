import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { AuthContext, useTerm } from '@/lib/auth';
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
import { AlertTriangle, ArrowDown, ArrowUp, Plus, GripVertical, UserMinus } from '@/components/ui/icons';
import { wentUnfilled, type AssociateLite, type Shift } from '@alto-people/shared';
import {
  dayIsPast,
  dropFitFor,
  hourlyCoverage,
  isCopyDrag,
  shiftTimesOnDay,
  type DropFit,
} from './weekGridFit';
import { CoverageHeatStrip } from './CoverageHeatStrip';

/** A grid row: a roster associate, or someone assigned this week who is no
 *  longer on the active roster (flagged, never silently dropped). */
type RosterRow = AssociateLite & { offRoster?: boolean };
import { cn } from '@/lib/cn';
import { useLaborCostVisible } from '@/lib/useLaborCostVisible';
import { colorForPosition } from '@/lib/positionColor';
import {
  fmtDateTz,
  fmtMoneyCompact,
  fmtTimeTz,
  fmtWeekdayTz,
  fmtCompactRange as compactRange,
  zonedDayKey,
  zonedMinutesOfDay,
  zonedWallTimeToUtc,
} from '@/lib/format';
import { addDays, paidShiftMinutes, sameDay, startOfDay, ymd } from './calendarDates';
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
import { Avatar } from '@/components/ui/Avatar';
import { associatePhotoUrl } from '@/lib/photoUrl';
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
  /** One-click group select: toggle a whole row's / day column's shifts.
   *  The parent adds all ids, or clears them when every one is already
   *  selected. Undefined = no row/column select affordance (read-only). */
  onToggleGroupSelection?: (ids: string[]) => void;
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
  /**
   * Alt/Option-drag (and ⌘V onto a cell): copy the shift to another cell —
   * same wall-clock times on the target day, assigned to the target row.
   * Undefined = the copy lands through `quickActions.onDuplicate` with the
   * target day's times (unassigned, in the Unassigned row).
   */
  onShiftCopy?: (
    s: Shift,
    target: { associateId: string | null; dayStart: Date }
  ) => Promise<void>;
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
  /** Deep-link focus: scroll this associate's row into view and ring it
   *  while set (the parent clears it after a beat). */
  highlightAssociateId?: string | null;
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
  onShiftCopy,
  quickActions,
  selectedIds,
  onToggleGroupSelection,
  onTemplateDrop,
  showAllAssociates,
  availabilityFit = null,
  hiddenShifts,
  coverageTarget = null,
  onCoverageGap,
  onReorderRow,
  onRemoveFromCrew,
  highlightAssociateId = null,
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
  // Store-bound roles never see labor cost — counts and hours only.
  const showCost = useLaborCostVisible();
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
      const mins = paidShiftMinutes(s);
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
        (out.get(s.assignedAssociateId) ?? 0) + paidShiftMinutes(s)
      );
    }
    return out;
  }, [shifts, dayKeys, displayTimeZone]);

  // The receipts behind each weekly total — hovering the hours figure
  // lists every counted shift ("Mon 10p–7a · Stocker · 8h paid [draft]").
  // A number a supervisor can't audit is a number they stop trusting.
  const weeklyBreakdown = useMemo(() => {
    const daySet = new Set(dayKeys);
    const out = new Map<string, string[]>();
    const rows: { id: string; at: number; line: string }[] = [];
    for (const s of shifts) {
      if (!s.assignedAssociateId) continue;
      if (s.status === 'CANCELLED') continue;
      if (!daySet.has(zonedDayKey(s.startsAt, displayTimeZone))) continue;
      const at = new Date(s.startsAt).getTime();
      rows.push({
        id: s.assignedAssociateId,
        at,
        line: `${fmtWeekdayTz(s.startsAt, displayTimeZone)} ${compactRange(s.startsAt, s.endsAt, displayTimeZone)} · ${s.position} · ${(paidShiftMinutes(s) / 60).toFixed(1)}h paid${s.status === 'DRAFT' ? ' [draft]' : ''}`,
      });
    }
    rows.sort((a, b) => a.at - b.at);
    for (const r of rows) {
      const list = out.get(r.id) ?? [];
      list.push(r.line);
      out.set(r.id, list);
    }
    return out;
  }, [shifts, dayKeys, displayTimeZone]);

  // Decide which associate rows to render.
  // Default = those with shifts in the VISIBLE week (compact view) — the
  // membership check keeps an associate whose only shift sits on a padded
  // fetch day from getting a phantom empty row.
  // showAllAssociates = the full roster (Sling default for managers).
  const visibleAssociates = useMemo<RosterRow[]>(() => {
    const daySet = new Set(dayKeys);
    const inView = new Map<string, string>();
    for (const s of shifts) {
      if (!s.assignedAssociateId) continue;
      if (!daySet.has(zonedDayKey(s.startsAt, displayTimeZone))) continue;
      if (!inView.has(s.assignedAssociateId)) inView.set(s.assignedAssociateId, s.assignedAssociateName ?? '');
    }
    const base = showAllAssociates ? associates : associates.filter((a) => inView.has(a.id));
    // Assigned in this week but not on the active roster — deactivated or
    // separated after these shifts, or covering from another site. Their
    // shifts still count in the day totals, so they keep a (flagged) row
    // instead of vanishing: history stays readable and a stray future
    // assignment stays visible to be re-covered.
    const rosterIds = new Set(associates.map((a) => a.id));
    const offRoster: RosterRow[] = [...inView]
      .filter(([id]) => !rosterIds.has(id))
      .map(([id, name]) => {
        const [first = '', ...rest] = name.trim().split(/\s+/);
        return { id, firstName: first, lastName: rest.join(' '), email: '', offRoster: true };
      });
    return [...base, ...offRoster];
  }, [associates, shifts, showAllAssociates, dayKeys, displayTimeZone]);

  const today = startOfDay(new Date());

  // Deep-link focus: bring the highlighted associate's row on screen once it
  // exists. One scroll per target — re-renders while the ring is up must not
  // keep yanking the viewport.
  const scrolledToRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightAssociateId) {
      scrolledToRef.current = null;
      return;
    }
    if (scrolledToRef.current === highlightAssociateId) return;
    const el = document.querySelector(
      `[data-associate-row="${highlightAssociateId}"]`,
    );
    if (!el) return; // row filtered out (or virtualized away) — no-op
    scrolledToRef.current = highlightAssociateId;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightAssociateId, visibleAssociates]);

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
  // Alt/Option held during a drag means "copy, don't move". dnd-kit only
  // hands us the activator event, so the key is tracked for the drag's
  // whole life — pressing it after the pickup still counts.
  const altHeldRef = useRef(false);
  const [copyArmed, setCopyArmed] = useState(false);
  useEffect(() => {
    if (!activeDragShift) {
      altHeldRef.current = false;
      setCopyArmed(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      altHeldRef.current = e.altKey;
      setCopyArmed(e.altKey);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [activeDragShift]);

  // A copy onto a cell: the parent's handler when it has one, else the
  // duplicate action with the target day's times (lands unassigned).
  const copyShiftTo = useCallback(
    async (shift: Shift, target: { associateId: string | null; dayStart: Date }) => {
      if (onShiftCopy) {
        await onShiftCopy(shift, target);
        return;
      }
      const times = shiftTimesOnDay(shift, ymd(target.dayStart), displayTimeZone);
      await quickActions.onDuplicate({ ...shift, ...times, assignedAssociateId: null, assignedAssociateName: null });
    },
    [onShiftCopy, quickActions, displayTimeZone],
  );

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

    // Alt/Option-drag copies: Duplicate-then-move was three clicks and a
    // drag for a chip that just needed to exist on Thursday too.
    if (isCopyDrag(e.activatorEvent, altHeldRef.current)) {
      setMovingShiftId(shiftId);
      try {
        await copyShiftTo(shift, { associateId, dayStart });
      } finally {
        setMovingShiftId(null);
      }
      return;
    }

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

  // ⌘C / ⌘V / Delete on the grid: copy the selected chips, paste them onto
  // the cell under the pointer, cancel the selection. The page-level keys
  // (← → t n) stand down on modifiers, so these never collide.
  const clipboardRef = useRef<Shift[]>([]);
  const focusedCellRef = useRef<{ associateId: string | null; dayStart: Date } | null>(null);
  const onCellPointerEnter = useCallback((dayStart: Date, associateId: string | null) => {
    focusedCellRef.current = { associateId, dayStart };
  }, []);
  const keyDepsRef = useRef({ shifts, selectedIds, canManage, copyShiftTo, quickActions });
  keyDepsRef.current = { shifts, selectedIds, canManage, copyShiftTo, quickActions };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { shifts, selectedIds, canManage, copyShiftTo, quickActions } = keyDepsRef.current;
      if (!canManage) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'c') {
        const picked = shifts.filter((s) => selectedIds.has(s.id));
        if (picked.length === 0) return;
        e.preventDefault();
        clipboardRef.current = picked;
        return;
      }
      if (meta && e.key.toLowerCase() === 'v') {
        const cell = focusedCellRef.current;
        if (!cell || clipboardRef.current.length === 0) return;
        e.preventDefault();
        for (const s of clipboardRef.current) void copyShiftTo(s, cell);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !meta) {
        const picked = shifts.filter((s) => selectedIds.has(s.id) && s.status !== 'CANCELLED' && s.status !== 'COMPLETED');
        if (picked.length === 0) return;
        e.preventDefault();
        for (const s of picked) void quickActions.onCancel(s);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Past day columns are history: dimmed, and an OPEN chip there reads
  // "Unfilled" — the shift went unfilled, nobody can be assigned now.
  const pastKeys = useMemo(() => new Set(dayKeys.filter((k) => dayIsPast(k, displayTimeZone))), [dayKeys, displayTimeZone]);

  // Headcount at the top of every hour, for the coverage strip under the
  // grid (the footer's single peak hid a mid-afternoon hole).
  const coverageByDay = useMemo(
    () => (coverageTarget != null && coverageTarget > 0 ? hourlyCoverage(shifts, dayKeys, displayTimeZone) : null),
    [shifts, dayKeys, displayTimeZone, coverageTarget],
  );

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

  // While a chip is in the air, every associate × day cell says what the
  // drop would do to that person: time off (red), outside their windows
  // (amber), or past 40h (amber "+OT"). Same data the rail badges use.
  const dropFitKeys = useMemo(() => {
    const out = new Map<string, DropFit>();
    if (!activeDragShift) return out;
    for (const a of visibleAssociates) {
      const fit = availabilityFit?.get(a.id);
      const mins = weeklyMinutes.get(a.id) ?? 0;
      days.forEach((d, i) => {
        const key = dayKeys[i];
        const f = dropFitFor({ associateId: a.id, dayKey: key, dow: d.getDay() }, activeDragShift, fit, mins);
        if (f) out.set(`${a.id}_${key}`, f);
      });
    }
    return out;
  }, [activeDragShift, visibleAssociates, availabilityFit, weeklyMinutes, days, dayKeys]);

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
          {days.map((d, i) => {
            const isToday = sameDay(d, today);
            const header = (
              <>
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
              </>
            );
            return (
              <div
                key={d.toISOString()}
                data-past={pastKeys.has(dayKeys[i]) ? 'true' : undefined}
                className={cn(
                  'border-b border-navy-secondary sticky top-0 z-10 bg-navy/95 backdrop-blur',
                  isToday && 'bg-gold/10',
                  pastKeys.has(dayKeys[i]) && 'past-day',
                )}
              >
                {onToggleGroupSelection ? (
                  // Quiet affordance: the header is also a one-click "select
                  // this day's shifts" toggle (selection shows on the chips).
                  <button
                    type="button"
                    onClick={() => {
                      const dayKey = dayKeys[i];
                      const ids: string[] = [];
                      for (const s of byCell.get(`${UNASSIGNED_ROW_ID}_${dayKey}`) ??
                        EMPTY_SHIFTS) {
                        ids.push(s.id);
                      }
                      for (const a of visibleAssociates) {
                        for (const s of byCell.get(`${a.id}_${dayKey}`) ??
                          EMPTY_SHIFTS) {
                          ids.push(s.id);
                        }
                      }
                      onToggleGroupSelection(ids);
                    }}
                    className="block w-full text-left px-2 py-2 cursor-pointer hover:bg-gold/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                    title="Click to select this day's shifts"
                  >
                    {header}
                  </button>
                ) : (
                  <div className="px-2 py-2">{header}</div>
                )}
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
              isPast={pastKeys.has(dayKeys[i])}
              canManage={canManage}
              onShiftClick={onShiftClick}
              onCellCreate={onCellCreate}
              onShiftResize={onShiftResize}
              hoverBind={hoverBind}
              onContextMenu={openContextMenu}
              onPointerEnterCell={onCellPointerEnter}
              movingShiftId={movingShiftId}
              selectedIds={selectedIds}
              isConflictTarget={false}
              variant="unassigned"
              onTemplateDrop={onTemplateDrop}
              copyArmed={copyArmed}
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
            // The visible neighbours in the saved order — the anchors the
            // ↑/↓ buttons (and the row drag) move against. Off-roster rows
            // sit outside the saved order, so they are never an anchor.
            const prevRow = visibleAssociates.slice(0, index).reverse().find((r) => !r.offRoster) ?? null;
            const nextRow = visibleAssociates.slice(index + 1).find((r) => !r.offRoster) ?? null;
            return (
              <Row
                key={a.id}
                associate={a}
                minutes={mins}
                breakdown={weeklyBreakdown.get(a.id) ?? null}
                overTime={overTime}
                nearOT={nearOT}
                highlighted={a.id === highlightAssociateId}
                colsStyle={colsStyle}
                reorderArmed={!!onReorderRow && !a.offRoster}
                onMoveUp={onReorderRow && !a.offRoster && prevRow ? () => onReorderRow(a.id, prevRow.id, -1) : undefined}
                onMoveDown={onReorderRow && !a.offRoster && nextRow ? () => onReorderRow(a.id, nextRow.id, 1) : undefined}
                rowDragActive={draggingRowId !== null}
                onRemoveFromCrew={
                  onRemoveFromCrew ? () => onRemoveFromCrew(a.id) : undefined
                }
                onSelectRow={
                  onToggleGroupSelection
                    ? () => {
                        const ids: string[] = [];
                        for (const key of dayKeys) {
                          for (const s of byCell.get(`${a.id}_${key}`) ??
                            EMPTY_SHIFTS) {
                            ids.push(s.id);
                          }
                        }
                        onToggleGroupSelection(ids);
                      }
                    : undefined
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
                      isPast={pastKeys.has(dayKey)}
                      canManage={canManage}
                      onShiftClick={onShiftClick}
                      onCellCreate={onCellCreate}
                      onShiftResize={onShiftResize}
                      hoverBind={hoverBind}
                      onContextMenu={openContextMenu}
                      onPointerEnterCell={onCellPointerEnter}
                      movingShiftId={movingShiftId}
                      selectedIds={selectedIds}
                      isConflictTarget={conflictCellKeys.has(`${a.id}_${dayKey}`)}
                      dropFit={dropFitKeys.get(`${a.id}_${dayKey}`) ?? null}
                      variant="default"
                      onTemplateDrop={onTemplateDrop}
                      availabilityShade={shade}
                      copyArmed={copyArmed}
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
                  pastKeys.has(dayKeys[i]) && 'past-day',
                )}
              >
                {count === 0 ? (
                  <div className="text-xs2 text-silver/70">—</div>
                ) : (
                  <div className="flex items-baseline gap-2 text-xs2 tabular-nums">
                    <span className="text-white font-medium">{count}</span>
                    <span className="text-silver/70">·</span>
                    <span className="text-silver">{hrs.toFixed(1)}h</span>
                    {showCost && cost > 0 && (
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
                  // A past day can't be covered any more, and the dimmed cell
                  // would drop the alert red below contrast: say it plainly.
                  if (gap > 0 && pastKeys.has(dayKeys[i])) {
                    return (
                      <div
                        className="mt-0.5 text-xs2 tabular-nums text-silver"
                        title={`Peak ${peak} scheduled vs a floor target of ${coverageTarget}.`}
                      >
                        {peak} / {coverageTarget} · {gap} short
                      </div>
                    );
                  }
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
      {coverageByDay && coverageTarget != null && (
        <div className="mt-3 no-print">
          <CoverageHeatStrip
            days={days.map((d, i) => ({
              dayKey: dayKeys[i],
              dayStart: d,
              label: `${fmtWeekdayTz(d)} ${fmtDateTz(d)}`,
              // "Sat 17" on the row: the long form wrapped to two lines.
              shortLabel: `${fmtWeekdayTz(d)} ${d.getDate()}`,
              coverage: coverageByDay.get(dayKeys[i]) ?? { scheduled: Array(24).fill(0), open: Array(24).fill(0) },
            }))}
            target={coverageTarget}
            onCoverageGap={onCoverageGap}
          />
        </div>
      )}
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
            getTopCandidates: quickActions.getTopCandidates,
            onAssignCandidate: quickActions.onAssignCandidate
              ? async (s, c) => {
                  // Close first — the flow may open confirm prompts or the
                  // AssignDialog; the card must not linger over them.
                  hover.close();
                  await quickActions.onAssignCandidate!(s, c);
                }
              : undefined,
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
  breakdown = null,
  overTime,
  nearOT,
  highlighted = false,
  colsStyle,
  children,
  reorderArmed = false,
  rowDragActive = false,
  onMoveUp,
  onMoveDown,
  onRemoveFromCrew,
  onSelectRow,
}: {
  associate: RosterRow;
  minutes: number;
  /** The counted shifts behind `minutes`, one line each — the receipts. */
  breakdown?: string[] | null;
  overTime: boolean;
  /** 36h ≤ weekly hours ≤ 40h — approaching overtime. */
  nearOT: boolean;
  /** Deep-link focus ring — the row a `?associate=` link points at. */
  highlighted?: boolean;
  /** Shared column template — every row grid matches the header's. */
  colsStyle: React.CSSProperties;
  children: React.ReactNode;
  /** Reordering available in this view state — shows the drag grip. */
  reorderArmed?: boolean;
  /** A row drag is in flight somewhere — arms this row's drop target. */
  rowDragActive?: boolean;
  /** Move this row above/below its visible neighbour — the keyboard and
   *  touch route to the saved order (the grip is drag-only). Undefined at
   *  the top/bottom of the roster. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Remove this row's associate from the active crew filter. */
  onRemoveFromCrew?: () => void;
  /** Toggle selection of every one of this row's shifts in the visible
   *  week. Undefined = name cell stays a plain label. */
  onSelectRow?: () => void;
}) {
  // Row-reorder drag: the grip is the draggable, the name cell the drop
  // target. The droppable stays DISABLED unless a row drag is in flight so
  // shift-chip drags can never resolve onto a row target by accident.
  const rowDrag = useDraggable({
    id: `rowmove:${associate.id}`,
    disabled: !reorderArmed,
  });
  const rowDrop = useDroppable({
    id: `rowdrop:${associate.id}`,
    // Off-roster rows sit outside the saved order — never a drop target.
    disabled: !rowDragActive || !!associate.offRoster,
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
      data-associate-row={associate.id}
      className={cn(
        'grid',
        rowDrag.isDragging && 'opacity-90',
        highlighted && 'ring-2 ring-inset ring-gold bg-gold/10 transition-colors',
      )}
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
        {/* The grip drags; the ↑/↓ pair under it is the same move for a
            keyboard or a finger (a drag grip alone left the saved order
            unreachable without a mouse). The pair shows on hover/focus so
            names keep the room. */}
        {reorderArmed && (
          <div className="flex shrink-0 flex-col items-center">
            <div
              ref={rowDrag.setNodeRef}
              {...rowDrag.listeners}
              {...rowDrag.attributes}
              className={cn(GRIP_HIT, 'touch-none coarse:p-1.5')}
              aria-label={`Drag to reorder ${associate.firstName} ${associate.lastName}`}
              title="Drag to reorder this row"
            >
              <GripVertical className={GRIP_ICON} />
            </div>
            <div className="flex can-hover:opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity no-print">
              <button
                type="button"
                onClick={onMoveUp}
                disabled={!onMoveUp}
                aria-label={`Move ${associate.firstName} ${associate.lastName} up`}
                title="Move this row up"
                className="rounded p-0.5 text-silver/50 hover:text-gold disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
              >
                <ArrowUp className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={onMoveDown}
                disabled={!onMoveDown}
                aria-label={`Move ${associate.firstName} ${associate.lastName} down`}
                title="Move this row down"
                className="rounded p-0.5 text-silver/50 hover:text-gold disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
              >
                <ArrowDown className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        <Avatar
          src={associatePhotoUrl(associate.id)}
          name={`${associate.firstName} ${associate.lastName}`}
          className="h-7 w-7 bg-gold/15 text-gold text-xs font-semibold"
        />
        <div className="min-w-0 flex-1">
          {/* Two lines + full-name tooltip: "Adolfo Fernando Reinoso
              Hernadez" must be identifiable, not a 6-character sliver.
              With onSelectRow the name doubles as a quiet click target that
              toggles selection of the whole row's shifts — a button (not a
              cell-wide onClick) so the drag grip and crew ✕ stay clean. */}
          {onSelectRow ? (
            <button
              type="button"
              onClick={onSelectRow}
              className="block w-full text-left text-sm text-white leading-tight line-clamp-2 break-words cursor-pointer hover:text-gold rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
              title={`${associate.firstName} ${associate.lastName} — click to select this row's shifts`}
            >
              {associate.firstName} {associate.lastName}
            </button>
          ) : (
            <div
              className="text-sm text-white leading-tight line-clamp-2 break-words"
              title={`${associate.firstName} ${associate.lastName}`}
            >
              {associate.firstName} {associate.lastName}
            </div>
          )}
          {associate.offRoster && <OffRosterNote associateId={associate.id} />}
          {/* Hours only when there are some — "0.0h" under every name was noise (F500 2026-10-26). */}
          {minutes > 0 && (
          <div className="text-2xs tabular-nums">
            <span
              className={cn(
                overTime || nearOT ? 'text-warning' : 'text-silver/70',
                breakdown && breakdown.length > 0 && 'cursor-help underline decoration-dotted decoration-silver/30 underline-offset-2',
              )}
              title={
                breakdown && breakdown.length > 0
                  ? `Counted shifts (paid hours — shifts over 6h include the 1h unpaid break):\n${breakdown.join('\n')}`
                  : nearOT
                    ? 'Near OT — 36–40h scheduled this week'
                    : undefined
              }
            >
              {(minutes / 60).toFixed(1)}h
              {overTime && ' • OT'}
            </span>
          </div>
          )}
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
  dropFit = null,
  variant,
  onTemplateDrop,
  availabilityShade = null,
  hiddenCount = 0,
  shortRestIds,
  isPast = false,
  onPointerEnterCell,
  copyArmed = false,
}: {
  cellId: string;
  shifts: Shift[];
  dayStart: Date;
  /** Row owner — null for the Unassigned row. */
  associateId: string | null;
  isToday: boolean;
  /** The day ended in the grid's zone — dimmed; its OPEN shifts went unfilled. */
  isPast?: boolean;
  /** Last cell the pointer entered — the ⌘V paste target. */
  onPointerEnterCell?: (dayStart: Date, associateId: string | null) => void;
  /** Alt/Option is held during the drag: the drop copies. */
  copyArmed?: boolean;
  /** What dropping the dragged chip here would do to this person. */
  dropFit?: DropFit | null;
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
      onPointerEnter={onPointerEnterCell ? () => onPointerEnterCell(dayStart, associateId) : undefined}
      data-drop-fit={dropFit ?? undefined}
      data-past={isPast ? 'true' : undefined}
      title={
        dropFit === 'blocked'
          ? 'Approved time off this day'
          : dropFit === 'outside'
            ? 'Outside their weekly availability'
            : dropFit === 'ot'
              ? 'Would put them past 40h this week'
              : availabilityShade === 'blocked'
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
        // Drag fit, under the conflict/hover states: red for time off,
        // amber for outside availability or past 40h.
        !isConflictTarget && !isOver && dropFit === 'blocked' && 'bg-alert/20',
        !isConflictTarget && !isOver && (dropFit === 'outside' || dropFit === 'ot') && 'bg-warning/20',
        isOver && copyArmed && 'outline-dashed',
        tplOver && 'bg-gold/20 outline-2 outline outline-gold/70 -outline-offset-1',
        variant === 'unassigned' && !isOver && !isConflictTarget && !tplOver && 'bg-warning/[0.04]',
        // Muted, not faded: a past day's shifts keep AA ink (index.css .past-day).
        isPast && 'past-day',
      )}
    >
      {dropFit === 'ot' && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0.5 right-0.5 z-[1] rounded bg-warning/80 px-1 text-2xs font-semibold text-navy"
        >
          +OT
        </span>
      )}
      {isOver && copyArmed && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0.5 left-0.5 z-[1] rounded bg-gold px-1 text-2xs font-semibold text-navy"
        >
          Copy
        </span>
      )}
      {shifts.length === 0 ? (
        <>
          {canManage && (
            <button
              type="button"
              onClick={onCreate}
              // "+" on the cell's hover or the button's focus only — ~200 of them
              // in an empty week read as a pattern, not an invitation (F500
              // 2026-10-26). Always shown on touch, where there is no hover.
              className="absolute inset-0 flex items-center justify-center text-silver/50 hover:text-gold hover:bg-gold/5 transition-[color,background-color,opacity] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright"
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

  const startsAt = useMemo(() => new Date(shift.startsAt), [shift.startsAt]);
  const endsAt = useMemo(() => new Date(shift.endsAt), [shift.endsAt]);
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
  // Ended while still OPEN: the shift went unfilled. It is history, not a
  // hole to fill — the label says so and the status mark is the record.
  const unfilled = wentUnfilled(shift);
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
        title={`${fmtTime(shift.startsAt, shift.timezone)}–${fmtTime(previewEndsAt.toISOString(), shift.timezone)} · ${shift.position} · ${unfilled ? 'Went unfilled' : SHIFT_STATUS_LABEL[shift.status]}${shift.clientName ? ` · ${shift.clientName}` : ''}`}
      >
        <div className="w-full min-w-0">
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
          {!unfilled && <StatusMark status={shift.status} />}
        </div>
        {/* "Unfilled" on its own line inside the tile — as a pill beside the
            time it pushed past the tile's edge in a narrow day. */}
        {unfilled && (
          <div className="truncate text-2xs font-medium leading-tight text-negative-800" data-testid="unfilled-tag">
            Unfilled
          </div>
        )}
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

/**
 * "Not on this store's roster" — said plainly, with the why on hover and,
 * for someone who can place people, the way to fix it: their record,
 * where "Assign to location" puts them on this store's roster.
 */
function OffRosterNote({ associateId }: { associateId: string }) {
  const canPlace = useContext(AuthContext)?.can('manage:org') ?? false;
  const inRouter = useInRouterContext();
  // The tenant's word for a site ("store", "property").
  const site = useTerm()('site').toLowerCase();
  return (
    <div
      className="text-2xs text-warning/80"
      title={`Not placed at this ${site} — deactivated, separated, or covering from another ${site}. Shown because they have shifts this week; their hours still count in the day totals.`}
      data-testid="off-roster"
    >
      Not on this {site}’s roster
      {canPlace && inRouter && (
        <>
          {' · '}
          <Link
            to={`/people?associateId=${associateId}&return=${encodeURIComponent('/scheduling')}`}
            className="underline underline-offset-2 hover:text-gold no-print"
          >
            Place here
          </Link>
        </>
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
