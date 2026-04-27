import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, MapPin } from 'lucide-react';
import type { ClientSummary } from '@alto-people/shared';
import { listClients } from '@/lib/clientsApi';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
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

const STATUS_VARIANT: Record<
  string,
  'success' | 'pending' | 'destructive' | 'default'
> = {
  ACTIVE: 'success',
  PROSPECT: 'pending',
  INACTIVE: 'default',
};

export function ClientsHome() {
  const [items, setItems] = useState<ClientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listClients()
      .then((res) => !cancelled && setItems(res.clients))
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Clients
        </h1>
        <p className="text-silver">
          Configure work-site state, geofence, and per-client jobs.
        </p>
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
          description="Once a client account is created, it'll appear here."
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
    </div>
  );
}
