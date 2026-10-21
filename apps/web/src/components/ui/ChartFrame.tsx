import { useState, type ReactNode } from 'react';
import { BarChart3, Download, Table2, LineChart } from 'lucide-react';
import { downloadCsv } from '@/lib/csv';
import { ymdLocal } from '@/lib/format';
import { Button } from './Button';
import { Card, CardContent } from './Card';
import { EmptyState } from './EmptyState';
import { InChartFrame } from './charts/frame';
import { EXTENDED_SERIES, PALETTE, TOOLTIP_STYLE } from './charts/palette';
import { SectionTitle } from './SectionTitle';

/**
 * One frame for every chart: a title, a one-line summary a screen reader
 * hears in place of the picture, a Chart/Table switch, and CSV — with the
 * data table always in the page (visually hidden while the chart shows),
 * so nobody gets a picture without its numbers.
 */

export interface ChartColumn {
  key: string;
  label: string;
  /** Right-align and tabular figures. */
  numeric?: boolean;
  format?: (v: unknown) => string;
}

/**
 * Colors for hand-built recharts figures — the same tokens as the kit
 * (components/ui/charts/palette). `series` is the validated categorical
 * order; slots past the fifth are neutrals kept for older charts, not
 * new hues — fold a sixth series into "Other".
 */
export const CHART = {
  grid: PALETTE.grid,
  axis: PALETTE.axis,
  series: EXTENDED_SERIES,
  good: PALETTE.good,
  bad: PALETTE.bad,
  warn: PALETTE.warn,
  muted: PALETTE.muted,
  tooltip: TOOLTIP_STYLE,
} as const;

export function ChartFrame({
  title,
  description,
  summary,
  columns,
  rows,
  csvName,
  height = 260,
  children,
  empty,
}: {
  title: string;
  description?: ReactNode;
  /** What the chart says, in a sentence — read in place of the picture. */
  summary: string;
  columns: ChartColumn[];
  rows: Array<Record<string, unknown>>;
  csvName: string;
  height?: number;
  children: ReactNode;
  /** Shown instead of the chart when there is nothing to draw. Defaults to a quiet empty state. */
  empty?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const cell = (c: ChartColumn, v: unknown) => (c.format ? c.format(v) : v === null || v === undefined ? '—' : String(v));
  const table = (hidden: boolean) => (
    <div className={hidden ? 'sr-only' : 'overflow-x-auto'}>
      <table className="w-full text-sm">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-muted">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`px-2 py-1.5 font-medium ${c.numeric ? 'text-right' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 last:border-0">
              {columns.map((c) => (
                <td key={c.key} className={`px-2 py-1.5 text-ink ${c.numeric ? 'text-right tabular-nums' : ''}`}>
                  {cell(c, r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const hasData = rows.length > 0;

  return (
    <Card>
      <CardContent className="space-y-3 p-4 md:p-5">
        <SectionTitle
          title={title}
          description={description}
          trailing={
            hasData ? (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
                  {asTable ? <LineChart className="h-3.5 w-3.5" aria-hidden="true" /> : <Table2 className="h-3.5 w-3.5" aria-hidden="true" />}
                  {asTable ? 'Chart' : 'Table'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Download ${title} as CSV`}
                  onClick={() => downloadCsv(`${csvName}-${ymdLocal()}.csv`, [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => cell(c, r[c.key])))])}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  CSV
                </Button>
              </div>
            ) : undefined
          }
        />
        {!hasData ? (
          (empty ?? <EmptyState size="sm" icon={BarChart3} title="Nothing to chart yet" description="It fills in as the numbers come in." />)
        ) : asTable ? (
          table(false)
        ) : (
          <>
            <div role="img" aria-label={summary} style={{ height }}>
              <InChartFrame.Provider value={true}>{children}</InChartFrame.Provider>
            </div>
            {table(true)}
          </>
        )}
      </CardContent>
    </Card>
  );
}
