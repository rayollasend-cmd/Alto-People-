import { DrugProviderPanel } from './providers/DrugProviderPanel';
import { nextInQueue } from '@/lib/queueNext';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Download, ExternalLink, FileCheck2, Plus, FlaskConical } from '@/components/ui/icons';
import { DirectorateHeader, Kpi, KpiStrip, TableShell } from './DirectorateShell';
import { sanitizeReturnPath } from './section2Verification';
import { WORKFORCE_PARAM, WorkforceFilter, useComplianceWorkforce } from './WorkforceFilter';
import { toast } from 'sonner';
import {
  COMPLIANCE_WORKFORCE_LABELS,
  DRUG_TEST_REASONS,
  DRUG_TEST_REASON_LABELS,
  type DrugTest,
  type DrugTestDetail,
  type DrugTestPendingResponse,
  type DrugTestPendingRow,
  type DrugTestPerson,
  type DrugTestReason,
  type DrugTestStatus,
  type ScreeningRosterGroup,
  type WorkStatus,
} from '@alto-people/shared';
import {
  bulkInitiateDrugTests,
  getDrugTestDetail,
  listDrugTests,
  listPendingDrugTests,
  sendDrugFinalAdverse,
  sendDrugPreAdverse,
  updateDrugTest,
  withdrawDrugAdverse,
} from '@/lib/complianceApi';
import { useConfirm } from '@/lib/confirm';
import { uploadAdminDocument } from '@/lib/documentsApi';
import { DocumentThumbnails } from '@/components/DocumentViewer';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { personPhotoUrl } from '@/lib/photoUrl';
import { downloadCsv } from '@/lib/csv';
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
 * Drug-test directorate — mirrors the Background checks tab. The structural
 * difference is recurrence: the Walmart SOW requires a result within 60
 * days, so the bulk-order roster is "no fresh result", not "never had a
 * row", and the dialog distinguishes never-tested from expired.
 *
 * About one group of people at a time (owner, 2026-11-03): it opens on the
 * CURRENT workforce. Each person shows once, on their newest test ("Earlier
 * tests" brings the history back), so the tiles count PEOPLE and each tile
 * is the rows it filters to. "No passed test" and "Due again" list the
 * group's people — including the never-tested — and "Last passed" says
 * when. Every order records why it was ordered.
 */

const TRANSITION_OPTIONS: DrugTestStatus[] = [
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'PASSED',
  'FAILED',
];

/** The 60-day window (Walmart SOW, Exhibit E). */
const RESULT_WINDOW_DAYS = 60;

function statusVariant(s: DrugTestStatus): 'default' | 'pending' | 'success' | 'destructive' | 'accent' {
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
  }
}

const STATUS_LABELS: Record<DrugTestStatus, string> = {
  INITIATED: 'Ordered',
  IN_PROGRESS: 'In progress',
  NEEDS_REVIEW: 'Needs review',
  PASSED: 'Passed',
  FAILED: 'Failed',
};

function transitionVariant(
  s: DrugTestStatus,
): 'primary' | 'outline' | 'destructive' {
  if (s === 'PASSED') return 'primary';
  if (s === 'FAILED') return 'destructive';
  return 'outline';
}

function isTerminal(s: DrugTestStatus): boolean {
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

// Stuck-order tone: an open drug screen 7+ days is worth a look,
// 14+ days is a problem.
function ageTone(days: number): string {
  if (days >= 14) return 'text-alert';
  if (days >= 7) return 'text-warning';
  return 'text-silver';
}

/**
 * One row of the list: a test, or — in "No passed test" / "Due again" — a
 * person of the group with no test at all. Person fields are filled either
 * way so the name, badge, client and "Last passed" read the same.
 */
interface Row {
  key: string;
  test: DrugTest | null;
  associateId: string;
  associateName: string;
  associatePhotoUrl?: string | null;
  clientId: string | null;
  clientName: string | null;
  workStatus: WorkStatus | null;
  lastPassedAt: string | null;
  /** Where the person's 60-day clock runs from (null = never tested). */
  clockFrom: string | null;
  /** The person's newest test (always true for a no-test row). */
  latest: boolean;
}

const isDue = (r: Row) => !r.clockFrom || ageInDays(r.clockFrom) > RESULT_WINDOW_DAYS;

// Status buckets mirror the KPI strip so a number that alarms someone is
// also a filter they can click through the dropdown — same idiom as the
// Background checks tab.
type StatusFilter = 'all' | 'in_flight' | 'stuck' | 'missing_result' | 'no_pass' | 'due' | DrugTestStatus;
const STATUS_FILTER_VALUES: readonly StatusFilter[] = [
  'all',
  'in_flight',
  'stuck',
  'missing_result',
  'no_pass',
  'due',
  'INITIATED',
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'PASSED',
  'FAILED',
];
/** The filters that are about people, not the ledger: never-tested people are rows. */
const PEOPLE_FILTERS: readonly StatusFilter[] = ['no_pass', 'due'];
type OrderedFilter = 'any' | 'week' | 'month' | 'quarter';

function matchesOrdered(initiatedAt: string, f: OrderedFilter): boolean {
  if (f === 'any') return true;
  const days = f === 'week' ? 7 : f === 'month' ? 30 : 90;
  return Date.now() - new Date(initiatedAt).getTime() <= days * 86_400_000;
}

function matchesStatus(r: Row, f: StatusFilter): boolean {
  const t = r.test;
  if (f === 'no_pass') return !t || t.status !== 'PASSED';
  if (f === 'due') return isDue(r);
  if (!t) return false;
  switch (f) {
    case 'all':
      return true;
    case 'in_flight':
      return !isTerminal(t.status);
    case 'stuck':
      return !isTerminal(t.status) && ageInDays(t.initiatedAt) >= 7;
    case 'missing_result':
      return isTerminal(t.status) && (t.reportCount ?? 0) === 0;
    default:
      return t.status === f;
  }
}

/** '' = every client; 'none' = rows with no client on record. */
function matchesClient(r: Row, clientFilter: string): boolean {
  return !clientFilter || (clientFilter === 'none' ? !r.clientId : r.clientId === clientFilter);
}

/** The ledger as rows: each test, flagged when it is the person's newest, plus the group's never-tested people. */
function buildRows(tests: DrugTest[], people: DrugTestPerson[]): { testRows: Row[]; untested: Row[] } {
  const byPerson = new Map(people.map((p) => [p.associateId, p]));
  const sorted = [...tests].sort((a, b) => b.initiatedAt.localeCompare(a.initiatedAt) || (a.id < b.id ? 1 : -1));
  const seen = new Set<string>();
  // Someone no longer on file (only under All) has no person row: read their last pass off their tests.
  const passedOn = new Map<string, string>();
  for (const t of sorted) {
    if (t.status !== 'PASSED') continue;
    const at = t.completedAt ?? t.initiatedAt;
    if (!passedOn.has(t.associateId) || at > passedOn.get(t.associateId)!) passedOn.set(t.associateId, at);
  }
  const testRows = sorted.map((t): Row => {
    const latest = !seen.has(t.associateId);
    seen.add(t.associateId);
    const p = byPerson.get(t.associateId);
    return {
      key: t.id,
      test: t,
      associateId: t.associateId,
      associateName: t.associateName,
      associatePhotoUrl: t.associatePhotoUrl,
      clientId: t.clientId,
      clientName: t.clientName ?? null,
      workStatus: t.workStatus ?? p?.workStatus ?? null,
      lastPassedAt: p ? p.lastPassedAt : passedOn.get(t.associateId) ?? null,
      clockFrom: p ? p.lastResultAt : passedOn.get(t.associateId) ?? null,
      latest,
    };
  });
  const untested = people
    .filter((p) => !p.latestTestId && !seen.has(p.associateId))
    .map((p): Row => ({
      key: `person:${p.associateId}`,
      test: null,
      associateId: p.associateId,
      associateName: p.associateName,
      associatePhotoUrl: p.associatePhotoUrl,
      clientId: p.clientId,
      clientName: p.clientName ?? null,
      workStatus: p.workStatus,
      lastPassedAt: null,
      // A result filed with no test on record still starts the clock.
      clockFrom: p.lastResultAt,
      latest: true,
    }));
  return { testRows, untested };
}

export function DrugTestTab({ canManage }: { canManage: boolean }) {
  // ?associateId= deep-links one person's test (the scorecard's Fix links,
  // the profile document vault and the lab's result notices send it) —
  // auto-open their newest test once the ledger arrives, on every group (a
  // link to one person opens on All). ?return= is the surface the reviewer
  // came from; the drawer offers a way back. ?status= (the Inbox) and
  // ?workforce= pick the view for this visit. All are captured into state
  // once, then consumed (replace: true): ComplianceHome tab switches copy
  // the current search params, so lingering params would re-arm on every
  // tab visit.
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
  // The order dialog, and who it opens on (a never-tested row, a link to someone with no test).
  const [orderFor, setOrderFor] = useState<PickedAssociate | null | false>(false);
  const [showBulkOrder, setShowBulkOrder] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<DrugTest | null>(null);
  // Search / status / client survive revisits (same idiom as EVerifyTab) —
  // this ledger is worked in passes and losing the slice on every tab
  // switch meant rebuilding it by hand.
  const [query, setQuery] = usePersistentState<string>(
    'alto:list.drugtests.query.v1',
    '',
    (v): v is string => typeof v === 'string',
  );
  const [storedStatusFilter, setStoredStatusFilter] = usePersistentState<StatusFilter>(
    'alto:list.drugtests.status.v1',
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
  // Each person once, on their newest test — or every test ever ordered.
  const [storedHistory, setStoredHistory] = usePersistentState<boolean>(
    'alto:list.drugtests.history.v1',
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
  const [orderedFilter, setOrderedFilter] = useState<OrderedFilter>('any');
  // '' = all clients; 'none' = rows with no client attribution.
  const [clientFilter, setClientFilter] = usePersistentState<string>(
    'alto:list.drugtests.client.v1',
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

  const refreshQuery = useQuery({
    queryKey: ['DrugTestTab', 'tests', workforce],
    queryFn: () => listDrugTests({ workforce }),
  });
  // Results for the open drawer — fetched on open (each read is an audited
  // disclosure server-side), null while loading. gcTime 0 so a re-opened
  // drawer reads (and discloses) afresh instead of replaying a cached copy.
  const detailQuery = useQuery({
    queryKey: ['DrugTestTab', 'detail', drawerTarget?.id ?? null],
    queryFn: () => getDrugTestDetail(drawerTarget!.id),
    enabled: drawerTarget !== null,
    gcTime: 0,
  });
  const detail: DrugTestDetail | null = detailQuery.data ?? null;
  const error =
    errorLocal ??
    (refreshQuery.error
      ? refreshQuery.error instanceof ApiError
        ? refreshQuery.error.message
        : 'Failed to load.'
      : detailQuery.error
        ? detailQuery.error instanceof ApiError
          ? detailQuery.error.message
          : 'Could not load the result list.'
        : null);
  const data = refreshQuery.data ?? null;
  const tests = data?.tests ?? null;
  const refresh = () => refreshQuery.refetch();

  const openDrawer = (t: DrugTest) => {
    setDrawerTarget(t);
  };

  const { testRows, untested } = useMemo(
    () => buildRows(tests ?? [], data?.people ?? []),
    [tests, data?.people],
  );

  // Deep link: open the linked person's newest test as soon as the ledger
  // arrives. Matched against the FULL list, not the filtered view, so a
  // saved filter can never turn the link into a silent no-op — and a
  // person with no test is said so, with a way to order one.
  const [linkedWithoutTest, setLinkedWithoutTest] = useState<PickedAssociate | null>(null);
  useEffect(() => {
    if (!deepLinkAssociateId || deepLinkOpened.current || !tests) return;
    deepLinkOpened.current = true;
    const match = testRows.find((r) => r.test && r.associateId === deepLinkAssociateId && r.latest);
    if (match?.test) {
      setDrawerTarget(match.test);
      return;
    }
    const who = untested.find((r) => r.associateId === deepLinkAssociateId);
    setLinkedWithoutTest({ id: deepLinkAssociateId, name: who?.associateName ?? '' });
  }, [tests, testRows, untested, deepLinkAssociateId]);

  const updateStatus = async (id: string, status: DrugTestStatus) => {
    setPendingId(id);
    try {
      const updated = await updateDrugTest(id, { status });
      const fresh = await refresh();
      setDrawerTarget((prev) =>
        prev ? fresh.data?.tests.find((t) => t.id === prev.id) ?? { ...prev, ...updated } : null,
      );
    } catch (err) {
      // Said where the person is looking: the drawer sits over the page banner.
      toast.error(err instanceof ApiError ? err.message : 'Update failed.');
    } finally {
      setPendingId(null);
    }
  };

  // One row per person: their newest test, and the people never tested.
  const latestRows = useMemo(() => testRows.filter((r) => r.latest), [testRows]);
  const peopleRows = useMemo(() => [...latestRows, ...untested], [latestRows, untested]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // "No passed test" and "Due again" are about people; the other views are the ledger.
    const base = PEOPLE_FILTERS.includes(statusFilter) ? peopleRows : showHistory ? testRows : latestRows;
    return base.filter((r) => {
      if (
        q &&
        !r.associateName.toLowerCase().includes(q) &&
        !(r.test?.provider ?? '').toLowerCase().includes(q) &&
        !(r.test?.externalId ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      if (!matchesClient(r, clientFilter)) return false;
      return matchesStatus(r, statusFilter) && (!r.test || matchesOrdered(r.test.initiatedAt, orderedFilter));
    });
  }, [testRows, latestRows, peopleRows, query, statusFilter, orderedFilter, clientFilter, showHistory]);

  // Distinct clients present in the ledger, for the dropdown — derived from
  // the rows themselves so no extra fetch (and no /clients dependency).
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of [...testRows, ...untested]) {
      if (r.clientId && r.clientName) m.set(r.clientId, r.clientName);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [testRows, untested]);
  const hasUnattributed = [...testRows, ...untested].some((r) => !r.clientId);

  // The tiles count PEOPLE of the chosen group (and client): each person on
  // their newest test, so a re-test every 60 days is one person, not a
  // growing "Passed". Each tile is a filter showing exactly the rows it counts.
  const counted = peopleRows.filter((r) => matchesClient(r, clientFilter));
  const latestTests = counted.flatMap((r) => (r.test ? [r.test] : []));
  const open = latestTests.filter((t) => !isTerminal(t.status));
  const kpi = {
    inFlight: open.length,
    needsReview: latestTests.filter((t) => t.status === 'NEEDS_REVIEW').length,
    stuck: open.filter((t) => ageInDays(t.initiatedAt) >= 7).length,
    passed: latestTests.filter((t) => t.status === 'PASSED').length,
    failed: latestTests.filter((t) => t.status === 'FAILED').length,
    noPass: counted.filter((r) => !r.test || r.test.status !== 'PASSED').length,
    due: counted.filter(isDue).length,
    // A finalized outcome with no lab result on file has no evidence.
    missingResult: latestTests.filter((t) => isTerminal(t.status) && (t.reportCount ?? 0) === 0).length,
  };
  const groupWord = COMPLIANCE_WORKFORCE_LABELS[workforce].toLowerCase();
  const tile = (f: StatusFilter) => ({ onClick: () => pickTile(f), active: statusFilter === f });
  const hasAnything = (tests?.length ?? 0) > 0 || untested.length > 0;

  return (
    <section>
      <DirectorateHeader
        icon={FlaskConical}
        title="Drug tests"
        blurb="Recurring screening under the 60-day rule — a result older than 60 days is due again"
        actions={
          canManage && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setShowBulkOrder(true)}>
                <Download className="h-4 w-4" />
                Bulk order CSV
              </Button>
              <Button onClick={() => setOrderFor(null)} size="sm">
                <Plus className="h-4 w-4" />
                Order test
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

      {linkedWithoutTest && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface p-3 text-sm text-ink" role="status">
          <span>
            {linkedWithoutTest.name ? `${linkedWithoutTest.name} has` : 'The person you followed a link to has'} no drug test on file.
          </span>
          <div className="flex gap-2">
            {canManage && (
              <Button size="sm" onClick={() => setOrderFor(linkedWithoutTest.name ? linkedWithoutTest : null)}>
                <Plus className="h-4 w-4" />
                Order a test
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setLinkedWithoutTest(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {data?.truncated && (
        <p className="mb-3 text-xs text-warning" role="status">
          More tests matched than the list can show. Narrow it with the groups or the filters below.
        </p>
      )}

      {data && hasAnything && (
        <KpiStrip>
          <Kpi label="In flight" value={kpi.inFlight} hint={`People in ${groupWord} whose newest test is still out.`} {...tile('in_flight')} />
          <Kpi
            label="Needs review"
            value={kpi.needsReview}
            tone={kpi.needsReview > 0 ? 'text-warning' : undefined}
            hint="People whose newest result needs a decision — often waiting on the Medical Review Officer."
            {...tile('NEEDS_REVIEW')}
          />
          <Kpi
            label="Stuck 7d+"
            value={kpi.stuck}
            tone={kpi.stuck > 0 ? 'text-alert' : undefined}
            hint="People whose newest test has been out a week or more."
            {...tile('stuck')}
          />
          <Kpi label="Passed" value={kpi.passed} tone="text-success" hint="People whose newest test passed." {...tile('PASSED')} />
          <Kpi
            label="Failed"
            value={kpi.failed}
            tone={kpi.failed > 0 ? 'text-alert' : undefined}
            hint="People whose newest test failed."
            {...tile('FAILED')}
          />
          <Kpi
            label="No passed test"
            value={kpi.noPass}
            of={counted.length}
            tone={kpi.noPass > 0 ? 'text-warning' : undefined}
            hint={`People in ${groupWord} whose newest test isn't a pass — never tested, still out, needing review or failed.`}
            {...tile('no_pass')}
          />
          <Kpi
            label="Due again"
            value={kpi.due}
            tone={kpi.due > 0 ? 'text-warning' : undefined}
            hint="People with no passed result in the last 60 days."
            {...tile('due')}
          />
          <Kpi
            label="Finalized, no result"
            value={kpi.missingResult}
            tone={kpi.missingResult > 0 ? 'text-warning' : undefined}
            hint="People whose newest test was decided with no lab result on file."
            {...tile('missing_result')}
          />
        </KpiStrip>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <WorkforceFilter value={workforce} onChange={setWorkforce} counts={data?.workforceCounts} />
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
            aria-label="Filter by test status"
          >
            <option value="all">All statuses</option>
            <option value="no_pass">No passed test</option>
            <option value="due">Due again (60 days)</option>
            <option value="in_flight">In flight (not finalized)</option>
            <option value="INITIATED">Ordered</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="NEEDS_REVIEW">Needs review</option>
            <option value="PASSED">Passed</option>
            <option value="FAILED">Failed</option>
            <option value="stuck">Stuck 7d+</option>
            <option value="missing_result">Finalized, no result</option>
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
            value={orderedFilter}
            onChange={(e) => setOrderedFilter(e.target.value as OrderedFilter)}
            size="sm"
            className="w-auto"
            aria-label="Filter by ordered date"
          >
            <option value="any">Ordered any time</option>
            <option value="week">Ordered in the last 7 days</option>
            <option value="month">Ordered in the last 30 days</option>
            <option value="quarter">Ordered in the last 90 days</option>
          </Select>
          {!PEOPLE_FILTERS.includes(statusFilter) && (
            <FilterChip
              active={showHistory}
              onClick={() => setShowHistory(!showHistory)}
              title="Each person shows once, on their newest test. Turn on to list every test ever ordered."
            >
              Earlier tests
            </FilterChip>
          )}
        </div>
      )}

      {!data && !error && <SkeletonRows count={4} rowHeight="h-12" />}
      {data && !hasAnything && (
        <EmptyState
          icon={FlaskConical}
          title={workforce === 'all' ? 'No drug tests yet' : `No one in ${groupWord}`}
          description={
            workforce !== 'all'
              ? 'Nobody in this group has a test or needs one. Pick another group above.'
              : canManage
                ? 'Order tests individually or download the bulk CSV for everyone whose result is missing or older than 60 days.'
                : 'Drug tests will appear here once they are ordered.'
          }
          action={
            canManage && workforce === 'all' ? (
              <Button onClick={() => setOrderFor(null)} size="sm">
                <Plus className="h-4 w-4" />
                Order test
              </Button>
            ) : undefined
          }
        />
      )}
      {data && hasAnything && visible.length === 0 && (
        testRows.length === 0 && !PEOPLE_FILTERS.includes(statusFilter) ? (
          // Nobody in the group has a test, but people in it need one: say so, not "no match".
          <EmptyState
            icon={FlaskConical}
            title={`No drug tests in ${groupWord}`}
            description={`${untested.length} ${untested.length === 1 ? 'person here has' : 'people here have'} never been tested.`}
            action={
              <Button size="sm" variant="secondary" onClick={() => setStatusFilter('no_pass')}>
                Show who has no passed test
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={FlaskConical}
            title="Nobody matches this filter"
            description="Clear the search, status, client, or ordered-date filter, or pick another group."
          />
        )
      )}
      {data && visible.length > 0 && (
        <TableShell>
        <DataGrid<Row>
          id="drug-tests"
          caption="Drug tests"
          rows={visible}
          rowKey={(x) => x.key}
          search={false}
          urlState={false}
          exportCsv={{ filename: `drug-tests-${workforce}-${ymdLocal()}` }}
          onRowClick={(x) => (x.test ? openDrawer(x.test) : canManage ? setOrderFor({ id: x.associateId, name: x.associateName }) : undefined)}
          rowActionLabel={(x) => (x.test ? `Open ${x.associateName}` : canManage ? `Order a test for ${x.associateName}` : `${x.associateName} has no test`)}
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
              accessor: (x) => x.test?.provider ?? null,
              sortable: true,
              cardMeta: true,
              className: 'text-silver',
              cell: (x) =>
                x.test ? (
                  <>
                    <div>{x.test.provider}</div>
                    {x.test.externalId && <div className="text-2xs font-mono text-silver/70 truncate max-w-[160px]">{x.test.externalId}</div>}
                  </>
                ) : (
                  <span className="text-silver/40">—</span>
                ),
            },
            {
              key: 'reason',
              header: 'Reason',
              accessor: (x) => reasonLabel(x.test?.reason),
              sortable: true,
              defaultHidden: true,
              className: 'text-silver',
            },
            {
              key: 'status',
              header: 'Status',
              accessor: (x) => (x.test ? STATUS_LABELS[x.test.status] : 'No test'),
              sortable: true,
              cardMeta: true,
              cell: (x) =>
                x.test ? (
                  <Badge variant={statusVariant(x.test.status)}>{STATUS_LABELS[x.test.status]}</Badge>
                ) : (
                  <Badge variant="outline">No test</Badge>
                ),
            },
            {
              key: 'report',
              header: 'Result',
              accessor: (x) => {
                const t = x.test;
                if (!t) return null;
                return (t.reportCount ?? 0) > 0 ? (t.reportCount === 1 ? 'On file' : `${t.reportCount} on file`) : isTerminal(t.status) ? 'None' : null;
              },
              sortable: true,
              searchable: false,
              cell: (x) => {
                const t = x.test;
                if (!t) return <span className="text-xs text-silver/40">—</span>;
                return (t.reportCount ?? 0) > 0 ? (
                  <span className="inline-flex items-center gap-1 text-xs text-success">
                    <FileCheck2 className="h-3.5 w-3.5" />
                    {t.reportCount === 1 ? 'On file' : `${t.reportCount} on file`}
                  </span>
                ) : isTerminal(t.status) ? (
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
              header: 'Ordered',
              accessor: (x) => x.test?.initiatedAt ?? null,
              sortable: true,
              searchable: false,
              cardMeta: true,
              className: 'text-silver tabular-nums',
              cell: (x) => {
                const t = x.test;
                if (!t) return <span className="text-silver/40">—</span>;
                return (
                  <>
                    {fmtDate(t.initiatedAt)}
                    {!isTerminal(t.status) && <span className={cn('ml-1.5', ageTone(ageInDays(t.initiatedAt)))}>{ageInDays(t.initiatedAt)}d since ordered</span>}
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
                    <span className={cn('ml-1.5', isDue(x) ? 'text-warning' : 'text-silver/70')}>
                      {ageWords(x.lastPassedAt)}
                      {isDue(x) ? ' · due again' : ''}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-warning">Never</span>
                ),
            },
            { key: 'completed', header: 'Completed', accessor: (x) => x.test?.completedAt ?? null, sortable: true, searchable: false, defaultHidden: true, className: 'text-silver tabular-nums', cell: (x) => fmtDate(x.test?.completedAt ?? null) },
          ]}
        />
        </TableShell>
      )}

      <OrderTestDialog
        open={orderFor !== false}
        initialAssociate={orderFor || null}
        onOpenChange={(o) => !o && setOrderFor(false)}
        onCreated={() => {
          setOrderFor(false);
          setLinkedWithoutTest(null);
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
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-xl"
      >
        {drawerTarget && (
          <DrugTestDetailPanel
            test={drawerTarget}
            reports={detail ? detail.reports : null}
            returnPath={returnPath}
            canManage={canManage}
            pending={pendingId === drawerTarget.id}
            onTransition={(status) => updateStatus(drawerTarget.id, status)}
            onReportsChanged={() => {
              void detailQuery.refetch();
              void refresh(); // result counts in the table + KPI strip
            }}
            onTestChanged={(updated) => {
              setDrawerTarget((prev) => (prev ? { ...prev, ...updated } : updated));
              void refresh();
            }}
            // Decide, then the next test in the list as filtered.
            onNext={() => setDrawerTarget(nextInQueue(visible.flatMap((r) => (r.test ? [r.test] : [])), drawerTarget.id))}
          />
        )}
      </Drawer>
    </section>
  );
}

function reasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return DRUG_TEST_REASONS.find((r) => r === reason) ? DRUG_TEST_REASON_LABELS[reason as DrugTestReason] : reason;
}

function DrugTestDetailPanel({
  test,
  reports,
  returnPath = null,
  canManage,
  pending,
  onTransition,
  onReportsChanged,
  onTestChanged,
  onNext,
}: {
  test: DrugTest;
  /** null while the audited detail fetch is in flight. */
  reports: DrugTestDetail['reports'] | null;
  /** Surface the reviewer deep-linked from (null = none). */
  returnPath?: string | null;
  canManage: boolean;
  pending: boolean;
  onTransition: (status: DrugTestStatus) => void;
  onReportsChanged: () => void;
  /** An adverse-action step moved the test; here is the record as it now stands. */
  onTestChanged: (updated: DrugTest) => void;
  /** Move to the next test in the list as filtered. */
  onNext?: () => void;
}) {
  const ageDays = ageInDays(test.initiatedAt);
  const finalized = isTerminal(test.status);
  // FCRA (2026-11-03): a result through a consumer reporting agency is failed
  // by the final adverse notice, not a button.
  const failByNotice = !!test.viaCra && test.adjudication !== 'ADVERSE';
  const transitions = TRANSITION_OPTIONS.filter((s) => s !== test.status && !(s === 'FAILED' && failByNotice));
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar src={personPhotoUrl({ photoUrl: test.associatePhotoUrl, associateId: test.associateId })} name={test.associateName} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">{test.associateName}</DrawerTitle>
            <DrawerDescription>{test.provider}</DrawerDescription>
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
            to={`/people?associateId=${test.associateId}`}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gold hover:underline"
          >
            View profile
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <Badge variant={statusVariant(test.status)}>
            {STATUS_LABELS[test.status]}
          </Badge>
          {test.workStatus && <PeopleStatusBadge status={test.workStatus} size="sm" />}
          {!finalized && (
            <span className={cn('text-xs tabular-nums', ageTone(ageDays))}>
              {ageDays}d open
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <DetailRow label="Ordered">
            {fmtDateTime(test.initiatedAt)}
          </DetailRow>
          <DetailRow label="Completed">
            {fmtDateTime(test.completedAt)}
          </DetailRow>
          <DetailRow label="Provider">{test.provider}</DetailRow>
          <DetailRow label="External ref">{test.externalId ?? '—'}</DetailRow>
          <DetailRow label="Reason">{reasonLabel(test.reason) ?? 'Not recorded'}</DetailRow>
        </dl>

        <DrugProviderPanel testId={test.id} personName={test.associateName} canManage={canManage} onChanged={onReportsChanged} />

        {test.viaCra && canManage && <DrugAdversePanel test={test} onChanged={onTestChanged} />}

        <div className="mt-6">
          <h3 className="mb-2 text-2xs uppercase tracking-widest text-silver/80">
            Lab result
          </h3>
          {reports === null ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <ResultSection
              associateId={test.associateId}
              reports={reports}
              finalized={finalized}
              canManage={canManage}
              onUploaded={onReportsChanged}
            />
          )}
        </div>

        {finalized && (
          <p className="mt-5 text-xs text-silver">
            This test is finalized. Use a transition below if the result needs
            to be revised.
          </p>
        )}
        {canManage && failByNotice && test.status !== 'FAILED' && (
          <p className="mt-3 text-xs text-silver">
            This result came through {test.provider}, a consumer reporting agency. To fail them on it, take the adverse-action steps above: record the result as needing review, send the pre-adverse notice with the result, wait out the response period, then send the final notice.
          </p>
        )}
      </DrawerBody>
      {canManage && (
        <DrawerFooter className="flex-wrap">
          {transitions.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={transitionVariant(s)}
              onClick={() => onTransition(s)}
              disabled={pending}
              loading={pending}
            >
              {labelFor(s)}
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
 * The FCRA steps for a test obtained through a consumer reporting agency
 * (2026-11-03): its result is a consumer report, so deciding against
 * someone on it takes the pre-adverse notice with the result on file and
 * the summary of rights, the waiting period, then the final notice — or
 * withdrawing once they clear it up. A lab ordered directly has none of this.
 */
function DrugAdversePanel({ test, onChanged }: { test: DrugTest; onChanged: (t: DrugTest) => void }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const decidable = !test.adjudication && (test.status === 'NEEDS_REVIEW' || test.status === 'FAILED');
  const pendingNotice = test.adjudication === 'PRE_ADVERSE';
  if (!decidable && !pendingNotice && test.adjudication !== 'ADVERSE') return null;
  const waitOver = !!test.adverseWaitUntil && new Date(test.adverseWaitUntil).getTime() <= Date.now();

  const run = async (fn: () => Promise<DrugTest>, done: string) => {
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
            This result came through {test.provider}, a consumer reporting agency. To decide against {test.associateName} on it, the law asks for two notices: a pre-adverse notice with a copy of the result and a summary of their rights, a waiting period for them to respond, then the final notice. Upload the result below first — the notice carries it.
          </p>
          <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={async () => {
              const ok = await confirm({
                title: 'Send the pre-adverse notice?',
                description: `${test.associateName} gets the result on file and the summary of their FCRA rights, and has 7 days to respond before any final decision.`,
                confirmLabel: 'Send pre-adverse notice',
              });
              if (ok) await run(() => sendDrugPreAdverse(test.id), 'Pre-adverse notice sent with the result.');
            }}
          >
            Send pre-adverse notice
          </Button>
        </>
      )}
      {pendingNotice && (
        <>
          <p className="text-sm text-ink-muted">
            Pre-adverse notice sent {test.preAdverseSentAt ? fmtDateTime(test.preAdverseSentAt) : ''}.{' '}
            {test.adverseWaitUntil && (waitOver ? 'The waiting period is over.' : `They have until ${fmtDate(test.adverseWaitUntil)} to respond.`)}
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
                  description: `${test.associateName} is told the decision, with the result and their rights. The test is recorded as failed.`,
                  confirmLabel: 'Send final notice',
                  destructive: true,
                });
                if (ok) await run(() => sendDrugFinalAdverse(test.id), 'Final notice sent.');
              }}
            >
              {waitOver ? 'Send final notice' : `Final notice from ${test.adverseWaitUntil ? fmtDate(test.adverseWaitUntil) : 'the end of the wait'}`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Withdraw the adverse action?',
                  description: 'Use this when they cleared it up. The test is recorded as passed.',
                  confirmLabel: 'Withdraw',
                });
                if (ok) await run(() => withdrawDrugAdverse(test.id), 'Adverse action withdrawn — the test is cleared.');
              }}
            >
              They cleared it up — withdraw
            </Button>
          </div>
        </>
      )}
      {test.adjudication === 'ADVERSE' && (
        <p className="text-sm text-ink-muted">Final adverse action notice sent {test.adverseSentAt ? fmtDateTime(test.adverseSentAt) : ''}.</p>
      )}
    </section>
  );
}

/**
 * The lab's result document. HR downloads it from the provider portal and
 * files it here so the evidence lives next to the recorded outcome. Stored
 * as DRUG_TEST_RESULT documents — the kind the compliance scorecard's
 * 60-day signal reads. A result belongs to the test that was current when
 * it was filed; the 60-day clock runs from the test's completion.
 */
function ResultSection({
  associateId,
  reports,
  finalized,
  canManage,
  onUploaded,
}: {
  associateId: string;
  reports: DrugTestDetail['reports'];
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
        await uploadAdminDocument(file, 'DRUG_TEST_RESULT', associateId);
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
            ? 'This test is finalized but no lab result is on file — upload it so the outcome has its evidence.'
            : 'No result yet. When the lab completes the screen, download the result and file it here.'}
        </p>
      ) : (
        <div className="mb-3">
          <DocumentThumbnails
            documents={reports}
            bulkDownloadAssociateId={associateId}
            bulkDownloadKinds={['DRUG_TEST_RESULT']}
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
            aria-label="Upload drug test result files"
            className="block w-full text-xs text-silver file:mr-3 file:rounded file:border file:border-navy-secondary file:bg-navy-secondary/40 file:px-3 file:py-1.5 file:text-xs file:text-white hover:file:border-gold/60 disabled:opacity-50"
          />
          <p className="mt-1 text-2xs text-silver/60">
            PDF, image, or a .zip. Up to 10 MB per file — select several at
            once if the result arrived as multiple documents.
          </p>
          {busy && <p className="mt-1 text-2xs text-gold">Uploading…</p>}
        </div>
      )}
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
function rosterGroup(r: Pick<DrugTestPendingRow, 'group' | 'status'>): ScreeningRosterGroup {
  return r.group ?? (r.status === 'ACTIVE' ? 'current' : r.status === 'PENDING' ? 'starting' : 'paused');
}

/** The API takes 500 people a call; a bigger order goes in turns. */
const ORDER_BATCH = 500;

/** Reason picker shared by the two order dialogs; '' until someone chooses. */
function ReasonSelect({ value, onChange }: { value: DrugTestReason | ''; onChange: (r: DrugTestReason | '') => void }) {
  return (
    <Field label="Reason" required>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => onChange(e.target.value as DrugTestReason | '')}>
          <option value="">Choose why it was ordered</option>
          {DRUG_TEST_REASONS.map((r) => (
            <option key={r} value={r}>
              {DRUG_TEST_REASON_LABELS[r]}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/**
 * Bulk provider ordering. The roster is everyone whose 60-day clock ran out
 * (or never started) — recurrence is the point, so "had a test once"
 * doesn't exempt anyone — grouped by their one status (2026-11-03): Current
 * and Starting soon ticked, Paused unticked, people who left never listed.
 * A result awaiting review or a failed newest test keeps a person off it.
 * Downloading marks NOTHING; the "mark ordered" step is separate, gated
 * behind the download, and records why the tests were ordered and with whom.
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
  const [reason, setReason] = useState<DrugTestReason | ''>('');
  const [provider, setProvider] = useState('');

  const pendingQuery = useQuery({
    queryKey: ['BulkOrderDialog', 'pending', open],
    queryFn: () => listPendingDrugTests(),
    enabled: Boolean(open),
  });
  const pending: DrugTestPendingResponse | null = pendingQuery.data ?? null;
  const error = errorLocal ?? (pendingQuery.error ? pendingQuery.error instanceof ApiError ? pendingQuery.error.message : 'Could not load the pending list.' : null);
  useEffect(() => {
    setDownloaded(false);
    setGroups({ ...DEFAULT_ROSTER });
    setReason('');
    setProvider('');
  }, [open]);

  const all = pending?.rows ?? [];
  const countOf = (g: ScreeningRosterGroup) => all.filter((r) => rosterGroup(r) === g).length;
  const rows = all.filter((r) => groups[rosterGroup(r)]);
  const expired = rows.filter((r) => r.lastResultAt !== null).length;

  const toggleGroup = (g: ScreeningRosterGroup) => {
    setGroups((cur) => ({ ...cur, [g]: !cur[g] }));
    // The CSV on disk no longer matches the selection — force a re-download
    // before "mark ordered" can fire.
    setDownloaded(false);
  };

  const download = () => {
    if (rows.length === 0) return;
    const today = ymdLocal(); // the file is named for the reader's day, not UTC's
    // Header names exactly as the provider's template expects them.
    downloadCsv(`drug-test-bulk-order-${today}.csv`, [
      ['email', 'first name', 'phone number'],
      ...rows.map((r) => [r.email, r.firstName, r.phone ?? '']),
    ]);
    setDownloaded(true);
  };

  const markOrdered = async () => {
    if (rows.length === 0 || busy || !reason) return;
    setBusy(true);
    try {
      const ids = rows.map((r) => r.associateId);
      let created = 0;
      let skipped = 0;
      for (let i = 0; i < ids.length; i += ORDER_BATCH) {
        const res = await bulkInitiateDrugTests({ associateIds: ids.slice(i, i + ORDER_BATCH), provider: provider.trim() || 'manual', reason });
        created += res.created;
        skipped += res.skipped;
      }
      toast.success(
        skipped > 0
          ? `Marked ${created} ordered (${skipped} already had a test out or awaiting review).`
          : `Marked ${created} test${created === 1 ? '' : 's'} ordered.`,
      );
      onInitiated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark tests ordered.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk order drug tests</DialogTitle>
          <DialogDescription>
            Downloads everyone whose newest pass is missing or older than 60
            days as a CSV ready for the provider&rsquo;s bulk-order upload.
            People who left are never listed.
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorBanner className="mb-1">{error}</ErrorBanner>}

        {!pending && !error && <Skeleton className="h-16 w-full" />}

        {pending && all.length === 0 && (
          <p className="text-sm text-silver">
            Nobody is due — everyone current, starting soon or paused has a
            result inside the 60-day window, a test out, or one awaiting review.
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
              {rows.length === 1 ? 'person' : 'people'} selected
              {rows.length > 0 && (
                <span className="text-silver/70">
                  {' '}
                  — {rows.length - expired} never tested, {expired} expired
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
            <div className="grid gap-3 sm:grid-cols-2">
              <ReasonSelect value={reason} onChange={setReason} />
              <Field label="Provider">
                <Input placeholder="e.g. eScreen, Quest" maxLength={80} value={provider} onChange={(e) => setProvider(e.target.value)} />
              </Field>
            </div>
            {downloaded && (
              <p className="text-xs text-gold">
                CSV downloaded. Once it&rsquo;s been uploaded to the provider,
                mark these tests as ordered so this queue reflects it.
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
            onClick={() => void markOrdered()}
            loading={busy}
            disabled={!downloaded || rows.length === 0 || busy || !reason}
            title={
              !downloaded
                ? 'Download the CSV first'
                : !reason
                  ? 'Choose why these tests were ordered'
                  : 'Click after the CSV has been uploaded to the provider'
            }
          >
            Mark {rows.length > 0 ? rows.length : ''} ordered
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function labelFor(s: DrugTestStatus): string {
  switch (s) {
    case 'IN_PROGRESS':
      return 'Mark in progress';
    case 'NEEDS_REVIEW':
      return 'Needs review';
    case 'PASSED':
      return 'Mark passed';
    case 'FAILED':
      return 'Mark failed';
    case 'INITIATED':
      return 'Reopen';
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

function OrderTestDialog({
  open,
  initialAssociate = null,
  onOpenChange,
  onCreated,
  onError,
}: {
  open: boolean;
  /** Opens on this person (a never-tested row, a link to someone with no test). */
  initialAssociate?: PickedAssociate | null;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [provider, setProvider] = useState('');
  const [reason, setReason] = useState<DrugTestReason | ''>('');
  const [externalId, setExternalId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setAssociate(initialAssociate);
      setProvider('');
      setReason('');
      setExternalId('');
    }
    // Only on opening: the person picked inside the dialog stays theirs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!associate || !reason || busy) return;
    setBusy(true);
    try {
      const ref = externalId.trim();
      // One person's order through the same record the bulk CSV order makes
      // (the old single "order" was a stub). Someone with a test still out
      // or awaiting review isn't ordered twice. The provider is who runs it
      // ('manual' when not said — it used to say 'checkr' whatever the truth).
      const r = await bulkInitiateDrugTests({
        associateIds: [associate.id],
        provider: provider.trim() || 'manual',
        reason,
        ...(ref ? { externalId: ref } : {}),
      });
      if (r.created === 0) {
        toast.message(
          reason === 'RETURN_TO_DUTY' || reason === 'FOLLOW_UP'
            ? `${associate.name} already has a drug test out or awaiting review. Open it in the list.`
            : `${associate.name} has a drug test out, awaiting review, or failed — decide that one first. Open it in the list.`,
        );
      }
      onCreated();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Order failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Order drug test</DialogTitle>
          <DialogDescription>
            Records the order here; run it in the provider portal and upload
            the lab result when it comes back.
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
          <ReasonSelect value={reason} onChange={setReason} />
          <Field label="Provider (optional)" hint="The lab or screening company that runs it. A consumer reporting agency such as Checkr means the FCRA notices apply before failing anyone.">
            <Input
              placeholder="e.g. eScreen, Quest, Checkr"
              maxLength={80}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
          </Field>
          <Field label="Provider reference / external ID (optional)">
            <Input
              placeholder="e.g. eScreen order number"
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
              disabled={busy || !associate || !reason}
            >
              Order test
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
