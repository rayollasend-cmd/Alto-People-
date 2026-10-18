import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getMarketRates } from '@/lib/marketRatesApi';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { whatIfBaseline, whatIfLose, whatIfWin, type WhatIfLeagueRow, type WhatIfOutcome, type WhatIfRates } from '@/lib/execWhatIf';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';

/**
 * "What if we lose this client / win this one", on the executive's hero
 * numbers: margin, hours, headcount and concentration move together. The
 * rate negotiation model beside it answers the price question; this one
 * answers the portfolio question.
 */

type Mode = 'lose' | 'win';

function Delta({ label, value, money, suffix, good }: { label: string; value: number; money?: boolean; suffix?: string; good?: boolean }) {
  const up = value > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const isGood = good ?? up;
  return (
    <div className="min-w-[7rem]">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={cn('mt-0.5 inline-flex items-center gap-1 text-lg font-semibold tabular-nums', value === 0 ? 'text-ink' : isGood ? 'text-success' : 'text-alert')}>
        {value !== 0 && <Icon className="h-4 w-4" aria-hidden="true" />}
        {value > 0 ? '+' : value < 0 ? '−' : ''}
        {money ? fmtMoney(Math.abs(value)) : Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}
        {suffix}
      </div>
    </div>
  );
}

export function WhatIfClientCard({
  league,
  clients,
  rates,
}: {
  league: WhatIfLeagueRow[];
  clients: Array<{ clientId: string; clientName: string; activeAssociates: number }>;
  rates: WhatIfRates;
}) {
  const base = useMemo(() => whatIfBaseline(league, clients), [league, clients]);
  const [mode, setMode] = useState<Mode>('lose');
  const [clientId, setClientId] = useState<string>(base.clients[0]?.clientId ?? '');
  const [name, setName] = useState('');
  const [stores, setStores] = useState('3');
  const [hours, setHours] = useState('160');
  const [bill, setBill] = useState(String(rates.billRate));
  const [pay, setPay] = useState(String(rates.payRate));
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  // The local market, for a hypothetical pay rate: the typical metro median
  // across the roles you benchmark (the market rates desk).
  const { can } = useAuth();
  const market = useQuery({ queryKey: ['market', 'rates', ''], queryFn: () => getMarketRates(), enabled: mode === 'win' && can('view:clients'), staleTime: 5 * 60_000 });
  const marketLine = useMemo(() => {
    const medians = (market.data?.rows ?? []).map((r) => r.market?.median).filter((m): m is number => typeof m === 'number').sort((a, b) => a - b);
    if (medians.length === 0) return null;
    const mid = medians[Math.floor(medians.length / 2)]!;
    const p = num(pay, rates.payRate);
    const diff = p - mid;
    return `Typical market median across your metros: ${fmtMoney(mid)}/h — ${Math.abs(diff) < 0.25 ? 'this pay sits right at it' : `this pay is ${fmtMoney(Math.abs(diff))} ${diff > 0 ? 'above' : 'below'} it`}.`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.data, pay]);
  const outcome: WhatIfOutcome | null =
    mode === 'lose'
      ? clientId
        ? whatIfLose(base, clientId)
        : null
      : whatIfWin(base, rates, { name, stores: num(stores, 0), hoursPerStoreWeek: num(hours, 0), billRate: num(bill, rates.billRate), payRate: num(pay, rates.payRate) });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">What if we lose this client / win this one</CardTitle>
          <SegmentedControl<Mode>
            ariaLabel="Scenario"
            options={[
              { value: 'lose', label: 'Lose one' },
              { value: 'win', label: 'Win one' },
            ]}
            value={mode}
            onChange={setMode}
          />
        </div>
        <p className="text-xs text-ink-muted">
          On the last four weeks: {fmtMoney(base.weeklyBilled)} billed and {fmtMoney(base.weeklyMargin)} margin a week across {base.clients.length} client{base.clients.length === 1 ? '' : 's'}.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {mode === 'lose' ? (
          base.clients.length === 0 ? (
            <p className="text-sm text-ink-muted">Worked time against a client over the last four weeks puts it in this picker.</p>
          ) : (
            <label className="block text-xs text-ink-muted">
              Client
              <Select size="sm" className="mt-1 max-w-xs" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                {base.clients.map((c) => (
                  <option key={c.clientId} value={c.clientId}>
                    {c.clientName} · {fmtMoney(c.weeklyBilled)}/wk
                  </option>
                ))}
              </Select>
            </label>
          )
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-muted">
              Client
              <Input size="sm" className="mt-1 w-36" value={name} placeholder="New client" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="text-xs text-ink-muted">
              Stores
              <Input size="sm" type="number" min="0" className="mt-1 w-20 tabular-nums" value={stores} onChange={(e) => setStores(e.target.value)} />
            </label>
            <label className="text-xs text-ink-muted">
              Hours / store / week
              <Input size="sm" type="number" min="0" className="mt-1 w-24 tabular-nums" value={hours} onChange={(e) => setHours(e.target.value)} />
            </label>
            <label className="text-xs text-ink-muted">
              Bill rate ($/h)
              <Input size="sm" type="number" min="0" step="0.25" className="mt-1 w-24 tabular-nums" value={bill} onChange={(e) => setBill(e.target.value)} />
            </label>
            <label className="text-xs text-ink-muted">
              Pay rate ($/h)
              <Input size="sm" type="number" min="0" step="0.25" className="mt-1 w-24 tabular-nums" value={pay} onChange={(e) => setPay(e.target.value)} />
            </label>
            {marketLine && (
              <p className="w-full text-xs text-ink-muted">
                {marketLine}{' '}
                <Link to="/market-rates" className="text-accent hover:underline">
                  Market rates
                </Link>
              </p>
            )}
          </div>
        )}
        {outcome && (
          <div className="flex flex-wrap gap-x-6 gap-y-3" aria-live="polite">
            <Delta label="Margin / week" value={Math.round(outcome.weeklyMargin)} money />
            <Delta label="Margin / year" value={Math.round(outcome.annualMargin)} money />
            <Delta label="Billed / week" value={Math.round(outcome.weeklyBilled)} money />
            <Delta label="Hours / week" value={Math.round(outcome.weeklyHours)} suffix="h" />
            <Delta label="People" value={outcome.headcount} good={mode === 'win'} />
            <div className="min-w-[9rem]">
              <div className="text-xs text-ink-muted">Largest client&rsquo;s share</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-ink">
                {outcome.topSharePct === null ? '—' : `${outcome.topSharePct.toFixed(0)}%`}
                {outcome.topShareBeforePct !== null && outcome.topSharePct !== null && outcome.topShareBeforePct !== outcome.topSharePct && (
                  <span className="ml-1 text-xs font-normal text-ink-muted">from {outcome.topShareBeforePct.toFixed(0)}%</span>
                )}
              </div>
              {outcome.topClientName && <div className="truncate text-2xs text-ink-muted">{outcome.topClientName}</div>}
            </div>
          </div>
        )}
        <p className="text-2xs text-ink-muted">
          Estimates at standard rates and burden, like the hero. Statements are the invoice-grade truth —{' '}
          <Link to="/clients" className="text-accent hover:underline">
            the pipeline lives on Clients
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
