import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getMarketRates } from '@/lib/marketRatesApi';
import { fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { fmtExecExact, fmtExecMoney } from '@/lib/executiveFormat';
import { whatIfBaseline, whatIfLose, whatIfWin, type WhatIfLeagueRow, type WhatIfOutcome, type WhatIfRates } from '@/lib/execWhatIf';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';

/**
 * "What if we lose a client / win one", on the same numbers the scorecard
 * shows: margin, billing, hours, people and concentration move together.
 * The rate model beside it answers the price question; this one answers
 * the portfolio question. Money is rounded (the exact figure is the
 * tooltip's); only money is coloured — more margin is good news, less is
 * bad — hours and people are facts, in ink.
 */

type Mode = 'lose' | 'win';

function Delta({ label, value, money, unit, toned }: { label: string; value: number; money?: boolean; unit?: string; toned?: boolean }) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const shown = money ? fmtExecMoney(Math.abs(value)) : Math.round(Math.abs(value)).toLocaleString('en-US');
  const tone = !toned || Math.round(value) === 0 ? 'text-ink' : value > 0 ? 'text-positive-800' : 'text-negative-800';
  return (
    <div className="min-w-0">
      <dt className="text-xs2 text-ink-muted">{label}</dt>
      <dd className={cn('mt-0.5 text-lg font-medium tabular-nums', tone)} title={money ? fmtExecExact(value, 'money') : undefined}>
        {sign}
        {shown}
        {unit}
      </dd>
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
  const { t } = useI18n();
  const base = useMemo(() => whatIfBaseline(league, clients), [league, clients]);
  const [mode, setMode] = useState<Mode>('lose');
  const [clientId, setClientId] = useState<string>(base.clients[0]?.clientId ?? '');
  const [name, setName] = useState('');
  const [stores, setStores] = useState('3');
  const [hours, setHours] = useState('160');
  const [bill, setBill] = useState(rates.billRate.toFixed(2));
  const [pay, setPay] = useState(rates.payRate.toFixed(2));
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  // The local market, for a hypothetical pay rate: the typical metro median
  // across the roles the market rates desk benchmarks.
  const { can } = useAuth();
  const market = useQuery({ queryKey: ['market', 'rates', ''], queryFn: () => getMarketRates(), enabled: mode === 'win' && can('view:clients'), staleTime: 5 * 60_000 });
  const p = num(pay, rates.payRate);
  const marketLine = useMemo(() => {
    const medians = (market.data?.rows ?? []).map((r) => r.market?.median).filter((m): m is number => typeof m === 'number').sort((a, b) => a - b);
    if (medians.length === 0) return null;
    const mid = medians[Math.floor(medians.length / 2)]!;
    const diff = p - mid;
    if (Math.abs(diff) < 0.25) return t('execPortal.scen.marketAt', { median: fmtMoney(mid) });
    return t(diff > 0 ? 'execPortal.scen.marketAbove' : 'execPortal.scen.marketBelow', { median: fmtMoney(mid), diff: fmtMoney(Math.abs(diff)) });
  }, [market.data, p, t]);
  const outcome: WhatIfOutcome | null =
    mode === 'lose'
      ? clientId
        ? whatIfLose(base, clientId)
        : null
      : whatIfWin(base, rates, { name: name.trim() || t('execPortal.scen.newClient'), stores: num(stores, 0), hoursPerStoreWeek: num(hours, 0), billRate: num(bill, rates.billRate), payRate: p });

  const shareLine = (() => {
    if (!outcome || outcome.topSharePct === null) return null;
    const after = Math.round(outcome.topSharePct);
    const before = outcome.topShareBeforePct === null ? null : Math.round(outcome.topShareBeforePct);
    if (before === null || before === after) return t('execPortal.scen.shareSame', { pct: after });
    return t(after > before ? 'execPortal.scen.shareRise' : 'execPortal.scen.shareFall', { before, after });
  })();

  return (
    <Card className="min-w-0" data-testid="exec-whatif">
      <CardContent className="space-y-4 p-4 md:p-5">
        <SectionTitle
          wrap
          title={t('execPortal.scen.whatIfTitle')}
          description={t('execPortal.scen.whatIfBase', { billed: fmtExecMoney(base.weeklyBilled), margin: fmtExecMoney(base.weeklyMargin), count: base.clients.length })}
          trailing={
            <SegmentedControl<Mode>
              ariaLabel={t('execPortal.scen.modeAria')}
              options={[
                { value: 'lose', label: t('execPortal.scen.modeLose') },
                { value: 'win', label: t('execPortal.scen.modeWin') },
              ]}
              value={mode}
              onChange={setMode}
            />
          }
        />
        {mode === 'lose' ? (
          base.clients.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('execPortal.scen.loseNone')}</p>
          ) : (
            <Field label={t('execPortal.scen.client')} className="max-w-sm">
              {(f) => (
                <Select {...f} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                  {base.clients.map((c) => (
                    <option key={c.clientId} value={c.clientId}>
                      {t('execPortal.scen.clientOption', { name: c.clientName, billed: fmtExecMoney(c.weeklyBilled) })}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Field label={t('execPortal.scen.client')} className="col-span-2 sm:col-span-1">
              {(f) => <Input {...f} value={name} placeholder={t('execPortal.scen.newClient')} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label={t('execPortal.scen.stores')}>
              {(f) => <Input {...f} type="number" inputMode="numeric" min="0" value={stores} onChange={(e) => setStores(e.target.value)} className="tabular-nums" />}
            </Field>
            <Field label={t('execPortal.scen.hoursPerStore')}>
              {(f) => <Input {...f} type="number" inputMode="numeric" min="0" value={hours} onChange={(e) => setHours(e.target.value)} className="tabular-nums" />}
            </Field>
            <Field label={t('execPortal.scen.billRate')}>
              {(f) => <Input {...f} type="number" inputMode="decimal" min="0" step="0.25" value={bill} onChange={(e) => setBill(e.target.value)} className="tabular-nums" />}
            </Field>
            <Field label={t('execPortal.scen.payRate')}>
              {(f) => <Input {...f} type="number" inputMode="decimal" min="0" step="0.25" value={pay} onChange={(e) => setPay(e.target.value)} className="tabular-nums" />}
            </Field>
            {marketLine && (
              <p className="col-span-full text-xs2 text-ink-muted">
                {marketLine}{' '}
                <Link to="/market-rates" className="text-accent underline underline-offset-2">
                  {t('execPortal.scen.marketLink')}
                </Link>
              </p>
            )}
          </div>
        )}
        {outcome && (
          <div className="space-y-3 border-t border-line-subtle pt-4" aria-live="polite" data-testid="exec-whatif-outcome">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
              <Delta label={t('execPortal.scen.marginYear')} value={outcome.annualMargin} money toned />
              <Delta label={t('execPortal.scen.marginWeek')} value={outcome.weeklyMargin} money toned />
              <Delta label={t('execPortal.scen.billedWeek')} value={outcome.weeklyBilled} money toned />
              <Delta label={t('execPortal.scen.hoursWeek')} value={outcome.weeklyHours} unit="h" />
              <Delta label={mode === 'lose' ? t('execPortal.scen.peoplePlaced') : t('execPortal.scen.peopleNeeded')} value={outcome.headcount} />
            </dl>
            {shareLine && (
              <p className="text-sm text-ink">
                {shareLine}
                {outcome.topClientName && <span className="text-ink-muted"> {t('execPortal.scen.shareWho', { name: outcome.topClientName })}</span>}
              </p>
            )}
          </div>
        )}
        <p className="text-2xs text-ink-muted">
          {t('execPortal.scen.whatIfFoot')}{' '}
          <Link to="/executive/clients" className="text-accent underline underline-offset-2">
            {t('execPortal.scen.whatIfFootLink')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
