import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { ListTemplate } from '@/components/templates';
import { ConnectionsSection } from './connections/ConnectionsSection';
import { ProvidersSection } from './providers/ProvidersSection';

/** The tabs that moved to API & webhooks, and their names there — old links still land. */
const MOVED_TABS: Record<string, string> = { clients: 'apps', keys: 'keys', webhooks: 'webhooks' };

/**
 * Settings & trust › Integrations (F500 G4): the systems the business runs
 * with — payouts, screening, filing, tax, the bank, and the HR and VMS
 * systems — each in one card or row, in one vocabulary (Working · Needs
 * attention · Failing · Not connected), with a failing one's fix as the
 * only gold button. The API's own apps, keys and webhooks live on API &
 * webhooks (/developers).
 */
export function IntegrationsHome() {
  const { user } = useAuth();
  const { search } = useLocation();
  const canManage = user ? hasCapability(user.role, 'manage:integrations') : false;
  const moved = MOVED_TABS[new URLSearchParams(search).get('tab') ?? ''];
  if (moved) return <Navigate to={`/developers?tab=${moved}`} replace />;

  return (
    <ListTemplate
      title="Integrations"
      subtitle="The systems this organization works with: payouts, screening, filing, tax, your bank, and your HR and VMS systems."
      related={[{ label: 'API & webhooks', to: '/developers' }]}
    >
      {/* E-Verify, screening, drug tests, tax filing and payouts (lib/providers) — payouts first-class, its rail's health on its card. */}
      <ProvidersSection canManage={canManage} />

      {/* Brief 3-5: the HR and VMS systems the customer already runs. */}
      <section aria-labelledby="connections-title" className="space-y-3">
        <SectionTitle id="connections-title" title="HR and VMS systems" description="Fieldglass, ADP, Workday, UKG or Beeline: each connection starts in sandbox and proves its mapping first." />
        <ConnectionsSection canManage={canManage} />
      </section>
    </ListTemplate>
  );
}
