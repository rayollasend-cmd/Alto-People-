import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AssociateLink } from '@/components/ui/AssociateLink';
import {
  AlertTriangle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  FileSpreadsheet,
  History as HistoryIcon,
  Lock,
  RefreshCw,
  Search,
  CheckCircle2,
} from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  TimesheetWeekResponse,
  TimesheetAssociateDetailResponse,
  TimesheetIssueKind,
  ClientListItem,
} from '@alto-people/shared';
import { useClients } from '@/lib/useClients';
import {
  getTimesheetWeek,
  exportTimesheetXlsx,
  getAssociateTimesheetDetail,
  fileTimesheetWeek,
  markFieldglassEntered,
} from '@/lib/timeApi';
import { EnterInFieldglass, FieldglassStatusCell, FieldglassStrip } from './FieldglassDesk';
import { onTimeEntriesChanged } from '@/lib/timeEntriesChannel';
import { upsertAttestation } from '@/lib/complianceScorecardApi';
import { useAuth } from '@/lib/auth';
import { boundedClientOf } from '@/lib/roles';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, parseYmd, ymdLocal } from '@/lib/format';
import { useConfirm } from '@/lib/confirm';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';

/** Saturday 00:00 (local) that starts the Sat→Fri week containing `d`. */
function startOfSaturdayWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); // Sat→0, Sun→1 … Fri→6
  return x;
}

/** The last fully-completed Sat→Fri week relative to now. */
function lastCompletedWeekStart(now: Date): Date {
  const cur = startOfSaturdayWeek(now);
  cur.setDate(cur.getDate() - 7);
  return cur;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday (YYYY-MM-DD) of the ISO week containing the given Friday date — the
 *  period the FIELDGLASS_TIMESHEET weekly attestation is keyed on. */
function mondayOfIsoWeek(fridayIso: string): string {
  const d = new Date(`${fridayIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}

const hoursCell = (n: number) => (n === 0 ? '0.00' : n.toFixed(2));

/**
 * Every time surface now speaks decimal hours (the payroll/Fieldglass
 * convention) — the old dual "7.50h (7h 30m)" display is gone with the
 * h:mm format that made it necessary.
 */

const ISSUE_LABEL: Record<TimesheetIssueKind, string> = {
  MISSING_CLOCKOUT: 'Missing clock-out',
  PENDING_APPROVAL: 'Pending approval',
  OVER_HOURS: 'Over hours',
  NOT_IN_FIELDGLASS: 'Not in Fieldglass',
};

/**
 * Stable shift-name → chip color. Hashed (not first-appearance) so "GM
 * Morning Shift" wears the same hue on every timesheet, every week —
 * reviewers learn the colors once. Warning is reserved for
 * "unscheduled"; alert for errors.
 */
const SHIFT_CHIP_PALETTE = [
  'bg-gold/15 text-gold',
  'bg-steel/25 text-white',
  'bg-sky/15 text-sky',
  'bg-teal/15 text-teal',
  'bg-success/15 text-success',
] as const;
function shiftChipClass(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SHIFT_CHIP_PALETTE[h % SHIFT_CHIP_PALETTE.length];
}

const NO_ROWS: TimesheetWeekResponse['rows'] = [];

export function TimesheetsView() {
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const canAttest = can('manage:compliance');
  // Client-bound roles (SHIFT_SUPERVISOR) can't list clients — /clients
  // 403s for them. Pin the client filter to their one client instead.
  const boundedClient = useMemo(() => boundedClientOf(user), [user]);
  // The client bill rate and the billed Amount are never a store-bound
  // role's (the API nulls them too) — their columns go rather than
  // showing dashes and a "set the bill rate" prompt they can't act on.
  const showBill = !boundedClient;

  // Round-trip state — the picked week (and client, below) live in the
  // URL (?week=YYYY-MM-DD&client=…, replace-written) so the fix-issue →
  // re-file loop returns to the same view: leaving for the approval queue
  // and coming Back, or refreshing, no longer resets to the default week.
  const [searchParams, setSearchParams] = useSearchParams();
  const [weekStart, setWeekStart] = useState<Date>(() => {
    const w = searchParams.get('week');
    const parsed = w && /^\d{4}-\d{2}-\d{2}$/.test(w) ? parseYmd(w) : null;
    return parsed ? startOfSaturdayWeek(parsed) : lastCompletedWeekStart(new Date());
  });
  const [downloading, setDownloading] = useState(false);
  const [filingBusy, setFilingBusy] = useState(false);

  // Fieldglass individual-timesheet drill-down: whose drawer is open.
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailAssociateId, setDetailAssociateId] = useState<string | null>(null);

  const [showSchedule, setShowSchedule] = useState(false);
  const [search, setSearch] = useState('');
  // The Fieldglass desk: enter mode, and a row's "entered" tick in flight.
  const [entering, setEntering] = useState(false);
  const [ticking, setTicking] = useState<string | null>(null);

  // Per-client filter — file one Fieldglass SOW at a time. '' = all clients.
  // Bounded viewers start (and stay) pinned to their client; everyone else
  // restores ?client= from the URL (see the round-trip note above).
  const [clientId, setClientId] = useState(
    () => boundedClient?.id ?? searchParams.get('client') ?? '',
  );
  // Shared react-query cache; the fetch is skipped entirely for bounded
  // roles (a failure just leaves the dropdown at "All clients").
  const { clients: fetchedClients } = useClients({ enabled: !boundedClient });
  const clients = useMemo<Array<Pick<ClientListItem, 'id' | 'name'>>>(
    () => (boundedClient ? [boundedClient] : fetchedClients),
    [boundedClient, fetchedClients],
  );

  const clientArg = clientId || undefined;

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  // Mirror week + client into the URL (replace — no history spam). Defaults
  // write no params so a fresh visit keeps a clean /time-attendance URL.
  useEffect(() => {
    const weekYmd = ymdLocal(weekStart);
    const defaultWeekYmd = ymdLocal(lastCompletedWeekStart(new Date()));
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (weekYmd === defaultWeekYmd) next.delete('week');
        else next.set('week', weekYmd);
        // Bounded viewers are pinned server-side — never write their pin.
        if (!clientId || clientId === boundedClient?.id) next.delete('client');
        else next.set('client', clientId);
        return next;
      },
      { replace: true },
    );
  }, [weekStart, clientId, boundedClient?.id, setSearchParams]);

  // The week. A failed background refresh keeps the last good rows on
  // screen — the next announcement or focus retries; only a read with
  // nothing to show yet may toast.
  const weekKey = ['timesheets', 'week', weekStart.toISOString(), clientArg ?? ''] as const;
  const weekQuery = useQuery({
    queryKey: weekKey,
    queryFn: () => getTimesheetWeek({ weekStart: weekStart.toISOString(), clientId: clientArg }),
    placeholderData: keepPreviousData,
  });
  const data: TimesheetWeekResponse | null = weekQuery.data ?? null;
  const loading = weekQuery.isPending;
  const { refetch: refetchWeek } = weekQuery;
  const load = useCallback(
    async (_opts?: { silent?: boolean }) => {
      await refetchWeek();
    },
    [refetchWeek],
  );
  useEffect(() => {
    if (weekQuery.error && !weekQuery.data) {
      toast.error(weekQuery.error instanceof ApiError ? weekQuery.error.message : 'Could not load timesheets.');
    }
  }, [weekQuery.error, weekQuery.data]);
  const queryCache = useQueryClient();

  // No-show (scheduled but zero worked) or a delta of 2h+ either way.
  const scheduleFlags = useMemo(
    () =>
      (data?.scheduleComparison ?? []).filter(
        (s) => (s.scheduledHours > 0 && s.actualHours === 0) || Math.abs(s.delta) >= 2,
      ),
    [data],
  );


  // The open drawer's timesheet, re-read in place by the live refresh —
  // no loading flash, and a failed re-read leaves it showing what it had.
  const detailQuery = useQuery({
    queryKey: ['timesheets', 'detail', detailAssociateId ?? '', weekStart.toISOString(), clientArg ?? ''],
    queryFn: () =>
      getAssociateTimesheetDetail({
        associateId: detailAssociateId!,
        weekStart: weekStart.toISOString(),
        clientId: clientArg,
      }),
    enabled: detailOpen && Boolean(detailAssociateId),
  });
  const detail: TimesheetAssociateDetailResponse | null = detailQuery.data ?? null;
  const detailLoading = detailOpen && Boolean(detailAssociateId) && detailQuery.isPending;
  const { refetch: refetchDetail } = detailQuery;
  const openDetail = useCallback((associateId: string) => {
    setDetailAssociateId(associateId);
    setDetailOpen(true);
  }, []);
  useEffect(() => {
    if (!detailOpen || !detailQuery.isError || detailQuery.data) return;
    toast.error(detailQuery.error instanceof ApiError ? detailQuery.error.message : 'Could not load the timesheet.');
    setDetailOpen(false);
    setDetailAssociateId(null);
  }, [detailOpen, detailQuery.isError, detailQuery.error, detailQuery.data]);

  // Live refresh. The approval queue announces every successful mutation on
  // a BroadcastChannel (reaches every tab of this browser) — debounced so a
  // burst of row-by-row approvals coalesces into one reload. Refetch on
  // focus/visibility covers edits made from OTHER machines, throttled so
  // alt-tabbing doesn't hammer the week recompute.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let lastFocus = 0;
    const reread = () => {
      void refetchWeek();
      if (detailOpen) void refetchDetail();
    };
    const offChanged = onTimeEntriesChanged(() => {
      clearTimeout(debounce);
      debounce = setTimeout(reread, 400);
    });
    const onFocus = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastFocus < 5_000) return;
      lastFocus = now;
      reread();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearTimeout(debounce);
      offChanged();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refetchWeek, refetchDetail, detailOpen]);

  const onDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await exportTimesheetXlsx({ weekStart: weekStart.toISOString(), clientId: clientArg });
      toast.success('Downloaded the Fieldglass timesheet workbook.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloading(false);
    }
  };

  const onCopy = async () => {
    if (!data || data.rows.length === 0) return;
    // Tab-separated so it pastes cleanly into Fieldglass / a spreadsheet.
    const header = ['Worker', 'Site', 'End', 'ST', 'OT', 'DT', 'Others', 'NB', 'Total'];
    const lines = [header.join('\t')];
    for (const r of data.rows) {
      lines.push(
        [r.worker, r.site, data.weekEnding, r.st, r.ot, r.dt, r.others, r.nb, r.total]
          .map(String)
          .join('\t'),
      );
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success(`Copied ${data.rows.length} rows to the clipboard.`);
    } catch {
      toast.error('Clipboard blocked — use Export .xlsx instead.');
    }
  };

  const onMarkFiled = async () => {
    if (!data || filingBusy) return;
    const already = !!data.filing;
    const ok = await confirm(
      already
        ? {
            title: `Re-file the week ending ${data.weekEnding}?`,
            description: 'This updates the recorded snapshot to the current hours.',
            confirmLabel: 'Re-file',
          }
        : {
            title: `Mark the week ending ${data.weekEnding} as filed?`,
            description: `This records a snapshot of the current hours${canAttest ? ' and ticks the weekly compliance attestation' : ''}.`,
            confirmLabel: 'Mark filed',
          },
    );
    if (!ok) return;
    setFilingBusy(true);
    try {
      const updated = await fileTimesheetWeek({ weekStart: weekStart.toISOString(), clientId: clientArg });
      queryCache.setQueryData<TimesheetWeekResponse>(weekKey, updated);
      // Attestation is best-effort and only for compliance-managers; the
      // filing snapshot is already recorded regardless.
      if (canAttest) {
        try {
          await upsertAttestation({
            key: 'FIELDGLASS_TIMESHEET',
            periodStart: mondayOfIsoWeek(updated.weekEndIso),
            outcome: 'YES',
            actionTakenAt: new Date().toISOString(),
            notes: `Filed via Timesheets for week ending ${updated.weekEnding}`,
            evidenceDocumentId: null,
          });
        } catch {
          /* filing recorded; attestation can be re-ticked on the scorecard */
        }
      }
      toast.success(already ? 'Re-filed — snapshot updated.' : 'Marked filed.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the filing.');
    } finally {
      setFilingBusy(false);
    }
  };

  const toggleEntered = async (r: NonNullable<typeof data>['rows'][number], entered: boolean) => {
    if (!r.clientId) return;
    setTicking(`${r.associateId}|${r.clientId}`);
    try {
      await markFieldglassEntered({ weekStart: weekStart.toISOString(), associateId: r.associateId, clientId: r.clientId, entered });
      await load({ silent: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update it.');
    } finally {
      setTicking(null);
    }
  };

  const allRows = data?.rows ?? NO_ROWS;
  // ST / OT / DT / NB stay zero under a flat "Others" SOW — shown only when
  // a week actually uses them (the export always carries every column).
  const showBuckets = allRows.some((r) => r.st > 0 || r.ot > 0 || r.dt > 0 || r.nb > 0);
  type TsRow = NonNullable<typeof data>['rows'][number];
  // Client-side name/site filter — the week's rows are already all loaded.
  // Token match ("aaliyah nelson" finds "Nelson, Aaliyah") since Fieldglass
  // names are Last, First. Copy/Export/filing stay on the FULL week: those
  // produce the Fieldglass artifact, not the current view.
  const rows = useMemo(() => {
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return allRows;
    return allRows.filter((r) => {
      const hay = `${r.worker} ${r.site}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [allRows, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fieldglass timesheets"
        subtitle="Fieldglass-ready weekly hours (Saturday → Friday). Approved time only, net of unpaid breaks."
      />

      {/* Week picker + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-md border border-navy-secondary bg-navy-secondary/30 p-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWeekStart((w) => addDays(w, -7))}
            title="Previous week"
            aria-label="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-3 text-sm text-white tabular-nums whitespace-nowrap">
            {/* Prefer the SERVER's week bounds once loaded. The rows are
                bucketed in the store timezone (America/New_York) server-side,
                while weekStart/weekEnd here are browser-local — for a viewer
                east of US Eastern, the browser's Saturday can fall in the
                PREVIOUS store-local week, and this header used to claim a
                different week than the data below it. The browser dates
                remain only as a pre-load placeholder and for navigation. */}
            {data
              ? `${fmtDate(`${data.weekStart}T12:00:00Z`)} – ${fmtDate(`${data.weekEndIso}T12:00:00Z`)}`
              : `${fmtDate(weekStart)} – ${fmtDate(weekEnd)}`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWeekStart((w) => addDays(w, 7))}
            title="Next week"
            aria-label="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setWeekStart(lastCompletedWeekStart(new Date()))}
          title="Jump to the last completed week"
        >
          Last completed week
        </Button>
        {boundedClient ? (
          <div
            className="inline-flex h-8 items-center rounded-md border border-navy-secondary bg-navy-secondary/30 px-2.5 text-sm text-white"
            title="Your account is scoped to this client"
          >
            {boundedClient.name}
          </div>
        ) : (
          <Select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="h-8 w-auto text-sm"
            title="File one Fieldglass client/SOW at a time"
            aria-label="Client filter"
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <div className="relative w-56">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-silver/70 pointer-events-none" />
          <Input
            placeholder="Search associate or site…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
            aria-label="Search associates"
          />
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant={showSchedule ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setShowSchedule((v) => !v)}
            disabled={!data || data.scheduleComparison.length === 0}
            title="Compare published schedule vs hours actually worked"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            Scheduled vs actual
            {scheduleFlags.length > 0 && (
              <span className="ml-1 rounded-full bg-gold/20 px-1.5 text-xs2 text-gold">
                {scheduleFlags.length}
              </span>
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void load()} loading={weekQuery.isFetching}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopy}
            disabled={allRows.length === 0}
            title="Copy the grid (tab-separated) for pasting into Fieldglass"
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            Copy
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onDownload}
            loading={downloading}
            disabled={allRows.length === 0}
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Export .xlsx
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onMarkFiled}
            loading={filingBusy}
            disabled={!data || allRows.length === 0}
            title="Record a snapshot of this week's hours as filed into Fieldglass"
          >
            {data?.filing ? <RefreshCw className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {data?.filing ? 'Re-file' : 'Mark filed'}
          </Button>
        </div>
      </div>

      {data && (
        <FieldglassStrip
          data={data}
          clientId={clientArg}
          onEnter={() => setEntering(true)}
          onImported={() => void load({ silent: true })}
        />
      )}

      {data?.filing &&
        (data.filing.drift.length > 0 ? (
          <div className="rounded-md border border-gold/40 bg-gold/10 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-gold">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Filed {fmtDate(data.filing.filedAt)} — {data.filing.drift.length}{' '}
                associate{data.filing.drift.length === 1 ? '' : 's'} changed since. Re-file to match
                Fieldglass.
              </div>
              <Button variant="secondary" size="sm" onClick={onMarkFiled} loading={filingBusy}>
                <RefreshCw className="h-3.5 w-3.5" />
                Re-file
              </Button>
            </div>
            <ul className="space-y-1 text-xs">
              {data.filing.drift.map((d) => (
                <li key={d.associateId} className="flex flex-wrap gap-x-2">
                  <span className="font-medium text-white">{d.worker}</span>
                  <span className="text-silver/70">
                    filed {d.filedHours.toFixed(2)}h → now {d.currentHours.toFixed(2)}h (
                    {d.delta > 0 ? '+' : ''}
                    {d.delta.toFixed(2)})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-navy-secondary bg-navy/40 p-2.5 text-sm text-silver">
            <Lock className="h-4 w-4 text-gold" />
            Filed{data.filing.filedBy ? ` by ${data.filing.filedBy}` : ''} ·{' '}
            {fmtDateTime(data.filing.filedAt)} ·{' '}
            {data.filing.filedTotalHours.toFixed(2)}h — in sync.
          </div>
        ))}

      {data && data.issues.length > 0 ? (
        <div className="rounded-md border border-gold/40 bg-gold/10 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-gold">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {data.issues.length} {data.issues.length === 1 ? 'issue' : 'issues'} to review before
              filing
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                navigate(
                  `/time-attendance?tab=queue&from=${data.weekStart}&to=${data.weekEndIso}`,
                )
              }
            >
              Review in Time &amp; Attendance
            </Button>
          </div>
          <ul className="space-y-1 text-xs">
            {data.issues.map((iss, i) => {
              const inner = (
                <>
                  <span className="shrink-0 font-semibold text-gold/90">
                    {ISSUE_LABEL[iss.kind]}
                  </span>
                  <span className="font-medium text-white group-hover:underline">
                    {iss.worker}
                  </span>
                  <span className="text-silver/70">— {iss.detail}</span>
                </>
              );
              return (
                <li key={`${iss.associateId ?? i}-${iss.kind}`}>
                  {iss.associateId ? (
                    <Link
                      to={`/time-attendance?tab=queue&associate=${iss.associateId}&name=${encodeURIComponent(iss.worker)}&from=${data.weekStart}&to=${data.weekEndIso}`}
                      className="group flex flex-wrap gap-x-2"
                      title="Open this associate's week in the approval queue"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className="flex flex-wrap gap-x-2">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : data && allRows.length > 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-navy-secondary bg-navy/40 p-2.5 text-sm text-silver">
          <CheckCircle2 className="h-4 w-4 text-gold" />
          No issues — this week looks ready to file.
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {/* Column budget: a phone keeps Status / Associate / Fieldglass /
              Total as the card; the ST/OT/DT breakdown and the Fieldglass
              bookkeeping columns (ID / Revision / week-End) are there to
              show or hide. */}
          <DataGrid<TsRow>
            id="timesheets-roster"
            caption="Approved hours by associate"
            rows={rows}
            rowKey={(r) => `${r.associateId}-${r.site}`}
            loading={loading}
            search={false}
            urlState={false}
            exportCsv={{ filename: 'timesheets' }}
            empty={
              allRows.length > 0
                ? { title: 'No associate matches', description: `Nobody in this week's timesheet matches "${search.trim()}". Clear the search to see all ${allRows.length} associates.` }
                : { title: 'No approved hours this week', description: 'Nothing to report to Fieldglass for the selected week. Approve time in the queue, then refresh.' }
            }
            columns={[
              {
                key: 'status',
                header: 'Status',
                accessor: (r) => (r.status === 'PENDING' ? 'Pending Approval' : 'Ready to submit'),
                sortable: true,
                cardMeta: true,
                cell: (r) => <Badge variant={r.status === 'PENDING' ? 'pending' : 'success'}>{r.status === 'PENDING' ? 'Pending Approval' : 'Ready to submit'}</Badge>,
              },
              // ID + Revision are Fieldglass's — filled from the imported
              // Fieldglass list, so the columns match it line for line.
              { key: 'id', header: 'ID', accessor: (r) => r.fieldglass?.timesheetId, sortable: true, className: 'font-mono text-xs text-silver', cell: (r) => r.fieldglass?.timesheetId ?? <span className="text-silver/50">—</span> },
              { key: 'revision', header: 'Revision', accessor: (r) => r.fieldglass?.revision ?? 0, sortable: true, searchable: false, defaultHidden: true, align: 'right', className: 'tabular-nums text-silver/60' },
              {
                key: 'associate',
                header: 'Associate',
                accessor: (r) => r.worker,
                sortable: true,
                primary: true,
                className: 'font-medium',
                cell: (r) => (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void openDetail(r.associateId)}
                        className="whitespace-nowrap text-left text-gold hover:underline focus:underline focus:outline-none"
                        title="Open this associate's daily timesheet"
                      >
                        {r.worker}
                      </button>
                      <Link
                        to={`/time-attendance/timesheets/history/${r.associateId}`}
                        aria-label={`${r.worker} — every timesheet, across pay periods`}
                        title="Every timesheet, across pay periods"
                        className="rounded text-silver/60 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                      >
                        <HistoryIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </span>
                    {r.fieldglass?.workerId && <div className="font-mono text-xs2 font-normal text-silver/70">{r.fieldglass.workerId}</div>}
                  </>
                ),
              },
              {
                key: 'fieldglass',
                header: 'Fieldglass',
                accessor: (r) => (r.fieldglass?.enteredAt ? 'Entered' : 'Not entered'),
                sortable: true,
                stopRowClick: true,
                cell: (r) => <FieldglassStatusCell row={r} busy={ticking === `${r.associateId}|${r.clientId}`} onToggle={(entered) => void toggleEntered(r, entered)} />,
              },
              { key: 'site', header: 'Site', accessor: (r) => r.site, sortable: true, cardMeta: true, className: 'text-silver', cell: (r) => <span className="block max-w-[12rem] truncate" title={r.site}>{r.site}</span> },
              { key: 'end', header: 'End', accessor: () => data?.weekEnding ?? null, searchable: false, defaultHidden: true, className: 'tabular-nums text-silver' },
              ...(showBuckets
                ? [
                    { key: 'st', header: 'ST', accessor: (r: TsRow) => r.st, csv: (r: TsRow) => hoursCell(r.st), sortable: true, searchable: false, align: 'right' as const, className: 'tabular-nums text-silver', cell: (r: TsRow) => hoursCell(r.st) },
                    { key: 'ot', header: 'OT', accessor: (r: TsRow) => r.ot, csv: (r: TsRow) => hoursCell(r.ot), sortable: true, searchable: false, align: 'right' as const, className: 'tabular-nums text-silver', cell: (r: TsRow) => hoursCell(r.ot) },
                    { key: 'dt', header: 'DT', accessor: (r: TsRow) => r.dt, csv: (r: TsRow) => hoursCell(r.dt), sortable: true, searchable: false, align: 'right' as const, className: 'tabular-nums text-silver', cell: (r: TsRow) => hoursCell(r.dt) },
                  ]
                : []),
              { key: 'others', header: 'Others', accessor: (r) => r.others, csv: (r) => hoursCell(r.others), sortable: true, searchable: false, align: 'right', className: 'tabular-nums text-white', cell: (r) => hoursCell(r.others) },
              ...(showBuckets
                ? [{ key: 'nb', header: 'NB', accessor: (r: TsRow) => r.nb, csv: (r: TsRow) => hoursCell(r.nb), sortable: true, searchable: false, align: 'right' as const, className: 'tabular-nums text-silver', cell: (r: TsRow) => hoursCell(r.nb) }]
                : []),
              { key: 'total', header: 'Total', accessor: (r) => r.total, csv: (r) => hoursCell(r.total), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums font-semibold text-white', cell: (r) => hoursCell(r.total) },
            ]}
          />
        </CardContent>
      </Card>

      {showSchedule && data && data.scheduleComparison.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center gap-2 border-b border-navy-secondary p-3 text-sm font-medium text-white">
              <CalendarClock className="h-4 w-4 text-gold" />
              Scheduled vs actual
              <span className="text-xs font-normal text-silver/60">
                (published assigned shifts vs approved hours worked)
              </span>
            </div>
            <div className="overflow-x-auto">
              <DataGrid<NonNullable<typeof data>['scheduleComparison'][number]>
                id="timesheets-scheduled-vs-actual"
                caption="Scheduled vs actual"
                rows={data.scheduleComparison}
                rowKey={(c) => c.associateId}
                search={false}
                urlState={false}
                exportCsv={{ filename: 'scheduled-vs-actual' }}
                columns={[
                  { key: 'associate', header: 'Associate', accessor: (c) => c.worker, sortable: true, primary: true, className: 'font-medium text-white' },
                  { key: 'scheduled', header: 'Scheduled', accessor: (c) => c.scheduledHours, csv: (c) => c.scheduledHours.toFixed(2), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums text-silver', cell: (c) => c.scheduledHours.toFixed(2) },
                  { key: 'actual', header: 'Actual', accessor: (c) => c.actualHours, csv: (c) => c.actualHours.toFixed(2), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums text-silver', cell: (c) => c.actualHours.toFixed(2) },
                  {
                    key: 'delta',
                    header: 'Δ',
                    accessor: (c) => c.delta,
                    csv: (c) => `${c.delta > 0 ? '+' : ''}${c.delta.toFixed(2)}`,
                    sortable: true,
                    searchable: false,
                    align: 'right',
                    className: 'tabular-nums',
                    cell: (c) => (
                      <span className={Math.abs(c.delta) >= 2 ? 'font-semibold text-gold' : 'text-silver/70'}>
                        {c.delta > 0 ? '+' : ''}
                        {c.delta.toFixed(2)}
                      </span>
                    ),
                  },
                  {
                    key: 'flag',
                    header: 'Flag',
                    accessor: (c) => (c.scheduledHours > 0 && c.actualHours === 0 ? 'No-show' : Math.abs(c.delta) >= 2 ? (c.delta > 0 ? 'Over' : 'Under') : null),
                    sortable: true,
                    cell: (c) =>
                      c.scheduledHours > 0 && c.actualHours === 0 ? (
                        <Badge variant="destructive">No-show</Badge>
                      ) : Math.abs(c.delta) >= 2 ? (
                        <Badge variant="pending">{c.delta > 0 ? 'Over' : 'Under'}</Badge>
                      ) : (
                        <span className="text-silver/40">—</span>
                      ),
                  },
                ]}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {data && allRows.length > 0 && (
        <p className="text-xs text-silver/70">
          {rows.length !== allRows.length
            ? `${rows.length} of ${allRows.length} associates shown`
            : `${allRows.length} associate${allRows.length === 1 ? '' : 's'}`}{' '}
          · {data.totalHours.toFixed(2)} total hours · week ending {data.weekEnding}. Hours are net
          of unpaid breaks, billed flat under &ldquo;Others&rdquo; per the SOW.
        </p>
      )}

      {data && (
        <EnterInFieldglass
          open={entering}
          onClose={() => setEntering(false)}
          data={data}
          weekStartIso={weekStart.toISOString()}
          onChanged={() => void load({ silent: true })}
        />
      )}

      {/* Fieldglass individual-timesheet drill-down */}
      <Drawer
        open={detailOpen}
        onOpenChange={(o) => {
          if (!o) {
            setDetailOpen(false);
            setDetailAssociateId(null);
          }
        }}
        width="max-w-3xl"
      >
        <DrawerHeader>
          <DrawerTitle>
            <AssociateLink associateId={detailAssociateId}>
              {detail?.worker ?? 'Timesheet'}
            </AssociateLink>
          </DrawerTitle>
          <DrawerDescription>
            {detail ? `Period ${detail.periodLabel} · ${detail.site}` : 'Loading…'}
            {detailAssociateId && (
              <Link
                to={`/time-attendance/timesheets/history/${detailAssociateId}`}
                className="ml-2 inline-flex items-center gap-1 text-gold hover:underline"
              >
                <HistoryIcon className="h-3.5 w-3.5" aria-hidden="true" />
                Full timesheet history
              </Link>
            )}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          {detailLoading || !detail ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span>
                  <span className="text-silver/60">Status: </span>
                  <Badge variant={detail.status === 'PENDING' ? 'pending' : 'success'}>
                    {detail.status === 'PENDING' ? 'Pending Approval' : 'Ready to submit'}
                  </Badge>
                </span>
                <span>
                  <span className="text-silver/60">Total worked: </span>
                  <span className="font-semibold text-white tabular-nums">
                    {detail.totalHours.toFixed(2)}h
                  </span>
                </span>
              </div>

              {detail.pendingCount > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-gold/40 bg-gold/10 p-2.5 text-xs text-gold">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {detail.pendingCount}{' '}
                    {detail.pendingCount === 1 ? 'entry is' : 'entries are'} still pending approval
                    and excluded from the totals below.
                  </span>
                </div>
              )}

              <div className="overflow-x-auto rounded-md border border-navy-secondary">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-navy-secondary/40">
                      <th className="p-2 text-left font-medium text-silver/70 whitespace-nowrap">
                        Time in / time out
                      </th>
                      {detail.days.map((d) => (
                        <th key={d.date} className="p-2 text-center whitespace-nowrap">
                          <div className="font-semibold text-white">{d.weekday}</div>
                          <div className="text-xs2 tabular-nums text-silver/60">{d.monthDay}</div>
                        </th>
                      ))}
                      <th className="p-2 text-center font-semibold text-white">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Which shift each day fulfilled — named and color-
                        coded so the week's pattern reads at a glance. */}
                    {detail.days.some((d) => (d.shifts ?? []).length > 0) && (
                      <tr className="border-t border-navy-secondary">
                        <td className="p-2 text-silver/70">Shift</td>
                        {detail.days.map((d) => (
                          <td key={d.date} className="p-2 text-center align-top">
                            {(d.shifts ?? []).length === 0 ? (
                              <span className="text-silver/40">—</span>
                            ) : (
                              <div className="flex flex-col items-center gap-1">
                                {(d.shifts ?? []).map((name, i) => (
                                  <span
                                    key={i}
                                    className={`inline-flex max-w-[9rem] items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs2 font-medium ${
                                      name === null
                                        ? 'bg-warning/15 text-warning'
                                        : shiftChipClass(name)
                                    }`}
                                    title={name ?? 'No scheduled shift matched this punch (walk-in or manual entry)'}
                                  >
                                    {name ?? 'unscheduled'}
                                  </span>
                                ))}
                                {d.overnight && (
                                  <span
                                    className="text-xs2 text-sky/80"
                                    title="This shift crossed midnight — it ends the next calendar day but belongs to this day's timesheet column."
                                  >
                                    ☾ overnight
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        ))}
                        <td />
                      </tr>
                    )}
                    <tr className="border-t border-navy-secondary">
                      <td className="p-2 text-silver/70">Time In</td>
                      {detail.days.map((d) => (
                        <td key={d.date} className="p-2 text-center tabular-nums text-silver whitespace-nowrap">
                          {d.timeIn ?? '—'}
                        </td>
                      ))}
                      <td />
                    </tr>
                    <tr className="border-t border-navy-secondary">
                      <td className="p-2 text-silver/70">Meal Break</td>
                      {detail.days.map((d) => (
                        <td key={d.date} className="p-2 text-center text-xs2 text-silver/80 whitespace-nowrap">
                          {d.breaks.length > 0
                            ? d.breaks.map((b, i) => <div key={i}>{b}</div>)
                            : '—'}
                        </td>
                      ))}
                      <td />
                    </tr>
                    <tr className="border-t border-navy-secondary">
                      <td className="p-2 text-silver/70">Time Out</td>
                      {detail.days.map((d) => (
                        <td key={d.date} className="p-2 text-center tabular-nums text-silver whitespace-nowrap">
                          {d.timeOut ?? '—'}
                        </td>
                      ))}
                      <td />
                    </tr>
                    <tr className="border-t border-navy-secondary bg-navy-secondary/30">
                      <td className="p-2 font-medium text-white">Total Worked</td>
                      {detail.days.map((d) => (
                        <td key={d.date} className="p-2 text-center tabular-nums font-medium text-white">
                          {d.netHours.toFixed(2)}
                        </td>
                      ))}
                      <td className="p-2 text-center tabular-nums font-semibold text-white">
                        {detail.totalHours.toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {/* Shift legend — the week's distinct shifts with their colors,
                  so the chip bands read without hovering. */}
              {(() => {
                const named = [
                  ...new Set(
                    detail.days.flatMap((d) =>
                      (d.shifts ?? []).filter((s): s is string => s !== null),
                    ),
                  ),
                ];
                const anyUnscheduled = detail.days.some((d) =>
                  (d.shifts ?? []).some((s) => s === null),
                );
                if (named.length === 0 && !anyUnscheduled) return null;
                return (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs2">
                    <span className="text-silver/60">Shifts:</span>
                    {named.map((name) => (
                      <span
                        key={name}
                        className={`rounded-full px-2 py-0.5 font-medium ${shiftChipClass(name)}`}
                      >
                        {name}
                      </span>
                    ))}
                    {anyUnscheduled && (
                      <span className="rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning">
                        unscheduled — no shift matched the punch
                      </span>
                    )}
                  </div>
                );
              })()}
              {/* Punches are formatted server-side on each SITE's wall clock —
                  the same clock the associate punched on — not the viewer's. */}
              <p className="text-xs2 text-silver/60">
                Times shown in each work site's local time.
              </p>

              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-white">Accounting (USD)</h3>
                <div className="overflow-x-auto rounded-md border border-navy-secondary">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-navy-secondary/40 text-silver/70">
                        <th className="p-2 text-left font-medium">Rates</th>
                        <th className="p-2 text-right font-medium">Pay Rate</th>
                        {showBill && <th className="p-2 text-right font-medium">Rate</th>}
                        <th className="p-2 text-right font-medium">Quantity</th>
                        <th className="p-2 text-right font-medium">Days</th>
                        {showBill && <th className="p-2 text-right font-medium">Amount (USD)</th>}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-navy-secondary">
                        <td className="p-2 text-silver whitespace-nowrap">{detail.rateLabel}</td>
                        <td className="p-2 text-right tabular-nums text-silver">
                          {/* Null = no comp record on file. A dash, not a
                              default — the old $15 fallback put a fabricated
                              rate on a billing-adjacent sheet. */}
                          {detail.payRate != null ? detail.payRate.toFixed(2) : '—'}
                        </td>
                        {showBill && (
                          <td className="p-2 text-right tabular-nums text-silver">
                            {detail.billRate != null ? detail.billRate.toFixed(2) : '—'}
                          </td>
                        )}
                        <td className="p-2 text-right tabular-nums text-silver">
                          {detail.totalHours.toFixed(2)}
                        </td>
                        <td className="p-2 text-right text-silver/60">—</td>
                        {showBill && (
                          <td className="p-2 text-right tabular-nums text-white">
                            {detail.amount != null ? detail.amount.toFixed(2) : '—'}
                          </td>
                        )}
                      </tr>
                      <tr className="border-t border-navy-secondary bg-navy-secondary/30 font-medium">
                        <td className="p-2 text-white">Subtotal</td>
                        <td className="p-2" />
                        {showBill && <td className="p-2" />}
                        <td className="p-2 text-right tabular-nums text-white">
                          {detail.totalHours.toFixed(2)}
                        </td>
                        <td className="p-2 text-right text-silver/60">—</td>
                        {showBill && (
                          <td className="p-2 text-right tabular-nums text-white">
                            {detail.amount != null ? detail.amount.toFixed(2) : '—'}
                          </td>
                        )}
                      </tr>
                    </tbody>
                  </table>
                </div>
                {showBill && detail.billRate == null && (
                  <p className="text-xs text-gold/80">
                    Set this client&rsquo;s <strong>Fieldglass bill rate</strong> (client → Basics)
                    to compute the Amount.
                  </p>
                )}
              </div>

              <p className="text-xs text-silver/60">
                Times shown in {detail.timeZone}. Overnight shifts appear under their clock-in day.
                Meal breaks are unpaid and excluded from Total Worked. Pay Rate is what Alto pays the
                associate{showBill ? '; Rate is the client bill rate' : ''}.
              </p>
            </div>
          )}
        </DrawerBody>
      </Drawer>
    </div>
  );
}
