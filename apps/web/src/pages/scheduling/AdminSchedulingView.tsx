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
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
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

      {/* Phase 53.6 — publish-week ribbon (week view only). Hides when there
          are no DRAFT shifts in the visible week. */}
      {canManage && view === 'week' && draftsInWeek > 0 && (
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
      {filteredShifts && view === 'week' && (
        <WeekCalendarView
          shifts={filteredShifts}
          associates={associates}
          weekStart={weekStart}
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
          onShiftResize={async (s, newEndsAt) => {
            try {
              await updateShift(s.id, { endsAt: newEndsAt.toISOString() });
              toast.success('Shift duration updated.');
              await refresh();
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Resize failed.');
              await refresh();
            }
          }}
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
  return (
    <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 px-4 py-3 rounded-md border border-navy-secondary bg-navy-secondary/30">
      <Kpi label="Open shifts" value={String(kpis.openShifts)} tone={kpis.openShifts > 0 ? 'text-warning' : 'text-silver'} />
      <Kpi label="Filled" value={String(kpis.assignedShifts + kpis.completedShifts)} />
      <Kpi label="Fill rate" value={`${kpis.fillRatePercent}%`} tone={fillTone} />
      <Kpi label="Hours scheduled" value={hours.toFixed(0)} />
      {kpis.draftShifts > 0 && (
        <Kpi label="Draft" value={String(kpis.draftShifts)} tone="text-silver" />
      )}
      <div className="text-[10px] uppercase tracking-wider text-silver/40 self-end ml-auto">
        this week
      </div>
    </div>
  );
}

function Kpi({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-[6rem]">
      <div className="text-[10px] uppercase tracking-wider text-silver">{label}</div>
      <div className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

/* ===== Assign dialog ====================================================== */

type ConflictRow = { position: string; client: string | null; startsAt: string };
type TimeOffRow = { category: string; startDate: string; endDate: string };

function AssignDialog({
  target,
  onClose,
  onAssigned,
}: {
  target: Shift | null;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [conflicts, setConflicts] = useState<ConflictRow[] | null>(null);
  const [timeOff, setTimeOff] = useState<TimeOffRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (target) {
      setAssociateId('');
      setConflicts(null);
      setTimeOff(null);
      setSubmitting(false);
      setChecking(false);
    }
  }, [target]);

  // Live conflict check — debounced. The /conflicts endpoint accepts any
  // string for associateId (returns 400 on a bad UUID) so we naively
  // hit it whenever the value looks plausible.
  useEffect(() => {
    if (!target) return;
    const id = associateId.trim();
    // UUID-ish gate so we don't hammer the API on every keystroke.
    if (id.length < 32) {
      setConflicts(null);
      setTimeOff(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setChecking(true);
      try {
        const c = await getShiftConflicts(target.id, id);
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
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [associateId, target]);

  const submit = async () => {
    if (!target || !associateId.trim()) return;
    setSubmitting(true);
    try {
      await assignShift(target.id, { associateId });
      onAssigned();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Assign failed.');
      setSubmitting(false);
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
            <Label htmlFor="assign-id" required>
              Associate ID
            </Label>
            <Input
              id="assign-id"
              value={associateId}
              onChange={(e) => setAssociateId(e.target.value)}
              placeholder="UUID"
              autoFocus
              required
            />
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
              disabled={!associateId.trim()}
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
          <div>
            <Label htmlFor="cancel-reason" required>
              Cancellation reason
            </Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Required for the audit trail."
              autoFocus
              rows={3}
              required
            />
          </div>
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
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [location, setLocation] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [notes, setNotes] = useState('');
  const [lateNoticeReason, setLateNoticeReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setClientId(clients[0]?.id ?? '');
      setPosition('');
      // When opened from a calendar cell, pre-fill 9am–5pm on that day —
      // the most common shift shape for hourly workforce, easy to edit.
      if (initialDate) {
        const start = new Date(initialDate);
        start.setHours(9, 0, 0, 0);
        const end = new Date(initialDate);
        end.setHours(17, 0, 0, 0);
        setStartsAt(toLocalDatetimeInput(start));
        setEndsAt(toLocalDatetimeInput(end));
      } else {
        setStartsAt('');
        setEndsAt('');
      }
      setLocation('');
      setHourlyRate('');
      setNotes('');
      setLateNoticeReason('');
      setSubmitting(false);
    }
  }, [open, clients, initialDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const created = await createShift({
        clientId,
        position,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        location: location || undefined,
        hourlyRate: hourlyRate ? Number(hourlyRate) : undefined,
        notes: notes || undefined,
        status: 'OPEN',
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
            <div>
              <Label htmlFor="cs-client" required>
                Client
              </Label>
              {clients.length > 0 ? (
                <select
                  id="cs-client"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  required
                  className="flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 py-2 text-sm text-white focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="cs-client"
                  required
                  placeholder="Client UUID"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              )}
            </div>
            <div>
              <Label htmlFor="cs-position" required>
                Position
              </Label>
              <Input
                id="cs-position"
                required
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                placeholder="e.g. Server"
              />
            </div>
            <div>
              <Label htmlFor="cs-starts" required>
                Starts at
              </Label>
              <Input
                id="cs-starts"
                type="datetime-local"
                required
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cs-ends" required>
                Ends at
              </Label>
              <Input
                id="cs-ends"
                type="datetime-local"
                required
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cs-location">Location</Label>
              <Input
                id="cs-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cs-rate">Hourly rate ($)</Label>
              <Input
                id="cs-rate"
                type="number"
                min={0}
                step="0.01"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="cs-notes">Notes</Label>
            <Textarea
              id="cs-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="cs-late">
              Late-notice reason (only required for fair-workweek states inside the 14-day window)
            </Label>
            <Textarea
              id="cs-late"
              rows={2}
              value={lateNoticeReason}
              onChange={(e) => setLateNoticeReason(e.target.value)}
              placeholder="e.g. Mutual agreement — associate volunteered to cover a sick call-out"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create shift
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
            <div>
              <Label htmlFor="ct-name" required>Name</Label>
              <Input id="ct-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            </div>
            <div>
              <Label htmlFor="ct-position" required>Position</Label>
              <Input id="ct-position" value={position} onChange={(e) => setPosition(e.target.value)} required maxLength={120} />
            </div>
            <div>
              <Label htmlFor="ct-client">Client (or global)</Label>
              <select
                id="ct-client"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 py-2 text-sm text-white focus:border-gold focus:outline-none"
              >
                <option value="">— Global —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="ct-day" required>Day of week</Label>
              <select
                id="ct-day"
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
                className="flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 py-2 text-sm text-white focus:border-gold focus:outline-none"
              >
                {DAY_NAMES.map((n, i) => (
                  <option key={i} value={i}>{n}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="ct-start" required>Start time</Label>
              <Input id="ct-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="ct-end" required>End time</Label>
              <Input id="ct-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="ct-rate">Hourly rate ($)</Label>
              <Input
                id="ct-rate"
                type="number"
                min={0}
                step="0.01"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
              />
            </div>
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
