import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Coffee,
  Download,
  FileText,
  ListChecks,
  MapPinOff,
  Search,
  Smartphone,
  X,
} from 'lucide-react';
import type {
  ActiveDashboardEntry,
  TimeEntry,
  TimeEntryStatus,
} from '@alto-people/shared';
import {
  approveTimeEntry,
  bulkApproveTimeEntries,
  bulkRejectTimeEntries,
  exportTimeEntries,
  getActiveDashboard,
  listAdminTimeEntries,
  rejectTimeEntry,
} from '@/lib/timeApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
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
  Skeleton,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
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

function ymdToIsoEndExclusive(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

interface AdminTimeViewProps {
  canManage: boolean;
}

type Tab = 'live' | 'queue';

export function AdminTimeView({ canManage }: AdminTimeViewProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('live');
  const [filter, setFilter] = useState<TimeEntryStatus | 'ALL'>('COMPLETED');
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
  const [exportBusy, setExportBusy] = useState<null | 'csv' | 'pdf'>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState<null | { mode: 'one'; id: string } | { mode: 'bulk' }>(null);
  const [drawerTarget, setDrawerTarget] = useState<TimeEntry | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listAdminTimeEntries({
        ...(filter !== 'ALL' ? { status: filter } : {}),
        from: ymdToIsoStart(fromYmd),
        to: ymdToIsoEndExclusive(toYmd),
        ...(appliedSearch ? { search: appliedSearch } : {}),
      });
      setEntries(res.entries);
      // Selection only valid on the COMPLETED filter; clear when refreshing.
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter, fromYmd, toYmd, appliedSearch]);

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
      const res = await listAdminTimeEntries({ status: 'COMPLETED' });
      setPendingCount(res.entries.length);
    } catch {
      // KPI is best-effort; leave previous value.
    }
  }, []);

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

  const selectableIds = useMemo(() => {
    if (!entries) return [] as string[];
    // Only COMPLETED rows are bulk-actionable on the Pending review tab.
    return entries.filter((e) => e.status === 'COMPLETED').map((e) => e.id);
  }, [entries]);

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
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Time & Attendance"
        subtitle={
          canManage
            ? 'Review, approve, or reject time entries from associates.'
            : 'Read-only view of time entries.'
        }
        secondaryActions={
          canManage ? (
            <Button
              variant="outline"
              onClick={() => navigate('/time-attendance/kiosk')}
            >
              <Smartphone className="mr-2 h-4 w-4" />
              Kiosk &amp; PINs
            </Button>
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
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-silver/60 pointer-events-none" />
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
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Associate</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Job</TableHead>
                      <TableHead>Since</TableHead>
                      <TableHead>Elapsed</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Geofence</TableHead>
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
                          {new Date(e.clockInAt).toLocaleTimeString()}
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
                            <span className="text-xs text-silver/60">N/A</span>
                          )}
                          {e.geofenceOk === true && <Badge variant="success">OK</Badge>}
                          {e.geofenceOk === false && (
                            <Badge variant="destructive">Off-site</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {filteredActive.length === 0 && (
                  <p className="text-sm text-silver mt-3">
                    No matches for &ldquo;{liveSearch}&rdquo;.
                  </p>
                )}
                <div className="mt-3 text-[10px] uppercase tracking-widest text-silver/60">
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">Time entries</CardTitle>
              <div className="flex flex-wrap gap-2">
                {STATUS_FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setFilter(f.value)}
                    className={cn(
                      'px-3 py-1.5 rounded text-xs uppercase tracking-wider border transition',
                      filter === f.value
                        ? 'border-gold text-gold bg-gold/10'
                        : 'border-navy-secondary text-silver hover:text-white'
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Phase 65 — date range + free-text search + export buttons. */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex items-end gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-silver mb-1">
                    From
                  </label>
                  <Input
                    type="date"
                    value={fromYmd}
                    max={toYmd}
                    onChange={(e) => setFromYmd(e.target.value || defaultFromYmd())}
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
                    onChange={(e) => setToYmd(e.target.value || defaultToYmd())}
                    className="h-9 text-sm w-40"
                  />
                </div>
              </div>

              <div className="relative flex-1 min-w-[200px]">
                <label className="block text-[10px] uppercase tracking-wider text-silver mb-1">
                  Search
                </label>
                <Search className="absolute left-2.5 top-[2.1rem] h-4 w-4 text-silver/60 pointer-events-none" />
                <Input
                  placeholder="Associate name…"
                  value={queueSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                  className="pl-8 h-9 text-sm"
                />
              </div>

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
                </div>
              )}
            </div>
          </CardHeader>

          {/* Bulk-action toolbar — only shown when rows are selectable & any selected. */}
          {canManage && filter === 'COMPLETED' && selected.size > 0 && (
            <div className="mx-5 mb-3 flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-gold/40 bg-gold/10">
              <div className="text-sm text-gold">
                <span className="font-medium tabular-nums">{selected.size}</span>{' '}
                selected
              </div>
              <div className="flex items-center gap-2">
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
            {!entries && <SkeletonRows count={6} rowHeight="h-12" />}
            {entries && entries.length === 0 && (
              <EmptyState
                title="Nothing to review"
                description="No time entries match this filter."
              />
            )}
            {entries && entries.length > 0 && (
              <Table>
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
                    <TableHead>Associate</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>In</TableHead>
                    <TableHead>Out</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                    {canManage && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => {
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
                          <div className="flex items-center gap-2.5">
                            <Avatar name={e.associateName ?? '—'} size="sm" />
                            <span>{e.associateName ?? '—'}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-silver">{e.clientName ?? '—'}</TableCell>
                        <TableCell className="tabular-nums">
                          {new Date(e.clockInAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {e.clockOutAt
                            ? new Date(e.clockOutAt).toLocaleTimeString()
                            : '—'}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatHM(e.minutesElapsed)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
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
          />
        )}
      </Drawer>
    </div>
  );
}

function TimeEntryDetailPanel({
  entry,
  canManage,
  busy,
  onApprove,
  onReject,
}: {
  entry: TimeEntry;
  canManage: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const showApprove =
    canManage && (entry.status === 'COMPLETED' || entry.status === 'REJECTED');
  const showReject =
    canManage && (entry.status === 'COMPLETED' || entry.status === 'APPROVED');
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
          <DetailRow label="Duration">{formatHM(entry.minutesElapsed)}</DetailRow>
          <DetailRow label="Pay rate">
            {entry.payRate != null
              ? `$${entry.payRate.toFixed(2)}/hr`
              : <span className="text-silver/80">—</span>}
          </DetailRow>
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
              {new Date(entry.approvedAt).toLocaleString()}
            </DetailRow>
          )}
        </dl>

        {entry.anomalies && entry.anomalies.length > 0 && (
          <div className="mb-5 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm">
            <div className="text-[10px] uppercase tracking-widest text-warning mb-1.5">
              Anomalies
            </div>
            <ul className="list-disc list-inside text-warning/90 space-y-0.5">
              {entry.anomalies.map((a) => (
                <li key={a}>{a}</li>
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
      {(showApprove || showReject) && (
        <DrawerFooter>
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
          <Icon className="h-3.5 w-3.5 text-silver/60" />
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
        <Icon className="h-3.5 w-3.5 text-silver/60" />
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
