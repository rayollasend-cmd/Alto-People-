import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Building2,
  ClipboardList,
  DollarSign,
  LayoutGrid,
  List,
  MapPin,
  Plus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ClientListItem, ClientStatus } from '@alto-people/shared';
import { listClients } from '@/lib/clientsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { StatusBadge } from '@/lib/status';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { FilterBar, FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { ViewToggle, useViewMode } from '@/components/ui/ViewToggle';
import { NewClientDialog } from './NewClientDialog';

const STATUS_FILTERS: Array<{ value: ClientStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PROSPECT', label: 'Prospect' },
  { value: 'INACTIVE', label: 'Inactive' },
];

const VIEW_OPTIONS = ['cards', 'table'] as const;
type ClientsView = (typeof VIEW_OPTIONS)[number];

function fmtRelative(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

export function ClientsHome() {
  const { can } = useAuth();
  const canManage = can('manage:clients');

  const [items, setItems] = useState<ClientListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ClientStatus | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [view, setView] = useViewMode<ClientsView>('clients', 'cards', VIEW_OPTIONS);
  useEffect(() => {
    const t = setTimeout(() => setAppliedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const refresh = useCallback(async () => {
    try {
      const res = await listClients({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        q: appliedQuery,
      });
      setItems(res.clients);
      setNextCursor(res.nextCursor ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [statusFilter, appliedQuery]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listClients({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        q: appliedQuery,
        cursor: nextCursor,
      });
      setItems((prev) => [...(prev ?? []), ...res.clients]);
      setNextCursor(res.nextCursor ?? null);
    } catch (err) {
      // The "Load more" button stays visible, so pressing it again retries.
      toast.error('Could not load more clients.', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Surface "?qbo_error=..." set by the QuickBooks OAuth callback when state
  // validation failed before we knew which client to bounce to. Clear the
  // param so a refresh doesn't re-fire the toast.
  const [searchParams, setSearchParams] = useSearchParams();
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
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Industry</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right hidden sm:table-cell">Open apps</TableHead>
                <TableHead className="text-right hidden md:table-cell">Active</TableHead>
                <TableHead className="text-right hidden lg:table-cell">Last payroll</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={c.name} size="sm" />
                      <Link
                        to={`/clients/${c.id}`}
                        className="text-white hover:text-gold-bright font-medium underline-offset-4 hover:underline"
                      >
                        {c.name}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-silver">
                    {c.industry ?? '—'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell>
                    {c.state ? (
                      <span className="inline-flex items-center gap-1 text-silver">
                        <MapPin className="h-3 w-3" aria-hidden="true" />
                        {c.state}
                      </span>
                    ) : (
                      <span className="text-silver/80 italic text-xs">federal default</span>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right hidden sm:table-cell tabular-nums',
                      c.openApplications > 0 ? 'text-silver' : 'text-silver/70'
                    )}
                  >
                    {c.openApplications}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right hidden md:table-cell tabular-nums',
                      c.activeAssociateCount > 0 ? 'text-success' : 'text-silver/70'
                    )}
                  >
                    {c.activeAssociateCount}
                  </TableCell>
                  <TableCell className="text-right hidden lg:table-cell text-silver text-xs">
                    {fmtRelative(c.lastPayrollDisbursedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {items && nextCursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={loadMore} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}

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
