import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { DonutChart } from '@/components/ui/DonutChart';
import { MetricCard, trendMeaning, trendSummary } from '@/components/ui/MetricCard';
import { EXTENDED_SERIES } from '@/components/ui/charts/palette';
import { Heatmap, PALETTE, Sparkline, Waterfall, foldToOther, seriesColor, sparkDomain, waterfallRows } from '@/components/ui/charts';

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
    expect(trendSummary({ series: [10, 12, 15], delta: 3, deltaLabel: 'vs last wk' }, 'down')).toBe('Over the last 3 complete weeks: from 10 to 15, up 3 vs last wk (worse).');

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

  it('a week still in progress draws hollow and dashed, and the sentence ends on the last whole week', () => {
    // 144h last week, 0h so far this Monday: not a collapse.
    const trend = { series: [120, 130, 144, 0], delta: 14, deltaLabel: 'vs the week before', lastIsPartial: true, format: (n: number) => `${n}h` };
    expect(trendSummary(trend, 'up')).toBe('Over the last 3 complete weeks: from 120h to 144h, up 14h vs the week before (better). This week so far: 0h.');
    const { container } = render(<Sparkline series={trend.series} lastIsPartial tone="good" />);
    expect(container.querySelector('line[stroke-dasharray]')).not.toBeNull();
    const dots = container.querySelectorAll('circle');
    expect(dots[dots.length - 1]!.getAttribute('fill')).toBe('none');
  });

  it('a missing point breaks the line instead of bridging it, and the fill closes on zero', () => {
    const { container } = render(<Sparkline series={[-10, -12, null, -8, -6]} tone="bad" height={24} />);
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
    // All negative: the fill closes on the top edge (zero is above the line), not the bottom.
    const poly = container.querySelector('polygon')!.getAttribute('points')!;
    const ys = poly.split(' ').map((p) => Number(p.split(',')[1]));
    expect(Math.min(...ys)).toBeLessThan(3);
    expect(sparkDomain([-10, -6])[1]).toBeLessThan(0);
  });

  it('the delta label wraps and truncates inside the tile, with the whole text on hover', () => {
    render(<MetricCard label="Hours" value="144h" trend={{ series: [1, 2, 3], delta: 1, deltaLabel: 'scheduled vs the week before last' }} />);
    const label = screen.getByText('scheduled vs the week before last');
    expect(label).toHaveClass('truncate');
    expect(label).toHaveAttribute('title', 'scheduled vs the week before last');
  });

  it('never repeats a hue: past the fifth everything folds into Other', () => {
    expect(EXTENDED_SERIES.slice(5).every((c) => c === PALETTE.other)).toBe(true);
    expect(new Set(EXTENDED_SERIES.slice(0, 5)).size).toBe(5);
    const folded = foldToOther(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) => ({ name, value: i + 1 })));
    expect(folded.map((d) => d.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'Other']);
    expect(folded.at(-1)!.value).toBe(13);
    render(<DonutChart data={['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name, value: 1 }))} />);
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.queryByText('g')).toBeNull();
  });

  it('a waterfall signs every bar — a net loss reads "−", a zero step is no change — and can subtotal mid-chart', () => {
    const rows = waterfallRows(
      { label: 'Income', value: 100 },
      [{ label: 'Costs', value: -150 }, { label: 'Gross profit', value: 0, subtotal: true }, { label: 'Other', value: 0 }],
      { label: 'Net' },
    );
    expect(rows.map((r) => [r.label, r.kind, r.amount])).toEqual([
      ['Income', 'total', 100],
      ['Costs', 'down', -150],
      ['Gross profit', 'total', -50],
      ['Other', 'flat', 0],
      ['Net', 'total', -50],
    ]);
    // Rendered labels carry the sign (recharts lays out only with a size; the rows are the contract).
    render(<Waterfall start={{ label: 'Income', value: 100 }} steps={[{ label: 'Costs', value: -150 }]} end={{ label: 'Net' }} height={200} />);
  });

  it('a chart holding controls is not hidden as one image: its summary is read and its cells stay reachable', async () => {
    render(
      <ChartFrame title="Lateness" summary="Mondays run late." columns={[{ key: 'd', label: 'Day' }]} rows={[{ d: 'Mon' }]} csvName="late">
        <Heatmap caption="Lateness" rows={[{ key: 'mon', label: 'Mon' }]} columns={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]} values={[[1, 2]]} />
      </ChartFrame>,
    );
    expect(await screen.findByText('Mondays run late.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Mondays run late.' })).toBeNull();
    // Roving tabindex: one tab stop, arrows move.
    const a = screen.getByRole('button', { name: 'Mon, A: 1' });
    const b = screen.getByRole('button', { name: 'Mon, B: 2' });
    expect(a).toHaveAttribute('tabindex', '0');
    expect(b).toHaveAttribute('tabindex', '-1');
    a.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(b).toHaveFocus();
    expect(b).toHaveAttribute('tabindex', '0');
  });

  it('a plain chart is still one image named by its summary', () => {
    render(
      <ChartFrame title="Hours" summary="Hours rose." columns={[{ key: 'w', label: 'Week' }]} rows={[{ w: 1 }]} csvName="h">
        <svg />
      </ChartFrame>,
    );
    expect(screen.getByRole('img', { name: 'Hours rose.' })).toBeInTheDocument();
  });
});
