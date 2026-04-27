import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, MapPin, Plus, Search } from 'lucide-react';
import type { ClientListItem, ClientStatus } from '@alto-people/shared';
import { listClients } from '@/lib/clientsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { NewClientDialog } from './NewClientDialog';

const STATUS_VARIANT: Record<
  string,
  'success' | 'pending' | 'destructive' | 'default'
> = {
  ACTIVE: 'success',
  PROSPECT: 'pending',
  INACTIVE: 'default',
};

const STATUS_FILTERS: Array<{ value: ClientStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PROSPECT', label: 'Prospect' },
  { value: 'INACTIVE', label: 'Inactive' },
];

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
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ClientStatus | 'ALL'>('ALL');
  // Two search states: `query` is what the user types, `appliedQuery` is what
  // the server has been asked. The 250ms debounce avoids a request per
  // keystroke while still feeling immediate.
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [statusFilter, appliedQuery]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Clients
          </h1>
          <p className="text-silver">
            Configure work-site state, geofence, and per-client jobs.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" />
            New client
          </Button>
        )}
      </header>

      {error && (
        <div
          className="mb-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-md border border-navy-secondary p-0.5 bg-navy-secondary/30">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={cn(
                'px-3 py-1 text-xs uppercase tracking-wider rounded-sm transition-colors',
                statusFilter === f.value
                  ? 'bg-gold text-navy'
                  : 'text-silver hover:text-white'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[14rem] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name…"
            className="pl-9"
            aria-label="Search clients"
          />
        </div>
      </div>

      {!items && !error && (
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

      {items && items.length > 0 && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Industry</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right hidden sm:table-cell">Open apps</TableHead>
                <TableHead className="text-right hidden lg:table-cell">Last payroll</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link
                      to={`/clients/${c.id}`}
                      className="text-gold hover:text-gold-bright underline-offset-4 hover:underline"
                    >
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-silver">
                    {c.industry ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[c.status] ?? 'default'}>
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {c.state ? (
                      <span className="inline-flex items-center gap-1 text-silver">
                        <MapPin className="h-3 w-3" aria-hidden="true" />
                        {c.state}
                      </span>
                    ) : (
                      <span className="text-silver/50 italic text-xs">federal default</span>
                    )}
                  </TableCell>
                  <TableCell className={cn(
                    'text-right hidden sm:table-cell tabular-nums',
                    c.openApplications > 0 ? 'text-silver' : 'text-silver/50'
                  )}>
                    {c.openApplications}
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

      <NewClientDialog
        open={showNew}
        onOpenChange={setShowNew}
        onCreated={() => refresh()}
      />
    </div>
  );
}
