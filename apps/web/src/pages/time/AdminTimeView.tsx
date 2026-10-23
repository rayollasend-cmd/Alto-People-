import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BreakFlagsDesk, TimeCorrectionsDesk } from './TimeCorrectionsDesk';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { hereAsReturn, withReturn } from '@/lib/returnPath';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { ListTemplate } from '@/components/templates';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock3,
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
  TimerOff,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  oldestPendingPeriod,
  type ActiveDashboardEntry,
  type PayPeriod,
  type TimeEntry,
  type TimeEntryStatus,
} from '@alto-people/shared';
import { useDesktopTable, useMediaQuery } from '@/lib/useViewport';
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
  getTimeExceptions,
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
import { boundedClientOf } from '@/lib/roles';
import { AttendanceCard } from '@/pages/time/AttendanceCard';
import { useClients } from '@/lib/useClients';
import { listShifts, listSchedulingAssociates } from '@/lib/schedulingApi';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm, useTenant } from '@/lib/auth';
import { useStoreScope } from '@/lib/storeScope';
import { cn } from '@/lib/cn';
import { personPhotoUrl } from '@/lib/photoUrl';
import { usePersistentState } from '@/lib/usePersistentState';
import { useListKeyboard } from '@/lib/shortcuts';
import { useSelection } from '@/lib/useSelection';
import { TIME_ANOMALY_LABELS, timeAnomalyLabel } from '@/lib/timeLabels';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { ShiftTimeline } from './ShiftTimeline';
import { TimesheetWeeks } from './TimesheetWeeks';
import { FocusToggle } from '@/pages/portal/FocusToggle';
import { clockInInWindows, inWindows, useShiftFocus } from '@/pages/portal/shiftFocus';
import { fmtPunchDateTime, fmtPunchTime, formatHM, punchDayOffset } from './punchFormat';
import {
  browserTimeZone,
  fmtDateTime,
  fmtDateOnly,
  fmtDateTz,
  fmtHours,
  fmtPayRate,
  fmtTimeTz,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorBanner,
  FilterBar,
  FilterChip,
  Input,
  Label,
  MetricCard,
  MetricStrip,
  SearchInput,
  SegmentedControl,
  Select,
  SkeletonRows,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  useTableSort,
} from '@/components/ui';

interface UnverifiedPacketChange {
  id: string;
  associateName: string;
  kindLabel: string;
  oldSummary: string;
  newSummary: string;
  by: string;
  at: string;
  status: string;
  highRisk: boolean;
  riskFlags: string[];
}

const STATUS_FILTERS: Array<{ value: TimeEntryStatus | 'ALL'; label: string }> = [
  { value: 'COMPLETED', label: 'Pending review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ALL', label: 'All' },
];

// Punch formatters live in ./punchFormat so the ShiftTimeline and every
// other single-entry surface renders identically to the queue.


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

/** "Sep 18 · 1:55 PM–9:55 PM CDT · 8.00h" — one punch on one line (the phone's queue row). */
function punchSpanLabel(e: TimeEntry): string {
  const tz = e.locationTimezone ?? null;
  const zone = tz ?? browserTimeZone();
  const day = fmtDateTz(e.clockInAt, zone);
  const start = fmtTimeTz(e.clockInAt, zone);
  const end = e.clockOutAt ? fmtPunchTime(e.clockOutAt, tz) : 'on the clock';
  const off = e.clockOutAt ? punchDayOffset(e.clockInAt, e.clockOutAt, tz) : 0;
  return `${day} · ${start}–${end}${off > 0 ? ` (+${off}d)` : ''} · ${formatHM(e.netMinutes ?? e.minutesElapsed)}`;
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
  const lateMin = lateMinutes(entry);
  if (lateMin === null || !entry.shiftStartsAt) return null;
  return (
    <span
      className="text-2xs uppercase tracking-widest px-1.5 py-0.5 rounded border border-alert/40 bg-alert/10 text-alert whitespace-nowrap"
      title={`Scheduled ${fmtPunchTime(entry.shiftStartsAt, entry.locationTimezone)}${entry.shiftPosition ? ` · ${entry.shiftPosition}` : ''}`}
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
  associateId,
  name,
  entries,
  onClear,
}: {
  associateId: string;
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

  // Overtime across the loaded range: each entry's share of the server's
  // labor-rules split (entry.hours) — the overtime the paycheck pays, over
  // the person's whole week at every client, daily rules included.
  const otMin = list
    .filter((e) => e.status !== 'REJECTED')
    .reduce((s, e) => s + (e.hours ? e.hours.overtimeMinutes + e.hours.doubleTimeMinutes : 0), 0);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-gold/40 bg-gold/5 px-3 py-2">
      <Avatar
        src={personPhotoUrl({ photoUrl: list.find((e) => e.associateId === associateId)?.photoUrl, associateId })}
        name={name}
        size="sm"
      />
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

/** The first local day a quick-range preset covers. */
function presetFrom(p: RangePreset): string {
  if (p === 'TODAY') return ymdLocal(new Date());
  if (p === 'LAST14') return defaultFromYmd();
  const thisWeekStart = startOfSaturdayWeek(new Date());
  if (p === 'THIS_WEEK') return ymdLocal(thisWeekStart);
  const lastStart = new Date(thisWeekStart);
  lastStart.setDate(lastStart.getDate() - 7);
  return ymdLocal(lastStart);
}

/**
 * The pay period the approval queue opens on: the current one — or, in the
 * days between a period closing and its payday (paid the Friday after, a
 * week on), the just-closed one while it still has no payroll run, because
 * that is the time somebody must approve before the money goes out.
 * `periods` is newest first, as the API sends them. Exported for tests.
 */
export function defaultQueuePeriod(periods: readonly PayPeriod[], today: string): { period: PayPeriod; which: 'CURRENT' | 'LAST' } | null {
  const current = periodContaining(periods, today);
  const closed = latestClosedPeriod(periods, today);
  if (closed && !closed.hasRun) {
    const payday = parseYmd(closed.end);
    if (payday) {
      payday.setDate(payday.getDate() + 7);
      if (today <= ymdLocal(payday)) return { period: closed, which: 'LAST' };
    }
  }
  if (current) return { period: current, which: 'CURRENT' };
  return closed ? { period: closed, which: 'LAST' } : null;
}

/** The period `today` (the reader's local date) falls in. The API's own
 *  `current` flag is decided on the server's UTC date, which on a US Friday
 *  evening is already Saturday — the next period. */
function periodContaining(periods: readonly PayPeriod[], today: string): PayPeriod | null {
  return periods.find((p) => p.start <= today && today <= p.end) ?? null;
}

/** The most recent period that has ended before `today`. */
function latestClosedPeriod(periods: readonly PayPeriod[], today: string): PayPeriod | null {
  return periods.filter((p) => p.end < today).sort((a, b) => (a.end < b.end ? 1 : -1))[0] ?? null;
}

/** The queue's remembered window: a pay period (relative, so it rolls
 *  forward), a quick-range chip, or AUTO (the rule above). */
type RangeChoice = 'AUTO' | 'CURRENT_PERIOD' | 'LAST_PERIOD' | 'TODAY' | 'THIS_WEEK' | 'LAST_WEEK' | 'LAST14';
const RANGE_CHOICES: readonly RangeChoice[] = ['AUTO', 'CURRENT_PERIOD', 'LAST_PERIOD', 'TODAY', 'THIS_WEEK', 'LAST_WEEK', 'LAST14'];

// Quick ranges, offered in the one date picker beside the pay periods (F500
// G2: the period select, three chips and two date fields were three ways to
// set one window). Picking a date by hand is "Custom range", which shows the
// From/To fields. Weeks follow the org Sat→Fri convention.
type RangePreset = 'TODAY' | 'THIS_WEEK' | 'LAST_WEEK' | 'LAST14';
const RANGE_PRESETS: Array<[RangePreset, string]> = [
  ['TODAY', 'Today'],
  ['THIS_WEEK', 'This week'],
  ['LAST_WEEK', 'Last week'],
  ['LAST14', 'Last 14 days'],
];
const RANGE_PRESET_KEYS = RANGE_PRESETS.map(([k]) => k as string);
/** The window picker's value for a hand-picked From/To. */
const CUSTOM_RANGE = 'CUSTOM';

/** Late by more than the grace: the queue's Late chip, and the Late today lens. */
function lateMinutes(e: { clockInAt: string; shiftStartsAt?: string | null }): number | null {
  if (!e.shiftStartsAt) return null;
  const late = Math.floor((new Date(e.clockInAt).getTime() - new Date(e.shiftStartsAt).getTime()) / 60_000);
  return late > LATE_GRACE_MINUTES ? late : null;
}

// "Jun 22 – Jul 5" — compact label for a pay-period option. Bare YYYY-MM-DD
// parses as UTC midnight, so format in UTC or the day shifts west of GMT.
function periodLabel(p: { start: string; end: string }): string {
  return `${fmtDateTz(p.start, 'UTC')} – ${fmtDateTz(p.end, 'UTC')}`;
}

interface AdminTimeViewProps {
  canManage: boolean;
  /** Watch-only mode (FLOOR_SUPERVISOR): live board only — the approval
   *  queue tab is hidden entirely. */
  liveOnly?: boolean;
  /** The viewer's own clock, as one slim row under the title — for people
   *  who run the floor AND punch themselves (one page, one title). */
  personal?: ReactNode;
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

type Tab = 'live' | 'queue' | 'corrections' | 'breaks';

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
  const { moduleOn } = useTenant();
  // Without clients (the client portal module off) there is nothing to pick.
  return (
    <>
      {!moduleOn('clientPortal') ? null : boundedClient ? (
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

export function AdminTimeView({ canManage, liveOnly = false, personal }: AdminTimeViewProps) {
  const term = useTerm();
  const { moduleOn: moduleOnTime } = useTenant();
  // Active tab lives in ?tab= — shareable ("send me the queue"), and Back
  // retraces the live↔queue switch instead of leaving the page.
  const [tabParams, setTabParams] = useSearchParams();
  const tabParam = tabParams.get('tab');
  const tab: Tab = liveOnly ? 'live' : tabParam === 'queue' || ((tabParam === 'corrections' || tabParam === 'breaks') && canManage) ? (tabParam as Tab) : 'live';
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
  // A shift supervisor's board opens on their shift (focus, not a lock —
  // "Whole store" is one tap away): whoever's shift starts in a window they
  // lead, or, with no shift, clocked in for it. Every lens below reads
  // `active`, so the counts, shift picker and table all follow the focus.
  const { windows: myWindows, focus, setFocus, mine } = useShiftFocus();
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
  const [periodKey, setPeriodKey] = useState('');
  // The window the queue opens on, remembered between visits as a choice
  // ("the current pay period", "last week") rather than as dates, so it
  // rolls forward. AUTO = the current period, or the just-closed one until
  // its payday. A deep link that names a window (?from/?to, ?entry) wins,
  // and otherwise the queue waits for the pay periods before it loads.
  const [rangeChoice, setRangeChoice] = usePersistentState<RangeChoice>(
    'alto:list.time.range.v1',
    'AUTO',
    (v): v is RangeChoice => RANGE_CHOICES.includes(v as RangeChoice),
  );
  const [rangeReady, setRangeReady] = useState(
    () => liveOnly || Boolean(tabParams.get('from') || tabParams.get('to') || tabParams.get('entry')),
  );
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
  // The exception tiles' lenses (F500 G2: the tiles are the filter).
  // Late today narrows the queue to late punches; Overtime risk opens the
  // list of people heading past 36 hours. Session-only, like the shift lens.
  const [lateOnly, setLateOnly] = useState(false);
  const [otOpen, setOtOpen] = useState(false);
  // The date fields show only for a hand-picked window ("Custom range").
  const [customRange, setCustomRange] = useState(false);
  // Below md the queue's filters live in a sheet behind "Filters (n)".
  const isDesktop = useMediaQuery('(min-width: 768px)');
  // The table (not the phone's cards) is showing — the grid's own rule.
  const desktopTable = useDesktopTable();
  // The grid's count and Columns render into the filter row (one tray).
  const [gridToolbarEl, setGridToolbarEl] = useState<HTMLElement | null>(null);
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
  // Boundedness is a property of the ROLE, never the account: an
  // org-wide role (WFM, HR) provisioned with an incidental clientId must
  // not self-clamp — that bug emptied the WFM's live board and queue.
  const boundedClient = boundedClientOf(user);
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
  // Bounded roles lack view:clients — the read 403s, the site list stays
  // empty, and the Location select stays disabled. Same graceful
  // degradation as the export dialogs below.
  const sitesQuery = useQuery({
    queryKey: ['clients', clientFilter, 'locations'],
    queryFn: () => listClientLocations(clientFilter),
    enabled: Boolean(clientFilter),
  });
  const locationOptions = useMemo(
    () => (clientFilter ? (sitesQuery.data?.locations ?? []).map((l) => ({ id: l.id, name: l.name })) : []),
    [clientFilter, sitesQuery.data],
  );
  useEffect(() => {
    setLocationFilter('');
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

  // The queue, keyed on everything that narrows it: a filter change is a
  // new question, an answer to an old one can never land last (the
  // sequence guard this replaces), and the previous rows stay on screen
  // until the new ones arrive.
  const focusAssociateId = focusAssociate?.id ?? null;
  const entriesQuery = useQuery({
    queryKey: [
      'time',
      'entries',
      {
        status: filter,
        from: fromYmd,
        to: toYmd,
        search: appliedSearch,
        associateId: focusAssociateId,
        clientId: clientFilter,
        locationId: locationFilter,
      },
    ],
    queryFn: () =>
      listAdminTimeEntries({
        ...(filter !== 'ALL' ? { status: filter } : {}),
        from: ymdToIsoStart(fromYmd),
        to: ymdToIsoEndExclusive(toYmd),
        ...(appliedSearch ? { search: appliedSearch } : {}),
        ...(focusAssociateId ? { associateId: focusAssociateId } : {}),
        ...(clientFilter ? { clientId: clientFilter } : {}),
        ...(locationFilter ? { locationId: locationFilter } : {}),
      }),
    enabled: tab === 'queue' && rangeReady,
    placeholderData: keepPreviousData,
  });
  const entries: TimeEntry[] | null = entriesQuery.data?.entries ?? null;
  // Server hit its row cap — the window has MORE rows than shown.
  const truncated = Boolean(entriesQuery.data?.truncated);

  // The live board: polled every 30s while its tab is open and the page
  // is visible (no point polling a dashboard nobody can see), and re-read
  // the moment the page comes back.
  const activeQuery = useQuery({
    queryKey: ['time', 'active', { clientId: clientFilter, locationId: locationFilter }],
    queryFn: () =>
      getActiveDashboard({
        ...(clientFilter ? { clientId: clientFilter } : {}),
        ...(locationFilter ? { locationId: locationFilter } : {}),
      }),
    // Read on every tab: the Clocked in tile counts it (a "—" there while
    // the queue was open read as "unknown"). Polled fast only on the board.
    staleTime: 0,
    refetchInterval: tab === 'live' ? 30_000 : 2 * 60_000,
    refetchOnWindowFocus: true,
  });
  const activeAll: ActiveDashboardEntry[] | null = activeQuery.data?.entries ?? null;
  const active = useMemo(() => {
    if (!activeAll || !mine) return activeAll;
    return activeAll.filter((e) =>
      e.shiftStartsAt
        ? inWindows(
            { locationId: e.locationId, startsAt: e.shiftStartsAt, timezone: e.locationTimezone ?? '' },
            myWindows,
          )
        : clockInInWindows(e.clockInAt, myWindows),
    );
  }, [activeAll, mine, myWindows]);

  // KPI: the pending backlog — all-time, following the client/site filter
  // so the badge and the queue agree. Best-effort: the last value stays up
  // while a re-read fails. Watch-only mode has no queue and no manage:time;
  // the count endpoint would only 403, so it is not read.
  const pendingQuery = useQuery({
    queryKey: ['time', 'pending-count', { clientId: clientFilter, locationId: locationFilter }],
    queryFn: () =>
      countAdminTimeEntries(
        'COMPLETED',
        {
          ...(clientFilter ? { clientId: clientFilter } : {}),
          ...(locationFilter ? { locationId: locationFilter } : {}),
        },
        { groupBy: 'payPeriod' },
      ),
    enabled: !liveOnly,
    placeholderData: keepPreviousData,
  });
  const pendingCount: number | null = pendingQuery.data?.count ?? null;
  // Where the pending rows sit, per pay period — the same predicate and
  // window the count uses, so the queue can open on the rows the count
  // counted instead of on a current period with nothing in it.
  const pendingByPeriod = pendingQuery.data?.byPeriod ?? null;
  const oldestPendingAt = pendingQuery.data?.oldestPendingAt ?? null;
  const oldestPending = useMemo(() => (pendingByPeriod ? oldestPendingPeriod(pendingByPeriod) : null), [pendingByPeriod]);
  const pendingInPeriod = useCallback(
    (p: { start: string; end: string }) => pendingByPeriod?.find((b) => b.start === p.start && b.end === p.end)?.count ?? 0,
    [pendingByPeriod],
  );

  // The exceptions a manager acts on (missed punches, late today, overtime
  // risk this week), counted by the server from the punches and the
  // schedule, following the client/site filter like the pending count.
  // "Today" is the reader's day, the same window the Late lens lists.
  const todayYmd = ymdLocal(new Date());
  const exceptionsQuery = useQuery({
    queryKey: ['time', 'exceptions', { clientId: clientFilter, locationId: locationFilter, day: todayYmd }],
    queryFn: () =>
      getTimeExceptions({
        ...(clientFilter ? { clientId: clientFilter } : {}),
        ...(locationFilter ? { locationId: locationFilter } : {}),
        dayFrom: ymdToIsoStart(todayYmd),
        dayTo: ymdToIsoEndExclusive(todayYmd),
      }),
    enabled: canManage && !liveOnly,
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  });
  const exceptions = exceptionsQuery.data ?? null;

  // A deep link that names the status (the shared "N timesheets" link
  // carries status=COMPLETED) sets the filter once, so the link opens on
  // the rows it promised rather than on a remembered Approved slice.
  const statusParam = tabParams.get('status');
  useEffect(() => {
    if (statusParam && STATUS_FILTERS.some((f) => f.value === statusParam)) {
      setFilter(statusParam as TimeEntryStatus | 'ALL');
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Time & attendance opens on the queue when nobody is clocked in and
  // something is waiting (role walk ops 19) — an empty Live tab over a
  // "Pending review 6" tile cost a click every visit. Only when the URL
  // names no tab; a person who picks Live keeps Live.
  const autoQueueDone = useRef(false);
  const liveLoaded = activeQuery.data !== undefined;
  const liveEmpty = liveLoaded && (activeQuery.data?.entries.length ?? 0) === 0;
  useEffect(() => {
    if (autoQueueDone.current || liveOnly || !canManage || tabParam !== null) return;
    if (!liveEmpty || !pendingCount || pendingCount <= 0) return;
    autoQueueDone.current = true;
    const params = new URLSearchParams(tabParams);
    params.set('tab', 'queue');
    setTabParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEmpty, pendingCount, tabParam, liveOnly, canManage]);

  // Pay periods change slowly (a run is finalized, a new period starts) —
  // re-read every few minutes rather than trusting a day-old cache. On
  // failure the picker simply stays hidden and the manual From/To range
  // keeps working.
  const payPeriodsQuery = useQuery({
    queryKey: ['time', 'pay-periods'],
    queryFn: () => listPayPeriods(),
    staleTime: 5 * 60_000,
  });
  const payPeriods: PayPeriod[] | null = payPeriodsQuery.isError
    ? []
    : (payPeriodsQuery.data?.periods ?? null);

  const loadError = entriesQuery.error
    ? entriesQuery.error instanceof ApiError
      ? entriesQuery.error.message
      : 'Failed to load.'
    : activeQuery.error
      ? activeQuery.error instanceof ApiError
        ? activeQuery.error.message
        : 'Failed to load active dashboard.'
      : null;

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
  // The entry is read through the cache; the effect consumes the param
  // once that read has settled — found, missing, or failed.
  const entryJump = useQuery({
    queryKey: ['time', 'entries', 'jump', entryParam],
    queryFn: () => listAdminTimeEntries({ entryId: entryParam! }),
    enabled: Boolean(entryParam) && !liveOnly,
    retry: false,
  });
  useEffect(() => {
    if (!entryParam || liveOnly || entryJump.isPending) return;
    {
      const target: TimeEntry | null = entryJump.data?.entries[0] ?? null;
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
    }
    // tabParams/setters change identity every render; entryParam going null
    // after the consume ends the cycle, so they're deliberately not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryParam, liveOnly, entryJump.isPending, entryJump.data]);

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

  // The three re-reads the rest of the page asks for. `refetch` is
  // identity-stable, so these are too, and the memoised rows keep their
  // handlers.
  const { refetch: refetchEntries } = entriesQuery;
  const { refetch: refetchActive } = activeQuery;
  const { refetch: refetchPending } = pendingQuery;
  const { refetch: refetchExceptions } = exceptionsQuery;
  const refresh = useCallback(async () => {
    await refetchEntries();
  }, [refetchEntries]);
  const refreshActive = useCallback(async () => {
    await refetchActive();
  }, [refetchActive]);

  // Pull down at the top = re-fetch both the live board and the queue.
  const pullState = usePullToRefresh(() => Promise.all([refresh(), refreshActive()]));

  // Live-board columns earn their place: the client only for org-wide
  // viewers (a store-bound supervisor's client is every row's), Job and
  // Geofence only when some row actually carries one — never a column of
  // dashes.
  const liveCols = useMemo(() => {
    const rows = active ?? [];
    // Brief 2-1b: no client column at all for a tenant without clients.
    const client = !boundedClient && moduleOnTime('clientPortal');
    const job = rows.some((e) => !!e.jobName);
    const geofence = rows.some((e) => e.geofenceOk !== null);
    return {
      client,
      job,
      geofence,
      span: 4 + (client ? 1 : 0) + (job ? 1 : 0) + (geofence ? 1 : 0) + (canManage ? 1 : 0),
    };
  }, [active, boundedClient, canManage, moduleOnTime]);

  const refreshPendingCount = useCallback(async () => {
    if (liveOnly) return;
    // A decision moves the exception tiles too (an approved missed punch).
    await Promise.all([refetchPending(), canManage ? refetchExceptions() : null]);
  }, [liveOnly, refetchPending, refetchExceptions, canManage]);

  // Refresh after an admin create/edit/clock-out — only the visible tab's
  // data plus the pending-review KPI. The other tab refetches on switch.
  const afterMutation = useCallback(async () => {
    await Promise.all([
      tab === 'queue' ? refresh() : refreshActive(),
      refreshPendingCount(),
    ]);
  }, [tab, refresh, refreshActive, refreshPendingCount]);

  // Debounce free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setAppliedSearch(queueSearch.trim()), 300);
    return () => clearTimeout(id);
  }, [queueSearch]);

  const onPickPeriod = (key: string) => {
    setPeriodKey(key);
    setCustomRange(false);
    if (!key) return; // back to custom range — keep current dates
    const p = (payPeriods ?? []).find((x) => `${x.start}|${x.end}` === key);
    if (!p) return;
    setActivePreset(null);
    setFromYmd(p.start);
    setToYmd(p.end);
    const today = ymdLocal(new Date());
    if (p === periodContaining(payPeriods ?? [], today)) setRangeChoice('CURRENT_PERIOD');
    else if (latestClosedPeriod(payPeriods ?? [], today) === p) setRangeChoice('LAST_PERIOD');
  };

  const applyPreset = (p: RangePreset) => {
    setActivePreset(p);
    setRangeChoice(p);
    setPeriodKey('');
    setCustomRange(false);
    const now = new Date();
    if (p === 'TODAY') {
      setFromYmd(ymdLocal(now));
      setToYmd(ymdLocal(now));
      return;
    }
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

  // First visit to the queue: open on the remembered window once the pay
  // periods are known (with none, the last 14 days stay) — unless the
  // remembered window holds nothing pending while an older period does:
  // then the queue opens on the OLDEST period with pending rows. Three
  // roles used to land on "Nothing to review" under a tile that said 6
  // because the six rows sat in an already-paid period (walk ops 1, floor
  // 1, HR 1). Waits for the pending count only while it is loading.
  useEffect(() => {
    if (rangeReady || payPeriods === null) return;
    if (!liveOnly && pendingQuery.isPending) return;
    setRangeReady(true);
    const today = ymdLocal(new Date());
    const jump = (target: PayPeriod) => {
      setActivePreset(null);
      setPeriodKey(`${target.start}|${target.end}`);
      setFromYmd(target.start);
      setToYmd(target.end);
    };
    const oldestWithPending = (): PayPeriod | null => {
      if (!oldestPending) return null;
      return (
        payPeriods.find((p) => p.start === oldestPending.start && p.end === oldestPending.end) ??
        // A bucket outside every known period: its own day.
        { start: oldestPending.start, end: oldestPending.end, current: false, hasRun: oldestPending.hasRun }
      );
    };
    if (rangeChoice === 'TODAY' || rangeChoice === 'THIS_WEEK' || rangeChoice === 'LAST_WEEK' || rangeChoice === 'LAST14') {
      // A preset window with nothing pending inside it while something
      // older waits: open where the work is.
      const older = oldestWithPending();
      if (older && oldestPendingAt && ymdLocal(new Date(oldestPendingAt)) < presetFrom(rangeChoice)) {
        if (!payPeriods.some((p) => p.start === older.start && p.end === older.end)) {
          setActivePreset(null);
          setPeriodKey('');
          setFromYmd(older.start);
          setToYmd(ymdLocal(new Date()));
        } else jump(older);
        return;
      }
      applyPreset(rangeChoice);
      return;
    }
    const target =
      (rangeChoice === 'CURRENT_PERIOD'
        ? periodContaining(payPeriods, today)
        : rangeChoice === 'LAST_PERIOD'
          ? latestClosedPeriod(payPeriods, today)
          : null) ?? defaultQueuePeriod(payPeriods, today)?.period;
    const older = oldestWithPending();
    if (older && (!target || pendingInPeriod(target) === 0)) {
      if (!payPeriods.some((p) => p.start === older.start && p.end === older.end)) {
        setActivePreset(null);
        setPeriodKey('');
        setFromYmd(older.start);
        setToYmd(older.end);
      } else jump(older);
      return;
    }
    if (!target) return;
    jump(target);
    // Runs once, when the periods and the count arrive; the choice is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeReady, payPeriods, pendingQuery.isPending]);

  // Widen the window to every pending row: the oldest pending day through
  // today. The "N pending entries are older than this period" notice.
  const showAllPending = () => {
    if (!oldestPendingAt) return;
    setActivePreset(null);
    setPeriodKey('');
    setRangeChoice('AUTO');
    setFromYmd(ymdLocal(new Date(oldestPendingAt)));
    setToYmd(ymdLocal(new Date()));
    if (filter !== 'COMPLETED') setFilter('COMPLETED');
  };

  // ── The tiles are the filter (F500 G2) ─────────────────────────────────
  // A lens that switches the (persisted) status filter snapshots it and
  // puts it back when the lens is cleared, the way focus mode does.
  const preLensFilterRef = useRef<TimeEntryStatus | 'ALL' | null>(null);
  const clearLateLens = () => {
    setLateOnly(false);
    const prev = preLensFilterRef.current;
    preLensFilterRef.current = null;
    if (prev !== null && filterRef.current === 'ALL') setFilter(prev);
  };
  /** A window the tile chose, not the reader: never remembered as their choice. */
  const showWindow = (from: string, to: string, preset: RangePreset | null = null) => {
    setPeriodKey('');
    setActivePreset(preset);
    setCustomRange(false);
    setFromYmd(from);
    setToYmd(to);
  };
  const dropAnomalyLens = () => {
    if (anomaliesOnly) setAnomaliesOnly(false);
    setAnomalyTypes([]);
  };
  const openLiveTile = () => {
    setLiveOffSiteOnly(false);
    setOtOpen(false);
    setTab('live');
  };
  // Pending review: every finished punch waiting, where it sits — its one
  // pay period, or from the oldest through today.
  const openPendingTile = () => {
    if (focusAssociate) clearFocus();
    if (lateOnly) clearLateLens();
    setOtOpen(false);
    dropAnomalyLens();
    setFilter('COMPLETED');
    setTab('queue');
    if (!pendingCount || !oldestPending) return;
    const key = `${oldestPending.start}|${oldestPending.end}`;
    if ((pendingByPeriod?.length ?? 0) === 1 && (payPeriods ?? []).some((p) => `${p.start}|${p.end}` === key)) onPickPeriod(key);
    else showAllPending();
  };
  // Missed punches: pending review, flagged "Forgot clock-out", from the
  // oldest such punch through today — the rows the tile counted.
  const openMissedTile = () => {
    if (focusAssociate) clearFocus();
    if (lateOnly) clearLateLens();
    setOtOpen(false);
    setFilter('COMPLETED');
    setAnomaliesOnly(true);
    setAnomalyTypes(['FORGOT_CLOCKOUT']);
    setTab('queue');
    const oldest = exceptions?.missedPunches.oldestAt;
    if (oldest) showWindow(ymdLocal(new Date(oldest)), todayYmd);
  };
  // Late today: every status but rejected, today, late past the grace.
  const openLateTile = () => {
    if (focusAssociate) clearFocus();
    setOtOpen(false);
    dropAnomalyLens();
    if (!lateOnly && preLensFilterRef.current === null) preLensFilterRef.current = filterRef.current;
    setLateOnly(true);
    setFilter('ALL');
    setTab('queue');
    showWindow(todayYmd, todayYmd, 'TODAY');
  };
  const toggleOtTile = () => {
    setTab('queue');
    setOtOpen((v) => !(v && tab === 'queue'));
  };
  // One person from the overtime list: their timesheet for this week.
  const openOtPerson = (p: { associateId: string; name: string }) => {
    setOtOpen(false);
    if (lateOnly) clearLateLens();
    dropAnomalyLens();
    focusWithAllFilter({ id: p.associateId, name: p.name });
    showWindow(exceptions?.overtimeRisk.weekStart ?? presetFrom('THIS_WEEK'), todayYmd, 'THIS_WEEK');
  };
  // The window picker: a pay period, a quick range, or a hand-picked
  // From/To ("Custom range", which shows the date fields).
  const rangeValue = periodKey || (activePreset && !customRange ? activePreset : CUSTOM_RANGE);
  const onPickRange = (v: string) => {
    if (v === CUSTOM_RANGE) {
      setPeriodKey('');
      setActivePreset(null);
      setCustomRange(true);
      return;
    }
    if (RANGE_PRESET_KEYS.includes(v)) {
      applyPreset(v as RangePreset);
      return;
    }
    onPickPeriod(v);
  };
  // Filters off their default — the phone's "Filters (n)" and its Clear.
  const queueActiveFilters =
    (clientFilter && !boundedClient ? 1 : 0) +
    (locationFilter ? 1 : 0) +
    (shiftFilter ? 1 : 0) +
    (anomaliesOnly ? 1 : 0) +
    (lateOnly ? 1 : 0);
  const clearQueueFilters = () => {
    if (!boundedClient && clientFilter) changeClientFilter('');
    setLocationFilter('');
    setShiftFilter('');
    dropAnomalyLens();
    if (lateOnly) clearLateLens();
  };
  const missedLensOn = anomaliesOnly && anomalyTypes.length === 1 && anomalyTypes[0] === 'FORGOT_CLOCKOUT';
  const tileSelected = {
    pending: tab === 'queue' && filter === 'COMPLETED' && !anomaliesOnly && !lateOnly && !otOpen && !focusAssociate,
    missed: tab === 'queue' && missedLensOn && !otOpen,
    late: tab === 'queue' && lateOnly && !otOpen,
    ot: tab === 'queue' && otOpen,
  };

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
  // render an empty queue — drop it (same guard as the shift lens). Only on
  // a settled read: the Missed punches tile picks its type and a new window
  // together, and the previous window's rows (still on screen while the new
  // ones load) must not drop the type it just picked.
  const entriesSettled = !entriesQuery.isFetching;
  useEffect(() => {
    if (!flaggedEntries || !entriesSettled) return;
    setAnomalyTypes((prev) => {
      const next = prev.filter((t) =>
        flaggedEntries.some((e) => e.anomalies?.includes(t)),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [flaggedEntries, entriesSettled]);

  // What the queue actually renders — the shift + anomalies lenses (and
  // the anomaly-type chips inside the latter) apply here so select-all
  // and the empty state follow what's on screen.
  const visibleEntries = useMemo(() => {
    if (!entries) return null;
    let list = entries;
    if (shiftFilter) list = list.filter((e) => matchesShiftPick(e, shiftFilter));
    // Late today: the punches the tile counted — late past the grace, not rejected.
    if (lateOnly) list = list.filter((e) => e.status !== 'REJECTED' && lateMinutes(e) !== null);
    if (!anomaliesOnly) return list;
    list = list.filter((e) => (e.anomalies?.length ?? 0) > 0);
    if (anomalyTypes.length > 0) {
      // Multiple chips OR together.
      list = list.filter((e) =>
        (e.anomalies ?? []).some((a) => anomalyTypes.includes(a)),
      );
    }
    return list;
  }, [entries, anomaliesOnly, shiftFilter, anomalyTypes, lateOnly]);

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

  // Someone else approves your own time: a supervisor with an associate
  // record never gets Approve on her own rows, and select-all skips them
  // (the server refuses with own_entry either way).
  const ownAssociateId = user?.associateId ?? null;
  const isOwnEntry = useCallback((e: TimeEntry) => ownAssociateId !== null && e.associateId === ownAssociateId, [ownAssociateId]);

  const selectableIds = useMemo(() => {
    if (!visibleEntries) return [] as string[];
    // Only COMPLETED rows are bulk-actionable on the Pending review tab.
    return visibleEntries.filter((e) => e.status === 'COMPLETED' && !isOwnEntry(e)).map((e) => e.id);
  }, [visibleEntries, isOwnEntry]);

  // "Select clean only" pool — COMPLETED rows with no anomaly flags, so
  // one click stages the uncontroversial approvals without sweeping in
  // flagged rows the way the header select-all does.
  const cleanSelectableIds = useMemo(() => {
    if (!visibleEntries) return [] as string[];
    return visibleEntries
      .filter((e) => e.status === 'COMPLETED' && (e.anomalies?.length ?? 0) === 0 && !isOwnEntry(e))
      .map((e) => e.id);
  }, [visibleEntries, isOwnEntry]);

  // The pay period a row's clock-in falls in, when that period is paid:
  // approving it now goes on an off-cycle or an adjustment, not a run.
  const knownPeriods = payPeriodsQuery.data?.periods;
  const paidPeriodOf = useCallback(
    (e: TimeEntry): PayPeriod | null => {
      if (!knownPeriods) return null;
      const day = ymdLocal(new Date(e.clockInAt));
      const p = knownPeriods.find((x) => x.start <= day && day <= x.end);
      return p && p.hasRun ? p : null;
    },
    [knownPeriods],
  );

  // Shared selection mechanics; selectableIds carries this page's RULE
  // (only COMPLETED rows). toggleMany is the day-header checkbox in the
  // individual timesheet: select/clear a whole day's pending entries in
  // one click.
  const {
    selected,
    toggle: toggleOne,
    setMany: toggleMany,
    selectAll: selectIds,
    replace: replaceSelection,
    clear: clearSelection,
  } = useSelection(selectableIds);
  // Selection only valid on the COMPLETED filter; a fresh read of the
  // queue drops it, as the loader used to.
  useEffect(() => {
    clearSelection();
  }, [entries, clearSelection]);

  // Keyboard triage over the queue table: j/k (or ↑/↓) move, Enter opens
  // the entry, a approves it, d opens the reject note. Stands down while a
  // drawer or dialog has the keyboard, and in one person's timesheet view
  // (that view has its own buttons).
  const queueKb = useListKeyboard<TimeEntry>({
    items: tab === 'queue' && !focusAssociate ? sortedEntries : [],
    idOf: (e) => e.id,
    onOpen: openDrawer,
    onApprove: canManage ? (e) => { if (e.status === 'COMPLETED') void onApprove(e.id); } : undefined,
    onDecline: canManage ? (e) => { if (e.status === 'COMPLETED') openRejectOne(e.id); } : undefined,
    enabled: tab === 'queue' && !drawerTarget && !editTarget && !createOpen && rejectOpen === null,
  });
  const queueCursor = queueKb.cursor;
  useEffect(() => {
    if (queueCursor) document.getElementById(`time-row-${queueCursor}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [queueCursor]);

  // The live board's columns. Client only for cross-client viewers, Job and
  // Geofence only when some row carries one (see liveCols).
  const liveColumns = useMemo<GridColumn<ActiveDashboardEntry>[]>(
    () => [
      {
        key: 'associate',
        header: term('worker'),
        accessor: (e) => e.associateName,
        sortable: true,
        primary: true,
        cell: (e) => (
          <span className="flex items-center gap-2.5 font-medium">
            <Avatar src={personPhotoUrl({ photoUrl: e.photoUrl, associateId: e.associateId })} name={e.associateName} size="sm" />
            <AssociateLink associateId={e.associateId}>{e.associateName}</AssociateLink>
          </span>
        ),
      },
      ...(liveCols.client
        ? [
            {
              key: 'client',
              header: 'Client',
              accessor: (e) => e.clientName,
              sortable: true,
              cardMeta: true,
              className: 'text-silver',
            } satisfies GridColumn<ActiveDashboardEntry>,
          ]
        : []),
      ...(liveCols.job
        ? [
            {
              key: 'job',
              header: 'Job',
              accessor: (e) => e.jobName,
              sortable: true,
              cardMeta: true,
              className: 'text-silver',
            } satisfies GridColumn<ActiveDashboardEntry>,
          ]
        : []),
      {
        key: 'since',
        header: 'Since',
        accessor: (e) => new Date(e.clockInAt).getTime(),
        csv: (e) => e.clockInAt,
        sortable: true,
        searchable: false,
        className: 'tabular-nums text-silver',
        cell: (e) => fmtPunchTime(e.clockInAt, e.locationTimezone),
      },
      {
        key: 'elapsed',
        header: 'Elapsed',
        accessor: (e) => e.minutesElapsed,
        csv: (e) => formatHM(e.minutesElapsed),
        sortable: true,
        searchable: false,
        className: 'tabular-nums',
        cell: (e) => formatHM(e.minutesElapsed),
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (e) => (e.onBreak ? 'On break' : 'Working'),
        sortable: true,
        cardMeta: true,
        cell: (e) => (e.onBreak ? <Badge variant="pending">On break</Badge> : <Badge variant="success">Working</Badge>),
      },
      ...(liveCols.geofence
        ? [
            {
              key: 'geofence',
              header: 'Geofence',
              accessor: (e) => (e.geofenceOk === null ? 'N/A' : e.geofenceOk ? 'OK' : 'Off-site'),
              sortable: true,
              cardMeta: true,
              cell: (e) =>
                e.geofenceOk === null ? (
                  <span className="text-xs text-silver/70">N/A</span>
                ) : e.geofenceOk ? (
                  <Badge variant="success">OK</Badge>
                ) : (
                  <Badge variant="destructive">Off-site</Badge>
                ),
            } satisfies GridColumn<ActiveDashboardEntry>,
          ]
        : []),
      ...(canManage
        ? [
            {
              key: 'actions',
              header: 'Actions',
              accessor: () => null,
              searchable: false,
              stopRowClick: true,
              align: 'right',
              className: 'whitespace-nowrap',
              cell: (e) => (
                <>
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
                </>
              ),
            } satisfies GridColumn<ActiveDashboardEntry>,
          ]
        : []),
    ],
    [liveCols, canManage, clockOutNow, liveClockOutIds, term],
  );

  // The approval queue's columns. Keys match the page's sort accessors.
  const queueColumns = useMemo<GridColumn<TimeEntry>[]>(
    () => [
      {
        key: 'associate',
        header: term('worker'),
        accessor: (e) => e.associateName,
        sortable: true,
        primary: true,
        stopRowClick: true,
        cell: (e) => (
          <button
            type="button"
            onClick={() => focusOn(e)}
            title="View individual timesheet"
            className="flex items-center gap-2.5 rounded text-left font-medium hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Avatar src={personPhotoUrl({ photoUrl: e.photoUrl, associateId: e.associateId })} name={e.associateName ?? '—'} size="sm" />
            <span className="underline-offset-2 hover:underline">{e.associateName ?? '—'}</span>
          </button>
        ),
      },
      ...(liveCols.client
        ? [
            {
              key: 'client',
              header: 'Client',
              accessor: (e) => e.clientName,
              sortable: true,
              cardMeta: true,
              className: 'text-silver',
            } satisfies GridColumn<TimeEntry>,
          ]
        : []),
      {
        key: 'in',
        header: 'In',
        accessor: (e) => new Date(e.clockInAt).getTime(),
        csv: (e) => e.clockInAt,
        sortable: true,
        searchable: false,
        className: 'tabular-nums',
        cell: (e) => fmtPunchDateTime(e.clockInAt, e.locationTimezone),
      },
      {
        key: 'out',
        header: 'Out',
        accessor: (e) => (e.clockOutAt ? new Date(e.clockOutAt).getTime() : null),
        csv: (e) => e.clockOutAt ?? '',
        sortable: true,
        searchable: false,
        className: 'tabular-nums',
        cell: (e) =>
          e.clockOutAt ? (
            <>
              {fmtPunchTime(e.clockOutAt, e.locationTimezone)}
              <DayOffsetTag entry={e} />
            </>
          ) : (
            '—'
          ),
      },
      {
        key: 'duration',
        header: 'Duration',
        accessor: (e) => e.netMinutes ?? e.minutesElapsed,
        csv: (e) => formatHM(e.netMinutes ?? e.minutesElapsed),
        sortable: true,
        searchable: false,
        cell: (e) => <DurationCell entry={e} />,
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (e) => STATUS_LABELS[e.status],
        sortable: true,
        cell: (e) => (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={statusVariant(e.status)}>{STATUS_LABELS[e.status]}</Badge>
              <LateChip entry={e} />
              {e.status === 'COMPLETED' && paidPeriodOf(e) && (
                <Badge size="sm" variant="pending" title="This pay period has already run — approved time here goes on an off-cycle or an adjustment.">
                  Paid period
                </Badge>
              )}
            </div>
            <AnomalyChips anomalies={e.anomalies} />
            {e.rejectionReason && <div className="mt-1 text-2xs text-alert">{e.rejectionReason}</div>}
          </>
        ),
      },
      ...(canManage
        ? [
            {
              key: 'actions',
              header: 'Actions',
              accessor: () => null,
              searchable: false,
              stopRowClick: true,
              align: 'right',
              className: 'whitespace-nowrap',
              cell: (e) => {
                const isPending = pendingId === e.id;
                // FORGOT_CLOCKOUT + a scheduled end on a non-ACTIVE,
                // approvable row → offer the one-click "approve at the
                // scheduled end" correction.
                const canApproveAtShiftEnd =
                  (e.status === 'COMPLETED' || e.status === 'REJECTED') &&
                  !!e.shiftEndsAt &&
                  (e.anomalies ?? []).includes('FORGOT_CLOCKOUT') &&
                  !isOwnEntry(e);
                return (
                  <div className="inline-flex items-center gap-1 transition-opacity can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Edit entry for ${e.associateName ?? 'associate'}`}
                      title="Edit times"
                      onClick={() => openEditRow(e)}
                      disabled={isPending || bulkBusy}
                      className="opacity-100 transition-opacity focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
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
                        Approve at sched. end {fmtPunchTime(e.shiftEndsAt!, e.locationTimezone)}
                      </Button>
                    )}
                    {(e.status === 'COMPLETED' || e.status === 'REJECTED') && isOwnEntry(e) && (
                      <span className="text-2xs text-silver/70" title="Someone else approves your own time.">
                        Yours — someone else approves it
                      </span>
                    )}
                    {(e.status === 'COMPLETED' || e.status === 'REJECTED') && !isOwnEntry(e) && (
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
                        className="text-alert hover:bg-alert/10 hover:text-alert"
                        onClick={() => openRejectOne(e.id)}
                        disabled={isPending || bulkBusy}
                      >
                        Reject
                      </Button>
                    )}
                  </div>
                );
              },
            } satisfies GridColumn<TimeEntry>,
          ]
        : []),
    ],
    [canManage, focusOn, pendingId, bulkBusy, openEditRow, onApproveAtShiftEnd, onApprove, openRejectOne, term, liveCols.client, isOwnEntry, paidPeriodOf],
  );

  // The phone's queue card: the same columns, folded — "Sep 18 · 1:55 PM–
  // 9:55 PM · 8.00h" under the name, the status and flags inline, and the
  // row's actions as the card's trailing pair (F500 G2: a 230px card per
  // punch put the first one 880px down).
  const queuePhoneColumns = useMemo<GridColumn<TimeEntry>[]>(() => {
    const byKey = new Map(queueColumns.map((c) => [c.key, c] as const));
    const when: GridColumn<TimeEntry> = {
      key: 'when',
      header: 'When',
      accessor: (e) => new Date(e.clockInAt).getTime(),
      searchable: false,
      cardMeta: true,
      cell: (e) => <span className="tabular-nums">{punchSpanLabel(e)}</span>,
    };
    const flags: GridColumn<TimeEntry> = {
      key: 'flags',
      header: 'Status',
      accessor: (e) => STATUS_LABELS[e.status],
      cardMeta: true,
      cell: (e) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          {/* The status the list is filtered to goes without saying. */}
          {e.status !== filter && <Badge variant={statusVariant(e.status)}>{STATUS_LABELS[e.status]}</Badge>}
          <LateChip entry={e} />
          {e.status === 'COMPLETED' && paidPeriodOf(e) && (
            <Badge size="sm" variant="pending">
              Paid period
            </Badge>
          )}
          {(e.anomalies ?? []).map((a) => (
            <span
              key={a}
              className="whitespace-nowrap rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-2xs uppercase tracking-widest text-warning"
            >
              {timeAnomalyLabel(a)}
            </span>
          ))}
        </span>
      ),
    };
    const client = byKey.get('client');
    const actions = byKey.get('actions');
    return [
      byKey.get('associate')!,
      ...(client ? [{ ...client, cardMeta: true }] : []),
      when,
      flags,
      ...(actions ? [actions] : []),
    ];
  }, [queueColumns, paidPeriodOf, filter]);

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      {/* Design system §4.2 (UX upgrade step 6, the sweep): the List template.
          The tabs are the page's two lists; each carries its own filter row. */}
      <ListTemplate
        title="Time & attendance"
        subtitle={
          canManage
            ? `Review, approve, or reject time entries from ${term('workers').toLowerCase()}.`
            : liveOnly
              ? "Live floor view — who's clocked in at your site right now."
              : 'Read-only view of time entries.'
        }
        // One primary action; the client's weekly hours sheet and the kiosk
        // are sibling pages, so they are links (F500 G2: "Timesheets" here
        // opened a third page that shared the word).
        actions={canManage ? [{ key: 'add', label: 'Add entry', icon: Plus, primary: true, onSelect: () => setCreateOpen(true) }] : undefined}
        related={
          canManage
            ? [
                // Client hours are the hours billed to clients: a company with
                // no clients (a hotel running its own staff) has none to show.
                ...(moduleOnTime('clientPortal') ? [{ label: 'Client hours', to: '/time-attendance/timesheets' }] : []),
                { label: 'Kiosk & PINs', to: '/time-attendance/kiosk' },
              ]
            : undefined
        }
        summary={
              <>
          {personal}
          {/* The numbers a time manager acts on, and each tile is the
              filter for its rows (F500 G2): who's on the clock, what waits
              for review, the missed punches, today's late arrivals and the
              people heading into overtime. On a phone the strip is one
              row that scrolls sideways, so the list starts on the first
              screen. */}
          <MetricStrip
            label="Time at a glance"
            className="mb-[var(--d-stack)] max-sm:flex max-sm:snap-x max-sm:overflow-x-auto max-sm:pb-1 max-sm:[&>*]:w-[9.5rem] max-sm:[&>*]:shrink-0 max-sm:[&>*]:snap-start"
          >
            <MetricCard
              key="live"
              icon={Clock3}
              label="Clocked in"
              value={liveStats.total === null ? '—' : String(liveStats.total)}
              hint={
                liveStats.total === null
                  ? undefined
                  : `${liveStats.onBreak ?? 0} on break · ${liveStats.offSite ?? 0} off-site`
              }
              tone="neutral"
              selected={tab === 'live' && !liveOffSiteOnly}
              onClick={openLiveTile}
            />
            {liveOnly ? (
              <MetricCard
                key="break"
                icon={Coffee}
                label="On break"
                value={liveStats.onBreak === null ? '—' : String(liveStats.onBreak)}
                tone="neutral"
                onClick={openLiveTile}
              />
            ) : null}
            {liveOnly ? (
              <MetricCard
                key="offsite"
                icon={MapPinOff}
                label="Off-site"
                value={liveStats.offSite === null ? '—' : String(liveStats.offSite)}
                tone="alert"
                selected={tab === 'live' && liveOffSiteOnly}
                onClick={() => {
                  setLiveOffSiteOnly(true);
                  setTab('live');
                }}
              />
            ) : null}
            {/* Watch-only (FLOOR_SUPERVISOR) never reviews time: no queue,
                no count — the tile read a permanent "—". */}
            {!liveOnly ? (
              <MetricCard
                key="pending"
                icon={ListChecks}
                label="Pending review"
                value={pendingCount === null ? '—' : String(pendingCount)}
                hint={oldestPending && pendingCount ? `Oldest in ${periodLabel(oldestPending)}` : 'Nothing waiting'}
                tone="warning"
                selected={tileSelected.pending}
                onClick={openPendingTile}
              />
            ) : null}
            {canManage && !liveOnly ? (
              <MetricCard
                key="missed"
                icon={TimerOff}
                label="Missed punches"
                value={exceptions ? String(exceptions.missedPunches.count) : '—'}
                hint="Forgot to clock out, waiting for review"
                tone="warning"
                selected={tileSelected.missed}
                onClick={openMissedTile}
              />
            ) : null}
            {canManage && !liveOnly ? (
              <MetricCard
                key="late"
                icon={AlertTriangle}
                label="Late today"
                value={exceptions ? String(exceptions.lateToday.count) : '—'}
                hint={`Clocked in ${LATE_GRACE_MINUTES}+ min after their shift began`}
                tone="warning"
                selected={tileSelected.late}
                onClick={openLateTile}
              />
            ) : null}
            {canManage && !liveOnly ? (
              <MetricCard
                key="ot"
                icon={TrendingUp}
                label="Overtime risk"
                value={exceptions ? String(exceptions.overtimeRisk.count) : '—'}
                hint={`${exceptions?.overtimeRisk.thresholdHours ?? 36}h+ worked and scheduled this week`}
                tone="warning"
                selected={tileSelected.ot}
                onClick={toggleOtTile}
              />
            ) : null}
          </MetricStrip>
              </>
        }
        drawer={
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
        }
      >
      {!liveOnly && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mb-5">
          <TabsList>
            <TabsTrigger value="live">Live (clocked in)</TabsTrigger>
            <TabsTrigger value="queue">Approval queue</TabsTrigger>
            {canManage && <TabsTrigger value="corrections">Punch corrections</TabsTrigger>}
            {canManage && <TabsTrigger value="breaks">Missed breaks</TabsTrigger>}
          </TabsList>
        </Tabs>
      )}

      {(error ?? loadError) && (
        <ErrorBanner className="mb-4">
          <div className="flex items-start gap-2">
            <span className="flex-1">{error ?? loadError}</span>
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

      {tab === 'corrections' && <TimeCorrectionsDesk />}
      {tab === 'breaks' && <BreakFlagsDesk />}
      {tab === 'live' && myWindows.length > 0 && (
        <FocusToggle windows={myWindows} focus={focus} onChange={setFocus} className="mb-3" />
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
                  placeholder={moduleOnTime('clientPortal') ? `Search ${term('worker').toLowerCase()}, client, job…` : `Search ${term('worker').toLowerCase()}, job…`}
                  aria-label={moduleOnTime('clientPortal') ? `Search the live board by ${term('worker').toLowerCase()}, client, or job` : `Search the live board by ${term('worker').toLowerCase()} or job`}
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
              mine && (activeAll?.length ?? 0) > 0 ? (
                <EmptyState
                  title="No one on your shift is clocked in"
                  description={`${activeAll!.length} clocked in on other shifts.`}
                  action={
                    <Button size="sm" variant="secondary" onClick={() => setFocus('store')}>
                      Show the whole store
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="No one is clocked in"
                  description="Active sessions will appear here in real time."
                />
              )
            )}
            {active && active.length > 0 && filteredActive && (
              <>
                {filteredActive.length > 0 && (
                  <DataGrid<ActiveDashboardEntry>
                    id="time-live"
                    caption="Currently clocked in"
                    rows={filteredActive}
                    columns={liveColumns}
                    rowKey={(e) => e.id}
                    urlState={false}
                    search={false}
                    exportCsv={{ filename: 'clocked-in' }}
                    // One table grouped by client when the board spans
                    // several — each place with its headcount and its own
                    // clock-everyone-out. A single client skips the headers.
                    groupBy={
                      showLiveGroups
                        ? {
                            key: (e) => e.clientName ?? 'No client',
                            header: (name, rows) => (
                              <span className="flex items-center gap-2 font-medium text-silver">
                                <span>
                                  {name}
                                  <span className="ml-2 tabular-nums text-silver/60">{rows.length} clocked in</span>
                                </span>
                                {canManage && (
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    className="ml-auto text-silver/70 hover:text-white"
                                    onClick={() => clockOutGroup(rows)}
                                    disabled={rows.some((r) => liveClockOutIds.has(r.id))}
                                    title="Clock everyone in this group out at the current time"
                                  >
                                    Clock out all ({rows.length})
                                  </Button>
                                )}
                              </span>
                            ),
                          }
                        : undefined
                    }
                  />
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
      {/* Overtime risk: who is heading past the line this week — worked so
          far plus the shifts still on their schedule — with a way into each
          person's week. Opened by the Overtime risk tile. */}
      {tab === 'queue' && otOpen && (
        <Card className="mb-4" data-testid="ot-risk-panel">
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 pb-2">
            <div className="min-w-0">
              <CardTitle className="text-base">Overtime risk this week</CardTitle>
              <p className="mt-1 text-xs text-silver">
                {exceptions
                  ? `Worked since ${fmtDateOnly(exceptions.overtimeRisk.weekStart, { weekday: true, year: false })} plus the shifts still on their schedule. ${exceptions.overtimeRisk.thresholdHours} hours or more is listed, while a schedule change can still keep them under 40.`
                  : 'Worked this week plus the shifts still on their schedule.'}
              </p>
            </div>
            <Button size="icon-sm" variant="ghost" onClick={() => setOtOpen(false)} aria-label="Close overtime risk">
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            {!exceptions ? (
              <SkeletonRows count={3} rowHeight="h-10" />
            ) : exceptions.overtimeRisk.people.length === 0 ? (
              <p className="text-sm text-silver">
                No one is on track for {exceptions.overtimeRisk.thresholdHours} hours this week.
              </p>
            ) : (
              <ul className="divide-y divide-navy-secondary">
                {exceptions.overtimeRisk.people.map((p) => (
                  <li key={p.associateId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <button
                      type="button"
                      onClick={() => openOtPerson(p)}
                      className="flex min-w-0 items-center gap-2.5 rounded text-left text-sm font-medium text-white hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                      title="Open this week's timesheet"
                    >
                      <Avatar src={personPhotoUrl({ photoUrl: p.photoUrl, associateId: p.associateId })} name={p.name} size="sm" />
                      <span className="truncate underline-offset-2 hover:underline">{p.name}</span>
                    </button>
                    <span className="ml-auto text-xs tabular-nums text-silver">
                      {fmtHours(Math.round(p.workedMinutes / 6) / 10)} worked
                      {p.scheduledMinutes > 0 ? ` · ${fmtHours(Math.round(p.scheduledMinutes / 6) / 10)} still scheduled` : ''}
                    </span>
                    <span
                      className={cn(
                        'w-24 text-right text-sm font-semibold tabular-nums',
                        p.projectedMinutes > 40 * 60 ? 'text-alert' : 'text-warning',
                      )}
                    >
                      {fmtHours(Math.round(p.projectedMinutes / 6) / 10)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
      {tab === 'queue' && (
        <Card>
          <CardHeader className="pb-3 gap-3">
            {focusAssociate && (
              <FocusBanner
                associateId={focusAssociate.id}
                name={focusAssociate.name}
                entries={entries}
                onClear={clearFocus}
              />
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">
                {focusAssociate ? `${focusAssociate.name} — timesheet` : 'Time entries'}
              </CardTitle>
              {/* Status: one segmented row; on a phone it scrolls sideways
                  instead of wrapping onto a second line. */}
              <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-0.5 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
                <SegmentedControl<TimeEntryStatus | 'ALL'>
                  ariaLabel="Status"
                  className="flex-nowrap sm:flex-wrap"
                  options={STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
                  value={filter}
                  onChange={(v) => {
                    // Picking a status by hand ends the Late lens (it chose ALL).
                    if (lateOnly) {
                      setLateOnly(false);
                      preLensFilterRef.current = null;
                    }
                    setFilter(v);
                  }}
                />
              </div>
            </div>

            {/* Checkboxes + the bulk bar only exist on the Completed filter.
                A reviewer parked on ALL sees neither — say why, with a
                one-click way over, instead of leaving them hunting. */}
            {canManage && filter !== 'COMPLETED' && selectableIds.length > 0 && (
              <p className="text-xs text-silver/70">
                Bulk actions live on the Pending review filter —{' '}
                <Button
                  variant="link"
                  onClick={() => setFilter('COMPLETED')}
                  className="text-xs font-normal text-gold underline hover:text-gold-bright"
                >
                  Switch
                </Button>
              </p>
            )}

            {/* ONE filter row (F500 G2 — it was five): the window (pay
                periods, quick ranges, or a custom From/To), client and site,
                shift, the flag lens, one people search, and one menu for the
                downloads and payroll sheets. The grid's count and Columns
                ride in this row. On a phone the filters fold into a sheet
                behind "Filters (n)" and the list is the first screen. */}
            <FilterBar
              bare
              data-testid="queue-filters"
              search={
                <SearchInput
                  placeholder={`Search ${term('workers').toLowerCase()}…`}
                  aria-label={`Search ${term('workers').toLowerCase()} by name`}
                  value={queueSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                  className="h-9 text-sm"
                />
              }
              activeFilters={queueActiveFilters}
              onClearFilters={clearQueueFilters}
              sheetDescription="Narrow the queue, then close to see the list."
              count={
                <span className="flex items-center gap-2">
                  {canManage && filter === 'COMPLETED' && selected.size === 0 && cleanSelectableIds.length > 0 && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => selectIds(cleanSelectableIds)}
                      disabled={bulkBusy}
                      title="Select only pending entries with no flags"
                    >
                      Select clean ({cleanSelectableIds.length})
                    </Button>
                  )}
                  <span ref={setGridToolbarEl} className="inline-flex items-center gap-2" />
                </span>
              }
              actions={
                // Downloads stay off phones: there is nowhere to put a sheet.
                (canManage || canProcessPayroll) && isDesktop ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" loading={exportBusy !== null} data-testid="export-menu">
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Export &amp; payroll
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[15rem]">
                      <DropdownMenuLabel>This list</DropdownMenuLabel>
                      <DropdownMenuItem onSelect={() => void onExport('csv')} disabled={exportBusy !== null}>
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        CSV
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void onExport('pdf')} disabled={exportBusy !== null}>
                        <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                        PDF
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Payroll</DropdownMenuLabel>
                      <DropdownMenuItem onSelect={() => setSummaryOpen(true)}>
                        <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
                        Hours summary…
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setPayrollOpen(true)}>
                        <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                        Payroll sheet…
                      </DropdownMenuItem>
                      {/* HR Administrator only — export:payroll-pii. Hidden
                          rather than disabled for everyone else: a greyed-out
                          item just advertises that the SSN + bank export
                          exists to roles who can't and shouldn't use it. */}
                      {canExportPayrollPii && (
                        <DropdownMenuItem onSelect={() => setExternalOpen(true)} className="text-warning">
                          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                          External payroll (SSN and bank)…
                        </DropdownMenuItem>
                      )}
                      {canProcessPayroll && (
                        <DropdownMenuItem
                          onSelect={() => setRecordPeriodOpen(true)}
                          title="Document the whole pay run: one row per paid associate, prefilled from approved time, recorded in a single click."
                        >
                          <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                          Record pay period…
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : undefined
              }
            >
              <Select
                id="pay-period-picker"
                aria-label="Pay period or date range"
                value={rangeValue}
                onChange={(e) => onPickRange(e.target.value)}
                className="h-9 w-auto min-w-[12.5rem] text-sm"
              >
                {payPeriods !== null && payPeriods.length > 0 && (
                  <optgroup label="Pay periods">
                    {payPeriods.map((p) => (
                      <option key={`${p.start}|${p.end}`} value={`${p.start}|${p.end}`}>
                        {periodLabel(p)}
                        {p === periodContaining(payPeriods, todayYmd) ? ' · current' : p.hasRun ? ' · paid' : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Quick ranges">
                  {RANGE_PRESETS.map(([preset, label]) => (
                    <option key={preset} value={preset}>
                      {label}
                    </option>
                  ))}
                </optgroup>
                <option value={CUSTOM_RANGE}>Custom range…</option>
              </Select>
              {rangeValue === CUSTOM_RANGE && (
                <div className="flex items-center gap-1.5" role="group" aria-label="Custom range">
                  <Input
                    type="date"
                    aria-label="From"
                    value={fromYmd}
                    max={toYmd}
                    onChange={(e) => {
                      setPeriodKey('');
                      setActivePreset(null);
                      setCustomRange(true);
                      setFromYmd(e.target.value || defaultFromYmd());
                    }}
                    className="h-9 w-[9.5rem] text-sm"
                  />
                  <span className="text-silver/60" aria-hidden="true">–</span>
                  <Input
                    type="date"
                    aria-label="To"
                    value={toYmd}
                    min={fromYmd}
                    onChange={(e) => {
                      setPeriodKey('');
                      setActivePreset(null);
                      setCustomRange(true);
                      setToYmd(e.target.value || defaultToYmd());
                    }}
                    className="h-9 w-[9.5rem] text-sm"
                  />
                </div>
              )}
              <ClientSiteSelects
                boundedClient={boundedClient}
                clients={clients}
                clientFilter={clientFilter}
                onClientChange={changeClientFilter}
                locationFilter={locationFilter}
                onLocationChange={setLocationFilter}
                locationOptions={locationOptions}
              />
              <div
                title={
                  truncated
                    ? 'Options come from the first 500 loaded entries — narrow the date range to see every window. Exports apply the pick across the whole range.'
                    : undefined
                }
              >
                <ShiftWindowSelect
                  id="shift-window-picker"
                  aria-label="Shift"
                  value={shiftFilter}
                  onChange={setShiftFilter}
                  options={shiftOptions}
                  className="h-9 w-auto max-w-48 text-sm"
                />
              </div>
              <FilterChip
                active={anomaliesOnly}
                onClick={() => {
                  // Turning the lens off retires its type chips too.
                  if (anomaliesOnly) setAnomalyTypes([]);
                  setAnomaliesOnly(!anomaliesOnly);
                }}
                className="h-9"
              >
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                Anomalies only
              </FilterChip>
              {lateOnly && (
                <FilterChip active onClick={clearLateLens} className="h-9" aria-label="Late arrivals only — clear">
                  Late arrivals only
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </FilterChip>
              )}
            </FilterBar>

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

          {/* Bulk-action bar — only while something is selected. */}
          {canManage && filter === 'COMPLETED' && selected.size > 0 && (
            <div
              className="mx-5 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/10 px-3 py-2"
              data-testid="bulk-bar"
            >
              <div className="text-sm text-gold">
                <span className="font-medium tabular-nums">{selected.size}</span> selected
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
            {/* The window shows nothing while the count says otherwise: the
                pending rows are older than this period. Say so, with the
                one tap that shows them, instead of "Nothing to review"
                under a tile that says 6. */}
            {visibleEntries &&
              visibleEntries.length === 0 &&
              !anomaliesOnly &&
              !focusAssociate &&
              filter === 'COMPLETED' &&
              pendingCount !== null &&
              pendingCount > 0 &&
              oldestPendingAt !== null &&
              ymdLocal(new Date(oldestPendingAt)) < fromYmd && (
                <div
                  className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
                  role="status"
                >
                  <span>
                    {pendingCount} pending {pendingCount === 1 ? 'entry is' : 'entries are'} older than this period.
                  </span>
                  <Button size="sm" variant="outline" onClick={showAllPending}>
                    Show them
                  </Button>
                </div>
              )}
            {visibleEntries && visibleEntries.length === 0 && (
              <EmptyState
                title={
                  lateOnly
                    ? 'No late arrivals'
                    : anomaliesOnly
                      ? 'No flagged entries'
                      : filter === 'COMPLETED'
                        ? 'Nothing to review'
                        : 'No time entries'
                }
                description={
                  lateOnly
                    ? 'No one clocked in more than 5 minutes after their shift began in this window.'
                    : anomaliesOnly
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
                ownAssociateId={ownAssociateId}
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
              // The list hook's container: ↑/↓ move the cursor only while
              // focus is in here — elsewhere they scroll the page.
              <div {...queueKb.listProps} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-gold/50">
                <DataGrid<TimeEntry>
                  id="time-queue"
                  keyboard={false}
                  caption="Time entries"
                  noun={{ one: 'entry', many: 'entries' }}
                  rows={sortedEntries}
                  // A phone gets one compact row per punch (name; day ·
                  // in–out · hours; the flags inline; Approve/Reject), not
                  // a 2×2 grid of labelled fields.
                  columns={desktopTable ? queueColumns : queuePhoneColumns}
                  toolbar={{ into: gridToolbarEl }}
                  rowKey={(e) => e.id}
                  urlState={false}
                  search={false}
                  exportCsv={false}
                  rowId={(e) => `time-row-${e.id}`}
                  rowClassName={(e) => cn('group', queueCursor === e.id && 'bg-gold/[0.08] shadow-[inset_3px_0_0_0_rgb(var(--color-gold))]')}
                  onRowClick={openDrawer}
                  rowActionLabel={(e) => `Open entry for ${e.associateName ?? 'associate'}`}
                  // The page keeps the order: the drawer's "approve and
                  // next" walks the same list the table shows.
                  sort={{ state: queueSort, onToggle: toggleQueueSort as (key: string) => void }}
                  selectable={
                    canManage && filter === 'COMPLETED'
                      ? {
                          disabled: (e) => e.status !== 'COMPLETED' || isOwnEntry(e),
                          selection: { selected, onChange: replaceSelection },
                          selectAllLabel: 'Select all',
                        }
                      : undefined
                  }
                />
              </div>
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
      </ListTemplate>
    </>
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
  ownAssociateId = null,
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
  /** The viewer's own associate record — their rows get no Approve. */
  ownAssociateId?: string | null;
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
          .filter((e) => e.status === 'COMPLETED' && e.associateId !== ownAssociateId)
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
          isOwn={e.associateId === ownAssociateId}
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
  isOwn = false,
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
  /** The viewer's own entry — someone else approves it. */
  isOwn?: boolean;
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
  const isSelectable = showSelect && e.status === 'COMPLETED' && !isOwn;
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
            {(e.status === 'COMPLETED' || e.status === 'REJECTED') && isOwn && (
              <span className="text-2xs text-silver/70" title="Someone else approves your own time.">
                Yours — someone else approves it
              </span>
            )}
            {(e.status === 'COMPLETED' || e.status === 'REJECTED') && !isOwn && (
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
          <Avatar src={personPhotoUrl({ photoUrl: entry.photoUrl, associateId: entry.associateId })} name={entry.associateName ?? '—'} size="md" />
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
                {fmtPunchDateTime(entry.shiftStartsAt, entry.locationTimezone)}
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
  const term = useTerm();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const associatesQuery = useQuery({
    queryKey: ['scheduling', 'associates'],
    queryFn: () => listSchedulingAssociates(),
  });
  const all = useMemo<Array<{ id: string; name: string; email: string }> | null>(() => {
    if (associatesQuery.isError) return [];
    if (!associatesQuery.data) return null;
    return associatesQuery.data.associates.map((a) => ({
      id: a.id,
      name: `${a.firstName} ${a.lastName}`,
      email: a.email,
    }));
  }, [associatesQuery.data, associatesQuery.isError]);
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
          placeholder={`Search ${term('worker').toLowerCase()} by name or email`}
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

export function TimeEntryFormDrawer({
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
  const linkedStartsAt = mode === 'edit' ? entry?.shiftStartsAt : undefined;
  const linkedEndsAt = mode === 'edit' ? entry?.shiftEndsAt : undefined;
  const linkedShift = useMemo(
    () =>
      linkedStartsAt && linkedEndsAt
        ? { startsAt: linkedStartsAt, endsAt: linkedEndsAt }
        : null,
    [linkedStartsAt, linkedEndsAt],
  );
  const dayShiftsQuery = useQuery({
    queryKey: ['shifts', 'day', dateStr],
    queryFn: () =>
      listShifts({
        from: combineWall(dateStr, '00:00').toISOString(),
        to: combineWall(dateStr, '00:00', 1).toISOString(),
      }),
    enabled: !linkedShift && Boolean(assoc && dateStr),
  });
  const schedShift = useMemo<{ startsAt: string; endsAt: string } | null>(() => {
    if (linkedShift) return linkedShift;
    if (!assoc || !dateStr || !dayShiftsQuery.data) return null;
    return (
      dayShiftsQuery.data.shifts.find(
        (s) =>
          s.assignedAssociateId === assoc.id &&
          s.status !== 'CANCELLED' &&
          s.status !== 'DRAFT',
      ) ?? null
    );
  }, [linkedShift, assoc, dateStr, dayShiftsQuery.data]);

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
            {/* On the same clock the form below is typed in (the site's). */}
            Use scheduled shift {fmtPunchTime(schedShift.startsAt, tz)} –{' '}
            {fmtPunchTime(schedShift.endsAt, tz)}
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
  // Boundedness is a property of the ROLE, never the account: an
  // org-wide role (WFM, HR) provisioned with an incidental clientId must
  // not self-clamp — that bug emptied the WFM's live board and queue.
  const boundedClient = boundedClientOf(user);
  // Shared 5-min-cached client list; only fetched while the dialog is open
  // and the viewer isn't pinned to a single client.
  const { clients } = useClients({ enabled: open && !boundedClient });
  const [clientId, setClientId] = useState(boundedClient?.id ?? '');
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
  }, [clientId]);
  const locationsQuery = useQuery({
    queryKey: ['clients', clientId, 'locations'],
    queryFn: () => listClientLocations(clientId),
    enabled: Boolean(clientId),
  });
  const locations = useMemo(
    () => (clientId ? (locationsQuery.data?.locations ?? []).map((l) => ({ id: l.id, name: l.name })) : []),
    [clientId, locationsQuery.data],
  );

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
  // The period being read — set by the open effect and the Load button;
  // the rows are whatever the cache holds for it.
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [grossById, setGrossById] = useState<Record<string, string>>({});
  const [payDate, setPayDate] = useState('');
  const [method, setMethod] = useState('DIRECT_DEPOSIT');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState<'save' | null>(null);
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

  const prefillQuery = useQuery({
    queryKey: ['time', 'period-prefill', range?.from ?? null, range?.to ?? null],
    queryFn: () => getPeriodPrefill(range!.from, range!.to),
    enabled: open && range !== null,
    retry: false,
  });
  const rows: PeriodPrefillRow[] | null = range ? (prefillQuery.data?.rows ?? null) : null;
  const payTerm = useTerm();
  const payClientsOn = useTenant().moduleOn('clientPortal');
  const loadErr = prefillQuery.error
    ? prefillQuery.error instanceof ApiError
      ? prefillQuery.error.message
      : 'Could not load the period.'
    : null;
  // Each read seeds the sheet: everyone with hours is checked, already-
  // recorded rows too (re-recording just refreshes them — idempotent
  // server-side), and the suggested gross is the starting figure.
  useEffect(() => {
    const r = prefillQuery.data;
    if (!r) return;
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
  }, [prefillQuery.data]);

  const load = (f = fromYmd, t = toYmd) => {
    if (!f || !t || t < f) {
      setErr('Pick a valid pay period (end on or after start).');
      return;
    }
    setErr(null);
    if (range && range.from === f && range.to === t) void prefillQuery.refetch();
    else setRange({ from: f, to: t });
  };

  useEffect(() => {
    if (!open) return;
    setFromYmd(defaultFromYmd);
    setToYmd(defaultToYmd);
    setChecked(new Set());
    setGrossById({});
    setPayDate(defaultToYmd ? ymdAddDays(defaultToYmd, payOffsetDays) : '');
    setReference(suggestNextReference(lastReference));
    setErr(null);
    // The period read is idempotent, so it starts on open when the
    // prefilled dates are already valid; the button stays for hand-edited
    // dates.
    setRange(
      defaultFromYmd && defaultToYmd && defaultToYmd >= defaultFromYmd
        ? { from: defaultFromYmd, to: defaultToYmd }
        : null,
    );
    // payOffsetDays / lastReference: open-time snapshots only —
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
      <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record pay period</DialogTitle>
          <DialogDescription>
            Documents the external pay run for the audit vault — one payment
            row per associate, prefilled from approved time. Re-recording a
            period refreshes it, never duplicates.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {(err ?? loadErr) && <ErrorBanner>{err ?? loadErr}</ErrorBanner>}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label className="text-xs">Period start</Label>
              <Input type="date" value={fromYmd} onChange={(e) => setFromYmd(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Period end</Label>
              <Input type="date" value={toYmd} onChange={(e) => setToYmd(e.target.value)} />
            </div>
            <Button onClick={() => load()} loading={prefillQuery.isFetching} disabled={busy !== null || prefillQuery.isFetching}>
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

              <DataGrid<PeriodPrefillRow>
                id="record-pay-period"
                caption="Approved time in the period"
                rows={rows}
                rowKey={(r) => r.associateId}
                search={false}
                urlState={false}
                exportCsv={false}
                columnChooser={false}
                selectable={{
                  selection: { selected: checked, onChange: setChecked },
                  selectAllLabel: 'Select everyone',
                }}
                className="max-h-80 overflow-y-auto"
                columns={[
                  {
                    key: 'name',
                    header: payTerm('worker'),
                    accessor: (r) => r.fullName,
                    sortable: true,
                    primary: true,
                    cell: (r) => (
                      <span className="text-white">
                        {r.fullName}
                        {payClientsOn && r.clientName && (
                          <span className="ml-1.5 text-2xs text-silver/60">{r.clientName}</span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'reg',
                    header: 'Reg h',
                    accessor: (r) => r.regularHours,
                    sortable: true,
                    align: 'right',
                    className: 'tabular-nums text-silver',
                    cell: (r) => r.regularHours.toFixed(1),
                  },
                  {
                    key: 'ot',
                    header: 'OT h',
                    accessor: (r) => r.overtimeHours,
                    sortable: true,
                    align: 'right',
                    className: 'tabular-nums text-silver',
                    cell: (r) => r.overtimeHours.toFixed(1),
                  },
                  {
                    key: 'gross',
                    header: 'Gross $',
                    accessor: (r) => grossById[r.associateId] ?? '',
                    searchable: false,
                    align: 'right',
                    cardMeta: true,
                    stopRowClick: true,
                    cell: (r) => (
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
                    ),
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    accessor: (r) => (r.alreadyRecorded ? 'recorded' : 'new'),
                    cardMeta: true,
                    className: 'text-2xs',
                    cell: (r) =>
                      r.alreadyRecorded ? (
                        <span className="text-success">recorded ✓</span>
                      ) : (
                        <span className="text-silver/50">new</span>
                      ),
                  },
                ]}
              />

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
  // Boundedness is a property of the ROLE, never the account: an
  // org-wide role (WFM, HR) provisioned with an incidental clientId must
  // not self-clamp — that bug emptied the WFM's live board and queue.
  const boundedClient = boundedClientOf(user);
  const { clients } = useClients({ enabled: open && !boundedClient });
  const [clientId, setClientId] = useState(boundedClient?.id ?? '');
  const [fromYmd, setFromYmd] = useState(defaultFromYmd);
  const [toYmd, setToYmd] = useState(defaultToYmd);
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  // Unverified financial changes the server refused over; each must be
  // ticked before the download is retried with their ids.
  const [blocking, setBlocking] = useState<UnverifiedPacketChange[]>([]);
  const [ackIds, setAckIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setFromYmd(defaultFromYmd);
    setToYmd(defaultToYmd);
    setClientId(boundedClient?.id ?? defaultClientId);
    setErr(null);
    // Re-arm every time. A sticky acknowledgement would defeat the point.
    setAcknowledged(false);
    setBlocking([]);
    setAckIds(new Set());
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
          ...(ackIds.size > 0 ? { acknowledgeChangeIds: [...ackIds] } : {}),
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
      if (e instanceof ApiError && e.code === 'unverified_changes') {
        const list = (e.details as { changes?: UnverifiedPacketChange[] } | undefined)?.changes ?? [];
        setBlocking(list);
        setAckIds(new Set());
        setErr(e.message);
      } else {
        setErr(e instanceof Error ? e.message : 'Export failed.');
      }
    } finally {
      setBusy(null);
    }
  };
  const allAcknowledged = blocking.length === 0 || blocking.every((c) => ackIds.has(c.id));

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

          {blocking.length > 0 && (
            <div className="space-y-2 rounded-md border border-alert/40 bg-alert/[0.07] p-3 text-xs">
              <div className="font-medium text-white">
                Finance has not verified these changes. Verify them in the Finance queue, or acknowledge each
                one to download anyway — your acknowledgment is recorded on the change and on this download.
              </div>
              <ul className="space-y-1.5">
                {blocking.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={ackIds.has(c.id)}
                        onChange={(e) =>
                          setAckIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(c.id);
                            else next.delete(c.id);
                            return next;
                          })
                        }
                        className="mt-0.5 h-3.5 w-3.5 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0"
                      />
                      <span className="min-w-0">
                        <span className="text-white">
                          {c.associateName} — {c.kindLabel}
                          {c.highRisk ? ' (HIGH RISK)' : ''}
                        </span>
                        <span className="block text-silver">
                          {c.oldSummary} → {c.newSummary} · by {c.by} · {c.status === 'HELD' ? 'held' : 'unverified'}
                          {' · '}
                          {/* Straight to this change in the Finance queue, and back here to export. */}
                          <RouterLink to={withReturn(`/payroll/financial-changes?id=${c.id}`, hereAsReturn())} className="text-gold underline">
                            Verify it
                          </RouterLink>
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <RouterLink to={withReturn('/payroll/financial-changes', hereAsReturn())} className="text-gold underline">
                Open the Finance queue
              </RouterLink>
            </div>
          )}

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
            disabled={busy !== null || !acknowledged || !allAcknowledged}
          >
            <FileText className="mr-2 h-4 w-4" />
            PDF
          </Button>
          <Button
            onClick={() => download('xlsx')}
            loading={busy === 'xlsx'}
            disabled={busy !== null || !acknowledged || !allAcknowledged}
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
  // Boundedness is a property of the ROLE, never the account: an
  // org-wide role (WFM, HR) provisioned with an incidental clientId must
  // not self-clamp — that bug emptied the WFM's live board and queue.
  const boundedClient = boundedClientOf(user);
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
