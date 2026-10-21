import { cn } from '@/lib/cn';

/**
 * The tooltip and legend every chart shares: a readout keyed by a short
 * line in the series color, values in text tokens (never the series
 * color), and a legend for two or more series. DetailsTable is the
 * table twin behind "Details" for charts that sit outside a ChartFrame.
 */

interface TipRow {
  dataKey?: string | number;
  value?: number | string;
  color?: string;
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  series,
  heading,
  format,
}: {
  active?: boolean;
  payload?: TipRow[];
  label?: string | number;
  /** dataKey → { name, color } so the readout keys each row by a line key. */
  series: Record<string, { name: string; color: string }>;
  heading?: (label: string) => string;
  format?: (v: number, key: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => p.dataKey !== undefined && series[String(p.dataKey)]);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-md border border-navy-secondary bg-navy px-3 py-2 elev-2 text-xs">
      <div className="mb-1 text-silver/80">{heading ? heading(String(label)) : String(label)}</div>
      {rows.map((p) => {
        const key = String(p.dataKey);
        const s = series[key]!;
        const v = Number(p.value ?? 0);
        return (
          <div key={key} className="flex items-center gap-2 py-0.5">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3.5 rounded-full"
              style={{ background: s.color }}
            />
            <span className="font-semibold tabular-nums text-white">
              {format ? format(v, key) : v.toLocaleString()}
            </span>
            <span className="text-silver/80">{s.name}</span>
          </div>
        );
      })}
    </div>
  );
}

export function LegendKey({ items }: { items: Array<{ name: string; color: string; line?: boolean }> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-silver/80">
      {items.map((i) => (
        <li key={i.name} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn('inline-block', i.line ? 'h-0.5 w-3.5 rounded-full' : 'h-2.5 w-2.5 rounded-sm')}
            style={{ background: i.color }}
          />
          {i.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * Props for a stock recharts <Legend> where a figure still uses one: the
 * key reads in the muted text token (recharts colors legend text in the
 * series color, which fails contrast for gold and the neutrals), square
 * swatches, the kit's size. Prefer LegendKey under the chart for new work.
 */
export const STOCK_LEGEND = {
  wrapperStyle: { fontSize: 12 },
  iconType: 'square' as const,
  iconSize: 10,
  formatter: (value: unknown) => <span style={{ color: 'rgb(var(--color-silver))' }}>{String(value)}</span>,
};

/** The portal's original name for the tooltip readout. */
export const PortalTooltip = ChartTooltipContent;

/* ---- Details table (the chart's table twin) ---------------------------- */

export function DetailsTable({
  label,
  columns,
  rows,
}: {
  label: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <details className="group mt-2 print:hidden">
      <summary className="inline-flex min-h-8 cursor-pointer select-none items-center text-2xs uppercase tracking-wider text-silver/60 hover:text-silver coarse:min-h-11">
        {label}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-2xs uppercase tracking-wider text-silver/60">
              {columns.map((c) => (
                <th key={c} className="py-1 pr-3 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-secondary/60">
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td
                    key={j}
                    className={cn('py-1 pr-3', j === 0 ? 'text-silver' : 'tabular-nums text-white')}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
