import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Calendar,
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
  Shift,
  ShiftStatus,
  ShiftSwapRequest,
  ShiftTemplate,
} from '@alto-people/shared';
import {
  applyShiftTemplate,
  assignShift,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
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
  endOfWeekMonday,
  shiftWeek,
  startOfWeekMonday,
} from './WeekCalendarView';
import { DayCalendarView } from './DayCalendarView';
import { TimeGridWeekView } from './TimeGridWeekView';
import { SelectionToolbar } from './SelectionToolbar';
import { TemplatesRail } from './TemplatesRail';
import { MonthCalendarView } from './MonthCalendarView';
import type { LucideIcon } from 'lucide-react';

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
  return new Date(iso).toLocaleString();
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
  };

  // Week-view layout: time-grid (Sling/Outlook style) vs compact (text rows).
  // Persisted in localStorage so the manager's preference sticks across visits.
  const [weekLayout, setWeekLayout] = useState<'time-grid' | 'compact'>(() => {
    if (typeof window === 'undefined') return 'time-grid';
    const stored = window.localStorage.getItem('alto:scheduling.weekLayout');
    return stored === 'compact' ? 'compact' : 'time-grid';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('alto:scheduling.weekLayout', weekLayout);
  }, [weekLayout]);

  const [filter, setFilter] = useState<ShiftStatus | 'ALL'>('OPEN');
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [associates, setAssociates] = useState<AssociateLite[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createInitialDate, setCreateInitialDate] = useState<Date | null>(null);
  const [createInitialAssociateId, setCreateInitialAssociateId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Phase 53 — calendar filter bar. Position is free text; client + location
  // are dropdowns derived from the data. All three are AND-combined.
  const [posFilter, setPosFilter] = useState<string>('');
  const [clientFilter, setClientFilter] = useState<string>(''); // '' = all
  const [locationFilter, setLocationFilter] = useState<string>(''); // '' = all
  const [showAllAssociates, setShowAllAssociates] = useState<boolean>(true);

  // Week-view state. weekStart is always a Monday at 00:00 local.
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()));
  const weekEnd = useMemo(() => endOfWeekMonday(weekStart), [weekStart]);

  // Day-view anchor (defaults to today). Independent of weekStart so the
  // user can have a "calendar week" they're planning AND a "today" zoom.
  const [dayAnchor, setDayAnchor] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Month-view anchor (first of month).
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Phase 54.2 — list-view date range (defaults to the current month). When
  // either bound is empty the field is treated as unbounded on that side.
  const [listFrom, setListFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(1);
    return ymd(d);
  });
  const [listTo, setListTo] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    d.setDate(0); // last day of current month
    return ymd(d);
  });

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
  useEffect(() => {
    getSchedulingKpis().then(setKpis).catch(() => setKpis(null));
    // shifts changing is a proxy for "something happened" — refresh KPIs
    // after assigns / cancels / publishes so the strip doesn't go stale.
  }, [shifts]);

  // Dialog state — replaces window.prompt + window.confirm.
  const [assignTarget, setAssignTarget] = useState<Shift | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Shift | null>(null);
  const [autoFillForShift, setAutoFillForShift] = useState<{
    shiftId: string;
    candidates: AutoFillCandidate[];
  } | null>(null);

  const refresh = useCallback(async () => {
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
        const monthEnd = new Date(monthAnchor);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        args = { from: monthAnchor.toISOString(), to: monthEnd.toISOString() };
      } else {
        args = filter === 'ALL' ? {} : { status: filter };
        // Phase 54.2 — list view honors a date range alongside the status
        // filter. Empty bounds = unbounded on that side.
        if (listFrom) {
          args = { ...args, from: fromYmd(listFrom).toISOString() };
        }
        if (listTo) {
          // Inclusive end-of-day: bump 1 day forward and use < (server uses lte
          // so we send the *next* day at 00:00 to capture the full last day).
          const end = fromYmd(listTo);
          end.setDate(end.getDate() + 1);
          args = { ...args, to: end.toISOString() };
        }
      }
      if (clientFilter) args = { ...args, clientId: clientFilter };
      const res = await listShifts(args);
      setShifts(res.shifts);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load shifts.';
      toast.error(msg);
    }
  }, [filter, view, weekStart, weekEnd, dayAnchor, monthAnchor, clientFilter, listFrom, listTo]);

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

  // Phase 53 — associate list for the pivot grid Y axis.
  useEffect(() => {
    if (!canManage) return;
    listSchedulingAssociates()
      .then((res) => setAssociates(res.associates))
      .catch(() => setAssociates([]));
  }, [canManage]);

  // Filter the loaded shift set by the position / location filter (client
  // is filtered server-side via clientId param).
  const filteredShifts = useMemo(() => {
    if (!shifts) return shifts;
    const pos = posFilter.trim().toLowerCase();
    const loc = locationFilter.trim().toLowerCase();
    if (!pos && !loc) return shifts;
    return shifts.filter((s) => {
      if (pos && !s.position.toLowerCase().includes(pos)) return false;
      if (loc) {
        if (!s.location || !s.location.toLowerCase().includes(loc)) return false;
      }
      return true;
    });
  }, [shifts, posFilter, locationFilter]);

  // Phase 53.5 — derive distinct location values from the loaded shifts so
  // HR doesn't have to type. Falls back to free-text input above when empty.
  const locationOptions = useMemo(() => {
    if (!shifts) return [] as string[];
    const set = new Set<string>();
    for (const s of shifts) {
      if (s.location && s.location.trim()) set.add(s.location.trim());
    }
    return Array.from(set).sort();
  }, [shifts]);

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
        const startsAt = new Date(dayStart);
        startsAt.setHours(0, tpl.startMinute, 0, 0);
        const endsAt = new Date(dayStart);
        endsAt.setHours(0, tpl.endMinute, 0, 0);
        if (endsAt <= startsAt) endsAt.setDate(endsAt.getDate() + 1);

        const created = await createShift({
          clientId: targetClientId,
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
    [clientFilter, refresh],
  );

  const onShiftResize = useCallback(
    async (s: Shift, newEndsAt: Date) => {
      try {
        await updateShift(s.id, { endsAt: newEndsAt.toISOString() });
        toast.success('Shift duration updated.');
        await refresh();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Resize failed.');
        await refresh();
      }
    },
    [refresh],
  );

  // Phase 53.7 — drag-end handler. Computes the right combination of
  // assign/unassign/updateShift to make the chip land in its new cell
  // with the same time-of-day it had before.
  const onShiftMove = useCallback(
    async (s: Shift, target: { associateId: string | null; dayStart: Date }) => {
      try {
        const origStart = new Date(s.startsAt);
        const origEnd = new Date(s.endsAt);
        const origDay = new Date(origStart);
        origDay.setHours(0, 0, 0, 0);
        const dayDeltaMs = target.dayStart.getTime() - origDay.getTime();
        const dateChanged = dayDeltaMs !== 0;

        if (dateChanged) {
          await updateShift(s.id, {
            startsAt: new Date(origStart.getTime() + dayDeltaMs).toISOString(),
            endsAt: new Date(origEnd.getTime() + dayDeltaMs).toISOString(),
          });
        }

        const currentAssignee = s.assignedAssociateId ?? null;
        if (currentAssignee !== target.associateId) {
          if (target.associateId === null) {
            await unassignShift(s.id);
          } else {
            await assignShift(s.id, { associateId: target.associateId });
          }
        }
        toast.success('Shift moved.');
        await refresh();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Move failed.');
        // Refresh anyway — the partial state may have stuck.
        await refresh();
      }
    },
    [refresh]
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
      description: `Cancel ${s.position} on ${new Date(s.startsAt).toLocaleString()}?`,
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

  const quickActions = useMemo(
    () => ({
      onEdit: (s: Shift) => setAssignTarget(s),
      onAssign: (s: Shift) => setAssignTarget(s),
      onUnassign,
      onCancel: onQuickCancel,
      onDuplicate: onQuickDuplicate,
    }),
    // refresh is the only thing onUnassign / onQuickCancel / onQuickDuplicate
    // close over indirectly — including it here would over-trigger re-renders.
    // The handlers are stable enough for the hover-card use case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="max-w-6xl mx-auto print-area">
      {/* Print-only header — appears on paper above the schedule, hidden on screen. */}
      <div className="print-only mb-3">
        <div className="text-xl font-semibold">Schedule</div>
        <div className="text-sm text-gray-700">
          {fmtPrintRange(exportRange.from, exportRange.to)}
          {clientFilter && clients.find((c) => c.id === clientFilter)
            ? ` · ${clients.find((c) => c.id === clientFilter)?.name}`
            : ''}
          {posFilter ? ` · position: ${posFilter}` : ''}
          {locationFilter ? ` · location: ${locationFilter}` : ''}
        </div>
        <div className="text-[10px] text-gray-500 mt-1">
          Generated {new Date().toLocaleString()}
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

      {canManage && (
        <CreateShiftDialog
          open={showCreate}
          clients={clients}
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
          <div className="inline-flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWeekStart((w) => shiftWeek(w, -1))}
              aria-label="Previous week"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <button
              type="button"
              onClick={() => setWeekStart(startOfWeekMonday(new Date()))}
              className="px-3 py-1 text-xs uppercase tracking-wider text-silver hover:text-white border border-navy-secondary rounded-md"
            >
              Today
            </button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWeekStart((w) => shiftWeek(w, 1))}
              aria-label="Next week"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="text-sm text-silver tabular-nums ml-2">
              {weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })}
              {' – '}
              {new Date(weekEnd.getTime() - 1).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
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
            <button
              type="button"
              onClick={() => {
                const t = new Date();
                t.setHours(0, 0, 0, 0);
                setDayAnchor(t);
              }}
              className="px-3 py-1 text-xs uppercase tracking-wider text-silver hover:text-white border border-navy-secondary rounded-md"
            >
              Today
            </button>
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
            <button
              type="button"
              onClick={() => {
                const t = new Date();
                t.setDate(1);
                t.setHours(0, 0, 0, 0);
                setMonthAnchor(t);
              }}
              className="px-3 py-1 text-xs uppercase tracking-wider text-silver hover:text-white border border-navy-secondary rounded-md"
            >
              This month
            </button>
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

      {/* Phase 53.5 — filter bar (calendar views only) */}
      {canManage && view !== 'list' && (
        <div className="no-print">
          <FilterBar
            posFilter={posFilter}
            setPosFilter={setPosFilter}
            clientFilter={clientFilter}
            setClientFilter={setClientFilter}
            locationFilter={locationFilter}
            setLocationFilter={setLocationFilter}
            locationOptions={locationOptions}
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
          <span className="text-silver/60 text-xs">→</span>
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
          <span className="ml-auto text-[10px] text-silver/60 tabular-nums">
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
        <Card>
          <div className="p-2 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        </Card>
      )}

      {/* Calendar shift-click router — shared by day/week views */}
      {/* eslint-disable react-hooks/rules-of-hooks */}
      {/* Week view */}
      {filteredShifts && view === 'week' && weekLayout === 'time-grid' && (
        <TimeGridWeekView
          shifts={filteredShifts}
          associates={associates}
          weekStart={weekStart}
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
      )}
      {filteredShifts && view === 'week' && weekLayout === 'compact' && (
        <WeekCalendarView
          shifts={filteredShifts}
          associates={associates}
          weekStart={weekStart}
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
      )}

      {/* Day view — same pivot, single column with hour grid + drag-to-resize */}
      {filteredShifts && view === 'day' && (
        <DayCalendarView
          shifts={filteredShifts}
          associates={associates}
          dayAnchor={dayAnchor}
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
      )}

      {/* Month view — 6×7 mini calendar with shift counts per day */}
      {filteredShifts && view === 'month' && (
        <MonthCalendarView
          shifts={filteredShifts}
          monthAnchor={monthAnchor}
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
    return (
      <div className="mb-5">
        <Skeleton className="h-14" />
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
      <div className="text-[10px] uppercase tracking-wider text-silver/50 self-end ml-auto">
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
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setChecking(true);
      try {
        const c = await getShiftConflicts(target.id, picked.id);
        if (cancelled) return;
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
                    className="mt-1 max-h-56 overflow-y-auto rounded-md border border-navy-secondary bg-navy shadow-xl"
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
                          <div className="text-[10px] text-silver/60 truncate">
                            {a.email}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {query.trim() && matches.length === 0 && (
                  <div className="mt-1 px-3 py-2 text-xs text-silver/60 rounded-md border border-navy-secondary bg-navy">
                    No associates match “{query}”.
                  </div>
                )}
              </div>
            )}
            {checking && (
              <div className="text-[11px] text-silver/60 mt-1">Checking conflicts…</div>
            )}
            {isClean && (
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
                        c.matchesAvailability ? 'text-success' : 'text-silver/60'
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
                      {new Date(s.shiftStartsAt).toLocaleString()}
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

/* ===== Create-shift dialog ================================================ */

function CreateShiftDialog({
  open,
  clients,
  initialDate,
  initialAssociateId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  clients: ClientSummary[];
  initialDate?: Date | null;
  /** When set, the created shift is auto-assigned to this associate. */
  initialAssociateId?: string | null;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [position, setPosition] = useState('');
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
    }
  }, [open, clients, initialDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    // Compose final ISO timestamps from whichever input mode is active.
    let startISO: string;
    let endISO: string;
    if (anchorDay) {
      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);
      const start = new Date(anchorDay);
      start.setHours(sh, sm, 0, 0);
      const end = new Date(anchorDay);
      end.setHours(eh, em, 0, 0);
      // Overnight: end <= start rolls end to next day. Matches how
      // template-apply handles overnight templates server-side.
      if (end <= start) end.setDate(end.getDate() + 1);
      startISO = start.toISOString();
      endISO = end.toISOString();
    } else {
      startISO = new Date(startsAt).toISOString();
      endISO = new Date(endsAt).toISOString();
    }
    setSubmitting(true);
    try {
      const created = await createShift({
        clientId,
        position,
        startsAt: startISO,
        endsAt: endISO,
        location: location || undefined,
        hourlyRate: hourlyRate ? Number(hourlyRate) : undefined,
        payRate: payRate ? Number(payRate) : undefined,
        notes: notes || undefined,
        status: publishImmediately ? 'OPEN' : 'DRAFT',
        lateNoticeReason: lateNoticeReason.trim() || undefined,
      });
      // Phase 53.4 — when the dialog was opened by clicking an associate's
      // cell, chain an assign so the new shift lands in the right row.
      if (initialAssociateId) {
        try {
          await assignShift(created.id, { associateId: initialAssociateId });
        } catch (err) {
          // Non-fatal — the shift exists, just not assigned. Surface the
          // reason so HR knows to re-assign manually.
          toast.error(
            err instanceof ApiError
              ? `Created, but assign failed: ${err.message}`
              : 'Created, but assign failed.'
          );
        }
      }
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Create failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New shift</DialogTitle>
          <DialogDescription>
            Open shifts publish immediately. Drafts stay private until you publish them.
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
            <Field label="Position" required>
              {(p) => (
                <Input
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  placeholder="e.g. Server"
                  {...p}
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
              </>
            ) : (
              <>
                <Field label="Starts at" required>
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
            <Field label="Location">
              {(p) => (
                <Input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  {...p}
                />
              )}
            </Field>
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
                <span className="normal-case tracking-normal text-silver/50">
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
            <Field label="Position" required>
              {(p) => (
                <Input
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  maxLength={120}
                  {...p}
                />
              )}
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
    <button
      type="button"
      onClick={() => onClick(value)}
      className={cn(
        'px-3 py-1 text-xs uppercase tracking-wider rounded-sm transition-colors inline-flex items-center gap-1.5',
        active ? 'bg-gold text-navy' : 'text-silver hover:text-white'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function FilterBar({
  posFilter,
  setPosFilter,
  clientFilter,
  setClientFilter,
  locationFilter,
  setLocationFilter,
  locationOptions,
  clients,
  showAllAssociates,
  setShowAllAssociates,
  showAssociateToggle,
}: {
  posFilter: string;
  setPosFilter: (v: string) => void;
  clientFilter: string;
  setClientFilter: (v: string) => void;
  locationFilter: string;
  setLocationFilter: (v: string) => void;
  locationOptions: string[];
  clients: ClientSummary[];
  showAllAssociates: boolean;
  setShowAllAssociates: (v: boolean) => void;
  showAssociateToggle: boolean;
}) {
  const anyActive =
    posFilter.trim() !== '' || clientFilter !== '' || locationFilter !== '';
  const inputCx =
    'h-8 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 py-1 text-xs text-white focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold';
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 px-3 py-2 rounded-md border border-navy-secondary bg-navy-secondary/20">
      <div className="text-[10px] uppercase tracking-wider text-silver/70 inline-flex items-center gap-1">
        <Filter className="h-3 w-3" />
        Filter
      </div>
      <input
        type="text"
        placeholder="Position…"
        value={posFilter}
        onChange={(e) => setPosFilter(e.target.value)}
        className={cn(inputCx, 'w-32')}
        aria-label="Filter by position"
      />
      <select
        value={clientFilter}
        onChange={(e) => setClientFilter(e.target.value)}
        className={cn(inputCx, 'min-w-[10rem]')}
        aria-label="Filter by client"
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        value={locationFilter}
        onChange={(e) => setLocationFilter(e.target.value)}
        className={cn(inputCx, 'min-w-[10rem]')}
        aria-label="Filter by location"
        disabled={locationOptions.length === 0}
      >
        <option value="">
          {locationOptions.length === 0 ? '— no locations —' : 'All locations'}
        </option>
        {locationOptions.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
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
