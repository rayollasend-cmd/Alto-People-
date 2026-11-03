import { BackgroundProviderPanel } from './providers/BackgroundProviderPanel';
import { nextInQueue } from '@/lib/queueNext';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Download, ExternalLink, FileCheck2, FileSearch, Plus, ShieldCheck } from '@/components/ui/icons';
import { DirectorateHeader, Kpi, KpiStrip, TableShell } from './DirectorateShell';
import { sanitizeReturnPath } from './section2Verification';
import { WORKFORCE_PARAM, WorkforceFilter, useComplianceWorkforce } from './WorkforceFilter';
import { toast } from 'sonner';
import {
  COMPLIANCE_WORKFORCE_LABELS,
  COMPLIANCE_WORKFORCES,
  type AdverseActionStage,
  type BackgroundCheck,
  type BackgroundCheckDetail,
  type BackgroundPendingResponse,
  type BackgroundPendingRow,
  type BackgroundPerson,
  type BgCheckStatus,
  type ComplianceWorkforce,
  type ScreeningRosterGroup,
  type WorkStatus,
} from '@alto-people/shared';
import {
  bulkInitiateBackgroundChecks,
  getBackgroundCheckDetail,
  listAdverseActions,
  listBackgroundChecks,
  listPendingBackgroundChecks,
  sendFinalAdverse,
  sendPreAdverse,
  updateBackgroundCheck,
  withdrawAdverse,
} from '@/lib/complianceApi';
import { useConfirm } from '@/lib/confirm';
import { downloadCsv } from '@/lib/csv';
import { uploadAdminDocument } from '@/lib/documentsApi';
import { DocumentThumbnails } from '@/components/DocumentViewer';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { personPhotoUrl } from '@/lib/photoUrl';
import { fmtDate, fmtDateTime, ymdLocal } from '@/lib/format';
import { usePersistentState } from '@/lib/usePersistentState';
import { useStoreScope } from '@/lib/storeScope';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Select,
  Skeleton,
  SkeletonRows,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { PeopleStatusBadge, workStatusEnglish } from '@/components/ui/PeopleStatusBadge';

/**
 * Background checks — the FCRA screening ledger, about one group of people
 * at a time (owner, 2026-11-03): it opens on the CURRENT workforce, with
 * Starting soon, Paused, Former and All one chip away. Each person shows
 * once, on their newest check ("Earlier checks" brings the history back),
 * so the tiles count PEOPLE and every tile is the rows it filters to. "No
 * passed check" lists the people of the group whose newest check isn't a
 * pass — including the ones never screened at all — and "Last passed" says
 * who is due a re-screen.
 *
 * Failing someone is not a button: it takes the FCRA adverse-action steps
 * (the pre-adverse notice with the report, the wait, the final notice).
 */

// The drawer's buttons. FAILED is not here: the final adverse notice records it.
const TRANSITION_OPTIONS: BgCheckStatus[] = [
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'PASSED',
];

function statusVariant(s: BgCheckStatus): 'default' | 'pending' | 'success' | 'destructive' | 'accent' {
  switch (s) {
    case 'PASSED':
      return 'success';
    case 'FAILED':
      return 'destructive';
    // In-flight work reads gold per the status contract.
    case 'IN_PROGRESS':
      return 'accent';
    case 'NEEDS_REVIEW':
      return 'pending';
    case 'INITIATED':
      return 'default';
    // Never ran: no screening provider is connected (audit 2026-10-21 #3).
    case 'NOT_RUN':
      return 'destructive';
  }
}

const STATUS_LABELS: Record<BgCheckStatus, string> = {
  INITIATED: 'Initiated',
  IN_PROGRESS: 'In progress',
  NEEDS_REVIEW: 'Needs review',
  PASSED: 'Passed',
  FAILED: 'Failed',
  NOT_RUN: 'Not run — no provider',
};

function transitionVariant(
  s: BgCheckStatus,
): 'primary' | 'outline' | 'destructive' {
  if (s === 'PASSED') return 'primary';
  return 'outline';
}

function isTerminal(s: BgCheckStatus): boolean {
  return s === 'PASSED' || s === 'FAILED';
}

function ageInDays(initiatedAt: string): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(initiatedAt).getTime()) / 86_400_000),
  );
}

/** How long ago, in the unit that reads at a glance: "12d", "7 mo", "2 yr". */
function ageWords(iso: string): string {
  const d = ageInDays(iso);
  if (d < 60) return `${d}d ago`;
  if (d < 730) return `${Math.floor(d / 30)} mo ago`;
  return `${Math.floor(d / 365)} yr ago`;
}

/**
 * One row of the list: a check, or — in "No passed check" — a person of the
 * group with no check at all. Person fields are filled either way so the
 * name, badge, client and "Last passed" read the same.
 */
interface Row {
  key: string;
  check: BackgroundCheck | null;
  associateId: string;
  associateName: string;
  associatePhotoUrl?: string | null;
  clientId: string | null;
  clientName: string | null;
  workStatus: WorkStatus | null;
  lastPassedAt: string | null;
  /** The person's newest check (always true for a no-check row). */
  latest: boolean;
}

// Status buckets mirror the KPI strip so a number that alarms someone is
// also a filter they can click: the raw statuses plus the derived buckets
// ("stuck 7d+", "finalized without a report", "no passed check").
type StatusFilter = 'all' | 'in_flight' | 'stuck' | 'missing_report' | 'no_pass' | BgCheckStatus;
const STATUS_FILTER_VALUES: readonly StatusFilter[] = [
  'all',
  'in_flight',
  'stuck',
  'missing_report',
  'no_pass',
  'INITIATED',
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'PASSED',
  'FAILED',
  'NOT_RUN',
];
type InitiatedFilter = 'any' | 'week' | 'month' | 'quarter';

function matchesInitiated(initiatedAt: string, f: InitiatedFilter): boolean {
  if (f === 'any') return true;
  const days = f === 'week' ? 7 : f === 'month' ? 30 : 90;
  return Date.now() - new Date(initiatedAt).getTime() <= days * 86_400_000;
}

function matchesStatus(r: Row, f: StatusFilter): boolean {
  const c = r.check;
  if (f === 'no_pass') return !c || c.status !== 'PASSED';
  if (!c) return false;
  switch (f) {
    case 'all':
      return true;
    case 'in_flight':
      return !isTerminal(c.status) && c.status !== 'NOT_RUN';
    case 'stuck':
      return !isTerminal(c.status) && c.status !== 'NOT_RUN' && ageInDays(c.initiatedAt) >= 7;
    case 'missing_report':
      return isTerminal(c.status) && (c.reportCount ?? 0) === 0;
    default:
      return c.status === f;
  }
}

/** '' = every client; 'none' = rows with no client on record. */
function matchesClient(r: Row, clientFilter: string): boolean {
  return !clientFilter || (clientFilter === 'none' ? !r.clientId : r.clientId === clientFilter);
}

// Stuck-check tone: a background check open 7+ days is worth a look,
// 14+ days is a problem.
function ageTone(days: number): string {
  if (days >= 14) return 'text-alert';
  if (days >= 7) return 'text-warning';
  return 'text-silver';
}

/** The ledger as rows: each check, flagged when it is the person's newest, plus the group's never-screened people. */
function buildRows(checks: BackgroundCheck[], people: BackgroundPerson[]): { checkRows: Row[]; unscreened: Row[] } {
  const byPerson = new Map(people.map((p) => [p.associateId, p]));
  const sorted = [...checks].sort((a, b) => b.initiatedAt.localeCompare(a.initiatedAt) || (a.id < b.id ? 1 : -1));
  const seen = new Set<string>();
  // Someone no longer on file (only under All) has no person row: read their last pass off their checks.
  const passedOn = new Map<string, string>();
  for (const c of sorted) {
    if (c.status !== 'PASSED') continue;
    const at = c.completedAt ?? c.initiatedAt;
    if (!passedOn.has(c.associateId) || at > passedOn.get(c.associateId)!) passedOn.set(c.associateId, at);
  }
  const checkRows = sorted.map((c): Row => {
    const latest = !seen.has(c.associateId);
    seen.add(c.associateId);
    const p = byPerson.get(c.associateId);
    return {
      key: c.id,
      check: c,
      associateId: c.associateId,
      associateName: c.associateName,
      associatePhotoUrl: c.associatePhotoUrl,
      clientId: c.clientId,
      clientName: c.clientName ?? null,
      workStatus: c.workStatus ?? p?.workStatus ?? null,
      lastPassedAt: p ? p.lastPassedAt : passedOn.get(c.associateId) ?? null,
      latest,
    };
  });
  const unscreened = people
    .filter((p) => !p.latestCheckId && !seen.has(p.associateId))
    .map((p): Row => ({
      key: `person:${p.associateId}`,
      check: null,
      associateId: p.associateId,
      associateName: p.associateName,
      associatePhotoUrl: p.associatePhotoUrl,
      clientId: p.clientId,
      clientName: p.clientName ?? null,
      workStatus: p.workStatus,
      lastPassedAt: null,
      latest: true,
    }));
  return { checkRows, unscreened };
}

export function BackgroundTab({ canManage }: { canManage: boolean }) {
  // ?associateId= deep-links one person's check (the scorecard's Fix links,
  // the profile document vault, the application checklist and the provider
  // notices send it) — auto-open their newest check once the ledger
  // arrives, on every group (a link to one person opens on All). ?return=
  // is the surface the reviewer came from; the drawer offers a way back.
  // ?status= (the Inbox) and ?workforce= pick the view for this visit. All
  // are captured into state once, then consumed (replace: true):
  // ComplianceHome tab switches copy the current search params, so
  // lingering params would re-arm on every tab visit and refresh.
  const [deepLinkParams, setDeepLinkParams] = useSearchParams();
  const [deepLinkAssociateId] = useState<string | null>(() =>
    deepLinkParams.get('associateId'),
  );
  const [returnPath] = useState<string | null>(() =>
    sanitizeReturnPath(deepLinkParams.get('return')),
  );
  const [deepLinkStatus] = useState<StatusFilter | null>(() => {
    const v = deepLinkParams.get('status');
    return STATUS_FILTER_VALUES.some((s) => s === v) ? (v as StatusFilter) : null;
  });
  const { workforce, setWorkforce } = useComplianceWorkforce({ wide: !!deepLinkAssociateId });
  // The Inbox's worklist view is two groups at once (?workforce=current,starting
  // — adverse action is mostly about applicants; lead, 2026-11-03). Only the
  // worklist reads a list; the ledger keeps one group. Picking a group ends it.
  const [worklistGroups, setWorklistGroups] = useState<ComplianceWorkforce[] | null>(() => {
    const words = (deepLinkParams.get(WORKFORCE_PARAM) ?? '').split(',');
    const groups = COMPLIANCE_WORKFORCES.filter((w) => words.includes(w));
    return groups.length > 1 ? groups : null;
  });
  const pickWorkforce = (w: ComplianceWorkforce) => {
    setWorklistGroups(null);
    setWorkforce(w);
  };
  const deepLinkOpened = useRef(false);
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (deepLinkConsumed.current) return;
    if (!['associateId', 'return', 'status', WORKFORCE_PARAM].some((k) => deepLinkParams.has(k))) return;
    deepLinkConsumed.current = true;
    const params = new URLSearchParams(deepLinkParams);
    params.delete('associateId');
    params.delete('return');
    params.delete('status');
    params.delete(WORKFORCE_PARAM);
    setDeepLinkParams(params, { replace: true });
  }, [deepLinkParams, setDeepLinkParams]);
  const [errorLocal, setError] = useState<string | null>(null);
  // The record/order dialog, and who it opens on (a never-screened row, a link to someone with no check).
  const [initiateFor, setInitiateFor] = useState<PickedAssociate | null | false>(false);
  const [showBulkOrder, setShowBulkOrder] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<BackgroundCheck | null>(null);
  // A check opened by id (a worklist row outside the list on screen): its
  // detail was read to open it, so the drawer uses that read rather than
  // disclosing the report list a second time.
  const [primedDetail, setPrimedDetail] = useState<BackgroundCheckDetail | null>(null);
  // Search / status / client survive revisits (same idiom as EVerifyTab) —
  // this ledger is worked in passes and losing the slice on every tab
  // switch meant rebuilding it by hand.
  const [query, setQuery] = usePersistentState<string>(
    'alto:list.background.query.v1',
    '',
    (v): v is string => typeof v === 'string',
  );
  const [storedStatusFilter, setStoredStatusFilter] = usePersistentState<StatusFilter>(
    'alto:list.background.status.v1',
    'all',
    (v): v is StatusFilter => STATUS_FILTER_VALUES.some((s) => s === v),
  );
  // A deep link lands on the widest view for this visit only — the linked
  // person must be present whatever their state, but a saved filter the
  // user deliberately chose must not be overwritten (same idiom as I9Tab).
  const [statusOverride, setStatusOverride] = useState<StatusFilter | null>(
    deepLinkStatus ?? (deepLinkAssociateId ? 'all' : null),
  );
  const statusFilter = statusOverride ?? storedStatusFilter;
  const setStatusFilter = (f: StatusFilter) => {
    setStatusOverride(null);
    setStoredStatusFilter(f);
  };
  // Each person once, on their newest check — or every check ever made.
  const [storedHistory, setStoredHistory] = usePersistentState<boolean>(
    'alto:list.background.history.v1',
    false,
    (v): v is boolean => typeof v === 'boolean',
  );
  const [historyOverride, setHistoryOverride] = useState<boolean | null>(deepLinkStatus ? false : null);
  const showHistory = historyOverride ?? storedHistory;
  const setShowHistory = (v: boolean) => {
    setHistoryOverride(null);
    setStoredHistory(v);
  };
  /** A tile is a filter: the rows it counts, one per person. */
  const pickTile = (f: StatusFilter) => {
    setStatusFilter(statusFilter === f ? 'all' : f);
    if (showHistory) setShowHistory(false);
  };
  const [initiatedFilter, setInitiatedFilter] = useState<InitiatedFilter>('any');
  // '' = all clients; 'none' = rows with no client attribution.
  const [clientFilter, setClientFilter] = usePersistentState<string>(
    'alto:list.background.client.v1',
    '',
    (v): v is string => typeof v === 'string',
  );
  // Global Topbar store scope drives the default client filter (same wiring
  // as EVerifyTab): adopt it on arrival when one is chosen, follow later
  // Topbar switches, and push page-level changes back so other modules stay
  // in step. Deep links skip the initial adoption so the scope can't hide
  // the linked row.
  const storeScope = useStoreScope();
  const scopeClientId = storeScope.enabled ? storeScope.clientId : null;
  const scopeSyncedRef = useRef(false);
  useEffect(() => {
    if (scopeClientId === null) return;
    if (!scopeSyncedRef.current) {
      scopeSyncedRef.current = true;
      if (!scopeClientId || deepLinkAssociateId) return;
    }
    setClientFilter((prev) => (prev === scopeClientId ? prev : scopeClientId));
  }, [scopeClientId, deepLinkAssociateId, setClientFilter]);
  const changeClientFilter = (id: string) => {
    setClientFilter(id);
    // 'none' is a page-local synthetic bucket, not a store the scope knows.
    if (id !== 'none') storeScope.setClientId(id);
  };
  const [pendingId, setPendingId] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const refreshQuery = useQuery({
    queryKey: ['BackgroundTab', 'checks', workforce],
    queryFn: () => listBackgroundChecks({ workforce }),
  });
  // Reports for the open drawer — fetched on open (each read is an audited
  // FCRA disclosure server-side), null while loading. gcTime 0 so a
  // re-opened drawer reads (and discloses) afresh instead of replaying a
  // cached copy.
  const primed = primedDetail && drawerTarget && primedDetail.check.id === drawerTarget.id ? primedDetail : null;
  const detailQuery = useQuery({
    queryKey: ['BackgroundTab', 'detail', drawerTarget?.id ?? null],
    queryFn: () => getBackgroundCheckDetail(drawerTarget!.id),
    enabled: drawerTarget !== null && !primed,
    gcTime: 0,
  });
  const detail: BackgroundCheckDetail | null = primed ?? detailQuery.data ?? null;
  const error =
    errorLocal ??
    (refreshQuery.error
      ? refreshQuery.error instanceof ApiError
        ? refreshQuery.error.message
        : 'Failed to load.'
      : detailQuery.error
        ? detailQuery.error instanceof ApiError
          ? detailQuery.error.message
          : 'Could not load the report list.'
        : null);
  const data = refreshQuery.data ?? null;
  const checks = data?.checks ?? null;
  const refresh = async () => {
    setPrimedDetail(null);
    return refreshQuery.refetch();
  };

  const openDrawer = (c: BackgroundCheck) => {
    setPrimedDetail(null);
    setDrawerTarget(c);
  };

  const { checkRows, unscreened } = useMemo(
    () => buildRows(checks ?? [], data?.people ?? []),
    [checks, data?.people],
  );

  // Deep link: open the linked person's newest check as soon as the ledger
  // arrives. Matched against the FULL list, not the filtered view, so a
  // saved filter can never turn the link into a silent no-op — and a
  // person with no check is said so, with a way to order one.
  const [linkedWithoutCheck, setLinkedWithoutCheck] = useState<PickedAssociate | null>(null);
  useEffect(() => {
    if (!deepLinkAssociateId || deepLinkOpened.current || !checks) return;
    deepLinkOpened.current = true;
    const match = checkRows.find((r) => r.check && r.associateId === deepLinkAssociateId && r.latest);
    if (match?.check) {
      setDrawerTarget(match.check);
      return;
    }
    const who = unscreened.find((r) => r.associateId === deepLinkAssociateId);
    setLinkedWithoutCheck({ id: deepLinkAssociateId, name: who?.associateName ?? '' });
  }, [checks, checkRows, unscreened, deepLinkAssociateId]);

  const updateStatus = async (id: string, status: BgCheckStatus) => {
    setPendingId(id);
    try {
      const updated = await updateBackgroundCheck(id, { status });
      const fresh = await refresh();
      setDrawerTarget((prev) =>
        prev ? fresh.data?.checks.find((c) => c.id === prev.id) ?? { ...prev, ...updated } : null,
      );
      void queryClient.invalidateQueries({ queryKey: ['BackgroundTab', 'adverse'] });
    } catch (err) {
      // Said where the person is looking: the drawer sits over the page banner.
      toast.error(err instanceof ApiError ? err.message : 'Update failed.');
    } finally {
      setPendingId(null);
    }
  };

  // A worklist row: open it from the list, or — outside the rows on screen
  // (another group, an earlier check) — load it by id.
  const openCheckById = async (checkId: string) => {
    const hit = checks?.find((c) => c.id === checkId);
    if (hit) {
      openDrawer(hit);
      return;
    }
    try {
      const d = await getBackgroundCheckDetail(checkId);
      setPrimedDetail(d);
      setDrawerTarget(d.check);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not open that check.');
    }
  };

  const clientMatches = (r: Row) => matchesClient(r, clientFilter);
  // One row per person: their newest check, and the people never screened.
  const latestRows = useMemo(() => checkRows.filter((r) => r.latest), [checkRows]);
  const peopleRows = useMemo(() => [...latestRows, ...unscreened], [latestRows, unscreened]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // "No passed check" is about people; the other views are the ledger.
    const base = statusFilter === 'no_pass' ? peopleRows : showHistory ? checkRows : latestRows;
    return base.filter((r) => {
      if (
        q &&
        !r.associateName.toLowerCase().includes(q) &&
        !(r.check?.provider ?? '').toLowerCase().includes(q) &&
        !(r.check?.externalId ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      if (!matchesClient(r, clientFilter)) return false;
      return matchesStatus(r, statusFilter) && (!r.check || matchesInitiated(r.check.initiatedAt, initiatedFilter));
    });
  }, [checkRows, latestRows, peopleRows, query, statusFilter, initiatedFilter, clientFilter, showHistory]);

  // Distinct clients present in the ledger, for the dropdown — derived from
  // the rows themselves so no extra fetch (and no /clients dependency).
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of [...checkRows, ...unscreened]) {
      if (r.clientId && r.clientName) m.set(r.clientId, r.clientName);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [checkRows, unscreened]);
  const hasUnattributed = [...checkRows, ...unscreened].some((r) => !r.clientId);

  // The tiles count PEOPLE of the chosen group (and client): each person on
  // their newest check, so a re-screen is one person, not two "Passed".
  // Each tile is a filter showing exactly the rows it counts.
  const counted = peopleRows.filter(clientMatches);
  const latestChecks = counted.flatMap((r) => (r.check ? [r.check] : []));
  const open = latestChecks.filter((c) => !isTerminal(c.status) && c.status !== 'NOT_RUN');
  const kpi = {
    inFlight: open.length,
    notRun: latestChecks.filter((c) => c.status === 'NOT_RUN').length,
    needsReview: latestChecks.filter((c) => c.status === 'NEEDS_REVIEW').length,
    stuck: open.filter((c) => ageInDays(c.initiatedAt) >= 7).length,
    passed: latestChecks.filter((c) => c.status === 'PASSED').length,
    failed: latestChecks.filter((c) => c.status === 'FAILED').length,
    noPass: counted.filter((r) => !r.check || r.check.status !== 'PASSED').length,
    // A finalized decision with no report on file has no evidence behind it.
    missingReport: latestChecks.filter((c) => isTerminal(c.status) && (c.reportCount ?? 0) === 0).length,
  };
  const groupWord = COMPLIANCE_WORKFORCE_LABELS[workforce].toLowerCase();
  const tile = (f: StatusFilter) => ({ onClick: () => pickTile(f), active: statusFilter === f });
  const hasAnything = (checks?.length ?? 0) > 0 || unscreened.length > 0;

  return (
    <section>
      <DirectorateHeader
        icon={FileSearch}
        title="Background checks"
        blurb="FCRA screening ledger — order, track, and file each provider report next to its decision"
        actions={
          canManage && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setShowBulkOrder(true)}>
                <Download className="h-4 w-4" />
                Bulk order CSV
              </Button>
              <Button onClick={() => setInitiateFor(null)} size="sm">
                <Plus className="h-4 w-4" />
                Record a check
              </Button>
            </>
          )
        }
      />

      {error && (
        <ErrorBanner
          className="mb-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      {linkedWithoutCheck && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface p-3 text-sm text-ink" role="status">
          <span>
            {linkedWithoutCheck.name ? `${linkedWithoutCheck.name} has` : 'The person you followed a link to has'} no background check on file.
          </span>
          <div className="flex gap-2">
            {canManage && (
              <Button size="sm" onClick={() => setInitiateFor(linkedWithoutCheck.name ? linkedWithoutCheck : null)}>
                <Plus className="h-4 w-4" />
                Order a check
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setLinkedWithoutCheck(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <AdverseWorklist
        groups={worklistGroups ?? [workforce]}
        combined={worklistGroups !== null}
        onWorkforce={pickWorkforce}
        onFollowTab={() => setWorklistGroups(null)}
        onOpen={(checkId) => void openCheckById(checkId)}
      />

      {data?.truncated && (
        <p className="mb-3 text-xs text-warning" role="status">
          More checks matched than the list can show. Narrow it with the groups or the filters below.
        </p>
      )}

      {data && hasAnything && (
        <KpiStrip>
          <Kpi label="In flight" value={kpi.inFlight} hint={`People in ${groupWord} whose newest check is still running.`} {...tile('in_flight')} />
          <Kpi
            label="Needs review"
            value={kpi.needsReview}
            tone={kpi.needsReview > 0 ? 'text-warning' : undefined}
            hint="People whose newest report needs a decision."
            {...tile('NEEDS_REVIEW')}
          />
          <Kpi
            label="Stuck 7d+"
            value={kpi.stuck}
            tone={kpi.stuck > 0 ? 'text-alert' : undefined}
            hint="People whose newest check has been running a week or more."
            {...tile('stuck')}
          />
          {kpi.notRun > 0 && <Kpi label="Not run — no provider" value={kpi.notRun} tone="text-alert" hint="Consent on file, but no check ran: no screening provider is connected." {...tile('NOT_RUN')} />}
          <Kpi label="Passed" value={kpi.passed} tone="text-success" hint="People whose newest check passed." {...tile('PASSED')} />
          <Kpi
            label="Failed"
            value={kpi.failed}
            tone={kpi.failed > 0 ? 'text-alert' : undefined}
            hint="People whose newest check failed after the adverse-action steps."
            {...tile('FAILED')}
          />
          <Kpi
            label="No passed check"
            value={kpi.noPass}
            of={counted.length}
            tone={kpi.noPass > 0 ? 'text-warning' : undefined}
            hint={`People in ${groupWord} whose newest check isn't a pass — never screened, never ran, failed or still running.`}
            {...tile('no_pass')}
          />
          <Kpi
            label="Finalized, no report"
            value={kpi.missingReport}
            tone={kpi.missingReport > 0 ? 'text-warning' : undefined}
            hint="People whose newest check was decided with no report on file."
            {...tile('missing_report')}
          />
        </KpiStrip>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <WorkforceFilter value={workforce} onChange={pickWorkforce} counts={data?.workforceCounts} />
      </div>
      {data && hasAnything && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, provider, or reference…"
            wrapperClassName="w-full sm:w-72"
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            size="sm"
            className="w-auto"
            aria-label="Filter by check status"
          >
            <option value="all">All statuses</option>
            <option value="no_pass">No passed check</option>
            <option value="in_flight">In flight (not finalized)</option>
            <option value="INITIATED">Initiated</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="NEEDS_REVIEW">Needs review</option>
            <option value="PASSED">Passed</option>
            <option value="FAILED">Failed</option>
            <option value="NOT_RUN">Not run — no provider</option>
            <option value="stuck">Stuck 7d+</option>
            <option value="missing_report">Finalized, no report</option>
          </Select>
          <Select
            value={clientFilter}
            onChange={(e) => changeClientFilter(e.target.value)}
            size="sm"
            className="w-auto"
            aria-label="Filter by client"
          >
            <option value="">All clients</option>
            {clientOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
            {hasUnattributed && <option value="none">No client on record</option>}
          </Select>
          <Select
            value={initiatedFilter}
            onChange={(e) => setInitiatedFilter(e.target.value as InitiatedFilter)}
            size="sm"
            className="w-auto"
            aria-label="Filter by initiated date"
          >
            <option value="any">Initiated any time</option>
            <option value="week">Initiated in the last 7 days</option>
            <option value="month">Initiated in the last 30 days</option>
            <option value="quarter">Initiated in the last 90 days</option>
          </Select>
          {statusFilter !== 'no_pass' && (
            <FilterChip
              active={showHistory}
              onClick={() => setShowHistory(!showHistory)}
              title="Each person shows once, on their newest check. Turn on to list every check ever made, re-screens included."
            >
              Earlier checks
            </FilterChip>
          )}
        </div>
      )}

      {!data && !error && <SkeletonRows count={4} rowHeight="h-12" />}
      {data && !hasAnything && (
        <EmptyState
          icon={ShieldCheck}
          title={workforce === 'all' ? 'No background checks yet' : `No one in ${groupWord}`}
          description={
            workforce !== 'all'
              ? 'Nobody in this group has a check or needs one. Pick another group above.'
              : canManage
                ? 'New hires should run through onboarding, which initiates a check automatically. Manual initiation is here for back-fills.'
                : 'Background checks will appear here once they are initiated.'
          }
          action={
            canManage && workforce === 'all' ? (
              <Button onClick={() => setInitiateFor(null)} size="sm">
                <Plus className="h-4 w-4" />
                Record a check
              </Button>
            ) : undefined
          }
        />
      )}
      {data && hasAnything && visible.length === 0 && (
        checkRows.length === 0 && statusFilter !== 'no_pass' ? (
          // Nobody in the group has a check, but people in it need one: say so, not "no match".
          <EmptyState
            icon={ShieldCheck}
            title={`No background checks in ${groupWord}`}
            description={`${unscreened.length} ${unscreened.length === 1 ? 'person here has' : 'people here have'} never been screened.`}
            action={
              <Button size="sm" variant="secondary" onClick={() => setStatusFilter('no_pass')}>
                Show who has no passed check
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={ShieldCheck}
            title="Nobody matches this filter"
            description="Clear the search, status, client, or initiated-date filter, or pick another group."
          />
        )
      )}
      {data && visible.length > 0 && (
        <TableShell>
        <DataGrid<Row>
          id="background-checks"
          caption="Background checks"
          rows={visible}
          rowKey={(x) => x.key}
          search={false}
          urlState={false}
          exportCsv={{ filename: `background-checks-${workforce}-${ymdLocal()}` }}
          onRowClick={(x) => (x.check ? openDrawer(x.check) : canManage ? setInitiateFor({ id: x.associateId, name: x.associateName }) : undefined)}
          rowActionLabel={(x) => (x.check ? `Open ${x.associateName}` : canManage ? `Order a check for ${x.associateName}` : `${x.associateName} has no check`)}
          columns={[
            {
              key: 'associate',
              header: 'Associate',
              accessor: (x) => x.associateName,
              sortable: true,
              primary: true,
              className: 'font-medium',
              cell: (x) => (
                <div className="flex items-center gap-2.5">
                  <Avatar src={personPhotoUrl({ photoUrl: x.associatePhotoUrl, associateId: x.associateId })} name={x.associateName} size="sm" />
                  <div className="min-w-0">
                    <div className="truncate">{x.associateName}</div>
                    {x.clientName && <div className="text-2xs text-silver/60 truncate">{x.clientName}</div>}
                  </div>
                </div>
              ),
            },
            {
              key: 'employment',
              header: 'Employment',
              accessor: (x) => (x.workStatus ? workStatusEnglish(x.workStatus) : 'No longer on file'),
              sortable: true,
              cardMeta: true,
              cell: (x) => (x.workStatus ? <PeopleStatusBadge status={x.workStatus} size="sm" /> : <span className="text-xs text-silver/60">No longer on file</span>),
            },
            {
              key: 'provider',
              header: 'Provider',
              accessor: (x) => x.check?.provider ?? null,
              sortable: true,
              cardMeta: true,
              className: 'text-silver',
              cell: (x) =>
                x.check ? (
                  <>
                    <div>{x.check.provider}</div>
                    {x.check.externalId && <div className="text-2xs font-mono text-silver/70 truncate max-w-[160px]">{x.check.externalId}</div>}
                  </>
                ) : (
                  <span className="text-silver/40">—</span>
                ),
            },
            {
              key: 'status',
              header: 'Status',
              accessor: (x) => (x.check ? STATUS_LABELS[x.check.status] : 'No check'),
              sortable: true,
              cardMeta: true,
              cell: (x) =>
                x.check ? (
                  <Badge variant={statusVariant(x.check.status)}>{STATUS_LABELS[x.check.status]}</Badge>
                ) : (
                  <Badge variant="outline">No check</Badge>
                ),
            },
            {
              key: 'report',
              header: 'Report',
              accessor: (x) => {
                const c = x.check;
                if (!c) return null;
                return (c.reportCount ?? 0) > 0 ? (c.reportCount === 1 ? 'On file' : `${c.reportCount} on file`) : isTerminal(c.status) ? 'None' : null;
              },
              sortable: true,
              searchable: false,
              cell: (x) => {
                const c = x.check;
                if (!c) return <span className="text-xs text-silver/40">—</span>;
                return (c.reportCount ?? 0) > 0 ? (
                  <span className="inline-flex items-center gap-1 text-xs text-success">
                    <FileCheck2 className="h-3.5 w-3.5" />
                    {c.reportCount === 1 ? 'On file' : `${c.reportCount} on file`}
                  </span>
                ) : isTerminal(c.status) ? (
                  // Outcome recorded, evidence missing — the gap this
                  // column exists to surface.
                  <span className="text-xs text-warning">None</span>
                ) : (
                  <span className="text-xs text-silver/40">—</span>
                );
              },
            },
            {
              key: 'initiated',
              header: 'Initiated',
              accessor: (x) => x.check?.initiatedAt ?? null,
              sortable: true,
              searchable: false,
              cardMeta: true,
              className: 'text-silver tabular-nums',
              cell: (x) => {
                const c = x.check;
                if (!c) return <span className="text-silver/40">—</span>;
                return (
                  <>
                    {fmtDate(c.initiatedAt)}
                    {!isTerminal(c.status) && <span className={cn('ml-1.5', ageTone(ageInDays(c.initiatedAt)))}>{ageInDays(c.initiatedAt)}d since initiated</span>}
                  </>
                );
              },
            },
            {
              key: 'lastPassed',
              header: 'Last passed',
              accessor: (x) => x.lastPassedAt,
              csv: (x) => (x.lastPassedAt ? fmtDate(x.lastPassedAt) : ''),
              sortable: true,
              searchable: false,
              className: 'text-silver tabular-nums',
              cell: (x) =>
                x.lastPassedAt ? (
                  <>
                    {fmtDate(x.lastPassedAt)}
                    <span className="ml-1.5 text-silver/70">{ageWords(x.lastPassedAt)}</span>
                  </>
                ) : (
                  <span className="text-xs text-warning">Never</span>
                ),
            },
            { key: 'completed', header: 'Completed', accessor: (x) => x.check?.completedAt ?? null, sortable: true, searchable: false, defaultHidden: true, className: 'text-silver tabular-nums', cell: (x) => fmtDate(x.check?.completedAt ?? null) },
          ]}
        />
        </TableShell>
      )}

      <InitiateCheckDialog
        open={initiateFor !== false}
        initialAssociate={initiateFor || null}
        onOpenChange={(o) => !o && setInitiateFor(false)}
        onCreated={() => {
          setInitiateFor(false);
          setLinkedWithoutCheck(null);
          void refresh();
        }}
        onError={setError}
      />

      <BulkOrderDialog
        open={showBulkOrder}
        onOpenChange={setShowBulkOrder}
        onInitiated={() => {
          setShowBulkOrder(false);
          void refresh();
        }}
      />

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => {
          if (o) return;
          setDrawerTarget(null);
          setPrimedDetail(null);
        }}
        width="max-w-xl"
      >
        {drawerTarget && (
          <BackgroundCheckDetailPanel
            check={drawerTarget}
            reports={detail ? detail.reports : null}
            returnPath={returnPath}
            canManage={canManage}
            pending={pendingId === drawerTarget.id}
            onTransition={(status) => updateStatus(drawerTarget.id, status)}
            onReportsChanged={() => {
              setPrimedDetail(null);
              void detailQuery.refetch();
              void refresh(); // report counts in the table + KPI strip
            }}
            onCheckChanged={(updated) => {
              setDrawerTarget((prev) => (prev ? { ...prev, ...updated } : updated));
              void refresh();
              void queryClient.invalidateQueries({ queryKey: ['BackgroundTab', 'adverse'] });
            }}
            // Decide, then the next check in the list as filtered — the I-9
            // and E-Verify tabs already work this way.
            onNext={() => {
              setPrimedDetail(null);
              setDrawerTarget(nextInQueue(visible.flatMap((r) => (r.check ? [r.check] : [])), drawerTarget.id));
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function BackgroundCheckDetailPanel({
  check,
  reports,
  returnPath = null,
  canManage,
  pending,
  onTransition,
  onReportsChanged,
  onCheckChanged,
  onNext,
}: {
  check: BackgroundCheck;
  /** null while the audited detail fetch is in flight. */
  reports: BackgroundCheckDetail['reports'] | null;
  /** Surface the reviewer deep-linked from (null = none). */
  returnPath?: string | null;
  canManage: boolean;
  pending: boolean;
  onTransition: (status: BgCheckStatus) => void | Promise<void>;
  onReportsChanged: () => void;
  /** An adverse-action step moved the check; here is the record as it now stands. */
  onCheckChanged: (updated: BackgroundCheck) => void;
  /** Move to the next check in the list as filtered. */
  onNext?: () => void;
}) {
  const ageDays = ageInDays(check.initiatedAt);
  const finalized = isTerminal(check.status);
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar src={personPhotoUrl({ photoUrl: check.associatePhotoUrl, associateId: check.associateId })} name={check.associateName} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">{check.associateName}</DrawerTitle>
            <DrawerDescription>{check.provider}</DrawerDescription>
          </div>
          {returnPath && (
            <Link
              to={returnPath}
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gold hover:underline"
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </Link>
          )}
          <Link
            to={`/people?associateId=${check.associateId}`}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gold hover:underline"
          >
            View profile
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <Badge variant={statusVariant(check.status)}>
            {STATUS_LABELS[check.status]}
          </Badge>
          {check.workStatus && <PeopleStatusBadge status={check.workStatus} size="sm" />}
          {!finalized && (
            <span className={cn('text-xs tabular-nums', ageTone(ageDays))}>
              {ageDays}d open
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <DetailRow label="Initiated">
            {fmtDateTime(check.initiatedAt)}
          </DetailRow>
          <DetailRow label="Completed">
            {fmtDateTime(check.completedAt)}
          </DetailRow>
          <DetailRow label="Provider">{check.provider}</DetailRow>
          <DetailRow label="External ref">{check.externalId ?? '—'}</DetailRow>
        </dl>

        {check.status === 'NOT_RUN' && (
          <p className="mt-5 flex items-start gap-2 rounded-md border border-alert/40 bg-alert/5 p-3 text-sm text-ink" role="status">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
            <span>
              The consent is on file but no check ran: no screening provider is connected. Connect one under Integrations and order it, or record a check run elsewhere.
            </span>
          </p>
        )}

        <BackgroundProviderPanel
          checkId={check.id}
          personName={check.associateName}
          canManage={canManage}
          onCleared={() => onTransition('PASSED')}
          onChanged={onReportsChanged}
        />

        {!check.viaProvider && canManage && <ManualAdversePanel check={check} onChanged={onCheckChanged} />}

        <div className="mt-6">
          <h3 className="mb-2 text-2xs uppercase tracking-widest text-silver/80">
            Provider report
          </h3>
          {reports === null ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <ReportSection
              associateId={check.associateId}
              reports={reports}
              finalized={finalized}
              canManage={canManage}
              onUploaded={onReportsChanged}
            />
          )}
        </div>

        {finalized && (
          <p className="mt-5 text-xs text-silver">
            This check is finalized. Use a transition below if the result needs
            to be revised.
          </p>
        )}
        {canManage && check.status !== 'FAILED' && (
          // FCRA (2026-11-03): there is no "Mark failed". The final adverse
          // notice records a failure, after the pre-adverse notice and the wait.
          <p className="mt-3 text-xs text-silver">
            To fail this check, take the adverse-action steps{check.viaProvider ? ' in the provider panel above' : ''}: record the result as needing review, send the pre-adverse notice with the report, wait out the response period, then send the final notice.
          </p>
        )}
      </DrawerBody>
      {canManage && (
        <DrawerFooter className="flex-wrap">
          {TRANSITION_OPTIONS.filter((s) => s !== check.status).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={transitionVariant(s)}
              onClick={() => onTransition(s)}
              disabled={pending}
              loading={pending}
            >
              {labelFor(s, check)}
            </Button>
          ))}
          {onNext && (
            <Button size="sm" variant="ghost" onClick={onNext} disabled={pending}>
              Next in list →
            </Button>
          )}
        </DrawerFooter>
      )}
    </>
  );
}

/**
 * The report the provider hands back when the screen completes.
 *
 * HR downloads it from the Checkr/Sterling portal and files it here, against
 * the associate, so the evidence lives next to the recorded decision instead
 * of in someone's Downloads folder — the same treatment E-Verify closure
 * packets get. Stored as BACKGROUND_CHECK_RESULT documents (the kind that
 * was always meant for this), which also feeds the compliance scorecard's
 * background signal and the profile's Documents tab. A report belongs to the
 * check that was current when it was filed.
 */
function ReportSection({
  associateId,
  reports,
  finalized,
  canManage,
  onUploaded,
}: {
  associateId: string;
  reports: BackgroundCheckDetail['reports'];
  finalized: boolean;
  canManage: boolean;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setErr(null);
    const failures: string[] = [];
    let ok = 0;
    // Sequential, not Promise.all: each file is its own audited write, and a
    // partial failure should say which file rather than rejecting the batch.
    for (const file of Array.from(files)) {
      try {
        await uploadAdminDocument(file, 'BACKGROUND_CHECK_RESULT', associateId);
        ok += 1;
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
    if (ok > 0) onUploaded();
    if (failures.length === 0) {
      toast.success(`Uploaded ${ok} file${ok === 1 ? '' : 's'}.`);
    } else {
      setErr(failures.join(' · '));
      if (ok > 0) toast.warning(`Uploaded ${ok}, ${failures.length} failed.`);
    }
  };

  return (
    <div>
      {err && <ErrorBanner className="mb-2">{err}</ErrorBanner>}

      {reports.length === 0 ? (
        <p className={cn('mb-2 text-xs', finalized ? 'text-warning' : 'text-silver')}>
          {finalized
            ? 'This check is finalized but no report is on file — upload the provider report so the decision has its evidence.'
            : 'No report yet. When the provider completes the screen, download the report and file it here.'}
        </p>
      ) : (
        <div className="mb-3">
          <DocumentThumbnails
            documents={reports}
            bulkDownloadAssociateId={associateId}
            bulkDownloadKinds={['BACKGROUND_CHECK_RESULT']}
          />
        </div>
      )}

      {canManage && (
        <div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.webp,.zip"
            onChange={(e) => void upload(e.target.files)}
            disabled={busy}
            aria-label="Upload background report files"
            className="block w-full text-xs text-silver file:mr-3 file:rounded file:border file:border-navy-secondary file:bg-navy-secondary/40 file:px-3 file:py-1.5 file:text-xs file:text-white hover:file:border-gold/60 disabled:opacity-50"
          />
          <p className="mt-1 text-2xs text-silver/60">
            PDF, image, or a .zip of the whole report folder. Up to 10 MB per
            file — select several at once if it arrived as multiple documents.
          </p>
          {busy && <p className="mt-1 text-2xs text-gold">Uploading…</p>}
        </div>
      )}
    </div>
  );
}

function labelFor(s: BgCheckStatus, check: BackgroundCheck): string {
  switch (s) {
    case 'IN_PROGRESS':
      return 'Mark in progress';
    case 'NEEDS_REVIEW':
      return 'Needs review';
    case 'PASSED':
      // On a report that needs a decision, a pass is the decision to clear them.
      return check.status === 'NEEDS_REVIEW' || check.result === 'consider' ? 'Clear to work' : 'Mark passed';
    case 'FAILED':
      return 'Mark failed';
    case 'INITIATED':
      return 'Reopen';
    case 'NOT_RUN':
      return 'Not run';
  }
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-widest text-silver/80">{label}</dt>
      <dd className="text-white text-sm mt-0.5 tabular-nums break-all">{children}</dd>
    </div>
  );
}

/** The groups a bulk order may include, and what each means here. People who left are never listed. */
const ROSTER_GROUPS: ReadonlyArray<{ key: ScreeningRosterGroup; hint: string }> = [
  { key: 'current', hint: 'hired and still here' },
  { key: 'starting', hint: 'onboarding, not hired yet' },
  { key: 'paused', hint: 'paused by hand — usually left out' },
];
const DEFAULT_ROSTER = { current: true, starting: true, paused: false } as const;

/** The row's group; an older server sent only the three-word status. */
function rosterGroup(r: Pick<BackgroundPendingRow, 'group' | 'status'>): ScreeningRosterGroup {
  return r.group ?? (r.status === 'ACTIVE' ? 'current' : r.status === 'PENDING' ? 'starting' : 'paused');
}

/** The provider's bulk upload takes 500 people a call; a bigger order goes in turns. */
const ORDER_BATCH = 500;

/**
 * Bulk Checkr ordering. Downloads the never-screened roster as the
 * provider's bulk-invitation CSV (email / first name / phone number — the
 * provider collects DOB/SSN from the candidate, so no heavy PII leaves).
 * People are grouped by their one status (2026-11-03): Current and
 * Starting soon ticked, Paused listed unticked, people who left never listed.
 *
 * Downloading marks NOTHING — a file on disk isn't an order, and the
 * provider might reject it. The "Mark as initiated" step is separate,
 * enabled only after a download, and worded to be clicked after the
 * upload to the provider actually succeeded.
 */
function BulkOrderDialog({
  open,
  onOpenChange,
  onInitiated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInitiated: () => void;
}) {
  const [errorLocal, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<Record<ScreeningRosterGroup, boolean>>({ ...DEFAULT_ROSTER });

  const pendingQuery = useQuery({
    queryKey: ['BulkOrderDialog', 'pending', open],
    queryFn: () => listPendingBackgroundChecks(),
    enabled: Boolean(open),
  });
  const pending: BackgroundPendingResponse | null = pendingQuery.data ?? null;
  const error = errorLocal ?? (pendingQuery.error ? pendingQuery.error instanceof ApiError ? pendingQuery.error.message : 'Could not load the pending list.' : null);
  useEffect(() => {
    setDownloaded(false);
    setGroups({ ...DEFAULT_ROSTER });
  }, [open]);

  const all = pending?.rows ?? [];
  const countOf = (g: ScreeningRosterGroup) => all.filter((r) => rosterGroup(r) === g).length;
  const rows = all.filter((r) => groups[rosterGroup(r)]);
  const neverRan = rows.filter((r) => r.lastStatus === 'NOT_RUN').length;

  const toggleGroup = (g: ScreeningRosterGroup) => {
    setGroups((cur) => ({ ...cur, [g]: !cur[g] }));
    // The CSV on disk no longer matches the selection — force a re-download
    // before "mark initiated" can fire.
    setDownloaded(false);
  };

  const download = () => {
    if (rows.length === 0) return;
    const today = ymdLocal(); // the file is named for the reader's day, not UTC's
    // Header names exactly as the provider's template expects them.
    downloadCsv(`background-bulk-order-${today}.csv`, [
      ['email', 'first name', 'phone number'],
      ...rows.map((r) => [r.email, r.firstName, r.phone ?? '']),
    ]);
    setDownloaded(true);
  };

  const markInitiated = async () => {
    if (rows.length === 0 || busy) return;
    setBusy(true);
    try {
      const ids = rows.map((r) => r.associateId);
      let created = 0;
      let skipped = 0;
      for (let i = 0; i < ids.length; i += ORDER_BATCH) {
        const res = await bulkInitiateBackgroundChecks({ associateIds: ids.slice(i, i + ORDER_BATCH), provider: 'checkr' });
        created += res.created;
        skipped += res.skipped;
      }
      toast.success(
        skipped > 0
          ? `Marked ${created} initiated (${skipped} already had a check running).`
          : `Marked ${created} check${created === 1 ? '' : 's'} initiated.`,
      );
      onInitiated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark checks initiated.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk order background checks</DialogTitle>
          <DialogDescription>
            Downloads everyone never screened — no check, or a consent whose
            check never ran — as a CSV ready for the provider&rsquo;s
            bulk-order upload. People who left are never listed.
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorBanner className="mb-1">{error}</ErrorBanner>}

        {!pending && !error && <Skeleton className="h-16 w-full" />}

        {pending && all.length === 0 && (
          <p className="text-sm text-silver">
            Nobody is waiting — everyone current, starting soon or paused already has a check on record.
          </p>
        )}

        {pending && all.length > 0 && (
          <div className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="sr-only">Groups to include</legend>
              {ROSTER_GROUPS.map(({ key, hint }) => (
                <label
                  key={key}
                  className={cn(
                    'flex items-center gap-2.5 text-sm',
                    countOf(key) === 0 ? 'opacity-50' : 'cursor-pointer',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={groups[key]}
                    onChange={() => toggleGroup(key)}
                    disabled={countOf(key) === 0}
                    className="h-4 w-4 rounded border-navy-secondary bg-navy-secondary/40 text-gold focus:ring-gold"
                  />
                  <span className="text-white">{COMPLIANCE_WORKFORCE_LABELS[key]}</span>
                  <span className="text-xs text-silver/70">{hint}</span>
                  <span className="ml-auto tabular-nums text-silver">{countOf(key)}</span>
                </label>
              ))}
            </fieldset>

            <p className="text-sm text-silver">
              <span className="font-semibold text-white tabular-nums">{rows.length}</span>{' '}
              never-screened {rows.length === 1 ? 'person' : 'people'} selected
              {neverRan > 0 && (
                <span className="text-silver/70">
                  {' '}
                  — {neverRan} with a consent whose check never ran
                </span>
              )}
              {pending.truncated && (
                <span className="text-warning">
                  {' '}
                  — list capped at 5,000; run again after this batch to catch the rest
                </span>
              )}
              .
            </p>
            {rows.length > 0 && (
              <p className="text-xs text-silver/70 truncate">
                {rows
                  .slice(0, 6)
                  .map((r) => `${r.lastName}, ${r.firstName}`)
                  .join(' · ')}
                {rows.length > 6 ? ` · +${rows.length - 6} more` : ''}
              </p>
            )}
            {downloaded && (
              <p className="text-xs text-gold">
                CSV downloaded. Once it&rsquo;s been uploaded to the provider,
                mark these people as initiated so this queue reflects the
                order.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {downloaded ? 'Close' : 'Cancel'}
          </Button>
          <Button
            type="button"
            variant={downloaded ? 'secondary' : 'primary'}
            onClick={download}
            disabled={rows.length === 0}
          >
            <Download className="h-4 w-4" />
            {downloaded ? 'Download again' : 'Download CSV'}
          </Button>
          <Button
            type="button"
            onClick={() => void markInitiated()}
            loading={busy}
            disabled={!downloaded || rows.length === 0 || busy}
            title={
              downloaded
                ? 'Click after the CSV has been uploaded to the provider'
                : 'Download the CSV first'
            }
          >
            Mark {rows.length > 0 ? rows.length : ''} initiated
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface InitiateCheckDialogProps {
  open: boolean;
  /** Opens on this person (a never-screened row, a link to someone with no check). */
  initialAssociate?: PickedAssociate | null;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}

function InitiateCheckDialog({
  open,
  initialAssociate = null,
  onOpenChange,
  onCreated,
  onError,
}: InitiateCheckDialogProps) {
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [provider, setProvider] = useState('');
  const [externalId, setExternalId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setAssociate(initialAssociate);
      setProvider('');
      setExternalId('');
    }
    // Only on opening: the person picked inside the dialog stays theirs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Records an order placed in the provider's portal: the same record the
  // bulk CSV order makes (the old single "initiate" was a stub that wrote a
  // fake 'alto-stub' provider). With a provider connected, the check's
  // drawer orders it through the connection. Someone already screened can
  // be screened again (2026-11-03); only a check still running blocks it.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!associate || busy) return;
    setBusy(true);
    try {
      const ref = externalId.trim();
      const r = await bulkInitiateBackgroundChecks({
        associateIds: [associate.id],
        provider: provider.trim() || 'none',
        ...(ref ? { externalId: ref } : {}),
      });
      if (r.created === 0) toast.message(`${associate.name} already has a background check running. Open it in the list.`);
      else toast.success(`Recorded. Open ${associate.name}’s check to order it through a connected provider or record the result.`);
      onCreated();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not record the order.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a background check</DialogTitle>
          <DialogDescription>
            For a check ordered outside Alto, in the provider’s own portal, or
            a re-screen. New hires get theirs when they give consent in
            onboarding.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Associate" required>
            <AssociatePicker
              value={associate}
              onChange={setAssociate}
              placeholder="Search by name…"
            />
          </Field>
          <Field label="Provider (optional)">
            <Input
              placeholder="e.g. Sterling portal"
              maxLength={80}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
          </Field>
          <Field label="Provider reference / external ID (optional)">
            <Input
              placeholder="e.g. Checkr report id"
              maxLength={120}
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
            />
          </Field>
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
              loading={busy}
              disabled={busy || !associate}
            >
              Record check
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ----- FCRA adverse action (audit 2026-10-21 #14) ------------------------ */

const STAGE_COPY: Record<AdverseActionStage, { label: string; variant: 'destructive' | 'pending' | 'default' | 'outline' }> = {
  FINAL_DUE: { label: 'Final notice due', variant: 'destructive' },
  DECIDE: { label: 'Decide', variant: 'pending' },
  WAITING: { label: 'Waiting period', variant: 'default' },
  DONE: { label: 'Final notice sent', variant: 'outline' },
};

/**
 * The adverse-action worklist: what the FCRA asks of HR next, in order —
 * final notices now due, reports to decide, notices waiting out their
 * period, and those finished in the last 90 days. For the group the tab
 * shows (2026-11-03), or — from the Inbox — Current and Starting soon
 * together, shown as one active chip that hands back to the tab's group.
 * When the view has none but another group does (an applicant's notice in
 * Starting soon), it says where, one click away.
 */
function AdverseWorklist({
  groups,
  combined,
  onWorkforce,
  onFollowTab,
  onOpen,
}: {
  groups: readonly ComplianceWorkforce[];
  /** The Inbox's several-group view, not the tab's chip. */
  combined: boolean;
  onWorkforce: (w: ComplianceWorkforce) => void;
  onFollowTab: () => void;
  onOpen: (checkId: string) => void;
}) {
  const asked = groups.length === 1 ? groups[0] : groups;
  const q = useQuery({
    queryKey: ['BackgroundTab', 'adverse', asked],
    queryFn: () => listAdverseActions({ workforce: asked }),
  });
  const rows = q.data?.rows ?? [];
  const counts = q.data?.workforceCounts;
  const viewLabel = groups.map((w) => COMPLIANCE_WORKFORCE_LABELS[w]).join(' + ');
  // Several groups on one list: each row says which the person is in.
  const badgeRows = groups.length > 1 || groups.includes('all');
  const viewChip = combined && (
    <FilterChip active onClick={onFollowTab} title="The Inbox’s view. Click to show the group picked below instead.">
      {viewLabel}
    </FilterChip>
  );
  if (rows.length === 0) {
    const elsewhere = counts ? COMPLIANCE_WORKFORCES.filter((w) => w !== 'all' && !groups.includes(w) && counts[w] > 0) : [];
    if (elsewhere.length === 0) return null;
    return (
      <p className="mb-4 flex flex-wrap items-center gap-2 text-xs text-ink-muted" role="status">
        {viewChip}
        No adverse actions for {viewLabel.toLowerCase()}. Waiting elsewhere:
        {elsewhere.map((w) => (
          <FilterChip key={w} count={counts![w]} onClick={() => onWorkforce(w)}>
            {COMPLIANCE_WORKFORCE_LABELS[w]}
          </FilterChip>
        ))}
      </p>
    );
  }
  return (
    <section aria-labelledby="adverse-worklist" className="mb-4 rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 id="adverse-worklist" className="text-sm font-medium text-ink">
          Adverse actions
        </h3>
        {viewChip}
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.checkId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="text-sm text-accent hover:underline" onClick={() => onOpen(r.checkId)}>
                  {r.associateName}
                </button>
                {r.workStatus && badgeRows && <PeopleStatusBadge status={r.workStatus} size="sm" />}
              </div>
              <div className="text-xs text-ink-muted">
                {r.stage === 'WAITING' && r.waitUntil && `They have until ${fmtDate(r.waitUntil)} to respond`}
                {r.stage === 'FINAL_DUE' && r.waitUntil && `Waiting period ended ${fmtDate(r.waitUntil)}`}
                {r.stage === 'DECIDE' && 'The report needs a decision'}
                {r.stage === 'DONE' && r.adverseSentAt && `Final notice sent ${fmtDate(r.adverseSentAt)}`}
                {r.viaProvider && ' · through the provider'}
              </div>
            </div>
            <Badge variant={STAGE_COPY[r.stage].variant}>{STAGE_COPY[r.stage].label}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The FCRA steps for a check recorded by hand (provider-ordered checks run
 * them in the provider panel above): the pre-adverse notice with the report
 * on file and the summary of rights, the waiting period, then the final
 * notice — or withdrawing once the person clears it up.
 */
function ManualAdversePanel({ check, onChanged }: { check: BackgroundCheck; onChanged: (c: BackgroundCheck) => void }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const decidable = !check.adjudication && check.status !== 'PASSED' && (check.status === 'NEEDS_REVIEW' || check.status === 'FAILED' || check.result === 'consider');
  const pending = check.adjudication === 'PRE_ADVERSE';
  if (!decidable && !pending && check.adjudication !== 'ADVERSE') return null;
  const waitOver = !!check.adverseWaitUntil && new Date(check.adverseWaitUntil).getTime() <= Date.now();

  const run = async (fn: () => Promise<BackgroundCheck>, done: string) => {
    setBusy(true);
    try {
      onChanged(await fn());
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Adverse action" className="mt-6 space-y-3 rounded-lg border border-line p-4">
      <h3 className="text-sm font-medium text-ink">Adverse action</h3>
      {decidable && (
        <>
          <p className="text-sm text-ink-muted">
            To decide against {check.associateName} on this report, the law asks for two notices: a pre-adverse notice with a copy of the report and a summary of their rights, a waiting period for them to respond, then the final notice. Upload the report below first — the notice carries it.
          </p>
          <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={async () => {
              const ok = await confirm({
                title: 'Send the pre-adverse notice?',
                description: `${check.associateName} gets the report on file and the summary of their FCRA rights, and has 7 days to respond before any final decision.`,
                confirmLabel: 'Send pre-adverse notice',
              });
              if (ok) await run(() => sendPreAdverse(check.id), 'Pre-adverse notice sent with the report.');
            }}
          >
            Send pre-adverse notice
          </Button>
        </>
      )}
      {pending && (
        <>
          <p className="text-sm text-ink-muted">
            Pre-adverse notice sent {check.preAdverseSentAt ? fmtDateTime(check.preAdverseSentAt) : ''}.{' '}
            {check.adverseWaitUntil && (waitOver ? 'The waiting period is over.' : `They have until ${fmtDate(check.adverseWaitUntil)} to respond.`)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive"
              loading={busy}
              disabled={!waitOver}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Send the final adverse action notice?',
                  description: `${check.associateName} is told the decision, with the report and their rights. The check is recorded as failed.`,
                  confirmLabel: 'Send final notice',
                  destructive: true,
                });
                if (ok) await run(() => sendFinalAdverse(check.id), 'Final notice sent.');
              }}
            >
              {waitOver ? 'Send final notice' : `Final notice from ${check.adverseWaitUntil ? fmtDate(check.adverseWaitUntil) : 'the end of the wait'}`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Withdraw the adverse action?',
                  description: 'Use this when they cleared it up. The check is recorded as passed.',
                  confirmLabel: 'Withdraw',
                });
                if (ok) await run(() => withdrawAdverse(check.id), 'Adverse action withdrawn — the check is cleared.');
              }}
            >
              They cleared it up — withdraw
            </Button>
          </div>
        </>
      )}
      {check.adjudication === 'ADVERSE' && (
        <p className="text-sm text-ink-muted">Final adverse action notice sent {check.adverseSentAt ? fmtDateTime(check.adverseSentAt) : ''}.</p>
      )}
    </section>
  );
}
