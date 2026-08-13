import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeftRight,
  Briefcase,
  Building2,
  Check,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileSearch,
  FileSignature,
  Fingerprint,
  FlaskConical,
  FolderOpen,
  Landmark,
  Plane,
  ShieldCheck,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Send,
  ShieldAlert,
  Upload,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  DirectoryEntry,
  DirectoryStatus,
  DocumentKind,
  DocumentRecord,
  DocumentVaultResponse,
  DocumentVaultSummary,
} from '@alto-people/shared';
import { listDirectory, type DirectoryFilters } from '@/lib/directoryApi';
import { useClients } from '@/lib/useClients';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtMoney, fmtPayRate, parseYmd, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { EMPLOYMENT_LABEL } from '@/lib/employmentLabels';
import {
  type CompChangeReason,
  type CompRecord,
  type PayType,
  createRecord,
  listRecords,
} from '@/lib/compApi';
import {
  DOCUMENT_KIND_LABEL,
  downloadAllDocumentsUrl,
  downloadDocumentUrl,
  getDocumentVault,
  rejectDocument,
  uploadAdminDocument,
  verifyDocument,
} from '@/lib/documentsApi';
import { DocumentPreview } from '@/components/DocumentPreview';
import {
  createExternalPayment,
  deleteExternalPayment,
  listExternalPayments,
  updateExternalPayment,
  uploadPaymentEvidence,
} from '@/lib/externalPaymentsApi';
import type {
  ExternalPayment,
  ExternalPaymentInput,
  ExternalPaymentMethod,
} from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { nudgeApplicant } from '@/lib/onboardingApi';
import {
  eraseAssociatePersonalData,
  getAssociatePayoutMethod,
  getAssociatePersonalInfo,
  getAssociateSsn,
  getAssociateW4,
  listDepartments,
  patchAssociateProfile,
  revealAssociatePayoutMethod,
  revealAssociateSsn,
  setAssociateBankName,
  transferAssociate,
  updateAssociateW4,
  type AssociateW4,
  type PayoutMethodReveal,
  type SsnReveal,
} from '@/lib/orgApi';
import { listClientLocations } from '@/lib/clientsApi';
import type { LocationSummary } from '@alto-people/shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
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
  FilterBar,
  FilterChip,
  Input,
  Label,
  MetricCard,
  PageHeader,
  SearchInput,
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
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useTableSort,
  type TableSortState,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { usePersistentState } from '@/lib/usePersistentState';
import { StatusBadge, statusLabel } from '@/lib/status';

const PAY_TYPE_SUFFIX: Record<string, string> = {
  HOURLY: '/hr',
  SALARY: '/yr',
  COMMISSION: ' commission',
  PIECEWORK: '/piece',
};

function fmtPay(amount: string | null, type: string | null, currency: string | null): string {
  if (!amount) return '—';
  const formatted = fmtMoney(amount, { currency: currency ?? undefined });
  if (formatted === '—') return amount;
  return `${formatted}${type ? PAY_TYPE_SUFFIX[type] ?? '' : ''}`;
}

/**
 * Phase add-on — People directory.
 *
 * One-stop list of every associate Alto HR knows about. Each row carries the
 * "is this person showing up?" answers HR needs at a glance: status, current
 * workplace, pay rate, employment type, manager. Click a row to see the
 * full profile drawer with contact info, onboarding %, and links into the
 * detail pages (org structure, agreements, documents, comp history).
 */
// Status values a ?status= deep-link is allowed to seed. Guards against junk
// in the URL turning into a filter the picker can't represent.
const SEEDABLE_STATUSES = new Set<DirectoryStatus>([
  'ACTIVE',
  'PENDING',
  'INACTIVE',
]);

// Validators for the persisted filters — a stored value from a removed
// option falls back to the default instead of silently hiding rows.
const isStatusFilter = (v: unknown): v is DirectoryStatus | '' =>
  v === '' ||
  (typeof v === 'string' && SEEDABLE_STATUSES.has(v as DirectoryStatus));

type EmploymentTypeFilter = NonNullable<DirectoryFilters['employmentType']>;

const EMPLOYMENT_TYPE_VALUES: readonly EmploymentTypeFilter[] = [
  'W2_EMPLOYEE',
  'CONTRACTOR_1099_INDIVIDUAL',
  'CONTRACTOR_1099_BUSINESS',
];

const isEmploymentTypeFilter = (v: unknown): v is EmploymentTypeFilter | '' =>
  v === '' ||
  (typeof v === 'string' &&
    (EMPLOYMENT_TYPE_VALUES as readonly string[]).includes(v));

// PERF: the desktop table and the phone card stack used to BOTH mount, with
// CSS (`hidden md:block` / `md:hidden`) hiding the inactive one — React still
// committed ~9,000 dead DOM nodes for the hidden list on large directories.
// This matchMedia hook lets us mount only the list the viewport can
// actually show, and re-render on breakpoint crossings (resize / rotation).
//
// Same cutover rule as scheduling and Time & Attendance: mouse-class
// devices get the table at md; touch devices (iPad portrait) keep the
// card list until lg instead of a desktop table in ~half a screen.
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

export function PeopleDirectory() {
  const queryClient = useQueryClient();
  const isDesktop = useIsDesktop();
  // Persisted list filters — status / workplace / employment type survive
  // revisits ('' = All). Free-text search and the cascading location /
  // department facets deliberately stay per-session.
  const [status, setStatus] = usePersistentState<DirectoryStatus | ''>(
    'alto:list.people.status.v1',
    '',
    isStatusFilter,
  );
  const [clientId, setClientId] = usePersistentState<string>(
    'alto:list.people.client.v1',
    '',
    (v): v is string => typeof v === 'string',
  );
  const [employmentType, setEmploymentType] = usePersistentState<
    EmploymentTypeFilter | ''
  >('alto:list.people.employmentType.v1', '', isEmploymentTypeFilter);
  const [locationId, setLocationId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  // ?q= seeds the search box (command-palette people results deep-link
  // here) — initial value only; typing takes over from there.
  const [q, setQ] = useState(
    () => new URLSearchParams(window.location.search).get('q')?.trim() ?? '',
  );
  // Seed the status filter from ?status= so dashboard tiles / cross-links can
  // deep-link straight to a filtered directory (e.g. /people?status=ACTIVE).
  // The deep link beats the persisted value. Applied during the first render
  // (React's adjust-state-while-rendering pattern) so the initial fetch
  // already carries the right filter.
  const urlSeedApplied = useRef(false);
  if (!urlSeedApplied.current) {
    urlSeedApplied.current = true;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('status') as DirectoryStatus | null;
    if (raw && SEEDABLE_STATUSES.has(raw) && raw !== status) setStatus(raw);
    // ?employmentType= deep-link — the headcount dashboard's
    // by-employment-type rows land here pre-filtered.
    const rawType = params.get('employmentType');
    if (
      rawType &&
      (EMPLOYMENT_TYPE_VALUES as readonly string[]).includes(rawType) &&
      rawType !== employmentType
    ) {
      setEmploymentType(rawType as EmploymentTypeFilter);
    }
  }
  const filters = useMemo<DirectoryFilters>(
    () => ({
      ...(q ? { q } : {}),
      ...(status ? { status } : {}),
      ...(clientId ? { clientId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(employmentType ? { employmentType } : {}),
    }),
    [q, status, clientId, locationId, departmentId, employmentType],
  );
  const [search, setSearch] = useState(
    () => new URLSearchParams(window.location.search).get('q') ?? '',
  );
  // useDeferredValue keeps the search input itself snappy even when the
  // committed `search` change would cause an expensive React re-render
  // downstream (virtualizer measure pass, filter chip recompute). React
  // shows the previous list while the new one is being computed in the
  // background. The debounce below still throttles the server fetch.
  const deferredSearch = useDeferredValue(search);
  const [target, setTarget] = useState<DirectoryEntry | null>(null);
  // Deep-link support: /people?associateId=<uuid> auto-opens the drawer
  // for that associate. Used by the payroll readiness dashboard so a
  // red-X click lands on the right profile. We consume the param once
  // (drop it on first match) so back-navigating doesn't re-open.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkAssociateId = searchParams.get('associateId');

  // Debounce the deferred search input. We search server-side to keep
  // the row math (status derivation, comp lookup) honest with paging in
  // the future. Using `deferredSearch` here means React can prioritise
  // typing-into-the-input over kicking the timer forward, which keeps
  // the field snappy under load.
  useEffect(() => {
    const id = setTimeout(() => {
      // Same-value sets of a primitive are no-ops, so no churn guard needed.
      setQ(deferredSearch.trim());
    }, 250);
    return () => clearTimeout(id);
  }, [deferredSearch]);

  // Clients change rarely; the shared useClients() hook pins every picker
  // in the app to one cached fetch (5-min staleTime, single query key —
  // this also keeps the ['clients','list'] cache shape consistent with the
  // other useClients() consumers). Failures are silent — the dropdown just
  // shows "All clients" without specific options.
  const { clients } = useClients();

  // Departments for the directory facet. Same long cache / silent-failure
  // treatment as clients — the picker just falls back to "All departments".
  const { data: departments = [] } = useQuery({
    queryKey: ['departments', 'list'],
    queryFn: async () => (await listDepartments()).departments,
    staleTime: 5 * 60_000,
  });

  // Locations cascade off the selected workplace — a store-level facet only
  // makes sense once a client is chosen. The locationId is cleared in the
  // Workplace onChange below so it can never dangle on a different client.
  const { data: locations = [] } = useQuery({
    queryKey: ['client-locations', clientId],
    queryFn: async () => (await listClientLocations(clientId)).locations,
    enabled: Boolean(clientId),
    staleTime: 5 * 60_000,
  });

  // A persisted workplace filter can outlive its client. If the loaded
  // client list doesn't contain it, the Select would display "All" while
  // the server filter silently hides everyone — reset it instead.
  useEffect(() => {
    if (
      clientId &&
      clients.length > 0 &&
      !clients.some((c) => c.id === clientId)
    ) {
      setClientId('');
      setLocationId('');
    }
  }, [clientId, clients, setClientId]);

  // keepPreviousData makes filter/search changes show the old rows
  // (faded by isFetching) until the new ones arrive instead of flashing
  // a skeleton — much smoother on slow connections.
  // Cursor-paged. The endpoint has always returned `nextCursor`; this
  // page used to drop it on the floor, so associate #501 onward was
  // invisible with no "load more" and no warning — the list simply
  // ended. useInfiniteQuery consumes the cursor the server already sends.
  const {
    data: pages,
    error: rowsError,
    isFetching: rowsFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['directory', filters],
    queryFn: ({ pageParam }) =>
      listDirectory({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    // A minute of freshness: back-navigating to the directory (or re-
    // applying a recent filter combo) renders instantly from cache instead
    // of refetching every page.
    staleTime: 60_000,
  });
  const rows = useMemo(
    () => pages?.pages.flatMap((p) => p.associates),
    [pages],
  );

  // Resolve the deep-link associateId once rows load. setTarget is the
  // canonical drawer-open path so we get all the existing render logic
  // for free. Strip the query param so the URL stays clean and a back-
  // forward dance doesn't re-open the drawer after the user closed it.
  //
  // When no loaded row matches (persisted status/workplace filters can
  // hide the person), there's no single-associate getter in the
  // directory API to fall back on — so we clear those filters once and
  // let the refetch surface them. If they're still absent after the
  // widened fetch, the id is stale: drop the param instead of looping.
  const deepLinkRetried = useRef(false);
  useEffect(() => {
    if (!deepLinkAssociateId || !rows || rowsFetching) return;
    const dropParam = () => {
      const next = new URLSearchParams(searchParams);
      next.delete('associateId');
      setSearchParams(next, { replace: true });
    };
    const match = rows.find((r) => r.id === deepLinkAssociateId);
    if (match) {
      setTarget(match);
      dropParam();
      return;
    }
    if (
      !deepLinkRetried.current &&
      (status || clientId || locationId || departmentId || employmentType || q)
    ) {
      deepLinkRetried.current = true;
      // Clear EVERY narrowing filter — a persisted employmentType (or a
      // live search/department filter) hid deep-link targets just as
      // effectively as the three this used to reset, e.g. any 1099
      // contractor while the saved filter was W-2.
      clearAllFilters();
      toast('Cleared filters to show this person.');
      return;
    }
    toast.error("Couldn't find that person in the directory.");
    dropParam();
  }, [
    deepLinkAssociateId,
    rows,
    rowsFetching,
    searchParams,
    setSearchParams,
    status,
    clientId,
    locationId,
    departmentId,
    employmentType,
    q,
    setStatus,
    setClientId,
  ]);
  const error = rowsError
    ? rowsError instanceof ApiError
      ? rowsError.message
      : 'Failed to load.'
    : null;

  const stats = useMemo(() => {
    if (!rows) return null;
    const byStatus: Record<DirectoryStatus, number> = {
      ACTIVE: 0,
      PENDING: 0,
      INACTIVE: 0,
    };
    for (const r of rows) byStatus[r.status] += 1;
    return { total: rows.length, ...byStatus };
  }, [rows]);

  const hasActiveFilters = Boolean(
    q || status || clientId || locationId || departmentId || employmentType,
  );

  const clearAllFilters = () => {
    setSearch('');
    setQ('');
    setStatus('');
    setClientId('');
    setLocationId('');
    setDepartmentId('');
    setEmploymentType('');
  };

  // Serializes the ENTIRE filtered directory, not just the pages the
  // admin happened to scroll through — the old version exported loaded
  // rows only, so a headcount export from a >1-page directory silently
  // missed everyone past the first page.
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const all: DirectoryEntry[] = [];
      let cursor: string | undefined;
      do {
        const res = await listDirectory({
          ...filters,
          ...(cursor ? { cursor } : {}),
        });
        all.push(...res.associates);
        cursor = res.nextCursor ?? undefined;
      } while (cursor);
      if (all.length === 0) return;
      downloadCsv(`people-${ymdLocal()}.csv`, [
        ['Name', 'Status', 'Email', 'Workplace', 'Type', 'Start date'],
        ...all.map((r) => [
          `${r.firstName} ${r.lastName}`,
          statusLabel(r.status),
          r.email,
          r.workplaceClientName ?? '',
          EMPLOYMENT_LABEL[r.employmentType] ?? r.employmentType,
          r.startDate ?? '',
        ]),
      ]);
    } catch {
      toast.error('Export failed — try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="People directory"
        subtitle="Every associate Alto HR knows about — active, pending onboarding, and inactive — with workplace, pay, and contact in one row."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'People' }]}
        primaryAction={
          <Button asChild>
            <Link to="/onboarding">
              <Plus className="h-4 w-4" />
              Invite associates
            </Link>
          </Button>
        }
        secondaryActions={
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={!rows || rows.length === 0 || exporting}
            title="Download the current filtered list as CSV (all pages)"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        }
      />

      {/* KPI strip. Counts cover the pages loaded so far; the "+" is the
          honest signal that more exist beyond the fetch horizon (status
          is derived server-side per page, so exact totals would need a
          full walk on every filter change). */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            label={hasNextPage ? 'Total (loaded)' : 'Total'}
            value={hasNextPage ? `${stats.total}+` : stats.total}
          />
          <MetricCard label="Active" value={hasNextPage ? `${stats.ACTIVE}+` : stats.ACTIVE} />
          {/* Interactive tile: toggles the Pending status filter. Wrapped
              outside MetricCard so the canonical tile stays presentational. */}
          <button
            type="button"
            onClick={() => setStatus((s) => (s === 'PENDING' ? '' : 'PENDING'))}
            aria-pressed={status === 'PENDING'}
            title={
              status === 'PENDING'
                ? 'Clear filter'
                : 'Filter to pending onboarding'
            }
            className={cn(
              'text-left rounded-lg transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
              status === 'PENDING' && 'ring-1 ring-gold/40',
            )}
          >
            <MetricCard
              label="Pending onboarding"
              value={hasNextPage ? `${stats.PENDING}+` : stats.PENDING}
              accent={stats.PENDING > 0}
              className="h-full"
            />
          </button>
          <MetricCard
            label="Inactive"
            value={hasNextPage ? `${stats.INACTIVE}+` : stats.INACTIVE}
          />
        </div>
      )}

      {/* Filter row */}
      <FilterBar>
        <div className="w-full sm:w-64">
          <SearchInput
            size="sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email"
            aria-label="Search people"
          />
        </div>
        {(['ACTIVE', 'PENDING', 'INACTIVE'] as const).map((s) => (
          <FilterChip
            key={s}
            active={status === s}
            onClick={() => setStatus(status === s ? '' : s)}
          >
            {statusLabel(s)}
          </FilterChip>
        ))}
        <Select
          size="sm"
          value={clientId}
          onChange={(e) => {
            // Changing the workplace drops any location filter — a store
            // from the previous client would match nothing here.
            setClientId(e.target.value);
            setLocationId('');
          }}
          aria-label="Filter by workplace"
          className="w-auto"
        >
          <option value="">All workplaces</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {clientId && locations.length > 0 && (
          <Select
            size="sm"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            aria-label="Filter by location"
            className="w-auto"
          >
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        {departments.length > 0 && (
          <Select
            size="sm"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            aria-label="Filter by department"
            className="w-auto"
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        )}
        <Select
          size="sm"
          value={employmentType}
          onChange={(e) =>
            setEmploymentType(e.target.value as EmploymentTypeFilter | '')
          }
          aria-label="Filter by employment type"
          className="w-auto"
        >
          <option value="">All employment types</option>
          <option value="W2_EMPLOYEE">W-2</option>
          <option value="CONTRACTOR_1099_INDIVIDUAL">1099 Individual</option>
          <option value="CONTRACTOR_1099_BUSINESS">1099 Business</option>
        </Select>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="xs"
            onClick={clearAllFilters}
            className="ml-auto"
          >
            <X className="h-3.5 w-3.5" />
            Clear filters
          </Button>
        )}
      </FilterBar>

      {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

      {!rows && !error && <SkeletonRows count={8} rowHeight="h-14" />}

      {rows && rows.length === 0 && (
        <EmptyState
          icon={Users}
          title={
            hasActiveFilters
              ? 'No associates match these filters'
              : 'No associates yet'
          }
          description={
            hasActiveFilters
              ? 'Loosen a filter or clear the search.'
              : 'Once you invite associates through onboarding they show up here.'
          }
          action={
            hasActiveFilters ? (
              <Button variant="outline" size="sm" onClick={clearAllFilters}>
                <X className="h-3.5 w-3.5" />
                Clear all filters
              </Button>
            ) : (
              <Button asChild size="sm">
                <Link to="/onboarding">
                  <Plus className="h-3.5 w-3.5" />
                  Invite associates
                </Link>
              </Button>
            )
          }
        />
      )}

      {rows && rows.length > 0 && (
        // Only the breakpoint-active list is mounted (useIsDesktop) — the
        // other used to render hidden, doubling DOM size for nothing.
        isDesktop ? (
          /* md+ : columnar table. Columns reveal progressively as
              viewport widens (md: Position, lg: Type + Pay, xl: Manager
              + Start). For lists past VIRTUALIZE_THRESHOLD we swap in a
              row virtualizer so DOM size stays bounded regardless of the
              underlying list size. */
          <DirectoryTable rows={rows} onSelect={setTarget} />
        ) : (
          /* Phone: card stack. Tap card → drawer (same as table click). */
          <ul className="space-y-2">
            {rows.map((r) => (
              <DirectoryPhoneCard key={r.id} row={r} onSelect={setTarget} />
            ))}
          </ul>
        )
      )}

      {/* The list is capped per page. Without this control the directory
          simply ended at the cap with no indication more people existed. */}
      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            onClick={() => void fetchNextPage()}
            loading={isFetchingNextPage}
            disabled={isFetchingNextPage}
          >
            Load more associates
          </Button>
        </div>
      )}

      <Drawer
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        width="max-w-2xl"
      >
        {target && (
          <DirectoryDrawer
            associate={target}
            onClose={() => setTarget(null)}
            onAssociateChange={(patch) => {
              const updated = { ...target, ...patch };
              setTarget(updated);
              // This key holds useInfiniteQuery's InfiniteData ({pages,
              // pageParams}), NOT a flat array — treating it as one threw
              // a TypeError inside the updater, which surfaced as a false
              // "Could not save/transfer" toast on writes that had already
              // succeeded server-side (and tempted a duplicate retry).
              queryClient.setQueryData<{
                pages: Array<{ associates: DirectoryEntry[] } & Record<string, unknown>>;
                pageParams: unknown[];
              }>(['directory', filters], (old) =>
                old
                  ? {
                      ...old,
                      pages: old.pages.map((p) => ({
                        ...p,
                        associates: p.associates.map((r) =>
                          r.id === updated.id ? updated : r,
                        ),
                      })),
                    }
                  : old,
              );
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

// Above this row count we swap from a plain DOM table to a virtualized
// one. The threshold is empirical: with the current row design (avatar,
// 4 cells, ~56px tall) Chrome handles up to ~200-300 rows smoothly, but
// scroll-jank and search-input lag become visible past that as React
// has to reconcile every row on each filter keystroke. With
// keepPreviousData it's worse — both the old and new lists exist in
// memory during a fetch. Virtualizing means the rendered DOM stays
// bounded regardless of the result count.
const VIRTUALIZE_THRESHOLD = 100;
const ROW_HEIGHT_PX = 56;
// Pad the visible window so a smooth scroll doesn't immediately reveal
// blank rows at the edges while the next batch is measured.
const VIRTUAL_OVERSCAN = 8;
// Cap the inner scroll container at this much of the viewport so the
// table doesn't push the rest of the page out of view. Headers stay
// sticky inside this container, so the user gets a familiar "scroll
// inside the data grid" affordance.
const VIRTUAL_CONTAINER_MAX_VH = 'max-h-[calc(100vh-360px)]';

type DirectorySortKey =
  | 'name'
  | 'status'
  | 'workplace'
  | 'position'
  | 'type'
  | 'pay'
  | 'manager'
  | 'start';

function DirectoryTable({
  rows,
  onSelect,
}: {
  rows: DirectoryEntry[];
  onSelect: (row: DirectoryEntry) => void;
}) {
  // Click-to-sort over the page of rows the server returned (post-filter).
  // Third click on a header clears back to server order.
  const { sorted, sortState, toggleSort } = useTableSort(rows, {
    name: (r: DirectoryEntry) => `${r.firstName} ${r.lastName}`,
    status: (r: DirectoryEntry) => r.status,
    workplace: (r: DirectoryEntry) => r.workplaceClientName,
    position: (r: DirectoryEntry) => r.position,
    type: (r: DirectoryEntry) =>
      EMPLOYMENT_LABEL[r.employmentType] ?? r.employmentType,
    pay: (r: DirectoryEntry) => {
      const n = r.payAmount === null ? NaN : Number(r.payAmount);
      return Number.isFinite(n) ? n : null;
    },
    manager: (r: DirectoryEntry) => r.managerName,
    start: (r: DirectoryEntry) =>
      r.startDate ? new Date(r.startDate).getTime() : null,
  });
  if (rows.length <= VIRTUALIZE_THRESHOLD) {
    return (
      <Card className="overflow-hidden">
        <Table caption="Associate directory">
          <TableHeader>
            <DirectoryHeaderRow state={sortState} onSort={toggleSort} />
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <DirectoryRow key={r.id} row={r} onSelect={onSelect} />
            ))}
          </TableBody>
        </Table>
      </Card>
    );
  }
  return (
    <VirtualDirectoryTable
      rows={sorted}
      sortState={sortState}
      onSort={toggleSort}
      onSelect={onSelect}
    />
  );
}

function DirectoryHeaderRow({
  state,
  onSort,
}: {
  state: TableSortState<DirectorySortKey>;
  onSort: (key: DirectorySortKey) => void;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <SortableTableHead sortKey="name" state={state} onSort={onSort}>
        Associate
      </SortableTableHead>
      <SortableTableHead sortKey="status" state={state} onSort={onSort} className="w-28">
        Status
      </SortableTableHead>
      <SortableTableHead sortKey="workplace" state={state} onSort={onSort}>
        Workplace
      </SortableTableHead>
      <SortableTableHead sortKey="position" state={state} onSort={onSort} className="hidden md:table-cell">
        Position
      </SortableTableHead>
      <SortableTableHead sortKey="type" state={state} onSort={onSort} className="hidden lg:table-cell w-24">
        Type
      </SortableTableHead>
      <SortableTableHead sortKey="pay" state={state} onSort={onSort} className="hidden lg:table-cell">
        Pay rate
      </SortableTableHead>
      <SortableTableHead sortKey="manager" state={state} onSort={onSort} className="hidden xl:table-cell">
        Manager
      </SortableTableHead>
      <SortableTableHead sortKey="start" state={state} onSort={onSort} className="hidden xl:table-cell w-24">
        Start
      </SortableTableHead>
    </TableRow>
  );
}

function VirtualDirectoryTable({
  rows,
  sortState,
  onSort,
  onSelect,
}: {
  rows: DirectoryEntry[];
  sortState: TableSortState<DirectorySortKey>;
  onSort: (key: DirectorySortKey) => void;
  onSelect: (row: DirectoryEntry) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // useVirtualizer reports start/end indices of items that should be
  // mounted given the current scroll position. We pad before/after the
  // window with two empty <tr> "spacer rows" of the correct total height
  // so the <tbody> retains its full scrollable size — the browser thinks
  // every row exists, the DOM only ever holds ~30.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: VIRTUAL_OVERSCAN,
  });

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = items.length > 0 ? items[0].start : 0;
  const paddingBottom =
    items.length > 0 ? totalSize - items[items.length - 1].end : 0;

  return (
    <Card className="overflow-hidden">
      <div ref={scrollRef} className={`overflow-y-auto ${VIRTUAL_CONTAINER_MAX_VH}`}>
        <Table caption="Associate directory">
          <TableHeader>
            <DirectoryHeaderRow state={sortState} onSort={onSort} />
          </TableHeader>
          <TableBody>
            {paddingTop > 0 && (
              <tr aria-hidden style={{ height: `${paddingTop}px` }} />
            )}
            {items.map((virtualRow) => {
              const r = rows[virtualRow.index];
              return <DirectoryRow key={r.id} row={r} onSelect={onSelect} />;
            })}
            {paddingBottom > 0 && (
              <tr aria-hidden style={{ height: `${paddingBottom}px` }} />
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

// Memoised so unrelated state changes (drawer open, search keystroke,
// filter dropdown click) don't re-render every row. Profiling showed
// this saved ~40 ms / interaction at 200 rows.
const DirectoryRow = memo(function DirectoryRow({
  row: r,
  onSelect,
}: {
  row: DirectoryEntry;
  onSelect: (row: DirectoryEntry) => void;
}) {
  return (
    <TableRow className="cursor-pointer" onClick={() => onSelect(r)}>
      <TableCell>
        <div className="flex items-center gap-2.5">
          <Avatar
            src={r.photoUrl}
            name={`${r.firstName} ${r.lastName}`}
            email={r.email}
            size="sm"
          />
          <div className="min-w-0">
            <div className="font-medium text-white truncate">
              {r.firstName} {r.lastName}
            </div>
            <div className="text-xs text-silver truncate">{r.email}</div>
          </div>
          {r.j1Status && (
            <Badge variant="default" className="ml-1 text-2xs">
              J-1
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <StatusBadge status={r.status} />
          {r.status === 'PENDING' && r.onboardingPercent !== null && (
            <span className="text-2xs tabular-nums text-silver">
              {r.onboardingPercent}%
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-silver">
        {r.workplaceClientId && r.workplaceClientName ? (
          <Link
            to={`/clients/${r.workplaceClientId}`}
            onClick={(e) => e.stopPropagation()}
            className="hover:text-white inline-flex items-center gap-1.5"
          >
            <Building2 className="h-3.5 w-3.5" />
            <span className="truncate">{r.workplaceClientName}</span>
          </Link>
        ) : (
          <span className="text-silver/70" aria-hidden="true">—</span>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell text-silver">
        {r.position ?? <span className="text-silver/70" aria-hidden="true">—</span>}
      </TableCell>
      <TableCell className="hidden lg:table-cell text-xs text-silver">
        {EMPLOYMENT_LABEL[r.employmentType] ?? r.employmentType}
      </TableCell>
      <TableCell className="hidden lg:table-cell text-silver tabular-nums">
        {fmtPay(r.payAmount, r.payType, r.payCurrency)}
      </TableCell>
      <TableCell className="hidden xl:table-cell text-silver">
        {r.managerName ? (
          r.managerId ? (
            <Link
              to={`/people?associateId=${r.managerId}`}
              onClick={(e) => e.stopPropagation()}
              className="hover:text-white"
            >
              {r.managerName}
            </Link>
          ) : (
            r.managerName
          )
        ) : (
          <span className="text-silver/70" aria-hidden="true">—</span>
        )}
      </TableCell>
      <TableCell className="hidden xl:table-cell text-silver text-xs tabular-nums">
        {r.startDate ? (
          fmtDate(parseYmd(r.startDate) ?? r.startDate)
        ) : (
          <span className="text-silver/70" aria-hidden="true">—</span>
        )}
      </TableCell>
    </TableRow>
  );
});

const DirectoryPhoneCard = memo(function DirectoryPhoneCard({
  row: r,
  onSelect,
}: {
  row: DirectoryEntry;
  onSelect: (row: DirectoryEntry) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(r)}
        className="w-full text-left rounded-md border border-navy-secondary bg-navy/40 p-3 hover:border-silver/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <div className="flex items-start gap-2.5">
          <Avatar
            src={r.photoUrl}
            name={`${r.firstName} ${r.lastName}`}
            email={r.email}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="font-medium text-white truncate">
                {r.firstName} {r.lastName}
              </div>
              <StatusBadge status={r.status} className="shrink-0" />
            </div>
            <div className="text-xs text-silver truncate">{r.email}</div>
            {(r.workplaceClientName || r.position) && (
              <div className="mt-1 text-xs2 text-silver/80 truncate">
                {r.workplaceClientName && (
                  <span className="inline-flex items-center gap-1">
                    <Building2 className="h-3 w-3" />
                    {r.workplaceClientName}
                  </span>
                )}
                {r.workplaceClientName && r.position && (
                  <span className="mx-1.5 text-silver/70" aria-hidden="true">·</span>
                )}
                {r.position}
              </div>
            )}
            {r.status === 'PENDING' && r.onboardingPercent !== null && (
              <div className="mt-1 text-2xs tabular-nums text-silver">
                Onboarding {r.onboardingPercent}%
              </div>
            )}
            {r.j1Status && (
              <Badge variant="default" className="mt-1.5 text-2xs">
                J-1
              </Badge>
            )}
          </div>
        </div>
      </button>
    </li>
  );
});

function DirectoryDrawer({
  associate: a,
  onClose,
  onAssociateChange,
}: {
  associate: DirectoryEntry;
  onClose: () => void;
  onAssociateChange: (patch: Partial<DirectoryEntry>) => void;
}) {
  // ?tab= picks the landing tab, so /people?associateId=X&tab=documents
  // deep-links straight into someone's document vault.
  const [drawerParams] = useSearchParams();
  const requestedDrawerTab = drawerParams.get('tab');
  const [tab, setTab] = useState<'profile' | 'compensation' | 'payments' | 'documents'>(
    requestedDrawerTab === 'compensation' ||
      requestedDrawerTab === 'documents' ||
      requestedDrawerTab === 'payments'
      ? requestedDrawerTab
      : 'profile',
  );
  const { user } = useAuth();
  const canSeePayments = user ? hasCapability(user.role, 'process:payroll') : false;
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar src={a.photoUrl} name={`${a.firstName} ${a.lastName}`} email={a.email} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              {a.firstName} {a.lastName}
            </DrawerTitle>
            <DrawerDescription className="truncate flex items-center gap-2">
              <StatusBadge status={a.status} className="text-2xs" />
              <span>{EMPLOYMENT_LABEL[a.employmentType] ?? a.employmentType}</span>
              {a.j1Status && <Badge variant="default">J-1</Badge>}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="compensation">Compensation</TabsTrigger>
            {canSeePayments && <TabsTrigger value="payments">Payments</TabsTrigger>}
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <ProfileTab associate={a} onAssociateChange={onAssociateChange} />
          </TabsContent>
          <TabsContent value="compensation">
            <CompensationTab associate={a} />
          </TabsContent>
          {canSeePayments && (
            <TabsContent value="payments">
              <PaymentsTab associateId={a.id} />
            </TabsContent>
          )}
          <TabsContent value="documents">
            <DocumentsTab associateId={a.id} />
          </TabsContent>
        </Tabs>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to={`/org?tab=people&associateId=${a.id}`}>
            Edit org assignment
          </Link>
        </Button>
      </DrawerFooter>
    </>
  );
}

function ProfileTab({
  associate: a,
  onAssociateChange,
}: {
  associate: DirectoryEntry;
  onAssociateChange: (patch: Partial<DirectoryEntry>) => void;
}) {
  const [transferOpen, setTransferOpen] = useState(false);
  const canTransfer = Boolean(a.workplaceClientId);
  return (
    <div className="space-y-4">
      <PersonalInfoSection associate={a} />

      <Section title="Contact">
        <InfoRow
          icon={<Mail className="h-3.5 w-3.5" />}
          label="Email"
          value={
            <a
              href={`mailto:${a.email}`}
              className="text-gold hover:text-gold-bright"
            >
              {a.email}
            </a>
          }
        />
        <PhoneField
          associate={a}
          onSaved={(phone) => onAssociateChange({ phone })}
        />
      </Section>

      <Section title="Workplace">
        <InfoRow
          icon={<Building2 className="h-3.5 w-3.5" />}
          label="Client"
          value={
            a.workplaceClientId && a.workplaceClientName ? (
              <Link
                to={`/clients/${a.workplaceClientId}`}
                className="text-gold hover:text-gold-bright"
              >
                {a.workplaceClientName}
              </Link>
            ) : (
              '—'
            )
          }
        />
        <InfoRow
          icon={<MapPin className="h-3.5 w-3.5" />}
          label="Location"
          value={a.currentLocationName ?? '—'}
        />
        <InfoRow
          icon={<Briefcase className="h-3.5 w-3.5" />}
          label="Position"
          value={a.position ?? '—'}
        />
        <InfoRow
          label="Start date"
          value={a.startDate ? fmtDate(parseYmd(a.startDate) ?? a.startDate) : '—'}
        />
        {a.status === 'PENDING' && a.onboardingPercent !== null && (
          <InfoRow
            label="Onboarding"
            value={
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 rounded bg-navy-secondary/60 overflow-hidden max-w-[160px]">
                  <div
                    className="h-full bg-warning"
                    style={{ width: `${a.onboardingPercent}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-silver">
                  {a.onboardingPercent}%
                </span>
                {a.applicationId && (
                  <Link
                    to={`/onboarding/applications/${a.applicationId}`}
                    className="text-xs text-gold hover:text-gold-bright whitespace-nowrap"
                  >
                    View checklist
                  </Link>
                )}
              </div>
            }
          />
        )}
        {canTransfer && (
          <div className="pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTransferOpen(true)}
            >
              <ArrowLeftRight className="mr-2 h-3.5 w-3.5" />
              {a.currentLocationId ? 'Transfer' : 'Assign to location'}
            </Button>
          </div>
        )}
      </Section>

      {canTransfer && (
        <TransferDialog
          open={transferOpen}
          onOpenChange={setTransferOpen}
          associate={a}
          onSaved={(locationId, locationName) => {
            onAssociateChange({
              currentLocationId: locationId,
              currentLocationName: locationName,
            });
            setTransferOpen(false);
          }}
        />
      )}

      {a.status === 'PENDING' && a.applicationId && (
        <PendingActions
          applicationId={a.applicationId}
          associateName={`${a.firstName} ${a.lastName}`}
        />
      )}

      <Section title="Org assignment">
        <InfoRow
          label="Manager"
          value={
            a.managerName ? (
              a.managerId ? (
                <Link
                  to={`/people?associateId=${a.managerId}`}
                  className="text-gold hover:text-gold-bright"
                >
                  {a.managerName}
                </Link>
              ) : (
                a.managerName
              )
            ) : (
              '—'
            )
          }
        />
        <InfoRow label="Department" value={a.departmentName ?? '—'} />
        <InfoRow label="Job profile" value={a.jobProfileTitle ?? '—'} />
      </Section>

      <PayoutMethodSection associateId={a.id} />

      <SsnSection associateId={a.id} />

      <W4Section associateId={a.id} />

      <Section title="On record">
        <InfoRow
          label="In Alto HR since"
          value={fmtDate(a.createdAt)}
        />
        {a.separatedAt && (
          <InfoRow
            label="Separated"
            value={
              <span className="text-silver">
                {fmtDate(a.separatedAt)} — deactivated (login disabled). Re-invite
                to rehire.
              </span>
            }
          />
        )}
        {!a.separatedAt && a.status === 'ACTIVE' && (
          <InfoRow
            label="Offboarding"
            value={
              <Link
                to={`/separations?associateId=${a.id}`}
                className="text-gold hover:text-gold-bright"
              >
                Start a separation to deactivate this associate
              </Link>
            }
          />
        )}
      </Section>

      <DangerZoneSection associate={a} />
    </div>
  );
}

/**
 * Danger zone — privacy erasure. Anonymizes the associate's identity and
 * scrubs credentials/ciphertext; payroll and tax history is legally
 * retained and stays. Gated on view:hr-admin, the same capability that
 * guards admin user management. The dialog demands a written reason and
 * retyping the associate's last name (the server 409s on a mismatch).
 */
function DangerZoneSection({ associate: a }: { associate: DirectoryEntry }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);

  const canErase = user ? hasCapability(user.role, 'view:hr-admin') : false;
  if (!canErase) return null;

  const openDialog = () => {
    setReason('');
    setConfirmName('');
    setForce(false);
    setOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await eraseAssociatePersonalData(a.id, {
        reason: reason.trim(),
        confirmName: confirmName.trim(),
        ...(force ? { force: true } : {}),
      });
      toast.success('Personal data erased. Payroll history is retained.');
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['directory'] });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Erasure failed. Nothing was changed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Danger zone">
      <p className="text-xs text-silver/80">
        Permanently anonymize this associate’s identity, delete their login
        credentials, biometrics and document files. Pay and tax history is
        kept, as required by law, under the anonymized record.
      </p>
      <div className="pt-2">
        <Button variant="destructive" size="sm" onClick={openDialog}>
          <ShieldAlert className="mr-2 h-3.5 w-3.5" />
          Erase personal data
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Erase personal data — {a.firstName} {a.lastName}
            </DialogTitle>
            <DialogDescription>
              This cannot be undone. Name, contact details, SSN, bank
              details, documents, biometrics and login access are erased.
              Time and payroll records are retained (IRS: 4 years, FLSA: 3
              years) against the anonymized record.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="erase-reason">Reason (required, min 10 characters)</Label>
              <Textarea
                id="erase-reason"
                autoFocus
                required
                minLength={10}
                maxLength={500}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. GDPR/CCPA deletion request received 2026-07-20, ticket #1234"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="erase-confirm-name">
                Type the associate’s last name (“{a.lastName}”) to confirm
              </Label>
              <Input
                id="erase-confirm-name"
                required
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={a.lastName}
                autoComplete="off"
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-silver">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Erase even though this associate is not marked separated
                (only needed when the server refuses with “not separated”).
              </span>
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                loading={busy}
                disabled={
                  busy || reason.trim().length < 10 || confirmName.trim().length === 0
                }
              >
                Erase permanently
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function PhoneField({
  associate: a,
  onSaved,
}: {
  associate: DirectoryEntry;
  onSaved: (phone: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.phone ?? '');
  const [saving, setSaving] = useState(false);

  // Reset the draft whenever the canonical phone changes (e.g. another
  // tab on this row saved it). Avoids stale text staying in the input.
  useEffect(() => {
    if (!editing) setDraft(a.phone ?? '');
  }, [a.phone, editing]);

  async function save() {
    if (saving) return;
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next === a.phone) {
      setEditing(false);
      return;
    }
    if (next !== null && next.length < 7) {
      toast.error('Phone must be at least 7 characters.');
      return;
    }
    setSaving(true);
    try {
      const r = await patchAssociateProfile(a.id, { phone: next });
      onSaved(r.phone);
      toast.success('Phone updated.');
      setEditing(false);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save.';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-start gap-3 text-sm">
        <div className="w-32 text-silver text-xs flex items-center gap-1.5 pt-2">
          <Phone className="h-3.5 w-3.5" />
          <span>Phone</span>
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-1">
          <Input
            type="tel"
            inputMode="tel"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="555 555 0123"
            className="h-8 text-sm"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(a.phone ?? '');
                setEditing(false);
              }
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void save()}
            disabled={saving}
            aria-label="Save phone"
            title="Save"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setDraft(a.phone ?? '');
              setEditing(false);
            }}
            disabled={saving}
            aria-label="Cancel"
            title="Cancel"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <InfoRow
      icon={<Phone className="h-3.5 w-3.5" />}
      label="Phone"
      value={
        <div className="flex items-center gap-2 group">
          <span className="flex-1 min-w-0">
            {a.phone ? (
              <a href={`tel:${a.phone}`} className="hover:text-white">
                {a.phone}
              </a>
            ) : (
              '—'
            )}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setEditing(true)}
            aria-label="Edit phone"
            title="Edit"
            // Always visible on touch devices (no hover to reveal it);
            // hover-revealed on pointer devices to keep the row clean.
            className="opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </div>
      }
    />
  );
}

function PendingActions({
  applicationId,
  associateName,
}: {
  applicationId: string;
  associateName: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function sendNudge() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await nudgeApplicant(applicationId, {
        subject: 'Reminder: finish your onboarding',
        body:
          `Hi ${associateName.split(' ')[0]},\n\n` +
          'This is a friendly reminder to finish the remaining onboarding ' +
          "steps so we can get you set up. Sign back into your Alto account to pick up where you left off — it should only take a few minutes.\n\n" +
          'Thanks,\nAlto HR',
      });
      setOpen(false);
      toast.success(
        r.emailSent ? `Nudge sent to ${r.recipientEmail}.` : 'Nudge logged.',
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not send.';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Onboarding">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to={`/onboarding/applications/${applicationId}`}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open application
          </Link>
        </Button>
        <Button
          variant="ghost"
          onClick={() => setOpen(true)}
          className="text-xs"
        >
          <Send className="h-3.5 w-3.5 mr-1" />
          Send nudge
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Send onboarding nudge?"
        description={`Emails ${associateName} a reminder to finish their open onboarding tasks.`}
        confirmLabel={busy ? 'Sending…' : 'Send nudge'}
        busy={busy}
        onConfirm={sendNudge}
      />
    </Section>
  );
}

const REASON_LABEL: Record<CompChangeReason, string> = {
  HIRE: 'Hire',
  MERIT: 'Merit',
  PROMOTION: 'Promotion',
  MARKET_ADJUSTMENT: 'Market adjustment',
  CORRECTION: 'Correction',
  OTHER: 'Other',
};

function CompensationTab({ associate: a }: { associate: DirectoryEntry }) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);

  const { data: records, error: recordsError } = useQuery({
    queryKey: ['comp-records', a.id],
    // Newest first — server sorts ASC by effectiveFrom; we flip for display.
    queryFn: async () => [...(await listRecords(a.id)).records].reverse(),
  });
  const error = recordsError
    ? recordsError instanceof ApiError
      ? recordsError.message
      : 'Failed to load.'
    : null;

  const current = records?.find((r) => r.effectiveTo === null) ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
                Current rate
              </div>
              <div className="text-3xl font-semibold tabular-nums text-white mt-1">
                {current
                  ? fmtPay(current.amount, current.payType, current.currency)
                  : fmtPay(a.payAmount, a.payType, a.payCurrency)}
              </div>
              {current && (
                <div className="text-xs2 text-silver mt-1">
                  {REASON_LABEL[current.reason]} · effective{' '}
                  {fmtDate(current.effectiveFrom)}
                </div>
              )}
            </div>
            <Button onClick={() => setEditOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Set new rate
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <div className="flex items-center justify-between mb-2 border-b border-navy-secondary pb-1">
          <div className="text-2xs uppercase tracking-widest text-silver/80">
            History
          </div>
          {records && records.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                downloadCsv(
                  `pay-history-${a.firstName}-${a.lastName}-${ymdLocal()}.csv`.toLowerCase(),
                  [
                    ['Effective from', 'Effective to', 'Amount', 'Pay type', 'Reason', 'Notes'],
                    ...records.map((r) => [
                      fmtDate(r.effectiveFrom),
                      r.effectiveTo ? fmtDate(r.effectiveTo) : '',
                      r.amount,
                      r.payType,
                      REASON_LABEL[r.reason],
                      r.notes ?? '',
                    ]),
                  ],
                )
              }
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          )}
        </div>
        {error && (
          <div className="text-sm text-alert" role="alert">
            {error}
          </div>
        )}
        {!records && !error && <SkeletonRows count={3} rowHeight="h-9" />}
        {records && records.length === 0 && !error && (
          <div className="text-sm text-silver py-4">
            No compensation records yet.
          </div>
        )}
        {records && records.length > 0 && (
          <Table caption="Pay rate history">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Effective</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-silver text-xs tabular-nums whitespace-nowrap">
                    {fmtDate(r.effectiveFrom)}
                    {r.effectiveTo && (
                      <>
                        {' – '}
                        {fmtDate(r.effectiveTo)}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="text-white tabular-nums">
                    {fmtPay(r.amount, r.payType, r.currency)}
                  </TableCell>
                  <TableCell className="text-silver text-xs">
                    {REASON_LABEL[r.reason]}
                    {r.notes && (
                      <span className="block text-2xs text-silver/70 truncate max-w-[180px]">
                        {r.notes}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <NewRateDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        associate={a}
        currentRecord={current}
        onSaved={() => {
          setEditOpen(false);
          void queryClient.invalidateQueries({
            queryKey: ['comp-records', a.id],
          });
        }}
      />
    </div>
  );
}

function TransferDialog({
  open,
  onOpenChange,
  associate: a,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  associate: DirectoryEntry;
  onSaved: (locationId: string, locationName: string) => void;
}) {
  const today = useMemo(() => ymdLocal(), []);
  const [locationId, setLocationId] = useState<string>(a.currentLocationId ?? '');
  const [startedAt, setStartedAt] = useState(today);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const clientId = a.workplaceClientId;

  const { data: locationsData, isLoading: locationsLoading } = useQuery({
    queryKey: ['client-locations', clientId],
    queryFn: () => listClientLocations(clientId!),
    enabled: open && Boolean(clientId),
  });
  const locations: LocationSummary[] = locationsData?.locations ?? [];

  // Reset when the dialog opens for a different associate.
  useEffect(() => {
    if (!open) return;
    setLocationId(a.currentLocationId ?? '');
    setStartedAt(today);
    setReason('');
    setNotes('');
    setSubmitting(false);
  }, [open, a.id, a.currentLocationId, today]);

  const targetLocation = locations.find((l) => l.id === locationId) ?? null;
  const valid =
    locationId.length > 0 &&
    startedAt.length === 10 &&
    locationId !== a.currentLocationId;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting || !targetLocation) return;
    setSubmitting(true);
    try {
      await transferAssociate(a.id, {
        locationId,
        startedAt,
        reason: reason.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success(`Transferred to ${targetLocation.name}.`);
      onSaved(targetLocation.id, targetLocation.name);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not transfer.';
      toast.error(msg);
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {a.currentLocationId ? 'Transfer to location' : 'Assign to location'}
          </DialogTitle>
          <DialogDescription>
            {a.firstName} {a.lastName}
            {a.workplaceClientName ? ` • ${a.workplaceClientName}` : ''}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <Field label="New location">
            {(p) => (
              <Select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                disabled={locationsLoading || locations.length === 0}
                {...p}
              >
                <option value="">
                  {locationsLoading
                    ? 'Loading…'
                    : locations.length === 0
                      ? 'No locations available'
                      : 'Select a location'}
                </option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id} disabled={l.id === a.currentLocationId}>
                    {l.name}
                    {l.id === a.currentLocationId ? ' (current)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Effective date">
            {(p) => (
              <Input
                type="date"
                value={startedAt}
                onChange={(e) => setStartedAt(e.target.value)}
                {...p}
              />
            )}
          </Field>

          <Field label="Reason (optional)">
            {(p) => (
              <Input
                type="text"
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Coverage need, employee request, etc."
                {...p}
              />
            )}
          </Field>

          <Field label="Notes (optional)">
            {(p) => (
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Context for the change (visible in history)"
                {...p}
              />
            )}
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || submitting}>
              {submitting ? 'Saving…' : 'Confirm transfer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Pay-setup section + audited reveal dialog. The masked summary is
// visible to anyone with process:payroll. The reveal flow asks for a
// reason, writes an AuditLog row, returns the full account/routing
// once, and auto-masks again after REVEAL_AUTO_HIDE_SECONDS so the
// numbers don't sit on a left-open browser tab.
const REVEAL_AUTO_HIDE_SECONDS = 30;

function PayoutMethodSection({ associateId }: { associateId: string }) {
  const { user } = useAuth();
  // process:payroll is the gate the backend enforces; HR_ADMINISTRATOR
  // + FINANCE_ACCOUNTANT + FULL_ADMIN roles all carry it. Hide the
  // section entirely for roles without it (e.g. plain ASSOCIATE,
  // EXECUTIVE_CHAIRMAN) so the side panel doesn't render an empty
  // "Pay setup" header to people who can't see anything in it.
  const canSee = user ? hasCapability(user.role, 'process:payroll') : false;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['associate-payout-method', associateId],
    queryFn: () => getAssociatePayoutMethod(associateId),
    enabled: canSee,
    staleTime: 30_000,
  });

  const [revealOpen, setRevealOpen] = useState(false);

  if (!canSee) return null;

  return (
    <>
      <Section title="Pay setup">
        {isLoading ? (
          <Skeleton className="h-4 w-48" />
        ) : !data || !data.hasPayoutMethod ? (
          <InfoRow
            icon={<Landmark className="h-3.5 w-3.5" />}
            label="Direct deposit"
            value={<span className="text-silver">Not on file</span>}
          />
        ) : data.type === 'BRANCH_CARD' ? (
          <>
            <InfoRow
              icon={<Landmark className="h-3.5 w-3.5" />}
              label="Method"
              value="Branch card"
            />
            <InfoRow
              label="Card ID"
              value={
                <span className="font-mono text-xs">
                  {data.branchCardId ?? '—'}
                </span>
              }
            />
          </>
        ) : (
          <>
            <InfoRow
              icon={<Landmark className="h-3.5 w-3.5" />}
              label="Method"
              value={`Direct deposit${
                data.accountType ? ` (${data.accountType.toLowerCase()})` : ''
              }`}
            />
            <BankNameRow
              associateId={associateId}
              bankName={data.bankName ?? null}
              onSaved={() => void refetch()}
            />
            <InfoRow
              label="Routing"
              value={
                <span className="font-mono text-xs">
                  {data.routingMasked ?? '—'}
                </span>
              }
            />
            <InfoRow
              label="Account"
              value={
                <span className="font-mono text-xs">
                  {data.accountLast4 ? `••••${data.accountLast4}` : '—'}
                </span>
              }
            />
            {data.verifiedAt && (
              <InfoRow
                label="Verified"
                value={fmtDate(data.verifiedAt)}
              />
            )}
            <div className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRevealOpen(true)}
              >
                <Eye className="mr-2 h-3.5 w-3.5" />
                Reveal full bank info
              </Button>
            </div>
          </>
        )}
      </Section>

      {revealOpen && (
        <RevealPayoutDialog
          associateId={associateId}
          onClose={() => {
            setRevealOpen(false);
            // Re-fetch the masked summary in case the verifiedAt/updatedAt
            // moved (it didn't on a reveal, but cheap insurance).
            void refetch();
          }}
        />
      )}
    </>
  );
}

/**
 * Bank name, inline-editable.
 *
 * The field was added after most associates onboarded, so existing records
 * carry a blank that an external payroll provider's intake file expects.
 * Without an admin path the only fix is asking each associate to re-save
 * their direct deposit, so this edits the label in place.
 *
 * Only the label — routing and account numbers stay read-only here and
 * writable only by the associate, whose self-service change fires a
 * confirmation email as a fraud tripwire. An admin control that could
 * rewrite where money lands is a payment-redirection vector, and nothing
 * about naming a bank needs one.
 */
function BankNameRow({
  associateId,
  bankName,
  onSaved,
}: {
  associateId: string;
  bankName: string | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(bankName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the query refetches under us (e.g. after a save elsewhere).
  useEffect(() => {
    if (!editing) setValue(bankName ?? '');
  }, [bankName, editing]);

  const save = async () => {
    const next = value.trim();
    if (!next) {
      setError('Enter a bank name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setAssociateBankName(associateId, next);
      setEditing(false);
      onSaved();
      toast.success('Bank name updated.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <InfoRow
        label="Bank"
        value={
          <span className="inline-flex items-center gap-2">
            {bankName ? (
              <span>{bankName}</span>
            ) : (
              // Called out rather than shown as a neutral dash: a blank here
              // is a cell the payroll provider expects filled.
              <span className="text-warning">Not set</span>
            )}
            <Button
              variant="link"
              onClick={() => setEditing(true)}
              className="text-2xs font-normal uppercase tracking-wider text-silver/70 underline underline-offset-2 hover:text-gold"
            >
              {bankName ? 'Edit' : 'Add'}
            </Button>
          </span>
        }
      />
    );
  }

  return (
    <div className="py-1">
      <div className="text-2xs uppercase tracking-widest text-silver/80 mb-1">
        Bank
      </div>
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={value}
          maxLength={120}
          placeholder="Chase"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') {
              setEditing(false);
              setValue(bankName ?? '');
              setError(null);
            }
          }}
          className="h-8 text-sm"
        />
        <Button size="sm" onClick={() => void save()} loading={saving} disabled={saving}>
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => {
            setEditing(false);
            setValue(bankName ?? '');
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
      {error && <div className="mt-1 text-xs text-alert">{error}</div>}
    </div>
  );
}

function RevealPayoutDialog({
  associateId,
  onClose,
}: {
  associateId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState<PayoutMethodReveal | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_AUTO_HIDE_SECONDS);
  const [err, setErr] = useState<string | null>(null);

  // Countdown to auto-mask. Once the timer expires the numbers vanish
  // and the admin is shown a "view expired" state; another reveal
  // requires a fresh reason.
  useEffect(() => {
    if (!revealed) return;
    setSecondsLeft(REVEAL_AUTO_HIDE_SECONDS);
    const start = Date.now();
    const tick = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const remaining = REVEAL_AUTO_HIDE_SECONDS - elapsed;
      if (remaining <= 0) {
        setRevealed(null);
        window.clearInterval(tick);
      } else {
        setSecondsLeft(remaining);
      }
    }, 1000);
    return () => window.clearInterval(tick);
  }, [revealed]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 8) {
      setErr('Reason must be at least 8 characters.');
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const r = await revealAssociatePayoutMethod(associateId, reason.trim());
      setRevealed(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reveal failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reveal full bank info</DialogTitle>
          <DialogDescription>
            This view is logged. Every reveal lands in the audit log with
            your name, the reason you provide, and your IP — so we have
            a paper trail when investigating payment issues.
          </DialogDescription>
        </DialogHeader>

        {!revealed ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="flex gap-2 items-start rounded-md border border-warning/40 bg-warning/10 p-3 text-warning text-xs">
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
              <div>
                Full routing and account numbers are sensitive. Reveal them
                only for a legitimate audit need (e.g. an ACH return).
              </div>
            </div>
            <div>
              <Label>Reason</Label>
              <Textarea
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (err) setErr(null);
                }}
                rows={3}
                maxLength={500}
                className="mt-1"
                placeholder="e.g. ACH return R03 on payroll run 2026-05-10 — verify routing matches associate's bank record"
                autoFocus
              />
              <div className="text-xs text-silver mt-1">
                {reason.length}/500 — minimum 8 characters.
              </div>
            </div>
            {err && <div className="text-sm text-alert">{err}</div>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting || reason.trim().length < 8}
              >
                {submitting ? 'Revealing…' : 'Reveal'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs uppercase tracking-widest text-silver">
              <span className="flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" /> Revealed
              </span>
              <span>Auto-hides in {secondsLeft}s</span>
            </div>
            <div className="rounded-md border border-navy-secondary bg-navy-secondary/40 p-4 space-y-3">
              {revealed.type === 'BRANCH_CARD' ? (
                <div>
                  <div className="text-xs text-silver uppercase tracking-widest mb-1">
                    Branch card ID
                  </div>
                  <div className="font-mono text-xl text-white tracking-wider">
                    {revealed.branchCardId ?? '—'}
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <div className="text-xs text-silver uppercase tracking-widest mb-1">
                      Routing number
                    </div>
                    <div className="font-mono text-xl text-white tracking-wider">
                      {revealed.routingNumber ?? '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-silver uppercase tracking-widest mb-1">
                      Account number
                      {revealed.accountType && (
                        <span className="ml-2 text-silver normal-case tracking-normal">
                          ({revealed.accountType.toLowerCase()})
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-xl text-white tracking-wider break-all">
                      {revealed.accountNumber ?? '—'}
                    </div>
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRevealed(null)}>
                <EyeOff className="mr-2 h-3.5 w-3.5" /> Hide now
              </Button>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// SSN section + audited reveal — same posture as the bank-info reveal
// above: masked last-4 for the process:payroll audience, full number
// behind a written reason + AuditLog row, auto-mask after 30s. This is
// the in-system answer to "the packet redacts the SSN": the packet stays
// redacted, this is the deliberate, logged path.
// DOB and home address, fetched per-associate so PII never rides along on
// the whole-roster directory response. Read-only on purpose: the associate
// owns these via self-service (Me → My profile) or the onboarding profile
// task, so HR edits can't silently diverge from what the person attested.
function PersonalInfoSection({ associate: a }: { associate: DirectoryEntry }) {
  const { user } = useAuth();
  const canSee = user ? hasCapability(user.role, 'process:payroll') : false;

  const { data, isLoading } = useQuery({
    queryKey: ['associate-personal-info', a.id],
    queryFn: () => getAssociatePersonalInfo(a.id),
    enabled: canSee,
    staleTime: 30_000,
  });

  if (!canSee) return null;

  const cityLine = data
    ? [data.city, [data.state, data.zip].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ')
    : '';
  const hasAddress = Boolean(data?.addressLine1 || cityLine);

  return (
    <Section title="Personal information">
      {isLoading || !data ? (
        <Skeleton className="h-4 w-48" />
      ) : (
        <>
          <InfoRow
            label="Legal name"
            value={[a.firstName, data.middleInitial && `${data.middleInitial}.`, a.lastName]
              .filter(Boolean)
              .join(' ')}
          />
          {data.otherLastNames.length > 0 && (
            <InfoRow
              label="Other last names"
              value={data.otherLastNames.join(', ')}
            />
          )}
          <InfoRow
            icon={<Mail className="h-3.5 w-3.5" />}
            label="Email"
            value={
              <a
                href={`mailto:${a.email}`}
                className="text-gold hover:text-gold-bright"
              >
                {a.email}
              </a>
            }
          />
          <InfoRow
            label="Date of birth"
            value={
              data.dob ? (
                fmtDate(parseYmd(data.dob) ?? data.dob)
              ) : (
                <span className="text-silver">
                  Not on file — collected during onboarding
                </span>
              )
            }
          />
          <InfoRow
            icon={<MapPin className="h-3.5 w-3.5" />}
            label="Home address"
            value={
              hasAddress ? (
                <span>
                  {data.addressLine1}
                  {data.addressLine2 && (
                    <>
                      <br />
                      {data.addressLine2}
                    </>
                  )}
                  {cityLine && (
                    <>
                      <br />
                      {cityLine}
                    </>
                  )}
                </span>
              ) : (
                <span className="text-silver">
                  Not on file — collected during onboarding
                </span>
              )
            }
          />
        </>
      )}
    </Section>
  );
}

function SsnSection({ associateId }: { associateId: string }) {
  const { user } = useAuth();
  const canSee = user ? hasCapability(user.role, 'process:payroll') : false;

  const { data, isLoading } = useQuery({
    queryKey: ['associate-ssn', associateId],
    queryFn: () => getAssociateSsn(associateId),
    enabled: canSee,
    staleTime: 30_000,
  });

  const [revealOpen, setRevealOpen] = useState(false);

  if (!canSee) return null;

  return (
    <>
      <Section title="Tax identity">
        {isLoading ? (
          <Skeleton className="h-4 w-48" />
        ) : !data || !data.hasSsn ? (
          <InfoRow
            label={data?.source === 'TIN' ? 'TIN' : 'SSN'}
            value={
              <span className="text-silver">
                Not on file — collected on the W-4 during onboarding
              </span>
            }
          />
        ) : (
          <>
            <InfoRow
              label={data.source === 'TIN' ? 'TIN' : 'SSN'}
              value={
                <span className="font-mono text-xs">
                  {data.ssnLast4 ? `•••-••-${data.ssnLast4}` : '•••-••-••••'}
                </span>
              }
            />
            <div className="pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRevealOpen(true)}
              >
                <Eye className="mr-2 h-3.5 w-3.5" />
                Reveal full {data.source === 'TIN' ? 'TIN' : 'SSN'}
              </Button>
            </div>
          </>
        )}
      </Section>

      {revealOpen && (
        <RevealSsnDialog
          associateId={associateId}
          onClose={() => setRevealOpen(false)}
        />
      )}
    </>
  );
}

// HR-facing W-4 elections — view the withholding a W-2 employee elected at
// onboarding and edit it on their behalf (a called-in change, a
// correction). Never the SSN. Gated on process:payroll; edits are audited
// server-side and take effect on the next run.
const W4_FILING_LABEL: Record<string, string> = {
  SINGLE: 'Single / married filing separately',
  MARRIED_FILING_JOINTLY: 'Married filing jointly',
  HEAD_OF_HOUSEHOLD: 'Head of household',
};

function W4Section({ associateId }: { associateId: string }) {
  const { user } = useAuth();
  const canSee = user ? hasCapability(user.role, 'process:payroll') : false;
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{
    filingStatus: NonNullable<AssociateW4['filingStatus']>;
    multipleJobs: boolean;
    dependentsAmount: number;
    otherIncome: number;
    deductions: number;
    extraWithholding: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['associate-w4', associateId],
    queryFn: () => getAssociateW4(associateId),
    enabled: canSee,
    staleTime: 30_000,
  });

  if (!canSee) return null;
  if (data && data.employmentType !== 'W2_EMPLOYEE') return null; // 1099 → no W-4

  const startEdit = () => {
    if (!data) return;
    setForm({
      filingStatus: data.filingStatus ?? 'SINGLE',
      multipleJobs: data.multipleJobs,
      dependentsAmount: data.dependentsAmount ?? 0,
      otherIncome: data.otherIncome ?? 0,
      deductions: data.deductions ?? 0,
      extraWithholding: data.extraWithholding ?? 0,
    });
    setEditing(true);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await updateAssociateW4(associateId, form);
      toast.success('W-4 updated — applies from the next payroll run.');
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['associate-w4', associateId] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update W-4.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Federal W-4">
      {isLoading ? (
        <Skeleton className="h-4 w-48" />
      ) : !data || !data.hasSubmission ? (
        <InfoRow
          label="W-4"
          value={<span className="text-silver">Not on file — collected during onboarding</span>}
        />
      ) : editing && form ? (
        <div className="space-y-2">
          <Select
            value={form.filingStatus}
            onChange={(e) =>
              setForm({ ...form, filingStatus: e.target.value as typeof form.filingStatus })
            }
          >
            {Object.entries(W4_FILING_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          {(
            [
              ['dependentsAmount', 'Dependents credit (step 3)'],
              ['otherIncome', 'Other income (4a)'],
              ['deductions', 'Deductions (4b)'],
              ['extraWithholding', 'Extra withholding / check (4c)'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block text-xs text-silver">
              {label}
              <Input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className="mt-1"
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) || 0 })}
              />
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs text-silver">
            <input
              type="checkbox"
              checked={form.multipleJobs}
              onChange={(e) => setForm({ ...form, multipleJobs: e.target.checked })}
            />
            Multiple jobs / spouse works (step 2)
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} loading={saving} disabled={saving}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <InfoRow
            label="Filing status"
            value={data.filingStatus ? W4_FILING_LABEL[data.filingStatus] : '—'}
          />
          <InfoRow label="Dependents credit" value={fmtMoney(data.dependentsAmount)} />
          <InfoRow label="Other income" value={fmtMoney(data.otherIncome)} />
          <InfoRow label="Deductions" value={fmtMoney(data.deductions)} />
          <InfoRow label="Extra withholding / check" value={fmtMoney(data.extraWithholding)} />
          {data.signedAt && (
            <InfoRow
              label="Last signed"
              value={<span className="text-silver">{fmtDate(data.signedAt)}</span>}
            />
          )}
          <div className="pt-2">
            <Button variant="ghost" size="sm" onClick={startEdit}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Edit W-4
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

function RevealSsnDialog({
  associateId,
  onClose,
}: {
  associateId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState<SsnReveal | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_AUTO_HIDE_SECONDS);
  const [err, setErr] = useState<string | null>(null);

  // Auto-mask, same as the bank reveal — an SSN must not sit on a
  // left-open browser tab.
  useEffect(() => {
    if (!revealed) return;
    setSecondsLeft(REVEAL_AUTO_HIDE_SECONDS);
    const start = Date.now();
    const tick = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const remaining = REVEAL_AUTO_HIDE_SECONDS - elapsed;
      if (remaining <= 0) {
        setRevealed(null);
        window.clearInterval(tick);
      } else {
        setSecondsLeft(remaining);
      }
    }, 1000);
    return () => window.clearInterval(tick);
  }, [revealed]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 8) {
      setErr('Reason must be at least 8 characters.');
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const r = await revealAssociateSsn(associateId, reason.trim());
      setRevealed(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reveal failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reveal full SSN</DialogTitle>
          <DialogDescription>
            This view is logged. Every reveal lands in the audit log with
            your name, the reason you provide, and your IP.
          </DialogDescription>
        </DialogHeader>

        {!revealed ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="flex gap-2 items-start rounded-md border border-warning/40 bg-warning/10 p-3 text-warning text-xs">
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
              <div>
                A Social Security number is the most sensitive field in the
                system. Reveal it only for a legitimate need — an
                I-9/E-Verify correction, a state filing, or a background-check
                dispute — and never write it down outside the system.
              </div>
            </div>
            <div>
              <Label>Reason</Label>
              <Textarea
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (err) setErr(null);
                }}
                rows={3}
                maxLength={500}
                className="mt-1"
                placeholder="e.g. E-Verify tentative nonconfirmation — verifying the SSN entered on the I-9 matches the W-4"
                autoFocus
              />
              <div className="text-xs text-silver mt-1">
                {reason.length}/500 — minimum 8 characters.
              </div>
            </div>
            {err && <div className="text-sm text-alert">{err}</div>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting || reason.trim().length < 8}
              >
                {submitting ? 'Revealing…' : 'Reveal'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs uppercase tracking-widest text-silver">
              <span className="flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" /> Revealed
              </span>
              <span>Auto-hides in {secondsLeft}s</span>
            </div>
            <div className="rounded-md border border-navy-secondary bg-navy-secondary/40 p-4">
              <div className="text-xs text-silver uppercase tracking-widest mb-1">
                {revealed.kind === 'EIN' ? 'EIN' : 'Social Security number'}
                <span className="ml-2 text-silver normal-case tracking-normal">
                  (from {revealed.source === 'W4' ? 'the W-4' : 'the TIN on file'})
                </span>
              </div>
              <div className="font-mono text-2xl text-white tracking-[0.2em]">
                {revealed.number}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRevealed(null)}>
                <EyeOff className="mr-2 h-3.5 w-3.5" /> Hide now
              </Button>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewRateDialog({
  open,
  onOpenChange,
  associate: a,
  currentRecord,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  associate: DirectoryEntry;
  currentRecord: CompRecord | null;
  onSaved: () => void;
}) {
  const today = useMemo(() => ymdLocal(), []);
  const initialPayType: PayType =
    (currentRecord?.payType as PayType | undefined) ??
    (a.payType === 'SALARY' ? 'SALARY' : 'HOURLY');

  const [payType, setPayType] = useState<PayType>(initialPayType);
  const [amount, setAmount] = useState<string>(
    currentRecord?.amount ?? a.payAmount ?? '',
  );
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [reason, setReason] = useState<CompChangeReason>('MERIT');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset whenever dialog opens for a different associate or current rate
  // changes — prevents stale form values bleeding across rows.
  useEffect(() => {
    if (!open) return;
    setPayType(initialPayType);
    setAmount(currentRecord?.amount ?? a.payAmount ?? '');
    setEffectiveFrom(today);
    setReason('MERIT');
    setNotes('');
    setSubmitting(false);
  }, [open, a.id, currentRecord?.id, initialPayType, today, currentRecord, a.payAmount]);

  const amountNum = Number(amount);
  const valid =
    Number.isFinite(amountNum) && amountNum > 0 && effectiveFrom.length === 10;

  // Live "was → will be" math against the current open record so the
  // admin sees the delta before committing.
  const currentAmountNum = currentRecord ? Number(currentRecord.amount) : NaN;
  const deltaPct =
    Number.isFinite(currentAmountNum) &&
    currentAmountNum > 0 &&
    Number.isFinite(amountNum) &&
    amountNum > 0
      ? ((amountNum - currentAmountNum) / currentAmountNum) * 100
      : null;
  // Effective-from can't sensibly predate the current record's start —
  // back-dating past it rewrites already-closed history.
  const minEffectiveFrom = currentRecord
    ? currentRecord.effectiveFrom.slice(0, 10)
    : undefined;
  const backdated = Boolean(
    minEffectiveFrom &&
      effectiveFrom.length === 10 &&
      effectiveFrom < minEffectiveFrom,
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await createRecord(a.id, {
        payType,
        amount: amountNum,
        reason,
        notes: notes.trim() || undefined,
        effectiveFrom,
      });
      toast.success('Rate updated.');
      onSaved();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save.';
      toast.error(msg);
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set new rate</DialogTitle>
          <DialogDescription>
            {a.firstName} {a.lastName}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Pay type</Label>
              <div className="mt-1 flex gap-2">
                <PayTypeOption
                  active={payType === 'HOURLY'}
                  onClick={() => setPayType('HOURLY')}
                  label="Hourly"
                />
                <PayTypeOption
                  active={payType === 'SALARY'}
                  onClick={() => setPayType('SALARY')}
                  label="Salary"
                />
              </div>
            </div>
            <Field
              label={`Amount${payType === 'HOURLY' ? ' / hour' : ' / year'}`}
            >
              {(p) => (
                <div>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder={payType === 'HOURLY' ? '24.50' : '65000'}
                    {...p}
                  />
                  {currentRecord && deltaPct !== null && (
                    <p className="mt-1 text-xs2 text-silver tabular-nums">
                      was{' '}
                      {fmtPayRate(currentRecord.amount, currentRecord.payType)}{' '}
                      → {fmtPayRate(amountNum, payType)} (
                      {deltaPct >= 0 ? '+' : ''}
                      {deltaPct.toFixed(1)}%)
                    </p>
                  )}
                </div>
              )}
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Effective from">
              {(p) => (
                <div>
                  <Input
                    type="date"
                    value={effectiveFrom}
                    min={minEffectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                    {...p}
                  />
                  {backdated && (
                    <p className="mt-1 text-xs2 text-warning" role="alert">
                      Before the current rate&apos;s start (
                      {fmtDate(parseYmd(minEffectiveFrom!) ?? minEffectiveFrom)}
                      ) — this back-dates pay history.
                    </p>
                  )}
                </div>
              )}
            </Field>
            <Field label="Reason">
              {(p) => (
                <Select
                  value={reason}
                  onChange={(e) =>
                    setReason(e.target.value as CompChangeReason)
                  }
                  {...p}
                >
                  <option value="HIRE">Hire</option>
                  <option value="MERIT">Merit</option>
                  <option value="PROMOTION">Promotion</option>
                  <option value="MARKET_ADJUSTMENT">Market adjustment</option>
                  <option value="CORRECTION">Correction</option>
                  <option value="OTHER">Other</option>
                </Select>
              )}
            </Field>
          </div>

          <Field label="Notes (optional)">
            {(p) => (
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="Context for the change (visible in history)"
                {...p}
              />
            )}
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PayTypeOption({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 h-10 rounded-md border text-sm transition-colors',
        active
          ? 'border-gold bg-gold/10 text-white'
          : 'border-navy-secondary bg-navy-secondary/40 text-silver hover:text-white',
      )}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

/* ----- Payments tab -------------------------------------------------------
 * Audit documentation for externally-run payroll: one card per pay period,
 * each carrying evidence uploads (paystub, cleared check, processor report)
 * that land in the document vault as PAYSTUB records under Tax & payroll.
 * Deliberately manual — these document payments Alto never computed.
 * ---------------------------------------------------------------------- */

const PAYMENT_METHOD_LABEL: Record<ExternalPaymentMethod, string> = {
  DIRECT_DEPOSIT: 'Direct deposit',
  CHECK: 'Check',
  CASH: 'Cash',
  PAYROLL_PROVIDER: 'Payroll provider',
  OTHER: 'Other',
};

function PaymentsTab({ associateId }: { associateId: string }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['external-payments', associateId],
    queryFn: () => listExternalPayments(associateId),
    staleTime: 15_000,
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ExternalPayment | null>(null);

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ['external-payments', associateId] });

  const payments = data?.payments ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-silver">
          Pay periods processed by the external payroll provider, with
          uploaded evidence for audit. Files also appear in the Documents tab
          under Tax &amp; payroll.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Record payment
        </Button>
      </div>

      {error instanceof Error && <ErrorBanner>{error.message}</ErrorBanner>}

      {isLoading ? (
        <SkeletonRows count={3} />
      ) : payments.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No payments recorded"
          description="Record the associate's first externally-processed pay period and attach the paystub or proof of payment."
        />
      ) : (
        <ul className="space-y-3">
          {payments.map((p) => (
            <PaymentCard
              key={p.id}
              payment={p}
              onEdit={() => {
                setEditing(p);
                setEditorOpen(true);
              }}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}

      <PaymentEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        associateId={associateId}
        payment={editing}
        lastPayment={payments[0] ?? null}
        onSaved={() => {
          setEditorOpen(false);
          void refresh();
        }}
      />
    </div>
  );
}

function PaymentCard({
  payment: p,
  onEdit,
  onChanged,
}: {
  payment: ExternalPayment;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const remove = async () => {
    setBusy(true);
    try {
      await deleteExternalPayment(p.id);
      toast.success('Payment record deleted. Evidence files stay in the vault.');
      setConfirmDelete(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const uploadEvidence = async (file: File) => {
    setUploading(true);
    try {
      await uploadPaymentEvidence(p.id, file);
      toast.success(`Uploaded ${file.name}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const period = `${fmtDate(parseYmd(p.periodStart) ?? p.periodStart)} – ${fmtDate(parseYmd(p.periodEnd) ?? p.periodEnd)}`;

  return (
    <li className="rounded-lg border border-navy-secondary bg-navy p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-white">{period}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-silver">
            {p.payDate && (
              <span>Paid {fmtDate(parseYmd(p.payDate) ?? p.payDate)}</span>
            )}
            <Badge variant="default" className="text-2xs">
              {PAYMENT_METHOD_LABEL[p.method]}
            </Badge>
            {p.reference && <span>Ref {p.reference}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            title="Edit"
            aria-label="Edit payment"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            title="Delete"
            aria-label="Delete payment"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {(p.grossAmount !== null || p.netAmount !== null) && (
        <div className="flex gap-6 text-sm tabular-nums">
          {p.grossAmount !== null && (
            <span>
              <span className="text-silver">Gross </span>
              <span className="text-white">{fmtMoney(p.grossAmount)}</span>
            </span>
          )}
          {p.netAmount !== null && (
            <span>
              <span className="text-silver">Net </span>
              <span className="text-white">{fmtMoney(p.netAmount)}</span>
            </span>
          )}
        </div>
      )}

      {p.note && <p className="text-xs text-silver">{p.note}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-navy-secondary pt-3">
        {p.evidence.map((d) =>
          d.fileAvailable ? (
            <a
              key={d.id}
              href={downloadDocumentUrl(d.id)}
              className="inline-flex items-center gap-1.5 rounded border border-navy-secondary bg-navy-secondary/40 px-2 py-1 text-xs text-gold hover:text-gold-bright"
            >
              <Download className="h-3 w-3" />
              <span className="max-w-[180px] truncate">{d.filename}</span>
            </a>
          ) : (
            <span
              key={d.id}
              className="inline-flex items-center gap-1.5 rounded border border-navy-secondary px-2 py-1 text-xs text-silver"
              title="File missing on server — re-upload required"
            >
              <ShieldAlert className="h-3 w-3" />
              <span className="max-w-[180px] truncate">{d.filename}</span>
            </span>
          ),
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadEvidence(f);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="text-xs"
        >
          <Upload className="mr-1.5 h-3 w-3" />
          {uploading ? 'Uploading…' : p.evidence.length === 0 ? 'Upload paystub' : 'Add evidence'}
        </Button>
        {p.evidence.length === 0 && !uploading && (
          <span className="text-2xs text-warning">No evidence attached</span>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this payment record?"
        description={`Removes the ${period} pay period from this list. Uploaded evidence files are kept in the associate's document vault.`}
        confirmLabel={busy ? 'Deleting…' : 'Delete'}
        busy={busy}
        onConfirm={remove}
      />
    </li>
  );
}

/** Calendar-date arithmetic on YYYY-MM-DD strings, at local midnight —
 *  never through Date parsing of the raw string (that's UTC and shifts a
 *  day west of Greenwich). */
function addDaysYmd(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  d.setDate(d.getDate() + days);
  return ymdLocal(d);
}

function daysBetweenYmd(a: string, b: string): number {
  const da = parseYmd(a);
  const db = parseYmd(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

function PaymentEditorDialog({
  open,
  onOpenChange,
  associateId,
  payment,
  lastPayment,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  associateId: string;
  payment: ExternalPayment | null;
  /** Most recent recorded period — seeds the next one so a routine entry
   *  is "glance, attach, save" instead of typing five fields. */
  lastPayment: ExternalPayment | null;
  onSaved: () => void;
}) {
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [payDate, setPayDate] = useState('');
  const [gross, setGross] = useState('');
  const [net, setNet] = useState('');
  const [method, setMethod] = useState<ExternalPaymentMethod>('PAYROLL_PROVIDER');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Re-seed whenever the dialog opens. Editing seeds from the record; a new
  // entry continues from the last period — same cadence (period length),
  // same pay-date offset, same method and amounts, since external payroll
  // is overwhelmingly rhythmic. Everything stays editable.
  useEffect(() => {
    if (!open) return;
    if (payment) {
      setPeriodStart(payment.periodStart);
      setPeriodEnd(payment.periodEnd);
      setPayDate(payment.payDate ?? '');
      setGross(payment.grossAmount != null ? String(payment.grossAmount) : '');
      setNet(payment.netAmount != null ? String(payment.netAmount) : '');
      setMethod(payment.method);
      setReference(payment.reference ?? '');
      setNote(payment.note ?? '');
    } else if (lastPayment) {
      const length = daysBetweenYmd(lastPayment.periodStart, lastPayment.periodEnd);
      const start = addDaysYmd(lastPayment.periodEnd, 1);
      const end = addDaysYmd(start, length);
      setPeriodStart(start);
      setPeriodEnd(end);
      setPayDate(
        lastPayment.payDate
          ? addDaysYmd(end, daysBetweenYmd(lastPayment.periodEnd, lastPayment.payDate))
          : '',
      );
      setGross(lastPayment.grossAmount != null ? String(lastPayment.grossAmount) : '');
      setNet(lastPayment.netAmount != null ? String(lastPayment.netAmount) : '');
      setMethod(lastPayment.method);
      setReference('');
      setNote('');
    } else {
      setPeriodStart('');
      setPeriodEnd('');
      setPayDate('');
      setGross('');
      setNet('');
      setMethod('PAYROLL_PROVIDER');
      setReference('');
      setNote('');
    }
    setFiles([]);
    setError(null);
  }, [open, payment, lastPayment]);

  const parseAmount = (raw: string): number | null | undefined => {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined; // undefined = invalid
  };

  // Picking a start fills the end (and pay date) from the pay cadence:
  // the associate's own last period length when there's history, else
  // biweekly (14 days) — the org's standard cycle. New records only; when
  // EDITING, a start correction must never silently move the end the
  // auditor already saw. End and pay date stay directly editable.
  const cadenceDays = lastPayment
    ? Math.max(1, daysBetweenYmd(lastPayment.periodStart, lastPayment.periodEnd))
    : 13;
  const payDateOffset = lastPayment?.payDate
    ? daysBetweenYmd(lastPayment.periodEnd, lastPayment.payDate)
    : null;
  const handleStartChange = (v: string) => {
    setPeriodStart(v);
    if (!payment && v) {
      const end = addDaysYmd(v, cadenceDays);
      setPeriodEnd(end);
      if (payDateOffset !== null) setPayDate(addDaysYmd(end, payDateOffset));
    }
  };

  const submit = async () => {
    setError(null);
    if (!periodStart || !periodEnd) {
      setError('Period start and end are required.');
      return;
    }
    if (periodEnd < periodStart) {
      setError('Period end must be on or after period start.');
      return;
    }
    const grossAmount = parseAmount(gross);
    const netAmount = parseAmount(net);
    if (grossAmount === undefined || netAmount === undefined) {
      setError('Amounts must be non-negative numbers.');
      return;
    }
    // Calendar dates go over the wire exactly as the inputs yield them
    // (YYYY-MM-DD) — never wrapped in Date/toISOString.
    const input: ExternalPaymentInput = {
      periodStart,
      periodEnd,
      payDate: payDate || null,
      grossAmount,
      netAmount,
      method,
      reference: reference.trim() || null,
      note: note.trim() || null,
    };
    setBusy(true);
    try {
      const saved = payment
        ? await updateExternalPayment(payment.id, input)
        : await createExternalPayment(associateId, input);
      // Evidence rides the same save: the record lands first, then the
      // files. A failed upload doesn't orphan anything — the period exists
      // and the card offers a retry.
      let uploaded = 0;
      try {
        for (const f of files) {
          await uploadPaymentEvidence(saved.id, f);
          uploaded += 1;
        }
      } catch (err) {
        toast.error(
          `${payment ? 'Saved' : 'Recorded'}, but ${files[uploaded].name} failed to upload — retry from the card. ${err instanceof Error ? err.message : ''}`,
        );
        onSaved();
        return;
      }
      if (uploaded > 0) {
        toast.success(
          `Payment ${payment ? 'updated' : 'recorded'} with ${uploaded} evidence ${uploaded === 1 ? 'file' : 'files'}.`,
        );
      } else if (payment) {
        toast.success('Payment updated.');
      } else {
        toast.success('Payment recorded — remember to attach the paystub.');
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {payment ? 'Edit payment' : 'Record external payment'}
          </DialogTitle>
          <DialogDescription>
            Document a pay period processed outside Alto and attach the
            paystub or proof of payment — one save does both.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Period start">
              <Input
                type="date"
                value={periodStart}
                onChange={(e) => handleStartChange(e.target.value)}
              />
            </Field>
            <Field
              label="Period end"
              hint={payment ? undefined : 'Fills automatically from the start date'}
            >
              <Input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </Field>
            <Field label="Pay date" hint="When funds were disbursed">
              <Input
                type="date"
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
              />
            </Field>
            <Field label="Method">
              <Select
                value={method}
                onChange={(e) => setMethod(e.target.value as ExternalPaymentMethod)}
              >
                {(Object.keys(PAYMENT_METHOD_LABEL) as ExternalPaymentMethod[]).map(
                  (m) => (
                    <option key={m} value={m}>
                      {PAYMENT_METHOD_LABEL[m]}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Gross amount">
              <Input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={gross}
                onChange={(e) => setGross(e.target.value)}
              />
            </Field>
            <Field label="Net amount">
              <Input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={net}
                onChange={(e) => setNet(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Reference" hint="Check number, ACH trace, or provider document ID">
            <Input
              value={reference}
              maxLength={120}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          <Field label="Note">
            <Textarea
              value={note}
              maxLength={500}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>

          <Field
            label="Paystub / evidence"
            hint="PDF or photo — lands in the document vault under Tax & payroll"
          >
            <div className="flex flex-wrap items-center gap-2">
              {files.map((f, i) => (
                <span
                  key={`${f.name}-${i}`}
                  className="inline-flex items-center gap-1.5 rounded border border-navy-secondary bg-navy-secondary/40 px-2 py-1 text-xs text-white"
                >
                  <span className="max-w-[180px] truncate">{f.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    className="text-silver hover:text-white"
                    onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.webp"
                className="hidden"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  if (picked.length) setFiles((cur) => [...cur, ...picked]);
                  if (fileRef.current) fileRef.current.value = '';
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="mr-1.5 h-3 w-3" />
                {files.length === 0 ? 'Attach paystub' : 'Add another'}
              </Button>
            </div>
          </Field>

          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={busy}>
            {busy ? 'Saving…' : payment ? 'Save changes' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// HR-curated result kinds available in the upload dialog. Associate-uploaded
// kinds (ID, SSN_CARD, etc.) are intentionally excluded — those come from
// the onboarding flow, not from HR.
const HR_UPLOAD_KINDS: ReadonlyArray<DocumentKind> = [
  'BACKGROUND_CHECK_RESULT',
  'DRUG_TEST_RESULT',
  'I9_VERIFICATION_RESULT',
  'OFFER_LETTER',
  'POLICY',
  'OTHER',
];

/* ----- Document vault ----------------------------------------------------
 * The Documents tab is the associate's whole file: every DocumentRecord in
 * the system is keyed here whichever screen uploaded it, grouped by the
 * compliance domain it belongs to, with each domain's ledger status beside
 * its evidence. The four core screening domains always render (their
 * status is the point, even with zero files); the rest appear when they
 * have documents.
 * ---------------------------------------------------------------------- */

type BadgeTone = 'default' | 'pending' | 'success' | 'destructive' | 'accent';

const VAULT_CATEGORIES: ReadonlyArray<{
  key: string;
  title: string;
  /** One-line purpose under the title, so a section identifies itself. */
  blurb: string;
  icon: LucideIcon;
  kinds: readonly string[];
  /** ?tab= value on /compliance — the owning directorate. */
  complianceTab?: string;
  alwaysVisible?: boolean;
}> = [
  {
    key: 'identity',
    title: 'Identity & I-9',
    blurb: 'IDs, SSN card, and Section 2 supporting documents',
    icon: Fingerprint,
    kinds: ['ID', 'SSN_CARD', 'I9_SUPPORTING'],
    complianceTab: 'i9',
    alwaysVisible: true,
  },
  {
    key: 'everify',
    title: 'E-Verify',
    blurb: 'Federal work-authorization case and closure packet',
    icon: ShieldCheck,
    kinds: ['I9_VERIFICATION_RESULT'],
    complianceTab: 'everify',
    alwaysVisible: true,
  },
  {
    key: 'background',
    title: 'Background check',
    blurb: 'Provider screening reports',
    icon: FileSearch,
    kinds: ['BACKGROUND_CHECK_RESULT'],
    complianceTab: 'background',
    alwaysVisible: true,
  },
  {
    key: 'drug',
    title: 'Drug test',
    blurb: 'Lab results — a result is valid for 60 days',
    icon: FlaskConical,
    kinds: ['DRUG_TEST_RESULT'],
    complianceTab: 'drugtests',
    alwaysVisible: true,
  },
  {
    key: 'j1',
    title: 'J-1 program',
    blurb: 'DS-2019 and visa documents',
    icon: Plane,
    kinds: ['J1_DS2019', 'J1_VISA'],
    complianceTab: 'j1',
  },
  {
    key: 'tax',
    title: 'Tax & payroll',
    blurb: 'W-4, paystubs, and payroll paperwork',
    icon: Landmark,
    kinds: ['W4_PDF', 'PAYSTUB'],
  },
  {
    key: 'agreements',
    title: 'Agreements & policies',
    blurb: 'Offer letters, signed agreements, and policy acknowledgments',
    icon: FileSignature,
    kinds: ['OFFER_LETTER', 'POLICY', 'HOUSING_AGREEMENT', 'TRANSPORT_AGREEMENT', 'SIGNED_AGREEMENT'],
  },
  {
    key: 'other',
    title: 'Other',
    blurb: 'Everything that fits no other drawer',
    icon: FolderOpen,
    kinds: ['OTHER'],
  },
];

const EVERIFY_CHIP: Record<string, { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Case pending', tone: 'pending' },
  EMPLOYMENT_AUTHORIZED: { label: 'Authorized', tone: 'success' },
  TENTATIVE_NONCONFIRMATION: { label: 'Tentative nonconfirmation', tone: 'destructive' },
  FINAL_NONCONFIRMATION: { label: 'Final nonconfirmation', tone: 'destructive' },
  CLOSE_CASE_AND_RESUBMIT: { label: 'Close & resubmit', tone: 'pending' },
};

const SCREEN_CHIP: Record<string, { label: string; tone: BadgeTone }> = {
  INITIATED: { label: 'Ordered', tone: 'accent' },
  IN_PROGRESS: { label: 'In progress', tone: 'accent' },
  NEEDS_REVIEW: { label: 'Needs review', tone: 'pending' },
  PASSED: { label: 'Passed', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'destructive' },
};

/** Ledger → header chips: the decision each category's documents evidence. */
function vaultChips(
  key: string,
  s: DocumentVaultSummary,
  docCount: number,
): Array<{ label: string; tone: BadgeTone }> {
  switch (key) {
    case 'identity': {
      if (!s.i9) return [{ label: 'I-9 not started', tone: 'default' }];
      return [
        s.i9.section1CompletedAt
          ? { label: 'Section 1 complete', tone: 'success' }
          : { label: 'Section 1 pending', tone: 'pending' },
        s.i9.section2CompletedAt
          ? { label: 'Section 2 complete', tone: 'success' }
          : { label: 'Section 2 pending', tone: 'pending' },
      ];
    }
    case 'everify': {
      if (!s.everify) return [{ label: 'No case recorded', tone: 'default' }];
      const chip = (s.everify.status && EVERIFY_CHIP[s.everify.status]) || {
        label: 'Case open',
        tone: 'pending' as BadgeTone,
      };
      return s.everify.caseNumber
        ? [chip, { label: `Case ${s.everify.caseNumber}`, tone: 'default' }]
        : [chip];
    }
    case 'background': {
      if (!s.background) return [{ label: 'Never screened', tone: 'default' }];
      const chip = SCREEN_CHIP[s.background.status] ?? {
        label: s.background.status,
        tone: 'default' as BadgeTone,
      };
      const chips = [
        s.background.completedAt
          ? { ...chip, label: `${chip.label} ${fmtDate(s.background.completedAt)}` }
          : chip,
      ];
      const finalized = s.background.status === 'PASSED' || s.background.status === 'FAILED';
      if (finalized && docCount === 0) {
        chips.push({ label: 'No report on file', tone: 'pending' });
      }
      return chips;
    }
    case 'drug': {
      if (!s.drugTest) return [{ label: 'Never tested', tone: 'default' }];
      const chips: Array<{ label: string; tone: BadgeTone }> = [];
      if (s.drugTest.lastResultAt) {
        chips.push(
          s.drugTest.fresh
            ? { label: `Result current (${fmtDate(s.drugTest.lastResultAt)})`, tone: 'success' }
            : { label: `Result expired (${fmtDate(s.drugTest.lastResultAt)})`, tone: 'destructive' },
        );
      } else {
        chips.push({ label: 'No result on file', tone: 'pending' });
      }
      if (s.drugTest.status === 'INITIATED' || s.drugTest.status === 'IN_PROGRESS') {
        chips.push({ label: 'Order in flight', tone: 'accent' });
      }
      return chips;
    }
    case 'j1': {
      if (!s.j1) return [];
      return [
        {
          label: `Program ${fmtDate(`${s.j1.programStartDate}T12:00:00Z`)} – ${fmtDate(`${s.j1.programEndDate}T12:00:00Z`)}`,
          tone: 'default',
        },
        { label: s.j1.sponsorAgency, tone: 'default' },
      ];
    }
    default:
      return [];
  }
}

function DocumentsTab({ associateId }: { associateId: string }) {
  const queryClient = useQueryClient();
  const [actingId, setActingId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DocumentRecord | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const [search, setSearch] = useState('');

  const { data: vault, error: docsError } = useQuery({
    queryKey: ['associate-vault', associateId],
    queryFn: () => getDocumentVault(associateId),
  });
  const docs = vault?.documents;
  const error = docsError
    ? docsError instanceof ApiError
      ? docsError.message
      : 'Failed to load.'
    : null;

  function replaceDoc(updated: DocumentRecord) {
    queryClient.setQueryData<DocumentVaultResponse>(
      ['associate-vault', associateId],
      (old) =>
        old
          ? {
              ...old,
              documents: old.documents.map((d) => (d.id === updated.id ? updated : d)),
            }
          : old,
    );
  }

  function prependDoc(created: DocumentRecord) {
    queryClient.setQueryData<DocumentVaultResponse>(
      ['associate-vault', associateId],
      (old) =>
        old
          ? { ...old, documents: [created, ...old.documents], total: old.total + 1 }
          : old,
    );
  }

  // Group by compliance domain; unknown future kinds fall into Other so
  // nothing silently vanishes from the vault.
  const searching = search.trim().length > 0;
  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (d: DocumentRecord) =>
      !q ||
      d.filename.toLowerCase().includes(q) ||
      (DOCUMENT_KIND_LABEL[d.kind] ?? d.kind).toLowerCase().includes(q);
    const byKind = new Map<string, DocumentRecord[]>();
    for (const d of docs ?? []) {
      if (!matches(d)) continue;
      const arr = byKind.get(d.kind);
      if (arr) arr.push(d);
      else byKind.set(d.kind, [d]);
    }
    const covered = new Set(VAULT_CATEGORIES.flatMap((c) => c.kinds));
    return VAULT_CATEGORIES.map((cat) => ({
      ...cat,
      docs: [
        ...cat.kinds.flatMap((k) => byKind.get(k) ?? []),
        ...(cat.key === 'other'
          ? [...byKind.entries()].filter(([k]) => !covered.has(k)).flatMap(([, v]) => v)
          : []),
      ],
    }));
  }, [docs, search]);

  async function handleVerify(d: DocumentRecord) {
    if (actingId) return;
    setActingId(d.id);
    try {
      const updated = await verifyDocument(d.id);
      replaceDoc(updated);
      toast.success('Document verified.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not verify.');
    } finally {
      setActingId(null);
    }
  }

  async function handleReject(reason: string) {
    if (!rejectTarget || actingId) return;
    const id = rejectTarget.id;
    setActingId(id);
    try {
      const updated = await rejectDocument(id, { reason });
      replaceDoc(updated);
      toast.success('Document rejected.');
      setRejectTarget(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not reject.');
    } finally {
      setActingId(null);
    }
  }

  if (error) {
    return <ErrorBanner>{error}</ErrorBanner>;
  }
  if (!vault || !docs) {
    return <SkeletonRows count={3} rowHeight="h-9" />;
  }

  const summary = vault.summary;
  // The four screening domains always render — their ledger status is the
  // point even with zero files. J-1 appears for J-1 people; the rest only
  // when they hold documents. A live search hides empty sections entirely.
  const visibleSections = sections.filter((s) =>
    searching
      ? s.docs.length > 0
      : s.docs.length > 0 || s.alwaysVisible || (s.key === 'j1' && summary.j1 !== null),
  );

  const uploadButton = (
    <Button size="sm" variant="outline" onClick={() => setShowUpload(true)}>
      <Upload className="h-3.5 w-3.5" />
      Upload result
    </Button>
  );

  const docRow = (d: DocumentRecord) => (
            <TableRow key={d.id}>
              <TableCell>
                <div className="font-medium text-white text-sm">
                  {DOCUMENT_KIND_LABEL[d.kind] ?? d.kind}
                </div>
                <div className="text-2xs text-silver truncate max-w-[220px]">
                  {d.filename}
                </div>
                {!d.fileAvailable && (
                  <div className="text-2xs text-alert mt-0.5">
                    File missing on server — please re-upload
                  </div>
                )}
                {d.status === 'REJECTED' && d.rejectionReason && (
                  <div className="text-2xs text-alert mt-0.5 truncate max-w-[220px]">
                    {d.rejectionReason}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <StatusBadge status={d.status} />
              </TableCell>
              <TableCell className="hidden sm:table-cell text-xs text-silver tabular-nums">
                {fmtDate(d.createdAt)}
              </TableCell>
              <TableCell>
                <div className="flex justify-end items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setPreviewDoc(d)}
                    aria-label={`View ${d.filename}`}
                    title={d.fileAvailable ? 'View' : 'File missing — open for details'}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  {d.status === 'UPLOADED' && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void handleVerify(d)}
                        disabled={actingId === d.id || !d.fileAvailable}
                        aria-label={`Verify ${d.filename}`}
                        title={
                          d.fileAvailable
                            ? 'Verify'
                            : "Can't verify — file missing on server"
                        }
                        className="text-success hover:text-success"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setRejectTarget(d)}
                        disabled={actingId === d.id}
                        aria-label={`Reject ${d.filename}`}
                        title="Reject"
                        className="text-alert hover:text-alert"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                  {d.fileAvailable ? (
                    <a
                      href={downloadDocumentUrl(d.id)}
                      download
                      className="grid place-items-center h-8 w-8 rounded text-silver hover:text-white hover:bg-navy-secondary/60"
                      aria-label={`Download ${d.filename}`}
                      title="Download"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  ) : (
                    <span
                      className="grid place-items-center h-8 w-8 rounded text-silver/30 cursor-not-allowed"
                      aria-label="Download disabled — file missing"
                      title="File missing on server — re-upload required"
                    >
                      <Download className="h-4 w-4" />
                    </span>
                  )}
                </div>
              </TableCell>
            </TableRow>
  );

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">Document vault</h2>
          <p className="mt-0.5 text-xs text-silver/70">
            {vault.total === 0
              ? 'Nothing on file yet — every document uploaded anywhere on the site lands here.'
              : `${vault.total} document${vault.total === 1 ? '' : 's'} on file${
                  vault.total > docs.length ? ` · showing latest ${docs.length}` : ''
                } — the associate's complete file, grouped by compliance domain.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents…"
            className="h-8 w-48 text-sm"
            aria-label="Search documents"
          />
          {vault.total > 0 && (
            <a
              href={downloadAllDocumentsUrl(associateId)}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-navy-secondary px-2.5 text-xs text-silver hover:border-gold/60 hover:text-white"
              title="One zip of this associate's entire file (audited)"
            >
              <Download className="h-3.5 w-3.5" />
              Download all
            </a>
          )}
          {uploadButton}
        </div>
      </div>

      <div className="space-y-4">
        {visibleSections.map((cat) => {
          const chips = vaultChips(cat.key, summary, cat.docs.length);
          const Icon = cat.icon;
          return (
            <section
              key={cat.key}
              className="overflow-hidden rounded-lg border border-navy-secondary bg-navy/40"
            >
              <header className="flex flex-wrap items-center gap-3 border-b border-navy-secondary bg-navy-secondary/25 px-4 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-gold/10 text-gold">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold leading-tight text-white">
                    {cat.title}
                    <span className="ml-2 font-normal tabular-nums text-silver/60">
                      {cat.docs.length}
                    </span>
                  </h3>
                  <p className="text-2xs text-silver/60">{cat.blurb}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:ml-2">
                  {chips.map((c, i) => (
                    <Badge key={i} variant={c.tone}>
                      {c.label}
                    </Badge>
                  ))}
                </div>
                {cat.complianceTab && (
                  <Link
                    // associateId rides along so tabs that support person
                    // deep-links (I-9 today) open THIS person; others
                    // ignore it harmlessly.
                    to={`/compliance?tab=${cat.complianceTab}&associateId=${associateId}`}
                    className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gold hover:underline"
                  >
                    Open in Compliance
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
              </header>
              {cat.docs.length === 0 ? (
                <p className="px-4 py-3 text-xs text-silver/60">
                  No documents filed in this section.
                </p>
              ) : (
                <Table caption={cat.title}>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Document</TableHead>
                      <TableHead className="w-28">Status</TableHead>
                      <TableHead className="hidden sm:table-cell">Uploaded</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{cat.docs.map(docRow)}</TableBody>
                </Table>
              )}
            </section>
          );
        })}
        {searching && visibleSections.length === 0 && (
          <p className="text-sm text-silver">
            No documents match &ldquo;{search.trim()}&rdquo;.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title="Reject document"
        description={
          rejectTarget
            ? `${DOCUMENT_KIND_LABEL[rejectTarget.kind] ?? rejectTarget.kind} — ${rejectTarget.filename}`
            : ''
        }
        requireReason
        reasonLabel="Reason for rejection"
        reasonPlaceholder="What's missing or wrong with this document?"
        confirmLabel={actingId === rejectTarget?.id ? 'Rejecting…' : 'Reject'}
        destructive
        busy={actingId === rejectTarget?.id}
        onConfirm={handleReject}
      />

      <DocumentPreview
        doc={previewDoc}
        onOpenChange={(o) => !o && setPreviewDoc(null)}
      />

      <UploadResultDialog
        open={showUpload}
        onOpenChange={setShowUpload}
        associateId={associateId}
        onUploaded={prependDoc}
      />
    </>
  );
}

function UploadResultDialog({
  open,
  onOpenChange,
  associateId,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  associateId: string;
  onUploaded: (doc: DocumentRecord) => void;
}) {
  const [kind, setKind] = useState<DocumentKind>('BACKGROUND_CHECK_RESULT');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset when the dialog reopens so a previous selection doesn't linger.
  useEffect(() => {
    if (open) {
      setKind('BACKGROUND_CHECK_RESULT');
      setFile(null);
      setBusy(false);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    try {
      const created = await uploadAdminDocument(file, kind, associateId);
      onUploaded(created);
      toast.success('Result uploaded.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.');
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload result document</DialogTitle>
          <DialogDescription>
            Attach a PDF or image (background-check report, drug-test result,
            E-Verify confirmation, etc.) to this associate&apos;s profile.
            The document is marked verified on upload.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Document type">
            {(p) => (
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as DocumentKind)}
                {...p}
              >
                {HR_UPLOAD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {DOCUMENT_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="File" hint="PDF, PNG, JPEG, or WebP. Max 10 MB.">
            {(p) => (
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-silver file:mr-3 file:rounded-md file:border-0 file:bg-navy-secondary file:px-3 file:py-2 file:text-xs file:font-medium file:text-white hover:file:bg-navy-secondary/80"
                {...p}
              />
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!file}>
              <Upload className="h-4 w-4" />
              Upload
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-widest text-silver/80 mb-2 border-b border-navy-secondary pb-1">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <div className="w-32 text-silver text-xs flex items-center gap-1.5 pt-0.5">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex-1 min-w-0 text-white">{value}</div>
    </div>
  );
}
