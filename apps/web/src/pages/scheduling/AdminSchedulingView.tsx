import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Calendar,
  Clock,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Filter,
  LayoutTemplate,
  List,
  Plus,
  Printer,
  Send,
  Sparkles,
  UserPlus,
  Wand2,
  X,
} from 'lucide-react';
import type {
  AssociateLite,
  AutoFillCandidate,
  ClientSummary,
  LocationSummary,
  Shift,
  ShiftStatus,
  ShiftSwapRequest,
  ShiftTemplate,
} from '@alto-people/shared';
import { listClientLocations } from '@/lib/clientsApi';
import { listShiftPositions } from '@/lib/orgApi';
import {
  applyShiftTemplate,
  assignShift,
  bulkCreateShifts,
  cancelShift,
  copyWeek,
  createShift,
  createShiftTemplate,
  deleteShiftTemplate,
  getAutoFillCandidates,
  getSchedulingKpis,
  getShiftConflicts,
  listAdminSwaps,
  listSchedulingAssociates,
  listShifts,
  listShiftTemplates,
  managerApproveSwap,
  managerRejectSwap,
  autoScheduleWeek,
  deleteShift,
  publishWeek,
  unassignShift,
  updateShift,
  type SchedulingKpis,
} from '@/lib/schedulingApi';
import { apiFetch, ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  fmtDateTime,
  browserTimeZone,
  tzAbbrev,
  zonedWallTimeToUtc,
  localInputToUtcIso,
  utcToZonedDatetimeInput,
  zonedDayKey,
  zonedMinutesOfDay,
} from '@/lib/format';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field, type FieldRenderArgs } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import {
  WeekCalendarView,
  shiftWeek,
  startOfWeekMonday,
} from './WeekCalendarView';
import { DayCalendarView } from './DayCalendarView';
import { TimeGridWeekView } from './TimeGridWeekView';
import { SelectionToolbar } from './SelectionToolbar';
import { TemplatesRail } from './TemplatesRail';
import { MonthCalendarView } from './MonthCalendarView';
import { MobileScheduleList } from './MobileScheduleList';
import type { LucideIcon } from 'lucide-react';

// Loads the curated shift-position names for a client (Org → Shift positions).
// null = still loading / no client picked. The dropdown in the shift dialogs
// is sourced from this; admins manage the list in org settings.
function useShiftPositionNames(clientId: string | null | undefined): string[] | null {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!clientId) {
      setNames([]);
      return;
    }
    let cancelled = false;
    setNames(null);
    listShiftPositions(clientId)
      .then((res) => {
        if (!cancelled) setNames(res.shiftPositions.map((p) => p.name));
      })
      .catch(() => {
        // Non-fatal: fall back to an empty list (the field still preserves
        // any current value and shows a "manage positions" hint).
        if (!cancelled) setNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);
  return names;
}

// Shared position dropdown for the shift create/edit/template dialogs. Sources
// options from the client's curated list, but always keeps the current value
// selectable so editing a legacy free-text shift never silently drops it.
function PositionSelect({
  value,
  onChange,
  options,
  fieldProps,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[] | null;
  fieldProps: FieldRenderArgs;
  disabled?: boolean;
}) {
  const loading = options === null;
  const list = options ?? [];
  // Preserve a current value that isn't in the catalog (legacy / renamed).
  const merged = value && !list.includes(value) ? [value, ...list] : list;
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || loading}
      {...fieldProps}
    >
      <option value="">
        {loading
          ? 'Loading…'
          : merged.length === 0
            ? 'No positions — add them in Org → Shift positions'
            : 'Select a position'}
      </option>
      {merged.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </Select>
  );
}

const STATUS_FILTERS: Array<{ value: ShiftStatus | 'ALL'; label: string }> = [
  { value: 'OPEN', label: 'Open' },
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'ALL', label: 'All' },
];

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

function fmt(iso: string): string {
  return fmtDateTime(iso);
}

/**
 * <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in *local* time.
 * `toISOString()` gives UTC and breaks the form. This builds the local
 * representation manually.
 */
function toLocalDatetimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Local HH:MM for <input type="time">. */
function toLocalTimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local YYYY-MM-DD for <input type="date"> (avoids the toISOString UTC-shift bug). */
function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse YYYY-MM-DD as a *local* midnight Date. */
function fromYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Add n calendar days to a date (local time). */
function addDaysLocal(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Whole calendar days from a → b (local midnight); negative if b precedes a. */
function daysBetweenLocal(a: Date, b: Date): number {
  const ms = fromYmd(ymd(b)).getTime() - fromYmd(ymd(a)).getTime();
  return Math.round(ms / 86_400_000);
}

// The week-view range (start day + how many days it spans) the manager picked.
// Persisted so leaving /scheduling and coming back resumes the SAME week they
// were planning, instead of snapping to the current Mon–Sun. The "This week"
// button still resets it on demand.
const WEEK_RANGE_KEY = 'alto:scheduling.weekRange.v1';
function readStoredWeekRange(): { start: Date; days: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WEEK_RANGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { start?: string; days?: number };
    if (!parsed.start) return null;
    const start = fromYmd(parsed.start);
    if (Number.isNaN(start.getTime())) return null;
    const days =
      typeof parsed.days === 'number' &&
      Number.isInteger(parsed.days) &&
      parsed.days >= 1 &&
      parsed.days <= 31
        ? parsed.days
        : 7;
    return { start, days };
  } catch {
    return null;
  }
}

// The client/location the manager narrowed the schedule to. Plain useState
// reset these to "whole org" on every remount (leave /scheduling and come
// back). Persist them so the scope survives navigation, mirroring the week
// range and layout preferences.
const FILTERS_KEY = 'alto:scheduling.filters.v1';
function readStoredFilters(): {
  client: string;
  location: string;
  status: string;
  position: string;
} | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(FILTERS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      client?: string;
      location?: string;
      status?: string;
      position?: string;
    };
    return {
      client: typeof parsed.client === 'string' ? parsed.client : '',
      location: typeof parsed.location === 'string' ? parsed.location : '',
      status: typeof parsed.status === 'string' ? parsed.status : '',
      position: typeof parsed.position === 'string' ? parsed.position : '',
    };
  } catch {
    return null;
  }
}

// The view anchors (day/month being viewed + the list-view date range). Like
// the filters and week range, these were plain useState seeded from `new
// Date()`, so any navigation away reset day/month/list views to "now". Persist
// them so each view resumes where it was left. The Today/This-month buttons
// still reset on demand.
const ANCHORS_KEY = 'alto:scheduling.anchors.v1';
function readStoredAnchors(): {
  day?: string;
  month?: string;
  listFrom?: string;
  listTo?: string;
} | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ANCHORS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return {
      day: str(p.day),
      month: str(p.month),
      listFrom: str(p.listFrom),
      listTo: str(p.listTo),
    };
  } catch {
    return null;
  }
}

/* ----- CSV / file-download helpers (Phase 54.3) -------------------------- */

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // RFC 4180: quote anything containing a delimiter, quote, or newline; double inner quotes.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(s: Shift): Array<string | number | null> {
  const start = new Date(s.startsAt);
  const end = new Date(s.endsAt);
  const hours = (s.scheduledMinutes / 60).toFixed(2);
  return [
    start.toLocaleDateString(),
    start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    hours,
    s.position,
    s.clientName ?? '',
    s.location ?? '',
    s.assignedAssociateName ?? '',
    s.status,
    s.hourlyRate ?? '',
    s.notes ?? '',
  ];
}

function downloadBlob(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Human-readable single-line date range — "April 2026", "Apr 1 – Apr 7, 2026", or "Apr 12, 2026". */
function fmtPrintRange(from: string, to: string): string {
  const f = fromYmd(from);
  const t = fromYmd(to);
  if (from === to) {
    return f.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  }
  // Whole-month detection: from is the 1st, to is the last day, same year+month.
  if (
    f.getFullYear() === t.getFullYear() &&
    f.getMonth() === t.getMonth() &&
    f.getDate() === 1
  ) {
    const lastOfMonth = new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate();
    if (t.getDate() === lastOfMonth) {
      return f.toLocaleDateString([], { month: 'long', year: 'numeric' });
    }
  }
  const sameYear = f.getFullYear() === t.getFullYear();
  const left = f.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  const right = t.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  return `${left} – ${right}`;
}

interface AdminSchedulingViewProps {
  canManage: boolean;
}

type ViewMode = 'list' | 'day' | 'week' | 'month';

const VIEWS: ViewMode[] = ['list', 'day', 'week', 'month'];
const VIEW_KEY = 'alto:scheduling.view.v1';

function parseView(raw: string | null): ViewMode {
  return (VIEWS as string[]).includes(raw ?? '') ? (raw as ViewMode) : 'list';
}

export function AdminSchedulingView({ canManage }: AdminSchedulingViewProps) {
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  // View mode persists in the URL so deep links stay stable.
  const view: ViewMode = parseView(searchParams.get('view'));
  const setView = (v: ViewMode) => {
    const next = new URLSearchParams(searchParams);
    if (v === 'list') next.delete('view');
    else next.set('view', v);
    setSearchParams(next, { replace: true });
    if (typeof window !== 'undefined') window.localStorage.setItem(VIEW_KEY, v);
  };
  // The view lives in the URL for deep-linking, but returning to /scheduling
  // via a fresh nav link carries no ?view= and would snap back to the default
  // (list) even if the manager was on week. Restore the last-used view from
  // localStorage when the URL doesn't specify one, so week/day/month survive
  // navigation like the other filters. Runs once on mount; the URL still wins
  // for an explicit deep link or back-button.
  useEffect(() => {
    if (searchParams.get('view')) return;
    if (typeof window === 'undefined') return;
    const stored = parseView(window.localStorage.getItem(VIEW_KEY));
    if (stored !== 'list') setView(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Week-view layout: time-grid (Sling/Outlook style) vs compact (text rows).
  // Persisted in localStorage so the manager's preference sticks across visits.
  // Default to the dense compact (Sling-style) bars — single-line shift
  // rectangles pack far more onto the screen than the time-grid's
  // duration-proportional blocks. The toggle still offers time-grid. Key is
  // versioned (.v2) so the new default takes effect once for everyone.
  const [weekLayout, setWeekLayout] = useState<'time-grid' | 'compact'>(() => {
    if (typeof window === 'undefined') return 'compact';
    const stored = window.localStorage.getItem('alto:scheduling.weekLayout.v2');
    return stored === 'time-grid' ? 'time-grid' : 'compact';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('alto:scheduling.weekLayout.v2', weekLayout);
  }, [weekLayout]);

  const [filter, setFilter] = useState<ShiftStatus | 'ALL'>(() => {
    const s = readStoredFilters()?.status;
    const valid = ['ALL', 'OPEN', 'ASSIGNED', 'DRAFT', 'COMPLETED', 'CANCELLED'];
    return s && valid.includes(s) ? (s as ShiftStatus | 'ALL') : 'OPEN';
  });
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  // True when the server capped the result — the visible list is a prefix, not
  // the whole match set. Drives a "narrow your range" banner in list view.
  const [listTruncated, setListTruncated] = useState(false);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [associates, setAssociates] = useState<AssociateLite[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createInitialDate, setCreateInitialDate] = useState<Date | null>(null);
  const [createInitialAssociateId, setCreateInitialAssociateId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Calendar filter bar — cascading "full schedule" narrowing.
  //   clientFilter   '' = every client (the full org schedule, the default)
  //   locationFilter '' = every location under the chosen client; otherwise a
  //                  real Location id (only selectable once a client is set).
  //   posFilter      exact position match (picked from a dropdown of the
  //                  positions in the schedule), AND-combined client-side.
  // client + location are filtered server-side; position is client-side.
  const [posFilter, setPosFilter] = useState<string>(
    () => readStoredFilters()?.position ?? '',
  );
  const [clientFilter, setClientFilter] = useState<string>(
    () => readStoredFilters()?.client ?? '',
  ); // '' = all
  const [locationFilter, setLocationFilter] = useState<string>(
    () => readStoredFilters()?.location ?? '',
  ); // '' = all
  // Persist the scope + status chip so they survive navigating away and back.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      FILTERS_KEY,
      JSON.stringify({
        client: clientFilter,
        location: locationFilter,
        status: filter,
        position: posFilter,
      }),
    );
  }, [clientFilter, locationFilter, filter, posFilter]);
  // Locations belonging to the currently-selected client, for the cascade.
  // null = loading; [] = client has none (or no client selected).
  const [clientLocations, setClientLocations] = useState<LocationSummary[]>([]);
  const [showAllAssociates, setShowAllAssociates] = useState<boolean>(true);

  // Week-view range. weekStart is the FIRST day shown (any day, not forced
  // to Monday) and weekDayCount is how many days the grid spans — so the
  // user picks an exact start and end. Defaults to the Mon–Sun week (7
  // days) so existing behavior is unchanged until they widen/move it.
  const [weekStart, setWeekStart] = useState<Date>(
    () => readStoredWeekRange()?.start ?? startOfWeekMonday(new Date()),
  );
  const [weekDayCount, setWeekDayCount] = useState<number>(
    () => readStoredWeekRange()?.days ?? 7,
  );
  // Persist the picked range so it survives navigating away and back.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      WEEK_RANGE_KEY,
      JSON.stringify({ start: ymd(weekStart), days: weekDayCount }),
    );
  }, [weekStart, weekDayCount]);
  const weekEnd = useMemo(
    () => addDaysLocal(weekStart, weekDayCount),
    [weekStart, weekDayCount],
  );
  // Inclusive last day shown (for the end date-picker value).
  const weekEndInclusive = useMemo(
    () => addDaysLocal(weekStart, weekDayCount - 1),
    [weekStart, weekDayCount],
  );

  // Day-view anchor (defaults to today, or the last day viewed). Independent
  // of weekStart so the user can have a "calendar week" they're planning AND a
  // "today" zoom.
  const [dayAnchor, setDayAnchor] = useState<Date>(() => {
    const stored = readStoredAnchors()?.day;
    if (stored) {
      const d = fromYmd(stored);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Month-view anchor (first of month, or the last month viewed).
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => {
    const stored = readStoredAnchors()?.month;
    if (stored) {
      const d = fromYmd(stored);
      if (!Number.isNaN(d.getTime())) {
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        return d;
      }
    }
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Phase 54.2 — list-view date range (defaults to the current month, or the
  // last range used). When either bound is empty the field is treated as
  // unbounded on that side.
  const [listFrom, setListFrom] = useState<string>(() => {
    const stored = readStoredAnchors();
    if (stored && stored.listFrom !== undefined) return stored.listFrom;
    const d = new Date();
    d.setDate(1);
    return ymd(d);
  });
  const [listTo, setListTo] = useState<string>(() => {
    const stored = readStoredAnchors();
    if (stored && stored.listTo !== undefined) return stored.listTo;
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    d.setDate(0); // last day of current month
    return ymd(d);
  });

  // Persist the anchors + list range so each view resumes where it was left.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      ANCHORS_KEY,
      JSON.stringify({
        day: ymd(dayAnchor),
        month: ymd(monthAnchor),
        listFrom,
        listTo,
      }),
    );
  }, [dayAnchor, monthAnchor, listFrom, listTo]);

  // Phase 54.4 — PDF export pending flag.
  const [exportingPdf, setExportingPdf] = useState(false);

  // KPI strip — always pulls the *current* week regardless of which week
  // the calendar is showing, so the "right now" signal stays consistent.
  const [kpis, setKpis] = useState<SchedulingKpis | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [copyingWeek, setCopyingWeek] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [autoScheduling, setAutoScheduling] = useState(false);
  // Bulk selection: shift/cmd/ctrl-click chips to add them. Stored as a
  // Set so adds and toggles are O(1); rebuilt on every selection change.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const onCopyWeekToNext = async () => {
    if (copyingWeek) return;
    if (!window.confirm('Copy every non-cancelled shift from this week into next week as drafts?')) return;
    setCopyingWeek(true);
    try {
      const target = shiftWeek(weekStart, 1);
      const result = await copyWeek({
        sourceWeekStart: weekStart.toISOString(),
        targetWeekStart: target.toISOString(),
      });
      toast.success(
        result.created === 0
          ? 'Nothing to copy — this week is empty.'
          : `Copied ${result.created} shift${result.created === 1 ? '' : 's'} to next week (DRAFT).`
      );
      // Hop to the target week so HR can review the new drafts immediately.
      setWeekStart(target);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Copy failed.');
    } finally {
      setCopyingWeek(false);
    }
  };
  // The KPI strip is always "this week" stats. `shifts` changing is a proxy for
  // "something happened" — but it also fires on every week/day navigation
  // (which doesn't change this-week data) and on every keystroke-free filter
  // change, so naively it double-fetched on every action. Debounce so a burst
  // (bulk action, rapid paging) collapses to one request, and guard with a
  // sequence id so a slow earlier response can't overwrite a newer one.
  const kpiSeq = useRef(0);
  useEffect(() => {
    const seq = ++kpiSeq.current;
    const t = window.setTimeout(() => {
      getSchedulingKpis()
        .then((k) => {
          if (seq === kpiSeq.current) setKpis(k);
        })
        .catch(() => {
          if (seq === kpiSeq.current) setKpis(null);
        });
    }, 300);
    return () => window.clearTimeout(t);
  }, [shifts]);

  // Dialog state — replaces window.prompt + window.confirm.
  const [assignTarget, setAssignTarget] = useState<Shift | null>(null);
  // Shift being edited (date/time/position/rates) — null = closed.
  const [editTarget, setEditTarget] = useState<Shift | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Shift | null>(null);
  // Source shift for the "Duplicate to employee…" picker (null = closed).
  const [duplicateSource, setDuplicateSource] = useState<Shift | null>(null);
  const [autoFillForShift, setAutoFillForShift] = useState<{
    shiftId: string;
    candidates: AutoFillCandidate[];
  } | null>(null);

  // Monotonic request id: a newer refresh() supersedes any in-flight one, so
  // a slow earlier response can't land last and repaint stale shifts (rapid
  // week paging, or a mutation's refresh racing a navigation's).
  const reqSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      // Calendar views load the visible window; list view honors the status
      // filter chips. Position/client/location filters apply client-side
      // because they're cheap and lets the calendar respond instantly.
      let args: Parameters<typeof listShifts>[0] = {};
      if (view === 'week') {
        args = { from: weekStart.toISOString(), to: weekEnd.toISOString() };
      } else if (view === 'day') {
        const dayEnd = new Date(dayAnchor);
        dayEnd.setDate(dayEnd.getDate() + 1);
        args = { from: dayAnchor.toISOString(), to: dayEnd.toISOString() };
      } else if (view === 'month') {
        // The month grid renders a full 6-week window (the Monday on/before
        // the 1st through 42 days), so it shows trailing days of the prev/next
        // month. Fetch that whole VISIBLE range — not just [1st, 1st-of-next)
        // — or shifts on those adjacent-month cells render blank.
        const gridStart = startOfWeekMonday(monthAnchor);
        const gridEnd = addDaysLocal(gridStart, 42);
        args = { from: gridStart.toISOString(), to: gridEnd.toISOString() };
      } else {
        args = filter === 'ALL' ? {} : { status: filter };
        // Phase 54.2 — list view honors a date range alongside the status
        // filter. Empty bounds = unbounded on that side.
        if (listFrom) {
          args = { ...args, from: fromYmd(listFrom).toISOString() };
        }
        if (listTo) {
          // Inclusive end-of-day: send the *next* day at 00:00 as the exclusive
          // upper bound (server uses `lt`), capturing the full last day.
          const end = fromYmd(listTo);
          end.setDate(end.getDate() + 1);
          args = { ...args, to: end.toISOString() };
        }
      }
      if (clientFilter) args = { ...args, clientId: clientFilter };
      // Location only narrows within a client (a Location belongs to one).
      if (clientFilter && locationFilter) {
        args = { ...args, locationId: locationFilter };
      }
      const res = await listShifts(args);
      // A newer request started while we were awaiting → discard this result.
      if (seq !== reqSeq.current) return;
      setShifts(res.shifts);
      setListTruncated(res.truncated ?? false);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      const msg = err instanceof ApiError ? err.message : 'Failed to load shifts.';
      toast.error(msg);
    }
  }, [filter, view, weekStart, weekEnd, dayAnchor, monthAnchor, clientFilter, locationFilter, listFrom, listTo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!canManage) return;
    (async () => {
      try {
        const res = await apiFetch<{ clients: ClientSummary[] }>('/clients');
        setClients(res.clients);
      } catch {
        // Silent — Create form falls back to free-text Client UUID entry.
      }
    })();
  }, [canManage]);

  // Associate list for the pivot grid Y axis — scoped to the selected
  // client/location so the rows match the filtered schedule (picking a
  // client now narrows the people shown, not just the shifts).
  useEffect(() => {
    if (!canManage) return;
    listSchedulingAssociates({
      clientId: clientFilter || undefined,
      locationId: (clientFilter && locationFilter) || undefined,
    })
      .then((res) => setAssociates(res.associates))
      .catch(() => setAssociates([]));
  }, [canManage, clientFilter, locationFilter]);

  // Cascade: when the client narrows, load THAT client's locations for the
  // location dropdown and clear any stale location selection. Selecting
  // "All clients" (the full schedule) empties the location list — a
  // location only has meaning within one client.
  //
  // The clear must NOT run on the initial mount: we restore client+location
  // from localStorage, and an unconditional reset here would wipe the
  // restored location before the user ever touches the filter. Skip the
  // first run; only clear when the user actually switches clients afterward.
  const cascadeMounted = useRef(false);
  useEffect(() => {
    if (cascadeMounted.current) {
      setLocationFilter('');
    } else {
      cascadeMounted.current = true;
    }
    if (!clientFilter) {
      setClientLocations([]);
      return;
    }
    let cancelled = false;
    listClientLocations(clientFilter)
      .then((r) => {
        if (!cancelled) setClientLocations(r.locations);
      })
      .catch(() => {
        if (!cancelled) setClientLocations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientFilter]);

  // Position is the only client-side narrowing left — client and location
  // are both filtered server-side (clientId + locationId params). Exact
  // (case/space-insensitive) match against the picked dropdown value.
  const filteredShifts = useMemo(() => {
    if (!shifts) return shifts;
    const pos = posFilter.trim().toLowerCase();
    if (!pos) return shifts;
    return shifts.filter((s) => s.position.trim().toLowerCase() === pos);
  }, [shifts, posFilter]);

  // The distinct positions actually used in the loaded schedule — drives the
  // position filter dropdown (Sling-style: pick from what you've scheduled
  // instead of retyping free text). Deduped case-insensitively, keeping the
  // first-seen casing. The active selection is kept in the list even if its
  // shifts scrolled out of the loaded window, so the dropdown stays valid.
  const knownPositions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of shifts ?? []) {
      const p = s.position.trim();
      if (!p) continue;
      const k = p.toLowerCase();
      if (!seen.has(k)) seen.set(k, p);
    }
    const cur = posFilter.trim();
    if (cur && !seen.has(cur.toLowerCase())) seen.set(cur.toLowerCase(), cur);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [shifts, posFilter]);

  // Shift times render in the work-site's timezone. When the viewer isn't
  // sitting in that zone (e.g. a remote/HQ manager), label it so nobody
  // misreads a 10 PM shift as their own 7 PM. Only shown on a real mismatch.
  const tzHint = useMemo(() => {
    if (!filteredShifts || filteredShifts.length === 0) return null;
    const zones = new Set(filteredShifts.map((s) => s.timezone).filter(Boolean));
    if (zones.size === 0) return null;
    const viewer = browserTimeZone();
    if (zones.size === 1) {
      const zone = [...zones][0]!;
      if (zone === viewer) return null; // viewer is at the store — no note
      return `Times shown in ${tzAbbrev(zone)} (store local time).`;
    }
    // Mixed locations (full-org schedule across timezones).
    if (zones.size > 1) {
      return 'Times shown in each location’s local time.';
    }
    return null;
  }, [filteredShifts]);

  // The zone the calendar grid should bucket day-columns and position chips in.
  // Only meaningful when the visible schedule resolves to ONE work-site zone
  // (a location filter, or a single-site client). Returns null — meaning
  // "use the browser zone, unchanged behavior" — when the schedule is empty,
  // spans MULTIPLE zones (full-org view, no single right answer), or the one
  // zone IS the viewer's. So the grid only switches to store-zone math for a
  // remote admin viewing a single other-zone site; everyone else is untouched.
  const gridTimeZone = useMemo(() => {
    if (!filteredShifts || filteredShifts.length === 0) return null;
    const zones = new Set(filteredShifts.map((s) => s.timezone).filter(Boolean));
    if (zones.size !== 1) return null;
    const zone = [...zones][0]!;
    return zone === browserTimeZone() ? null : zone;
  }, [filteredShifts]);

  // Phase 53.6 — DRAFT count for the visible week (powers the publish ribbon).
  const draftsInWeek = useMemo(() => {
    if (!shifts || view === 'list') return 0;
    const startMs = weekStart.getTime();
    const endMs = weekEnd.getTime();
    return shifts.filter((s) => {
      if (s.status !== 'DRAFT') return false;
      const t = new Date(s.startsAt).getTime();
      return t >= startMs && t < endMs;
    }).length;
  }, [shifts, view, weekStart, weekEnd]);

  // All drafts across the loaded data range (powers the global "Drafts" pill
   // near the view tabs). Lets the manager find unpublished work even when
   // they're looking at a week that doesn't contain any drafts.
  const allDrafts = useMemo(() => {
    if (!shifts) return [] as Shift[];
    return shifts
      .filter((s) => s.status === 'DRAFT')
      .sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      );
  }, [shifts]);

  // Jump to the week containing the earliest draft and switch to week view
  // so the publish ribbon is in front of the manager.
  const jumpToFirstDraft = useCallback(() => {
    if (allDrafts.length === 0) return;
    const earliest = new Date(allDrafts[0].startsAt);
    const w = startOfWeekMonday(earliest);
    setWeekStart(w);
    setView('week');
  }, [allDrafts]);

  // Unassigned OPEN shifts in the visible week (powers the auto-schedule ribbon).
  const openInWeek = useMemo(() => {
    if (!shifts || view === 'list') return 0;
    const startMs = weekStart.getTime();
    const endMs = weekEnd.getTime();
    return shifts.filter((s) => {
      if (s.status !== 'OPEN' || s.assignedAssociateId) return false;
      const t = new Date(s.startsAt).getTime();
      return t >= startMs && t < endMs;
    }).length;
  }, [shifts, view, weekStart, weekEnd]);

  // Phase 54 — print / CSV / PDF exports.

  const onPrint = () => {
    // window.print uses the @media print rules in index.css to hide chrome
    // and force light-mode. The print-area wrapper and no-print classes
    // do the rest.
    window.print();
  };

  /** Range string used in filenames + the print/PDF title block. */
  const exportRange = useMemo(() => {
    if (view === 'list') return { from: listFrom, to: listTo };
    if (view === 'week') return { from: ymd(weekStart), to: ymd(new Date(weekEnd.getTime() - 1)) };
    if (view === 'day') return { from: ymd(dayAnchor), to: ymd(dayAnchor) };
    // month
    const last = new Date(monthAnchor);
    last.setMonth(last.getMonth() + 1);
    last.setDate(0);
    return { from: ymd(monthAnchor), to: ymd(last) };
  }, [view, listFrom, listTo, weekStart, weekEnd, dayAnchor, monthAnchor]);

  const onExportCsv = () => {
    if (!filteredShifts || filteredShifts.length === 0) {
      toast.error('Nothing to export.');
      return;
    }
    const rows = [...filteredShifts].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
    );
    const header = [
      'Date',
      'Start',
      'End',
      'Hours',
      'Position',
      'Client',
      'Location',
      'Associate',
      'Status',
      'Hourly rate',
      'Notes',
    ];
    const csv = [header, ...rows.map((s) => csvRow(s))]
      .map((r) => r.map(csvCell).join(','))
      .join('\r\n');
    downloadBlob(
      `shifts-${exportRange.from}-to-${exportRange.to}.csv`,
      'text/csv;charset=utf-8',
      // BOM keeps Excel from mojibake-ing UTF-8 names like "José".
      '﻿' + csv
    );
  };

  const onExportPdf = async () => {
    if (exportingPdf) return;
    setExportingPdf(true);
    try {
      // Always pull a server-rendered, *complete* range (not truncated by
      // the on-screen list cap). Range comes from the active view.
      const start = fromYmd(exportRange.from);
      const end = fromYmd(exportRange.to);
      end.setDate(end.getDate() + 1); // end-exclusive
      const res = await fetch('/api/scheduling/export.pdf', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: start.toISOString(),
          to: end.toISOString(),
          ...(clientFilter ? { clientId: clientFilter } : {}),
        }),
      });
      if (!res.ok) throw new ApiError(res.status, 'export_failed', 'PDF export failed.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shifts-${exportRange.from}-to-${exportRange.to}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'PDF export failed.');
    } finally {
      setExportingPdf(false);
    }
  };

  const onPublishWeek = async () => {
    if (publishing) return;
    const ok = await confirm({
      title: `Publish ${draftsInWeek} draft shift${draftsInWeek === 1 ? '' : 's'}?`,
      description: `Assigned associates will be notified. Drafts inside a fair-workweek state's 14-day notice window will be skipped — open those individually to add a late-notice reason before publishing.`,
      confirmLabel: 'Publish week',
    });
    if (!ok) return;
    setPublishing(true);
    try {
      const res = await publishWeek({
        weekStart: weekStart.toISOString(),
        ...(clientFilter ? { clientId: clientFilter } : {}),
      });
      if (res.published > 0) {
        toast.success(
          `Published ${res.published} shift${res.published === 1 ? '' : 's'}.${res.skipped.length > 0 ? ` Skipped ${res.skipped.length} (predictive-schedule reason needed).` : ''}`
        );
      } else if (res.skipped.length > 0) {
        toast.error(
          `All ${res.skipped.length} draft${res.skipped.length === 1 ? '' : 's'} skipped — they need a late-notice reason in a fair-workweek state.`
        );
      } else {
        toast.success('Nothing to publish.');
      }
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Publish failed.');
    } finally {
      setPublishing(false);
    }
  };

  const onAutoScheduleWeek = async () => {
    if (autoScheduling) return;
    const ok = await confirm({
      title: `Auto-schedule ${openInWeek} open shift${openInWeek === 1 ? '' : 's'}?`,
      description:
        'Picks the best-scoring associate for each open shift this week (availability, no conflicts, under 40h, not on PTO). Earlier shifts get first pick. Assignments stay private until you publish the week.',
      confirmLabel: 'Auto-schedule',
    });
    if (!ok) return;
    setAutoScheduling(true);
    try {
      const res = await autoScheduleWeek({
        weekStart: weekStart.toISOString(),
        ...(clientFilter ? { clientId: clientFilter } : {}),
      });
      if (res.assigned > 0) {
        const top = res.byAssociate[0];
        const topNote = top
          ? ` Top: ${top.associateName} (${top.shiftsAssigned}).`
          : '';
        toast.success(
          `Assigned ${res.assigned} shift${res.assigned === 1 ? '' : 's'}.${
            res.skipped.length > 0
              ? ` Skipped ${res.skipped.length} (no eligible candidate).`
              : ''
          }${topNote}`,
        );
      } else if (res.skipped.length > 0) {
        toast.error(
          `All ${res.skipped.length} open shift${
            res.skipped.length === 1 ? '' : 's'
          } skipped — no eligible associates without conflicts or overtime.`,
        );
      } else {
        toast.success('Nothing to auto-schedule.');
      }
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Auto-schedule failed.');
    } finally {
      setAutoScheduling(false);
    }
  };

  const onTemplateDrop = useCallback(
    async (templateId: string, dayStart: Date, associateId: string | null) => {
      try {
        const all = await listShiftTemplates();
        const tpl = all.templates.find((t) => t.id === templateId);
        if (!tpl) {
          toast.error('Template not found.');
          return;
        }
        // Resolve client: template's clientId wins; else fall back to the
        // current filter; else error (global template needs a target client).
        const targetClientId = tpl.clientId ?? clientFilter ?? '';
        if (!targetClientId) {
          toast.error('Pick a client filter first — global templates need a target.');
          return;
        }
        // Resolve the WORK SITE so we can stamp the template's start/end
        // minutes (which are site-local minutes-from-midnight) in the site's
        // zone — not the admin's browser zone (else every templated shift is
        // off by the browser↔site offset, the same bug the create dialog had).
        // Prefer the location the admin filtered to; else the client's first
        // site. We PIN the location id so the shift lands in the same zone we
        // composed its times in (the server would otherwise auto-pick, possibly
        // a different-zone site, and re-introduce the skew).
        let site: { id: string; timezone: string } | null = null;
        if (locationFilter) {
          site = clientLocations.find((l) => l.id === locationFilter) ?? null;
        }
        if (!site) {
          try {
            const locs = await listClientLocations(targetClientId);
            const pick =
              locs.locations.find((l) => l.isActive) ?? locs.locations[0] ?? null;
            site = pick ? { id: pick.id, timezone: pick.timezone } : null;
          } catch {
            site = null; // fall back to browser-local below
          }
        }
        const siteTz = site?.timezone ?? null;
        const y = dayStart.getFullYear();
        const mo = dayStart.getMonth() + 1;
        const d = dayStart.getDate();
        const startsAt = zonedWallTimeToUtc(
          y, mo, d,
          Math.floor(tpl.startMinute / 60), tpl.startMinute % 60,
          siteTz,
        );
        let endsAt = zonedWallTimeToUtc(
          y, mo, d,
          Math.floor(tpl.endMinute / 60), tpl.endMinute % 60,
          siteTz,
        );
        // Overnight: end <= start rolls to the next site-local day (re-convert
        // so a DST boundary that night is handled).
        if (endsAt <= startsAt) {
          endsAt = zonedWallTimeToUtc(
            y, mo, d + 1,
            Math.floor(tpl.endMinute / 60), tpl.endMinute % 60,
            siteTz,
          );
        }

        const created = await createShift({
          clientId: targetClientId,
          ...(site ? { locationId: site.id } : {}),
          position: tpl.position,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          ...(tpl.location ? { location: tpl.location } : {}),
          ...(tpl.hourlyRate != null ? { hourlyRate: tpl.hourlyRate } : {}),
          ...(tpl.payRate != null ? { payRate: tpl.payRate } : {}),
          ...(tpl.notes ? { notes: tpl.notes } : {}),
        });
        if (associateId) {
          await assignShift(created.id, { associateId });
        }
        toast.success(`Applied "${tpl.name}".`);
        await refresh();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Apply failed.');
      }
    },
    [clientFilter, locationFilter, clientLocations, refresh],
  );

  // Optimistic local-state helpers — patch the one changed shift immediately so
  // a drag/resize/reassign is reflected in the grid before the server round-trip
  // lands, instead of snapping back and waiting on a full refetch. On error the
  // handler calls refresh() to snap back to server truth.
  const patchShift = useCallback((id: string, patch: Partial<Shift>) => {
    setShifts((prev) =>
      prev ? prev.map((s) => (s.id === id ? { ...s, ...patch } : s)) : prev,
    );
  }, []);
  const replaceShift = useCallback((updated: Shift) => {
    setShifts((prev) =>
      prev ? prev.map((s) => (s.id === updated.id ? updated : s)) : prev,
    );
  }, []);

  const onShiftResize = useCallback(
    async (s: Shift, newEndsAt: Date) => {
      const endsAt = newEndsAt.toISOString();
      patchShift(s.id, { endsAt }); // optimistic — chip resizes instantly
      try {
        const updated = await updateShift(s.id, { endsAt });
        replaceShift(updated);
        toast.success('Shift duration updated.');
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Resize failed.');
        await refresh(); // roll back to server truth
      }
    },
    [refresh, patchShift, replaceShift],
  );

  // Phase 53.7 — drag-end handler. Computes the right combination of
  // assign/unassign/updateShift to make the chip land in its new cell
  // with the same time-of-day it had before.
  const onShiftMove = useCallback(
    async (s: Shift, target: { associateId: string | null; dayStart: Date }) => {
      const origStart = new Date(s.startsAt);
      const origEnd = new Date(s.endsAt);
      // target.dayStart is the destination COLUMN's calendar date (local
      // midnight). Compare it against the shift's current day IN THE GRID's
      // zone so a remote admin's drag lands on the store-local day they
      // dropped on, not their browser day.
      const gz = gridTimeZone;
      const targetKey = ymd(target.dayStart);
      const origDayKey = zonedDayKey(origStart, gz);
      const dateChanged = targetKey !== origDayKey;
      const currentAssignee = s.assignedAssociateId ?? null;
      const assigneeChanged = currentAssignee !== target.associateId;
      if (!dateChanged && !assigneeChanged) return;

      // Compute the new start/end if the day changed.
      let newStartISO = s.startsAt;
      let newEndISO = s.endsAt;
      if (dateChanged) {
        let newStart: Date;
        let newEnd: Date;
        if (gz) {
          // Re-stamp the shift's store-local time-of-day onto the target
          // store-local date; preserve duration via elapsed ms.
          const mins = zonedMinutesOfDay(origStart, gz);
          const [ty, tm, td] = targetKey.split('-').map(Number);
          newStart = zonedWallTimeToUtc(
            ty, tm, td,
            Math.floor(mins / 60), mins % 60,
            gz,
          );
          newEnd = new Date(
            newStart.getTime() + (origEnd.getTime() - origStart.getTime()),
          );
        } else {
          // Browser-local: shift the date with setDate (absorbs 23h/25h DST
          // days) so the wall-clock time of day is preserved on both ends.
          const dayDelta = Math.round(
            (target.dayStart.getTime() - fromYmd(origDayKey).getTime()) / 86_400_000,
          );
          newStart = new Date(origStart);
          newStart.setDate(newStart.getDate() + dayDelta);
          newEnd = new Date(origEnd);
          newEnd.setDate(newEnd.getDate() + dayDelta);
        }
        newStartISO = newStart.toISOString();
        newEndISO = newEnd.toISOString();
      }

      // Optimistic patch — move the chip to its new cell instantly. Status
      // color (ASSIGNED/OPEN) is left to the authoritative response below since
      // the grid buckets by associate+day, not status, so the chip already
      // lands correctly.
      const patch: Partial<Shift> = {};
      if (dateChanged) {
        patch.startsAt = newStartISO;
        patch.endsAt = newEndISO;
      }
      if (assigneeChanged) {
        patch.assignedAssociateId = target.associateId;
        if (target.associateId) {
          const a = associates.find((x) => x.id === target.associateId);
          patch.assignedAssociateName = a ? `${a.firstName} ${a.lastName}` : null;
        } else {
          patch.assignedAssociateName = null;
        }
      }
      patchShift(s.id, patch);

      try {
        let updated = s;
        if (dateChanged) {
          updated = await updateShift(s.id, {
            startsAt: newStartISO,
            endsAt: newEndISO,
          });
        }
        if (assigneeChanged) {
          updated =
            target.associateId === null
              ? await unassignShift(s.id)
              : await assignShift(s.id, { associateId: target.associateId });
        }
        replaceShift(updated); // reconcile with server truth
        toast.success('Shift moved.');
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Move failed.');
        await refresh(); // roll back — a partial write may have stuck
      }
    },
    [refresh, gridTimeZone, associates, patchShift, replaceShift]
  );

  const onAutoFill = async (id: string) => {
    if (pendingId) return;
    setPendingId(id);
    try {
      const res = await getAutoFillCandidates(id);
      setAutoFillForShift({ shiftId: id, candidates: res.candidates });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Auto-fill failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onPickAutoFill = async (associateId: string) => {
    if (!autoFillForShift) return;
    setPendingId(autoFillForShift.shiftId);
    try {
      await assignShift(autoFillForShift.shiftId, { associateId });
      setAutoFillForShift(null);
      toast.success('Shift assigned.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Assign failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onUnassign = async (s: Shift) => {
    if (pendingId) return;
    setPendingId(s.id);
    try {
      await unassignShift(s.id);
      toast.success('Shift unassigned.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Unassign failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onQuickCancel = async (s: Shift) => {
    const ok = await confirm({
      title: 'Cancel shift?',
      description: `Cancel ${s.position} on ${fmtDateTime(s.startsAt)}?`,
      confirmLabel: 'Cancel shift',
    });
    if (!ok) return;
    try {
      await cancelShift(s.id, { reason: 'Cancelled from quick actions' });
      toast.success('Shift cancelled.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Cancel failed.');
    }
  };

  const onQuickDuplicate = async (s: Shift) => {
    try {
      await createShift({
        clientId: s.clientId,
        position: s.position,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        ...(s.location ? { location: s.location } : {}),
        ...(s.hourlyRate != null ? { hourlyRate: s.hourlyRate } : {}),
        ...(s.payRate != null ? { payRate: s.payRate } : {}),
        ...(s.notes ? { notes: s.notes } : {}),
      });
      toast.success('Shift duplicated.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Duplicate failed.');
    }
  };

  // Publish a single DRAFT shift (assigned → ASSIGNED, else OPEN). Surfaces
  // the fair-workweek "needs a reason" error so HR knows to use Edit.
  const onPublishShift = async (s: Shift) => {
    try {
      await updateShift(s.id, {
        status: s.assignedAssociateId ? 'ASSIGNED' : 'OPEN',
      });
      toast.success('Shift published.');
      await refresh();
    } catch (err) {
      const msg =
        err instanceof ApiError && err.code === 'late_notice_reason_required'
          ? 'Inside the 14-day notice window — open Edit and add a late-notice reason to publish.'
          : err instanceof ApiError
            ? err.message
            : 'Publish failed.';
      toast.error(msg);
    }
  };

  // Un-publish back to a private DRAFT.
  const onUnpublishShift = async (s: Shift) => {
    try {
      await updateShift(s.id, { status: 'DRAFT' });
      toast.success('Moved to draft.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not un-publish.');
    }
  };

  // Hard-delete (vs. cancel). Drafts delete with a light confirm; a
  // published/assigned shift gets a sterner one since people may have seen it.
  const onDeleteShift = async (s: Shift) => {
    const published = s.status !== 'DRAFT';
    const ok = await confirm({
      title: published ? 'Delete this shift?' : 'Delete this draft?',
      description: published
        ? `Permanently delete ${s.position} on ${fmtDateTime(s.startsAt)}? This can't be undone${s.assignedAssociateId ? ' and removes it from the employee’s schedule' : ''}.`
        : `Permanently delete this draft (${s.position} on ${fmtDateTime(s.startsAt)})?`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteShift(s.id);
      toast.success('Shift deleted.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Delete failed.');
    }
  };

  // Built fresh each render (not memoized) so the handlers always close over
  // the CURRENT refresh + pendingId. A previous useMemo([]) froze them at
  // mount, so after navigating weeks the hover-card actions refetched the
  // old window and the in-flight (pendingId) guard never fired. The views
  // aren't React.memo'd, so a new object reference here costs nothing.
  const quickActions = {
    onEdit: (s: Shift) => setEditTarget(s),
    onAssign: (s: Shift) => setAssignTarget(s),
    onUnassign,
    onCancel: onQuickCancel,
    onDuplicate: onQuickDuplicate,
    onDuplicateToEmployee: (s: Shift) => setDuplicateSource(s),
    onPublish: onPublishShift,
    onUnpublish: onUnpublishShift,
    onDelete: onDeleteShift,
  };

  return (
    <div className="mx-auto print-area">
      {/* Print-only header — appears on paper above the schedule, hidden on screen. */}
      <div className="print-only mb-3">
        <div className="text-xl font-semibold">Schedule</div>
        <div className="text-sm text-gray-700">
          {fmtPrintRange(exportRange.from, exportRange.to)}
          {clientFilter && clients.find((c) => c.id === clientFilter)
            ? ` · ${clients.find((c) => c.id === clientFilter)?.name}`
            : ''}
          {locationFilter && clientLocations.find((l) => l.id === locationFilter)
            ? ` › ${clientLocations.find((l) => l.id === locationFilter)?.name}`
            : ''}
          {posFilter ? ` · position: ${posFilter}` : ''}
        </div>
        <div className="text-[10px] text-gray-500 mt-1">
          Generated {fmtDateTime(new Date())}
        </div>
      </div>

      <PageHeader
        className="no-print"
        title="Scheduling"
        subtitle={
          canManage
            ? 'Plan shifts, assign associates, and track fill status.'
            : 'Read-only view of scheduled shifts.'
        }
        secondaryActions={
          canManage ? (
            <>
              <Button variant="ghost" size="sm" onClick={onPrint} title="Print the current view">
                <Printer className="h-4 w-4" />
                Print
              </Button>
              <Button variant="ghost" size="sm" onClick={onExportCsv} title="Download as CSV">
                <Download className="h-4 w-4" />
                CSV
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onExportPdf}
                loading={exportingPdf}
                title="Generate a PDF for this date range"
              >
                <FileText className="h-4 w-4" />
                PDF
              </Button>
              <Button variant="secondary" onClick={() => setShowTemplates(true)}>
                <LayoutTemplate className="h-4 w-4" />
                Templates
              </Button>
            </>
          ) : undefined
        }
        primaryAction={
          canManage ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              New shift
            </Button>
          ) : undefined
        }
      />

      {canManage && (
        <div className="no-print">
          <KpiStrip kpis={kpis} />
        </div>
      )}

      {tzHint && (
        <div className="no-print mb-2 text-[11px] text-silver/70 inline-flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {tzHint}
        </div>
      )}

      {canManage && (
        <CreateShiftDialog
          open={showCreate}
          clients={clients}
          associates={associates}
          initialDate={createInitialDate}
          initialAssociateId={createInitialAssociateId}
          onOpenChange={(o) => {
            setShowCreate(o);
            if (!o) {
              setCreateInitialDate(null);
              setCreateInitialAssociateId(null);
            }
          }}
          onCreated={() => {
            setShowCreate(false);
            setCreateInitialDate(null);
            setCreateInitialAssociateId(null);
            toast.success('Shift created.');
            refresh();
          }}
        />
      )}

      {/* View-mode toggle + per-view navigator */}
      <div className="flex flex-wrap items-center gap-3 mb-4 no-print">
        <div className="inline-flex rounded-md border border-navy-secondary p-0.5 bg-navy-secondary/30">
          <ViewTab current={view} value="list" onClick={setView} icon={List} label="List" />
          <ViewTab current={view} value="day" onClick={setView} icon={Calendar} label="Day" />
          <ViewTab current={view} value="week" onClick={setView} icon={CalendarDays} label="Week" />
          <ViewTab current={view} value="month" onClick={setView} icon={CalendarRange} label="Month" />
        </div>

        {/* Persistent drafts indicator. Visible across views so the manager
            knows unpublished work exists even when looking at a different
            week. Click → jumps to the earliest draft's week and switches to
            week view so the publish ribbon is in their face. */}
        {canManage && allDrafts.length > 0 && (
          <button
            type="button"
            onClick={jumpToFirstDraft}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-warning/40 bg-warning/[0.08] text-warning hover:bg-warning/15 text-xs"
            title={`${allDrafts.length} draft shift${allDrafts.length === 1 ? '' : 's'} not yet published — click to review`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse" />
            <span className="font-medium tabular-nums">{allDrafts.length}</span>
            draft{allDrafts.length === 1 ? '' : 's'} unpublished
          </button>
        )}

        {view === 'week' && (
          <div className="inline-flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWeekStart((w) => addDaysLocal(w, -weekDayCount))}
              aria-label="Previous period"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setWeekStart(startOfWeekMonday(new Date()));
                setWeekDayCount(7);
              }}
              className="uppercase tracking-wider"
            >
              This week
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWeekStart((w) => addDaysLocal(w, weekDayCount))}
              aria-label="Next period"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {/* Pick the exact start and end of the range to schedule. */}
            <label className="ml-2 inline-flex items-center gap-1 text-[11px] text-silver/70">
              From
              <input
                type="date"
                aria-label="Week start date"
                value={ymd(weekStart)}
                max={ymd(weekEndInclusive)}
                onChange={(e) => {
                  if (!e.target.value) return;
                  const nextStart = fromYmd(e.target.value);
                  // Keep the same end day; recompute the span (clamp 1..31).
                  const span = Math.min(31, Math.max(1, daysBetweenLocal(nextStart, weekEndInclusive) + 1));
                  setWeekStart(nextStart);
                  setWeekDayCount(span);
                }}
                className="h-7 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-xs text-white [color-scheme:dark] focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </label>
            <label className="inline-flex items-center gap-1 text-[11px] text-silver/70">
              To
              <input
                type="date"
                aria-label="Week end date"
                value={ymd(weekEndInclusive)}
                min={ymd(weekStart)}
                onChange={(e) => {
                  if (!e.target.value) return;
                  const end = fromYmd(e.target.value);
                  const span = Math.min(31, Math.max(1, daysBetweenLocal(weekStart, end) + 1));
                  setWeekDayCount(span);
                }}
                className="h-7 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-xs text-white [color-scheme:dark] focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </label>
            <span className="text-[11px] text-silver/60 tabular-nums">
              {weekDayCount}d
            </span>
            {canManage && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCopyWeekToNext}
                loading={copyingWeek}
                title="Copy this week's shifts to next week (as drafts)"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy to next week
              </Button>
            )}
            <div className="ml-auto inline-flex rounded-md border border-navy-secondary p-0.5 bg-navy-secondary/30">
              <button
                type="button"
                onClick={() => setWeekLayout('time-grid')}
                className={cn(
                  'px-2.5 py-1 text-[11px] uppercase tracking-wider rounded',
                  weekLayout === 'time-grid'
                    ? 'bg-gold/15 text-gold'
                    : 'text-silver hover:text-white',
                )}
                title="Time-grid layout — shifts proportional to duration"
              >
                Time grid
              </button>
              <button
                type="button"
                onClick={() => setWeekLayout('compact')}
                className={cn(
                  'px-2.5 py-1 text-[11px] uppercase tracking-wider rounded',
                  weekLayout === 'compact'
                    ? 'bg-gold/15 text-gold'
                    : 'text-silver hover:text-white',
                )}
                title="Compact layout — text rows, denser overview"
              >
                Compact
              </button>
            </div>
          </div>
        )}

        {view === 'day' && (
          <div className="inline-flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const d = new Date(dayAnchor);
                d.setDate(d.getDate() - 1);
                setDayAnchor(d);
              }}
              aria-label="Previous day"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                const t = new Date();
                t.setHours(0, 0, 0, 0);
                setDayAnchor(t);
              }}
              className="uppercase tracking-wider"
            >
              Today
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const d = new Date(dayAnchor);
                d.setDate(d.getDate() + 1);
                setDayAnchor(d);
              }}
              aria-label="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="text-sm text-silver tabular-nums ml-2">
              {dayAnchor.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
            {/* Jump to any day. */}
            <input
              type="date"
              aria-label="Jump to a specific day"
              title="Jump to a specific day"
              value={ymd(dayAnchor)}
              onChange={(e) => {
                if (e.target.value) setDayAnchor(fromYmd(e.target.value));
              }}
              className="h-7 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-xs text-white [color-scheme:dark] focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
        )}

        {view === 'month' && (
          <div className="inline-flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const d = new Date(monthAnchor);
                d.setMonth(d.getMonth() - 1);
                setMonthAnchor(d);
              }}
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                const t = new Date();
                t.setDate(1);
                t.setHours(0, 0, 0, 0);
                setMonthAnchor(t);
              }}
              className="uppercase tracking-wider"
            >
              This month
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const d = new Date(monthAnchor);
                d.setMonth(d.getMonth() + 1);
                setMonthAnchor(d);
              }}
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="text-sm text-silver tabular-nums ml-2">
              {monthAnchor.toLocaleDateString([], { month: 'long', year: 'numeric' })}
            </span>
            {/* Jump to any month. */}
            <input
              type="month"
              aria-label="Jump to a specific month"
              title="Jump to a specific month"
              value={`${monthAnchor.getFullYear()}-${String(monthAnchor.getMonth() + 1).padStart(2, '0')}`}
              onChange={(e) => {
                const [y, m] = e.target.value.split('-').map(Number);
                if (y && m) setMonthAnchor(new Date(y, m - 1, 1));
              }}
              className="h-7 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-xs text-white [color-scheme:dark] focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
        )}

        {view === 'list' && (
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm border transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                  filter === f.value
                    ? 'border-gold text-gold bg-gold/10'
                    : 'border-navy-secondary text-silver hover:text-white hover:border-silver/40'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Full-schedule filter bar — shown in every view (incl. the list
          "full schedule" table) so the cascade client → location → position
          narrows the whole org schedule from one place. */}
      {canManage && (
        <div className="no-print">
          <FilterBar
            posFilter={posFilter}
            setPosFilter={setPosFilter}
            positions={knownPositions}
            clientFilter={clientFilter}
            setClientFilter={setClientFilter}
            locationFilter={locationFilter}
            setLocationFilter={setLocationFilter}
            clientLocations={clientLocations}
            clients={clients}
            showAllAssociates={showAllAssociates}
            setShowAllAssociates={setShowAllAssociates}
            showAssociateToggle={view === 'week' || view === 'day'}
          />
        </div>
      )}

      {/* Phase 54.2 — date range filter for the list view (lives above the
          status filter chips). Defaults to the current month. */}
      {view === 'list' && (
        <div className="no-print mb-3 flex flex-wrap items-center gap-2 px-3 py-2 rounded-md border border-navy-secondary bg-navy-secondary/20">
          <div className="text-[10px] uppercase tracking-wider text-silver/70 inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            Range
          </div>
          <input
            type="date"
            value={listFrom}
            onChange={(e) => setListFrom(e.target.value)}
            className="h-8 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 py-1 text-xs text-white focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            aria-label="From date"
          />
          <span className="text-silver/70 text-xs">→</span>
          <input
            type="date"
            value={listTo}
            onChange={(e) => setListTo(e.target.value)}
            className="h-8 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 py-1 text-xs text-white focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            aria-label="To date"
          />
          <button
            type="button"
            onClick={() => {
              const d = new Date();
              setListFrom(ymd(new Date(d.getFullYear(), d.getMonth(), 1)));
              setListTo(ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)));
            }}
            className="text-[10px] text-silver/70 hover:text-gold underline underline-offset-2 ml-1"
          >
            This month
          </button>
          <button
            type="button"
            onClick={() => {
              const d = new Date();
              const monday = startOfWeekMonday(d);
              setListFrom(ymd(monday));
              const sunday = new Date(monday);
              sunday.setDate(sunday.getDate() + 6);
              setListTo(ymd(sunday));
            }}
            className="text-[10px] text-silver/70 hover:text-gold underline underline-offset-2"
          >
            This week
          </button>
          <button
            type="button"
            onClick={() => {
              setListFrom('');
              setListTo('');
            }}
            className="text-[10px] text-silver/70 hover:text-gold underline underline-offset-2"
          >
            Clear
          </button>
          <span className="ml-auto text-[10px] text-silver/70 tabular-nums">
            {filteredShifts ? `${filteredShifts.length} shifts` : ''}
          </span>
        </div>
      )}

      {/* Auto-schedule ribbon (week view only). Hides when there are no
          unassigned OPEN shifts in the visible week. Stacks above the publish
          ribbon so the manager flow reads top-to-bottom: fill, then publish. */}
      {canManage && view === 'week' && openInWeek > 0 && (
        <div className="no-print">
          <AutoScheduleRibbon
            count={openInWeek}
            onAutoSchedule={onAutoScheduleWeek}
            loading={autoScheduling}
          />
        </div>
      )}

      {/* Publish-week ribbon. Visible across week/day/month views so the
          manager always knows when there's unpublished work, regardless of
          which calendar layout they're in. (List view has its own scope so
          we keep the ribbon on the calendar views.) */}
      {canManage &&
        (view === 'week' || view === 'day' || view === 'month') &&
        draftsInWeek > 0 && (
          <div className="no-print">
            <PublishRibbon
              count={draftsInWeek}
              onPublish={onPublishWeek}
              loading={publishing}
            />
          </div>
        )}

      {!shifts && (
        // Reserve roughly the real surface's height so the page doesn't lurch
        // when data lands: the list is a few rows, but the calendar grids are
        // tall. Sizing the placeholder per view keeps the layout stable.
        <Card>
          <div className="p-2 space-y-2">
            {Array.from({ length: view === 'list' ? 4 : 10 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        </Card>
      )}

      {/* Calendar shift-click router — shared by day/week views */}
      {/* eslint-disable react-hooks/rules-of-hooks */}

      {/* Mobile-only schedule list. The desktop grids (week/day pivots)
          are min-w-[700px]–[1200px] and force horizontal scroll on a
          phone — a scheduler can only see one column at a time. On
          <md we always show a vertical, time-sorted list anchored to
          dayAnchor regardless of which desktop view is selected. The
          assign / create drawers are shared with the desktop path. */}
      {filteredShifts && (
        <div className="md:hidden">
          <MobileScheduleList
            shifts={filteredShifts}
            associates={associates}
            dayAnchor={dayAnchor}
            displayTimeZone={gridTimeZone}
            canManage={canManage}
            onShiftClick={(s) => {
              if (s.status === 'OPEN' || s.status === 'DRAFT' || s.status === 'ASSIGNED') {
                setAssignTarget(s);
              }
            }}
            onPrevDay={() =>
              setDayAnchor(new Date(dayAnchor.getTime() - 24 * 60 * 60 * 1000))
            }
            onNextDay={() =>
              setDayAnchor(new Date(dayAnchor.getTime() + 24 * 60 * 60 * 1000))
            }
            onCreate={(dayStart) => {
              setCreateInitialDate(dayStart);
              setCreateInitialAssociateId(null);
              setShowCreate(true);
            }}
          />
        </div>
      )}

      {/* Week view */}
      {filteredShifts && view === 'week' && weekLayout === 'time-grid' && (
        <div className="hidden md:block">
        <TimeGridWeekView
          shifts={filteredShifts}
          associates={associates}
          weekStart={weekStart}
          dayCount={weekDayCount}
          displayTimeZone={gridTimeZone}
          canManage={canManage}
          showAllAssociates={showAllAssociates}
          onShiftClick={(s, e) => {
            // Modifier-click → bulk-select. Bare click → existing edit dialog.
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
              toggleSelection(s.id);
              return;
            }
            if (s.status === 'OPEN' || s.status === 'DRAFT' || s.status === 'ASSIGNED') {
              setAssignTarget(s);
            }
          }}
          onCellCreate={(start, associateId) => {
            setCreateInitialDate(start);
            setCreateInitialAssociateId(associateId);
            setShowCreate(true);
          }}
          onShiftMove={onShiftMove}
          onShiftResize={onShiftResize}
          quickActions={quickActions}
          selectedIds={selectedIds}
          onTemplateDrop={onTemplateDrop}
        />
        </div>
      )}
      {filteredShifts && view === 'week' && weekLayout === 'compact' && (
        <div className="hidden md:block">
        <WeekCalendarView
          shifts={filteredShifts}
          associates={associates}
          weekStart={weekStart}
          dayCount={weekDayCount}
          displayTimeZone={gridTimeZone}
          canManage={canManage}
          showAllAssociates={showAllAssociates}
          onShiftClick={(s, e) => {
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
              toggleSelection(s.id);
              return;
            }
            if (s.status === 'OPEN' || s.status === 'DRAFT' || s.status === 'ASSIGNED') {
              setAssignTarget(s);
            }
          }}
          onCellCreate={(dayStart, associateId) => {
            setCreateInitialDate(dayStart);
            setCreateInitialAssociateId(associateId);
            setShowCreate(true);
          }}
          onShiftMove={onShiftMove}
          onShiftResize={onShiftResize}
          quickActions={quickActions}
          selectedIds={selectedIds}
          onTemplateDrop={onTemplateDrop}
        />
        </div>
      )}

      {/* Day view — same pivot, single column with hour grid + drag-to-resize */}
      {filteredShifts && view === 'day' && (
        <div className="hidden md:block">
        <DayCalendarView
          shifts={filteredShifts}
          associates={associates}
          dayAnchor={dayAnchor}
          displayTimeZone={gridTimeZone}
          canManage={canManage}
          showAllAssociates={showAllAssociates}
          onShiftClick={(s) => {
            if (s.status === 'OPEN' || s.status === 'DRAFT' || s.status === 'ASSIGNED') {
              setAssignTarget(s);
            }
          }}
          onCellCreate={(dayStart, associateId) => {
            setCreateInitialDate(dayStart);
            setCreateInitialAssociateId(associateId);
            setShowCreate(true);
          }}
          onShiftMove={onShiftMove}
          onShiftResize={onShiftResize}
          quickActions={quickActions}
        />
        </div>
      )}

      {/* Month view — 6×7 mini calendar with shift counts per day */}
      {filteredShifts && view === 'month' && (
        <div className="hidden md:block">
        <MonthCalendarView
          shifts={filteredShifts}
          monthAnchor={monthAnchor}
          displayTimeZone={gridTimeZone}
          canManage={canManage}
          onDayClick={(d) => {
            setDayAnchor(d);
            setView('day');
          }}
          onShiftClick={(s) => {
            if (s.status === 'OPEN' || s.status === 'DRAFT' || s.status === 'ASSIGNED') {
              setAssignTarget(s);
            }
          }}
          onCellCreate={(dayStart) => {
            setCreateInitialDate(dayStart);
            setCreateInitialAssociateId(null);
            setShowCreate(true);
          }}
        />
        </div>
      )}

      {/* List view: empty state */}
      {shifts && view === 'list' && shifts.length === 0 && (
        <EmptyState
          icon={Calendar}
          title="No shifts match this filter"
          description={
            canManage
              ? 'Try a different filter, or create a new shift to start staffing.'
              : 'Try a different filter to see other shifts.'
          }
          action={
            canManage ? (
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                New shift
              </Button>
            ) : undefined
          }
        />
      )}

      {view === 'list' && listTruncated && (
        <ErrorBanner severity="warning" className="mb-3">
          Showing the first 200 shifts — more match this filter than fit. Narrow
          the date range, client, or status to see the rest.
        </ErrorBanner>
      )}

      {shifts && view === 'list' && shifts.length > 0 && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Position</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Starts</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="text-right no-print">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shifts.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.position}</TableCell>
                  <TableCell className="text-silver">{s.clientName ?? '—'}</TableCell>
                  <TableCell className="tabular-nums">{fmt(s.startsAt)}</TableCell>
                  <TableCell className="tabular-nums">{fmt(s.endsAt)}</TableCell>
                  <TableCell className="text-silver">
                    {s.assignedAssociateName ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={STATUS_VARIANT[s.status] ?? 'default'}
                      data-status={s.status}
                    >
                      {s.status}
                    </Badge>
                    {s.cancellationReason && (
                      <div className="text-alert text-[10px] mt-1">
                        {s.cancellationReason}
                      </div>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right whitespace-nowrap no-print">
                      <div className="inline-flex gap-1.5">
                        {(s.status === 'OPEN' || s.status === 'DRAFT') && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onAutoFill(s.id)}
                              disabled={pendingId === s.id}
                            >
                              <Sparkles className="h-3.5 w-3.5" />
                              Auto-fill
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setAssignTarget(s)}
                              disabled={pendingId === s.id}
                            >
                              <UserPlus className="h-3.5 w-3.5" />
                              Assign
                            </Button>
                          </>
                        )}
                        {s.status === 'ASSIGNED' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onUnassign(s)}
                            disabled={pendingId === s.id}
                          >
                            Unassign
                          </Button>
                        )}
                        {s.status !== 'COMPLETED' && s.status !== 'CANCELLED' && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setCancelTarget(s)}
                            disabled={pendingId === s.id}
                          >
                            <X className="h-3.5 w-3.5" />
                            Cancel
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {canManage && (
        <div className="no-print">
          <AdminSwapsPanel />
        </div>
      )}

      {/* Assign-with-conflicts dialog */}
      <AssignDialog
        target={assignTarget}
        associates={associates}
        onClose={() => setAssignTarget(null)}
        onAssigned={() => {
          setAssignTarget(null);
          toast.success('Shift assigned.');
          refresh();
        }}
      />

      {/* Edit date/time/position/rates/notes */}
      <EditShiftDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          refresh();
        }}
      />

      {/* Cancel-with-reason dialog */}
      <CancelDialog
        target={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onCancelled={() => {
          setCancelTarget(null);
          toast.success('Shift cancelled.');
          refresh();
        }}
      />

      {/* Copy a shift onto another employee (as a draft) */}
      {duplicateSource && (
        <DuplicateToEmployeeDialog
          // Remount per source shift so the picked employee / search reset
          // instead of carrying over from the previous shift.
          key={duplicateSource.id}
          source={duplicateSource}
          onClose={() => setDuplicateSource(null)}
          onDone={() => {
            setDuplicateSource(null);
            refresh();
          }}
        />
      )}

      {/* Auto-fill candidates dialog */}
      <AutoFillDialog
        target={autoFillForShift}
        onClose={() => setAutoFillForShift(null)}
        onPick={onPickAutoFill}
        pending={pendingId !== null}
      />

      {/* Phase 51 — templates */}
      {canManage && (
        <TemplatesDialog
          open={showTemplates}
          onOpenChange={setShowTemplates}
          clients={clients}
          weekStart={weekStart}
          onApplied={() => {
            toast.success('Template applied as a draft shift.');
            refresh();
          }}
        />
      )}

      {/* Bulk selection toolbar — fixed bottom-center, only visible while
          one or more chips are selected. Lives at the page level so it
          floats over both week-view layouts. */}
      <SelectionToolbar
        selected={(filteredShifts ?? []).filter((s) => selectedIds.has(s.id))}
        onClear={clearSelection}
        onAfterAction={refresh}
      />

      {/* Templates rail — fixed right-side panel; only relevant on the
          schedule-editing views (not list/month). Drop a template on a
          cell to apply. */}
      {canManage && (view === 'week' || view === 'day') && (
        <TemplatesRail
          clientId={clientFilter || null}
          onManage={() => setShowTemplates(true)}
        />
      )}
    </div>
  );
}

/* ===== KPI strip ========================================================== */

function KpiStrip({ kpis }: { kpis: SchedulingKpis | null }) {
  if (!kpis) {
    // Match the resolved strip's height (px-4 py-3 + two text lines) so the
    // skeleton→data swap doesn't nudge the grid down.
    return (
      <div className="mb-5">
        <Skeleton className="h-[68px]" />
      </div>
    );
  }
  const hours = kpis.totalScheduledMinutes / 60;
  const fillTone =
    kpis.fillRatePercent >= 90
      ? 'text-success'
      : kpis.fillRatePercent >= 70
        ? 'text-warning'
        : 'text-alert';
  // Compact currency: $1.2k / $24k / $1.4M — keeps the strip readable on
  // 13" laptops without giving up signal on six-figure weeks.
  const cost = formatCompactUsd(kpis.projectedLaborCost);
  const costSuffix =
    kpis.shiftsWithoutRate > 0
      ? `${kpis.shiftsWithoutRate} no rate`
      : null;
  return (
    <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 px-4 py-3 rounded-md border border-navy-secondary bg-navy-secondary/30">
      <Kpi label="Open shifts" value={String(kpis.openShifts)} tone={kpis.openShifts > 0 ? 'text-warning' : 'text-silver'} />
      <Kpi label="Filled" value={String(kpis.assignedShifts + kpis.completedShifts)} />
      <Kpi label="Fill rate" value={`${kpis.fillRatePercent}%`} tone={fillTone} />
      <Kpi label="Hours scheduled" value={hours.toFixed(0)} />
      <Kpi
        label="Projected labor"
        value={cost}
        suffix={costSuffix}
      />
      {kpis.draftShifts > 0 && (
        <Kpi label="Draft" value={String(kpis.draftShifts)} tone="text-silver" />
      )}
      <div className="text-[10px] uppercase tracking-wider text-silver/70 self-end ml-auto">
        this week
      </div>
    </div>
  );
}

function formatCompactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function Kpi({
  label,
  value,
  tone = 'text-white',
  suffix,
}: {
  label: string;
  value: string;
  tone?: string;
  suffix?: string | null;
}) {
  return (
    <div className="min-w-[6rem]">
      <div className="text-[10px] uppercase tracking-wider text-silver">{label}</div>
      <div className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</div>
      {suffix ? (
        <div className="text-[10px] text-warning/80 tabular-nums">{suffix}</div>
      ) : null}
    </div>
  );
}

/* ===== Assign dialog ====================================================== */

type ConflictRow = { position: string; client: string | null; startsAt: string };
type TimeOffRow = { category: string; startDate: string; endDate: string };

function AssignDialog({
  target,
  associates,
  onClose,
  onAssigned,
}: {
  target: Shift | null;
  associates: AssociateLite[];
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [picked, setPicked] = useState<AssociateLite | null>(null);
  const [query, setQuery] = useState('');
  const [conflicts, setConflicts] = useState<ConflictRow[] | null>(null);
  const [timeOff, setTimeOff] = useState<TimeOffRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  // Set when the conflict check itself FAILS (network/500) — distinct from
  // "checked, no conflicts" so the admin isn't misled into assigning blind.
  const [checkError, setCheckError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Keyboard navigation index in the suggestion list.
  const [highlight, setHighlight] = useState(0);

  // Reset on open.
  useEffect(() => {
    if (target) {
      setPicked(null);
      setQuery('');
      setConflicts(null);
      setTimeOff(null);
      setCheckError(null);
      setSubmitting(false);
      setChecking(false);
      setHighlight(0);
    }
  }, [target]);

  // Live conflict check on the picked associate — debounced.
  useEffect(() => {
    if (!target || !picked) {
      setConflicts(null);
      setTimeOff(null);
      setCheckError(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setChecking(true);
      try {
        const c = await getShiftConflicts(target.id, picked.id);
        if (cancelled) return;
        setCheckError(null);
        setConflicts(
          c.conflicts.map((cf) => ({
            position: cf.conflictingPosition,
            client: cf.conflictingClientName,
            startsAt: cf.conflictingStartsAt,
          }))
        );
        setTimeOff(
          c.timeOffConflicts.map((t) => ({
            category: t.category,
            startDate: t.startDate,
            endDate: t.endDate,
          }))
        );
      } catch {
        if (!cancelled) {
          setConflicts(null);
          setTimeOff(null);
          setCheckError('Couldn’t check for conflicts — verify manually before assigning.');
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [picked, target]);

  const submit = async () => {
    if (!target || !picked) return;
    setSubmitting(true);
    try {
      await assignShift(target.id, { associateId: picked.id });
      onAssigned();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Assign failed.');
      setSubmitting(false);
    }
  };

  // Substring match across "first last" and email. Lowercase once per
  // query so we're not normalizing per-row on every keystroke.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return associates.slice(0, 10);
    return associates
      .filter((a) => {
        const full = `${a.firstName} ${a.lastName}`.toLowerCase();
        return (
          full.includes(q) ||
          a.lastName.toLowerCase().includes(q) ||
          a.email.toLowerCase().includes(q)
        );
      })
      .slice(0, 12);
  }, [query, associates]);

  // Keep highlight in range when results change.
  useEffect(() => {
    if (highlight >= matches.length) setHighlight(0);
  }, [matches.length, highlight]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (picked) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(0, matches.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter' && matches[highlight]) {
      e.preventDefault();
      setPicked(matches[highlight]);
      setQuery('');
    }
  };

  const hasConflicts = !!(conflicts && conflicts.length > 0);
  const hasTimeOff = !!(timeOff && timeOff.length > 0);
  const isClean =
    !checking && conflicts !== null && conflicts.length === 0 && !hasTimeOff;

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign shift</DialogTitle>
          <DialogDescription>
            {target && (
              <>
                {target.position} at {target.clientName ?? '—'} ·{' '}
                {fmt(target.startsAt)}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-3"
        >
          <div>
            <Label htmlFor="assign-name" required>
              Associate
            </Label>
            {picked ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-gold/40 bg-gold/[0.06]">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-7 w-7 rounded-full bg-gold/15 text-gold text-[10px] font-semibold flex items-center justify-center shrink-0">
                    {picked.firstName[0]}
                    {picked.lastName[0]}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate">
                      {picked.firstName} {picked.lastName}
                    </div>
                    <div className="text-[11px] text-silver/70 truncate">
                      {picked.email}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPicked(null);
                    setQuery('');
                  }}
                  className="text-[11px] text-silver/70 hover:text-gold underline underline-offset-2"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  id="assign-name"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(0);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder="Type a name…"
                  autoFocus
                  autoComplete="off"
                  required
                />
                {matches.length > 0 && (
                  <ul
                    role="listbox"
                    className="mt-1 max-h-56 overflow-y-auto rounded-md border border-navy-secondary bg-navy elev-3"
                  >
                    {matches.map((a, i) => (
                      <li
                        key={a.id}
                        role="option"
                        aria-selected={i === highlight}
                        onMouseEnter={() => setHighlight(i)}
                        onMouseDown={(e) => {
                          // mousedown fires before blur so the picker
                          // stays focused while the selection is set.
                          e.preventDefault();
                          setPicked(a);
                          setQuery('');
                        }}
                        className={cn(
                          'px-3 py-2 text-sm cursor-pointer flex items-center gap-2',
                          i === highlight
                            ? 'bg-gold/10 text-white'
                            : 'text-silver hover:bg-navy-secondary/40',
                        )}
                      >
                        <div className="h-6 w-6 rounded-full bg-gold/10 text-gold text-[9px] font-semibold flex items-center justify-center shrink-0">
                          {a.firstName[0]}
                          {a.lastName[0]}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate">
                            {a.firstName} {a.lastName}
                          </div>
                          <div className="text-[10px] text-silver/70 truncate">
                            {a.email}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {query.trim() && matches.length === 0 && (
                  <div className="mt-1 px-3 py-2 text-xs text-silver/70 rounded-md border border-navy-secondary bg-navy">
                    No associates match “{query}”.
                  </div>
                )}
              </div>
            )}
            {checking && (
              <div className="text-[11px] text-silver/70 mt-1">Checking conflicts…</div>
            )}
            {!checking && checkError && (
              <div className="text-[11px] text-warning mt-1 inline-flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {checkError}
              </div>
            )}
            {isClean && !checkError && (
              <div className="text-[11px] text-success mt-1 inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                No conflicts
              </div>
            )}
          </div>

          {hasTimeOff && (
            <div className="flex items-start gap-2 p-3 rounded-md border border-error/50 bg-error/10 text-sm">
              <AlertTriangle className="h-4 w-4 text-error mt-0.5 shrink-0" />
              <div>
                <div className="font-medium text-white">
                  Approved time off covers this shift
                </div>
                <ul className="mt-2 space-y-1 text-silver">
                  {timeOff!.map((t, i) => (
                    <li key={i} className="text-xs">
                      • {fmtCategory(t.category)} ·{' '}
                      <span className="tabular-nums">
                        {t.startDate}
                        {t.startDate !== t.endDate ? ` → ${t.endDate}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {hasConflicts && (
            <div className="flex items-start gap-2 p-3 rounded-md border border-warning/40 bg-warning/10 text-sm">
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <div>
                <div className="font-medium text-white">
                  Overlaps {conflicts!.length} existing shift
                  {conflicts!.length === 1 ? '' : 's'}:
                </div>
                <ul className="mt-2 space-y-1 text-silver">
                  {conflicts!.map((c, i) => (
                    <li key={i} className="text-xs">
                      • {c.position} @ {c.client ?? '—'} ·{' '}
                      <span className="tabular-nums">{fmt(c.startsAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={hasConflicts || hasTimeOff ? 'destructive' : 'primary'}
              loading={submitting}
              disabled={!picked}
            >
              {hasConflicts || hasTimeOff ? 'Assign anyway' : 'Assign'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function fmtCategory(c: string): string {
  return c
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/* ===== Cancel dialog ====================================================== */

function CancelDialog({
  target,
  onClose,
  onCancelled,
}: {
  target: Shift | null;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (target) {
      setReason('');
      setSubmitting(false);
    }
  }, [target]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target || !reason.trim()) return;
    setSubmitting(true);
    try {
      await cancelShift(target.id, { reason: reason.trim() });
      onCancelled();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Cancel failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel shift</DialogTitle>
          <DialogDescription>
            {target && (
              <>
                {target.position} at {target.clientName ?? '—'} ·{' '}
                {fmt(target.startsAt)}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Cancellation reason" required>
            {(p) => (
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Required for the audit trail."
                autoFocus
                rows={3}
                {...p}
              />
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Keep shift
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={submitting}
              disabled={!reason.trim()}
            >
              Cancel shift
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Auto-fill dialog =================================================== */

function AutoFillDialog({
  target,
  onClose,
  onPick,
  pending,
}: {
  target: { shiftId: string; candidates: AutoFillCandidate[] } | null;
  onClose: () => void;
  onPick: (associateId: string) => void;
  pending: boolean;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Suggested associates</DialogTitle>
          <DialogDescription>
            Ranked by availability, conflict-free, and weekly hours headroom.
          </DialogDescription>
        </DialogHeader>
        {target?.candidates.length === 0 && (
          <p className="text-silver text-sm">
            No candidates returned. Check that associates have set availability.
          </p>
        )}
        {target && target.candidates.length > 0 && (
          <ul className="space-y-2 max-h-[60vh] overflow-y-auto">
            {target.candidates.slice(0, 15).map((c) => (
              <li
                key={c.associateId}
                className="flex items-center justify-between gap-3 p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-white text-sm font-medium">{c.associateName}</div>
                  <div className="text-xs text-silver flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        c.matchesAvailability ? 'text-success' : 'text-silver/70'
                      )}
                    >
                      {c.matchesAvailability ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : null}
                      {c.matchesAvailability ? 'Available' : 'No availability'}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        c.noConflict ? 'text-success' : 'text-alert'
                      )}
                    >
                      {c.noConflict ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      {c.noConflict ? 'No conflict' : 'Conflict'}
                    </span>
                    <span className="tabular-nums">
                      {Math.round(c.weeklyMinutesActual / 60)}h worked this week
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="accent">{(c.score * 100).toFixed(0)}%</Badge>
                  <Button
                    size="sm"
                    onClick={() => onPick(c.associateId)}
                    disabled={pending}
                  >
                    Assign
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ===== Swaps panel ======================================================== */

const SWAP_STATUS_VARIANT: Record<
  ShiftSwapRequest['status'],
  'success' | 'pending' | 'destructive' | 'default'
> = {
  PENDING_PEER: 'pending',
  PEER_ACCEPTED: 'pending',
  PEER_DECLINED: 'destructive',
  MANAGER_APPROVED: 'success',
  MANAGER_REJECTED: 'destructive',
  CANCELLED: 'default',
};

function AdminSwapsPanel() {
  const [items, setItems] = useState<ShiftSwapRequest[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listAdminSwaps({ status: 'PEER_ACCEPTED' });
      setItems(res.requests);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load swaps.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const wrap = async (id: string, fn: () => Promise<unknown>, successMsg: string) => {
    setPendingId(id);
    try {
      await fn();
      toast.success(successMsg);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Swap requests awaiting your approval</CardTitle>
      </CardHeader>
      <CardContent>
        {!items && <Skeleton className="h-16" />}
        {items && items.length === 0 && (
          <p className="text-silver text-sm">
            No swap requests need your approval.
          </p>
        )}
        {items && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((s) => (
              <li
                key={s.id}
                className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md flex items-start justify-between gap-3 flex-wrap"
              >
                <div>
                  <div className="text-white text-sm">
                    <span className="font-medium">{s.requesterName}</span>
                    {' → '}
                    <span className="font-medium">{s.counterpartyName}</span>
                  </div>
                  <div className="text-xs text-silver mt-0.5">
                    {s.shiftPosition} · {s.shiftClientName ?? '—'} ·{' '}
                    <span className="tabular-nums">
                      {fmtDateTime(s.shiftStartsAt)}
                    </span>
                  </div>
                  {s.note && (
                    <div className="text-xs text-silver/70 italic mt-1">"{s.note}"</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={SWAP_STATUS_VARIANT[s.status]}>
                    {s.status.replace(/_/g, ' ')}
                  </Badge>
                  <Button
                    size="sm"
                    onClick={() =>
                      wrap(s.id, () => managerApproveSwap(s.id), 'Swap approved.')
                    }
                    disabled={pendingId === s.id}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      wrap(s.id, () => managerRejectSwap(s.id), 'Swap rejected.')
                    }
                    disabled={pendingId === s.id}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ===== Duplicate-to-employee dialog ====================================== */

function DuplicateToEmployeeDialog({
  source,
  onClose,
  onDone,
}: {
  source: Shift;
  onClose: () => void;
  onDone: () => void;
}) {
  const [associates, setAssociates] = useState<AssociateLite[] | null>(null);
  const [search, setSearch] = useState('');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Scope the picker to the source shift's client.
  useEffect(() => {
    let cancelled = false;
    setAssociates(null);
    listSchedulingAssociates({ clientId: source.clientId })
      .then((r) => {
        if (!cancelled) setAssociates(r.associates);
      })
      .catch(() => {
        if (!cancelled) setAssociates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [source.clientId]);

  const filtered = (associates ?? []).filter((a) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${a.firstName} ${a.lastName} ${a.email}`.toLowerCase().includes(q);
  });

  const submit = async () => {
    if (!pickedId || submitting) return;
    setSubmitting(true);
    try {
      // Copy the shift definition onto the chosen employee as a DRAFT, so
      // it's reviewable before publishing (and won't surprise-notify). The
      // bulk endpoint skips the employee if they're already booked then.
      const res = await bulkCreateShifts({
        clientId: source.clientId,
        ...(source.locationId ? { locationId: source.locationId } : {}),
        position: source.position,
        startsAt: source.startsAt,
        endsAt: source.endsAt,
        ...(source.location ? { location: source.location } : {}),
        ...(source.hourlyRate != null ? { hourlyRate: source.hourlyRate } : {}),
        ...(source.payRate != null ? { payRate: source.payRate } : {}),
        ...(source.notes ? { notes: source.notes } : {}),
        status: 'DRAFT',
        associateIds: [pickedId],
      });
      if (res.created === 0) {
        toast.error('That employee is already scheduled then.');
      } else {
        toast.success('Copied to employee as a draft.');
        onDone();
        return;
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Copy failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Copy shift to an employee</DialogTitle>
          <DialogDescription>
            {source.position} ·{' '}
            {fmtDateTime(source.startsAt)} — creates a draft copy on the
            employee you pick.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employees…"
            className="h-9 text-sm"
            aria-label="Search employees"
          />
          <div className="max-h-64 overflow-y-auto rounded border border-navy-secondary/60 divide-y divide-navy-secondary/40">
            {associates === null ? (
              <div className="p-3 text-xs text-silver/70">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="p-3 text-xs text-silver/70">
                No employees for this client.
              </div>
            ) : (
              filtered.map((a) => (
                <label
                  key={a.id}
                  className="flex items-center gap-2 px-2 py-2 text-xs text-silver hover:bg-navy-secondary/40 cursor-pointer"
                >
                  <input
                    type="radio"
                    name="dup-employee"
                    className="accent-gold"
                    checked={pickedId === a.id}
                    onChange={() => setPickedId(a.id)}
                  />
                  <span className="truncate">
                    {a.firstName} {a.lastName}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!pickedId} loading={submitting}>
            Copy as draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Edit-shift dialog ================================================= */

function EditShiftDialog({
  target,
  onClose,
  onSaved,
}: {
  target: Shift | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [position, setPosition] = useState('');
  const positionOptions = useShiftPositionNames(target?.clientId);
  const [subzone, setSubzone] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [payRate, setPayRate] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill from the shift each time a new one is opened. Times show in the
  // WORK SITE's zone (same as the calendar grid), so editing a FL store from
  // CA shows—and saves—the store's wall-clock, not the browser's.
  useEffect(() => {
    if (!target) return;
    setStartsAt(utcToZonedDatetimeInput(target.startsAt, target.timezone));
    setEndsAt(utcToZonedDatetimeInput(target.endsAt, target.timezone));
    setPosition(target.position);
    setSubzone(target.location ?? '');
    setHourlyRate(target.hourlyRate != null ? String(target.hourlyRate) : '');
    setPayRate(target.payRate != null ? String(target.payRate) : '');
    setNotes(target.notes ?? '');
    setSubmitting(false);
  }, [target]);

  const tzHint =
    target && target.timezone && target.timezone !== browserTimeZone()
      ? `Times are in the work site's zone (${tzAbbrev(target.timezone)}).`
      : undefined;

  if (!target) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    // Inputs are wall-clock at the work site → convert back through the
    // shift's zone (symmetric with the pre-fill above).
    const start = new Date(localInputToUtcIso(startsAt, target.timezone));
    const end = new Date(localInputToUtcIso(endsAt, target.timezone));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      toast.error('Enter a valid start and end.');
      return;
    }
    if (end <= start) {
      toast.error('End time must be after the start time.');
      return;
    }
    if (!position.trim()) {
      toast.error('Position is required.');
      return;
    }
    setSubmitting(true);
    try {
      await updateShift(target.id, {
        position: position.trim(),
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        location: subzone.trim() || null,
        hourlyRate: hourlyRate ? Number(hourlyRate) : null,
        payRate: payRate ? Number(payRate) : null,
        notes: notes.trim() || null,
      });
      toast.success('Shift updated.');
      onSaved();
    } catch (err) {
      const msg =
        err instanceof ApiError && err.code === 'late_notice_reason_required'
          ? 'This is a published shift moving inside the 14-day notice window — un-publish it (Move to draft) before re-timing, or keep it outside the window.'
          : err instanceof ApiError && err.code === 'shift_not_editable'
            ? 'A completed or cancelled shift can’t be edited.'
            : err instanceof ApiError
              ? err.message
              : 'Update failed.';
      toast.error(msg);
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit shift</DialogTitle>
          <DialogDescription>
            {target.clientName ?? 'Shift'}
            {target.assignedAssociateName ? ` · ${target.assignedAssociateName}` : ' · unassigned'}
            {' '}— change the date, time, position, rates, or notes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Position" required>
              {(p) => (
                <PositionSelect
                  value={position}
                  onChange={setPosition}
                  options={positionOptions}
                  fieldProps={p}
                />
              )}
            </Field>
            <Field label="Sub-zone (optional)" hint='Label within the site (e.g. "Bar", "Floor 2").'>
              {(p) => (
                <Input value={subzone} onChange={(e) => setSubzone(e.target.value)} {...p} />
              )}
            </Field>
            <Field label="Starts at" required hint={tzHint}>
              {(p) => (
                <Input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label="Ends at" required>
              {(p) => (
                <Input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label="Bill rate /hr (optional)">
              {(p) => (
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={hourlyRate}
                  onChange={(e) => setHourlyRate(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label="Pay rate /hr (optional)">
              {(p) => (
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={payRate}
                  onChange={(e) => setPayRate(e.target.value)}
                  {...p}
                />
              )}
            </Field>
          </div>
          <Field label="Notes (optional)">
            {(p) => <Input value={notes} onChange={(e) => setNotes(e.target.value)} {...p} />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Create-shift dialog ================================================ */

function CreateShiftDialog({
  open,
  clients,
  associates,
  initialDate,
  initialAssociateId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  clients: ClientSummary[];
  /** Schedulable employees, for the multi-assign picker. */
  associates: AssociateLite[];
  initialDate?: Date | null;
  /** When set, the created shift is auto-assigned to this associate. */
  initialAssociateId?: string | null;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState<LocationSummary[] | null>(null);
  // Employees scoped to the dialog's selected client — so the multi-assign
  // picker only offers people who work for that client. Seeded from the
  // page-level roster prop, then refined per client below.
  const [scopedAssociates, setScopedAssociates] = useState<AssociateLite[]>(associates);
  const [position, setPosition] = useState('');
  const positionOptions = useShiftPositionNames(clientId);
  // When opened from a calendar cell we know the day → switch to time-only
  // inputs (`HH:MM`) and show the date as a header label. When opened from
  // the toolbar the day is unknown, so fall back to full datetime-local.
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  // The "anchor day" for time-only mode. null means full datetime mode.
  const [anchorDay, setAnchorDay] = useState<Date | null>(null);
  const [location, setLocation] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [payRate, setPayRate] = useState('');
  const [notes, setNotes] = useState('');
  const [lateNoticeReason, setLateNoticeReason] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Default to DRAFT — new shifts are private until the manager publishes
  // the week. This is the Sling/Deputy convention and surfaces the publish
  // flow naturally (the publish ribbon shows up the moment a draft exists).
  // The manager can override per-shift via the "Publish immediately" toggle.
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Multi-assign: which employees get a copy of this shift, plus how many
  // extra unassigned "open slots" to post.
  const [assignIds, setAssignIds] = useState<Set<string>>(new Set());
  const [openSlots, setOpenSlots] = useState('0');
  const [empSearch, setEmpSearch] = useState('');

  // Phase 131 — load Locations under the selected client. Auto-picks
  // the first option so HR can hit Save in the single-site case
  // without an extra click. Re-runs on every OPEN (not just client change)
  // so reopening for the same client re-fetches and re-auto-picks — the
  // open-reset effect clears locationId, and without this the Location
  // field would be blank (and Save blocked) on reopen.
  useEffect(() => {
    if (!open) return;
    setLocationId('');
    if (!clientId) {
      setLocations(null);
      return;
    }
    let cancelled = false;
    setLocations(null);
    listClientLocations(clientId)
      .then((r) => {
        if (cancelled) return;
        setLocations(r.locations);
        if (r.locations.length > 0) setLocationId(r.locations[0]!.id);
      })
      .catch(() => {
        if (!cancelled) setLocations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, open]);

  // Scope the multi-assign picker to the chosen client's employees. Without
  // a client we fall back to the page roster prop. (Scoped by client, not
  // the specific location, so you can still staff a new site with any of
  // the client's people.)
  useEffect(() => {
    if (!open) return;
    if (!clientId) {
      setScopedAssociates(associates);
      return;
    }
    let cancelled = false;
    listSchedulingAssociates({ clientId })
      .then((r) => {
        if (!cancelled) setScopedAssociates(r.associates);
      })
      .catch(() => {
        if (!cancelled) setScopedAssociates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, clientId, associates]);

  useEffect(() => {
    if (open) {
      setClientId(clients[0]?.id ?? '');
      setPosition('');
      // When opened from a calendar cell, pre-fill 9am–5pm on that day —
      // the most common shift shape for hourly workforce, easy to edit.
      if (initialDate) {
        const day = new Date(initialDate);
        day.setHours(0, 0, 0, 0);
        setAnchorDay(day);
        // initialDate may include a clicked time-of-day (TimeGridWeekView
        // passes the snapped hour); honor it when set, else default 9–5.
        const initHasTime =
          initialDate.getHours() !== 0 || initialDate.getMinutes() !== 0;
        if (initHasTime) {
          const start = new Date(initialDate);
          const end = new Date(initialDate);
          end.setHours(end.getHours() + 4); // 4h default block off the click
          setStartTime(toLocalTimeInput(start));
          setEndTime(toLocalTimeInput(end));
        } else {
          setStartTime('09:00');
          setEndTime('17:00');
        }
        setStartsAt('');
        setEndsAt('');
      } else {
        setAnchorDay(null);
        setStartTime('');
        setEndTime('');
        setStartsAt('');
        setEndsAt('');
      }
      setLocation('');
      setHourlyRate('');
      setPayRate('');
      setNotes('');
      setLateNoticeReason('');
      setShowAdvanced(false);
      setPublishImmediately(false);
      setSubmitting(false);
      // Pre-select the employee whose cell was clicked, if any.
      setAssignIds(initialAssociateId ? new Set([initialAssociateId]) : new Set());
      setOpenSlots('0');
      setEmpSearch('');
    }
  }, [open, clients, initialDate, initialAssociateId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    // Compose final ISO timestamps from whichever input mode is active. The
    // times the admin types are wall-clock at the WORK SITE — interpret them
    // in the selected location's zone (the grid renders shifts in that zone
    // too), not the admin's browser zone. siteTz null → browser-local, which
    // matches the old behavior for location-less / full-org shifts.
    const siteTz =
      locations?.find((l) => l.id === locationId)?.timezone ?? null;
    let startISO: string;
    let endISO: string;
    if (anchorDay) {
      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);
      const y = anchorDay.getFullYear();
      const mo = anchorDay.getMonth() + 1;
      const d = anchorDay.getDate();
      const start = zonedWallTimeToUtc(y, mo, d, sh, sm, siteTz);
      let end = zonedWallTimeToUtc(y, mo, d, eh, em, siteTz);
      // Overnight: end <= start rolls end to the next site-local day (re-convert
      // so a DST boundary that night is handled). Matches template-apply.
      if (end <= start) end = zonedWallTimeToUtc(y, mo, d + 1, eh, em, siteTz);
      startISO = start.toISOString();
      endISO = end.toISOString();
    } else {
      startISO = localInputToUtcIso(startsAt, siteTz);
      endISO = localInputToUtcIso(endsAt, siteTz);
    }
    const assignList = [...assignIds];
    const open = Math.max(0, Math.trunc(Number(openSlots)) || 0);
    const shared = {
      clientId,
      ...(locationId ? { locationId } : {}),
      position,
      startsAt: startISO,
      endsAt: endISO,
      location: location || undefined,
      hourlyRate: hourlyRate ? Number(hourlyRate) : undefined,
      payRate: payRate ? Number(payRate) : undefined,
      notes: notes || undefined,
      status: (publishImmediately ? 'OPEN' : 'DRAFT') as ShiftStatus,
      lateNoticeReason: lateNoticeReason.trim() || undefined,
    };
    setSubmitting(true);
    try {
      if (assignList.length > 0 || open > 0) {
        // Create one copy per selected employee (+ any open slots) in a
        // single call; employees already scheduled at this time are skipped.
        const res = await bulkCreateShifts({
          ...shared,
          associateIds: assignList,
          openCount: open,
        });
        const made = `${res.created} shift${res.created === 1 ? '' : 's'}`;
        if (res.skipped.length > 0) {
          toast.success(
            `Created ${made} · skipped ${res.skipped.length} already scheduled then`,
          );
        } else {
          toast.success(`Created ${made}.`);
        }
      } else {
        // No employees chosen → a single unassigned shift (open coverage).
        await createShift(shared);
        toast.success('Shift created.');
      }
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Create failed.');
      setSubmitting(false);
    }
  };

  // Times are entered in the work-site's zone (we store/render shifts there).
  // When the admin isn't in that zone, label it so "4am" isn't misread as
  // the admin's local 4am.
  const siteTz = locations?.find((l) => l.id === locationId)?.timezone ?? null;
  const tzHint =
    siteTz && siteTz !== browserTimeZone()
      ? `Times are in the work site's zone (${tzAbbrev(siteTz)}).`
      : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New shift</DialogTitle>
          <DialogDescription>
            Define the shift once and assign it to one or many employees —
            each gets their own copy. Drafts stay private until you publish.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Client" required>
              {(p) =>
                clients.length > 0 ? (
                  <Select
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    {...p}
                  >
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    placeholder="Client UUID"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    {...p}
                  />
                )
              }
            </Field>
            <Field
              label="Location"
              required
              hint="Physical site. Used by the kiosk geofence and reports."
            >
              {(p) => (
                <Select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  disabled={!clientId || locations === null || locations.length === 0}
                  {...p}
                >
                  <option value="">
                    {!clientId
                      ? 'Pick a client first'
                      : locations === null
                        ? 'Loading…'
                        : locations.length === 0
                          ? 'No locations under this client'
                          : 'Select a location'}
                  </option>
                  {locations?.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l.state ? ` · ${l.state}` : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Position" required>
              {(p) => (
                <PositionSelect
                  value={position}
                  onChange={setPosition}
                  options={positionOptions}
                  disabled={!clientId}
                  fieldProps={p}
                />
              )}
            </Field>
            {anchorDay ? (
              <>
                <div className="md:col-span-2 -mb-1">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-silver/70">
                        Day
                      </div>
                      <div className="text-sm text-white tabular-nums">
                        {anchorDay.toLocaleDateString(undefined, {
                          weekday: 'long',
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        // Drop into full datetime-local mode if the user
                        // wants to span multiple days or pick a different
                        // date. Pre-seed from the current time-only values.
                        const [sh, sm] = startTime.split(':').map(Number);
                        const [eh, em] = endTime.split(':').map(Number);
                        const start = new Date(anchorDay);
                        start.setHours(sh || 9, sm || 0, 0, 0);
                        const end = new Date(anchorDay);
                        end.setHours(eh || 17, em || 0, 0, 0);
                        setStartsAt(toLocalDatetimeInput(start));
                        setEndsAt(toLocalDatetimeInput(end));
                        setAnchorDay(null);
                      }}
                      className="text-[11px] text-silver/70 hover:text-gold underline underline-offset-2"
                    >
                      Different day?
                    </button>
                  </div>
                </div>
                <Field label="Start time" required hint={tzHint}>
                  {(p) => (
                    <Input
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      {...p}
                    />
                  )}
                </Field>
                <Field label="End time" required>
                  {(p) => (
                    <Input
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      {...p}
                    />
                  )}
                </Field>
              </>
            ) : (
              <>
                <Field label="Starts at" required hint={tzHint}>
                  {(p) => (
                    <Input
                      type="datetime-local"
                      value={startsAt}
                      onChange={(e) => setStartsAt(e.target.value)}
                      {...p}
                    />
                  )}
                </Field>
                <Field label="Ends at" required>
                  {(p) => (
                    <Input
                      type="datetime-local"
                      value={endsAt}
                      onChange={(e) => setEndsAt(e.target.value)}
                      {...p}
                    />
                  )}
                </Field>
              </>
            )}
            <Field
              label="Sub-zone (optional)"
              hint='Free-text label within the Location (e.g. "Bar", "Patio", "Floor 2").'
            >
              {(p) => (
                <Input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  {...p}
                />
              )}
            </Field>
          </div>

          {/* Multi-assign — drop a copy of this shift onto each chosen
              employee (their own row), plus optional open slots. Leaving it
              empty creates a single unassigned shift. */}
          <div className="rounded-md border border-navy-secondary bg-navy-secondary/20 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-white">
                Assign to employees
                {assignIds.size > 0 && (
                  <span className="ml-2 text-gold tabular-nums">{assignIds.size} selected</span>
                )}
              </div>
              {scopedAssociates.length > 0 && (
                <div className="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setAssignIds(new Set(scopedAssociates.map((a) => a.id)))}
                    className="text-silver/70 hover:text-gold underline underline-offset-2"
                  >
                    Select all
                  </button>
                  {assignIds.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setAssignIds(new Set())}
                      className="text-silver/70 hover:text-gold underline underline-offset-2"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
            {scopedAssociates.length === 0 ? (
              <div className="text-[11px] text-silver/70">
                No schedulable employees for this client. The shift will be created unassigned.
              </div>
            ) : (
              <>
                <Input
                  value={empSearch}
                  onChange={(e) => setEmpSearch(e.target.value)}
                  placeholder="Search employees…"
                  className="h-8 text-xs"
                  aria-label="Search employees"
                />
                <div className="max-h-44 overflow-y-auto rounded border border-navy-secondary/60 divide-y divide-navy-secondary/40">
                  {scopedAssociates
                    .filter((a) => {
                      const q = empSearch.trim().toLowerCase();
                      if (!q) return true;
                      return `${a.firstName} ${a.lastName} ${a.email}`
                        .toLowerCase()
                        .includes(q);
                    })
                    .map((a) => {
                      const checked = assignIds.has(a.id);
                      return (
                        <label
                          key={a.id}
                          className="flex items-center gap-2 px-2 py-1.5 text-xs text-silver hover:bg-navy-secondary/40 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            className="accent-gold"
                            checked={checked}
                            onChange={() =>
                              setAssignIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(a.id)) next.delete(a.id);
                                else next.add(a.id);
                                return next;
                              })
                            }
                          />
                          <span className="truncate">
                            {a.firstName} {a.lastName}
                          </span>
                        </label>
                      );
                    })}
                </div>
              </>
            )}
            <div className="flex items-center gap-2 pt-1">
              <label className="text-[11px] text-silver/70" htmlFor="open-slots">
                Extra open (unassigned) slots
              </label>
              <Input
                id="open-slots"
                type="number"
                min={0}
                max={100}
                value={openSlots}
                onChange={(e) => setOpenSlots(e.target.value)}
                className="h-8 w-20 text-xs"
              />
            </div>
            <div className="text-[11px] text-silver/60">
              {assignIds.size + (Math.max(0, Math.trunc(Number(openSlots)) || 0)) > 0
                ? `Creates ${assignIds.size} assigned + ${Math.max(0, Math.trunc(Number(openSlots)) || 0)} open = ${assignIds.size + Math.max(0, Math.trunc(Number(openSlots)) || 0)} shift${assignIds.size + Math.max(0, Math.trunc(Number(openSlots)) || 0) === 1 ? '' : 's'}. Anyone already scheduled then is skipped.`
                : 'No employees selected — creates one unassigned shift.'}
            </div>
          </div>

          {/* Advanced — rates, late-notice. Hidden by default because
              rates are usually set at the position/client level, not on
              every individual shift, and most managers never touch them. */}
          <div className="border-t border-navy-secondary pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-[11px] uppercase tracking-wider text-silver/70 hover:text-gold inline-flex items-center gap-1"
            >
              {showAdvanced ? '▾' : '▸'} Advanced
              {!showAdvanced && (
                <span className="normal-case tracking-normal text-silver/70">
                  · rates, late-notice reason
                </span>
              )}
            </button>
            {showAdvanced && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                <Field label="Pay rate ($/hr)">
                  {(p) => (
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={payRate}
                      onChange={(e) => setPayRate(e.target.value)}
                      placeholder="What the associate is paid"
                      {...p}
                    />
                  )}
                </Field>
                <Field label="Bill rate ($/hr)">
                  {(p) => (
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={hourlyRate}
                      onChange={(e) => setHourlyRate(e.target.value)}
                      placeholder="What the client is billed"
                      {...p}
                    />
                  )}
                </Field>
                <Field label="Late-notice reason" className="md:col-span-2">
                  {(p) => (
                    <Textarea
                      rows={2}
                      value={lateNoticeReason}
                      onChange={(e) => setLateNoticeReason(e.target.value)}
                      placeholder="Only required for fair-workweek states inside the 14-day window"
                      {...p}
                    />
                  )}
                </Field>
              </div>
            )}
          </div>
          <Field label="Notes">
            {(p) => (
              <Textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                {...p}
              />
            )}
          </Field>
          {/* Publish-now toggle. Default off → save as draft, which lets
              the manager build the whole week privately before broadcasting.
              Flipping on creates an OPEN shift visible to associates the
              moment it's saved. */}
          <label className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-navy-secondary bg-navy-secondary/30 cursor-pointer">
            <input
              type="checkbox"
              checked={publishImmediately}
              onChange={(e) => setPublishImmediately(e.target.checked)}
              className="mt-0.5 accent-gold"
            />
            <div className="flex-1">
              <div className="text-sm text-white font-medium">
                Publish immediately
              </div>
              <div className="text-[11px] text-silver/70">
                {publishImmediately
                  ? 'Will be visible to assigned associate the moment you save.'
                  : 'Saved as draft. Stays private until you click "Publish week".'}
              </div>
            </div>
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {publishImmediately ? 'Create & publish' : 'Save as draft'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Phase 51 — Templates dialog ======================================== */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtMinute(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const period = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, '0')}${period}`;
}

function TemplatesDialog({
  open,
  onOpenChange,
  clients,
  weekStart,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clients: ClientSummary[];
  weekStart: Date;
  onApplied: () => void;
}) {
  const [templates, setTemplates] = useState<ShiftTemplate[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await listShiftTemplates();
      setTemplates(res.templates);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load templates.');
    }
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const onApply = async (id: string, requiresClient: boolean) => {
    let clientId: string | undefined;
    if (requiresClient) {
      const fallback = clients[0]?.id;
      if (!fallback) {
        toast.error('Create a client first to apply a global template.');
        return;
      }
      clientId = fallback;
    }
    setPendingId(id);
    try {
      await applyShiftTemplate(id, {
        weekStart: weekStart.toISOString(),
        clientId,
      });
      onApplied();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Apply failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm('Delete this template? Existing shifts created from it are not affected.')) return;
    setPendingId(id);
    try {
      await deleteShiftTemplate(id);
      toast.success('Template deleted.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Delete failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Shift templates</DialogTitle>
          <DialogDescription>
            Reusable "Friday closer", "weekend opener" patterns. Apply one to drop a
            DRAFT shift on the matching day of the week you're viewing.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end mb-2">
          <Button variant="secondary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-3.5 w-3.5" />
            New template
          </Button>
        </div>

        {!templates && <Skeleton className="h-32" />}
        {templates && templates.length === 0 && (
          <p className="text-silver text-sm py-4 text-center">
            No templates yet — create one to get started.
          </p>
        )}
        {templates && templates.length > 0 && (
          <ul className="space-y-2">
            {templates.map((t) => (
              <li
                key={t.id}
                className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded-md flex items-start justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-white text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-silver mt-0.5 flex flex-wrap gap-x-3">
                    <span>{t.position}</span>
                    <span className="tabular-nums">
                      {DAY_NAMES[t.dayOfWeek]} · {fmtMinute(t.startMinute)}–{fmtMinute(t.endMinute)}
                    </span>
                    <span className={t.clientName ? 'text-silver' : 'text-gold/80 italic'}>
                      {t.clientName ?? 'global'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    onClick={() => onApply(t.id, t.clientId === null)}
                    disabled={pendingId === t.id}
                  >
                    Apply
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => onDelete(t.id)}
                    disabled={pendingId === t.id}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <CreateTemplateDialog
          open={showCreate}
          clients={clients}
          onOpenChange={setShowCreate}
          onCreated={() => {
            setShowCreate(false);
            toast.success('Template created.');
            refresh();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function CreateTemplateDialog({
  open,
  clients,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  clients: ClientSummary[];
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [position, setPosition] = useState('');
  const [clientId, setClientId] = useState<string>('');
  // Global templates (no client) have no per-client catalog to source from,
  // so the position field stays free-text in that case (handled below).
  const positionOptions = useShiftPositionNames(clientId);
  const [dayOfWeek, setDayOfWeek] = useState(1); // Monday
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [hourlyRate, setHourlyRate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setPosition('');
      setClientId('');
      setDayOfWeek(1);
      setStartTime('09:00');
      setEndTime('17:00');
      setHourlyRate('');
      setSubmitting(false);
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parseHHMM = (s: string): number => {
      const [h, m] = s.split(':').map(Number);
      return h * 60 + (m || 0);
    };
    setSubmitting(true);
    try {
      await createShiftTemplate({
        clientId: clientId || null,
        name: name.trim(),
        position: position.trim(),
        dayOfWeek,
        startMinute: parseHHMM(startTime),
        endMinute: parseHHMM(endTime),
        hourlyRate: hourlyRate ? Number(hourlyRate) : null,
      });
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Create failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New shift template</DialogTitle>
          <DialogDescription>
            Saves a reusable shape. Applying it stamps a DRAFT shift on the chosen
            day of the visible week.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name" required>
              {(p) => (
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  {...p}
                />
              )}
            </Field>
            <Field
              label="Position"
              required
              hint={!clientId ? 'Global template — type any position name.' : undefined}
            >
              {(p) =>
                clientId ? (
                  <PositionSelect
                    value={position}
                    onChange={setPosition}
                    options={positionOptions}
                    fieldProps={p}
                  />
                ) : (
                  <Input
                    value={position}
                    onChange={(e) => setPosition(e.target.value)}
                    maxLength={120}
                    {...p}
                  />
                )
              }
            </Field>
            <Field label="Client (or global)">
              {(p) => (
                <Select
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  {...p}
                >
                  <option value="">— Global —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Day of week" required>
              {(p) => (
                <Select
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                  {...p}
                >
                  {DAY_NAMES.map((n, i) => (
                    <option key={i} value={i}>{n}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Start time" required>
              {(p) => (
                <Input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label="End time" required>
              {(p) => (
                <Input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label="Hourly rate ($)">
              {(p) => (
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={hourlyRate}
                  onChange={(e) => setHourlyRate(e.target.value)}
                  {...p}
                />
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ===== View tab + filter bar + publish ribbon (Phase 53) ================== */

function ViewTab({
  current,
  value,
  onClick,
  icon: Icon,
  label,
}: {
  current: ViewMode;
  value: ViewMode;
  onClick: (v: ViewMode) => void;
  icon: LucideIcon;
  label: string;
}) {
  const active = current === value;
  return (
    <Button
      type="button"
      variant={active ? 'primary' : 'ghost'}
      size="xs"
      onClick={() => onClick(value)}
      className="uppercase tracking-wider rounded-sm"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

function FilterBar({
  posFilter,
  setPosFilter,
  positions,
  clientFilter,
  setClientFilter,
  locationFilter,
  setLocationFilter,
  clientLocations,
  clients,
  showAllAssociates,
  setShowAllAssociates,
  showAssociateToggle,
}: {
  posFilter: string;
  setPosFilter: (v: string) => void;
  positions: string[];
  clientFilter: string;
  setClientFilter: (v: string) => void;
  locationFilter: string;
  setLocationFilter: (v: string) => void;
  clientLocations: LocationSummary[];
  clients: ClientSummary[];
  showAllAssociates: boolean;
  setShowAllAssociates: (v: boolean) => void;
  showAssociateToggle: boolean;
}) {
  const anyActive =
    posFilter.trim() !== '' || clientFilter !== '' || locationFilter !== '';
  const clientName = clients.find((c) => c.id === clientFilter)?.name;
  const locationName = clientLocations.find((l) => l.id === locationFilter)?.name;
  // Location only makes sense once a client is chosen (a Location belongs to
  // one client). With "All clients" selected this stays disabled.
  const locationDisabled = !clientFilter;
  return (
    <div className="mb-3 rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 py-2">
      {/* Scope line — tells the admin exactly what they're looking at. */}
      <div className="mb-2 text-[11px] text-silver/80">
        {!clientFilter ? (
          <span>
            <span className="font-medium text-white">Full schedule</span>
            <span className="text-silver/60"> · every client &amp; location in the organization</span>
          </span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="font-medium text-white">{clientName ?? 'Client'}</span>
            {locationName ? (
              <>
                <span className="text-silver/50">›</span>
                <span className="font-medium text-white">{locationName}</span>
              </>
            ) : (
              <span className="text-silver/60">· all locations</span>
            )}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[10px] uppercase tracking-wider text-silver/70 inline-flex items-center gap-1">
          <Filter className="h-3 w-3" />
          Filter
        </div>
        <div className="min-w-[10rem]">
          <Select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            size="sm"
            aria-label="Filter by client"
          >
            <option value="">All clients (full schedule)</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-[11rem]">
          <Select
            value={locationFilter}
            onChange={(e) => setLocationFilter(e.target.value)}
            size="sm"
            aria-label="Filter by location"
            disabled={locationDisabled}
          >
            <option value="">
              {locationDisabled
                ? 'Select a client first'
                : clientLocations.length === 0
                  ? 'No locations for this client'
                  : 'All locations'}
            </option>
            {clientLocations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-[10rem]">
          <Select
            value={posFilter}
            onChange={(e) => setPosFilter(e.target.value)}
            size="sm"
            aria-label="Filter by position"
            disabled={positions.length === 0}
          >
            <option value="">
              {positions.length === 0 ? 'No positions yet' : 'All positions'}
            </option>
            {positions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </div>
        {anyActive && (
          <button
            type="button"
            onClick={() => {
              setPosFilter('');
              setClientFilter('');
              setLocationFilter('');
            }}
            className="text-[10px] text-silver/70 hover:text-gold underline underline-offset-2 ml-1"
          >
            Clear
          </button>
        )}
        {showAssociateToggle && (
          <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-silver cursor-pointer">
            <input
              type="checkbox"
              checked={showAllAssociates}
              onChange={(e) => setShowAllAssociates(e.target.checked)}
              className="accent-gold"
            />
            Show all associates
          </label>
        )}
      </div>
    </div>
  );
}

function PublishRibbon({
  count,
  onPublish,
  loading,
}: {
  count: number;
  onPublish: () => void;
  loading: boolean;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-gold/40 bg-gold/[0.06]">
      <div className="text-sm text-white">
        <span className="font-medium tabular-nums">{count}</span>{' '}
        draft shift{count === 1 ? '' : 's'} ready to publish for this week.
        <span className="text-silver/70 ml-1">
          Drafts are private until you publish.
        </span>
      </div>
      <Button onClick={onPublish} loading={loading} variant="primary">
        <Send className="h-3.5 w-3.5" />
        Publish week
      </Button>
    </div>
  );
}

function AutoScheduleRibbon({
  count,
  onAutoSchedule,
  loading,
}: {
  count: number;
  onAutoSchedule: () => void;
  loading: boolean;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-silver/30 bg-silver/[0.04]">
      <div className="text-sm text-white">
        <span className="font-medium tabular-nums">{count}</span>{' '}
        open shift{count === 1 ? '' : 's'} this week need an associate.
        <span className="text-silver/70 ml-1">
          Auto-schedule picks the best fit per shift — you still publish.
        </span>
      </div>
      <Button onClick={onAutoSchedule} loading={loading} variant="secondary">
        <Wand2 className="h-3.5 w-3.5" />
        Auto-schedule week
      </Button>
    </div>
  );
}
