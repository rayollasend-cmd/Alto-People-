import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { DonutChart } from '@/components/ui/DonutChart';
import { MetricCard, trendMeaning, trendSummary } from '@/components/ui/MetricCard';
import { Heatmap, PALETTE, seriesColor, sparkDomain, waterfallRows } from '@/components/ui/charts';

describe('chart kit', () => {
  it('pads a near-flat series so it does not read as a cliff, and never dips below zero for counts', () => {
    const [lo, hi] = sparkDomain([100, 101, 100]);
    // At least ±10% of the middle: the 1-point wiggle stays small on the tile.
    expect(hi - lo).toBeGreaterThanOrEqual(20);
    expect(sparkDomain([0, 0, 1, 0])[0]).toBe(0);
    expect(sparkDomain([0, 0, 0])).toEqual([0, 0.55]);
  });

  it('assigns categories in the fixed order and folds past the fifth', () => {
    expect(seriesColor(0)).toBe(PALETTE.primary);
    expect(seriesColor(4)).toBe('rgb(var(--color-chart-5))');
    expect(seriesColor(5)).toBe(PALETTE.other);
  });

  it('floats each waterfall step from the running total and closes on the sum', () => {
    const rows = waterfallRows({ label: 'Gross', value: 1000 }, [{ label: 'Taxes', value: -200 }, { label: 'Reimbursed', value: 50 }], { label: 'Net' });
    expect(rows.map((r) => [r.label, r.range, r.kind])).toEqual([
      ['Gross', [0, 1000], 'total'],
      ['Taxes', [800, 1000], 'down'],
      ['Reimbursed', [800, 850], 'up'],
      ['Net', [0, 850], 'total'],
    ]);
  });

  it('colors a trend by which way is good and says it in words', () => {
    expect(trendMeaning(5, 'up')).toBe('good');
    expect(trendMeaning(5, 'down')).toBe('bad');
    expect(trendMeaning(5, 'neutral')).toBe('flat');
    expect(trendSummary({ series: [10, 12, 15], delta: 3, deltaLabel: 'vs last wk' }, 'down')).toBe('Over the last 3 weeks: from 10 to 15, up 3 vs last wk (worse).');

    render(<MetricCard label="Late arrivals" value="15" trend={{ series: [10, 12, 15], delta: 3, deltaLabel: 'vs last wk' }} trendGood="down" />);
    expect(screen.getByText(/\(worse\)/)).toBeInTheDocument();
    // The chip wears the alert tone; older callers' deltaPositiveIsGood still works.
    expect(screen.getByText('3').closest('span')?.className).toMatch(/text-alert/);
  });

  it('a chart with nothing to draw shows an empty state, not a blank card', () => {
    render(
      <ChartFrame title="Hours" summary="none" columns={[{ key: 'w', label: 'Week' }]} rows={[]} csvName="hours">
        <div />
      </ChartFrame>,
    );
    expect(screen.getByText('Nothing to chart yet')).toBeInTheDocument();
    render(<DonutChart data={[{ name: 'A', value: 0 }]} />);
    expect(screen.getByText('Nothing to break down yet')).toBeInTheDocument();
  });

  it('a heatmap is a real table with a label on every cell, and a tap reads the figure out', async () => {
    render(
      <Heatmap
        caption="Late arrivals by day and hour"
        rows={[{ key: 'mon', label: 'Mon' }]}
        columns={[{ key: '6', label: '6 AM' }, { key: '7', label: '7 AM' }]}
        values={[[2, null]]}
        tone="bad"
      />,
    );
    expect(screen.getByRole('table', { name: 'Late arrivals by day and hour' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '7 AM' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mon, 6 AM: 2' }));
    expect(screen.getAllByText('Mon, 6 AM: 2').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Mon, 7 AM: no data' })).toBeInTheDocument();
  });
});
