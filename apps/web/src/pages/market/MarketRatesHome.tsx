import { useSearchParams } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { useTerm } from '@/lib/auth';
import { useClients } from '@/lib/useClients';
import { marketBriefUrl } from '@/lib/marketRatesApi';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { useState } from 'react';
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
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'rates';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'rates') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };

  return (
    <ListTemplate
      title="Market rates"
      subtitle={`Every role at every ${term('label.store').toLowerCase()} against its local market — where pay sits, what fill looks like at each pay level, and the bill rate that keeps your margin.`}
      breadcrumbs={[{ label: 'Pay & finance' }, { label: 'Market rates' }]}
      secondaryActions={<BriefButton />}
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
    </ListTemplate>
  );
}

/** One client's rates against the market, as a PDF to take into a negotiation. */
function BriefButton() {
  const term = useTerm();
  const { clients } = useClients();
  const [clientId, setClientId] = useState('');
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="brief-client" className="sr-only">
        {term('label.client')} for the negotiation brief
      </label>
      <Select id="brief-client" size="sm" value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-44">
        <option value="">Brief for…</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      {clientId ? (
        <Button asChild variant="outline" size="sm">
          <a href={marketBriefUrl(clientId)} download>
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            Negotiation brief
          </a>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled title={`Pick a ${term('label.client').toLowerCase()} first`}>
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          Negotiation brief
        </Button>
      )}
    </div>
  );
}
