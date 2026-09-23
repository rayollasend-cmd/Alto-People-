import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Building2,
  ClipboardList,
  DollarSign,
  FileText,
  LayoutGrid,
  List,
  MapPin,
  Plus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ClientListItem, ClientStatus } from '@alto-people/shared';
import { clientServiceReportUrl, listClients } from '@/lib/clientsApi';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtRelativeDate, ymdLocal } from '@/lib/format';
// Org-week helper — despite the name it starts weeks on SATURDAY, the
// Sat→Fri week every payroll/report surface runs on.
import { startOfWeekMonday } from '@/pages/scheduling/WeekCalendarView';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { StatusBadge } from '@/lib/status';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { FilterBar, FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { DataGrid } from '@/components/ui/DataGrid';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { ViewToggle, useViewMode } from '@/components/ui/ViewToggle';
import { NewClientDialog } from './NewClientDialog';
import { PipelineSection } from './PipelineSection';

const STATUS_FILTERS: Array<{ value: ClientStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PROSPECT', label: 'Prospect' },
  { value: 'INACTIVE', label: 'Inactive' },
];

const VIEW_OPTIONS = ['cards', 'table'] as const;
type ClientsView = (typeof VIEW_OPTIONS)[number];

// Shared relative formatter — one "time ago" dialect across the app.
const fmtRelative = (iso: string | null): string => fmtRelativeDate(iso);

/** The 8 most recent COMPLETED org weeks (Sat 00:00 → Fri), newest first —
 *  the weeks the service-report endpoint can cover. `value` is the week
 *  start as YYYY-MM-DD, the shape the `week` query param expects. */
export function serviceReportWeekOptions(): Array<{ value: string; label: string }> {
  const currentStart = startOfWeekMonday(new Date());
  const out: Array<{ value: string; label: string }> = [];
  for (let i = 1; i <= 8; i++) {
    const start = new Date(currentStart);
    start.setDate(start.getDate() - 7 * i);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    out.push({ value: ymdLocal(start), label: `${fmtDate(start)} – ${fmtDate(end)}` });
  }
  return out;
}

export function ClientsHome() {
  const { can } = useAuth();
  const canManage = can('manage:clients');
  // The weekly service-report endpoint is billing-gated; the button only
  // renders for logins that can actually download it.
  const canReport = can('process:payroll') || can('view:executive');
  // Per-row busy tracking so several clients' reports can generate in
  // parallel — a single busy id serialized the whole run.
  const [reportBusyIds, setReportBusyIds] = useState<Set<string>>(new Set());
  // Which org week every per-row PDF link covers. Defaults to the last
  // completed week — the server's own default when no week is passed.
  const reportWeeks = useMemo(serviceReportWeekOptions, []);
  const [reportWeek, setReportWeek] = useState(reportWeeks[0].value);

  const downloadReport = async (clientId: string, clientName: string) => {
    if (reportBusyIds.has(clientId)) return;
    // Functional updates — concurrent downloads must not clear each other.
    setReportBusyIds((prev) => {
      const n = new Set(prev);
      n.add(clientId);
      return n;
    });
    try {
      const res = await fetch(clientServiceReportUrl(clientId, reportWeek), {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const m = /filename="([^"]+)"/.exec(cd);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = m?.[1] ?? `service-report-${clientName}-${reportWeek}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      toast.success(`Service report for ${clientName} downloaded.`);
    } catch {
      toast.error(`Could not generate the report for ${clientName}.`);
    } finally {
      setReportBusyIds((prev) => {
        const n = new Set(prev);
        n.delete(clientId);
        return n;
      });
    }
  };

  const [showNew, setShowNew] = useState(false);
  // Filter + search live in the URL (?status=&q=, replace-mode) so
  // opening a client and coming Back restores the same slice of the list.
  const [statusFilter, setStatusFilter] = useState<ClientStatus | 'ALL'>(() => {
    const s = new URLSearchParams(window.location.search).get('status');
    return s && STATUS_FILTERS.some((f) => f.value === s)
      ? (s as ClientStatus | 'ALL')
      : 'ALL';
  });
  const [query, setQuery] = useState(
    () => new URLSearchParams(window.location.search).get('q') ?? '',
  );
  const [appliedQuery, setAppliedQuery] = useState(query);
  const [view, setView] = useViewMode<ClientsView>('clients', 'cards', VIEW_OPTIONS);
  useEffect(() => {
    const t = setTimeout(() => setAppliedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  // The same cursor-paged shape as the audit log, on the same query: the
  // pages are one cache entry keyed by the filters, Back restores the
  // scrolled list instantly, and "Load more" appends a page.
  const clientsQuery = useInfiniteQuery({
    queryKey: ['clients', 'list', statusFilter, appliedQuery],
    queryFn: ({ pageParam }) =>
      listClients({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        q: appliedQuery,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  const items = clientsQuery.data ? clientsQuery.data.pages.flatMap((pg) => pg.clients) : null;
  const nextCursor = clientsQuery.hasNextPage ? 'more' : null;
  const loadingMore = clientsQuery.isFetchingNextPage;
  const error = clientsQuery.error
    ? clientsQuery.error instanceof ApiError
      ? clientsQuery.error.message
      : 'Failed to load.'
    : null;
  const refresh = () => clientsQuery.refetch();
  const loadMore = () => {
    if (clientsQuery.hasNextPage && !clientsQuery.isFetchingNextPage) void clientsQuery.fetchNextPage();
  };

  // Surface "?qbo_error=..." set by the QuickBooks OAuth callback when state
  // validation failed before we knew which client to bounce to. Clear the
  // param so a refresh doesn't re-fire the toast.
  const [searchParams, setSearchParams] = useSearchParams();

  // Mirror filter + debounced search into the URL. Replace-mode so
  // filter clicks don't pile up history entries — Back still leaves the
  // page in one press, and detail→Back restores the filters.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (statusFilter === 'ALL') next.delete('status');
        else next.set('status', statusFilter);
        if (appliedQuery) next.set('q', appliedQuery);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [statusFilter, appliedQuery, setSearchParams]);
  useEffect(() => {
    const code = searchParams.get('qbo_error');
    if (!code) return;
    toast.error('QuickBooks connection failed.', {
      description:
        code === 'invalid_state'
          ? 'Connection request expired or was tampered with. Try connecting again from the client page.'
          : 'Try connecting again from the client page.',
    });
    const next = new URLSearchParams(searchParams);
    next.delete('qbo_error');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div className="mx-auto">
      <PageHeader
        title="Clients"
        subtitle="Configure work-site state, geofence, and per-client jobs."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Clients' }]}
        secondaryActions={
          canReport ? (
            <Button asChild variant="outline">
              <Link to="/clients/statements">
                <FileText className="h-4 w-4" />
                Weekly statements
              </Link>
            </Button>
          ) : undefined
        }
        primaryAction={
          canManage ? (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" />
              New client
            </Button>
          ) : undefined
        }
      />

      {error && (
        <ErrorBanner className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => refresh()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}

      <FilterBar className="mb-4">
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={statusFilter === f.value}
            onClick={() => setStatusFilter(f.value)}
          >
            {f.label}
          </FilterChip>
        ))}
        <div className="flex-1 min-w-[14rem] max-w-md">
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name…"
            aria-label="Search clients"
          />
        </div>
        <span className="ml-auto text-2xs text-silver/80 tabular-nums">
          {items
            ? nextCursor
              ? // More pages exist server-side — don't present the page
                // length as the total.
                `${items.length} shown`
              : `${items.length} client${items.length === 1 ? '' : 's'}`
            : ''}
        </span>
        {canReport && view === 'table' && (
          <Select
            size="sm"
            aria-label="Service report week"
            title="Org week (Sat–Fri) each row's service-report PDF covers"
            value={reportWeek}
            onChange={(e) => setReportWeek(e.target.value)}
            className="max-w-[16rem]"
          >
            {reportWeeks.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
        )}
        <ViewToggle<ClientsView>
          value={view}
          onChange={setView}
          options={[
            { value: 'cards', label: 'Cards', icon: LayoutGrid },
            { value: 'table', label: 'Table', icon: List },
          ]}
        />
      </FilterBar>

      {!items && !error && view === 'cards' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      )}

      {!items && !error && view === 'table' && (
        <Card>
          <div className="p-2">
            <SkeletonRows count={4} rowHeight="h-12" />
          </div>
        </Card>
      )}

      {items && items.length === 0 && (
        <EmptyState
          icon={Building2}
          title={
            statusFilter !== 'ALL' || appliedQuery.length > 0
              ? 'No matching clients'
              : 'No clients yet'
          }
          description={
            statusFilter !== 'ALL' || appliedQuery.length > 0
              ? 'Try clearing the filter or search.'
              : canManage
                ? 'Click "New client" above to add your first one.'
                : "Once a client account is created, it'll appear here."
          }
        />
      )}

      {items && items.length > 0 && view === 'cards' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.map((c) => (
            <ClientCard key={c.id} client={c} />
          ))}
        </div>
      )}

      {items && items.length > 0 && view === 'table' && (
        <Card className="p-3">
          {/* The list's own filter bar above does the server-side status
              and search; the grid takes the loaded page and adds what the
              hand-built table never had — sort on every column, a column
              chooser, an export of what is on screen, and a real card
              layout on phones instead of columns that hide themselves. */}
          <DataGrid<ClientListItem>
            id="clients"
            caption="Clients"
            rows={items}
            rowKey={(c) => c.id}
            search={false}
            urlState={false}
            defaultSort={{ key: 'name', direction: 'asc' }}
            footnote={nextCursor ? 'more on the server — load more below' : undefined}
            columns={[
              {
                key: 'name',
                header: 'Name',
                accessor: (c) => c.name,
                sortable: true,
                primary: true,
                cell: (c) => (
                  <div className="flex items-center gap-2.5">
                    <Avatar name={c.name} size="sm" />
                    <Link
                      to={`/clients/${c.id}`}
                      className="text-white hover:text-gold-bright font-medium underline-offset-4 hover:underline"
                    >
                      {c.name}
                    </Link>
                  </div>
                ),
              },
              {
                key: 'industry',
                header: 'Industry',
                accessor: (c) => c.industry,
                sortable: true,
                cardMeta: true,
                className: 'text-silver',
              },
              {
                key: 'status',
                header: 'Status',
                accessor: (c) => c.status,
                sortable: true,
                cell: (c) => <StatusBadge status={c.status} />,
              },
              {
                key: 'state',
                header: 'State',
                accessor: (c) => c.state ?? 'federal default',
                sortable: true,
                cell: (c) =>
                  c.state ? (
                    <span className="inline-flex items-center gap-1 text-silver">
                      <MapPin className="h-3 w-3" aria-hidden="true" />
                      {c.state}
                    </span>
                  ) : (
                    <span className="text-silver/80 italic text-xs">federal default</span>
                  ),
              },
              {
                key: 'openApplications',
                header: 'Open apps',
                accessor: (c) => c.openApplications,
                sortable: true,
                align: 'right',
                className: 'tabular-nums',
                cell: (c) => (
                  <span className={c.openApplications > 0 ? 'text-silver' : 'text-silver/70'}>
                    {c.openApplications}
                  </span>
                ),
              },
              {
                key: 'active',
                header: 'Active',
                accessor: (c) => c.activeAssociateCount,
                sortable: true,
                align: 'right',
                className: 'tabular-nums',
                cell: (c) => (
                  <span className={c.activeAssociateCount > 0 ? 'text-success' : 'text-silver/70'}>
                    {c.activeAssociateCount}
                  </span>
                ),
              },
              {
                key: 'lastPayroll',
                header: 'Last payroll',
                accessor: (c) =>
                  c.lastPayrollDisbursedAt ? new Date(c.lastPayrollDisbursedAt).getTime() : null,
                csv: (c) => c.lastPayrollDisbursedAt ?? '',
                sortable: true,
                align: 'right',
                className: 'text-silver text-xs',
                cell: (c) => fmtRelative(c.lastPayrollDisbursedAt),
              },
              ...(canReport
                ? [
                    {
                      key: 'report',
                      header: 'Report',
                      accessor: () => null,
                      searchable: false,
                      align: 'right' as const,
                      csv: () => '',
                      cell: (c: ClientListItem) => (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void downloadReport(c.id, c.name)}
                          loading={reportBusyIds.has(c.id)}
                          title={`Download ${c.name}'s weekly service report for the selected week — the client-facing PDF.`}
                          aria-label={`Download service report for ${c.name}`}
                        >
                          <FileText className="h-3.5 w-3.5" />
                          PDF
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
      )}

      {items && nextCursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={loadMore} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}

      {canManage && <PipelineSection />}

      <NewClientDialog
        open={showNew}
        onOpenChange={setShowNew}
        onCreated={() => refresh()}
      />
    </div>
  );
}

function ClientCard({ client }: { client: ClientListItem }) {
  const stateLabel = client.state ?? 'Federal default';
  return (
    <Link
      to={`/clients/${client.id}`}
      className={cn(
        'group flex flex-col gap-3 rounded-lg border bg-navy p-4 transition-colors',
        'border-navy-secondary hover:border-gold/40',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright'
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar name={client.name} size="md" />
        <div className="min-w-0 flex-1">
          <div className="text-lg text-white group-hover:text-gold-bright transition-colors truncate leading-tight">
            {client.name}
          </div>
          <div className="text-xs text-silver mt-0.5 flex items-center gap-1.5 flex-wrap">
            {client.industry && <span>{client.industry}</span>}
            {client.industry && client.state && <span className="text-silver/70">·</span>}
            <span className="inline-flex items-center gap-0.5">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              {stateLabel}
            </span>
          </div>
        </div>
        <StatusBadge status={client.status} className="shrink-0" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-navy-secondary/60">
        <KpiTile
          icon={ClipboardList}
          label="Open apps"
          value={client.openApplications}
          tone={client.openApplications > 0 ? 'gold' : 'silver'}
        />
        <KpiTile
          icon={Users}
          label="Active"
          value={client.activeAssociateCount}
          tone={client.activeAssociateCount > 0 ? 'success' : 'silver'}
        />
        <KpiTile
          icon={DollarSign}
          label="Last payroll"
          value={fmtRelative(client.lastPayrollDisbursedAt)}
          tone={client.lastPayrollDisbursedAt ? 'silver' : 'mute'}
          small
        />
      </div>
    </Link>
  );
}

function KpiTile({
  icon: Icon,
  label,
  value,
  tone,
  small,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
  tone: 'gold' | 'success' | 'silver' | 'mute';
  small?: boolean;
}) {
  const valueClass =
    tone === 'gold'
      ? 'text-gold'
      : tone === 'success'
        ? 'text-success'
        : tone === 'silver'
          ? 'text-white'
          : 'text-silver/70';
  return (
    <div className="min-w-0">
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70 flex items-center gap-1">
        <Icon className="h-3 w-3" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          'mt-0.5 tabular-nums truncate',
          small ? 'text-xs' : 'text-lg font-semibold',
          valueClass
        )}
      >
        {value}
      </div>
    </div>
  );
}
