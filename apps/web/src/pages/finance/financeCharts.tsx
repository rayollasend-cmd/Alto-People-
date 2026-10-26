import { fmtDateTz, parseYmd } from '@/lib/format';
import { LegendKey, PALETTE } from '@/components/ui/charts';
import { lazyPlot } from '@/components/ui/charts/lazyPlot';
import type { CashWeek, MarginWeek } from './financeTypes';

/**
 * The finance pictures, on the shared chart kit's palette and tooltip:
 * cash in and out with the running total (the forecast page and the
 * cockpit card), revenue against wages with the margin on top, and the
 * receivables split by age. Each fills the box it's given.
 *
 * The drawings (recharts) load with the first picture, not the page
 * (lazyPlot); each box keeps its size while they land.
 */

const CashFlowPlot = lazyPlot(() => import('./financeCharts.plot').then((m) => ({ default: m.CashFlowPlot })));
const MarginPlot = lazyPlot(() => import('./financeCharts.plot').then((m) => ({ default: m.MarginPlot })));
const AgingPlot = lazyPlot(() => import('./financeCharts.plot').then((m) => ({ default: m.AgingPlot })));

const shortDay = (ymd: string) => fmtDateTz(parseYmd(ymd) ?? ymd);

/* ---- Cash: in above the line, out below, running total over both ------- */

// Money out in the second series token (it was chart-5's magenta, which read as an alert pink).
export const CASH_COLORS = { in: PALETTE.tertiary, out: PALETTE.secondary, run: PALETTE.primary } as const;

const CASH_SERIES = {
  inflow: { name: 'Money in', color: CASH_COLORS.in },
  outflowNeg: { name: 'Money out', color: CASH_COLORS.out },
  cumulative: { name: 'Running total', color: CASH_COLORS.run },
};

export type CashRow = ReturnType<typeof cashRows>[number];

export function cashRows(weeks: CashWeek[]) {
  return weeks.map((w) => ({ week: shortDay(w.weekStart), weekStart: w.weekStart, inflow: w.inflow, outflowNeg: -w.outflow, outflow: w.outflow, net: w.net, cumulative: w.cumulative, balance: w.balance ?? w.cumulative }));
}

/**
 * Money in above the line, out below, and one line over both: the cash
 * BALANCE when the books hold one (opening + movement), else the running
 * total of movement. With a floor set, the band under it is shaded; the
 * lowest week is marked.
 */
export function CashFlowChart({
  weeks,
  compact = false,
  withBalance = false,
  line = true,
  minimumCash = null,
}: {
  weeks: CashWeek[];
  compact?: boolean;
  withBalance?: boolean;
  /** Draw the line over the bars. Off where no bank balance is on file: a running total from $0 dipping to −$15.9k read as an overdraft. */
  line?: boolean;
  minimumCash?: number | null;
}) {
  const rows = cashRows(weeks);
  const lineKey = withBalance ? 'balance' : 'cumulative';
  const lineName = withBalance ? 'Cash balance' : 'Running total';
  const low = line && rows.length ? rows.reduce((m, r) => (r[lineKey] < m[lineKey] ? r : m), rows[0]!) : null;
  const series = { ...CASH_SERIES, [lineKey]: { name: lineName, color: CASH_COLORS.run } };
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <CashFlowPlot rows={rows} compact={compact} lineKey={line ? lineKey : null} low={low} series={series} colors={CASH_COLORS} minimumCash={minimumCash} />
      </div>
      <div className="mt-1">
        <LegendKey
          items={[
            { name: 'Money in', color: CASH_COLORS.in },
            { name: 'Money out', color: CASH_COLORS.out },
            ...(line ? [{ name: lineName, color: CASH_COLORS.run, line: true }] : []),
            ...(low && !compact ? [{ name: 'Low point', color: PALETTE.bad }] : []),
            ...(minimumCash !== null && minimumCash > 0 ? [{ name: 'Under the cash floor', color: PALETTE.warn }] : []),
          ]}
        />
      </div>
    </div>
  );
}

/* ---- Revenue and wages, week by week, the margin printed on top -------- */

const MARGIN_SERIES = {
  revenue: { name: 'Revenue', color: PALETTE.primary },
  wages: { name: 'Wages', color: PALETTE.other },
};

export interface MarginRow {
  week: string;
  revenue: number;
  wages: number;
  pct: string;
  marginPct: number | null;
  inProgress: boolean;
}

export function MarginChart({ weeks, words }: { weeks: MarginWeek[]; words: { revenue: string; wages: string; soFar: string } }) {
  const rows: MarginRow[] = weeks.map((w) => ({
    week: w.inProgress ? words.soFar : shortDay(w.weekEnd),
    revenue: w.revenue,
    wages: w.wages,
    pct: w.marginPct === null ? '—' : `${Math.round(w.marginPct * 100)}%`,
    marginPct: w.marginPct,
    inProgress: w.inProgress,
  }));
  const series = { revenue: { ...MARGIN_SERIES.revenue, name: words.revenue }, wages: { ...MARGIN_SERIES.wages, name: words.wages } };
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <MarginPlot rows={rows} series={series} />
      </div>
      <div className="mt-1">
        <LegendKey items={[{ name: words.revenue, color: series.revenue.color }, { name: words.wages, color: series.wages.color }]} />
      </div>
    </div>
  );
}

/* ---- Receivables by age: one bar, not yet due to 90+ ------------------- */

/**
 * The one aging definition's buckets (days past due): not yet due in the
 * positive colour, then ONE alert hue that deepens with age. Mixing the
 * caution and alert tokens flipped meaning between themes — 31–60 days read
 * amber on navy but rust (darker than 61–90) on white (F500 audit 2026-10-26).
 */
export const AGING_COLORS = {
  current: PALETTE.good,
  days1to30: 'rgb(var(--color-alert) / 0.3)',
  days31to60: 'rgb(var(--color-alert) / 0.55)',
  days61to90: 'rgb(var(--color-alert) / 0.8)',
  over90: PALETTE.bad,
} as const;

export interface AgingBucket {
  key: keyof typeof AGING_COLORS;
  label: string;
  amount: number;
}

export function AgingBar({ buckets }: { buckets: AgingBucket[] }) {
  const row = Object.fromEntries(buckets.map((b) => [b.key, b.amount]));
  const shown = buckets.filter((b) => b.amount > 0);
  // A picture of the numbers printed beside it — its callers hide it
  // (aria-hidden) or label it (role="img"), so recharts' keyboard layer
  // (a tab stop on the svg) is off: a focusable inside aria-hidden is a
  // serious axe finding (finance home, 2026-10-23).
  return (
    <div className="h-3 w-full">
      <AgingPlot row={row} buckets={buckets} shown={shown} colors={AGING_COLORS} />
    </div>
  );
}
