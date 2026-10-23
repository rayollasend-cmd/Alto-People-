import { FileSpreadsheet } from 'lucide-react';
import { ListTemplate } from '@/components/templates';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { TaxYearSelect } from '@/components/ui/TaxYearSelect';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { useAuth } from '@/lib/auth';
import { urlNumber, useUrlParam, useUrlState } from '@/lib/useUrlState';
import { RejectedFormsCard } from '@/pages/payrollTaxes/ReturnsTab';
import { TaxFormsTab } from '@/pages/payrollTax/PayrollTaxHome';
import { YearEndTab as ContractorYearEnd } from '@/pages/contractors/ContractorPayments';
import { YearEndChecklist } from './PayrollYearEndClose';
import { YearEndReconcile, downloadReconWorkbook } from './YearEndReconciliation';

/**
 * Year-end — one home for closing a tax year (F500 G3). It lived in four
 * places: the year-end close checklist, the reconciliation, the "Year-end
 * forms" block at the bottom of Payroll taxes › Returns, and the
 * contractors' Year-end tab. Now one page, one tax-year picker:
 *
 *   Checklist   is the year wrapped up: every run paid, every form made, filed, sent
 *   Reconcile   paychecks, 941s, deposits and W-2s side by side before anything is filed
 *   Forms       W-2s, 1099s, the 941/940 builders, e-file and recipient copies, and the
 *               contractors' 1099 summary
 *
 * Old addresses redirect here (legacyPayrollRoutes): /payroll/year-end-close,
 * /payroll/year-end/reconciliation and /payroll/contractors?tab=year-end.
 */

export type YearEndTabKey = 'checklist' | 'reconcile' | 'forms';
const TABS: readonly YearEndTabKey[] = ['checklist', 'reconcile', 'forms'];

/** The tax year a year-end page opens on: last year (the one being closed). */
export const defaultTaxYear = (now: Date = new Date()) => now.getFullYear() - 1;

const YEAR_CODEC = urlNumber({ min: 2000, max: 2100, integer: true });

export function YearEndPage({ defaultTab = 'checklist' }: { defaultTab?: YearEndTabKey }) {
  const canManageForms = useAuth().can('process:payroll');
  const [tab, setTab] = useUrlParam<YearEndTabKey>('tab', defaultTab, TABS, { history: 'push' });
  const [year, setYear] = useUrlState<number>('year', defaultTaxYear(), YEAR_CODEC);

  return (
    <ListTemplate
      title="Year-end"
      subtitle={`Close ${year}: every run paid, W-2s and 1099s made, filed and sent, and every figure reconciled before anything is filed.`}
      actions={
        tab === 'reconcile'
          ? [{ key: 'excel', label: 'Download Excel', icon: FileSpreadsheet, onSelect: () => void downloadReconWorkbook(year) }]
          : undefined
      }
      related={[
        { label: 'Payroll taxes', to: '/payroll/taxes' },
        { label: 'Year-to-date', to: `/payroll/ytd?year=${year}` },
        { label: 'Contractors', to: '/payroll/contractors' },
      ]}
      filters={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-muted">Tax year</span>
          <TaxYearSelect value={year} onChange={setYear} since={2020} span={5} label="Tax year" />
        </div>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as YearEndTabKey)}>
        <TabsList>
          <TabsTrigger value="checklist">Checklist</TabsTrigger>
          <TabsTrigger value="reconcile">Reconcile</TabsTrigger>
          <TabsTrigger value="forms">Forms</TabsTrigger>
        </TabsList>
        <TabsContent value="checklist">
          <YearEndChecklist year={year} />
        </TabsContent>
        <TabsContent value="reconcile">
          <YearEndReconcile year={year} />
        </TabsContent>
        <TabsContent value="forms">
          <div className="space-y-6">
            {/* The Inbox's "Tax filings rejected" lands here: what the agency sent back, first. */}
            <RejectedFormsCard />
            <section aria-labelledby="year-end-forms" className="space-y-3">
              <SectionTitle id="year-end-forms" title="W-2s, 1099s and federal returns" description="Each person’s W-2 or 1099, the 941 and 940 builders, e-file and recipient copies." />
              <TaxFormsTab canManage={canManageForms} />
            </section>
            <section aria-labelledby="year-end-contractors" className="space-y-3">
              <SectionTitle id="year-end-contractors" title={`Contractors’ 1099s for ${year}`} />
              <ContractorYearEnd year={year} />
            </section>
          </div>
        </TabsContent>
      </Tabs>
    </ListTemplate>
  );
}

/** Old names, kept so a stale import still renders the right tab. */
export const PayrollYearEndClose = () => <YearEndPage defaultTab="checklist" />;
export const YearEndReconciliation = () => <YearEndPage defaultTab="reconcile" />;
