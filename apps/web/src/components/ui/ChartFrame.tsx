import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BarChart3, Download, Table2, LineChart } from 'lucide-react';
import { downloadCsv } from '@/lib/csv';
import { ymdLocal } from '@/lib/format';
import { Button } from './Button';
import { Card, CardContent } from './Card';
import { EmptyState } from './EmptyState';
import { InChartFrame } from './charts/frame';
import { EXTENDED_SERIES, PALETTE, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from './charts/palette';
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
  other: PALETTE.other,
  tooltip: TOOLTIP_STYLE,
  /** Pass as `labelStyle` / `itemStyle` on a stock recharts Tooltip — rows
   *  read in the text color, never the series color. */
  tooltipLabel: TOOLTIP_LABEL_STYLE,
  tooltipItem: TOOLTIP_ITEM_STYLE,
} as const;

/**
 * Inside a frame the summary and the table carry the chart for assistive
 * tech, so recharts' own keyboard layer (an `svg role="application"` tab
 * stop that announces nothing useful) is switched off — including in
 * hand-built charts that don't pass `accessibilityLayer={false}`.
 */
function quietRecharts(el: HTMLElement) {
  el.querySelectorAll('svg.recharts-surface').forEach((svg) => {
    if (svg.getAttribute('tabindex') !== '-1') svg.setAttribute('tabindex', '-1');
    if (svg.getAttribute('role') === 'application') svg.removeAttribute('role');
  });
}

const CONTROLS = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
  interactive,
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
  /** The figure holds controls (a heatmap's cells, buttons): it is not
   *  wrapped as one image, so they stay reachable. Detected when omitted. */
  interactive?: boolean;
}) {
  const [asTable, setAsTable] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const [hasControls, setHasControls] = useState(false);
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

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const sync = () => {
      quietRecharts(el);
      setHasControls(el.querySelector(CONTROLS) !== null);
    };
    sync();
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(sync);
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['tabindex', 'role'] });
    return () => mo.disconnect();
  }, [asTable, hasData]);
  const asImage = !(interactive ?? hasControls);

  return (
    <Card>
      <CardContent className="space-y-3 p-4 md:p-5">
        <SectionTitle
          title={title}
          description={description}
          trailing={
            hasData ? (
              <div className="flex items-center gap-1">
                {/* The label names the view it switches to; no aria-pressed on top of a changing label. */}
                <Button size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)}>
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
            {!asImage && <p className="sr-only">{summary}</p>}
            <div ref={plotRef} {...(asImage ? { role: 'img', 'aria-label': summary } : {})} style={{ height }}>
              <InChartFrame.Provider value={true}>{children}</InChartFrame.Provider>
            </div>
            {table(true)}
          </>
        )}
      </CardContent>
    </Card>
  );
}
