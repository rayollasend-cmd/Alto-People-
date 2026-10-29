import { useSearchParams } from 'react-router-dom';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { I9Tab } from './I9Tab';
import { EVerifyTab } from './EVerifyTab';
import { BackgroundTab } from './BackgroundTab';
import { DrugTestTab } from './DrugTestTab';
import { J1Tab } from './J1Tab';
import { ComplianceScorecard } from './ComplianceScorecard';
import { AuditPacketTab } from './AuditPacketTab';
import { RequirementsTab } from './RequirementsTab';
import { ListTemplate } from '@/components/templates';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';

type Tab = 'scorecard' | 'i9' | 'everify' | 'background' | 'drugtests' | 'j1' | 'requirements' | 'audit';

export function ComplianceHome() {
  const { can } = useAuth();
  const canManage = can('manage:compliance');
  // The packet is the product's single largest PII export — the tab only
  // exists for the same capability the server enforces. It used to read
  // view:hr-admin, which six roles hold; the packet itself is now behind
  // export:audit-packet, which two do, so the tab followed it rather than
  // leaving four roles a button that 403s.
  const canAudit = can('export:audit-packet');
  const { moduleOn } = useTenant();
  const term = useTerm();
  // The scorecard measures client contracts (MSA, SOW, MTSA) and the J-1 tab a
  // sponsored program: a tenant with neither module gets neither tab, and lands
  // on I-9 instead of a scorecard of contracts it does not hold.
  const hasScorecard = moduleOn('clientPortal') || moduleOn('billRates');
  const hasJ1 = moduleOn('programs');
  const defaultTab: Tab = hasScorecard ? 'scorecard' : 'i9';
  // Scorecard is the new default landing — preventative dashboard. The
  // existing forensic tabs (I-9 / background / J-1) stay as drill-downs.
  // The active tab LIVES in ?tab= (URL is the single source of truth):
  // other pages deep-link a directorate (the profile document vault links
  // each category to its owning tab), the URL stays shareable, and Back
  // retraces tab switches instead of dumping out of the page.
  const TABS: readonly Tab[] = ['scorecard', 'i9', 'everify', 'background', 'drugtests', 'j1', 'requirements', 'audit'];
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  // A bookmarked ?tab=audit from before the capability narrowed would
  // otherwise select a tab that no longer renders — an empty page, not a
  // refusal. Fall back to the scorecard.
  const tabAllowed = (t: string | null): t is Tab =>
    TABS.includes(t as Tab) && (t !== 'audit' || canAudit) && (t !== 'scorecard' || hasScorecard) && (t !== 'j1' || hasJ1);
  const tab: Tab = tabAllowed(requestedTab) ? requestedTab : defaultTab;
  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    if (next === defaultTab) params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params);
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Compliance"
        subtitle={`Track I-9, background-check${hasJ1 ? ', drug-test and J-1' : ' and drug-test'} obligations across every active ${term('worker').toLowerCase()}.`}
        // The injury log, WC codes and EEO-1 are their own page (and their
        // own sidebar entry, Safety & EEO): a sibling link, not a button.
        related={[{ label: 'Safety & EEO reporting', to: '/compliance/osha' }]}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {hasScorecard && <TabsTrigger value="scorecard">Scorecard</TabsTrigger>}
          <TabsTrigger value="i9">I-9 verification</TabsTrigger>
          {/* Sits next to I-9 because E-Verify is downstream of it — the
              verifier finishes Section 2 and moves straight here. */}
          <TabsTrigger value="everify">E-Verify</TabsTrigger>
          <TabsTrigger value="background">Background checks</TabsTrigger>
          <TabsTrigger value="drugtests">Drug tests</TabsTrigger>
          {hasJ1 && <TabsTrigger value="j1">J-1 program</TabsTrigger>}
          {/* What each site requires (agent families step 5: the Compliance agent measures it weekly). */}
          <TabsTrigger value="requirements">{term('site')} requirements</TabsTrigger>
          {canAudit && <TabsTrigger value="audit">Audit packets</TabsTrigger>}
        </TabsList>
        {hasScorecard && (
          <TabsContent value="scorecard">
            <ComplianceScorecard />
          </TabsContent>
        )}
        <TabsContent value="i9">
          <I9Tab canManage={canManage} />
        </TabsContent>
        <TabsContent value="everify">
          <EVerifyTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="background">
          <BackgroundTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="drugtests">
          <DrugTestTab canManage={canManage} />
        </TabsContent>
        {hasJ1 && (
          <TabsContent value="j1">
            <J1Tab canManage={canManage} />
          </TabsContent>
        )}
        <TabsContent value="requirements">
          <RequirementsTab canManage={canManage} canReadQualifications={can('view:scheduling')} />
        </TabsContent>
        {canAudit && (
          <TabsContent value="audit">
            <AuditPacketTab />
          </TabsContent>
        )}
      </Tabs>
    </ListTemplate>
  );
}
