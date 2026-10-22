import { FileSignature, PiggyBank, ScrollText, UserPlus } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { NewHireReportsTab, PayNoticesTab, PaystubRulesTab, RothCatchUpTab } from './PayComplianceTabs';
import { ListTemplate } from '@/components/templates';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

/**
 * The payroll compliance queues that have no desk of their own: state
 * new-hire reporting (20-day rule), state pay notices, the 2026 Roth
 * catch-up rule and paystub rules. Everything overdue is loud.
 */

// Tax deposits and garnishment remittances moved to their desks
// (/payroll/taxes?tab=deposits, /payroll/garnishments?tab=remittances);
// old ?tab= links redirect there (legacyPayrollRoutes).
type Tab = 'newhire' | 'notices' | 'roth' | 'paystubs';
const TABS: Tab[] = ['newhire', 'notices', 'roth', 'paystubs'];

export function PayrollCompliance() {
  // ?tab= deep links from the Inbox (pay notices, new-hire reports).
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('tab') as Tab | null;
  const tab: Tab = fromUrl && TABS.includes(fromUrl) ? fromUrl : 'newhire';
  const setTab = (t: Tab) => setParams((p) => {
    const next = new URLSearchParams(p);
    next.set('tab', t);
    return next;
  }, { replace: true });
  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Payroll compliance"
        subtitle="New-hire reports, state pay notices and the 2026 retirement and paystub rules. Tax deposits are on Payroll taxes; garnishment payments on the garnishment desk."
        breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Compliance' }]}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="newhire">
            <UserPlus className="mr-2 h-4 w-4" /> New-hire reporting
          </TabsTrigger>
          <TabsTrigger value="notices">
            <FileSignature className="mr-2 h-4 w-4" /> Pay notices
          </TabsTrigger>
          <TabsTrigger value="roth">
            <PiggyBank className="mr-2 h-4 w-4" /> Roth catch-up
          </TabsTrigger>
          <TabsTrigger value="paystubs">
            <ScrollText className="mr-2 h-4 w-4" /> Paystub rules
          </TabsTrigger>
        </TabsList>
        <TabsContent value="newhire">
          <NewHireReportsTab />
        </TabsContent>
        <TabsContent value="notices">
          <PayNoticesTab />
        </TabsContent>
        <TabsContent value="roth">
          <RothCatchUpTab />
        </TabsContent>
        <TabsContent value="paystubs">
          <PaystubRulesTab />
        </TabsContent>
      </Tabs>
    </ListTemplate>
  );
}
