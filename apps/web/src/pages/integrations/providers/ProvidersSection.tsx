import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listProviderConnections, providerCatalog, type ProviderKind, type ProviderKindSummary } from '@/lib/providersApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { ProviderSetupDrawer } from './ProviderSetupDrawer';
import { ProviderManageDrawer } from './ProviderManageDrawer';
import { HEALTH_BADGE, KIND_COPY, KIND_ICON, environmentLabel, healthLine } from './providerShared';

/**
 * Settings & trust → Integrations → Screening, filing and payouts: one card
 * per kind. Not connected says what happens today (the manual path) and
 * offers setup; connected says which provider, sandbox or live, and how it
 * is doing — failing says since when and what it said.
 */
export function ProvidersSection({ canManage }: { canManage: boolean }) {
  const list = useQuery({ queryKey: ['providers', 'connections'], queryFn: listProviderConnections });
  const catalog = useQuery({ queryKey: ['providers', 'catalog'], queryFn: providerCatalog, staleTime: 30 * 60_000 });
  const [setupKind, setSetupKind] = useState<ProviderKind | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);

  const kinds = list.data?.kinds ?? null;
  const managed = kinds?.flatMap((k) => k.connections).find((c) => c.id === manageId) ?? null;

  return (
    <section aria-labelledby="providers-title" className="space-y-3">
      <SectionTitle
        id="providers-title"
        title="Screening, filing and payouts"
        description="The services that work for you from here. Each one is optional — without it, the work is recorded by hand as it is today."
      />
      {list.isError ? (
        <QueryError what="the provider connections" query={list} />
      ) : kinds === null ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading provider connections">
          {Array.from({ length: 5 }, (_, i) => (
            <Card key={i}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-8 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Provider kinds">
          {kinds.map((k) => (
            <KindCard key={k.kind} k={k} canManage={canManage} onSetup={() => setSetupKind(k.kind)} onManage={(id) => setManageId(id)} />
          ))}
        </ul>
      )}
      <ProviderSetupDrawer
        kind={setupKind}
        providers={(catalog.data?.providers ?? []).filter((p) => p.kind === setupKind)}
        onClose={() => setSetupKind(null)}
        onSaved={(id) => {
          void list.refetch();
          setSetupKind(null);
          setManageId(id);
        }}
      />
      <ProviderManageDrawer
        connection={managed}
        info={(catalog.data?.providers ?? []).find((p) => p.id === managed?.provider) ?? null}
        canManage={canManage}
        onClose={() => setManageId(null)}
        onChanged={() => void list.refetch()}
      />
    </section>
  );
}

function KindCard({ k, canManage, onSetup, onManage }: { k: ProviderKindSummary; canManage: boolean; onSetup: () => void; onManage: (id: string) => void }) {
  const Icon = KIND_ICON[k.kind];
  const copy = KIND_COPY[k.kind];
  const c = k.active;
  const badge = c ? HEALTH_BADGE[c.health] : null;
  return (
    <li>
      <Card className={cn('h-full', c?.health === 'failing' && 'border-alert/50')}>
        <CardContent className="flex h-full flex-col gap-3 p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-raised text-ink-muted" aria-hidden="true">
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-ink">{copy.title}</h3>
              <p className="text-xs text-ink-muted">{c ? `${c.providerLabel} · ${environmentLabel(c.environment)}` : 'Not connected'}</p>
            </div>
            {badge && (
              <Badge size="sm" variant={badge.variant}>
                {badge.label}
              </Badge>
            )}
          </div>
          <p className={cn('flex-1 text-sm', c?.health === 'failing' ? 'text-alert' : 'text-ink-muted')}>{c ? healthLine(c) : copy.manual}</p>
          <div>
            {c ? (
              <Button size="sm" variant="outline" onClick={() => onManage(c.id)}>
                {canManage ? 'Manage' : 'View'}
              </Button>
            ) : canManage ? (
              <Button size="sm" onClick={onSetup}>
                Set up {copy.title.toLowerCase()}
              </Button>
            ) : (
              <span className="text-xs text-ink-muted">An integrations admin can connect this.</span>
            )}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
