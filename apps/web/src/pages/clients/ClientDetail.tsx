import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { ClientOverview as Overview, ClientSummary } from '@alto-people/shared';
import { getClient } from '@/lib/clientsApi';
import { clientOverviewKey } from '@/lib/clientAccountApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { StatusBadge } from '@/lib/status';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { RecordTemplate } from '@/components/templates';
import { Skeleton } from '@/components/ui/Skeleton';
import { JobsSection } from './JobsSection';
import { RateDefaultsSection } from './RateDefaultsSection';
import { StatementsSection } from './StatementsSection';
import { LocationsSection } from './LocationsSection';
import { BenefitsPlansSection } from './BenefitsPlansSection';
import { PortalAccessSection } from './PortalAccessSection';
import { ClientPerformance, useCanSeeClientPerformance } from './ClientPerformance';
import { ClientOverview, fmtCount, HEALTH, useClientOverview } from './ClientOverview';
import { ClientBasicsCard } from './ClientBasicsCard';
import { ClientSettingsSection } from './ClientSettingsSection';
import { ClientRecordActions } from './ClientRecordActions';

/**
 * One client account (Clients rebuild, 2026-10-22). It opens on the
 * Overview — how the account is doing and what needs you — and keeps
 * configuration a tab away: Basics (who the client is, read first),
 * Settings (scheduling week, work-site state, billing, exports) and the
 * facets that were here before.
 *
 * "?section=<key>" is the open tab and a contract notifications rely on:
 * ?section=basics opens Basics, ?section=state opens Settings at the
 * work-site state, ?tab=<key> is read the same way for older links.
 */

/** Old section keys that now live inside another tab. */
const SECTION_ALIASES: Record<string, string> = { state: 'settings' };

/** "Owner Pat Lee · Contract ends Dec 31, 2026 · Primary Dana Reyes · 3 locations · 41 on assignment", only what exists. */
export function recordSubtitle(o: Overview | undefined): string | undefined {
  if (!o) return undefined;
  const primary = o.contacts.find((c) => c.isPrimary);
  const parts = [
    o.owner ? `Owner ${o.owner.name}` : null,
    o.contract.end ? `${o.contract.daysLeft !== null && o.contract.daysLeft < 0 ? 'Contract ended' : 'Contract ends'} ${fmtDate(o.contract.end)}` : null,
    primary ? `Primary contact ${primary.name}` : null,
    o.locations.count > 0 ? (o.locations.count === 1 ? '1 location' : `${fmtCount(o.locations.count)} locations`) : null,
    o.kpis && o.kpis.onAssignment > 0 ? `${fmtCount(o.kpis.onAssignment)} on assignment` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** The account's health beside its status, and how many things need someone: one tap to the list. */
function HealthLink({ o }: { o: Overview }) {
  const h = HEALTH[o.kpis!.health];
  const n = o.needsYou.length;
  return (
    <Link to={{ search: '?section=overview', hash: '#needs-you' }} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright" data-testid="client-health-link">
      <Badge variant={h.variant}>{n > 0 ? `${h.label} · ${n} need${n === 1 ? 's' : ''} you` : h.label}</Badge>
    </Link>
  );
}

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const canManage = can('manage:clients');
  const showPerformance = useCanSeeClientPerformance();
  const canSeeStatements = can('process:payroll') || can('view:executive');

  const queryClient = useQueryClient();
  const [client, setClient] = useState<ClientSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingBasics, setEditingBasics] = useState(false);

  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('section') ?? searchParams.get('tab');
  const activeTab = requested ? (SECTION_ALIASES[requested] ?? requested) : 'overview';
  const openTab = (key: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('section', key);
    next.delete('tab');
    setSearchParams(next, { replace: true });
  };

  // ?section=state scrolls Settings to the work-site state once it renders.
  useEffect(() => {
    if (requested !== 'state' || !client) return;
    const t = window.setTimeout(() => document.getElementById('state')?.scrollIntoView?.({ block: 'start' }), 0);
    return () => window.clearTimeout(t);
  }, [requested, client]);

  const clientQuery = useQuery({
    // Keyed by the route id: this element stays mounted from one client's
    // URL to the next, and a fixed key showed the previous client's record.
    queryKey: ['ClientDetail', 'client', id ?? ''],
    queryFn: () => getClient(id!),
    enabled: Boolean(id),
  });
  useEffect(() => {
    if (clientQuery.data !== undefined) setClient(clientQuery.data);
  }, [clientQuery.data]);
  useEffect(() => {
    if (!clientQuery.isError) return;
    const err = clientQuery.error;
    setError(err instanceof ApiError ? err.message : 'Failed to load.');
  }, [clientQuery.isError, clientQuery.error]);
  // The header's line reads the overview the Overview tab shows (one request, shared).
  const overview = useClientOverview(id ?? '');
  // A different client's URL starts from its own read mode.
  useEffect(() => setEditingBasics(false), [id]);

  if (error) {
    return (
      <div className="mx-auto">
        <ErrorBanner>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                void clientQuery.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        </ErrorBanner>
      </div>
    );
  }
  // The previous client's record never paints under this client's URL.
  if (!client || client.id !== id) {
    return (
      <div className="mx-auto space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  // A save anywhere on the record is the record from now on, and the overview reads it again.
  const onSaved = (c: ClientSummary) => {
    setClient(c);
    queryClient.setQueryData(['ClientDetail', 'client', c.id], c);
    void queryClient.invalidateQueries({ queryKey: clientOverviewKey(c.id) });
  };
  const primary = overview.data?.contacts.find((c) => c.isPrimary && c.email) ?? null;
  const editBasics = () => {
    setEditingBasics(true);
    openTab('basics');
  };

  const tabs = [
    { key: 'overview', label: 'Overview', content: <ClientOverview client={client} onOpenTab={openTab} onSaved={onSaved} /> },
    {
      key: 'basics',
      label: 'Basics',
      content: <ClientBasicsCard client={client} canManage={canManage} editing={editingBasics} onEditingChange={setEditingBasics} onSaved={onSaved} />,
    },
    ...(showPerformance ? [{ key: 'performance', label: 'Performance', content: <ClientPerformance clientId={client.id} /> }] : []),
    { key: 'locations', label: 'Locations', content: <LocationsSection clientId={client.id} /> },
    { key: 'portal', label: 'Portal access', content: <PortalAccessSection clientId={client.id} /> },
    { key: 'jobs', label: 'Jobs', content: <JobsSection clientId={client.id} /> },
    { key: 'rates', label: 'Rates', content: <RateDefaultsSection clientId={client.id} /> },
    // Statements render for those who read them (payroll drafts and finalizes; executives read).
    ...(canSeeStatements ? [{ key: 'statements', label: 'Statements', content: <StatementsSection clientId={client.id} /> }] : []),
    { key: 'benefits', label: 'Benefits', content: <BenefitsPlansSection clientId={client.id} /> },
    { key: 'settings', label: 'Settings', content: <ClientSettingsSection client={client} onSaved={onSaved} onOpenTab={openTab} /> },
  ];

  return (
    <RecordTemplate
      breadcrumbs={[{ label: 'Clients', to: '/clients' }, { label: client.name }]}
      title={client.name}
      status={
        <span className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge status={client.status} />
          {overview.data?.kpis && <HealthLink o={overview.data} />}
        </span>
      }
      subtitle={recordSubtitle(overview.data) ?? (client.industry || undefined)}
      actions={<ClientRecordActions client={client} primaryEmail={primary ? { name: primary.name, email: primary.email! } : null} onEdit={editBasics} onOpenTab={openTab} />}
      tabs={tabs}
      activeTab={tabs.some((t) => t.key === activeTab) ? activeTab : 'overview'}
      onTabChange={openTab}
    />
  );
}
