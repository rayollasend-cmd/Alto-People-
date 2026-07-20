import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Coffee,
  Download,
  FileSpreadsheet,
  FileText,
  ListChecks,
  MapPinOff,
  Pencil,
  Plus,
  Search,
  Smartphone,
  X,
} from 'lucide-react';
import type {
  ActiveDashboardEntry,
  PayPeriod,
  TimeEntry,
  TimeEntryStatus,
} from '@alto-people/shared';
import {
  addTimeEntryBreak,
  adminCreateTimeEntry,
  adminEditTimeEntry,
  approveTimeEntry,
  deleteTimeEntryBreak,
  updateTimeEntryBreak,
  bulkApplyBreakTimeEntries,
  bulkApproveTimeEntries,
  bulkRejectTimeEntries,
  countAdminTimeEntries,
  exportPayrollSheet,
  exportTimeEntries,
  exportTimeSummary,
  getActiveDashboard,
  listAdminTimeEntries,
  listPayPeriods,
  rejectTimeEntry,
} from '@/lib/timeApi';
import { listDirectory } from '@/lib/directoryApi';
import { listClients, listClientLocations } from '@/lib/clientsApi';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePersistentState } from '@/lib/usePersistentState';
import { timeAnomalyLabel } from '@/lib/timeLabels';
import { fmtDateTime, fmtDateTz, fmtTime } from '@/lib/format';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  SkeletonRows,
  SortableTableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useTableSort,
} from '@/components/ui';

const STATUS_FILTERS: Array<{ value: TimeEntryStatus | 'ALL'; label: string }> = [
  { value: 'COMPLETED', label: 'Pending review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ALL', label: 'All' },
];

function formatHM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function statusVariant(s: TimeEntryStatus): 'success' | 'pending' | 'destructive' | 'accent' | 'default' {
  switch (s) {
    case 'APPROVED': return 'success';
    case 'COMPLETED': return 'pending';
    case 'REJECTED': return 'destructive';
    case 'ACTIVE': return 'accent';
    default: return 'default';
  }
}

// Net-first duration. The headline figure is worked-time NET of breaks —
// what payroll actually pays — with the gross span and break time as a
// subline whenever they differ. Showing only gross made approvals
// disagree with every money surface (summary export, OT, accrual).
function DurationCell({ entry }: { entry: TimeEntry }) {
  const net = entry.netMinutes ?? entry.minutesElapsed;
  const breakMin = Math.max(0, entry.minutesElapsed - net);
  return (
    <div className="tabular-nums">
      {formatHM(net)}
      {breakMin > 0 && (
        <div className="text-[10px] text-silver/70">
          {formatHM(entry.minutesElapsed)} gross − {formatHM(breakMin)} break
        </div>
      )}
    </div>
  );
}

// Punch↔shift comparison chip. Entries auto-link to the scheduled shift
// at clock-in; when the punch landed meaningfully after the scheduled
// start, surface it inline so reviewers see lateness without opening
// the drawer. 5-minute grace absorbs kiosk-queue jitter.
const LATE_GRACE_MINUTES = 5;
function LateChip({ entry }: { entry: TimeEntry }) {
  if (!entry.shiftStartsAt) return null;
  const lateMin = Math.floor(
    (new Date(entry.clockInAt).getTime() - new Date(entry.shiftStartsAt).getTime()) / 60_000,
  );
  if (lateMin <= LATE_GRACE_MINUTES) return null;
  return (
    <span
      className="text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded border border-alert/40 bg-alert/10 text-alert whitespace-nowrap"
      title={`Scheduled ${fmtTime(entry.shiftStartsAt)}${entry.shiftPosition ? ` · ${entry.shiftPosition}` : ''}`}
    >
      Late {lateMin >= 60 ? `${Math.floor(lateMin / 60)}h ${lateMin % 60}m` : `${lateMin}m`}
    </span>
  );
}

/**
 * Header strip for the individual-timesheet focus: whose entries these
 * are, their range totals by status, and the way out. The date range
 * and status chips below keep working — this only pins the WHO.
 */
function FocusBanner({
  name,
  entries,
  onClear,
}: {
  name: string;
  entries: TimeEntry[] | null;
  onClear: () => void;
}) {
  const list = entries ?? [];
  const sum = (statuses: TimeEntry['status'][]) =>
    list
      .filter((e) => statuses.includes(e.status))
      .reduce((s, e) => s + (e.netMinutes ?? e.minutesElapsed), 0);
  const approvedMin = sum(['APPROVED']);
  const pendingMin = sum(['COMPLETED', 'ACTIVE']);
  const rejectedCount = list.filter((e) => e.status === 'REJECTED').length;
  const fmtH = (m: number) => `${(m / 60).toFixed(1)}h`;

  // Weekly overtime across the loaded range: net minutes beyond 40h in any
  // local Sunday-based week (same grouping the associate timesheet uses).
  const byWeek = new Map<number, number>();
  for (const e of list) {
    if (e.status === 'REJECTED') continue;
    const d = new Date(e.clockInAt);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    byWeek.set(d.getTime(), (byWeek.get(d.getTime()) ?? 0) + (e.netMinutes ?? e.minutesElapsed));
  }
  const otMin = [...byWeek.values()].reduce((s, m) => s + Math.max(0, m - 40 * 60), 0);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-gold/40 bg-gold/5 px-3 py-2">
      <Avatar name={name} size="sm" />
      <div className="min-w-0">
        <div className="text-sm text-white font-medium truncate">{name}</div>
        <div className="text-[11px] text-silver/70">
          Individual timesheet — date range and status filters still apply
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2 text-xs tabular-nums">
        <span className="rounded-full border border-success/40 bg-success/10 px-2.5 py-1 text-success">
          {fmtH(approvedMin)} approved
        </span>
        <span className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-gold">
          {fmtH(pendingMin)} pending
        </span>
        {otMin > 0 && (
          <span className="rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-warning">
            {fmtH(otMin)} OT
          </span>
        )}
        {rejectedCount > 0 && (
          <span className="rounded-full border border-alert/40 bg-alert/10 px-2.5 py-1 text-alert">
            {rejectedCount} rejected
          </span>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onClear}
          aria-label="Back to all associates"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// Inline anomaly chips for queue rows. Reviewers used to see flags only
// after opening each row's drawer — bulk-approving meant approving
// anomalies sight-unseen.
function AnomalyChips({ anomalies }: { anomalies?: string[] | null }) {
  if (!anomalies || anomalies.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {anomalies.map((a) => (
        <span
          key={a}
          className="text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded border border-warning/40 bg-warning/10 text-warning whitespace-nowrap"
        >
          {timeAnomalyLabel(a)}
        </span>
      ))}
    </div>
  );
}

// YYYY-MM-DD in local time. Inputs and the API both treat dates as days,
// so we convert to ISO at the boundary, not in state.
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultFromYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 13); // last 14 days inclusive
  return ymdLocal(d);
}

function defaultToYmd(): string {
  return ymdLocal(new Date());
}

function ymdToIsoStart(ymd: string): string {
  return new Date(`${ymd}T00:00:00`).toISOString();
}

// "Jun 22 – Jul 5" — compact label for a pay-period option. Bare YYYY-MM-DD
// parses as UTC midnight, so format in UTC or the day shifts west of GMT.
function periodLabel(p: PayPeriod): string {
  return `${fmtDateTz(p.start, 'UTC')} – ${fmtDateTz(p.end, 'UTC')}`;
}

function ymdToIsoEndExclusive(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

interface AdminTimeViewProps {
  canManage: boolean;
}

type Tab = 'live' | 'queue';

// The live dashboard carries a lightweight ActiveDashboardEntry; widen it to
// a TimeEntry so the edit / clock-out drawer (shared with the queue) can open
// straight from a live row. These rows are always ACTIVE.
function liveEntryToTimeEntry(e: ActiveDashboardEntry): TimeEntry {
  return {
    id: e.id,
    associateId: e.associateId,
    associateName: e.associateName,
    clientId: e.clientId,
    clientName: e.clientName,
    clockInAt: e.clockInAt,
    clockOutAt: null,
    status: 'ACTIVE',
    notes: null,
    rejectionReason: null,
    approvedById: null,
    approverEmail: null,
    approvedAt: null,
    minutesElapsed: e.minutesElapsed,
    jobId: e.jobId,
    jobName: e.jobName,
    payRate: null,
    clockInLat: e.clockInLat,
    clockInLng: e.clockInLng,
    clockOutLat: null,
    clockOutLng: null,
    anomalies: [],
  };
}

export function AdminTimeView({ canManage }: AdminTimeViewProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('live');
  // Persisted list filter — a reviewer who works the Approved slice gets it
  // back next visit. A stored value no longer in STATUS_FILTERS falls back
  // to the default instead of silently rendering an empty queue.
  const [filter, setFilter] = usePersistentState<TimeEntryStatus | 'ALL'>(
    'alto:list.time.status.v1',
    'COMPLETED',
    (v): v is TimeEntryStatus | 'ALL' => STATUS_FILTERS.some((f) => f.value === v),
  );
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [active, setActive] = useState<ActiveDashboardEntry[] | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [liveSearch, setLiveSearch] = useState('');
  // Phase 65 — queue tab: server-side search + date range. Defaults give
  // the user something useful on first load (last 14 days).
  const [queueSearch, setQueueSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [fromYmd, setFromYmd] = useState<string>(defaultFromYmd());
  const [toYmd, setToYmd] = useState<string>(defaultToYmd());
  // Pay-period picker: choosing a period drives From/To; hand-editing
  // either date drops back to "Custom range" (stateful-chip pattern).
  const [payPeriods, setPayPeriods] = useState<PayPeriod[] | null>(null);
  const [periodKey, setPeriodKey] = useState('');
  // Triage lens: show only flagged entries (client-side over the loaded
  // window — same scope as everything else on this tab). Persisted — the
  // lit toggle button keeps the active lens obvious across visits.
  const [anomaliesOnly, setAnomaliesOnly] = usePersistentState<boolean>(
    'alto:list.time.anomaliesOnly.v1',
    false,
    (v): v is boolean => typeof v === 'boolean',
  );
  // Server hit its row cap — the window has MORE rows than shown.
  const [truncated, setTruncated] = useState(false);
  const [exportBusy, setExportBusy] = useState<null | 'csv' | 'pdf'>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [payrollOpen, setPayrollOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState<null | { mode: 'one'; id: string } | { mode: 'bulk' }>(null);
  const [drawerTarget, setDrawerTarget] = useState<TimeEntry | null>(null);
  // Admin clock-in/out + edit on behalf of an associate.
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TimeEntry | null>(null);

  // Individual timesheet focus: click an associate's name in the queue to
  // scope every filter to just their entries, with range totals up top.
  // Session-only by design — a persisted person-filter is the classic
  // "where did everyone go?" trap.
  const [focusAssociate, setFocusAssociate] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const focusOn = (e: TimeEntry) => {
    setFocusAssociate({ id: e.associateId, name: e.associateName ?? '—' });
    // Their full timesheet, not just the current status slice.
    setFilter('ALL');
  };

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listAdminTimeEntries({
        ...(filter !== 'ALL' ? { status: filter } : {}),
        from: ymdToIsoStart(fromYmd),
        to: ymdToIsoEndExclusive(toYmd),
        ...(appliedSearch ? { search: appliedSearch } : {}),
        ...(focusAssociate ? { associateId: focusAssociate.id } : {}),
      });
      setEntries(res.entries);
      setTruncated(Boolean(res.truncated));
      // Selection only valid on the COMPLETED filter; clear when refreshing.
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter, fromYmd, toYmd, appliedSearch, focusAssociate]);

  const refreshActive = useCallback(async () => {
    try {
      setError(null);
      const res = await getActiveDashboard();
      setActive(res.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load active dashboard.');
    }
  }, []);

  const refreshPendingCount = useCallback(async () => {
    try {
      const res = await countAdminTimeEntries('COMPLETED');
      setPendingCount(res.count);
    } catch {
      // KPI is best-effort; leave previous value.
    }
  }, []);

  // Refresh after an admin create/edit/clock-out — only the visible tab's
  // data plus the pending-review KPI. The other tab refetches on switch.
  const afterMutation = useCallback(async () => {
    await Promise.all([
      tab === 'queue' ? refresh() : refreshActive(),
      refreshPendingCount(),
    ]);
  }, [tab, refresh, refreshActive, refreshPendingCount]);

  useEffect(() => {
    if (tab === 'queue') refresh();
    else refreshActive();
  }, [tab, refresh, refreshActive]);

  // KPI: pending count loads independent of which tab is open.
  useEffect(() => {
    refreshPendingCount();
  }, [refreshPendingCount]);

  // Debounce free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setAppliedSearch(queueSearch.trim()), 300);
    return () => clearTimeout(id);
  }, [queueSearch]);

  // Pay-period options load once; on failure the picker simply stays hidden
  // and the manual From/To range keeps working.
  useEffect(() => {
    listPayPeriods()
      .then((r) => setPayPeriods(r.periods))
      .catch(() => setPayPeriods([]));
  }, []);

  const onPickPeriod = (key: string) => {
    setPeriodKey(key);
    if (!key) return; // back to custom range — keep current dates
    const p = (payPeriods ?? []).find((x) => `${x.start}|${x.end}` === key);
    if (!p) return;
    setFromYmd(p.start);
    setToYmd(p.end);
  };

  // Auto-refresh the live tab every 30s while it's open.
  useEffect(() => {
    if (tab !== 'live') return;
    const id = setInterval(refreshActive, 30_000);
    return () => clearInterval(id);
  }, [tab, refreshActive]);

  const onApprove = async (id: string) => {
    if (pendingId) return;
    setPendingId(id);
    try {
      await approveTimeEntry(id);
      await Promise.all([refresh(), refreshPendingCount()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Approve failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onSubmitReject = async (reason: string) => {
    if (!rejectOpen) return;
    if (rejectOpen.mode === 'one') {
      const id = rejectOpen.id;
      setPendingId(id);
      try {
        await rejectTimeEntry(id, { reason });
        setRejectOpen(null);
        await Promise.all([refresh(), refreshPendingCount()]);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Reject failed.');
      } finally {
        setPendingId(null);
      }
      return;
    }
    // Bulk reject.
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkRejectTimeEntries({
        entryIds: Array.from(selected),
        reason,
      });
      setRejectOpen(null);
      if (res.failed > 0) {
        setError(`${res.failed} of ${selected.size} entries could not be rejected.`);
      }
      await Promise.all([refresh(), refreshPendingCount()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Bulk reject failed.');
    } finally {
      setBulkBusy(false);
    }
  };

  const onBulkApprove = async () => {
    if (selected.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const res = await bulkApproveTimeEntries({
        entryIds: Array.from(selected),
      });
      if (res.failed > 0) {
        setError(`${res.failed} of ${selected.size} entries could not be approved.`);
      }
      await Promise.all([refresh(), refreshPendingCount()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Bulk approve failed.');
    } finally {
      setBulkBusy(false);
    }
  };

  // Standard-break cleanup for NO_BREAK piles: book the 1h unpaid meal on
  // every selected entry. The server skips entries that already have a
  // meal break, are under 6h, or aren't pending review — so a reviewer
  // can sweep-select and let the guardrails sort it out.
  const onBulkApplyBreak = async () => {
    if (selected.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const res = await bulkApplyBreakTimeEntries(Array.from(selected));
      if (res.succeeded > 0) {
        toast.success(
          `1h meal break applied to ${res.succeeded} ${res.succeeded === 1 ? 'entry' : 'entries'}.`,
        );
      }
      if (res.failed > 0) {
        toast.warning(
          `${res.failed} ${res.failed === 1 ? 'entry was' : 'entries were'} skipped (already has a break, under 6h, or not pending review).`,
        );
      }
      await Promise.all([refresh(), refreshPendingCount()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Applying breaks failed.');
    } finally {
      setBulkBusy(false);
    }
  };

  const onExport = async (format: 'csv' | 'pdf') => {
    if (exportBusy) return;
    setExportBusy(format);
    try {
      await exportTimeEntries(format, {
        from: ymdToIsoStart(fromYmd),
        to: ymdToIsoEndExclusive(toYmd),
        ...(filter !== 'ALL' ? { status: filter } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExportBusy(null);
    }
  };

  const liveStats = useMemo(() => {
    if (!active) return { total: null, onBreak: null, offSite: null };
    const onBreak = active.filter((e) => e.onBreak).length;
    const offSite = active.filter((e) => e.geofenceOk === false).length;
    return { total: active.length, onBreak, offSite };
  }, [active]);

  const filteredActive = useMemo(() => {
    if (!active) return null;
    const q = liveSearch.trim().toLowerCase();
    if (!q) return active;
    return active.filter(
      (e) =>
        e.associateName.toLowerCase().includes(q) ||
        (e.clientName ?? '').toLowerCase().includes(q) ||
        (e.jobName ?? '').toLowerCase().includes(q)
    );
  }, [active, liveSearch]);

  // What the queue actually renders — the anomalies-only lens applies here
  // so select-all and the empty state follow what's on screen.
  const visibleEntries = useMemo(() => {
    if (!entries) return null;
    if (!anomaliesOnly) return entries;
    return entries.filter((e) => (e.anomalies?.length ?? 0) > 0);
  }, [entries, anomaliesOnly]);

  // Click-to-sort for the queue's desktop table. Sorts the filtered page
  // the table renders; the md:hidden card stack keeps server order.
  const {
    sorted: sortedEntries,
    sortState: queueSort,
    toggleSort: toggleQueueSort,
  } = useTableSort(visibleEntries ?? [], {
    associate: (e: TimeEntry) => e.associateName,
    client: (e: TimeEntry) => e.clientName,
    in: (e: TimeEntry) => new Date(e.clockInAt).getTime(),
    out: (e: TimeEntry) =>
      e.clockOutAt ? new Date(e.clockOutAt).getTime() : null,
    duration: (e: TimeEntry) => e.netMinutes ?? e.minutesElapsed,
    status: (e: TimeEntry) => e.status,
  });

  const selectableIds = useMemo(() => {
    if (!visibleEntries) return [] as string[];
    // Only COMPLETED rows are bulk-actionable on the Pending review tab.
    return visibleEntries.filter((e) => e.status === 'COMPLETED').map((e) => e.id);
  }, [visibleEntries]);

  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(selectableIds));
  };

  const toggleOne = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="mx-auto">
      <PageHeader
        title="Time & Attendance"
        subtitle={
          canManage
            ? 'Review, approve, or reject time entries from associates.'
            : 'Read-only view of time entries.'
        }
        secondaryActions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add entry
              </Button>
              <Button
                variant="outline"
                onClick={() => navigate('/time-attendance/kiosk')}
              >
                <Smartphone className="mr-2 h-4 w-4" />
                Kiosk &amp; PINs
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* KPI strip — mirrors the onboarding analytics pattern. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KpiCard
          icon={Activity}
          label="Clocked in"
          value={liveStats.total === null ? '—' : String(liveStats.total)}
          tone="default"
        />
        <KpiCard
          icon={Coffee}
          label="On break"
          value={liveStats.onBreak === null ? '—' : String(liveStats.onBreak)}
          tone="warning"
        />
        <KpiCard
          icon={MapPinOff}
          label="Off-site"
          value={liveStats.offSite === null ? '—' : String(liveStats.offSite)}
          tone={liveStats.offSite && liveStats.offSite > 0 ? 'alert' : 'silver'}
        />
        <KpiCard
          icon={ListChecks}
          label="Pending review"
          value={pendingCount === null ? '—' : String(pendingCount)}
          tone={pendingCount && pendingCount > 0 ? 'warning' : 'success'}
        />
      </div>

      <div role="tablist" className="flex gap-2 mb-5 border-b border-navy-secondary">
        {(['live', 'queue'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'px-3 py-2 text-sm border-b-2 -mb-px transition capitalize',
              tab === t
                ? 'border-gold text-gold'
                : 'border-transparent text-silver hover:text-white'
            )}
          >
            {t === 'live' ? 'Live (clocked in)' : 'Approval queue'}
          </button>
        ))}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 mb-4 px-3 py-2 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-alert/60 hover:text-alert"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {tab === 'live' && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Currently clocked in</CardTitle>
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-silver/70 pointer-events-none" />
              <Input
                placeholder="Search associate, client, job…"
                value={liveSearch}
                onChange={(e) => setLiveSearch(e.target.value)}
                className="pl-8 h-9 text-sm"
              />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {!active && <SkeletonRows count={5} rowHeight="h-12" />}
            {active && active.length === 0 && (
              <EmptyState
                title="No one is clocked in"
                description="Active sessions will appear here in real time."
              />
            )}
            {active && active.length > 0 && filteredActive && (
              <>
                {/* md+ : full columnar table. */}
                <div className="hidden md:block">
                  <Table caption="Currently clocked in">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Associate</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>Job</TableHead>
                        <TableHead>Since</TableHead>
                        <TableHead>Elapsed</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Geofence</TableHead>
                        {canManage && (
                          <TableHead className="text-right">Actions</TableHead>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredActive.map((e) => (
                        <TableRow key={e.id} className="group">
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2.5">
                              <Avatar name={e.associateName} size="sm" />
                              <span>{e.associateName}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-silver">{e.clientName ?? '—'}</TableCell>
                          <TableCell className="text-silver">{e.jobName ?? '—'}</TableCell>
                          <TableCell className="tabular-nums text-silver">
                            {fmtTime(e.clockInAt)}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {formatHM(e.minutesElapsed)}
                          </TableCell>
                          <TableCell>
                            {e.onBreak ? (
                              <Badge variant="pending">On break</Badge>
                            ) : (
                              <Badge variant="success">Working</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {e.geofenceOk === null && (
                              <span className="text-xs text-silver/70">N/A</span>
                            )}
                            {e.geofenceOk === true && <Badge variant="success">OK</Badge>}
                            {e.geofenceOk === false && (
                              <Badge variant="destructive">Off-site</Badge>
                            )}
                          </TableCell>
                          {canManage && (
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditTarget(liveEntryToTimeEntry(e))}
                              >
                                Clock out
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Phone: card stack. Manager scans for "who's on shift" /
                    "is anyone off-site"; the elapsed counter and break
                    state are the load-bearing bits. */}
                <ul className="md:hidden space-y-2">
                  {filteredActive.map((e) => (
                    <li
                      key={e.id}
                      className="rounded-md border border-navy-secondary bg-navy/40 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <Avatar name={e.associateName} size="sm" />
                          <div className="min-w-0">
                            <div className="font-medium text-white truncate">
                              {e.associateName}
                            </div>
                            <div className="text-[11px] text-silver/70 truncate">
                              {e.clientName ?? '—'}
                              {e.jobName ? ` · ${e.jobName}` : ''}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {e.onBreak ? (
                            <Badge variant="pending">On break</Badge>
                          ) : (
                            <Badge variant="success">Working</Badge>
                          )}
                          {e.geofenceOk === false && (
                            <Badge variant="destructive" className="text-[10px]">
                              Off-site
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex items-end justify-between gap-3 text-[11px] text-silver">
                        <span className="tabular-nums">
                          Since {fmtTime(e.clockInAt)}
                        </span>
                        <span className="tabular-nums text-white">
                          {formatHM(e.minutesElapsed)}
                        </span>
                      </div>
                      {canManage && (
                        <div className="mt-2 flex justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditTarget(liveEntryToTimeEntry(e))}
                          >
                            Clock out
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {filteredActive.length === 0 && (
                  <p className="text-sm text-silver mt-3">
                    No matches for &ldquo;{liveSearch}&rdquo;.
                  </p>
                )}
                <div className="mt-3 text-[10px] uppercase tracking-widest text-silver/70">
                  Auto-refreshes every 30s
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {tab === 'queue' && (
        <Card>
          <CardHeader className="pb-3 gap-3">
            {focusAssociate && (
              <FocusBanner
                name={focusAssociate.name}
                entries={entries}
                onClear={() => setFocusAssociate(null)}
              />
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">
                {focusAssociate ? `${focusAssociate.name} — timesheet` : 'Time entries'}
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                {STATUS_FILTERS.map((f) => (
                  <Button
                    key={f.value}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setFilter(f.value)}
                    className={cn(
                      'uppercase tracking-wider font-normal',
                      filter === f.value
                        ? 'border-gold text-gold bg-gold/10 hover:border-gold hover:text-gold'
                        : 'border-navy-secondary'
                    )}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Phase 65 — date range + free-text search + export buttons. */}
            <div className="flex flex-wrap items-end gap-3">
              {payPeriods !== null && payPeriods.length > 0 && (
                <div>
                  <label
                    htmlFor="pay-period-picker"
                    className="block text-[10px] uppercase tracking-wider text-silver mb-1"
                  >
                    Pay period
                  </label>
                  <Select
                    id="pay-period-picker"
                    value={periodKey}
                    onChange={(e) => onPickPeriod(e.target.value)}
                    className="h-9 text-sm w-52"
                  >
                    <option value="">Custom range</option>
                    {payPeriods.map((p) => (
                      <option key={`${p.start}|${p.end}`} value={`${p.start}|${p.end}`}>
                        {periodLabel(p)}
                        {p.current ? ' · current' : p.hasRun ? ' · paid' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <div className="flex items-end gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-silver mb-1">
                    From
                  </label>
                  <Input
                    type="date"
                    value={fromYmd}
                    max={toYmd}
                    onChange={(e) => {
                      setPeriodKey('');
                      setFromYmd(e.target.value || defaultFromYmd());
                    }}
                    className="h-9 text-sm w-40"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-silver mb-1">
                    To
                  </label>
                  <Input
                    type="date"
                    value={toYmd}
                    min={fromYmd}
                    onChange={(e) => {
                      setPeriodKey('');
                      setToYmd(e.target.value || defaultToYmd());
                    }}
                    className="h-9 text-sm w-40"
                  />
                </div>
              </div>

              <div className="relative flex-1 w-full sm:min-w-[200px]">
                <label className="block text-[10px] uppercase tracking-wider text-silver mb-1">
                  Search
                </label>
                <Search className="absolute left-2.5 top-[2.1rem] h-4 w-4 text-silver/70 pointer-events-none" />
                <Input
                  placeholder="Associate name…"
                  value={queueSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                  className="pl-8 h-9 text-sm"
                />
              </div>

              <button
                type="button"
                onClick={() => setAnomaliesOnly((v) => !v)}
                className={cn(
                  'h-9 rounded-md border px-3 text-sm transition-colors self-end',
                  anomaliesOnly
                    ? 'border-warning/60 bg-warning/15 text-warning'
                    : 'border-navy-secondary bg-navy-secondary/40 text-silver hover:text-white',
                )}
              >
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" /> Anomalies only
              </button>

              {canManage && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onExport('csv')}
                    loading={exportBusy === 'csv'}
                    disabled={exportBusy !== null}
                  >
                    <Download className="h-4 w-4" />
                    CSV
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onExport('pdf')}
                    loading={exportBusy === 'pdf'}
                    disabled={exportBusy !== null}
                  >
                    <FileText className="h-4 w-4" />
                    PDF
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSummaryOpen(true)}
                    disabled={exportBusy !== null}
                  >
                    <ListChecks className="h-4 w-4" />
                    Summary
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPayrollOpen(true)}
                    disabled={exportBusy !== null}
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    Payroll sheet
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>

          {/* Bulk-action toolbar — only shown when rows are selectable & any selected. */}
          {canManage && filter === 'COMPLETED' && selected.size > 0 && (
            <div className="mx-5 mb-3 flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-md border border-gold/40 bg-gold/10">
              <div className="text-sm text-gold">
                <span className="font-medium tabular-nums">{selected.size}</span>{' '}
                selected
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={onBulkApprove}
                  loading={bulkBusy}
                  disabled={bulkBusy}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Approve {selected.size}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setRejectOpen({ mode: 'bulk' })}
                  disabled={bulkBusy}
                >
                  Reject {selected.size}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onBulkApplyBreak}
                  disabled={bulkBusy}
                  title="Book the standard 1-hour unpaid meal break, centered mid-shift, on each selected entry that has none (6h+ shifts only)"
                >
                  <Coffee className="h-4 w-4" />
                  Apply 1h break
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(new Set())}
                  disabled={bulkBusy}
                >
                  Clear
                </Button>
              </div>
            </div>
          )}

          <CardContent className="pt-0">
            {truncated && (
              <div className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                Showing the most recent 500 entries — this window has more.
                Narrow the date range to see (and bulk-act on) everything.
              </div>
            )}
            {!visibleEntries && <SkeletonRows count={6} rowHeight="h-12" />}
            {visibleEntries && visibleEntries.length === 0 && (
              <EmptyState
                title={anomaliesOnly ? 'No flagged entries' : 'Nothing to review'}
                description={
                  anomaliesOnly
                    ? 'No entries in this window carry anomaly flags.'
                    : 'No time entries match this filter.'
                }
              />
            )}
            {visibleEntries && visibleEntries.length > 0 && (
              <>
                {/* md+ : full sortable table. */}
                <div className="hidden md:block">
                  <Table caption="Time entries">
                    <TableHeader>
                      <TableRow>
                        {canManage && filter === 'COMPLETED' && (
                          <TableHead className="w-8">
                            <input
                              type="checkbox"
                              aria-label="Select all"
                              checked={allSelected}
                              ref={(el) => {
                                if (el) el.indeterminate = someSelected;
                              }}
                              onChange={toggleAll}
                              className="h-4 w-4 rounded border-navy-secondary bg-navy-secondary/40 text-gold focus:ring-gold"
                            />
                          </TableHead>
                        )}
                        <SortableTableHead sortKey="associate" state={queueSort} onSort={toggleQueueSort}>
                          Associate
                        </SortableTableHead>
                        <SortableTableHead sortKey="client" state={queueSort} onSort={toggleQueueSort}>
                          Client
                        </SortableTableHead>
                        <SortableTableHead sortKey="in" state={queueSort} onSort={toggleQueueSort}>
                          In
                        </SortableTableHead>
                        <SortableTableHead sortKey="out" state={queueSort} onSort={toggleQueueSort}>
                          Out
                        </SortableTableHead>
                        <SortableTableHead sortKey="duration" state={queueSort} onSort={toggleQueueSort}>
                          Duration
                        </SortableTableHead>
                        <SortableTableHead sortKey="status" state={queueSort} onSort={toggleQueueSort}>
                          Status
                        </SortableTableHead>
                        {canManage && <TableHead className="text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedEntries.map((e) => {
                        const isSelectable = canManage && filter === 'COMPLETED' && e.status === 'COMPLETED';
                        return (
                          <TableRow
                            key={e.id}
                            className="group cursor-pointer"
                            data-state={selected.has(e.id) ? 'selected' : undefined}
                            onClick={(ev) => {
                              const target = ev.target as HTMLElement;
                              if (target.closest('button, a, input, [data-no-row-click]')) return;
                              if (window.getSelection()?.toString()) return;
                              setDrawerTarget(e);
                            }}
                          >
                            {canManage && filter === 'COMPLETED' && (
                              <TableCell className="w-8">
                                {isSelectable && (
                                  <input
                                    type="checkbox"
                                    aria-label={`Select entry for ${e.associateName ?? 'associate'}`}
                                    checked={selected.has(e.id)}
                                    onChange={() => toggleOne(e.id)}
                                    className="h-4 w-4 rounded border-navy-secondary bg-navy-secondary/40 text-gold focus:ring-gold"
                                  />
                                )}
                              </TableCell>
                            )}
                            <TableCell className="font-medium">
                              <button
                                type="button"
                                onClick={() => focusOn(e)}
                                title="View individual timesheet"
                                className="flex items-center gap-2.5 rounded text-left hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                              >
                                <Avatar name={e.associateName ?? '—'} size="sm" />
                                <span className="underline-offset-2 hover:underline">
                                  {e.associateName ?? '—'}
                                </span>
                              </button>
                            </TableCell>
                            <TableCell className="text-silver">{e.clientName ?? '—'}</TableCell>
                            <TableCell className="tabular-nums">
                              {fmtDateTime(e.clockInAt)}
                            </TableCell>
                            <TableCell className="tabular-nums">
                              {e.clockOutAt ? fmtTime(e.clockOutAt) : '—'}
                            </TableCell>
                            <TableCell>
                              <DurationCell entry={e} />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                                <LateChip entry={e} />
                              </div>
                              <AnomalyChips anomalies={e.anomalies} />
                              {e.rejectionReason && (
                                <div className="text-alert text-[10px] mt-1">
                                  {e.rejectionReason}
                                </div>
                              )}
                            </TableCell>
                            {canManage && (
                              <TableCell className="text-right whitespace-nowrap">
                                <div className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity inline-flex items-center gap-1">
                                  {(e.status === 'COMPLETED' || e.status === 'REJECTED') && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => onApprove(e.id)}
                                      loading={pendingId === e.id}
                                      disabled={pendingId === e.id || bulkBusy}
                                    >
                                      Approve
                                    </Button>
                                  )}
                                  {(e.status === 'COMPLETED' || e.status === 'APPROVED') && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="text-alert hover:text-alert hover:bg-alert/10"
                                      onClick={() => setRejectOpen({ mode: 'one', id: e.id })}
                                      disabled={pendingId === e.id || bulkBusy}
                                    >
                                      Reject
                                    </Button>
                                  )}
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Phone: card stack. Approve/Reject are inline on each
                    card instead of hover-revealed; the row is also tap-to-
                    open the detail drawer (managers reach the audit trail
                    + edits there). Selection checkbox top-left when
                    bulk-eligible. */}
                <ul className="md:hidden space-y-2">
                  {visibleEntries.map((e) => {
                    const isSelectable = canManage && filter === 'COMPLETED' && e.status === 'COMPLETED';
                    const showCheckbox = canManage && filter === 'COMPLETED';
                    return (
                      <li key={e.id}>
                        <div
                          className={cn(
                            'rounded-md border bg-navy/40 transition-colors',
                            selected.has(e.id)
                              ? 'border-gold/40 bg-gold/5'
                              : 'border-navy-secondary'
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => setDrawerTarget(e)}
                            className="w-full text-left p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-md"
                          >
                            <div className="flex items-start gap-2.5">
                              {showCheckbox && (
                                <span
                                  className="pt-0.5 shrink-0"
                                  data-no-row-click
                                  onClick={(ev) => ev.stopPropagation()}
                                >
                                  {isSelectable && (
                                    <input
                                      type="checkbox"
                                      aria-label={`Select entry for ${e.associateName ?? 'associate'}`}
                                      checked={selected.has(e.id)}
                                      onChange={() => toggleOne(e.id)}
                                      className="h-4 w-4 rounded border-navy-secondary bg-navy-secondary/40 text-gold focus:ring-gold"
                                    />
                                  )}
                                </span>
                              )}
                              <Avatar name={e.associateName ?? '—'} size="sm" />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="font-medium text-white truncate">
                                    {e.associateName ?? '—'}
                                  </div>
                                  <Badge variant={statusVariant(e.status)} className="shrink-0">
                                    {e.status}
                                  </Badge>
                                </div>
                                <div className="text-[11px] text-silver/70 truncate">
                                  {e.clientName ?? '—'}
                                </div>
                                <div className="mt-1.5 flex items-end justify-between gap-3 text-[11px] text-silver">
                                  <span className="tabular-nums">
                                    {fmtDateTime(e.clockInAt)}
                                    {e.clockOutAt
                                      ? ` → ${fmtTime(e.clockOutAt)}`
                                      : ' → —'}
                                  </span>
                                  <span className="tabular-nums text-white">
                                    {formatHM(e.netMinutes ?? e.minutesElapsed)}
                                  </span>
                                </div>
                                <div className="mt-1 empty:hidden">
                                  <LateChip entry={e} />
                                </div>
                                <AnomalyChips anomalies={e.anomalies} />
                                {e.rejectionReason && (
                                  <div className="text-alert text-[10px] mt-1">
                                    {e.rejectionReason}
                                  </div>
                                )}
                              </div>
                            </div>
                          </button>
                          {canManage &&
                            (e.status === 'COMPLETED' ||
                              e.status === 'APPROVED' ||
                              e.status === 'REJECTED') && (
                              <div
                                className="flex gap-2 px-3 pb-3 pt-0"
                                data-no-row-click
                                onClick={(ev) => ev.stopPropagation()}
                              >
                                {(e.status === 'COMPLETED' || e.status === 'REJECTED') && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => onApprove(e.id)}
                                    loading={pendingId === e.id}
                                    disabled={pendingId === e.id || bulkBusy}
                                  >
                                    Approve
                                  </Button>
                                )}
                                {(e.status === 'COMPLETED' || e.status === 'APPROVED') && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-alert hover:text-alert hover:bg-alert/10"
                                    onClick={() => setRejectOpen({ mode: 'one', id: e.id })}
                                    disabled={pendingId === e.id || bulkBusy}
                                  >
                                    Reject
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="ml-auto text-silver/70 hover:text-white"
                                  onClick={() => focusOn(e)}
                                >
                                  Timesheet
                                </Button>
                              </div>
                            )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <RejectTimeDialog
        open={rejectOpen !== null}
        onOpenChange={(o) => !o && setRejectOpen(null)}
        count={rejectOpen?.mode === 'bulk' ? selected.size : 1}
        busy={bulkBusy || pendingId !== null}
        onSubmit={onSubmitReject}
      />

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => {
          if (!o) {
            setDrawerTarget(null);
            // Mutations from the drawer's footer buttons trigger their own
            // refresh through onApprove / setRejectOpen. No extra refresh.
          }
        }}
        width="max-w-xl"
      >
        {drawerTarget && (
          <TimeEntryDetailPanel
            entry={drawerTarget}
            canManage={canManage}
            busy={pendingId === drawerTarget.id || bulkBusy}
            onApprove={async () => {
              const id = drawerTarget.id;
              setDrawerTarget(null);
              await onApprove(id);
            }}
            onReject={() => {
              setRejectOpen({ mode: 'one', id: drawerTarget.id });
              setDrawerTarget(null);
            }}
            onEdit={() => {
              setEditTarget(drawerTarget);
              setDrawerTarget(null);
            }}
          />
        )}
      </Drawer>

      <SummaryExportDialog
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
        fromIso={ymdToIsoStart(fromYmd)}
        toIso={ymdToIsoEndExclusive(toYmd)}
      />

      <PayrollSheetDialog
        open={payrollOpen}
        onOpenChange={setPayrollOpen}
        defaultFromYmd={fromYmd}
        defaultToYmd={toYmd}
      />

      {createOpen && (
        <TimeEntryFormDrawer
          mode="create"
          onClose={() => setCreateOpen(false)}
          onSaved={async () => {
            setCreateOpen(false);
            await afterMutation();
          }}
        />
      )}
      {editTarget && (
        <TimeEntryFormDrawer
          mode="edit"
          entry={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={async () => {
            setEditTarget(null);
            await afterMutation();
          }}
        />
      )}
    </div>
  );
}

function TimeEntryDetailPanel({
  entry,
  canManage,
  busy,
  onApprove,
  onReject,
  onEdit,
}: {
  entry: TimeEntry;
  canManage: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
}) {
  const showApprove =
    canManage && (entry.status === 'COMPLETED' || entry.status === 'REJECTED');
  const showReject =
    canManage && (entry.status === 'COMPLETED' || entry.status === 'APPROVED');
  // Edit/clock-out is allowed at ANY status — including APPROVED, for
  // payroll corrections that surface days later. The API keeps the entry
  // approved, re-runs the sick-leave accrual from the corrected hours,
  // and notifies the associate.
  const showEdit = canManage;
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar name={entry.associateName ?? '—'} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              {entry.associateName ?? '—'}
            </DrawerTitle>
            <DrawerDescription>
              {entry.clientName ?? 'No client'}
              {entry.jobName ? ` · ${entry.jobName}` : ''}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Badge variant={statusVariant(entry.status)}>{entry.status}</Badge>
          {entry.anomalies && entry.anomalies.length > 0 && (
            <Badge variant="destructive">
              {entry.anomalies.length} anomal{entry.anomalies.length === 1 ? 'y' : 'ies'}
            </Badge>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm mb-5">
          <DetailRow label="Clock in">
            {new Date(entry.clockInAt).toLocaleString()}
          </DetailRow>
          <DetailRow label="Clock out">
            {entry.clockOutAt
              ? new Date(entry.clockOutAt).toLocaleString()
              : 'Still on the clock'}
          </DetailRow>
          <DetailRow label="Worked (net of breaks)">
            {formatHM(entry.netMinutes ?? entry.minutesElapsed)}
          </DetailRow>
          <DetailRow label="Gross span">{formatHM(entry.minutesElapsed)}</DetailRow>
          <DetailRow label="Pay rate">
            {entry.payRate != null
              ? `$${entry.payRate.toFixed(2)}/hr`
              : <span className="text-silver/80">—</span>}
          </DetailRow>
          {entry.shiftStartsAt && (
            <DetailRow label="Scheduled shift">
              <span className="tabular-nums">
                {new Date(entry.shiftStartsAt).toLocaleString()}
              </span>
              {entry.shiftPosition && (
                <span className="text-silver/80"> · {entry.shiftPosition}</span>
              )}
            </DetailRow>
          )}
          {(entry.clockInLat != null && entry.clockInLng != null) && (
            <DetailRow label="Clock-in geofence">
              <span className="font-mono text-xs">
                {entry.clockInLat.toFixed(5)}, {entry.clockInLng.toFixed(5)}
              </span>
            </DetailRow>
          )}
          {(entry.clockOutLat != null && entry.clockOutLng != null) && (
            <DetailRow label="Clock-out geofence">
              <span className="font-mono text-xs">
                {entry.clockOutLat.toFixed(5)}, {entry.clockOutLng.toFixed(5)}
              </span>
            </DetailRow>
          )}
          {entry.approverEmail && (
            <DetailRow label="Approved by">{entry.approverEmail}</DetailRow>
          )}
          {entry.approvedAt && (
            <DetailRow label="Approved at">
              {fmtDateTime(entry.approvedAt)}
            </DetailRow>
          )}
        </dl>

        {entry.breaks && entry.breaks.length > 0 && (
          <div className="mb-5 rounded-md border border-navy-secondary bg-navy-secondary/30 p-3 text-sm">
            <div className="text-[10px] uppercase tracking-widest text-silver mb-1.5">
              Breaks
            </div>
            <ul className="space-y-1 text-silver">
              {entry.breaks.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3">
                  <span>
                    {b.type === 'MEAL' ? 'Meal' : 'Rest'}{' '}
                    <span className="tabular-nums">
                      {fmtTime(b.startedAt)} –{' '}
                      {b.endedAt ? fmtTime(b.endedAt) : 'still open'}
                    </span>
                  </span>
                  <span className="tabular-nums text-white">{formatHM(b.minutes)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {entry.anomalies && entry.anomalies.length > 0 && (
          <div className="mb-5 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm">
            <div className="text-[10px] uppercase tracking-widest text-warning mb-1.5">
              Anomalies
            </div>
            <ul className="list-disc list-inside text-warning/90 space-y-0.5">
              {entry.anomalies.map((a) => (
                <li key={a}>{timeAnomalyLabel(a)}</li>
              ))}
            </ul>
          </div>
        )}

        {entry.notes && (
          <DetailSection label="Notes" body={entry.notes} />
        )}

        {entry.rejectionReason && (
          <div
            className="rounded-md border border-alert/40 bg-alert/[0.07] p-3 text-sm text-alert"
            role="alert"
          >
            <div className="font-medium mb-0.5">Rejected</div>
            <div className="break-words">{entry.rejectionReason}</div>
          </div>
        )}
      </DrawerBody>
      {(showApprove || showReject || showEdit) && (
        <DrawerFooter>
          {showEdit && (
            <Button variant="outline" onClick={onEdit} disabled={busy}>
              <Pencil className="mr-2 h-4 w-4" />
              {entry.status === 'ACTIVE' ? 'Edit / clock out' : 'Edit times'}
            </Button>
          )}
          {showReject && (
            <Button
              variant="ghost"
              className="text-alert hover:text-alert hover:bg-alert/10"
              onClick={onReject}
              disabled={busy}
            >
              Reject
            </Button>
          )}
          {showApprove && (
            <Button onClick={onApprove} loading={busy} disabled={busy}>
              Approve
            </Button>
          )}
        </DrawerFooter>
      )}
    </>
  );
}

/* ===== Admin: create / edit a time entry on behalf of an associate ===== */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ISO → value for <input type="datetime-local"> (local wall-clock).
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

function localInputToIso(local: string): string {
  return new Date(local).toISOString();
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[11px] uppercase tracking-widest text-silver">
      {children}
    </div>
  );
}

// Debounced directory typeahead → resolves to an associate id.
function AssociateSearchField({
  value,
  onChange,
}: {
  value: { id: string; name: string } | null;
  onChange: (v: { id: string; name: string } | null) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<
    Array<{ id: string; name: string; email: string }>
  >([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      listDirectory({ q: term })
        .then((r) => {
          if (cancelled) return;
          setResults(
            r.associates.slice(0, 8).map((a) => ({
              id: a.id,
              name: `${a.firstName} ${a.lastName}`,
              email: a.email,
            })),
          );
        })
        .catch(() => !cancelled && setResults([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  if (value) {
    return (
      <div>
        <FieldLabel>Associate</FieldLabel>
        <span className="inline-flex h-9 items-center gap-2 rounded-md border border-gold/40 bg-gold/10 px-3 text-sm text-white">
          {value.name}
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear associate"
            className="text-silver hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
    );
  }
  return (
    <div>
      <FieldLabel>Associate</FieldLabel>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-silver" />
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search associate by name or email"
          className="pl-9"
        />
        {open && results.length > 0 && (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-navy-secondary bg-midnight shadow-xl">
            {results.map((a) => (
              <button
                key={a.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange({ id: a.id, name: a.name });
                  setQ('');
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-navy-secondary/60"
              >
                {a.name} <span className="text-silver">— {a.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TimeEntryFormDrawer({
  mode,
  entry,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  entry?: TimeEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [assoc, setAssoc] = useState<{ id: string; name: string } | null>(
    mode === 'edit' && entry
      ? { id: entry.associateId, name: entry.associateName ?? '—' }
      : null,
  );
  const [clockInLocal, setClockInLocal] = useState(
    mode === 'edit' && entry ? isoToLocalInput(entry.clockInAt) : '',
  );
  const [clockOutLocal, setClockOutLocal] = useState(
    mode === 'edit' && entry ? isoToLocalInput(entry.clockOutAt) : '',
  );
  const [notes, setNotes] = useState(
    mode === 'edit' && entry ? entry.notes ?? '' : '',
  );
  const [payRate, setPayRate] = useState(
    mode === 'edit' && entry?.payRate != null ? String(entry.payRate) : '',
  );
  // Breaks, editable inline like the clock times. Rows with an id mirror
  // existing BreakEntry rows; id=null rows are new and created on save.
  // An empty end is only legal on a pre-existing open break (associate
  // is on it right now).
  const [breakRows, setBreakRows] = useState<
    Array<{ id: string | null; startLocal: string; endLocal: string }>
  >(
    mode === 'edit' && entry?.breaks
      ? entry.breaks.map((b) => ({
          id: b.id,
          startLocal: isoToLocalInput(b.startedAt),
          endLocal: b.endedAt ? isoToLocalInput(b.endedAt) : '',
        }))
      : [],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isActive = mode === 'edit' && entry?.status === 'ACTIVE';
  const clockOutOptional = mode === 'create' || isActive;

  const submit = async () => {
    setErr(null);
    if (mode === 'create' && !assoc) {
      setErr('Pick an associate.');
      return;
    }
    if (!clockInLocal) {
      setErr('Clock-in time is required.');
      return;
    }
    if (clockOutLocal && new Date(clockOutLocal) <= new Date(clockInLocal)) {
      setErr('Clock-out must be after clock-in.');
      return;
    }
    let payRateVal: number | null = null;
    if (payRate.trim() !== '') {
      const n = Number(payRate);
      if (!Number.isFinite(n) || n < 0) {
        setErr('Pay rate must be a non-negative number.');
        return;
      }
      payRateVal = n;
    }
    // Validate breaks up front — the entry itself saves first, so a break
    // the server would reject must be caught before anything is written.
    const inMs = new Date(clockInLocal).getTime();
    const outMs = clockOutLocal ? new Date(clockOutLocal).getTime() : Date.now();
    for (const [i, r] of breakRows.entries()) {
      const orig = r.id ? entry?.breaks?.find((b) => b.id === r.id) : undefined;
      const openBreak = !!orig && orig.endedAt === null && r.endLocal === '';
      if (!r.startLocal || (!r.endLocal && !openBreak)) {
        setErr(`Break ${i + 1} needs both a start and an end time.`);
        return;
      }
      const s = new Date(r.startLocal).getTime();
      const e = r.endLocal ? new Date(r.endLocal).getTime() : outMs;
      if (e <= s) {
        setErr(`Break ${i + 1} must end after it starts.`);
        return;
      }
      if (s < inMs || e > outMs) {
        setErr(`Break ${i + 1} must fall inside the clock-in/clock-out window.`);
        return;
      }
      for (const [j, other] of breakRows.entries()) {
        if (j >= i || !other.startLocal) continue;
        const os = new Date(other.startLocal).getTime();
        const oe = other.endLocal ? new Date(other.endLocal).getTime() : outMs;
        if (s < oe && e > os) {
          setErr(`Breaks ${j + 1} and ${i + 1} overlap.`);
          return;
        }
      }
    }
    setBusy(true);
    try {
      let entryId: string;
      if (mode === 'create') {
        const created = await adminCreateTimeEntry({
          associateId: assoc!.id,
          clockInAt: localInputToIso(clockInLocal),
          clockOutAt: clockOutLocal ? localInputToIso(clockOutLocal) : null,
          payRate: payRateVal,
          notes: notes.trim() || null,
        });
        entryId = created.id;
        // No job picked and no open assignment to resolve one from — the
        // entry saved clientless, which keeps it out of every client-scoped
        // payroll export. Say so now, not at export time.
        if (!created.clientId) {
          toast.warning(
            `Saved, but no client could be resolved for ${assoc!.name} — this entry won't appear in client-scoped payroll sheets. Assign them to a client (or pick a job) and edit the entry.`,
            { duration: 10000 },
          );
        } else {
          toast.success(
            clockOutLocal ? 'Shift logged.' : `Clocked in ${assoc!.name}.`,
          );
        }
      } else {
        entryId = entry!.id;
        await adminEditTimeEntry(entry!.id, {
          clockInAt: localInputToIso(clockInLocal),
          clockOutAt: clockOutLocal ? localInputToIso(clockOutLocal) : null,
          payRate: payRateVal,
          notes: notes.trim() || null,
        });
        toast.success(
          isActive && clockOutLocal
            ? `Clocked out ${entry!.associateName ?? 'associate'}.`
            : 'Entry updated.',
        );
      }
      // Sync breaks AFTER the entry saved — deletions, then edits, then
      // adds. A failure here must not strand the drawer (the entry write
      // already landed, and in create mode a retry would duplicate it):
      // warn, close, and let the admin reopen edit to fix the break.
      try {
        const origBreaks = mode === 'edit' ? (entry?.breaks ?? []) : [];
        const keptIds = new Set(breakRows.map((r) => r.id).filter(Boolean));
        for (const b of origBreaks) {
          if (!keptIds.has(b.id)) await deleteTimeEntryBreak(b.id);
        }
        for (const r of breakRows) {
          if (!r.id) {
            await addTimeEntryBreak(entryId, {
              startedAt: localInputToIso(r.startLocal),
              endedAt: localInputToIso(r.endLocal),
            });
            continue;
          }
          const orig = origBreaks.find((b) => b.id === r.id);
          if (!orig) continue;
          const startChanged = isoToLocalInput(orig.startedAt) !== r.startLocal;
          const origEndLocal = orig.endedAt ? isoToLocalInput(orig.endedAt) : '';
          const endChanged = origEndLocal !== r.endLocal;
          if (!startChanged && !endChanged) continue;
          await updateTimeEntryBreak(r.id, {
            ...(startChanged ? { startedAt: localInputToIso(r.startLocal) } : {}),
            ...(endChanged && r.endLocal
              ? { endedAt: localInputToIso(r.endLocal) }
              : {}),
          });
        }
      } catch (breakErr) {
        toast.warning(
          `Entry saved, but a break change failed: ${
            breakErr instanceof ApiError ? breakErr.message : 'unknown error'
          }. Reopen the entry to fix its breaks.`,
          { duration: 10000 },
        );
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>
          {mode === 'create' ? 'Add time entry' : 'Edit time entry'}
        </DrawerTitle>
        <DrawerDescription>
          {mode === 'create'
            ? 'Log a shift for an associate. Leave clock-out empty to clock them in (still on the clock).'
            : isActive
              ? 'Fix the clock-in, or set a clock-out to clock this associate out.'
              : 'Adjust the clock times before approval.'}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {err && (
          <div className="rounded-md border border-alert/40 bg-alert/10 p-2 text-sm text-alert">
            {err}
          </div>
        )}
        {mode === 'create' ? (
          <AssociateSearchField value={assoc} onChange={setAssoc} />
        ) : (
          <div>
            <FieldLabel>Associate</FieldLabel>
            <div className="text-white">{entry?.associateName ?? '—'}</div>
          </div>
        )}
        <div>
          <FieldLabel>Clock in</FieldLabel>
          <Input
            type="datetime-local"
            value={clockInLocal}
            onChange={(e) => setClockInLocal(e.target.value)}
          />
        </div>
        <div>
          <FieldLabel>Clock out{clockOutOptional ? ' (optional)' : ''}</FieldLabel>
          <div className="flex gap-2">
            <Input
              type="datetime-local"
              value={clockOutLocal}
              onChange={(e) => setClockOutLocal(e.target.value)}
              className="flex-1"
            />
            {clockOutOptional && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setClockOutLocal(isoToLocalInput(new Date().toISOString()))
                }
              >
                Now
              </Button>
            )}
          </div>
          {isActive && (
            <p className="mt-1 text-xs text-silver">
              Setting a clock-out clocks this associate out.
            </p>
          )}
        </div>
        <div>
          <FieldLabel>Breaks (unpaid)</FieldLabel>
          {breakRows.length === 0 && (
            <p className="mb-1 text-xs text-silver">No breaks on this entry.</p>
          )}
          <div className="space-y-2">
            {breakRows.map((r, i) => (
              <div key={r.id ?? `new-${i}`} className="flex items-center gap-2">
                <Input
                  type="datetime-local"
                  aria-label={`Break ${i + 1} start`}
                  value={r.startLocal}
                  onChange={(e) =>
                    setBreakRows((rows) =>
                      rows.map((row, j) =>
                        j === i ? { ...row, startLocal: e.target.value } : row,
                      ),
                    )
                  }
                  className="flex-1"
                />
                <span className="text-silver" aria-hidden="true">–</span>
                <Input
                  type="datetime-local"
                  aria-label={`Break ${i + 1} end`}
                  value={r.endLocal}
                  onChange={(e) =>
                    setBreakRows((rows) =>
                      rows.map((row, j) =>
                        j === i ? { ...row, endLocal: e.target.value } : row,
                      ),
                    )
                  }
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove break ${i + 1}`}
                  onClick={() =>
                    setBreakRows((rows) => rows.filter((_, j) => j !== i))
                  }
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() =>
              setBreakRows((rows) => [
                ...rows,
                { id: null, startLocal: '', endLocal: '' },
              ])
            }
          >
            <Plus className="h-4 w-4" />
            Add break
          </Button>
          <p className="mt-1 text-xs text-silver">
            Unpaid time inside the shift — subtracted from paid hours.
          </p>
        </div>
        <div>
          <FieldLabel>Pay rate ($/hr)</FieldLabel>
          <Input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={payRate}
            onChange={(e) => setPayRate(e.target.value)}
            placeholder="e.g. 18.50"
          />
          <p className="mt-1 text-xs text-silver">
            Recorded on this entry for reporting. Payroll pays from the
            associate&rsquo;s Compensation record, not this field.
          </p>
        </div>
        <div>
          <FieldLabel>Notes</FieldLabel>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Optional — why this entry was added or changed."
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} loading={busy} disabled={busy}>
          {mode === 'create' ? 'Create entry' : 'Save changes'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// Per-associate summary export: pick a facility (Client → Location) to scope,
// then download the regular/overtime/pay-rate CSV for the queue's date range.
function SummaryExportDialog({
  open,
  onOpenChange,
  fromIso,
  toIso,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  fromIso: string;
  toIso: string;
}) {
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [clientId, setClientId] = useState('');
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    listClients()
      .then((r) => setClients(r.clients.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setClients([]));
  }, [open]);
  useEffect(() => {
    setLocationId('');
    if (!clientId) {
      setLocations([]);
      return;
    }
    listClientLocations(clientId)
      .then((r) => setLocations(r.locations.map((l) => ({ id: l.id, name: l.name }))))
      .catch(() => setLocations([]));
  }, [clientId]);

  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      await exportTimeSummary({
        from: fromIso,
        to: toIso,
        ...(clientId ? { clientId } : {}),
        ...(locationId ? { locationId } : {}),
      });
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Summary export</DialogTitle>
          <DialogDescription>
            One row per associate — regular &amp; overtime hours and pay rate —
            for the date range selected in the queue. APPROVED time only.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {err && (
            <div className="rounded-md border border-alert/40 bg-alert/10 p-2 text-sm text-alert">
              {err}
            </div>
          )}
          <div>
            <FieldLabel>Client</FieldLabel>
            <Select
              className="mt-1"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel>Facility (location)</FieldLabel>
            <Select
              className="mt-1"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              disabled={!clientId}
            >
              <option value="">
                {clientId ? 'All locations at this client' : 'Pick a client first'}
              </option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-xs text-silver">
            Overtime = hours over 40 per week (federal), matching payroll.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={download} loading={busy} disabled={busy}>
            <Download className="mr-2 h-4 w-4" />
            Download CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Payroll-ready sheet export: pick a client + a date range (pay period), then
// download a PDF or .xlsx listing each associate's dates worked, daily
// duration, and regular/overtime totals. APPROVED time only.
function PayrollSheetDialog({
  open,
  onOpenChange,
  defaultFromYmd,
  defaultToYmd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultFromYmd: string;
  defaultToYmd: string;
}) {
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [clientId, setClientId] = useState('');
  const [fromYmd, setFromYmd] = useState(defaultFromYmd);
  const [toYmd, setToYmd] = useState(defaultToYmd);
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFromYmd(defaultFromYmd);
    setToYmd(defaultToYmd);
    setErr(null);
    listClients()
      .then((r) => setClients(r.clients.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setClients([]));
  }, [open, defaultFromYmd, defaultToYmd]);

  const download = async (format: 'pdf' | 'xlsx') => {
    if (!clientId) {
      setErr('Pick a client first.');
      return;
    }
    if (!fromYmd || !toYmd || toYmd < fromYmd) {
      setErr('Pick a valid pay period (end on or after start).');
      return;
    }
    setBusy(format);
    setErr(null);
    try {
      const { noClientCount } = await exportPayrollSheet(format, {
        from: ymdToIsoStart(fromYmd),
        to: ymdToIsoEndExclusive(toYmd),
        clientId,
      });
      if (noClientCount > 0) {
        toast.warning(
          `${noClientCount} approved ${noClientCount === 1 ? 'entry' : 'entries'} in this period ${noClientCount === 1 ? 'has' : 'have'} no client attached and ${noClientCount === 1 ? 'was' : 'were'} left out of the sheet. Find ${noClientCount === 1 ? 'it' : 'them'} under the Approved filter and attach the client.`,
          { duration: 12000 },
        );
      }
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Payroll sheet</DialogTitle>
          <DialogDescription>
            Pick a client and a pay period — download a payroll-ready sheet of
            each associate&apos;s dates worked, daily duration, and regular &amp;
            overtime totals. APPROVED time only.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {err && (
            <div className="rounded-md border border-alert/40 bg-alert/10 p-2 text-sm text-alert">
              {err}
            </div>
          )}
          <div>
            <FieldLabel>Client</FieldLabel>
            <Select
              className="mt-1"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">Select a client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Pay period start</FieldLabel>
              <Input
                type="date"
                value={fromYmd}
                max={toYmd}
                onChange={(e) => setFromYmd(e.target.value)}
                className="mt-1 h-10 text-sm"
              />
            </div>
            <div>
              <FieldLabel>Pay period end</FieldLabel>
              <Input
                type="date"
                value={toYmd}
                min={fromYmd}
                onChange={(e) => setToYmd(e.target.value)}
                className="mt-1 h-10 text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-silver">
            Overtime = hours over 40 per week (federal), matching payroll.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy !== null}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => download('pdf')}
            loading={busy === 'pdf'}
            disabled={busy !== null || !clientId}
          >
            <FileText className="mr-2 h-4 w-4" />
            PDF
          </Button>
          <Button
            onClick={() => download('xlsx')}
            loading={busy === 'xlsx'}
            disabled={busy !== null || !clientId}
          >
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Excel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-widest text-silver/80">{label}</dt>
      <dd className="text-white text-sm mt-0.5 break-words tabular-nums">{children}</dd>
    </div>
  );
}

function DetailSection({ label, body }: { label: string; body: string }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-1">
        {label}
      </div>
      <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-3 text-sm text-white whitespace-pre-wrap">
        {body}
      </div>
    </div>
  );
}

interface KpiCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'alert' | 'default' | 'silver';
}

const TONE_TEXT: Record<KpiCardProps['tone'], string> = {
  success: 'text-success',
  warning: 'text-warning',
  alert: 'text-alert',
  default: 'text-gold',
  silver: 'text-silver',
};

function KpiCard({ icon: Icon, label, value, tone }: KpiCardProps) {
  if (value === '—') {
    return (
      <Card className="p-4">
        <div className="flex items-start justify-between mb-1">
          <div className="text-[10px] uppercase tracking-wider text-silver">
            {label}
          </div>
          <Icon className="h-3.5 w-3.5 text-silver/70" />
        </div>
        <Skeleton className="h-9 w-12 mt-1" />
      </Card>
    );
  }
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wider text-silver">
          {label}
        </div>
        <Icon className="h-3.5 w-3.5 text-silver/70" />
      </div>
      <div className={cn('text-3xl font-display tabular-nums', TONE_TEXT[tone])}>
        {value}
      </div>
    </Card>
  );
}

interface RejectTimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  busy: boolean;
  onSubmit: (reason: string) => void;
}

function RejectTimeDialog({ open, onOpenChange, count, busy, onSubmit }: RejectTimeDialogProps) {
  const [reason, setReason] = useState('');

  // Clear the field whenever the dialog opens so old text doesn't leak.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Reject {count > 1 ? `${count} time entries` : 'time entry'}
          </DialogTitle>
          <DialogDescription>
            The associate will see this reason. They can re-submit a corrected entry.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3">
          <Textarea
            autoFocus
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g., Forgot to clock out — please re-submit with the correct end time."
            maxLength={500}
            rows={4}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={busy}
              disabled={busy || !reason.trim()}
            >
              Reject {count > 1 ? `${count}` : ''}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
