import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  keepPreviousData,
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
  FileText,
  Landmark,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Search,
  Send,
  ShieldAlert,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  DirectoryEntry,
  DirectoryStatus,
  DocumentKind,
  DocumentRecord,
} from '@alto-people/shared';
import { listDirectory, type DirectoryFilters } from '@/lib/directoryApi';
import { listClients } from '@/lib/clientsApi';
import type { ClientListItem } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import {
  type CompChangeReason,
  type CompRecord,
  type PayType,
  createRecord,
  listRecords,
} from '@/lib/compApi';
import {
  downloadDocumentUrl,
  listAdminDocuments,
  rejectDocument,
  uploadAdminDocument,
  verifyDocument,
} from '@/lib/documentsApi';
import { DocumentPreview } from '@/components/DocumentPreview';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { nudgeApplicant } from '@/lib/onboardingApi';
import {
  getAssociatePayoutMethod,
  getAssociateSsn,
  listDepartments,
  patchAssociateProfile,
  revealAssociatePayoutMethod,
  revealAssociateSsn,
  transferAssociate,
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
  Input,
  Label,
  PageHeader,
  Select,
  SkeletonRows,
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
} from '@/components/ui';
import { cn } from '@/lib/cn';

const STATUS_VARIANT: Record<
  DirectoryStatus,
  'success' | 'pending' | 'default'
> = {
  ACTIVE: 'success',
  PENDING: 'pending',
  INACTIVE: 'default',
};

const STATUS_LABEL: Record<DirectoryStatus, string> = {
  ACTIVE: 'Active',
  PENDING: 'Pending',
  INACTIVE: 'Inactive',
};

const EMPLOYMENT_LABEL: Record<string, string> = {
  W2_EMPLOYEE: 'W-2',
  CONTRACTOR_1099_INDIVIDUAL: '1099 Individual',
  CONTRACTOR_1099_BUSINESS: '1099 Business',
};

const PAY_TYPE_SUFFIX: Record<string, string> = {
  HOURLY: '/ hr',
  SALARY: '/ yr',
  COMMISSION: ' commission',
  PIECEWORK: ' / piece',
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

export function PeopleDirectory() {
  const queryClient = useQueryClient();
  // Seed the status filter from ?status= so dashboard tiles / cross-links can
  // deep-link straight to a filtered directory (e.g. /people?status=ACTIVE).
  const [filters, setFilters] = useState<DirectoryFilters>(() => {
    const raw = new URLSearchParams(window.location.search).get(
      'status',
    ) as DirectoryStatus | null;
    return raw && SEEDABLE_STATUSES.has(raw) ? { status: raw } : {};
  });
  const [search, setSearch] = useState('');
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
      setFilters((f) => {
        const trimmed = deferredSearch.trim();
        if ((f.q ?? '') === trimmed) return f;
        return { ...f, q: trimmed || undefined };
      });
    }, 250);
    return () => clearTimeout(id);
  }, [deferredSearch]);

  // Clients change rarely; cache for a long time so the filter dropdown
  // is instant on revisit. Failures are silent — the dropdown just shows
  // "All clients" without specific options.
  const { data: clients = [] as ClientListItem[] } = useQuery({
    queryKey: ['clients', 'list'],
    queryFn: async () => (await listClients()).clients,
    staleTime: 5 * 60_000,
  });

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
    queryKey: ['client-locations', filters.clientId],
    queryFn: async () =>
      (await listClientLocations(filters.clientId!)).locations,
    enabled: Boolean(filters.clientId),
    staleTime: 5 * 60_000,
  });

  // keepPreviousData makes filter/search changes show the old rows
  // (faded by isFetching) until the new ones arrive instead of flashing
  // a skeleton — much smoother on slow connections.
  const { data: rows, error: rowsError } = useQuery({
    queryKey: ['directory', filters],
    queryFn: async () => (await listDirectory(filters)).associates,
    placeholderData: keepPreviousData,
  });

  // Resolve the deep-link associateId once rows load. setTarget is the
  // canonical drawer-open path so we get all the existing render logic
  // for free. Strip the query param so the URL stays clean and a back-
  // forward dance doesn't re-open the drawer after the user closed it.
  useEffect(() => {
    if (!deepLinkAssociateId || !rows) return;
    const match = rows.find((r) => r.id === deepLinkAssociateId);
    if (match) {
      setTarget(match);
      const next = new URLSearchParams(searchParams);
      next.delete('associateId');
      setSearchParams(next, { replace: true });
    }
  }, [deepLinkAssociateId, rows, searchParams, setSearchParams]);
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="People directory"
        subtitle="Every associate Alto HR knows about — active, pending onboarding, and inactive — with workplace, pay, and contact in one row."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'People' }]}
      />

      {/* KPI strip */}
      {stats && (
        <Card>
          <CardContent className="flex flex-wrap gap-x-6 gap-y-2 py-3">
            <Kpi label="Total" value={stats.total} />
            <Kpi label="Active" value={stats.ACTIVE} tone="text-success" />
            <Kpi
              label="Pending onboarding"
              value={stats.PENDING}
              tone={stats.PENDING > 0 ? 'text-warning' : 'text-silver'}
              active={filters.status === 'PENDING'}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  status: f.status === 'PENDING' ? undefined : 'PENDING',
                }))
              }
            />
            <Kpi label="Inactive" value={stats.INACTIVE} tone="text-silver" />
          </CardContent>
        </Card>
      )}

      {/* Filter row */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-3">
          <div className="flex-1 w-full sm:min-w-[220px]">
            <label className="text-[10px] uppercase tracking-wider text-silver">
              Search
            </label>
            <div className="relative mt-1">
              <Search className="h-3.5 w-3.5 text-silver/70 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name or email"
                className="pl-8 pr-8"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-silver/70 hover:text-white"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          <FilterPicker
            label="Status"
            value={filters.status ?? ''}
            onChange={(v) =>
              setFilters((f) => ({
                ...f,
                status: (v || undefined) as DirectoryStatus | undefined,
              }))
            }
            options={[
              { value: '', label: 'All' },
              { value: 'ACTIVE', label: 'Active' },
              { value: 'PENDING', label: 'Pending' },
              { value: 'INACTIVE', label: 'Inactive' },
            ]}
          />
          <FilterPicker
            label="Workplace"
            value={filters.clientId ?? ''}
            onChange={(v) =>
              // Changing the workplace drops any location filter — a store
              // from the previous client would match nothing here.
              setFilters((f) => ({
                ...f,
                clientId: v || undefined,
                locationId: undefined,
              }))
            }
            options={[
              { value: '', label: 'All' },
              ...clients.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          {filters.clientId && locations.length > 0 && (
            <FilterPicker
              label="Location"
              value={filters.locationId ?? ''}
              onChange={(v) =>
                setFilters((f) => ({ ...f, locationId: v || undefined }))
              }
              options={[
                { value: '', label: 'All' },
                ...locations.map((l) => ({ value: l.id, label: l.name })),
              ]}
            />
          )}
          {departments.length > 0 && (
            <FilterPicker
              label="Department"
              value={filters.departmentId ?? ''}
              onChange={(v) =>
                setFilters((f) => ({ ...f, departmentId: v || undefined }))
              }
              options={[
                { value: '', label: 'All' },
                ...departments.map((d) => ({ value: d.id, label: d.name })),
              ]}
            />
          )}
          <FilterPicker
            label="Employment type"
            value={filters.employmentType ?? ''}
            onChange={(v) =>
              setFilters((f) => ({
                ...f,
                employmentType: (v || undefined) as DirectoryFilters['employmentType'],
              }))
            }
            options={[
              { value: '', label: 'All' },
              { value: 'W2_EMPLOYEE', label: 'W-2' },
              { value: 'CONTRACTOR_1099_INDIVIDUAL', label: '1099 Individual' },
              { value: 'CONTRACTOR_1099_BUSINESS', label: '1099 Business' },
            ]}
          />
        </CardContent>
      </Card>

      {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

      {!rows && !error && <SkeletonRows count={8} rowHeight="h-14" />}

      {rows && rows.length === 0 && (
        <EmptyState
          icon={Users}
          title={
            filters.q || filters.status || filters.clientId || filters.departmentId || filters.locationId || filters.employmentType
              ? 'No associates match these filters'
              : 'No associates yet'
          }
          description={
            filters.q || filters.status || filters.clientId || filters.departmentId || filters.locationId || filters.employmentType
              ? 'Loosen a filter or clear the search.'
              : 'Once you invite associates through onboarding they show up here.'
          }
        />
      )}

      {rows && rows.length > 0 && (
        <>
          {/* md+ : columnar table. Columns reveal progressively as
              viewport widens (md: Position, lg: Type + Pay, xl: Manager
              + Start). For lists past VIRTUALIZE_THRESHOLD we swap in a
              row virtualizer so DOM size stays bounded regardless of the
              underlying list size. */}
          <div className="hidden md:block">
            <DirectoryTable rows={rows} onSelect={setTarget} />
          </div>

          {/* Phone: card stack. Tap card → drawer (same as table click). */}
          <ul className="md:hidden space-y-2">
            {rows.map((r) => (
              <DirectoryPhoneCard key={r.id} row={r} onSelect={setTarget} />
            ))}
          </ul>
        </>
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
              queryClient.setQueryData<DirectoryEntry[]>(
                ['directory', filters],
                (old) =>
                  old ? old.map((r) => (r.id === updated.id ? updated : r)) : old,
              );
            }}
          />
        )}
      </Drawer>
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
  value: number;
  tone?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      <div className="text-[10px] uppercase tracking-wider text-silver">{label}</div>
      <div className={cn('text-2xl font-semibold tabular-nums', tone)}>{value}</div>
    </>
  );
  if (!onClick) {
    return <div className="min-w-[7rem]">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'min-w-[7rem] text-left rounded-md -mx-1.5 px-1.5 py-0.5 transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        active
          ? 'bg-gold/10 ring-1 ring-gold/40'
          : 'hover:bg-navy-secondary/40',
      )}
      title={active ? 'Clear filter' : `Filter to ${label.toLowerCase()}`}
    >
      {body}
    </button>
  );
}

function FilterPicker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="min-w-[150px]">
      <label className="text-[10px] uppercase tracking-wider text-silver">
        {label}
      </label>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        size="sm"
        className="mt-1"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
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

function DirectoryTable({
  rows,
  onSelect,
}: {
  rows: DirectoryEntry[];
  onSelect: (row: DirectoryEntry) => void;
}) {
  if (rows.length <= VIRTUALIZE_THRESHOLD) {
    return (
      <Card className="overflow-hidden">
        <Table caption="Associate directory">
          <TableHeader>
            <DirectoryHeaderRow />
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <DirectoryRow key={r.id} row={r} onSelect={onSelect} />
            ))}
          </TableBody>
        </Table>
      </Card>
    );
  }
  return <VirtualDirectoryTable rows={rows} onSelect={onSelect} />;
}

function DirectoryHeaderRow() {
  return (
    <TableRow className="hover:bg-transparent">
      <TableHead>Associate</TableHead>
      <TableHead className="w-28">Status</TableHead>
      <TableHead>Workplace</TableHead>
      <TableHead className="hidden md:table-cell">Position</TableHead>
      <TableHead className="hidden lg:table-cell w-24">Type</TableHead>
      <TableHead className="hidden lg:table-cell">Pay rate</TableHead>
      <TableHead className="hidden xl:table-cell">Manager</TableHead>
      <TableHead className="hidden xl:table-cell w-24">Start</TableHead>
    </TableRow>
  );
}

function VirtualDirectoryTable({
  rows,
  onSelect,
}: {
  rows: DirectoryEntry[];
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
            <DirectoryHeaderRow />
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
            <Badge variant="default" className="ml-1 text-[10px]">
              J-1
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
          {r.status === 'PENDING' && r.onboardingPercent !== null && (
            <span className="text-[10px] tabular-nums text-silver">
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
        {r.startDate ?? <span className="text-silver/70" aria-hidden="true">—</span>}
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
              <Badge variant={STATUS_VARIANT[r.status]} className="shrink-0">
                {STATUS_LABEL[r.status]}
              </Badge>
            </div>
            <div className="text-xs text-silver truncate">{r.email}</div>
            {(r.workplaceClientName || r.position) && (
              <div className="mt-1 text-[11px] text-silver/80 truncate">
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
              <div className="mt-1 text-[10px] tabular-nums text-silver">
                Onboarding {r.onboardingPercent}%
              </div>
            )}
            {r.j1Status && (
              <Badge variant="default" className="mt-1.5 text-[10px]">
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
  const [tab, setTab] = useState<'profile' | 'compensation' | 'documents'>(
    'profile',
  );
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
              <Badge variant={STATUS_VARIANT[a.status]} className="text-[10px]">
                {STATUS_LABEL[a.status]}
              </Badge>
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
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <ProfileTab associate={a} onAssociateChange={onAssociateChange} />
          </TabsContent>
          <TabsContent value="compensation">
            <CompensationTab associate={a} />
          </TabsContent>
          <TabsContent value="documents">
            <DocumentsTab associateId={a.id} />
          </TabsContent>
        </Tabs>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Link
          to={`/org`}
          className="text-xs px-3 py-2 rounded bg-navy-secondary/60 text-silver hover:text-white border border-navy-secondary"
        >
          Edit org assignment
        </Link>
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
        <InfoRow label="Start date" value={a.startDate ?? '—'} />
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

      <Section title="On record">
        <InfoRow
          label="In Alto HR since"
          value={fmtDate(a.createdAt)}
        />
      </Section>
    </div>
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
      toast.error('Phone must be at least 7 characters');
      return;
    }
    setSaving(true);
    try {
      const r = await patchAssociateProfile(a.id, { phone: next });
      onSaved(r.phone);
      toast.success('Phone updated');
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
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            aria-label="Save phone"
            title="Save"
            className="grid place-items-center h-8 w-8 rounded text-silver hover:text-white hover:bg-navy-secondary/60 disabled:opacity-40"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(a.phone ?? '');
              setEditing(false);
            }}
            disabled={saving}
            aria-label="Cancel"
            title="Cancel"
            className="grid place-items-center h-8 w-8 rounded text-silver hover:text-white hover:bg-navy-secondary/60 disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
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
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Edit phone"
            title="Edit"
            // Always visible on touch devices (no hover to reveal it);
            // hover-revealed on pointer devices to keep the row clean.
            className="opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 grid place-items-center h-9 w-9 rounded text-silver hover:text-white hover:bg-navy-secondary/60 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
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
        r.emailSent ? `Nudge sent to ${r.recipientEmail}` : 'Nudge logged',
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
        <Link
          to={`/onboarding/applications/${applicationId}`}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded bg-navy-secondary/60 text-silver hover:text-white border border-navy-secondary"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open application
        </Link>
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
              <div className="text-[10px] uppercase tracking-wider text-silver">
                Current rate
              </div>
              <div className="text-3xl font-semibold tabular-nums text-white mt-1">
                {current
                  ? fmtPay(current.amount, current.payType, current.currency)
                  : fmtPay(a.payAmount, a.payType, a.payCurrency)}
              </div>
              {current && (
                <div className="text-[11px] text-silver mt-1">
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
        <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-2 border-b border-navy-secondary pb-1">
          History
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
                      <span className="block text-[10px] text-silver/70 truncate max-w-[180px]">
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
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
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
      toast.success(`Transferred to ${targetLocation.name}`);
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
          <div className="text-xs text-silver">Loading…</div>
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
          <div className="text-xs text-silver">Loading…</div>
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
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
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
      toast.success('Rate updated');
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
              )}
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Effective from">
              {(p) => (
                <Input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  {...p}
                />
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

const DOCUMENT_KIND_LABEL: Record<string, string> = {
  ID: 'ID',
  SSN_CARD: 'SSN card',
  I9_SUPPORTING: 'I-9 supporting',
  W4_PDF: 'W-4',
  OFFER_LETTER: 'Offer letter',
  POLICY: 'Policy',
  HOUSING_AGREEMENT: 'Housing agreement',
  TRANSPORT_AGREEMENT: 'Transport agreement',
  J1_DS2019: 'DS-2019',
  J1_VISA: 'J-1 visa',
  SIGNED_AGREEMENT: 'Signed agreement',
  BACKGROUND_CHECK_RESULT: 'Background check result',
  DRUG_TEST_RESULT: 'Drug test result',
  I9_VERIFICATION_RESULT: 'I-9 verification result',
  OTHER: 'Other',
};

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

const DOC_STATUS_VARIANT: Record<
  DocumentRecord['status'],
  'success' | 'pending' | 'default'
> = {
  VERIFIED: 'success',
  UPLOADED: 'pending',
  REJECTED: 'default',
  EXPIRED: 'default',
};

function DocumentsTab({ associateId }: { associateId: string }) {
  const queryClient = useQueryClient();
  const [actingId, setActingId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DocumentRecord | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const { data: docs, error: docsError } = useQuery({
    queryKey: ['associate-docs', associateId],
    queryFn: async () => (await listAdminDocuments({ associateId })).documents,
  });
  const error = docsError
    ? docsError instanceof ApiError
      ? docsError.message
      : 'Failed to load.'
    : null;

  function replaceDoc(updated: DocumentRecord) {
    queryClient.setQueryData<DocumentRecord[]>(
      ['associate-docs', associateId],
      (old) =>
        old ? old.map((d) => (d.id === updated.id ? updated : d)) : old,
    );
  }

  function prependDoc(created: DocumentRecord) {
    queryClient.setQueryData<DocumentRecord[]>(
      ['associate-docs', associateId],
      (old) => (old ? [created, ...old] : [created]),
    );
  }

  async function handleVerify(d: DocumentRecord) {
    if (actingId) return;
    setActingId(d.id);
    try {
      const updated = await verifyDocument(d.id);
      replaceDoc(updated);
      toast.success('Document verified');
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
      toast.success('Document rejected');
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
  if (!docs) {
    return <SkeletonRows count={3} rowHeight="h-9" />;
  }

  const uploadButton = (
    <Button size="sm" variant="outline" onClick={() => setShowUpload(true)}>
      <Upload className="h-3.5 w-3.5" />
      Upload result
    </Button>
  );

  if (docs.length === 0) {
    return (
      <>
        <div className="flex items-center justify-end mb-3">{uploadButton}</div>
        <EmptyState
          icon={FileText}
          title="No documents on file"
          description="Upload background-check, drug-test, or E-Verify result PDFs here. Associate-submitted documents will also appear in this list."
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

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-widest text-silver/80">
          {docs.length} document{docs.length === 1 ? '' : 's'}
        </div>
        {uploadButton}
      </div>
      <Table caption="Documents">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Document</TableHead>
            <TableHead className="w-28">Status</TableHead>
            <TableHead className="hidden sm:table-cell">Uploaded</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {docs.map((d) => (
            <TableRow key={d.id}>
              <TableCell>
                <div className="font-medium text-white text-sm">
                  {DOCUMENT_KIND_LABEL[d.kind] ?? d.kind}
                </div>
                <div className="text-[10px] text-silver truncate max-w-[220px]">
                  {d.filename}
                </div>
                {!d.fileAvailable && (
                  <div className="text-[10px] text-alert mt-0.5">
                    File missing on server — please re-upload
                  </div>
                )}
                {d.status === 'REJECTED' && d.rejectionReason && (
                  <div className="text-[10px] text-alert mt-0.5 truncate max-w-[220px]">
                    {d.rejectionReason}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={DOC_STATUS_VARIANT[d.status]}>
                  {d.status.charAt(0) + d.status.slice(1).toLowerCase()}
                </Badge>
              </TableCell>
              <TableCell className="hidden sm:table-cell text-xs text-silver tabular-nums">
                {fmtDate(d.createdAt)}
              </TableCell>
              <TableCell>
                <div className="flex justify-end items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPreviewDoc(d)}
                    aria-label={`View ${d.filename}`}
                    title={d.fileAvailable ? 'View' : 'File missing — open for details'}
                    className="grid place-items-center h-8 w-8 rounded text-silver hover:text-white hover:bg-navy-secondary/60"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  {d.status === 'UPLOADED' && (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleVerify(d)}
                        disabled={actingId === d.id || !d.fileAvailable}
                        aria-label={`Verify ${d.filename}`}
                        title={
                          d.fileAvailable
                            ? 'Verify'
                            : "Can't verify — file missing on server"
                        }
                        className="grid place-items-center h-8 w-8 rounded text-success hover:bg-navy-secondary/60 disabled:opacity-40"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRejectTarget(d)}
                        disabled={actingId === d.id}
                        aria-label={`Reject ${d.filename}`}
                        title="Reject"
                        className="grid place-items-center h-8 w-8 rounded text-alert hover:bg-navy-secondary/60 disabled:opacity-40"
                      >
                        <X className="h-4 w-4" />
                      </button>
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
          ))}
        </TableBody>
      </Table>

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
      toast.success('Result uploaded');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
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
      <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-2 border-b border-navy-secondary pb-1">
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
