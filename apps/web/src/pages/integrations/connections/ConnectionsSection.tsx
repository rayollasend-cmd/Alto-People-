import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plug, Plus } from '@/components/ui/icons';
import type { IntegrationConnectionSummary } from '@alto-people/shared';
import { listIntegrationConnections, listIntegrationVendors } from '@/lib/integrationsApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ConnectDrawer } from './ConnectDrawer';
import { connectionStatus, modeLabel, vendorLabel } from './shared';

/**
 * Brief 3-5: the tenant's HR and VMS connections, on Settings & Trust ›
 * Integrations under Connections. One row per connection: the vendor and
 * its name, the state in one badge, when it last ran and when it runs
 * next, and how many records the last ten runs rejected. The row opens
 * the connection's sync log.
 */
export function ConnectionsSection({ canManage }: { canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const connections = useQuery({ queryKey: ['integrations', 'connections'], queryFn: listIntegrationConnections });
  const vendors = useQuery({ queryKey: ['integrations', 'vendors'], queryFn: listIntegrationVendors, staleTime: 10 * 60_000 });
  const rows = connections.data?.connections ?? null;

  return (
    <div className="space-y-3">
      {connections.isError ? (
        <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => connections.refetch()}>Retry</Button>}>
          Couldn’t load the connections.
        </ErrorBanner>
      ) : rows === null ? (
        <Card><CardContent><SkeletonRows count={2} /></CardContent></Card>
      ) : rows.length === 0 ? (
        // One quiet line, not a hero (F500 G4): the only gold button on Integrations is a failing connection's fix.
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <span className="flex min-w-0 items-center gap-3">
              <Plug className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="text-sm text-ink">No HR or VMS system connected</span>
            </span>
            {canManage && (
              <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Connect a system
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-line" aria-label="HR and VMS connections">
              {rows.map((c) => (
                <ConnectionRow key={c.id} c={c} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {rows !== null && rows.length > 0 && canManage && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Connect a system
          </Button>
        </div>
      )}
      <ConnectDrawer open={open} onOpenChange={setOpen} vendors={vendors.data?.vendors ?? []} onSaved={() => connections.refetch()} />
    </div>
  );
}

function ConnectionRow({ c }: { c: IntegrationConnectionSummary }) {
  const s = connectionStatus(c);
  return (
    <li>
      <Link
        to={`/integrations/connections/${c.id}`}
        className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 transition-colors hover:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{c.name}</span>
          <span className="block truncate text-xs text-ink-muted">
            {vendorLabel(c.vendor)} · {modeLabel(c)} · {c.capabilities.length} of the vendor’s capabilities on
            {c.scheduleMinutes ? ` · every ${c.scheduleMinutes >= 60 ? `${c.scheduleMinutes / 60}h` : `${c.scheduleMinutes}m`}` : ''}
            {c.eventDriven ? ' · on events' : ''}
          </span>
        </span>
        <span className="flex items-center gap-3 text-xs text-ink-muted">
          <span className="hidden sm:inline">{c.lastSyncAt ? `Last sync ${fmtDateTime(c.lastSyncAt)}` : 'Never synced'}</span>
          {c.recentErrors > 0 && <span className={cn('tabular-nums', 'text-alert')}>{c.recentErrors} rejected</span>}
          <Badge variant={s.variant} size="sm">{s.label}</Badge>
        </span>
      </Link>
    </li>
  );
}
