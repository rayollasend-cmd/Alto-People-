import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ListTemplate } from '@/components/templates';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { AddLocalRuleDialog, LocalTaxRulesSection } from '@/components/payroll/LocalTaxRulesSection';
import { useUrlParam } from '@/lib/useUrlState';
import { FederalTaxTables } from './PayrollConfigView';
import { StateTaxTables } from './StateTaxCoverage';
import { LocalTaxTables, ReciprocityTable } from './TaxJurisdictions';

/**
 * Tax tables — the one home for the tax reference payroll withholds by
 * (F500 G3). It lived in three places: "Payroll tax config" (/payroll/config,
 * no nav home), State tax coverage and Tax jurisdictions, with the
 * reciprocity table and the hand-set local rules form at the bottom of the
 * last. One page now, a tab each:
 *
 *   Federal         the year's wage limits and income tax brackets (read-only)
 *   State           where payroll can withhold, and the states waiting on a review
 *   Local           cities, counties, school and transit districts, and their reviews
 *   Hand-set rules  flat local rates set by hand, added in a dialog
 *   Reciprocity     which states' residents pay only their home state's tax
 *
 * The old addresses redirect here (legacyPayrollRoutes), keeping ?filter=.
 */

export type TaxTablesTab = 'federal' | 'state' | 'local' | 'rules' | 'reciprocity';
const TABS: readonly TaxTablesTab[] = ['federal', 'state', 'local', 'rules', 'reciprocity'];

export function TaxTablesPage() {
  const [tab, setTab] = useUrlParam<TaxTablesTab>('tab', 'federal', TABS, { history: 'push' });
  const [adding, setAdding] = useState(false);
  return (
    <ListTemplate
      title="Tax tables"
      subtitle="The federal, state and local taxes payroll withholds, and the ones waiting on a review with your tax adviser before it can."
      actions={tab === 'rules' ? [{ key: 'add-rule', label: 'Add local rule', icon: Plus, primary: true, onSelect: () => setAdding(true) }] : undefined}
      related={[
        { label: 'Payroll taxes', to: '/payroll/taxes' },
        { label: 'Year-end', to: '/payroll/year-end' },
      ]}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as TaxTablesTab)}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            <TabsTrigger value="federal">Federal</TabsTrigger>
            <TabsTrigger value="state">State</TabsTrigger>
            <TabsTrigger value="local">Local</TabsTrigger>
            <TabsTrigger value="rules">Hand-set rules</TabsTrigger>
            <TabsTrigger value="reciprocity">Reciprocity</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="federal">
          <FederalTaxTables />
        </TabsContent>
        <TabsContent value="state">
          <StateTaxTables />
        </TabsContent>
        <TabsContent value="local">
          <LocalTaxTables />
        </TabsContent>
        <TabsContent value="rules">
          <LocalTaxRulesSection onAdd={() => setAdding(true)} />
        </TabsContent>
        <TabsContent value="reciprocity">
          <ReciprocityTable />
        </TabsContent>
      </Tabs>
      <AddLocalRuleDialog open={adding} onOpenChange={setAdding} />
    </ListTemplate>
  );
}
