import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { AssociateLink } from '@/components/ui/AssociateLink';
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Coffee,
  Download,
  ExternalLink,
  FileSpreadsheet,
  ShieldAlert,
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
  exportExternalPayrollSheet,
  exportPayrollSheet,
  exportTimeEntries,
  exportTimeSummary,
  getActiveDashboard,
  listAdminTimeEntries,
  listPayPeriods,
  rejectTimeEntry,
} from '@/lib/timeApi';
import {
  getPeriodPrefill,
  recordPayPeriod,
  type PeriodPrefillRow,
} from '@/lib/externalPaymentsApi';
import { listClientLocations } from '@/lib/clientsApi';
import { AttendanceCard } from '@/pages/time/AttendanceCard';
import { useClients } from '@/lib/useClients';
import { listShifts, listSchedulingAssociates } from '@/lib/schedulingApi';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useStoreScope } from '@/lib/storeScope';
import { cn } from '@/lib/cn';
import { usePersistentState } from '@/lib/usePersistentState';
import { useSelection } from '@/lib/useSelection';
import { TIME_ANOMALY_LABELS, timeAnomalyLabel } from '@/lib/timeLabels';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { ShiftTimeline } from './ShiftTimeline';
import { TimesheetWeeks } from './TimesheetWeeks';
import { fmtPunchDateTime, fmtPunchTime, formatHM, punchDayOffset } from './punchFormat';
import {
  browserTimeZone,
  fmtDateTime,
  fmtDateTz,
  fmtPayRate,
  fmtTime,
  parseYmd,
  tzAbbrev,
  ymdLocal,
  ymdToIsoEndExclusive,
  ymdToIsoStart,
  zonedDayKey,
  zonedMinutesOfDay,
  zonedWallTimeToUtc,
} from '@/lib/format';
import {
  AssociatePicker,
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
  ErrorBanner,
  FilterChip,
  Input,
  Label,
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
  Tabs,
  TabsList,
  TabsTrigger,
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

// Punch formatters live in ./punchFormat so the ShiftTimeline and every
// other single-entry surface renders identically to the queue.

// PERF: the desktop table and the phone card stack used to BOTH mount — CSS
// (`hidden md:block` / `md:hidden`) hid one, but React still committed up to
// 500 dead heavy rows for the hidden list. This matchMedia hook lets us
// mount only the list the viewport can show, and re-render on breakpoint
// crossings (resize / rotation).
//
// Cutover matches the scheduling module's rule: mouse-class devices get
// the table from md (768px); TOUCH devices keep the card stack until lg —
// an iPad portrait is 768px total, and after the sidebar it was cramming
// the desktop table into ~half a screen.
const DESKTOP_TABLE_QUERY =
  '(min-width: 1024px), ((pointer: fine) and (min-width: 768px))';
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia(DESKTOP_TABLE_QUERY).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_TABLE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
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

// Human labels for the raw status enum — chips never show "COMPLETED".
const STATUS_LABELS: Record<TimeEntryStatus, string> = {
  ACTIVE: 'Active',
  COMPLETED: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

// Net-first duration. The headline figure is worked-time NET of breaks —
// what payroll actually pays. The subline used to be a bare equation
// fragment ("9h 00m gross − 0h 30m break") that users had to decode; it
// now reads as facts: the on-site span and how many breaks were taken.
function DurationCell({ entry }: { entry: TimeEntry }) {
  const net = entry.netMinutes ?? entry.minutesElapsed;
  const breakMin = Math.max(0, entry.minutesElapsed - net);
  const breakCount = entry.breaks?.length ?? (breakMin > 0 ? 1 : 0);
  return (
    <div className="tabular-nums">
      {formatHM(net)}
      {breakMin > 0 && (
        <div className="text-2xs text-silver/70 whitespace-nowrap">
          {formatHM(entry.minutesElapsed)} on site ·{' '}
          {breakCount > 1 ? `${breakCount} breaks` : '1 break'} ({formatHM(breakMin)})
        </div>
      )}
    </div>
  );
}

/** "+1d" tag for punches landing a site-local day after the clock-in, so an
 *  overnight shift's "Out" column stops reading as the same afternoon. */
function DayOffsetTag({ entry }: { entry: TimeEntry }) {
  if (!entry.clockOutAt) return null;
  const off = punchDayOffset(entry.clockInAt, entry.clockOutAt, entry.locationTimezone);
  if (off <= 0) return null;
  return <span className="ml-1 text-2xs text-warning align-super">+{off}d</span>;
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
      className="text-2xs uppercase tracking-widest px-1.5 py-0.5 rounded border border-alert/40 bg-alert/10 text-alert whitespace-nowrap"
      title={`Scheduled ${fmtTime(entry.shiftStartsAt)}${entry.shiftPosition ? ` · ${entry.shiftPosition}` : ''}`}
    >
      {/* Lateness stays in minutes below the hour (an offset, not paid
          time); an hour-plus lateness reads as decimal hours like every
          other duration. */}
      Late {lateMin >= 60 ? `${(lateMin / 60).toFixed(1)}h` : `${lateMin}m`}
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
        <div className="text-xs2 text-silver/70">
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
          className="text-2xs uppercase tracking-widest px-1.5 py-0.5 rounded border border-warning/40 bg-warning/10 text-warning whitespace-nowrap"
        >
          {timeAnomalyLabel(a)}
        </span>
      ))}
    </div>
  );
}

function defaultFromYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - 13); // last 14 days inclusive
  return ymdLocal(d);
}

function defaultToYmd(): string {
  return ymdLocal(new Date());
}

/** Saturday 00:00 (local) that starts the org's Sat→Fri week containing `d`
 *  — same convention as TimesheetsView's filing weeks. */
function startOfSaturdayWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); // Sat→0, Sun→1 … Fri→6
  return x;
}

// Quick-range chips over the From/To inputs. Same stateful-chip semantics
// as MyTimesheet: hand-editing a date clears the active chip so it never
// lies about what's shown. Weeks follow the org Sat→Fri convention.
type RangePreset = 'THIS_WEEK' | 'LAST_WEEK' | 'LAST14';
const RANGE_PRESETS: Array<[RangePreset, string]> = [
  ['THIS_WEEK', 'This week'],
  ['LAST_WEEK', 'Last week'],
  ['LAST14', 'Last 14 days'],
];

// "Jun 22 – Jul 5" — compact label for a pay-period option. Bare YYYY-MM-DD
// parses as UTC midnight, so format in UTC or the day shifts west of GMT.
function periodLabel(p: PayPeriod): string {
  return `${fmtDateTz(p.start, 'UTC')} – ${fmtDateTz(p.end, 'UTC')}`;
}

// Pay periods are static config for the tenant — cache them at module level
// so remounting this view (tab hops, route changes) doesn't refetch.
// Failures are NOT cached, so the next mount retries.
let payPeriodsCache: PayPeriod[] | null = null;

/** Tests mock listPayPeriods per-case; the module cache would otherwise
 *  leak the first case's periods into the rest of the file's tests. */
export function __resetPayPeriodsCacheForTests(): void {
  payPeriodsCache = null;
}

interface AdminTimeViewProps {
  canManage: boolean;
  /** Watch-only mode (FLOOR_SUPERVISOR): live board only — the approval
   *  queue tab is hidden entirely. */
  liveOnly?: boolean;
}

// ── Shift-window lens ─────────────────────────────────────────────────────
// Key = the matched shift's start/end as minutes-from-midnight in the SITE
// timezone (UTC fallback), so Monday's and Tuesday's 6–2 collapse into one
// option and DST weeks don't split into two. Must stay in lockstep with the
// server's siteLocalMinutes (time.ts) — the export re-derives the same key.
// Formatter cache — Intl.DateTimeFormat construction is the expensive
// part, and the shift-window predicates below run this over up to 500
// rows per filter pass (twice per row). Same idiom as lib/format.ts.
const SITE_MIN_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
function siteMinutesFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = SITE_MIN_FMT_CACHE.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: tz,
    });
    SITE_MIN_FMT_CACHE.set(tz, fmt);
  }
  return fmt;
}
function siteMinutes(iso: string, tz: string | null): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = siteMinutesFormatter(tz ?? 'UTC').formatToParts(new Date(iso));
  } catch {
    parts = siteMinutesFormatter('UTC').formatToParts(new Date(iso));
  }
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h % 24) * 60 + m;
}

function minutesLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Structural param — both the queue's TimeEntry and the live board's
// ActiveDashboardEntry qualify.
function shiftWindowOf(e: {
  shiftStartsAt?: string | null;
  shiftEndsAt?: string | null;
  locationTimezone?: string | null;
}): { key: string; label: string; sort: number } | null {
  if (!e.shiftStartsAt || !e.shiftEndsAt) return null;
  const tz = e.locationTimezone ?? null;
  const startMin = siteMinutes(e.shiftStartsAt, tz);
  const endMin = siteMinutes(e.shiftEndsAt, tz);
  return {
    key: `${startMin}-${endMin}`,
    label: `${minutesLabel(startMin)} – ${minutesLabel(endMin)}`,
    sort: startMin * 1440 + endMin,
  };
}

type ShiftWindowOptions = {
  windows: Array<{ key: string; label: string; count: number; sort: number }>;
  unmatched: number;
};

// Dropdown options from whatever list is on screen — the org's real
// windows, not a hardcoded list. Shared by the queue and the live board.
function collectShiftWindows(
  list: ReadonlyArray<Parameters<typeof shiftWindowOf>[0]> | null,
): ShiftWindowOptions {
  const windows = new Map<string, { key: string; label: string; count: number; sort: number }>();
  let unmatched = 0;
  for (const e of list ?? []) {
    const w = shiftWindowOf(e);
    if (!w) {
      unmatched += 1;
      continue;
    }
    const cur = windows.get(w.key);
    if (cur) cur.count += 1;
    else windows.set(w.key, { ...w, count: 1 });
  }
  return {
    windows: [...windows.values()].sort((a, b) => a.sort - b.sort),
    unmatched,
  };
}

function ShiftWindowSelect({
  id,
  value,
  onChange,
  options,
  className,
  'aria-label': ariaLabel,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: ShiftWindowOptions;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className ?? 'h-9 text-sm w-48'}
      aria-label={ariaLabel}
    >
      <option value="">All shifts</option>
      {options.windows.map((w) => (
        <option key={w.key} value={w.key}>
          {w.label} ({w.count})
        </option>
      ))}
      {options.unmatched > 0 && (
        <option value="none">No matched shift ({options.unmatched})</option>
      )}
    </Select>
  );
}

// True while `pick` still corresponds to something in the refreshed list.
function shiftPickStillThere(pick: string, options: ShiftWindowOptions): boolean {
  return pick === 'none'
    ? options.unmatched > 0
    : options.windows.some((w) => w.key === pick);
}

function matchesShiftPick(
  e: Parameters<typeof shiftWindowOf>[0],
  pick: string,
): boolean {
  const w = shiftWindowOf(e);
  return pick === 'none' ? w === null : w?.key === pick;
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

/**
 * Client → site cascading scope, rendered on BOTH the live board and the
 * approval queue. Bounded viewers see their pinned client as a static chip
 * (the server clamps them anyway); admins default to all clients.
 */
function ClientSiteSelects({
  boundedClient,
  clients,
  clientFilter,
  onClientChange,
  locationFilter,
  onLocationChange,
  locationOptions,
}: {
  boundedClient: { id: string; name: string } | null;
  clients: Array<{ id: string; name: string }>;
  clientFilter: string;
  onClientChange: (id: string) => void;
  locationFilter: string;
  onLocationChange: (id: string) => void;
  locationOptions: Array<{ id: string; name: string }>;
}) {
  return (
    <>
      {boundedClient ? (
        <div
          className="inline-flex h-9 items-center rounded-md border border-navy-secondary bg-navy-secondary/30 px-2.5 text-sm text-white"
          title="Your account is scoped to this client"
        >
          {boundedClient.name}
        </div>
      ) : (
        <Select
          value={clientFilter}
          onChange={(e) => onClientChange(e.target.value)}
          className="h-9 w-auto max-w-48 text-sm"
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
      {clientFilter && locationOptions.length > 0 && (
        <Select
          value={locationFilter}
          onChange={(e) => onLocationChange(e.target.value)}
          className="h-9 w-auto max-w-48 text-sm"
          aria-label="Location filter"
        >
          <option value="">All locations</option>
          {locationOptions.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      )}
    </>
  );
}

export function AdminTimeView({ canManage, liveOnly = false }: AdminTimeViewProps) {
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  // Active tab lives in ?tab= — shareable ("send me the queue"), and Back
  // retraces the live↔queue switch instead of leaving the page.
  const [tabParams, setTabParams] = useSearchParams();
  const tabParam = tabParams.get('tab');
  const tab: Tab = !liveOnly && tabParam === 'queue' ? 'queue' : 'live';
  const setTab = (next: Tab) => {
    const params = new URLSearchParams(tabParams);
    if (next === 'live') params.delete('tab');
    else params.set('tab', next);
    setTabParams(params);
  };
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
  // Which quick-range chip produced the current window; the defaults ARE
  // the last-14-days preset. Manual edits / period picks clear it.
  const [activePreset, setActivePreset] = useState<RangePreset | null>('LAST14');
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
  // Anomaly-TYPE chips inside the anomalies lens: multiple picks OR
  // together, none = every flagged entry. Session-only — a persisted
  // type pick would silently hide next week's different pile.
  const [anomalyTypes, setAnomalyTypes] = useState<string[]>([]);
  // Shift lens: narrow the queue to one shift window (e.g. the 6–2), same
  // client-side scope as the anomalies lens. '' = all; 'none' = entries
  // with no matched shift; otherwise a "<startMin>-<endMin>" window key.
  // The live board gets its own pick — the two tabs cover different rosters
  // (right now vs a date range), so one shared value would cross-reset.
  const [shiftFilter, setShiftFilter] = useState('');
  const [liveShiftFilter, setLiveShiftFilter] = useState('');
  // Live-board lenses: longest-elapsed-first surfaces runaway sessions;
  // the off-site lens narrows to geofence violations (also reachable via
  // the Off-site KPI tile).
  const [liveSortLongest, setLiveSortLongest] = useState(false);
  const [liveOffSiteOnly, setLiveOffSiteOnly] = useState(false);
  // Rows with a one-click clock-out in flight (single or group action).
  const [liveClockOutIds, setLiveClockOutIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Bulk apply-break length — the button next to the picker reads it.
  const [bulkBreakMinutes, setBulkBreakMinutes] = useState<15 | 30 | 60>(60);
  // Server hit its row cap — the window has MORE rows than shown.
  const [truncated, setTruncated] = useState(false);
  const [exportBusy, setExportBusy] = useState<null | 'csv' | 'pdf'>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [payrollOpen, setPayrollOpen] = useState(false);
  const [externalOpen, setExternalOpen] = useState(false);
  // Distinct from canManage (manage:time). The external sheet carries full
  // SSNs and bank accounts, so it sits behind its own capability held by
  // HR_ADMINISTRATOR alone — manage:time reaches down to SHIFT_SUPERVISOR.
  const { can: canCap, user } = useAuth();
  const canExportPayrollPii = canCap('export:payroll-pii');
  const canProcessPayroll = canCap('process:payroll');
  const [recordPeriodOpen, setRecordPeriodOpen] = useState(false);

  // Client/site scope — shared by BOTH tabs so switching keeps context.
  // Every client's live board and approval queue used to pool into one
  // list: the server accepted clientId all along but the page never sent
  // it, so bulk select-all spanned clients while timesheets file per
  // client. Bounded roles (SHIFT_SUPERVISOR) are clamped server-side
  // regardless; the pin below just makes the UI say so.
  const boundedClient = user?.clientId
    ? { id: user.clientId, name: user.clientName ?? 'Your client' }
    : null;
  const { clients } = useClients({ enabled: !boundedClient });
  // The global Topbar store scope is this page's default client filter —
  // previously the filter reset to "all clients" on every visit while
  // Scheduling remembered its own, which made both feel broken. A ?entry=
  // deep link skips the default so the scope can't hide an entry that
  // lives at another store; page-level select changes write back to the
  // scope so Scheduling/Labor follow along.
  const storeScope = useStoreScope();
  const [clientFilter, setClientFilter] = useState(
    () =>
      boundedClient?.id ??
      (storeScope.enabled &&
      storeScope.clientId &&
      !new URLSearchParams(window.location.search).get('entry')
        ? storeScope.clientId
        : ''),
  );
  const scopeClientId = storeScope.enabled && !boundedClient ? storeScope.clientId : null;
  const scopeSyncedRef = useRef(false);
  useEffect(() => {
    if (scopeClientId === null) return;
    if (!scopeSyncedRef.current) {
      scopeSyncedRef.current = true;
      return;
    }
    setClientFilter((prev) => (prev === scopeClientId ? prev : scopeClientId));
  }, [scopeClientId]);
  const changeClientFilter = useCallback(
    (id: string) => {
      setClientFilter(id);
      storeScope.setClientId(id);
    },
    [storeScope],
  );
  const [locationFilter, setLocationFilter] = useState('');
  const [locationOptions, setLocationOptions] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    setLocationFilter('');
    if (!clientFilter) {
      setLocationOptions([]);
      return;
    }
    let cancelled = false;
    // Bounded roles lack view:clients — the fetch 403s, the catch leaves
    // the site list empty, and the Location select stays disabled. Same
    // graceful degradation as the export dialogs below.
    listClientLocations(clientFilter)
      .then((r) => {
        if (!cancelled) setLocationOptions(r.locations.map((l) => ({ id: l.id, name: l.name })));
      })
      .catch(() => {
        if (!cancelled) setLocationOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientFilter]);
  const [bulkBusy, setBulkBusy] = useState(false);
  // advanceOnDone: the reject came from the detail drawer mid-triage —
  // when it completes, open the next flagged entry's drawer (Fix: the
  // common triage path used to dump the reviewer back to the list).
  const [rejectOpen, setRejectOpen] = useState<
    null | { mode: 'one'; id: string; advanceOnDone?: boolean } | { mode: 'bulk' }
  >(null);
  const [drawerTarget, setDrawerTarget] = useState<TimeEntry | null>(null);
  // Admin clock-in/out + edit on behalf of an associate.
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TimeEntry | null>(null);
  // Edit opened from the detail drawer → Save returns there (with fresh
  // data) instead of dumping the reviewer back to the list.
  const [editFromDetail, setEditFromDetail] = useState(false);

  // Individual timesheet focus: click an associate's name in the queue to
  // scope every filter to just their entries, with range totals up top.
  // Session-only by design — a persisted person-filter is the classic
  // "where did everyone go?" trap.
  const [focusAssociate, setFocusAssociate] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Ref mirrors so the stable focus callbacks can read the CURRENT filter
  // and focus without carrying them as deps (which would re-render the
  // memoised queue rows on every filter flip).
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const focusAssociateRef = useRef(focusAssociate);
  focusAssociateRef.current = focusAssociate;
  // Entering focus mode forces the status filter to ALL — but that filter
  // is PERSISTED, so without a snapshot the reviewer's slice (usually
  // "Pending review") was permanently overwritten. Snapshot on entry,
  // restore on clear.
  const preFocusFilterRef = useRef<TimeEntryStatus | 'ALL' | null>(null);

  // Focus + force filter to ALL (their full timesheet, not just the
  // current status slice), snapshotting the filter the first time.
  const focusWithAllFilter = useCallback(
    (assoc: { id: string; name: string }) => {
      if (!focusAssociateRef.current && preFocusFilterRef.current === null) {
        preFocusFilterRef.current = filterRef.current;
      }
      setFocusAssociate(assoc);
      setFilter('ALL');
    },
    [setFilter],
  );

  // Leaving focus restores the snapshotted filter — unless the reviewer
  // deliberately moved off ALL while focused (their pick wins).
  const clearFocus = useCallback(() => {
    setFocusAssociate(null);
    const prev = preFocusFilterRef.current;
    preFocusFilterRef.current = null;
    if (prev !== null && prev !== 'ALL' && filterRef.current === 'ALL') {
      setFilter(prev);
    }
  }, [setFilter]);

  // Stable (useCallback, empty-ish deps) so the memoised queue rows don't
  // re-render when unrelated parent state changes.
  const focusOn = useCallback(
    (e: TimeEntry) => {
      focusWithAllFilter({ id: e.associateId, name: e.associateName ?? '—' });
    },
    [focusWithAllFilter],
  );

  // Deep-link: ?from=YYYY-MM-DD&to=YYYY-MM-DD presets the queue's date
  // window (report links pair it with &associate=). Consume-once like the
  // ?entry/?associate params below; invalid values are consumed and
  // ignored. Runs before those effects so a combined associate+range link
  // lands on the right window.
  const fromParam = tabParams.get('from');
  const toParam = tabParams.get('to');
  useEffect(() => {
    if ((!fromParam && !toParam) || liveOnly) return;
    const valid = (s: string | null): s is string =>
      !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseYmd(s) !== null;
    const f = valid(fromParam) ? fromParam : null;
    const t = valid(toParam) ? toParam : null;
    const params = new URLSearchParams(tabParams);
    params.delete('from');
    params.delete('to');
    setTabParams(params, { replace: true });
    if (f && t && f > t) return; // inverted range — ignore both
    if (f) setFromYmd(f);
    if (t) setToYmd(t);
    if (f || t) {
      setPeriodKey('');
      setActivePreset(null);
    }
    // Same rationale as the ?entry effect below for the trimmed dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromParam, toParam, liveOnly]);

  // Notification deep-link: ?entry=<id> lands on the exact record — queue
  // tab, that associate's focused timesheet (which guarantees the row is on
  // screen regardless of the persisted status filter), date window widened
  // to cover the entry, detail drawer open, row flashed briefly. The param
  // is consumed once so refreshes/back don't re-trigger.
  const [flashEntryId, setFlashEntryId] = useState<string | null>(null);
  const entryParam = tabParams.get('entry');
  useEffect(() => {
    if (!entryParam || liveOnly) return;
    let cancelled = false;
    (async () => {
      let target: TimeEntry | null = null;
      try {
        const res = await listAdminTimeEntries({ entryId: entryParam });
        target = res.entries[0] ?? null;
      } catch {
        // Fall through — consume the param and explain below.
      }
      if (cancelled) return;
      const params = new URLSearchParams(tabParams);
      params.delete('entry');
      // This write happens async off a mount-time snapshot — drop the
      // date params too so it can't resurrect ones consumed above.
      params.delete('from');
      params.delete('to');
      if (!target) {
        setTabParams(params, { replace: true });
        setError('That time entry could not be found — it may have been deleted.');
        return;
      }
      params.set('tab', 'queue');
      setTabParams(params, { replace: true });
      // Snapshots the persisted status filter before forcing ALL, so
      // clearing the focus later restores the reviewer's slice.
      focusWithAllFilter({
        id: target.associateId,
        name: target.associateName ?? '—',
      });
      const day = ymdLocal(new Date(target.clockInAt));
      setFromYmd((cur) => (day < cur ? day : cur));
      setToYmd((cur) => (day > cur ? day : cur));
      // A widened window is no longer any preset/period.
      setActivePreset(null);
      setPeriodKey('');
      setDrawerTarget(target);
      setFlashEntryId(target.id);
    })();
    return () => {
      cancelled = true;
    };
    // tabParams/setters change identity every render; entryParam going null
    // after the consume ends the cycle, so they're deliberately not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryParam, liveOnly]);

  // Deep-link: ?associate=<id> (optionally &name=) opens that associate's
  // focused timesheet — the landing the profile drawer's "Timesheet" button
  // and payroll-exception "Fix" links target. Same consume-once semantics
  // as ?entry= above.
  const associateParam = tabParams.get('associate');
  useEffect(() => {
    if (!associateParam || liveOnly) return;
    const params = new URLSearchParams(tabParams);
    const nameParam = params.get('name');
    params.delete('associate');
    params.delete('name');
    // The ?from/?to effect above consumed these already this commit; drop
    // them here too so this write can't resurrect them from its snapshot.
    params.delete('from');
    params.delete('to');
    params.set('tab', 'queue');
    setTabParams(params, { replace: true });
    // Snapshot-then-force, same as ?entry= — the persisted filter comes
    // back when the focus is cleared.
    focusWithAllFilter({ id: associateParam, name: nameParam ?? '—' });
    // Same rationale as the ?entry= effect for the trimmed dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [associateParam, liveOnly]);

  // A nameless deep link shows '—' until the focused fetch returns a row
  // that carries the display name — then adopt it.
  useEffect(() => {
    if (!focusAssociate || focusAssociate.name !== '—' || !entries) return;
    const match = entries.find(
      (e) => e.associateId === focusAssociate.id && e.associateName,
    );
    if (match) {
      setFocusAssociate({ id: focusAssociate.id, name: match.associateName ?? '—' });
    }
  }, [entries, focusAssociate]);

  // Once the focused timesheet has rendered the target row, bring it into
  // view; the flash ring clears itself after ~2s.
  useEffect(() => {
    if (!flashEntryId || !entries) return;
    document
      .querySelector(`[data-entry-id="${flashEntryId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = window.setTimeout(() => setFlashEntryId(null), 2000);
    return () => window.clearTimeout(t);
  }, [flashEntryId, entries]);

  // Sequence-guarded like the scheduling grid's refresh: filters, dates,
  // and the search debounce all re-fire this, and without the guard a slow
  // earlier response could land LAST and repaint stale rows (plus the wrong
  // truncated flag) over the fresher result.
  const queueReqSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++queueReqSeq.current;
    try {
      setError(null);
      const res = await listAdminTimeEntries({
        ...(filter !== 'ALL' ? { status: filter } : {}),
        from: ymdToIsoStart(fromYmd),
        to: ymdToIsoEndExclusive(toYmd),
        ...(appliedSearch ? { search: appliedSearch } : {}),
        ...(focusAssociate ? { associateId: focusAssociate.id } : {}),
        ...(clientFilter ? { clientId: clientFilter } : {}),
        ...(locationFilter ? { locationId: locationFilter } : {}),
      });
      if (seq !== queueReqSeq.current) return; // newer request in flight
      setEntries(res.entries);
      setTruncated(Boolean(res.truncated));
      // Selection only valid on the COMPLETED filter; clear when refreshing.
      // (clearSelection is a stable callback from useSelection, declared
      // below — safe to call from this closure, deliberately not a dep.)
      clearSelection();
    } catch (err) {
      if (seq !== queueReqSeq.current) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter, fromYmd, toYmd, appliedSearch, focusAssociate, clientFilter, locationFilter]);

  const refreshActive = useCallback(async () => {
    try {
      setError(null);
      const res = await getActiveDashboard({
        ...(clientFilter ? { clientId: clientFilter } : {}),
        ...(locationFilter ? { locationId: locationFilter } : {}),
      });
      setActive(res.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load active dashboard.');
    }
  }, [clientFilter, locationFilter]);

  // Pull down at the top = re-fetch both the live board and the queue.
  const pullState = usePullToRefresh(() => Promise.all([refresh(), refreshActive()]));

  const refreshPendingCount = useCallback(async () => {
    try {
      // Follows the client/site filter so the badge and the queue agree;
      // still all-time — it's the total backlog, not the date window.
      const res = await countAdminTimeEntries('COMPLETED', {
        ...(clientFilter ? { clientId: clientFilter } : {}),
        ...(locationFilter ? { locationId: locationFilter } : {}),
      });
      setPendingCount(res.count);
    } catch {
      // KPI is best-effort; leave previous value.
    }
  }, [clientFilter, locationFilter]);

  // Refresh after an admin create/edit/clock-out — only the visible tab's
  // data plus the pending-review KPI. The other tab refetches on switch.
  const afterMutation = useCallback(async () => {
    await Promise.all([
      tab === 'queue' ? refresh() : refreshActive(),
      refreshPendingCount(),
    ]);
  }, [tab, refresh, refreshActive, refreshPendingCount]);

  // Two effects, one per tab, each depending only on its own tab's inputs.
  // A single combined effect used to re-run refreshActive() whenever a
  // queue-only filter changed `refresh`'s identity while the live tab was
  // open — a pointless dashboard refetch per keystroke/date change.
  useEffect(() => {
    if (tab === 'queue') refresh();
  }, [tab, refresh]);

  useEffect(() => {
    if (tab === 'live') refreshActive();
  }, [tab, refreshActive]);

  // KPI: pending count loads independent of which tab is open.
  useEffect(() => {
    refreshPendingCount();
  }, [refreshPendingCount]);

  // Debounce free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setAppliedSearch(queueSearch.trim()), 300);
    return () => clearTimeout(id);
  }, [queueSearch]);

  // Pay-period options load once per app session (module-level cache — they
  // are static config); on failure the picker simply stays hidden and the
  // manual From/To range keeps working.
  useEffect(() => {
    if (payPeriodsCache) {
      setPayPeriods(payPeriodsCache);
      return;
    }
    listPayPeriods()
      .then((r) => {
        payPeriodsCache = r.periods;
        setPayPeriods(r.periods);
      })
      .catch(() => setPayPeriods([]));
  }, []);

  const onPickPeriod = (key: string) => {
    setPeriodKey(key);
    if (!key) return; // back to custom range — keep current dates
    const p = (payPeriods ?? []).find((x) => `${x.start}|${x.end}` === key);
    if (!p) return;
    setActivePreset(null);
    setFromYmd(p.start);
    setToYmd(p.end);
  };

  const applyPreset = (p: RangePreset) => {
    setActivePreset(p);
    setPeriodKey('');
    const now = new Date();
    if (p === 'LAST14') {
      setFromYmd(defaultFromYmd());
      setToYmd(ymdLocal(now));
      return;
    }
    const thisWeekStart = startOfSaturdayWeek(now);
    if (p === 'THIS_WEEK') {
      setFromYmd(ymdLocal(thisWeekStart));
      setToYmd(ymdLocal(now));
    } else {
      const lastStart = new Date(thisWeekStart);
      lastStart.setDate(lastStart.getDate() - 7);
      const lastEnd = new Date(thisWeekStart);
      lastEnd.setDate(lastEnd.getDate() - 1);
      setFromYmd(ymdLocal(lastStart));
      setToYmd(ymdLocal(lastEnd));
    }
  };

  // Auto-refresh the live tab every 30s while it's open — paused while the
  // browser tab is hidden (mirrors NotificationsBell): no point polling a
  // dashboard nobody can see, and no backlog of throttled fires dumping at
  // once on return. Coming back refetches immediately and restarts the timer.
  useEffect(() => {
    if (tab !== 'live') return;
    let id = window.setInterval(refreshActive, 30_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        window.clearInterval(id);
        refreshActive();
        id = window.setInterval(refreshActive, 30_000);
      } else {
        window.clearInterval(id);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tab, refreshActive]);

  // Ref-mirrored guard so this callback stays identity-stable across
  // pendingId flips — a stable handler is what lets the memoised queue rows
  // skip re-rendering 500 rows on one Approve click.
  const pendingIdRef = useRef<string | null>(null);
  const onApprove = useCallback(
    async (id: string) => {
      if (pendingIdRef.current) return;
      pendingIdRef.current = id;
      setPendingId(id);
      try {
        await approveTimeEntry(id);
        await Promise.all([refresh(), refreshPendingCount()]);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Approve failed.');
      } finally {
        pendingIdRef.current = null;
        setPendingId(null);
      }
    },
    [refresh, refreshPendingCount],
  );

  // Stable id-taking openers for the memoised queue rows.
  const openRejectOne = useCallback(
    (id: string) => setRejectOpen({ mode: 'one', id }),
    [],
  );
  const openDrawer = useCallback((e: TimeEntry) => setDrawerTarget(e), []);

  // Row-level edit — straight to the edit drawer, skipping the detail stop.
  const openEditRow = useCallback((e: TimeEntry) => {
    setEditFromDetail(false);
    setEditTarget(e);
  }, []);

  // FORGOT_CLOCKOUT one-clicker: approve with the clock-out corrected to
  // the scheduled shift end in the same call (TimeApproveInput override).
  const onApproveAtShiftEnd = useCallback(
    async (e: TimeEntry) => {
      if (pendingIdRef.current || !e.shiftEndsAt) return;
      pendingIdRef.current = e.id;
      setPendingId(e.id);
      try {
        await approveTimeEntry(e.id, { clockOutAt: e.shiftEndsAt });
        toast.success(
          `Approved ${e.associateName ?? 'entry'} — clock-out set to the scheduled ${fmtPunchTime(e.shiftEndsAt, e.locationTimezone)}.`,
        );
        await Promise.all([refresh(), refreshPendingCount()]);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Approve failed.');
      } finally {
        pendingIdRef.current = null;
        setPendingId(null);
      }
    },
    [refresh, refreshPendingCount],
  );

  // Live board: one-click clock-out at "now" — the drawer stays available
  // behind the quiet "Adjust…" action for anything needing a typed time.
  const clockOutNow = useCallback(
    async (e: ActiveDashboardEntry) => {
      setLiveClockOutIds((prev) => new Set(prev).add(e.id));
      try {
        await adminEditTimeEntry(e.id, { clockOutAt: new Date().toISOString() });
        toast.success(`Clocked out ${e.associateName}.`);
        await Promise.all([refreshActive(), refreshPendingCount()]);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Clock out failed.');
      } finally {
        setLiveClockOutIds((prev) => {
          const next = new Set(prev);
          next.delete(e.id);
          return next;
        });
      }
    },
    [refreshActive, refreshPendingCount],
  );

  // Group header sweep: clock out everyone still on the clock at a client.
  // allSettled — one refused row (already out, say) must not strand the
  // rest mid-flight.
  const clockOutGroup = useCallback(
    async (rows: ActiveDashboardEntry[]) => {
      if (rows.length === 0) return;
      const nowIso = new Date().toISOString();
      setLiveClockOutIds((prev) => new Set([...prev, ...rows.map((r) => r.id)]));
      try {
        const settled = await Promise.allSettled(
          rows.map((r) => adminEditTimeEntry(r.id, { clockOutAt: nowIso })),
        );
        const ok = settled.filter((s) => s.status === 'fulfilled').length;
        const failedCount = rows.length - ok;
        if (ok > 0) {
          toast.success(`Clocked out ${ok} associate${ok === 1 ? '' : 's'}.`);
        }
        if (failedCount > 0) {
          toast.warning(
            `${failedCount} ${failedCount === 1 ? 'associate' : 'associates'} could not be clocked out.`,
          );
        }
        await Promise.all([refreshActive(), refreshPendingCount()]);
      } finally {
        setLiveClockOutIds((prev) => {
          const next = new Set(prev);
          for (const r of rows) next.delete(r.id);
          return next;
        });
      }
    },
    [refreshActive, refreshPendingCount],
  );

  const onSubmitReject = async (reason: string) => {
    if (!rejectOpen) return;
    if (rejectOpen.mode === 'one') {
      const id = rejectOpen.id;
      const advance = rejectOpen.advanceOnDone === true;
      pendingIdRef.current = id;
      setPendingId(id);
      try {
        await rejectTimeEntry(id, { reason });
        setRejectOpen(null);
        if (advance) {
          // Drawer-originated triage: chain to the next flagged entry
          // (walked off the pre-refresh view, same as the edit path).
          const next = nextFlaggedAfter(id);
          if (next) setDrawerTarget(next);
        }
        await Promise.all([refresh(), refreshPendingCount()]);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Reject failed.');
      } finally {
        pendingIdRef.current = null;
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

  // Standard-break cleanup for NO_BREAK piles: book the picked unpaid meal
  // (15m/30m/1h) on every selected entry. The server skips entries that
  // already have a meal break, are under 6h, or aren't pending review — so
  // a reviewer can sweep-select and let the guardrails sort it out.
  const onBulkApplyBreak = async () => {
    if (selected.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    const lengthLabel = bulkBreakMinutes === 60 ? '1h' : `${bulkBreakMinutes}m`;
    try {
      const res = await bulkApplyBreakTimeEntries(
        Array.from(selected),
        bulkBreakMinutes,
      );
      if (res.succeeded > 0) {
        toast.success(
          `${lengthLabel} meal break applied to ${res.succeeded} ${res.succeeded === 1 ? 'entry' : 'entries'}.`,
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
      // Mirror the queue's filters exactly — a download that quietly ignored
      // the associate/search/anomaly narrowing handed back every associate in
      // the range and read as if it were the filtered list. anomaliesOnly is
      // applied server-side, so the file covers the whole range rather than
      // just the page the screen had fetched.
      await exportTimeEntries(format, {
        from: ymdToIsoStart(fromYmd),
        to: ymdToIsoEndExclusive(toYmd),
        ...(filter !== 'ALL' ? { status: filter } : {}),
        ...(focusAssociate ? { associateId: focusAssociate.id } : {}),
        ...(appliedSearch ? { search: appliedSearch } : {}),
        // client/site were the two filters this list applies that the
        // export dropped — a file scoped to one client silently contained
        // every client's entries (including other clients' worker data).
        ...(clientFilter ? { clientId: clientFilter } : {}),
        ...(locationFilter ? { locationId: locationFilter } : {}),
        ...(anomaliesOnly ? { anomaliesOnly: true } : {}),
        // Same lockstep rule as anomaliesOnly: the shift lens narrows the
        // screen, so the file must narrow too (server re-derives the key).
        ...(shiftFilter ? { shiftWindow: shiftFilter } : {}),
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

  // Live board's shift options track who is on the clock right now.
  const liveShiftOptions = useMemo(() => collectShiftWindows(active), [active]);

  // Same guard as the queue: a window everyone has clocked out of would
  // silently render an empty board — reset to All shifts.
  useEffect(() => {
    if (!active || !liveShiftFilter) return;
    if (!shiftPickStillThere(liveShiftFilter, liveShiftOptions)) {
      setLiveShiftFilter('');
    }
  }, [active, liveShiftFilter, liveShiftOptions]);

  const filteredActive = useMemo(() => {
    if (!active) return null;
    let list = active;
    if (liveShiftFilter) {
      list = list.filter((e) => matchesShiftPick(e, liveShiftFilter));
    }
    // Off-site lens — geofenceOk is already on every live row, so this is
    // pure client-side narrowing (the Off-site KPI tile turns it on).
    if (liveOffSiteOnly) {
      list = list.filter((e) => e.geofenceOk === false);
    }
    // Longest-elapsed first surfaces runaway sessions (a 14h "shift" is a
    // forgotten clock-out, not a worker). Applies inside each client group.
    if (liveSortLongest) {
      list = [...list].sort((a, b) => b.minutesElapsed - a.minutesElapsed);
    }
    const q = liveSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (e) =>
        e.associateName.toLowerCase().includes(q) ||
        (e.clientName ?? '').toLowerCase().includes(q) ||
        (e.jobName ?? '').toLowerCase().includes(q)
    );
  }, [active, liveSearch, liveShiftFilter, liveOffSiteOnly, liveSortLongest]);

  // Group the live board by client when viewing all clients — the one big
  // pile reads as organized places, each with a headcount. A single client
  // (filtered, or naturally) skips the subheaders.
  const liveGroups = useMemo(() => {
    if (!filteredActive) return null;
    const map = new Map<string, ActiveDashboardEntry[]>();
    for (const e of filteredActive) {
      const key = e.clientName ?? 'No client';
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredActive]);
  const showLiveGroups = !clientFilter && (liveGroups?.length ?? 0) > 1;

  // Shift dropdown options come from the loaded page itself — the org's
  // real windows for the picked range/client, not a hardcoded list.
  const shiftOptions = useMemo(() => collectShiftWindows(entries), [entries]);

  // A picked window that vanished from the refreshed page (range/client
  // changed) would silently render an empty queue — reset to All shifts.
  useEffect(() => {
    if (!entries || !shiftFilter) return;
    if (!shiftPickStillThere(shiftFilter, shiftOptions)) setShiftFilter('');
  }, [entries, shiftFilter, shiftOptions]);

  // The flagged slice the anomaly-type chips further narrow: shift lens
  // applied, anomalies present. Counting off this list (not visibleEntries)
  // keeps each chip's count stable while other chips are toggled.
  const flaggedEntries = useMemo(() => {
    if (!entries) return null;
    let list = entries;
    if (shiftFilter) list = list.filter((e) => matchesShiftPick(e, shiftFilter));
    return list.filter((e) => (e.anomalies?.length ?? 0) > 0);
  }, [entries, shiftFilter]);

  // Chip options: only the anomaly TYPES present on screen, with counts,
  // in the label map's stable order (unknown future codes trail behind).
  const anomalyTypeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of flaggedEntries ?? []) {
      for (const a of e.anomalies ?? []) {
        counts.set(a, (counts.get(a) ?? 0) + 1);
      }
    }
    const known = Object.keys(TIME_ANOMALY_LABELS);
    return [...counts.entries()].sort((x, y) => {
      const xi = known.indexOf(x[0]);
      const yi = known.indexOf(y[0]);
      return (xi === -1 ? known.length : xi) - (yi === -1 ? known.length : yi);
    });
  }, [flaggedEntries]);

  // A picked type that vanished from the refreshed page would silently
  // render an empty queue — drop it (same guard as the shift lens).
  useEffect(() => {
    if (!flaggedEntries) return;
    setAnomalyTypes((prev) => {
      const next = prev.filter((t) =>
        flaggedEntries.some((e) => e.anomalies?.includes(t)),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [flaggedEntries]);

  // What the queue actually renders — the shift + anomalies lenses (and
  // the anomaly-type chips inside the latter) apply here so select-all
  // and the empty state follow what's on screen.
  const visibleEntries = useMemo(() => {
    if (!entries) return null;
    let list = entries;
    if (shiftFilter) list = list.filter((e) => matchesShiftPick(e, shiftFilter));
    if (!anomaliesOnly) return list;
    list = list.filter((e) => (e.anomalies?.length ?? 0) > 0);
    if (anomalyTypes.length > 0) {
      // Multiple chips OR together.
      list = list.filter((e) =>
        (e.anomalies ?? []).some((a) => anomalyTypes.includes(a)),
      );
    }
    return list;
  }, [entries, anomaliesOnly, shiftFilter, anomalyTypes]);

  // The triage walk: the next flagged entry still pending review in the
  // CURRENT view (anomaly-type chips honored), starting after `fromId` and
  // wrapping past the end. One implementation shared by the edit drawer's
  // "Save, approve & next" and the detail drawer's "Approve & next" /
  // post-reject advance.
  const nextFlaggedAfter = useCallback(
    (fromId: string): TimeEntry | null => {
      const list = visibleEntries ?? [];
      const idx = list.findIndex((x) => x.id === fromId);
      const ordered =
        idx >= 0 ? [...list.slice(idx + 1), ...list.slice(0, idx)] : list;
      return (
        ordered.find(
          (x) =>
            x.id !== fromId &&
            x.status === 'COMPLETED' &&
            (x.anomalies?.length ?? 0) > 0 &&
            (anomalyTypes.length === 0 ||
              (x.anomalies ?? []).some((a) => anomalyTypes.includes(a))),
        ) ?? null
      );
    },
    [visibleEntries, anomalyTypes],
  );

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

  // "Select clean only" pool — COMPLETED rows with no anomaly flags, so
  // one click stages the uncontroversial approvals without sweeping in
  // flagged rows the way the header select-all does.
  const cleanSelectableIds = useMemo(() => {
    if (!visibleEntries) return [] as string[];
    return visibleEntries
      .filter((e) => e.status === 'COMPLETED' && (e.anomalies?.length ?? 0) === 0)
      .map((e) => e.id);
  }, [visibleEntries]);

  // Shared selection mechanics; selectableIds carries this page's RULE
  // (only COMPLETED rows). toggleMany is the day-header checkbox in the
  // individual timesheet: select/clear a whole day's pending entries in
  // one click.
  const {
    selected,
    toggle: toggleOne,
    setMany: toggleMany,
    selectAll: replaceSelection,
    clear: clearSelection,
    allSelected,
    someSelected,
    toggleAll,
  } = useSelection(selectableIds);

  return (
    <div className="mx-auto">
      <PullToRefreshIndicator state={pullState} />
      <PageHeader
        title="Time & attendance"
        subtitle={
          canManage
            ? 'Review, approve, or reject time entries from associates.'
            : liveOnly
              ? "Live floor view — who's clocked in at your site right now."
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
                onClick={() => navigate('/time-attendance/timesheets')}
              >
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Timesheets
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

      {/* KPI strip — mirrors the onboarding analytics pattern. Tiles are
          shortcuts too: the live trio jumps to the live board (Off-site
          also applies the off-site lens), Pending review opens the queue. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KpiCard
          icon={Activity}
          label="Clocked in"
          value={liveStats.total === null ? '—' : String(liveStats.total)}
          tone="default"
          onClick={() => {
            setLiveOffSiteOnly(false);
            setTab('live');
          }}
        />
        <KpiCard
          icon={Coffee}
          label="On break"
          value={liveStats.onBreak === null ? '—' : String(liveStats.onBreak)}
          tone="warning"
          onClick={() => {
            setLiveOffSiteOnly(false);
            setTab('live');
          }}
        />
        <KpiCard
          icon={MapPinOff}
          label="Off-site"
          value={liveStats.offSite === null ? '—' : String(liveStats.offSite)}
          tone={liveStats.offSite && liveStats.offSite > 0 ? 'alert' : 'silver'}
          onClick={() => {
            setLiveOffSiteOnly(true);
            setTab('live');
          }}
        />
        <KpiCard
          icon={ListChecks}
          label="Pending review"
          value={pendingCount === null ? '—' : String(pendingCount)}
          tone={pendingCount && pendingCount > 0 ? 'warning' : 'success'}
          onClick={liveOnly ? undefined : () => setTab('queue')}
        />
      </div>

      {!liveOnly && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mb-5">
          <TabsList>
            <TabsTrigger value="live">Live (clocked in)</TabsTrigger>
            <TabsTrigger value="queue">Approval queue</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {error && (
        <ErrorBanner className="mb-4">
          <div className="flex items-start gap-2">
            <span className="flex-1">{error}</span>
            {/* -my keeps the icon-sm hit target from inflating the banner. */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setError(null)}
              className="-my-1.5 text-alert/60 hover:text-alert"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </ErrorBanner>
      )}

      {tab === 'live' && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Currently clocked in</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <ClientSiteSelects
                boundedClient={boundedClient}
                clients={clients}
                clientFilter={clientFilter}
                onClientChange={changeClientFilter}
                locationFilter={locationFilter}
                onLocationChange={setLocationFilter}
                locationOptions={locationOptions}
              />
              <ShiftWindowSelect
                id="live-shift-window-picker"
                value={liveShiftFilter}
                onChange={setLiveShiftFilter}
                options={liveShiftOptions}
                aria-label="Shift"
              />
              <button
                type="button"
                aria-pressed={liveOffSiteOnly}
                onClick={() => setLiveOffSiteOnly((v) => !v)}
                className={cn(
                  'h-9 rounded-md border px-3 text-sm transition-colors',
                  liveOffSiteOnly
                    ? 'border-alert/60 bg-alert/15 text-alert'
                    : 'border-navy-secondary bg-navy-secondary/40 text-silver hover:text-white',
                )}
              >
                <MapPinOff className="mr-1 inline h-3.5 w-3.5" /> Off-site only
              </button>
              <FilterChip
                active={liveSortLongest}
                title="Sort by elapsed time, longest first — runaway sessions rise to the top"
                onClick={() => setLiveSortLongest((v) => !v)}
                className="h-9"
              >
                Longest first
              </FilterChip>
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-silver/70 pointer-events-none" />
                <Input
                  placeholder="Search associate, client, job…"
                  aria-label="Search the live board by associate, client, or job"
                  value={liveSearch}
                  onChange={(e) => setLiveSearch(e.target.value)}
                  className="pl-8 h-9 text-sm"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {!active && !error && <SkeletonRows count={5} rowHeight="h-12" />}
            {active && active.length === 0 && (
              <EmptyState
                title="No one is clocked in"
                description="Active sessions will appear here in real time."
              />
            )}
            {active && active.length > 0 && filteredActive && (
              <>
                {/* md+ : full columnar table. Only the breakpoint-active
                    list mounts (useIsDesktop) — the hidden twin used to
                    double the DOM for nothing. */}
                {isDesktop && (
                <div>
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
                      {(liveGroups ?? []).map(([groupName, groupRows]) => (
                        <Fragment key={groupName}>
                          {showLiveGroups && (
                            <TableRow className="bg-navy-secondary/20 hover:bg-navy-secondary/20">
                              <TableCell
                                colSpan={canManage ? 8 : 7}
                                className="py-1.5 text-xs font-medium text-silver"
                              >
                                <div className="flex items-center gap-2">
                                  <span>
                                    {groupName}
                                    <span className="ml-2 tabular-nums text-silver/60">
                                      {groupRows.length} clocked in
                                    </span>
                                  </span>
                                  {canManage && (
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      className="ml-auto text-silver/70 hover:text-white"
                                      onClick={() => clockOutGroup(groupRows)}
                                      disabled={groupRows.some((r) =>
                                        liveClockOutIds.has(r.id),
                                      )}
                                      title="Clock everyone in this group out at the current time"
                                    >
                                      Clock out all ({groupRows.length})
                                    </Button>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                          {groupRows.map((e) => (
                        <TableRow key={e.id} className="group">
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2.5">
                              <Avatar name={e.associateName} size="sm" />
                              <AssociateLink associateId={e.associateId}>
                                {e.associateName}
                              </AssociateLink>
                            </div>
                          </TableCell>
                          <TableCell className="text-silver">{e.clientName ?? '—'}</TableCell>
                          <TableCell className="text-silver">{e.jobName ?? '—'}</TableCell>
                          <TableCell className="tabular-nums text-silver">
                            {fmtPunchTime(e.clockInAt, e.locationTimezone)}
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
                            <TableCell className="text-right whitespace-nowrap">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => clockOutNow(e)}
                                loading={liveClockOutIds.has(e.id)}
                                disabled={liveClockOutIds.has(e.id)}
                              >
                                Clock out now
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="ml-1 text-silver/70 hover:text-white"
                                onClick={() => setEditTarget(liveEntryToTimeEntry(e))}
                                disabled={liveClockOutIds.has(e.id)}
                                title="Open the edit drawer to type an exact clock-out time"
                              >
                                Adjust…
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                          ))}
                        </Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                )}

                {/* Phone: card stack. Manager scans for "who's on shift" /
                    "is anyone off-site"; the elapsed counter and break
                    state are the load-bearing bits. */}
                {!isDesktop && (
                <ul className="space-y-2">
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
                            <div className="text-xs2 text-silver/70 truncate">
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
                            <Badge variant="destructive" className="text-2xs">
                              Off-site
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex items-end justify-between gap-3 text-xs2 text-silver">
                        <span className="tabular-nums">
                          Since {fmtPunchTime(e.clockInAt, e.locationTimezone)}
                        </span>
                        <span className="tabular-nums text-white">
                          {formatHM(e.minutesElapsed)}
                        </span>
                      </div>
                      {canManage && (
                        <div className="mt-2 flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-silver/70 hover:text-white"
                            onClick={() => setEditTarget(liveEntryToTimeEntry(e))}
                            disabled={liveClockOutIds.has(e.id)}
                          >
                            Adjust…
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => clockOutNow(e)}
                            loading={liveClockOutIds.has(e.id)}
                            disabled={liveClockOutIds.has(e.id)}
                          >
                            Clock out now
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                )}
                {filteredActive.length === 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-silver">
                    {/* Name the filter that actually emptied the board —
                        blaming an empty search box for the shift filter's
                        work read as a bug. */}
                    <span>
                      {liveSearch.trim()
                        ? `No matches for "${liveSearch.trim()}".`
                        : liveShiftFilter
                          ? 'No one on the clock in that shift window.'
                          : 'No one is clocked in.'}
                    </span>
                    {liveShiftFilter && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setLiveShiftFilter('')}
                      >
                        Show all shifts
                      </Button>
                    )}
                  </div>
                )}
                <div className="mt-3 text-2xs uppercase tracking-widest text-silver/70">
                  Auto-refreshes every 30s
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Focused on one person → their attendance record sits above the
          timesheet, where late/no-show patterns explain what's below. */}
      {tab === 'queue' && focusAssociate && (
        <div className="mb-4">
          <AttendanceCard associateId={focusAssociate.id} canManage={canManage} />
        </div>
      )}
      {tab === 'queue' && (
        <Card>
          <CardHeader className="pb-3 gap-3">
            {focusAssociate && (
              <FocusBanner
                name={focusAssociate.name}
                entries={entries}
                onClear={clearFocus}
              />
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">
                {focusAssociate ? `${focusAssociate.name} — timesheet` : 'Time entries'}
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                {STATUS_FILTERS.map((f) => (
                  <FilterChip
                    key={f.value}
                    active={filter === f.value}
                    onClick={() => setFilter(f.value)}
                  >
                    {f.label}
                  </FilterChip>
                ))}
              </div>
            </div>

            {/* Checkboxes + the bulk bar only exist on the Completed filter.
                A reviewer parked on ALL sees neither — say why, with a
                one-click way over, instead of leaving them hunting. */}
            {canManage && filter !== 'COMPLETED' && selectableIds.length > 0 && (
              <p className="text-xs text-silver/70">
                Bulk actions live on the Completed filter —{' '}
                <Button
                  variant="link"
                  onClick={() => setFilter('COMPLETED')}
                  className="text-xs font-normal text-gold underline hover:text-gold-bright"
                >
                  Switch
                </Button>
              </p>
            )}

            {/* Phase 65 — date range + free-text search + export buttons. */}
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-2xs uppercase tracking-wider text-silver mb-1">
                  Client / site
                </label>
                <div className="flex items-center gap-2">
                  <ClientSiteSelects
                    boundedClient={boundedClient}
                    clients={clients}
                    clientFilter={clientFilter}
                    onClientChange={changeClientFilter}
                    locationFilter={locationFilter}
                    onLocationChange={setLocationFilter}
                    locationOptions={locationOptions}
                  />
                </div>
              </div>
              <div>
                <label
                  htmlFor="shift-window-picker"
                  className="block text-2xs uppercase tracking-wider text-silver mb-1"
                >
                  Shift
                </label>
                <div
                  title={
                    truncated
                      ? 'Options come from the first 500 loaded entries — narrow the date range to see every window. Exports apply the pick across the whole range.'
                      : undefined
                  }
                >
                  <ShiftWindowSelect
                    id="shift-window-picker"
                    value={shiftFilter}
                    onChange={setShiftFilter}
                    options={shiftOptions}
                  />
                </div>
              </div>
              {payPeriods !== null && payPeriods.length > 0 && (
                <div>
                  <label
                    htmlFor="pay-period-picker"
                    className="block text-2xs uppercase tracking-wider text-silver mb-1"
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
              <div>
                <span className="block text-2xs uppercase tracking-wider text-silver mb-1">
                  Range
                </span>
                <div
                  className="flex h-9 items-center gap-1.5"
                  role="group"
                  aria-label="Quick date range"
                >
                  {RANGE_PRESETS.map(([preset, label]) => {
                    const isActive = activePreset === preset;
                    return (
                      <Button
                        key={preset}
                        size="xs"
                        variant="outline"
                        aria-pressed={isActive}
                        onClick={() => applyPreset(preset)}
                        className={cn(
                          isActive &&
                            'border-gold text-gold bg-gold/10 hover:border-gold hover:text-gold',
                        )}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div>
                  <label className="block text-2xs uppercase tracking-wider text-silver mb-1">
                    From
                  </label>
                  <Input
                    type="date"
                    value={fromYmd}
                    max={toYmd}
                    onChange={(e) => {
                      setPeriodKey('');
                      setActivePreset(null);
                      setFromYmd(e.target.value || defaultFromYmd());
                    }}
                    className="h-9 text-sm w-40"
                  />
                </div>
                <div>
                  <label className="block text-2xs uppercase tracking-wider text-silver mb-1">
                    To
                  </label>
                  <Input
                    type="date"
                    value={toYmd}
                    min={fromYmd}
                    onChange={(e) => {
                      setPeriodKey('');
                      setActivePreset(null);
                      setToYmd(e.target.value || defaultToYmd());
                    }}
                    className="h-9 text-sm w-40"
                  />
                </div>
              </div>

              {/* Pick a person directly instead of having to find one of their
                  rows and click it. Scopes the queue AND the download. */}
              <div className="w-full sm:w-56">
                <label className="block text-2xs uppercase tracking-wider text-silver mb-1">
                  Associate
                </label>
                <AssociatePicker
                  value={focusAssociate}
                  // Picking keeps the current filter (only name-clicks and
                  // deep links force ALL); clearing restores any snapshot.
                  onChange={(v) => (v ? setFocusAssociate(v) : clearFocus())}
                  placeholder="All associates…"
                  className="h-9 text-sm"
                />
              </div>

              <div className="relative flex-1 w-full sm:min-w-[200px]">
                <label className="block text-2xs uppercase tracking-wider text-silver mb-1">
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
                onClick={() => {
                  // Turning the lens off retires its type chips too.
                  if (anomaliesOnly) setAnomalyTypes([]);
                  setAnomaliesOnly(!anomaliesOnly);
                }}
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
                  {/* HR Administrator only — export:payroll-pii. Hidden rather
                      than disabled for everyone else: a greyed-out "External
                      payroll" button just advertises that the SSN + bank
                      export exists to roles who can't and shouldn't use it. */}
                  {canExportPayrollPii && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setExternalOpen(true)}
                      disabled={exportBusy !== null}
                      className="border-warning/50 text-warning hover:text-warning"
                    >
                      <ShieldAlert className="h-4 w-4" />
                      External payroll
                    </Button>
                  )}
                  {canProcessPayroll && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setRecordPeriodOpen(true)}
                      disabled={exportBusy !== null}
                      title="Document the whole pay run: one row per paid associate, prefilled from approved time, recorded in a single click."
                    >
                      <FileSpreadsheet className="h-4 w-4" />
                      Record pay period
                    </Button>
                  )}
                </div>
              )}

            </div>

            {/* Anomaly-TYPE chips — only while the anomalies lens is on.
                Chip styling matches AnomalyChips; multiple picks OR. */}
            {anomaliesOnly && anomalyTypeOptions.length > 0 && (
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Anomaly type"
              >
                {anomalyTypeOptions.map(([type, count]) => {
                  const isActive = anomalyTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() =>
                        setAnomalyTypes((prev) =>
                          isActive
                            ? prev.filter((t) => t !== type)
                            : [...prev, type],
                        )
                      }
                      className={cn(
                        'text-2xs uppercase tracking-widest px-1.5 py-0.5 rounded border whitespace-nowrap transition-colors',
                        isActive
                          ? 'border-warning bg-warning/25 text-warning'
                          : 'border-warning/40 bg-warning/10 text-warning/70 hover:text-warning',
                      )}
                    >
                      {timeAnomalyLabel(type)} ({count})
                    </button>
                  );
                })}
                {anomalyTypes.length > 0 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setAnomalyTypes([])}
                    className="text-silver/70 hover:text-white"
                  >
                    Clear types
                  </Button>
                )}
              </div>
            )}
          </CardHeader>

          {/* Bulk-action toolbar — shown when rows are selected, or quietly
              when clean rows are available to stage with one click. */}
          {canManage &&
            filter === 'COMPLETED' &&
            (selected.size > 0 || cleanSelectableIds.length > 0) && (
            <div
              className={cn(
                'mx-5 mb-3 flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-md border',
                selected.size > 0
                  ? 'border-gold/40 bg-gold/10'
                  : 'border-navy-secondary bg-navy-secondary/30',
              )}
            >
              <div
                className={cn(
                  'text-sm',
                  selected.size > 0 ? 'text-gold' : 'text-silver',
                )}
              >
                <span className="font-medium tabular-nums">{selected.size}</span>{' '}
                selected
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {cleanSelectableIds.length > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => replaceSelection(cleanSelectableIds)}
                    disabled={bulkBusy}
                    title="Select only completed entries with no anomaly flags (replaces the current selection)"
                  >
                    Select clean ({cleanSelectableIds.length})
                  </Button>
                )}
                {selected.size > 0 && (
                  <>
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
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={onBulkApplyBreak}
                        disabled={bulkBusy}
                        title="Book the standard unpaid meal break of the picked length, centered mid-shift, on each selected entry that has none (6h+ shifts only)"
                      >
                        <Coffee className="h-4 w-4" />
                        Apply {bulkBreakMinutes === 60 ? '1h' : `${bulkBreakMinutes}m`}{' '}
                        break
                      </Button>
                      <Select
                        aria-label="Break length"
                        value={String(bulkBreakMinutes)}
                        onChange={(e) =>
                          setBulkBreakMinutes(
                            Number(e.target.value) as 15 | 30 | 60,
                          )
                        }
                        disabled={bulkBusy}
                        className="h-8 w-auto text-sm"
                      >
                        <option value="15">15 min</option>
                        <option value="30">30 min</option>
                        <option value="60">1 h</option>
                      </Select>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={clearSelection}
                      disabled={bulkBusy}
                    >
                      Clear
                    </Button>
                  </>
                )}
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
            {!visibleEntries && !error && <SkeletonRows count={6} rowHeight="h-12" />}
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
            {/* One associate in focus → a real timesheet: day groups inside
                week sections with subtotals, instead of the flat triage
                table where two same-day clock-ins read as a data error. */}
            {visibleEntries && visibleEntries.length > 0 && focusAssociate && (
              <FocusTimesheet
                entries={visibleEntries}
                canManage={canManage}
                showSelect={canManage && filter === 'COMPLETED'}
                selected={selected}
                pendingId={pendingId}
                bulkBusy={bulkBusy}
                flashId={flashEntryId}
                onToggleSelect={toggleOne}
                onToggleMany={toggleMany}
                onOpen={openDrawer}
                onApprove={onApprove}
                onReject={openRejectOne}
              />
            )}
            {visibleEntries && visibleEntries.length > 0 && !focusAssociate && (
              <>
                {/* md+ : full sortable table. Only the breakpoint-active
                    list mounts (useIsDesktop). */}
                {isDesktop && (
                <div>
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
                      {sortedEntries.map((e) => (
                        <QueueEntryRow
                          key={e.id}
                          entry={e}
                          canManage={canManage}
                          showSelect={canManage && filter === 'COMPLETED'}
                          isSelected={selected.has(e.id)}
                          isPending={pendingId === e.id}
                          bulkBusy={bulkBusy}
                          onToggleSelect={toggleOne}
                          onFocus={focusOn}
                          onOpen={openDrawer}
                          onApprove={onApprove}
                          onReject={openRejectOne}
                          onEdit={openEditRow}
                          onApproveAtShiftEnd={onApproveAtShiftEnd}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
                )}

                {/* Phone: card stack. Approve/Reject are inline on each
                    card instead of hover-revealed; the row is also tap-to-
                    open the detail drawer (managers reach the audit trail
                    + edits there). Selection checkbox top-left when
                    bulk-eligible. */}
                {!isDesktop && (
                <ul className="space-y-2">
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
                            className="w-full text-left p-3 active:bg-navy-secondary/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-md"
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
                                    {STATUS_LABELS[e.status]}
                                  </Badge>
                                </div>
                                <div className="text-xs2 text-silver/70 truncate">
                                  {e.clientName ?? '—'}
                                </div>
                                <div className="mt-1.5 flex items-end justify-between gap-3 text-xs2 text-silver">
                                  <span className="tabular-nums">
                                    {fmtPunchDateTime(e.clockInAt, e.locationTimezone)}
                                    {e.clockOutAt ? (
                                      <>
                                        {` → ${fmtPunchTime(e.clockOutAt, e.locationTimezone)}`}
                                        <DayOffsetTag entry={e} />
                                      </>
                                    ) : (
                                      ' → —'
                                    )}
                                  </span>
                                  <span className="tabular-nums text-white">
                                    {formatHM(e.netMinutes ?? e.minutesElapsed)}
                                  </span>
                                </div>
                                {(() => {
                                  const breakMin = Math.max(
                                    0,
                                    e.minutesElapsed - (e.netMinutes ?? e.minutesElapsed),
                                  );
                                  if (breakMin === 0) return null;
                                  const n = e.breaks?.length ?? 1;
                                  return (
                                    <div className="text-2xs text-silver/70 tabular-nums">
                                      {formatHM(e.minutesElapsed)} on site ·{' '}
                                      {n > 1 ? `${n} breaks` : '1 break'} ({formatHM(breakMin)})
                                    </div>
                                  );
                                })()}
                                <div className="mt-1 empty:hidden">
                                  <LateChip entry={e} />
                                </div>
                                <AnomalyChips anomalies={e.anomalies} />
                                {e.rejectionReason && (
                                  <div className="text-alert text-2xs mt-1">
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
                                className="flex flex-wrap gap-2 px-3 pb-3 pt-0"
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
                                {(e.status === 'COMPLETED' || e.status === 'REJECTED') &&
                                  !!e.shiftEndsAt &&
                                  (e.anomalies ?? []).includes('FORGOT_CLOCKOUT') && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => onApproveAtShiftEnd(e)}
                                      loading={pendingId === e.id}
                                      disabled={pendingId === e.id || bulkBusy}
                                      title="Approve with the clock-out corrected to the scheduled shift end"
                                    >
                                      Approve at sched. end{' '}
                                      {fmtPunchTime(e.shiftEndsAt, e.locationTimezone)}
                                    </Button>
                                  )}
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={`Edit entry for ${e.associateName ?? 'associate'}`}
                                  title="Edit times"
                                  onClick={() => openEditRow(e)}
                                  disabled={pendingId === e.id || bulkBusy}
                                >
                                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                </Button>
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
                )}
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
            // Triage chain — offered only while another flagged entry is
            // waiting in the current view. Approves in place and advances
            // the drawer instead of dumping the reviewer to the list; a
            // failed approve keeps this drawer open.
            onApproveNext={
              tab === 'queue' && nextFlaggedAfter(drawerTarget.id)
                ? async () => {
                    if (pendingIdRef.current) return;
                    const id = drawerTarget.id;
                    pendingIdRef.current = id;
                    setPendingId(id);
                    try {
                      await approveTimeEntry(id);
                      const next = nextFlaggedAfter(id);
                      if (next) {
                        setDrawerTarget(next);
                      } else {
                        setDrawerTarget(null);
                        toast.success(
                          'All caught up — no more flagged entries in view.',
                        );
                      }
                      await Promise.all([refresh(), refreshPendingCount()]);
                    } catch (err) {
                      setError(
                        err instanceof ApiError ? err.message : 'Approve failed.',
                      );
                    } finally {
                      pendingIdRef.current = null;
                      setPendingId(null);
                    }
                  }
                : undefined
            }
            onReject={() => {
              // advanceOnDone only when the triage chain has somewhere to
              // go — a lone reject keeps today's close-to-list behavior.
              setRejectOpen({
                mode: 'one',
                id: drawerTarget.id,
                advanceOnDone:
                  tab === 'queue' && nextFlaggedAfter(drawerTarget.id) !== null,
              });
              setDrawerTarget(null);
            }}
            onEdit={() => {
              setEditFromDetail(true);
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
        defaultClientId={clientFilter}
        defaultLocationId={locationFilter}
      />

      <PayrollSheetDialog
        open={payrollOpen}
        onOpenChange={setPayrollOpen}
        defaultFromYmd={fromYmd}
        defaultToYmd={toYmd}
        defaultClientId={clientFilter}
      />

      {canExportPayrollPii && (
        <ExternalPayrollSheetDialog
          open={externalOpen}
          onOpenChange={setExternalOpen}
          defaultFromYmd={fromYmd}
          defaultToYmd={toYmd}
          defaultClientId={clientFilter}
        />
      )}

      {canProcessPayroll && (
        <RecordPayPeriodDialog
          open={recordPeriodOpen}
          onOpenChange={setRecordPeriodOpen}
          defaultFromYmd={fromYmd}
          defaultToYmd={toYmd}
        />
      )}

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
          // Keyed so "Save, approve & next" remounts the drawer on the next
          // entry (its fields initialize from `entry` once, on mount).
          key={editTarget.id}
          mode="edit"
          entry={editTarget}
          showApproveNext={tab === 'queue'}
          onClose={() => {
            setEditTarget(null);
            setEditFromDetail(false);
          }}
          onSaved={async (updated, advanceNext) => {
            const savedId = editTarget.id;
            setEditTarget(null);
            if (advanceNext) {
              // Triage loop: jump straight to the next flagged entry still
              // pending review in the CURRENT view (shared walk — same
              // rules as the detail drawer's Approve & next).
              setEditFromDetail(false);
              const next = nextFlaggedAfter(savedId);
              if (next) {
                setEditTarget(next);
              } else {
                toast.success('All caught up — no more flagged entries in view.');
              }
            } else if (editFromDetail && updated) {
              // Back to the detail drawer the reviewer came from, showing
              // the saved (and possibly approved) entry — not the list.
              setDrawerTarget(updated);
              setEditFromDetail(false);
            } else {
              setEditFromDetail(false);
            }
            await afterMutation();
          }}
        />
      )}
    </div>
  );
}

// One desktop queue row, memoised on the entry object + the few bits of
// parent state that actually concern it (selection, its own pending flag,
// bulk busy). With stable id-taking handlers, approving one entry no longer
// re-renders the other ~499 rows.
/* ---- Individual timesheet (focus mode) --------------------------------- *
 * The flat queue table is built for triage across MANY associates; for ONE
 * associate it reads as a wall of undifferentiated rows. Focus mode renders
 * the shared TimesheetWeeks shell (week/day grouping, subtotals, gap and
 * overlap notes) with admin rows: selection, Approve/Reject, drawer open.  */

function FocusTimesheet({
  entries,
  canManage,
  showSelect,
  selected,
  pendingId,
  bulkBusy,
  flashId,
  onToggleSelect,
  onToggleMany,
  onOpen,
  onApprove,
  onReject,
}: {
  entries: TimeEntry[];
  canManage: boolean;
  showSelect: boolean;
  selected: ReadonlySet<string>;
  pendingId: string | null;
  bulkBusy: boolean;
  flashId: string | null;
  onToggleSelect: (id: string) => void;
  onToggleMany: (ids: string[], select: boolean) => void;
  onOpen: (entry: TimeEntry) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <TimesheetWeeks
      entries={entries}
      dayHeaderExtra={(day) => {
        const selectableIds = day.entries
          .filter((e) => e.status === 'COMPLETED')
          .map((e) => e.id);
        if (!showSelect || selectableIds.length === 0) return null;
        const allDaySelected = selectableIds.every((id) => selected.has(id));
        return (
          <input
            type="checkbox"
            aria-label={`Select all entries on ${day.key}`}
            checked={allDaySelected}
            onChange={() => onToggleMany(selectableIds, !allDaySelected)}
            className="h-4 w-4 rounded border-navy-secondary bg-navy-secondary/40 text-gold focus:ring-gold"
          />
        );
      }}
      renderEntry={(e) => (
        <FocusEntryRow
          entry={e}
          canManage={canManage}
          showSelect={showSelect}
          isSelected={selected.has(e.id)}
          isPending={pendingId === e.id}
          bulkBusy={bulkBusy}
          isFlashed={flashId === e.id}
          onToggleSelect={onToggleSelect}
          onOpen={onOpen}
          onApprove={onApprove}
          onReject={onReject}
        />
      )}
    />
  );
}

function FocusEntryRow({
  entry: e,
  canManage,
  showSelect,
  isSelected,
  isPending,
  bulkBusy,
  isFlashed,
  onToggleSelect,
  onOpen,
  onApprove,
  onReject,
}: {
  entry: TimeEntry;
  canManage: boolean;
  showSelect: boolean;
  isSelected: boolean;
  isPending: boolean;
  bulkBusy: boolean;
  isFlashed: boolean;
  onToggleSelect: (id: string) => void;
  onOpen: (entry: TimeEntry) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const isSelectable = showSelect && e.status === 'COMPLETED';
  const net = e.netMinutes ?? e.minutesElapsed;
  const breakMin = Math.max(0, e.minutesElapsed - net);
  const breakCount = e.breaks?.length ?? (breakMin > 0 ? 1 : 0);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(ev) => {
        const target = ev.target as HTMLElement;
        if (target.closest('button, a, input, [data-no-row-click]')) return;
        if (window.getSelection()?.toString()) return;
        onOpen(e);
      }}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onOpen(e);
        }
      }}
      data-entry-id={e.id}
      className={cn(
        'group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 cursor-pointer transition-colors hover:bg-navy-secondary/30 active:bg-navy-secondary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        isSelected && 'bg-gold/5',
        // Deep-link landing flash (~2s) — see flashEntryId in AdminTimeView.
        isFlashed && 'ring-2 ring-inset ring-gold bg-gold/10',
      )}
    >
      {showSelect && (
        <span className="w-4 flex-none" data-no-row-click>
          {isSelectable && (
            <input
              type="checkbox"
              aria-label={`Select entry starting ${fmtPunchTime(e.clockInAt, e.locationTimezone)}`}
              checked={isSelected}
              onChange={() => onToggleSelect(e.id)}
              className="h-4 w-4 rounded border-navy-secondary bg-navy-secondary/40 text-gold focus:ring-gold"
            />
          )}
        </span>
      )}
      <span className="tabular-nums text-sm text-white">
        {fmtPunchTime(e.clockInAt, e.locationTimezone)}
        {' → '}
        {e.clockOutAt ? (
          <>
            {fmtPunchTime(e.clockOutAt, e.locationTimezone)}
            <DayOffsetTag entry={e} />
          </>
        ) : (
          <span className="text-silver">on the clock</span>
        )}
      </span>
      {breakMin > 0 && (
        <span className="text-2xs tabular-nums text-silver/70 whitespace-nowrap">
          {breakCount > 1 ? `${breakCount} breaks` : '1 break'} ({formatHM(breakMin)})
        </span>
      )}
      {e.jobName && (
        <span className="text-2xs text-silver/70 truncate max-w-[10rem]">{e.jobName}</span>
      )}
      <span className="ml-auto flex items-center gap-2">
        <span className="tabular-nums text-sm font-medium text-white">
          {formatHM(net)}
        </span>
        <Badge size="sm" variant={statusVariant(e.status)}>
          {STATUS_LABELS[e.status]}
        </Badge>
        {canManage && (
          <span className="inline-flex items-center gap-1 can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            {(e.status === 'COMPLETED' || e.status === 'REJECTED') && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onApprove(e.id)}
                loading={isPending}
                disabled={isPending || bulkBusy}
              >
                Approve
              </Button>
            )}
            {(e.status === 'COMPLETED' || e.status === 'APPROVED') && (
              <Button
                size="sm"
                variant="ghost"
                className="text-alert hover:text-alert hover:bg-alert/10"
                onClick={() => onReject(e.id)}
                disabled={isPending || bulkBusy}
              >
                Reject
              </Button>
            )}
          </span>
        )}
      </span>
      <div className="w-full empty:hidden">
        <AnomalyChips anomalies={e.anomalies} />
        {e.rejectionReason && (
          <div className="text-alert text-2xs mt-1">{e.rejectionReason}</div>
        )}
      </div>
    </div>
  );
}

const QueueEntryRow = memo(function QueueEntryRow({
  entry: e,
  canManage,
  showSelect,
  isSelected,
  isPending,
  bulkBusy,
  onToggleSelect,
  onFocus,
  onOpen,
  onApprove,
  onReject,
  onEdit,
  onApproveAtShiftEnd,
}: {
  entry: TimeEntry;
  canManage: boolean;
  showSelect: boolean;
  isSelected: boolean;
  isPending: boolean;
  bulkBusy: boolean;
  onToggleSelect: (id: string) => void;
  onFocus: (entry: TimeEntry) => void;
  onOpen: (entry: TimeEntry) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onEdit: (entry: TimeEntry) => void;
  onApproveAtShiftEnd: (entry: TimeEntry) => void;
}) {
  const isSelectable = showSelect && e.status === 'COMPLETED';
  // FORGOT_CLOCKOUT + a scheduled end on a non-ACTIVE, approvable row →
  // offer the one-click "approve at the scheduled end" correction.
  const canApproveAtShiftEnd =
    canManage &&
    (e.status === 'COMPLETED' || e.status === 'REJECTED') &&
    !!e.shiftEndsAt &&
    (e.anomalies ?? []).includes('FORGOT_CLOCKOUT');
  return (
    <TableRow
      className="group cursor-pointer"
      data-state={isSelected ? 'selected' : undefined}
      onClick={(ev) => {
        const target = ev.target as HTMLElement;
        if (target.closest('button, a, input, [data-no-row-click]')) return;
        if (window.getSelection()?.toString()) return;
        onOpen(e);
      }}
    >
      {showSelect && (
        <TableCell className="w-8">
          {isSelectable && (
            <input
              type="checkbox"
              aria-label={`Select entry for ${e.associateName ?? 'associate'}`}
              checked={isSelected}
              onChange={() => onToggleSelect(e.id)}
              className="h-4 w-4 rounded border-navy-secondary bg-navy-secondary/40 text-gold focus:ring-gold"
            />
          )}
        </TableCell>
      )}
      <TableCell className="font-medium">
        <button
          type="button"
          onClick={() => onFocus(e)}
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
        {fmtPunchDateTime(e.clockInAt, e.locationTimezone)}
      </TableCell>
      <TableCell className="tabular-nums">
        {e.clockOutAt ? (
          <>
            {fmtPunchTime(e.clockOutAt, e.locationTimezone)}
            <DayOffsetTag entry={e} />
          </>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell>
        <DurationCell entry={e} />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge variant={statusVariant(e.status)}>{STATUS_LABELS[e.status]}</Badge>
          <LateChip entry={e} />
        </div>
        <AnomalyChips anomalies={e.anomalies} />
        {e.rejectionReason && (
          <div className="text-alert text-2xs mt-1">
            {e.rejectionReason}
          </div>
        )}
      </TableCell>
      {canManage && (
        <TableCell className="text-right whitespace-nowrap">
          <div className="can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity inline-flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit entry for ${e.associateName ?? 'associate'}`}
              title="Edit times"
              onClick={() => onEdit(e)}
              disabled={isPending || bulkBusy}
              className="opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            {canApproveAtShiftEnd && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onApproveAtShiftEnd(e)}
                loading={isPending}
                disabled={isPending || bulkBusy}
                title="Approve with the clock-out corrected to the scheduled shift end"
              >
                Approve at sched. end{' '}
                {fmtPunchTime(e.shiftEndsAt!, e.locationTimezone)}
              </Button>
            )}
            {(e.status === 'COMPLETED' || e.status === 'REJECTED') && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onApprove(e.id)}
                loading={isPending}
                disabled={isPending || bulkBusy}
              >
                Approve
              </Button>
            )}
            {(e.status === 'COMPLETED' || e.status === 'APPROVED') && (
              <Button
                size="sm"
                variant="ghost"
                className="text-alert hover:text-alert hover:bg-alert/10"
                onClick={() => onReject(e.id)}
                disabled={isPending || bulkBusy}
              >
                Reject
              </Button>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
});

function TimeEntryDetailPanel({
  entry,
  canManage,
  busy,
  onApprove,
  onApproveNext,
  onReject,
  onEdit,
}: {
  entry: TimeEntry;
  canManage: boolean;
  busy: boolean;
  onApprove: () => void;
  /** Triage chain: approve this entry and advance the drawer to the next
   *  flagged pending entry in view. Absent when there is nowhere to go. */
  onApproveNext?: () => void;
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
          <RouterLink
            to={`/people?associateId=${entry.associateId}`}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gold hover:underline"
          >
            View profile
            <ExternalLink className="h-3 w-3" />
          </RouterLink>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Badge variant={statusVariant(entry.status)}>{STATUS_LABELS[entry.status]}</Badge>
          {entry.anomalies && entry.anomalies.length > 0 && (
            <Badge variant="destructive">
              {entry.anomalies.length} anomal{entry.anomalies.length === 1 ? 'y' : 'ies'}
            </Badge>
          )}
        </div>

        {/* The shift as it happened — bar, punch sequence, totals in one
            card. Replaces the old scattered layout (clock-in top-left,
            clock-out top-right, breaks in a separate box below the pay
            rate) that reviewers had to reassemble mentally. */}
        <div className="mb-5">
          <ShiftTimeline entry={entry} />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm mb-5">
          <DetailRow label="Pay rate">
            {entry.payRate != null
              ? fmtPayRate(entry.payRate, 'HOURLY')
              : <span className="text-silver/80">—</span>}
          </DetailRow>
          {entry.shiftStartsAt && (
            <DetailRow label="Scheduled shift">
              <span className="tabular-nums">
                {fmtDateTime(entry.shiftStartsAt)}
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

        {entry.anomalies && entry.anomalies.length > 0 && (
          <div className="mb-5 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm">
            <div className="text-2xs uppercase tracking-widest text-warning mb-1.5">
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
          {showApprove && onApproveNext && (
            <Button
              onClick={onApproveNext}
              loading={busy}
              disabled={busy}
              title="Approve this entry and open the next flagged entry in view"
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Approve &amp; next
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

// The drawer edits ONE calendar date plus separate wall-clock times, so the
// admin never types the same date twice. The wall-clock helpers
// (dateOfWall/timeOfWall/combineWall/wallDayDiff) live INSIDE
// TimeEntryFormDrawer — they close over the entry's site zone. The old
// module-level browser-local copies are gone: they were the bug (a CT
// admin typing "9:00" for an ET entry stored 9:00 CT).

// Decimal hours, matching formatHM and the payroll convention.
function fmtDurMin(min: number): string {
  return `${(min / 60).toFixed(2)}h`;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-xs2 uppercase tracking-widest text-silver">
      {children}
    </div>
  );
}

// Associate typeahead → resolves to an associate id. Sourced from the
// scheduling roster (listSchedulingAssociates), which the server clamps to
// the viewer's scope — a client-bound SHIFT_SUPERVISOR gets their client's
// people. The old listDirectory() source 403'd for that role and silently
// returned no matches.
function AssociateSearchField({
  value,
  onChange,
}: {
  value: { id: string; name: string } | null;
  onChange: (v: { id: string; name: string } | null) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<
    Array<{ id: string; name: string; email: string }> | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    listSchedulingAssociates()
      .then((r) => {
        if (cancelled) return;
        setAll(
          r.associates.map((a) => ({
            id: a.id,
            name: `${a.firstName} ${a.lastName}`,
            email: a.email,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setAll([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term.length < 2 || !all) return [];
    return all
      .filter((a) => `${a.name} ${a.email}`.toLowerCase().includes(term))
      .slice(0, 8);
  }, [q, all]);

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
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-navy-secondary bg-midnight elev-2">
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
  showApproveNext = false,
}: {
  mode: 'create' | 'edit';
  entry?: TimeEntry;
  onClose: () => void;
  /** Called after a successful save with the freshest server copy of the
   *  entry (when one is available) so the caller can reopen its detail.
   *  `advanceNext` is true when "Save, approve & next" was used — the
   *  caller advances the drawer to the next flagged entry. */
  onSaved: (updated?: TimeEntry, advanceNext?: boolean) => void;
  /** Offer the "Save, approve & next" triage button (queue context only —
   *  advancing needs the queue's visible list behind it). */
  showApproveNext?: boolean;
}) {
  const [assoc, setAssoc] = useState<{ id: string; name: string } | null>(
    mode === 'edit' && entry
      ? { id: entry.associateId, name: entry.associateName ?? '—' }
      : null,
  );
  // Every wall-clock string in this form speaks the SITE's clock when the
  // entry has one. The queue and drawer render punches in the site zone,
  // but this form used to parse typed times browser-locally — a CT admin
  // typing "9:00" for an ET entry stored 9:00 CT (= 10:00 ET). Null zone
  // (create mode, or a legacy entry with no location) = browser-local,
  // exactly the old behavior.
  const tz = mode === 'edit' ? entry?.locationTimezone ?? null : null;
  const dateOfWall = (d: Date) => zonedDayKey(d, tz);
  const timeOfWall = (d: Date) => {
    const mins = zonedMinutesOfDay(d, tz);
    return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
  };
  const combineWall = (ds: string, ts: string, dayOffset = 0): Date => {
    const [y, m, dd] = ds.split('-').map(Number);
    const [hh, mm] = ts.split(':').map(Number);
    return zonedWallTimeToUtc(y, m, dd + dayOffset, hh, mm, tz);
  };
  const wallDayDiff = (a: Date, b: Date) =>
    Math.round(
      (Date.parse(`${zonedDayKey(b, tz)}T00:00:00Z`) -
        Date.parse(`${zonedDayKey(a, tz)}T00:00:00Z`)) /
        86_400_000,
    );
  const editIn = mode === 'edit' && entry ? new Date(entry.clockInAt) : null;
  const editOut =
    mode === 'edit' && entry?.clockOutAt ? new Date(entry.clockOutAt) : null;
  const [dateStr, setDateStr] = useState(dateOfWall(editIn ?? new Date()));
  const [startTime, setStartTime] = useState(editIn ? timeOfWall(editIn) : '');
  const [endTime, setEndTime] = useState(editOut ? timeOfWall(editOut) : '');
  // Calendar days between clock-in and clock-out. The common overnight case
  // (end < start) is derived automatically; this only preserves rarer spans
  // loaded from an existing entry.
  const [extraDays, setExtraDays] = useState(
    editIn && editOut ? wallDayDiff(editIn, editOut) : 0,
  );
  const [notes, setNotes] = useState(
    mode === 'edit' && entry ? entry.notes ?? '' : '',
  );
  const [payRate, setPayRate] = useState(
    mode === 'edit' && entry?.payRate != null ? String(entry.payRate) : '',
  );
  // Breaks, editable inline as wall-clock times on the shift's timeline.
  // Rows with an id mirror existing BreakEntry rows; id=null rows are new
  // and created on save. An empty end is only legal on a pre-existing open
  // break (associate is on it right now).
  const [breakRows, setBreakRows] = useState<
    Array<{ id: string | null; startTime: string; endTime: string }>
  >(
    mode === 'edit' && entry?.breaks
      ? entry.breaks.map((b) => ({
          id: b.id,
          startTime: timeOfWall(new Date(b.startedAt)),
          endTime: b.endedAt ? timeOfWall(new Date(b.endedAt)) : '',
        }))
      : [],
  );
  const [busy, setBusy] = useState(false);
  // Which footer button is in flight — all share `busy`, only the clicked
  // one shows its spinner.
  const [approveIntent, setApproveIntent] = useState(false);
  const [nextIntent, setNextIntent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Mount-time snapshot for the discard guard — the drawer is keyed per
  // entry, so first-render state IS the pristine form. Compared field-by-
  // field so a stray Esc / outside click can't silently destroy edited
  // punches, breaks, or notes.
  const breaksKey = (
    rows: Array<{ id: string | null; startTime: string; endTime: string }>,
  ) => rows.map((r) => `${r.id ?? ''}|${r.startTime}|${r.endTime}`).join(',');
  const initialFormRef = useRef({
    assocId: assoc?.id ?? null,
    dateStr,
    startTime,
    endTime,
    extraDays,
    notes,
    payRate,
    breaks: breaksKey(breakRows),
  });
  const isDirty = () => {
    const i = initialFormRef.current;
    return (
      (assoc?.id ?? null) !== i.assocId ||
      dateStr !== i.dateStr ||
      startTime !== i.startTime ||
      endTime !== i.endTime ||
      extraDays !== i.extraDays ||
      notes !== i.notes ||
      payRate !== i.payRate ||
      breaksKey(breakRows) !== i.breaks
    );
  };

  const isActive = mode === 'edit' && entry?.status === 'ACTIVE';
  const clockOutOptional = mode === 'create' || isActive;

  // End earlier than start means the shift runs past midnight — "+1 day" is
  // implied, never asked for as a second date.
  const overnight = !!startTime && !!endTime && endTime < startTime;
  const endOffset = overnight ? Math.max(1, extraDays) : extraDays;
  const startDate =
    dateStr && startTime ? combineWall(dateStr, startTime) : null;
  const endDate =
    dateStr && startTime && endTime
      ? combineWall(dateStr, endTime, endOffset)
      : null;

  // A break time earlier than clock-in belongs to the next calendar day
  // (overnight shifts).
  const breakDate = (t: string): Date =>
    combineWall(dateStr, t, startTime && t < startTime ? 1 : 0);

  // The associate's rostered shift for the picked day — one click prefills
  // the times instead of retyping what scheduling already knows. Edit mode
  // (where missing clock-outs get repaired) shows the same chip: the entry's
  // own linked shift times are already denormalized on the row (zero extra
  // fetch); unlinked entries fall back to the create-mode schedule lookup.
  const [schedShift, setSchedShift] = useState<{
    startsAt: string;
    endsAt: string;
  } | null>(null);
  useEffect(() => {
    if (mode === 'edit' && entry?.shiftStartsAt && entry?.shiftEndsAt) {
      setSchedShift({ startsAt: entry.shiftStartsAt, endsAt: entry.shiftEndsAt });
      return;
    }
    if (!assoc || !dateStr) {
      setSchedShift(null);
      return;
    }
    let cancelled = false;
    listShifts({
      from: combineWall(dateStr, '00:00').toISOString(),
      to: combineWall(dateStr, '00:00', 1).toISOString(),
    })
      .then((r) => {
        if (cancelled) return;
        setSchedShift(
          r.shifts.find(
            (s) =>
              s.assignedAssociateId === assoc.id &&
              s.status !== 'CANCELLED' &&
              s.status !== 'DRAFT',
          ) ?? null,
        );
      })
      .catch(() => {
        if (!cancelled) setSchedShift(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, entry, assoc, dateStr]);

  const applySchedule = () => {
    if (!schedShift) return;
    const s = new Date(schedShift.startsAt);
    const e = new Date(schedShift.endsAt);
    setDateStr(dateOfWall(s));
    setStartTime(timeOfWall(s));
    setEndTime(timeOfWall(e));
    setExtraDays(wallDayDiff(s, e));
  };

  const setEndNow = () => {
    const now = new Date();
    setEndTime(timeOfWall(now));
    if (dateStr) {
      setExtraDays(
        Math.max(0, wallDayDiff(combineWall(dateStr, '00:00'), now)),
      );
    }
  };

  // Drop a break of the given length into the middle of the shift (about
  // 4 hours in while the associate is still on the clock), snapped to 5
  // minutes — the admin only adjusts the times if the guess is off.
  const addQuickBreak = (minutes: number) => {
    if (!startDate) return;
    const dur = minutes * 60_000;
    const s = startDate.getTime();
    let bs = endDate ? (s + endDate.getTime() - dur) / 2 : s + 4 * 3_600_000;
    bs = Math.round(bs / 300_000) * 300_000;
    if (endDate) bs = Math.min(bs, endDate.getTime() - dur);
    bs = Math.max(bs, s);
    setBreakRows((rows) => [
      ...rows,
      {
        id: null,
        startTime: timeOfWall(new Date(bs)),
        endTime: timeOfWall(new Date(bs + dur)),
      },
    ]);
  };

  const totalMin =
    startDate && endDate
      ? (endDate.getTime() - startDate.getTime()) / 60_000
      : null;
  const breakMin = breakRows.reduce((acc, r) => {
    if (!r.startTime || !r.endTime || !dateStr || !startTime) return acc;
    const bs = breakDate(r.startTime).getTime();
    const be = breakDate(r.endTime).getTime();
    return be > bs ? acc + (be - bs) / 60_000 : acc;
  }, 0);

  const submit = async (andApprove = false, andNext = false) => {
    setApproveIntent(andApprove);
    setNextIntent(andNext);
    setErr(null);
    if (mode === 'create' && !assoc) {
      setErr('Pick an associate.');
      return;
    }
    if (!dateStr) {
      setErr('Date is required.');
      return;
    }
    if (!startTime) {
      setErr('Clock-in time is required.');
      return;
    }
    const inDate = combineWall(dateStr, startTime);
    const outDate = endTime ? combineWall(dateStr, endTime, endOffset) : null;
    if (outDate && outDate.getTime() <= inDate.getTime()) {
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
    const inMs = inDate.getTime();
    const outMs = outDate ? outDate.getTime() : Date.now();
    for (const [i, r] of breakRows.entries()) {
      const orig = r.id ? entry?.breaks?.find((b) => b.id === r.id) : undefined;
      const openBreak = !!orig && orig.endedAt === null && r.endTime === '';
      if (!r.startTime || (!r.endTime && !openBreak)) {
        setErr(`Break ${i + 1} needs both a start and an end time.`);
        return;
      }
      const s = breakDate(r.startTime).getTime();
      const e = r.endTime ? breakDate(r.endTime).getTime() : outMs;
      if (e <= s) {
        setErr(`Break ${i + 1} must end after it starts.`);
        return;
      }
      if (s < inMs || e > outMs) {
        setErr(`Break ${i + 1} must fall inside the clock-in/clock-out window.`);
        return;
      }
      for (const [j, other] of breakRows.entries()) {
        if (j >= i || !other.startTime) continue;
        const os = breakDate(other.startTime).getTime();
        const oe = other.endTime ? breakDate(other.endTime).getTime() : outMs;
        if (s < oe && e > os) {
          setErr(`Breaks ${j + 1} and ${i + 1} overlap.`);
          return;
        }
      }
    }
    setBusy(true);
    try {
      let entryId: string;
      // Freshest server copy of the entry across the save/break/approve
      // calls — handed to onSaved so the detail drawer can reopen updated.
      let latest: TimeEntry | undefined;
      if (mode === 'create') {
        const created = await adminCreateTimeEntry({
          associateId: assoc!.id,
          clockInAt: inDate.toISOString(),
          clockOutAt: outDate ? outDate.toISOString() : null,
          payRate: payRateVal,
          notes: notes.trim() || null,
        });
        entryId = created.id;
        latest = created;
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
            outDate ? 'Shift logged.' : `Clocked in ${assoc!.name}.`,
          );
        }
      } else {
        entryId = entry!.id;
        latest = await adminEditTimeEntry(entry!.id, {
          clockInAt: inDate.toISOString(),
          clockOutAt: outDate ? outDate.toISOString() : null,
          payRate: payRateVal,
          notes: notes.trim() || null,
        });
        // Save & approve gets ONE toast, after the approval below.
        if (!andApprove) {
          toast.success(
            isActive && outDate
              ? `Clocked out ${entry!.associateName ?? 'associate'}.`
              : 'Entry updated.',
          );
        }
      }
      // Sync breaks AFTER the entry saved — deletions, then edits, then
      // adds. A failure here must not strand the drawer (the entry write
      // already landed, and in create mode a retry would duplicate it):
      // warn, close, and let the admin reopen edit to fix the break.
      try {
        const origBreaks = mode === 'edit' ? (entry?.breaks ?? []) : [];
        const keptIds = new Set(breakRows.map((r) => r.id).filter(Boolean));
        for (const b of origBreaks) {
          if (!keptIds.has(b.id)) latest = await deleteTimeEntryBreak(b.id);
        }
        for (const r of breakRows) {
          if (!r.id) {
            latest = await addTimeEntryBreak(entryId, {
              startedAt: breakDate(r.startTime).toISOString(),
              endedAt: breakDate(r.endTime).toISOString(),
            });
            continue;
          }
          const orig = origBreaks.find((b) => b.id === r.id);
          if (!orig) continue;
          const startChanged =
            new Date(orig.startedAt).getTime() !==
            breakDate(r.startTime).getTime();
          const endChanged =
            (orig.endedAt ? new Date(orig.endedAt).getTime() : null) !==
            (r.endTime ? breakDate(r.endTime).getTime() : null);
          if (!startChanged && !endChanged) continue;
          latest = await updateTimeEntryBreak(r.id, {
            ...(startChanged
              ? { startedAt: breakDate(r.startTime).toISOString() }
              : {}),
            ...(endChanged && r.endTime
              ? { endedAt: breakDate(r.endTime).toISOString() }
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
      // Save & approve: the times just written are what gets approved. An
      // approval failure must not strand the drawer — the save already
      // landed, so warn and fall back to the queue's Approve button.
      if (andApprove && mode === 'edit') {
        try {
          latest = await approveTimeEntry(entryId);
          toast.success(
            `Saved and approved — ${entry!.associateName ?? 'associate'}.`,
          );
        } catch (approveErr) {
          toast.warning(
            `Entry saved, but approving it failed: ${
              approveErr instanceof ApiError ? approveErr.message : 'unknown error'
            }. Approve it from the queue.`,
            { duration: 10000 },
          );
        }
      }
      onSaved(latest, andNext);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      confirmDiscard={isDirty}
      width="max-w-lg"
    >
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
        {err && <ErrorBanner>{err}</ErrorBanner>}
        {mode === 'create' ? (
          <AssociateSearchField value={assoc} onChange={setAssoc} />
        ) : (
          <div>
            <FieldLabel>Associate</FieldLabel>
            <div className="text-white">{entry?.associateName ?? '—'}</div>
          </div>
        )}
        {tz && tz !== browserTimeZone() && (
          <p className="text-xs2 text-gold">
            Times are entered in {tzAbbrev(tz)} — the work site&apos;s clock,
            matching the queue and drawer.
          </p>
        )}
        <div>
          <FieldLabel>Date</FieldLabel>
          <Input
            type="date"
            aria-label="Shift date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
          />
        </div>
        {schedShift && (
          <Button
            variant="outline"
            size="xs"
            onClick={applySchedule}
            className="gap-1.5 rounded-full border-gold/40 bg-gold/10 text-gold hover:border-gold/60 hover:bg-gold/20 hover:text-gold"
          >
            <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
            Use scheduled shift {fmtTime(schedShift.startsAt)} –{' '}
            {fmtTime(schedShift.endsAt)}
          </Button>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Clock in</FieldLabel>
            <Input
              type="time"
              aria-label="Clock-in time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div>
            <FieldLabel>
              Clock out{clockOutOptional ? ' (optional)' : ''}
            </FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                type="time"
                aria-label="Clock-out time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="flex-1"
              />
              {clockOutOptional && (
                <Button type="button" variant="ghost" onClick={setEndNow}>
                  Now
                </Button>
              )}
            </div>
          </div>
        </div>
        {endTime && endOffset > 0 && (
          <p className="-mt-2 text-xs text-gold">
            Ends the next day (+{endOffset === 1 ? '1 day' : `${endOffset} days`})
            {!overnight && extraDays > 0 && (
              <Button
                variant="link"
                onClick={() => setExtraDays(0)}
                className="ml-2 text-xs font-normal text-gold underline hover:text-gold-bright"
              >
                make it same-day
              </Button>
            )}
          </p>
        )}
        {isActive && (
          <p className="-mt-2 text-xs text-silver">
            Setting a clock-out clocks this associate out.
          </p>
        )}
        <div>
          <FieldLabel>Breaks (unpaid)</FieldLabel>
          {breakRows.length === 0 && (
            <p className="mb-1 text-xs text-silver">No breaks on this entry.</p>
          )}
          <div className="space-y-2">
            {breakRows.map((r, i) => (
              <div key={r.id ?? `new-${i}`} className="flex items-center gap-2">
                <Input
                  type="time"
                  aria-label={`Break ${i + 1} start`}
                  value={r.startTime}
                  onChange={(e) =>
                    setBreakRows((rows) =>
                      rows.map((row, j) =>
                        j === i ? { ...row, startTime: e.target.value } : row,
                      ),
                    )
                  }
                  className="flex-1"
                />
                <span className="text-silver" aria-hidden="true">–</span>
                <Input
                  type="time"
                  aria-label={`Break ${i + 1} end`}
                  value={r.endTime}
                  onChange={(e) =>
                    setBreakRows((rows) =>
                      rows.map((row, j) =>
                        j === i ? { ...row, endTime: e.target.value } : row,
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {[15, 30, 60].map((min) => (
              <Button
                key={min}
                type="button"
                variant="ghost"
                size="sm"
                disabled={!startTime}
                title={
                  startTime
                    ? `Add a ${min}-minute break in the middle of the shift`
                    : 'Set the clock-in time first'
                }
                onClick={() => addQuickBreak(min)}
              >
                <Coffee className="h-3.5 w-3.5" />
                {min === 60 ? '1h' : `${min}m`}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setBreakRows((rows) => [
                  ...rows,
                  { id: null, startTime: '', endTime: '' },
                ])
              }
            >
              <Plus className="h-4 w-4" />
              Add break
            </Button>
          </div>
          <p className="mt-1 text-xs text-silver">
            Unpaid time inside the shift — subtracted from paid hours.
          </p>
        </div>
        {totalMin !== null && totalMin > 0 && (
          <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 px-3 py-2 text-sm text-silver">
            Total {fmtDurMin(totalMin)}
            {breakMin > 0 && <> · Breaks {fmtDurMin(breakMin)}</>}
            {' · '}
            <span className="text-gold">
              Paid {fmtDurMin(Math.max(0, totalMin - breakMin))}
            </span>
          </div>
        )}
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
        {/* One click instead of Save → find the row → Approve. Only when a
            clock-out is set (an ACTIVE entry can't be approved) and the
            entry isn't already approved. */}
        {mode === 'edit' && entry && entry.status !== 'APPROVED' && !!endTime && (
          <>
            <Button
              variant="outline"
              onClick={() => submit(true)}
              loading={busy && approveIntent && !nextIntent}
              disabled={busy}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Save &amp; approve
            </Button>
            {/* Triage loop: same save+approve, then the caller advances
                this drawer to the next flagged entry in view. */}
            {showApproveNext && (
              <Button
                variant="outline"
                onClick={() => submit(true, true)}
                loading={busy && nextIntent}
                disabled={busy}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Save, approve &amp; next
              </Button>
            )}
          </>
        )}
        <Button
          onClick={() => submit(false)}
          loading={busy && !approveIntent}
          disabled={busy}
        >
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
  defaultClientId,
  defaultLocationId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  fromIso: string;
  toIso: string;
  /** The page's current client/site scope — seeds the dialog on open so
   *  the common "export what I'm looking at" case is zero extra clicks. */
  defaultClientId: string;
  defaultLocationId: string;
}) {
  const { user } = useAuth();
  // Client-bound roles can't list clients (403) — pin the dropdown to
  // their one client instead of fetching.
  const boundedClient = user?.clientId
    ? { id: user.clientId, name: user.clientName ?? 'Your client' }
    : null;
  // Shared 5-min-cached client list; only fetched while the dialog is open
  // and the viewer isn't pinned to a single client.
  const { clients } = useClients({ enabled: open && !boundedClient });
  const [clientId, setClientId] = useState(boundedClient?.id ?? '');
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The clientId-change effect below wipes locationId (an in-dialog client
  // switch invalidates the site pick); this ref carries the page's seed
  // across that wipe when opening re-seeds BOTH at once.
  const seedLocationRef = useRef('');
  useEffect(() => {
    if (!open) return;
    seedLocationRef.current = defaultLocationId;
    setClientId(boundedClient?.id ?? defaultClientId);
    setLocationId(defaultLocationId);
    // boundedClient is a per-render literal; open/defaults drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultClientId, defaultLocationId]);

  useEffect(() => {
    setLocationId(seedLocationRef.current);
    seedLocationRef.current = '';
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
          {err && <ErrorBanner>{err}</ErrorBanner>}
          <div>
            <FieldLabel>Client</FieldLabel>
            {boundedClient ? (
              <div className="mt-1 flex h-10 items-center rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 text-sm text-white">
                {boundedClient.name}
              </div>
            ) : (
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
            )}
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
            Export CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `ymd` + `days`, as YYYY-MM-DD. Calendar math (DST-safe), no toLocale. */
function ymdAddDays(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  return ymdLocal(d);
}

/**
 * Next batch-reference suggestion: a trailing number increments, keeping
 * zero-padding ("ADP run #4412" → "…#4413", "BATCH-007" → "BATCH-008");
 * anything else prefills unchanged for hand-editing.
 */
function suggestNextReference(last: string): string {
  const m = /^(.*?)(\d{1,15})$/.exec(last);
  if (!m) return last;
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
}

/**
 * Record pay period — the batch external-payment recorder. One row per
 * associate with APPROVED time in the period, hours + suggested gross
 * prefilled from the same math as the bureau handoff sheet; one click
 * records (or refreshes) the whole run as ExternalPayment vault rows.
 * Replaces the old per-associate drawer round-trip for run documentation;
 * per-person evidence uploads stay on the profile drawer.
 */
function RecordPayPeriodDialog({
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
  const [fromYmd, setFromYmd] = useState(defaultFromYmd);
  const [toYmd, setToYmd] = useState(defaultToYmd);
  const [rows, setRows] = useState<PeriodPrefillRow[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [grossById, setGrossById] = useState<Record<string, string>>({});
  const [payDate, setPayDate] = useState('');
  const [method, setMethod] = useState('DIRECT_DEPOSIT');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState<'load' | 'save' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Last run's habits, remembered across visits: the gap between period end
  // and pay date, and the batch reference — both prefilled on open so a
  // steady cadence needs zero retyping.
  const [payOffsetDays, setPayOffsetDays] = usePersistentState<number>(
    'alto:form.time.recordPeriod.payOffsetDays.v1',
    5,
    (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 60,
  );
  const [lastReference, setLastReference] = usePersistentState<string>(
    'alto:form.time.recordPeriod.reference.v1',
    '',
    (v): v is string => typeof v === 'string',
  );

  const load = async (f = fromYmd, t = toYmd) => {
    if (!f || !t || t < f) {
      setErr('Pick a valid pay period (end on or after start).');
      return;
    }
    setBusy('load');
    setErr(null);
    try {
      const r = await getPeriodPrefill(f, t);
      setRows(r.rows);
      // Default: everyone with hours is checked; already-recorded rows too
      // (re-recording just refreshes them — idempotent server-side).
      setChecked(new Set(r.rows.map((x) => x.associateId)));
      setGrossById(
        Object.fromEntries(
          r.rows.map((x) => [
            x.associateId,
            x.suggestedGross != null ? String(x.suggestedGross) : '',
          ]),
        ),
      );
      if (r.truncated) {
        toast.warning('The time scan hit its cap — narrow the range.');
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not load the period.');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    setFromYmd(defaultFromYmd);
    setToYmd(defaultToYmd);
    setRows(null);
    setChecked(new Set());
    setGrossById({});
    setPayDate(defaultToYmd ? ymdAddDays(defaultToYmd, payOffsetDays) : '');
    setReference(suggestNextReference(lastReference));
    setErr(null);
    // The period read is idempotent, so fire it on open when the prefilled
    // dates are already valid; the button stays for hand-edited dates.
    if (defaultFromYmd && defaultToYmd && defaultToYmd >= defaultFromYmd) {
      void load(defaultFromYmd, defaultToYmd);
    }
    // payOffsetDays / lastReference / load: open-time snapshots only —
    // re-running mid-session would wipe the loaded rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultFromYmd, defaultToYmd]);

  const record = async () => {
    if (!rows) return;
    const picked = rows.filter((r) => checked.has(r.associateId));
    if (picked.length === 0) {
      setErr('Nobody is selected.');
      return;
    }
    setBusy('save');
    setErr(null);
    try {
      const res = await recordPayPeriod({
        periodStart: fromYmd,
        periodEnd: toYmd,
        payDate: payDate || null,
        method,
        reference: reference || null,
        rows: picked.map((r) => {
          const g = Number(grossById[r.associateId]);
          return {
            associateId: r.associateId,
            grossAmount: Number.isFinite(g) && grossById[r.associateId] !== '' ? g : null,
          };
        }),
      });
      // No aggregate "all recorded payments" surface exists — each record
      // lives on its associate's profile drawer (Payments tab). Name the
      // period + counts so the toast stands on its own, and say where the
      // per-person records landed.
      toast.success(
        `Pay period ${fmtDateTz(fromYmd, 'UTC')} – ${fmtDateTz(toYmd, 'UTC')} recorded: ${res.created} new, ${res.updated} refreshed${res.skipped > 0 ? `, ${res.skipped} skipped` : ''}.`,
        {
          description:
            "Each associate's payment record is on their profile drawer under Payments.",
        },
      );
      // Remember this run's habits for next open (only sane offsets — a
      // one-off backdated correction shouldn't poison future prefills).
      const end = parseYmd(toYmd);
      const paid = parseYmd(payDate);
      if (end && paid) {
        const offset = Math.round((paid.getTime() - end.getTime()) / 86_400_000);
        if (offset >= 0 && offset <= 60) setPayOffsetDays(offset);
      }
      if (reference.trim()) setLastReference(reference.trim());
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Recording failed.');
    } finally {
      setBusy(null);
    }
  };

  const total = rows
    ? rows
        .filter((r) => checked.has(r.associateId))
        .reduce((s, r) => s + (Number(grossById[r.associateId]) || 0), 0)
    : 0;

  // Real dirty check for the discard guard: any typed gross override that
  // differs from the prefill. Hand-corrected amounts across a long roster
  // used to vanish on a stray Esc / outside click.
  const isDirty = () =>
    !!rows &&
    rows.some(
      (r) =>
        (grossById[r.associateId] ?? '') !==
        (r.suggestedGross != null ? String(r.suggestedGross) : ''),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange} confirmDiscard={isDirty}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record pay period</DialogTitle>
          <DialogDescription>
            Documents the external pay run for the audit vault — one payment
            row per associate, prefilled from approved time. Re-recording a
            period refreshes it, never duplicates.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {err && <ErrorBanner>{err}</ErrorBanner>}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label className="text-xs">Period start</Label>
              <Input type="date" value={fromYmd} onChange={(e) => setFromYmd(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Period end</Label>
              <Input type="date" value={toYmd} onChange={(e) => setToYmd(e.target.value)} />
            </div>
            <Button onClick={() => void load()} loading={busy === 'load'} disabled={busy !== null}>
              Load period
            </Button>
          </div>

          {rows && rows.length === 0 && (
            <p className="text-sm text-silver">
              No approved time in this period — approve entries first.
            </p>
          )}

          {rows && rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label className="text-xs">Pay date</Label>
                  <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs">Method</Label>
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    <option value="DIRECT_DEPOSIT">ACH / direct deposit</option>
                    <option value="CHECK">Check</option>
                    <option value="CASH">Cash</option>
                    <option value="PAYROLL_PROVIDER">Payroll provider</option>
                    <option value="OTHER">Other</option>
                  </Select>
                </div>
                <div className="min-w-[180px] flex-1">
                  <Label className="text-xs">Reference (processor run / batch id)</Label>
                  <Input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="e.g. ADP run #4412"
                  />
                </div>
              </div>

              <div className="max-h-80 overflow-y-auto rounded-md border border-navy-secondary">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-navy">
                    <tr className="text-left text-2xs uppercase tracking-wider text-silver/70">
                      <th className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          aria-label="Select everyone"
                          checked={checked.size === rows.length}
                          onChange={(e) =>
                            setChecked(
                              e.target.checked
                                ? new Set(rows.map((r) => r.associateId))
                                : new Set(),
                            )
                          }
                        />
                      </th>
                      <th className="px-2 py-1.5">Associate</th>
                      <th className="px-2 py-1.5 text-right">Reg h</th>
                      <th className="px-2 py-1.5 text-right">OT h</th>
                      <th className="px-2 py-1.5 text-right">Gross $</th>
                      <th className="px-2 py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-navy-secondary/60">
                    {rows.map((r) => (
                      <tr key={r.associateId}>
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            aria-label={`Include ${r.fullName}`}
                            checked={checked.has(r.associateId)}
                            onChange={(e) =>
                              setChecked((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(r.associateId);
                                else next.delete(r.associateId);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1 text-white">
                          {r.fullName}
                          <span className="ml-1.5 text-2xs text-silver/60">{r.clientName}</span>
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-silver">
                          {r.regularHours.toFixed(1)}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-silver">
                          {r.overtimeHours.toFixed(1)}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <Input
                            inputMode="decimal"
                            className="h-7 w-24 text-right tabular-nums"
                            value={grossById[r.associateId] ?? ''}
                            onChange={(e) =>
                              setGrossById((prev) => ({
                                ...prev,
                                [r.associateId]: e.target.value,
                              }))
                            }
                            aria-label={`Gross pay for ${r.fullName}`}
                          />
                        </td>
                        <td className="px-2 py-1 text-2xs">
                          {r.alreadyRecorded ? (
                            <span className="text-success">recorded ✓</span>
                          ) : (
                            <span className="text-silver/50">new</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-silver tabular-nums">
                  {checked.size} of {rows.length} selected · total gross ~$
                  {total.toFixed(2)}
                </div>
                <Button onClick={() => void record()} loading={busy === 'save'} disabled={busy !== null}>
                  Record {checked.size} payment{checked.size === 1 ? '' : 's'}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * External payroll sheet — the handoff file for an outside payroll bureau.
 *
 * Separate dialog from PayrollSheetDialog rather than a checkbox on it,
 * deliberately. The two files look similar but are not interchangeable: this
 * one puts a full SSN next to a full bank account and routing number for
 * every worker in the range. Making it a distinct, differently-styled action
 * behind its own confirmation means nobody produces it by reflex while
 * reaching for the ordinary payroll sheet.
 */
function ExternalPayrollSheetDialog({
  open,
  onOpenChange,
  defaultFromYmd,
  defaultToYmd,
  defaultClientId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultFromYmd: string;
  defaultToYmd: string;
  /** The page's current client scope — seeded on open, still editable. */
  defaultClientId: string;
}) {
  const { user } = useAuth();
  const boundedClient = user?.clientId
    ? { id: user.clientId, name: user.clientName ?? 'Your client' }
    : null;
  const { clients } = useClients({ enabled: open && !boundedClient });
  const [clientId, setClientId] = useState(boundedClient?.id ?? '');
  const [fromYmd, setFromYmd] = useState(defaultFromYmd);
  const [toYmd, setToYmd] = useState(defaultToYmd);
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFromYmd(defaultFromYmd);
    setToYmd(defaultToYmd);
    setClientId(boundedClient?.id ?? defaultClientId);
    setErr(null);
    // Re-arm every time. A sticky acknowledgement would defeat the point.
    setAcknowledged(false);
    // boundedClient is a per-render literal; open/defaults drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultFromYmd, defaultToYmd, defaultClientId]);

  const download = async (format: 'pdf' | 'xlsx') => {
    if (!fromYmd || !toYmd || toYmd < fromYmd) {
      setErr('Pick a valid pay period (end on or after start).');
      return;
    }
    setBusy(format);
    setErr(null);
    try {
      const { employeeCount, gaps, truncated } = await exportExternalPayrollSheet(
        format,
        {
          from: ymdToIsoStart(fromYmd),
          to: ymdToIsoEndExclusive(toYmd),
          ...(clientId ? { clientId } : {}),
        },
      );
      // Blank cells in a bureau file are rejected submissions or unpaid
      // workers, and they're invisible in a 300-row spreadsheet. Say it out
      // loud rather than letting the download read as a clean success.
      const problems: string[] = [];
      if (gaps.missingW4 > 0) problems.push(`${gaps.missingW4} with no W-4`);
      if (gaps.unreadableSsn > 0)
        problems.push(`${gaps.unreadableSsn} with no readable SSN`);
      if (gaps.missingBankDetails > 0)
        problems.push(`${gaps.missingBankDetails} missing bank details`);
      if (gaps.missingPayRate > 0)
        problems.push(`${gaps.missingPayRate} with no pay rate`);

      if (truncated) {
        toast.error(
          'The sheet is incomplete — the time-entry scan hit its cap. Narrow the range or filter by client and regenerate before sending.',
          { duration: 15000 },
        );
      } else if (problems.length > 0) {
        toast.warning(
          `${employeeCount} employee${employeeCount === 1 ? '' : 's'} exported, but ${problems.join(', ')}. Those rows will be rejected or unpaid — fix them before sending.`,
          { duration: 15000 },
        );
      } else {
        toast.success(
          `${employeeCount} employee${employeeCount === 1 ? '' : 's'} exported with complete details.`,
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
          <DialogTitle>External payroll sheet</DialogTitle>
          <DialogDescription>
            The handoff file for an outside payroll provider. APPROVED time
            only.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {err && <ErrorBanner>{err}</ErrorBanner>}

          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.07] p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0 text-xs">
              <div className="font-medium text-white">
                This file contains full Social Security numbers and bank
                account details
              </div>
              <div className="mt-0.5 text-silver">
                One row per employee, each with SSN, routing and account
                number, date of birth and home address. Send it only to your
                designated payroll provider over an encrypted channel. Every
                download is recorded against your account.
              </div>
            </div>
          </div>

          <div>
            <FieldLabel>Client</FieldLabel>
            {boundedClient ? (
              <div className="mt-1 flex h-10 items-center rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 text-sm text-white">
                {boundedClient.name}
              </div>
            ) : (
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
            )}
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

          <label className="flex items-start gap-2 text-xs text-silver cursor-pointer">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0"
            />
            <span>
              I&apos;m authorised to share this data with our payroll provider
              and will transmit it securely.
            </span>
          </label>

          <p className="text-xs text-silver">
            Overtime = hours over 40 per week (federal), matching payroll. Bank
            name comes from each associate&apos;s direct-deposit setup and is
            blank on records saved before that field existed.
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy !== null}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => download('pdf')}
            loading={busy === 'pdf'}
            disabled={busy !== null || !acknowledged}
          >
            <FileText className="mr-2 h-4 w-4" />
            PDF
          </Button>
          <Button
            onClick={() => download('xlsx')}
            loading={busy === 'xlsx'}
            disabled={busy !== null || !acknowledged}
          >
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Excel
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
  defaultClientId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultFromYmd: string;
  defaultToYmd: string;
  /** The page's current client scope — seeded on open, still editable.
   *  Kills the "Pick a client first." stop for the common case. */
  defaultClientId: string;
}) {
  const { user } = useAuth();
  // Client-bound roles can't list clients (403) — pin the required client
  // to theirs so the export isn't hard-blocked by an empty dropdown.
  const boundedClient = user?.clientId
    ? { id: user.clientId, name: user.clientName ?? 'Your client' }
    : null;
  // Shared 5-min-cached client list; only fetched while the dialog is open
  // and the viewer isn't pinned to a single client.
  const { clients } = useClients({ enabled: open && !boundedClient });
  const [clientId, setClientId] = useState(boundedClient?.id ?? '');
  const [fromYmd, setFromYmd] = useState(defaultFromYmd);
  const [toYmd, setToYmd] = useState(defaultToYmd);
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFromYmd(defaultFromYmd);
    setToYmd(defaultToYmd);
    setClientId(boundedClient?.id ?? defaultClientId);
    setErr(null);
    // boundedClient is a per-render literal; open/defaults drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultFromYmd, defaultToYmd, defaultClientId]);

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
        // Honest about the fix: there is no client field on a time entry —
        // the client comes from the associate's job at punch time, so the
        // old "attach the client" instruction pointed at a control that
        // doesn't exist.
        toast.warning(
          `${noClientCount} approved ${noClientCount === 1 ? 'entry' : 'entries'} in this period ${noClientCount === 1 ? 'has' : 'have'} no client attached and ${noClientCount === 1 ? 'was' : 'were'} left out of the sheet. An entry takes its client from the associate's job at punch time — assign those associates to a job for this client so their shifts land on future sheets.`,
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
          {err && <ErrorBanner>{err}</ErrorBanner>}
          <div>
            <FieldLabel>Client</FieldLabel>
            {boundedClient ? (
              <div className="mt-1 flex h-10 items-center rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 text-sm text-white">
                {boundedClient.name}
              </div>
            ) : (
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
            )}
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
      <dt className="text-2xs uppercase tracking-widest text-silver/80">{label}</dt>
      <dd className="text-white text-sm mt-0.5 break-words tabular-nums">{children}</dd>
    </div>
  );
}

function DetailSection({ label, body }: { label: string; body: string }) {
  return (
    <div className="mb-4">
      <div className="text-2xs uppercase tracking-widest text-silver/80 mb-1">
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
  /** Present = the tile is a shortcut (renders as a real button). */
  onClick?: () => void;
}

const TONE_TEXT: Record<KpiCardProps['tone'], string> = {
  success: 'text-success',
  warning: 'text-warning',
  alert: 'text-alert',
  default: 'text-gold',
  silver: 'text-silver',
};

function KpiCard({ icon: Icon, label, value, tone, onClick }: KpiCardProps) {
  if (value === '—') {
    return (
      <Card className="p-4">
        <div className="flex items-start justify-between mb-1">
          <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
            {label}
          </div>
          <Icon className="h-3.5 w-3.5 text-silver/70" />
        </div>
        <Skeleton className="h-9 w-12 mt-1" />
      </Card>
    );
  }
  const body = (
    <>
      <div className="flex items-start justify-between mb-1">
        <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
          {label}
        </div>
        <Icon className="h-3.5 w-3.5 text-silver/70" />
      </div>
      <div className={cn('text-3xl font-display tabular-nums', TONE_TEXT[tone])}>
        {value}
      </div>
    </>
  );
  if (onClick) {
    // A real <button> (Card renders a div) so the shortcut is keyboard-
    // and screen-reader reachable; classes mirror Card + interactive.
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-lg border border-navy-secondary bg-navy text-white elev-1 p-4 text-left transition-colors hover:border-steel hover:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        {body}
      </button>
    );
  }
  return <Card className="p-4">{body}</Card>;
}

interface RejectTimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  busy: boolean;
  onSubmit: (reason: string) => void;
}

// The three reasons reviewers type over and over — one tap fills the box,
// still editable, still required.
const REJECT_REASON_PRESETS = [
  'Forgot to clock out — please re-submit',
  'Punched at the wrong site',
  'Duplicate punch',
];

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
          <div className="flex flex-wrap gap-1.5">
            {REJECT_REASON_PRESETS.map((preset) => (
              <Button
                key={preset}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setReason(preset)}
                className={cn(
                  reason === preset &&
                    'border-gold text-gold bg-gold/10 hover:border-gold hover:text-gold',
                )}
              >
                {preset}
              </Button>
            ))}
          </div>
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
