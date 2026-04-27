import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, MapPin, Plus } from 'lucide-react';
import type { ClientSummary } from '@alto-people/shared';
import { listClients } from '@/lib/clientsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
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

export function ClientsHome() {
  const { can } = useAuth();
  const canManage = can('manage:clients');

  const [items, setItems] = useState<ClientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await listClients();
      setItems(res.clients);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

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
          title="No clients yet"
          description={
            canManage
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
