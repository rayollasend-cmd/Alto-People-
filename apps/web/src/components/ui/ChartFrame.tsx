import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BarChart3, Download, Table2, LineChart } from '@/components/ui/icons';
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
  /** What the CSV carries for this column, when it isn't the raw value. */
  csv?: (v: unknown) => string | number | null;
}

/**
 * One CSV cell for a chart column (audit 2026-10-29 MONEY-29): the raw
 * number, never the display string — "$29,885.44" and "—" are text to a
 * spreadsheet, and the same figure came out as a number from a grid's CSV.
 * A missing value is an empty cell. Text columns keep their formatter (a
 * month key reads "Oct 2026" in the file as on screen).
 */
export function chartCsvCell(c: ChartColumn, v: unknown): string | number | null {
  if (c.csv) return c.csv(v);
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (c.numeric) return String(v);
  return c.format ? c.format(v) : String(v);
}

/** The chart's CSV: a header row, then each row's raw values. */
export function chartCsvRows(columns: ChartColumn[], rows: Array<Record<string, unknown>>): Array<Array<string | number | null>> {
  return [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => chartCsvCell(c, r[c.key])))];
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

/** The measures a frame's rows carry: its numeric columns, or (none marked) every number in the rows. */
function measureKeys(columns: ChartColumn[], rows: Array<Record<string, unknown>>): string[] {
  const marked = columns.filter((c) => c.numeric).map((c) => c.key);
  if (marked.length > 0) return marked;
  const keys = new Set<string>();
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (typeof v === 'number') keys.add(k);
  return [...keys];
}

/** Every measure is zero or missing: there is nothing to draw. */
export function nothingButZeros(columns: ChartColumn[], rows: Array<Record<string, unknown>>): boolean {
  const keys = measureKeys(columns, rows);
  if (keys.length === 0) return false;
  for (const r of rows) {
    for (const k of keys) {
      const v = r[k];
      if (v === null || v === undefined || v === '') continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n !== 0) return false;
    }
  }
  return true;
}

/** A column formatted as a percent: a rate, where zero is a reading, not an absence. */
function hasRateColumn(columns: ChartColumn[]): boolean {
  return columns.some((c) => {
    if (!c.numeric || !c.format) return false;
    try {
      return c.format(0).includes('%');
    } catch {
      return false;
    }
  });
}

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
  zerosMeaningful,
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
  /**
   * Whether a chart whose every value is zero still draws. By default it
   * doesn't: six $0 months are "nothing to chart yet", not a 320px card of
   * flat axis (Books' profit, P&L by month's $0–$4 axis). A RATE at zero is
   * a real reading (0% delivered is the news), so a chart with a column
   * formatted as a percent keeps drawing on its own; pass `true` for any
   * other measure where zero is the answer, `false` to collapse anyway.
   */
  zerosMeaningful?: boolean;
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
  const hasData = rows.length > 0 && !(nothingButZeros(columns, rows) && !(zerosMeaningful ?? hasRateColumn(columns)));

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
    // min-w-0: a chart card is usually a grid item, and a grid item's
    // min-content width (an SVG, a long title) pushed the page past 390px.
    <Card className="min-w-0">
      <CardContent className="space-y-3 p-4 md:p-5">
        <SectionTitle
          wrap
          title={title}
          description={description}
          trailing={
            hasData ? (
              <div className="flex items-center gap-1">
                {/* The label names the view it switches to; no aria-pressed on top of a changing label. */}
                {/* Icon-only below sm (the names stay as aria-labels), so a phone's title keeps its width. */}
                <Button size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)} aria-label={asTable ? 'Chart' : 'Table'}>
                  {asTable ? <LineChart className="h-3.5 w-3.5" aria-hidden="true" /> : <Table2 className="h-3.5 w-3.5" aria-hidden="true" />}
                  <span className="hidden sm:inline">{asTable ? 'Chart' : 'Table'}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Download ${title} as CSV`}
                  onClick={() => downloadCsv(`${csvName}-${ymdLocal()}.csv`, chartCsvRows(columns, rows))}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">CSV</span>
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
