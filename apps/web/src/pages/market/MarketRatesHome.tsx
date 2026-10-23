import { useState } from 'react';
import { FileText } from 'lucide-react';
import { useTerm } from '@/lib/auth';
import { useClients } from '@/lib/useClients';
import { useStoreScope } from '@/lib/storeScope';
import { useUrlParam } from '@/lib/useUrlState';
import { marketBriefUrl } from '@/lib/marketRatesApi';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { MarketRatesTab } from './MarketRatesTab';
import { MarketMappingTab } from './MarketMappingTab';
import { MarketDataTab } from './MarketDataTab';

/**
 * Market rates: pay against the local market, and the bill rate that
 * keeps the margin. Three tabs — the rates themselves, the mapping that
 * benchmarks them (store → metro, role → occupation), and where the wage
 * figures come from. The negotiation brief is one client's rates as a PDF.
 */

type Tab = 'rates' | 'mapping' | 'data';
const TABS: Tab[] = ['rates', 'mapping', 'data'];

export function MarketRatesHome() {
  const term = useTerm();
  const [tab, setTab] = useUrlParam<Tab>('tab', 'rates', TABS, { history: 'push' });
  const [briefOpen, setBriefOpen] = useState(false);

  return (
    <ListTemplate
      title="Market rates"
      subtitle={`Every role at every ${term('label.store').toLowerCase()} against its local market — where pay sits, what fill looks like at each pay level, and the bill rate that keeps your margin.`}
      actions={[{ label: 'Negotiation brief…', icon: FileText, onSelect: () => setBriefOpen(true) }]}
    >
      <div className="space-y-5">
        <SegmentedControl
          ariaLabel="Market rates view"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'rates', label: 'Rates' },
            { value: 'mapping', label: 'Mapping' },
            { value: 'data', label: 'Wage data' },
          ]}
        />
        {tab === 'rates' ? <MarketRatesTab onOpenMapping={() => setTab('mapping')} /> : tab === 'mapping' ? <MarketMappingTab /> : <MarketDataTab />}
      </div>
      {briefOpen && <BriefDialog onClose={() => setBriefOpen(false)} />}
    </ListTemplate>
  );
}

/**
 * One client's rates against the market, as a PDF to take into a
 * negotiation. One button in the header opens this; the client starts as
 * the top bar's, when it names one.
 */
function BriefDialog({ onClose }: { onClose: () => void }) {
  const term = useTerm();
  const { clients } = useClients();
  const scope = useStoreScope();
  const [clientId, setClientId] = useState(scope.clientId);
  const client = clients.find((c) => c.id === clientId);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Negotiation brief</DialogTitle>
          <DialogDescription>One {term('label.client').toLowerCase()}’s pay and bill rates against the local market, as a PDF.</DialogDescription>
        </DialogHeader>
        <Field label={term('label.client')}>
          {(p) => (
            <Select {...p} value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Pick a {term('label.client').toLowerCase()}…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {client ? (
            <Button asChild>
              <a href={marketBriefUrl(client.id)} download onClick={onClose}>
                <FileText className="h-4 w-4" aria-hidden="true" />
                Download {client.name}’s brief
              </a>
            </Button>
          ) : (
            <Button disabled>Download the brief</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
