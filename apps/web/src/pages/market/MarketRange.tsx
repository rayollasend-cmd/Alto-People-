import { cn } from '@/lib/cn';
import type { MarketFigures } from '@/lib/marketRatesApi';

/**
 * Where a pay rate sits in its metro: a line from the 10th to the 90th
 * percentile, the middle half (25th–75th) shaded, a tick at the median and
 * a dot for what we pay. Screen readers get the same as one sentence.
 */

export const money = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `$${x.toFixed(2)}`);

export const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

export function MarketRange({ market, pay, percentile, className }: { market: MarketFigures; pay: number; percentile: number | null; className?: string }) {
  const lo = market.p10 ?? market.p25 ?? market.median;
  const hi = market.p90 ?? market.p75 ?? market.median;
  if (lo === null || hi === null || market.median === null) return <span className="text-xs text-ink-muted">Not enough published figures</span>;
  // Pad the scale so a dot just outside the 10th–90th still shows on the line.
  const min = Math.min(lo, pay) * 0.97;
  const max = Math.max(hi, pay) * 1.03;
  const at = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  const label = `${market.areaName}: 10th percentile ${money(market.p10)}, median ${money(market.median)}, 90th ${money(market.p90)}. You pay ${money(pay)}${percentile !== null ? `, about the ${ordinal(percentile)} percentile` : ''}.`;
  const below = pay < market.median;
  return (
    <div className={cn('w-full min-w-[9rem]', className)} role="img" aria-label={label}>
      <div className="relative h-4">
        <div className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-line" aria-hidden="true" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-line" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} aria-hidden="true" />
        {market.p25 !== null && market.p75 !== null && (
          <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-accent/30" style={{ left: at(market.p25), width: `calc(${at(market.p75)} - ${at(market.p25)})` }} aria-hidden="true" />
        )}
        <div className="absolute top-0 h-4 w-0.5 -translate-x-1/2 rounded bg-accent" style={{ left: at(market.median) }} aria-hidden="true" />
        <div
          className={cn('absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface', below ? 'bg-warning' : 'bg-success')}
          style={{ left: at(pay) }}
          aria-hidden="true"
        />
      </div>
      <div className="mt-0.5 flex justify-between text-2xs tabular-nums text-ink-muted" aria-hidden="true">
        <span>{money(lo)}</span>
        <span>median {money(market.median)}</span>
        <span>{money(hi)}</span>
      </div>
    </div>
  );
}
