import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  BarChart3,
  ClipboardList,
  Download,
  FileUp,
  LayoutGrid,
  LayoutTemplate,
  List,
  MailPlus,
  MailWarning,
  MessageCircle,
  Plus,
  RotateCcw,
  Search,
  Send,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import type {
  ApplicationStatsResponse,
  ApplicationStatus,
  ApplicationSummary,
} from '@alto-people/shared';
import {
  bulkRejectApplications,
  bulkResendInvite,
  getApplicationStats,
  listApplications,
  nudgeAllStale,
  reopenApplication,
  resendInvite,
} from '@/lib/onboardingApi';
import { CancelInviteDialog, cancelledToast, type AfterCancel, type CancelledInvite } from './CancelInviteDialog';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { listClients } from '@/lib/clientsApi';
import type { ClientSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ProgressBar } from '@/components/ProgressBar';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { StatusBadge } from '@/lib/status';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { FilterChip } from '@/components/ui/FilterBar';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { DataGrid } from '@/components/ui/DataGrid';
import { ViewToggle, useViewMode } from '@/components/ui/ViewToggle';
import { toast } from 'sonner';
import { ApplicationDetailBody } from './ApplicationDetail';
import { BulkApproveDialog } from './BulkApproveDialog';
import { BulkInviteDialog } from './BulkInviteDialog';
import { CsvImportDialog } from './CsvImportDialog';
import { NewApplicationDialog } from './NewApplicationDialog';
import { NudgeDialog } from './NudgeDialog';
import { cn } from '@/lib/cn';
import { usePersistentState } from '@/lib/usePersistentState';

const VIEW_OPTIONS = ['table', 'cards'] as const;
type ApplicationsView = (typeof VIEW_OPTIONS)[number];

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

// Phase 145 — APPROVED and REJECTED roll up under "Archived" by default.
// The chip row exposes the working set + a single click to drill into
// the archive. Real ApplicationStatus values (and the legacy 'ALL') are
// still accepted via URL for power-user / bookmark access.
type StatusFilter =
  | 'ACTIVE'
  | 'ARCHIVED'
  | 'ALL'
  | ApplicationStatus;

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'IN_REVIEW', label: 'In review' },
  { value: 'ARCHIVED', label: 'Archived' },
];

// "Show me who we invited today / this week" — relative presets, safe to
// persist (unlike absolute dates, TODAY recomputes every day).
type InvitedWindow = 'ALL' | 'TODAY' | 'YESTERDAY' | 'LAST7' | 'LAST30';

const INVITED_WINDOWS: Array<{ value: InvitedWindow; label: string }> = [
  { value: 'ALL', label: 'Any time' },
  { value: 'TODAY', label: 'Today' },
  { value: 'YESTERDAY', label: 'Yesterday' },
  { value: 'LAST7', label: 'Last 7 days' },
  { value: 'LAST30', label: 'Last 30 days' },
];

const isInvitedWindow = (v: unknown): v is InvitedWindow =>
  typeof v === 'string' && INVITED_WINDOWS.some((w) => w.value === v);

/** [from, to) instants for a preset, anchored to the ADMIN's local
 *  midnights so "Today" means their today, not the server's. */
function invitedRange(w: InvitedWindow): { invitedFrom?: string; invitedTo?: string } {
  if (w === 'ALL') return {};
  const startOfDay = (offsetDays: number): Date => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return d;
  };
  switch (w) {
    case 'TODAY':
      return { invitedFrom: startOfDay(0).toISOString() };
    case 'YESTERDAY':
      return {
        invitedFrom: startOfDay(-1).toISOString(),
        invitedTo: startOfDay(0).toISOString(),
      };
    case 'LAST7':
      // 7 calendar days including today.
      return { invitedFrom: startOfDay(-6).toISOString() };
    case 'LAST30':
      return { invitedFrom: startOfDay(-29).toISOString() };
  }
}

/** "Today" / "Yesterday" / "3d ago" — CALENDAR days (local midnights),
 *  so a 11pm invite reads "Yesterday" the next morning, not "Today". */
function invitedLabel(iso: string, now: number): string {
  const localMidnight = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round(
    (localMidnight(now) - localMidnight(new Date(iso).getTime())) / ONE_DAY_MS,
  );
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

// Every value setStatus can be handed — the chip row plus the legacy /
// programmatic values ('ALL' via "Clear filters", raw statuses via banners
// and bookmarks). Guards both the persisted value and URL junk.
const STATUS_FILTER_VALUES: readonly StatusFilter[] = [
  'ACTIVE',
  'ARCHIVED',
  'ALL',
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
];

function isStatusFilter(v: unknown): v is StatusFilter {
  return (
    typeof v === 'string' &&
    (STATUS_FILTER_VALUES as readonly string[]).includes(v)
  );
}

const STALE_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Default stats while the /applications/stats request is in-flight, so the
// KPI strip / chip-counts JSX can render without `?.` everywhere.
const EMPTY_STATS: ApplicationStatsResponse = {
  total: 0,
  byStatus: {} as ApplicationStatsResponse['byStatus'],
  inFlight: 0,
  stale: 0,
  bounced: 0,
  avgPercent: 0,
  staleSamples: [],
  bouncedSamples: [],
};

function isStale(a: ApplicationSummary, now: number): boolean {
  if (isTerminal(a)) return false;
  if (a.percentComplete === 100) return false;
  const invitedMs = new Date(a.invitedAt).getTime();
  return now - invitedMs > STALE_DAYS * ONE_DAY_MS;
}

function daysSince(iso: string, now: number): number {
  return Math.floor((now - new Date(iso).getTime()) / ONE_DAY_MS);
}

/** Decided, or called off — nothing more to send or chase. */
function isTerminal(a: ApplicationSummary): boolean {
  return a.status === 'APPROVED' || a.status === 'REJECTED' || a.status === 'CANCELLED';
}

/** Last movement on the application: latest task completion, else the invite. */
function lastActivityIso(a: ApplicationSummary): string {
  return a.lastActivityAt ?? a.invitedAt;
}

/** Idle-days tone for the "Blocked on" column. */
function idleTone(days: number): string {
  if (days >= 7) return 'text-alert';
  if (days >= 3) return 'text-warning';
  return 'text-silver/60';
}

/** Start-date risk chip: unfinished checklist vs. an imminent/past start. */
function startRisk(a: ApplicationSummary, now: number): 'past' | 'at-risk' | null {
  if (!a.startDate || a.percentComplete >= 100 || isTerminal(a)) return null;
  // startDate is a calendar date (YYYY-MM-DD). new Date() on it parses
  // UTC midnight, which flipped "past start" the evening BEFORE the real
  // start west of UTC while the adjacent fmtDate showed the correct day.
  // Anchor at LOCAL end-of-day: a start date is only "past" once that
  // whole day has elapsed for the viewer.
  const d = parseYmd(a.startDate);
  if (!d) return null;
  const endOfStartDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  if (endOfStartDay < now) return 'past';
  if (d.getTime() - now <= 7 * ONE_DAY_MS) return 'at-risk';
  return null;
}

/** Personalized nudge subject/body for the single-row dialog prefill.
 *  "Nudge all stale" composes the same content server-side. The server
 *  appends the portal link, so the body doesn't need one. */
function nudgeContentFor(a: ApplicationSummary): { subject: string; body: string } {
  const firstName = a.associateName.trim().split(/\s+/)[0] || 'there';
  const subject = a.blockedOnTitle
    ? `Quick nudge: ${a.blockedOnTitle}`
    : 'Quick check-in on your onboarding';
  const body = [
    `Hi ${firstName},`,
    '',
    a.blockedOnTitle
      ? `Your onboarding is ${a.percentComplete}% done — the next step is '${a.blockedOnTitle}'. It only takes a few minutes.`
      : `Your onboarding is ${a.percentComplete}% done — just a few tasks left, and each only takes a few minutes.`,
    '',
    "Let us know if you're stuck.",
  ].join('\n');
  return { subject, body };
}

export function ApplicationsList() {
  const { can } = useAuth();
  const canManage = can('manage:onboarding');
  // Superset of canManage (every manage:onboarding role also holds
  // invite:onboarding). Gates the send-and-monitor surface — bulk invite,
  // the progress KPIs, and the per-row nudge/resend actions — so a
  // SHIFT_SUPERVISOR gets those without the HR review affordances.
  const canInvite = can('invite:onboarding');
  const prompt = usePrompt();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  // Default lands on ACTIVE so terminal applications (Approved/Rejected)
  // are hidden until the user explicitly clicks Archived. Legacy URLs
  // with ?status=ALL still pass through unchanged.
  //
  // The URL param stays the source of truth (bookmarks / deep links win),
  // but the last chip the admin clicked is persisted so a clean URL lands
  // on their previous slice instead of always resetting to ACTIVE.
  const [storedStatus, setStoredStatus] = usePersistentState<StatusFilter>(
    'alto:list.applications.status.v1',
    'ACTIVE',
    isStatusFilter,
  );
  const urlStatus = searchParams.get('status');
  const status: StatusFilter = isStatusFilter(urlStatus)
    ? urlStatus
    : storedStatus;
  const clientId = searchParams.get('clientId') ?? '';
  const urlQ = searchParams.get('q') ?? '';
  const [qInput, setQInput] = useState(urlQ);

  // Debounce search input → URL → server fetch.
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (qInput.trim()) next.set('q', qInput.trim());
      else next.delete('q');
      setSearchParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const setStatus = (s: StatusFilter) => {
    // Keep the persisted copy in sync so the choice survives the next visit
    // (and so deleting the ACTIVE param below doesn't resurrect an old value).
    setStoredStatus(s);
    const next = new URLSearchParams(searchParams);
    // Active is the implicit default — omit the param so the URL stays clean.
    if (s === 'ACTIVE') next.delete('status');
    else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const setClientId = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (!id) next.delete('clientId');
    else next.set('clientId', id);
    setSearchParams(next, { replace: true });
  };

  // The visible (filtered, paginated) page of rows.
  // Total count for the *current filter* — drives the pagination footer.
  // 1-indexed page number for the visible rows. Reset on filter change.
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  // Roll-up counts (across the whole tenant scope, ignoring active filters)
  // returned by the dedicated stats endpoint so the KPI strip / banners /
  // chip counts don't require pulling the entire application table to the
  // client every load.
  // Client list for the "Filter by client" dropdown. Loaded once on
  // mount — clients change rarely enough that a cache miss isn't worth
  // the extra plumbing.
  const [openCreate, setOpenCreate] = useState(false);
  // An invite being called off; and after a mistake, the corrected one.
  const [cancelTarget, setCancelTarget] = useState<{ id: string; name: string } | null>(null);
  const [createPrefill, setCreatePrefill] = useState<{ firstName: string; lastName: string; email: string } | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  const [openBulkInvite, setOpenBulkInvite] = useState(false);
  const [openCsvImport, setOpenCsvImport] = useState(false);
  const [resendingIds, setResendingIds] = useState<Set<string>>(new Set());
  const [bulkResending, setBulkResending] = useState(false);
  const [bulkRejecting, setBulkRejecting] = useState(false);
  const [bulkNudging, setBulkNudging] = useState(false);
  const [openBulkApprove, setOpenBulkApprove] = useState(false);

  // Deep link from the command palette ("Invite associate"): ?new=invite
  // opens the invite dialog once, then the param is consumed with a replace
  // navigation so Back / refresh doesn't reopen it. Falls back to Bulk
  // invite for invite-only roles (no manage:onboarding → no single-create).
  // The application page's "send a corrected invite" arrives the same way,
  // carrying the person to prefill in navigation state.
  useEffect(() => {
    if (searchParams.get('new') !== 'invite') return;
    const carried = (location.state as { invitePrefill?: { firstName: string; lastName: string; email: string } } | null)?.invitePrefill;
    if (carried) setCreatePrefill(carried);
    if (canManage) setOpenCreate(true);
    else if (canInvite) setOpenBulkInvite(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, canManage, canInvite, location.state]);

  // Bulk-select state. The set holds applicationIds; "select all" applies
  // to the *currently visible* (filtered) rows so it never spans pages
  // worth of work the user can't see.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The card view keeps its own checkboxes; the table's are the grid's.
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Single-row nudge dialog. Bulk nudge exists too ("Nudge all stale") —
  // bodies are personalized per recipient via nudgeContentFor.
  const [nudgeTarget, setNudgeTarget] = useState<ApplicationSummary | null>(null);

  // Phase 72 — slide-over detail drawer. Click a row → keep the list mounted
  // and show ApplicationDetailBody in the drawer. Direct URL still routes to
  // the standalone page.
  const [drawerTarget, setDrawerTarget] = useState<ApplicationSummary | null>(null);

  // Phase 72 — table / cards view toggle, persisted per-user.
  const [view, setView] = useViewMode<ApplicationsView>('applications', 'table', VIEW_OPTIONS);

  // Invited-date window chips ("who did we invite today?"). Persisted:
  // relative presets recompute daily, so they can't go stale the way an
  // absolute date range would.
  const [invitedWindow, setInvitedWindow] = usePersistentState<InvitedWindow>(
    'alto:list.applications.invited.v1',
    'ALL',
    isInvitedWindow,
  );

  // Sequence guard: changing a filter while on page > 1 fires two fetches
  // (this effect with the stale page, then the page-reset effect with
  // page 1). Without the guard, whichever response lands LAST wins — a
  // stale page-5 result could blank the list with "no applications match"
  // even though page 1 has rows. Same pattern as AdminTimeView.
  // Every input the fetch reads is in the key. The move to the query layer
  // (9fab056f) left a fixed key over five filters and the page number, so
  // changing any of them fetched nothing until an action refreshed the
  // list, and the persisted cache painted whichever fetch came last.
  const listParams = {
    status,
    q: urlQ,
    clientId: clientId || undefined,
    ...invitedRange(invitedWindow),
    page,
    pageSize: PAGE_SIZE,
  };
  const refreshQuery = useQuery({
    queryKey: ['ApplicationsList', 'items', listParams],
    queryFn: () => listApplications(listParams),
  });
  const items: ApplicationSummary[] | null = refreshQuery.data?.applications ?? null;
  const filteredTotal = refreshQuery.data?.total ?? 0;
  const error = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load.' : null;
  const refresh = () => void refreshQuery.refetch();

  const refreshStatsQuery = useQuery({
    queryKey: ['ApplicationsList', 'statsData'],
    queryFn: () => getApplicationStats(),
  });
  const statsData: ApplicationStatsResponse | null = refreshStatsQuery.isError ? null : (refreshStatsQuery.data ? refreshStatsQuery.data : null);
  const refreshStats = () => void refreshStatsQuery.refetch();

  // Reset to page 1 whenever the filter changes — keeps "page 5 of 8" from
  // pointing at nothing after the user narrows results.
  useEffect(() => {
    setPage(1);
  }, [status, urlQ, clientId, invitedWindow]);



  const clientsQuery = useQuery({
    queryKey: ['ApplicationsList', 'clients'],
    queryFn: () => listClients(),
  });
  const clients: ClientSummary[] | null = clientsQuery.isError ? [] : (clientsQuery.data?.clients ?? null);

  const now = Date.now();
  const stats = statsData ?? EMPTY_STATS;

  // Selected rows eligible for bulk approve: checklist finished and not
  // already decided. Warning-gated rows still fail server-side per row —
  // this filter just keeps the obvious non-starters out of the batch.
  const approvableSelected = (items ?? []).filter(
    (a) => selected.has(a.id) && a.percentComplete === 100 && !isTerminal(a),
  );

  // CSV export of the ENTIRE filtered result set — same all-pages loop as
  // PeopleDirectory, so a >1-page backlog doesn't silently truncate.
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const all: ApplicationSummary[] = [];
      let exportPage = 1;
      let total = Infinity;
      while (all.length < total) {
        const res = await listApplications({
          status,
          q: urlQ,
          clientId: clientId || undefined,
          ...invitedRange(invitedWindow),
          page: exportPage,
          pageSize: 200,
        });
        all.push(...res.applications);
        total = res.total;
        if (res.applications.length === 0) break;
        exportPage += 1;
      }
      if (all.length === 0) return;
      downloadCsv(`applications-${ymdLocal()}.csv`, [
        [
          'Name',
          'Client',
          'Position',
          'Track',
          'Status',
          '% complete',
          'Invited',
          'Start date',
          'Blocked on',
        ],
        ...all.map((a) => [
          a.associateName,
          a.clientName,
          a.position ?? '',
          TRACK_LABEL[a.onboardingTrack] ?? a.onboardingTrack,
          a.status,
          a.percentComplete,
          a.invitedAt.slice(0, 10),
          a.startDate ?? '',
          a.blockedOnTitle ?? '',
        ]),
      ]);
    } catch {
      toast.error('Export failed — try again.');
    } finally {
      setExporting(false);
    }
  };

  // After a cancel from a row, a card or the drawer: confirm it, and open
  // the corrected invite when the recruiter asked for one.
  const handleCancelled = (r: CancelledInvite, next: AfterCancel) => {
    cancelledToast(r);
    refresh();
    refreshStats();
    if (next !== 'none') {
      setCreatePrefill(next === 'corrected' ? r.associate : null);
      setOpenCreate(true);
    }
  };

  const onReopen = async (a: ApplicationSummary) => {
    setReopening(a.id);
    try {
      const r = await reopenApplication(a.id);
      if (r.inviteUrl) {
        await navigator.clipboard.writeText(r.inviteUrl).catch(() => {});
        toast.success('Reopened — fresh invite link copied.');
      } else {
        toast.success(
          r.emailed
            ? `Reopened — a new invite link is on its way to ${a.associateName}.`
            : `Reopened — ${a.associateName} already has a login and signs in as before.`,
        );
      }
      refresh();
      refreshStats();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not reopen it.');
    } finally {
      setReopening(null);
    }
  };

  const onResend = async (a: ApplicationSummary) => {
    if (resendingIds.has(a.id)) return;
    // Functional updates — a plain `new Set(resendingIds)` here would close
    // over a stale set and concurrent resends would clear each other.
    setResendingIds((prev) => {
      const n = new Set(prev);
      n.add(a.id);
      return n;
    });
    try {
      const res = await resendInvite(a.id);
      if (res.inviteUrl) {
        await navigator.clipboard.writeText(res.inviteUrl).catch(() => {});
        toast.success('Fresh invite link copied.');
      } else {
        toast.success('Invite re-sent.');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'user_already_active') {
        toast.message('Invite already accepted.', {
          description: `${a.associateName} has already set their password.`,
        });
      } else {
        toast.error('Resend failed.');
      }
    } finally {
      setResendingIds((prev) => {
        const n = new Set(prev);
        n.delete(a.id);
        return n;
      });
    }
  };

  // Drop selections that are no longer in the visible set (e.g. user
  // changed the status filter). Stops the toolbar from showing a count
  // for rows that aren't on screen.
  useEffect(() => {
    if (!items) return;
    const visibleIds = new Set(items.map((a) => a.id));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items]);


  const onBulkResend = async () => {
    if (selected.size === 0 || bulkResending) return;
    const ids = Array.from(selected);
    setBulkResending(true);
    try {
      const res = await bulkResendInvite({ applicationIds: ids });
      if (res.failed === 0) {
        toast.success(`Re-sent ${res.succeeded} invite${res.succeeded === 1 ? '' : 's'}.`);
      } else if (res.succeeded === 0) {
        toast.error(`All ${res.failed} resends failed.`);
      } else {
        // Pull the first failure as the description so HR sees actionable info.
        const firstFail = res.results.find((r) => !r.ok);
        toast.message(`Re-sent ${res.succeeded}, ${res.failed} failed.`, {
          description: firstFail
            ? `e.g. ${firstFail.errorCode}: ${firstFail.errorMessage}`
            : undefined,
        });
      }
      setSelected(new Set());
      refresh();
      refreshStats();
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Bulk resend failed.';
      toast.error('Could not bulk resend.', { description: msg });
    } finally {
      setBulkResending(false);
    }
  };

  const onBulkReject = async () => {
    if (selected.size === 0 || bulkRejecting) return;
    const n = selected.size;
    const reason = (
      await prompt({
        title: `Reject ${n} application${n === 1 ? '' : 's'}?`,
        description:
          'Each candidate (and their manager) is emailed that they were declined. Already-decided applications are skipped. This cannot be undone.',
        reasonLabel: 'Reason for rejection',
        confirmLabel: `Reject ${n}`,
        destructive: true,
      })
    )?.trim();
    if (!reason) return;
    setBulkRejecting(true);
    try {
      const res = await bulkRejectApplications({
        applicationIds: Array.from(selected),
        reason,
      });
      toast.success(
        `Rejected ${res.rejected}${res.skipped.length ? ` · ${res.skipped.length} skipped` : ''}.`,
      );
      setSelected(new Set());
      refresh();
      refreshStats();
    } catch (err) {
      toast.error('Could not bulk reject.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBulkRejecting(false);
    }
  };

  // Bulk nudge — one server-side sweep over EVERY stale application (the
  // stats tile's 7-day rule), not just the loaded page. The server builds
  // the same personalized body nudgeContentFor prefills for a single row.
  const onBulkNudge = async () => {
    if (bulkNudging || stats.stale === 0) return;
    const n = stats.stale;
    const ok = await confirm({
      title: `Nudge ${n} stale applicant${n === 1 ? '' : 's'}?`,
      description:
        `Sends a personalized email to every applicant stuck for more than ${STALE_DAYS} days — across all pages, not just the rows shown. Each mentions the recipient's progress and the task they're stuck on. Doesn't rotate invite tokens.`,
      confirmLabel: `Send ${n} nudge${n === 1 ? '' : 's'}`,
    });
    if (!ok) return;
    setBulkNudging(true);
    try {
      const res = await nudgeAllStale();
      if (res.skipped === 0) {
        toast.success(`Nudged ${res.nudged} applicant${res.nudged === 1 ? '' : 's'}.`);
      } else if (res.nudged === 0) {
        toast.error(`All ${res.skipped} nudges were skipped or failed.`);
      } else {
        toast.message(`Nudged ${res.nudged}, ${res.skipped} skipped.`);
      }
      refresh();
      refreshStats();
    } catch (err) {
      toast.error('Could not nudge stale applicants.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBulkNudging(false);
    }
  };

  return (
    <div className="mx-auto">
      <PageHeader
        title="Onboarding"
        subtitle="Active applications and their checklist progress."
        secondaryActions={
          canInvite ? (
            <>
              {canManage && (
                <>
                  <Link to="/onboarding/analytics">
                    <Button variant="ghost">
                      <BarChart3 className="h-4 w-4" />
                      Analytics
                    </Button>
                  </Link>
                  <Link to="/onboarding/templates">
                    <Button variant="ghost">
                      <LayoutTemplate className="h-4 w-4" />
                      Templates
                    </Button>
                  </Link>
                </>
              )}
              <Button
                variant="secondary"
                onClick={exportCsv}
                disabled={exporting || filteredTotal === 0}
                title="Download the current filtered list as CSV (all pages)"
              >
                <Download className="h-4 w-4" />
                {exporting ? 'Exporting…' : 'Export CSV'}
              </Button>
              <Button variant="secondary" onClick={() => setOpenCsvImport(true)}>
                <FileUp className="h-4 w-4" />
                Import CSV
              </Button>
              <Button variant="secondary" onClick={() => setOpenBulkInvite(true)}>
                <Users className="h-4 w-4" />
                Bulk invite
              </Button>
            </>
          ) : undefined
        }
        primaryAction={
          canManage ? (
            <Button onClick={() => setOpenCreate(true)}>
              <Plus className="h-4 w-4" />
              New application
            </Button>
          ) : undefined
        }
      />

      {/* KPI strip — always visible (empty-zero state is fine). */}
      {canInvite && statsData && statsData.total > 0 && (
        <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 px-4 py-3 rounded-md border border-navy-secondary bg-navy-secondary/30">
          <Kpi label="Total" value={String(stats.total)} />
          <Kpi label="In flight" value={String(stats.inFlight)} />
          <Kpi
            label="Avg. complete"
            value={`${stats.avgPercent}%`}
            tone={
              stats.avgPercent >= 75
                ? 'text-success'
                : stats.avgPercent >= 50
                  ? 'text-warning'
                  : 'text-silver'
            }
          />
          <Kpi
            label={`Stuck > ${STALE_DAYS}d`}
            value={String(stats.stale)}
            tone={stats.stale > 0 ? 'text-alert' : 'text-success'}
            // Same jump-off as the stale banner's "Review": most stuck
            // applicants are invited-but-unfinished (SUBMITTED). Only wired
            // when there's something to review.
            active={stats.stale > 0 && status === 'SUBMITTED'}
            onClick={
              stats.stale > 0 ? () => setStatus('SUBMITTED') : undefined
            }
          />
          <Kpi
            label="Email bounced"
            value={String(stats.bounced)}
            tone={stats.bounced > 0 ? 'text-alert' : 'text-silver'}
          />
          <Kpi
            label="Approved"
            value={String(stats.byStatus.APPROVED ?? 0)}
            tone="text-success"
          />
        </div>
      )}

      {/* Email-bounce banner — fires when at least one in-flight invite/nudge
          came back FAILED from the provider. Distinct from the stale banner
          (which is just "old"); a bounce is *actionable* (fix the email). */}
      {canInvite && stats.bounced > 0 && (
        <div className="mb-4 flex items-start gap-2 p-3 rounded-md border border-alert/40 bg-alert/[0.07] text-sm">
          <MailWarning className="h-4 w-4 text-alert mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-white">
              {stats.bounced} invite{stats.bounced === 1 ? '' : 's'} bounced —
              recipient never received the email
            </div>
            <div className="text-silver text-xs mt-0.5">
              {stats.bouncedSamples.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && ' · '}
                  <Link
                    to={`/onboarding/applications/${a.id}`}
                    className="text-gold hover:text-gold-bright"
                  >
                    {a.associateName}
                  </Link>
                </span>
              ))}
              {stats.bounced > stats.bouncedSamples.length && (
                <span className="text-silver/70">
                  {' '}+ {stats.bounced - stats.bouncedSamples.length} more
                </span>
              )}
              <span className="text-silver/70 ml-2">
                · Open the application to see the provider error and fix the
                email address.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Stale-application banner — only when there's something to nudge about. */}
      {canInvite && stats.stale > 0 && (
        <div className="mb-4 flex items-start gap-2 p-3 rounded-md border border-alert/40 bg-alert/[0.07] text-sm">
          <AlertTriangle className="h-4 w-4 text-alert mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-white">
              {stats.stale} application{stats.stale === 1 ? '' : 's'} stuck for more
              than {STALE_DAYS} days
            </div>
            <div className="text-silver text-xs mt-0.5">
              {stats.staleSamples.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && ' · '}
                  <Link
                    to={`/onboarding/applications/${a.id}`}
                    className="text-gold hover:text-gold-bright"
                  >
                    {a.associateName}
                  </Link>{' '}
                  <span className="text-silver/70 tabular-nums">
                    ({daysSince(a.invitedAt, now)}d)
                  </span>
                </span>
              ))}
              {stats.stale > stats.staleSamples.length && (
                <span className="text-silver/70">
                  {' '}+ {stats.stale - stats.staleSamples.length} more
                </span>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStatus('SUBMITTED')}
            className="shrink-0"
          >
            Review
          </Button>
        </div>
      )}

      {/* Filter row: search input + status pills */}
      {canInvite && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {/* Phone: search gets its own row (basis-full) — sharing one with
              the client picker left it three letters wide. */}
          <div className="relative flex-1 basis-full sm:basis-0 sm:min-w-[200px] sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-silver/70 pointer-events-none" />
            <Input
              type="search"
              placeholder="Search by name or email…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              className="pl-8 pr-8"
            />
            {qInput && (
              <button
                type="button"
                onClick={() => setQInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-silver/70 hover:text-white"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {clients && clients.length > 1 && (
            <Select
              size="sm"
              aria-label="Filter by client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="max-w-[14rem]"
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((f) => {
              const count =
                f.value === 'ALL'
                  ? stats.total
                  : f.value === 'ACTIVE'
                    ? (stats.byStatus.DRAFT ?? 0) +
                      (stats.byStatus.SUBMITTED ?? 0) +
                      (stats.byStatus.IN_REVIEW ?? 0)
                    : f.value === 'ARCHIVED'
                      ? (stats.byStatus.APPROVED ?? 0) +
                        (stats.byStatus.REJECTED ?? 0) +
                        (stats.byStatus.CANCELLED ?? 0)
                      : (stats.byStatus[f.value] ?? 0);
              const active = status === f.value;
              return (
                <FilterChip
                  key={f.value}
                  active={active}
                  onClick={() => setStatus(f.value)}
                >
                  {f.label}
                  {statsData && (
                    <span className="text-2xs tabular-nums text-silver/70">
                      {count}
                    </span>
                  )}
                </FilterChip>
              );
            })}
          </div>
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Filter by invite date"
          >
            <span className="text-2xs uppercase tracking-widest text-silver/70">
              Invited
            </span>
            {INVITED_WINDOWS.map((w) => (
              <FilterChip
                key={w.value}
                active={invitedWindow === w.value}
                onClick={() => setInvitedWindow(w.value)}
              >
                {w.label}
              </FilterChip>
            ))}
          </div>
          {stats.stale > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={onBulkNudge}
              loading={bulkNudging}
              title={`Send a personalized nudge to every applicant stuck for more than ${STALE_DAYS} days — across all pages, not just this one`}
            >
              <MessageCircle className="h-4 w-4" />
              Nudge all stale ({stats.stale})
            </Button>
          )}
          <span className="ml-auto text-2xs text-silver/80 tabular-nums">
            {items ? `${items.length} shown` : ''}
          </span>
          <ViewToggle<ApplicationsView>
            value={view}
            onChange={setView}
            options={[
              { value: 'table', label: 'Table', icon: List },
              { value: 'cards', label: 'Cards', icon: LayoutGrid },
            ]}
          />
        </div>
      )}

      {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

      {!items && !error && (
        <Card>
          <div className="p-2">
            <SkeletonRows count={5} rowHeight="h-14" />
          </div>
        </Card>
      )}

      {items && items.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title={
            urlQ || status !== 'ALL'
              ? 'No applications match this filter'
              : 'No active applications'
          }
          description={
            urlQ || status !== 'ALL'
              ? 'Clear the filter to see all applications.'
              : canManage
                ? 'Click "New application" to invite the first associate.'
                : canInvite
                  ? 'Click "Bulk invite" to send the first onboarding invitation.'
                  : "When HR creates an onboarding application, it'll show up here with live checklist progress."
          }
          action={
            urlQ || status !== 'ALL' ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setQInput('');
                  setStatus('ALL');
                }}
              >
                Clear filters
              </Button>
            ) : canManage ? (
              <Button onClick={() => setOpenCreate(true)}>
                <Plus className="h-4 w-4" />
                New application
              </Button>
            ) : canInvite ? (
              <Button onClick={() => setOpenBulkInvite(true)}>
                <Users className="h-4 w-4" />
                Bulk invite
              </Button>
            ) : undefined
          }
        />
      )}

      <NewApplicationDialog
        open={openCreate}
        onOpenChange={(o) => {
          setOpenCreate(o);
          if (!o) setCreatePrefill(null);
        }}
        onCreated={() => {
          refresh();
          refreshStats();
        }}
        prefill={createPrefill}
      />

      <CancelInviteDialog
        target={cancelTarget}
        onOpenChange={(o) => !o && setCancelTarget(null)}
        onCancelled={handleCancelled}
      />

      <BulkInviteDialog
        open={openBulkInvite}
        onOpenChange={setOpenBulkInvite}
        onCreated={() => {
          refresh();
          refreshStats();
        }}
      />

      <CsvImportDialog
        open={openCsvImport}
        onOpenChange={setOpenCsvImport}
        onImported={() => {
          refresh();
          refreshStats();
        }}
      />

      <BulkApproveDialog
        open={openBulkApprove}
        onOpenChange={setOpenBulkApprove}
        applications={approvableSelected}
        onApproved={() => {
          setSelected(new Set());
          refresh();
          refreshStats();
        }}
      />

      <NudgeDialog
        open={!!nudgeTarget}
        onOpenChange={(v) => !v && setNudgeTarget(null)}
        applicationId={nudgeTarget?.id ?? null}
        associateName={nudgeTarget?.associateName ?? ''}
        suggestedSubject={
          nudgeTarget?.blockedOnTitle
            ? `Quick nudge: ${nudgeTarget.blockedOnTitle}`
            : undefined
        }
        suggestedBody={nudgeTarget ? nudgeContentFor(nudgeTarget).body : undefined}
      />

      {/* Bulk-actions toolbar — only visible when at least one row is selected.
          Sits above the table so it doesn't shift row layout when it appears. */}
      {canInvite && selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 px-3 py-2 rounded-md border border-gold/40 bg-gold/[0.06] text-sm">
          <span className="text-white font-medium">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="secondary"
            onClick={onBulkResend}
            loading={bulkResending}
            disabled={bulkRejecting}
          >
            <MailPlus className="h-4 w-4" />
            Resend invite
          </Button>
          {canManage && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setOpenBulkApprove(true)}
              disabled={
                bulkResending || bulkRejecting || approvableSelected.length === 0
              }
              title={
                approvableSelected.length === 0
                  ? 'No selected rows are 100% complete and undecided'
                  : 'Approve every selected row that is 100% complete'
              }
            >
              <UserCheck className="h-4 w-4" />
              Approve ({approvableSelected.length})
            </Button>
          )}
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onBulkReject}
              loading={bulkRejecting}
              disabled={bulkResending}
              className="text-alert hover:text-alert"
            >
              <Ban className="h-4 w-4" />
              Reject
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
            disabled={bulkRejecting}
          >
            Clear
          </Button>
        </div>
      )}

      {items && items.length > 0 && view === 'table' && (
        <Card className="p-3">
          <DataGrid<(typeof items)[number]>
            id="applications"
            caption="Onboarding applications"
            rows={items}
            rowKey={(a) => a.id}
            search={false}
            urlState={false}
            exportCsv={{ filename: 'applications' }}
            onRowClick={(a) => setDrawerTarget(a)}
            rowActionLabel={(a) => `Open ${a.associateName}`}
            selectable={canInvite ? { selectAllLabel: 'Select all visible', selection: { selected, onChange: setSelected } } : undefined}
            columns={[
              {
                key: 'applicant',
                header: 'Applicant',
                accessor: (a) => a.associateName,
                sortable: true,
                primary: true,
                cell: (a) => {
                  const stale = isStale(a, now);
                  return (
                    <div className="flex items-center gap-2.5">
                      <div className="relative">
                        <Avatar name={a.associateName} size="sm" />
                        {(a.lastInviteDelivery?.status === 'FAILED' || stale) && (
                          <span
                            className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-alert border-2 border-navy grid place-items-center"
                            aria-label={a.lastInviteDelivery?.status === 'FAILED' ? 'Email bounced' : 'Stuck'}
                            title={a.lastInviteDelivery?.status === 'FAILED' ? (a.lastInviteDelivery.failureReason ?? 'Email bounced') : 'Stuck'}
                          >
                            {a.lastInviteDelivery?.status === 'FAILED' ? <MailWarning className="h-2 w-2 text-white" aria-hidden="true" /> : <AlertTriangle className="h-2 w-2 text-white" aria-hidden="true" />}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <span className="text-white font-medium">{a.associateName}</span>
                        {a.position && <div className="text-xs text-silver mt-0.5 truncate">{a.position}</div>}
                      </div>
                    </div>
                  );
                },
              },
              { key: 'client', header: 'Client', accessor: (a) => a.clientName, sortable: true, cardMeta: true, className: 'text-silver' },
              { key: 'track', header: 'Track', accessor: (a) => TRACK_LABEL[a.onboardingTrack] ?? a.onboardingTrack, sortable: true, className: 'text-silver' },
              {
                key: 'invited',
                header: 'Invited',
                accessor: (a) => a.invitedAt,
                csv: (a) => invitedLabel(a.invitedAt, now),
                sortable: true,
                searchable: false,
                className: 'text-xs tabular-nums',
                cell: (a) => <span className={cn(invitedLabel(a.invitedAt, now) === 'Today' ? 'text-gold font-medium' : 'text-silver')}>{invitedLabel(a.invitedAt, now)}</span>,
              },
              {
                key: 'status',
                header: 'Status',
                accessor: (a) => a.status,
                sortable: true,
                cardMeta: true,
                cell: (a) => (
                  <>
                    <StatusBadge status={a.status} data-status={a.status} />
                    {a.updatedAfterSubmitAt && (a.status === 'SUBMITTED' || a.status === 'IN_REVIEW') && (
                      <Badge variant="pending" className="ml-1.5" title={`The applicant changed their information on ${fmtDate(a.updatedAfterSubmitAt)} — re-check before approving.`}>
                        updated
                      </Badge>
                    )}
                  </>
                ),
              },
              {
                key: 'progress',
                header: 'Progress',
                accessor: (a) => a.percentComplete,
                csv: (a) => `${a.percentComplete}%`,
                sortable: true,
                searchable: false,
                width: '14rem',
                cell: (a) => (
                  <div className="flex items-center gap-2">
                    <ProgressBar percent={a.percentComplete} hideLabel className="flex-1" />
                    <span className={cn('text-xs tabular-nums w-9 text-right', a.percentComplete === 100 ? 'text-success font-medium' : a.percentComplete >= 50 ? 'text-gold' : 'text-silver')}>
                      {a.percentComplete}%
                    </span>
                  </div>
                ),
              },
              {
                key: 'blocked',
                header: 'Blocked on',
                accessor: (a) => (isTerminal(a) || a.percentComplete === 100 || !a.blockedOnTitle ? null : a.blockedOnTitle),
                sortable: true,
                className: 'text-xs',
                cell: (a) => {
                  const idleDays = daysSince(lastActivityIso(a), now);
                  return isTerminal(a) || a.percentComplete === 100 || !a.blockedOnTitle ? (
                    <span className="text-silver/50">—</span>
                  ) : (
                    <span className="text-silver">
                      {a.blockedOnTitle}
                      <span className={cn('tabular-nums', idleTone(idleDays))}> · {idleDays}d idle</span>
                    </span>
                  );
                },
              },
              {
                key: 'start',
                header: 'Start',
                accessor: (a) => a.startDate,
                sortable: true,
                searchable: false,
                cardMeta: true,
                className: 'text-xs whitespace-nowrap',
                cell: (a) => {
                  const risk = startRisk(a, now);
                  return (
                    <>
                      <span className="text-silver tabular-nums">{fmtDate(a.startDate)}</span>
                      {risk === 'past' && (
                        <Badge variant="destructive" className="ml-1.5">
                          past start
                        </Badge>
                      )}
                      {risk === 'at-risk' && (
                        <Badge variant="pending" className="ml-1.5">
                          at risk
                        </Badge>
                      )}
                    </>
                  );
                },
              },
              ...(canInvite
                ? [
                    {
                      key: 'actions',
                      header: '',
                      accessor: () => null,
                      searchable: false,
                      csv: () => '',
                      align: 'right' as const,
                      stopRowClick: true,
                      className: 'whitespace-nowrap no-print',
                      cell: (a: (typeof items)[number]) => (
                        <div className="flex items-center justify-end gap-0.5">
                          {canManage && !isTerminal(a) && (
                            <Button asChild variant="ghost" size="sm" title="Onboard in person — open the walk-in workspace">
                              <Link to={`/onboarding/in-person/${a.id}`}>
                                <UserCheck className="h-3.5 w-3.5" />
                              </Link>
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => setNudgeTarget(a)} title="Send nudge email" disabled={isTerminal(a)}>
                            <MessageCircle className="h-3.5 w-3.5" />
                          </Button>
                          {a.status === 'CANCELLED' ? (
                            canManage && (
                              <Button variant="ghost" size="sm" onClick={() => void onReopen(a)} loading={reopening === a.id} title="Reopen with a fresh invite link" aria-label={`Reopen the invite to ${a.associateName}`}>
                                <RotateCcw className="h-3.5 w-3.5" />
                              </Button>
                            )
                          ) : (
                            <Button variant="ghost" size="sm" onClick={() => onResend(a)} loading={resendingIds.has(a.id)} title="Resend invite" disabled={isTerminal(a)}>
                              <Send className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {canManage && !isTerminal(a) && (
                            <Button variant="ghost" size="sm" onClick={() => setCancelTarget({ id: a.id, name: a.associateName })} title="Cancel this invite — sent by mistake, or not joining" aria-label={`Cancel the invite to ${a.associateName}`}>
                              <Ban className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
      )}

      {items && items.length > 0 && view === 'cards' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.map((a) => {
            const stale = isStale(a, now);
            const isSelected = selected.has(a.id);
            return (
              <ApplicationCard
                key={a.id}
                a={a}
                stale={stale}
                isSelected={isSelected}
                canManage={canManage}
                canInvite={canInvite}
                onOpen={() => setDrawerTarget(a)}
                onToggleSelect={() => toggleOne(a.id)}
                onNudge={() => setNudgeTarget(a)}
                onResend={() => onResend(a)}
                resending={resendingIds.has(a.id)}
                onCancel={() => setCancelTarget({ id: a.id, name: a.associateName })}
                onReopen={() => void onReopen(a)}
                reopening={reopening === a.id}
              />
            );
          })}
        </div>
      )}

      {/* Pagination footer — hidden when the whole result set fits on one page,
          so the common case (small client, few applications) shows nothing. */}
      {items && items.length > 0 && filteredTotal > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between gap-3 text-sm text-silver">
          <div className="tabular-nums">
            Showing{' '}
            <span className="text-white">
              {(page - 1) * PAGE_SIZE + 1}
              {'–'}
              {Math.min(page * PAGE_SIZE, filteredTotal)}
            </span>{' '}
            of <span className="text-white">{filteredTotal}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <span className="tabular-nums text-xs text-silver/70">
              Page {page} of {Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE))}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => p + 1)}
              disabled={page * PAGE_SIZE >= filteredTotal}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => {
          if (!o) {
            setDrawerTarget(null);
            // Refresh in case the drawer mutated (skip task / resend).
            refresh();
            refreshStats();
          }
        }}
        width="max-w-2xl"
      >
        {drawerTarget && (
          <>
            <DrawerHeader>
              <DrawerTitle>{drawerTarget.associateName}</DrawerTitle>
              <DrawerDescription>
                {drawerTarget.clientName}
                {drawerTarget.position ? ` · ${drawerTarget.position}` : ''}
              </DrawerDescription>
            </DrawerHeader>
            <DrawerBody>
              <ApplicationDetailBody
                applicationId={drawerTarget.id}
                mode="drawer"
                onCancelled={(r, next) => {
                  setDrawerTarget(null);
                  handleCancelled(r, next);
                }}
              />
            </DrawerBody>
          </>
        )}
      </Drawer>
    </div>
  );
}

interface ApplicationCardProps {
  a: ApplicationSummary;
  stale: boolean;
  isSelected: boolean;
  /** HR review powers — gates the in-person onboarding workspace link. */
  canManage: boolean;
  /** Send/monitor powers — gates selection and the nudge/resend strip. */
  canInvite: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onNudge: () => void;
  onResend: () => void;
  resending: boolean;
  /** Call off the invite (sent by mistake, not joining). */
  onCancel: () => void;
  /** Bring back a cancelled invite. */
  onReopen: () => void;
  reopening: boolean;
}

function ApplicationCard({
  a,
  stale,
  isSelected,
  canManage,
  canInvite,
  onOpen,
  onToggleSelect,
  onNudge,
  onResend,
  resending,
  onCancel,
  onReopen,
  reopening,
}: ApplicationCardProps) {
  const bounced = a.lastInviteDelivery?.status === 'FAILED';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('button, a, input, [data-no-row-click]')) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group relative flex flex-col gap-3 rounded-lg border bg-navy p-4 cursor-pointer transition-colors',
        'hover:border-gold/40',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        isSelected ? 'border-gold/60 bg-gold/[0.04]' : 'border-navy-secondary'
      )}
    >
      <div className="flex items-start gap-3">
        {canInvite && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            aria-label={isSelected ? `Deselect ${a.associateName}` : `Select ${a.associateName}`}
            className="mt-1 h-3.5 w-3.5 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0 cursor-pointer"
          />
        )}
        <Avatar name={a.associateName} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium text-white group-hover:text-gold-bright transition-colors truncate">
              {a.associateName}
            </span>
            {bounced && (
              <span title={a.lastInviteDelivery?.failureReason ?? 'Email bounced'}>
                <MailWarning
                  className="h-3.5 w-3.5 text-alert shrink-0"
                  aria-label="Email bounced"
                />
              </span>
            )}
            {!bounced && stale && (
              <AlertTriangle
                className="h-3.5 w-3.5 text-alert shrink-0"
                aria-label="Stuck"
              />
            )}
          </div>
          <div className="text-xs text-silver mt-0.5 truncate">
            {a.clientName}
            {a.position ? ` · ${a.position}` : ''}
          </div>
        </div>
        <StatusBadge status={a.status} data-status={a.status} className="shrink-0" />
      </div>

      <div>
        <div className="flex items-center justify-between text-2xs uppercase tracking-widest text-silver/80 mb-1">
          <span>Progress</span>
          <span
            className={cn(
              'tabular-nums',
              a.percentComplete === 100
                ? 'text-success font-medium'
                : a.percentComplete >= 50
                  ? 'text-gold'
                  : 'text-silver'
            )}
          >
            {a.percentComplete}%
          </span>
        </div>
        <ProgressBar percent={a.percentComplete} hideLabel />
      </div>

      <div className="flex items-center justify-between text-2xs text-silver/80">
        <span>{TRACK_LABEL[a.onboardingTrack] ?? a.onboardingTrack} track</span>
        <span className="tabular-nums">
          Invited {daysSince(a.invitedAt, Date.now())}d ago
        </span>
      </div>

      {canInvite && (
        <div
          className="flex items-center gap-1 can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
          data-no-row-click
        >
          {canManage && !isTerminal(a) && (
            <Button
              asChild
              variant="ghost"
              size="sm"
              title="Onboard in person"
            >
              <Link
                to={`/onboarding/in-person/${a.id}`}
                onClick={(e) => e.stopPropagation()}
              >
                <UserCheck className="h-3.5 w-3.5" />
                In person
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onNudge();
            }}
            disabled={isTerminal(a)}
            title="Send nudge email"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            Nudge
          </Button>
          {a.status === 'CANCELLED' ? (
            canManage && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onReopen();
                }}
                loading={reopening}
                title="Reopen with a fresh invite link"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reopen
              </Button>
            )
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onResend();
              }}
              loading={resending}
              disabled={isTerminal(a)}
              title="Resend invite"
            >
              <Send className="h-3.5 w-3.5" />
              Resend
            </Button>
          )}
          {canManage && !isTerminal(a) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              title="Cancel this invite — sent by mistake, or not joining"
            >
              <Ban className="h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  tone = 'text-white',
  onClick,
  active,
}: {
  label: string;
  value: string;
  tone?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
        {label}
      </div>
      <div className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</div>
    </>
  );
  if (!onClick) {
    return <div className="min-w-[6rem]">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'min-w-[6rem] text-left rounded-md -mx-1.5 px-1.5 py-0.5 transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        active ? 'bg-gold/10 ring-1 ring-gold/40' : 'hover:bg-navy-secondary/50',
      )}
      title="Review stuck applications"
    >
      {body}
    </button>
  );
}

// Re-export so the existing import path keeps working if anything points at this file.
export { Skeleton };
