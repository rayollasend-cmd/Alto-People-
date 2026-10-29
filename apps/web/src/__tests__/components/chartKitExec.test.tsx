import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Funnel, FUNNEL_MIN_PCT, TrendLineChart, SparseReading, TREND_MIN_POINTS, funnelWidths, isSparseTrend, sparseSentence, trendReadings } from '@/components/ui/charts';

/**
 * The chart kit's 2026-10-27 pieces: the sparse rule (fewer than four
 * readings is a number and a sentence, never a near-empty axis) and the
 * Funnel (centred stage bars as long as each stage's value, the figures in
 * words beside them, an empty stage drawing nothing).
 */

describe('the sparse rule', () => {
  const series = [{ key: 'days', name: 'Days to collect' }];

  it('counts the rows that carry a reading in any series', () => {
    const data = [{ m: 'May', days: null }, { m: 'Jun', days: 31 }, { m: 'Jul', a: 1 }, { m: 'Aug', days: Number.NaN }];
    expect(trendReadings(data, series)).toBe(1);
    expect(trendReadings(data, [...series, { key: 'a' }])).toBe(2);
    expect(TREND_MIN_POINTS).toBe(4);
    expect(isSparseTrend(data, series)).toBe(true);
    expect(isSparseTrend([1, 2, 3, 4].map((d) => ({ days: d })), series)).toBe(false);
  });

  it('says how many readings there are, with the latest one named', () => {
    expect(sparseSentence(0, null)).toBe('No readings yet.');
    expect(sparseSentence(1, 'Oct 2026')).toBe('One reading so far (Oct 2026) — a trend needs 4.');
    expect(sparseSentence(3, 'Week of Oct 17, 2026')).toBe('3 readings so far, the latest (Week of Oct 17, 2026) — a trend needs 4.');
  });

  it('draws three readings as the latest value and a sentence, not an axis', () => {
    const data = [
      { m: 'Aug', days: 31 },
      { m: 'Sep', days: null },
      { m: 'Oct', days: 23 },
    ];
    render(<TrendLineChart data={data} x="m" series={series} format={(v) => `${v} days`} sparseNote="October is the first month with payments on record." height={200} />);
    const box = screen.getByTestId('trend-sparse');
    expect(box).toHaveTextContent('23 days');
    expect(box).toHaveTextContent('October is the first month with payments on record.');
    // One series: the value stands alone, no label over it.
    expect(box).not.toHaveTextContent('Days to collect');
    expect(document.querySelector('.recharts-wrapper')).toBeNull();
  });

  it('falls back to its own sentence and labels each series when there are two', () => {
    const data = [
      { w: '2026-10-10', billed: 21000, cost: 16500 },
      { w: '2026-10-17', billed: 22600, cost: 17900 },
    ];
    render(
      <TrendLineChart
        data={data}
        x="w"
        xDates="week"
        series={[
          { key: 'billed', name: 'Billed' },
          { key: 'cost', name: 'Cost' },
        ]}
        format={(v) => `$${(v / 1000).toFixed(1)}k`}
      />,
    );
    const box = screen.getByTestId('trend-sparse');
    expect(box).toHaveTextContent('Billed$22.6k');
    expect(box).toHaveTextContent('Cost$17.9k');
    expect(box).toHaveTextContent(/2 readings so far, the latest \(Week of Oct 17, 2026\) — a trend needs 4\./);
  });

  it('draws the line from four readings', () => {
    const data = [1, 2, 3, 4].map((v, i) => ({ m: `M${i}`, days: v }));
    render(<TrendLineChart data={data} x="m" series={series} height={200} />);
    expect(screen.queryByTestId('trend-sparse')).toBeNull();
  });

  it('SparseReading carries the exact figure in its title', () => {
    render(<SparseReading figures={[{ label: 'Total cost', value: '$35.5k', title: '$35,493.65' }]} note="The first run on record." />);
    expect(screen.getByText('$35.5k')).toHaveAttribute('title', '$35,493.65');
  });
});

describe('Funnel', () => {
  it('sizes each bar against the widest stage, never to nothing for a small one, and not at all for an empty one', () => {
    expect(funnelWidths([183040, 257920, 29250, 51584]).map((w) => Math.round(w * 10) / 10)).toEqual([71, 100, 11.3, 20]);
    expect(funnelWidths([1, 1000])[0]).toBe(FUNNEL_MIN_PCT);
    expect(funnelWidths([0, -5, Number.NaN, 10])).toEqual([0, 0, 0, 100]);
    expect(funnelWidths([0, 0])).toEqual([0, 0]);
  });

  it('prints every stage in words beside its centred bar, and an empty stage has no bar', () => {
    render(
      <Funnel
        stages={[
          { key: 'VERBAL', label: 'Verbal yes', value: 183040, detail: '1 prospect', figure: '$183k a year', figureDetail: '$4.40k a week · 80% close' },
          { key: 'PROPOSAL', label: 'Proposal', value: 257920, detail: '2 prospects', figure: '$258k a year', figureDetail: '$9.92k a week · 50% close' },
          { key: 'LEAD', label: 'Lead', value: 0, detail: 'No prospects', figure: '$0 a year' },
        ]}
      />,
    );
    const verbal = screen.getByTestId('funnel-stage-VERBAL');
    expect(verbal).toHaveTextContent('Verbal yes1 prospect');
    expect(verbal).toHaveTextContent('$183k a year$4.40k a week · 80% close');
    const bar = verbal.querySelector('[data-width]') as HTMLElement;
    expect(bar.dataset.width).toBe('71.0');
    // Centred: as much space on the left as on the right.
    expect(parseFloat(bar.style.left) * 2 + parseFloat(bar.style.width)).toBeCloseTo(100);
    expect(screen.getByTestId('funnel-stage-PROPOSAL').querySelector('[data-width]')).toHaveAttribute('data-width', '100.0');
    expect(screen.getByTestId('funnel-stage-LEAD').querySelector('[data-width]')).toBeNull();
  });
});
