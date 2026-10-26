import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EChartColors } from '@/components/ui/charts/echarts/colors';

/**
 * The ECharts kit (components/ui/charts/echarts): the option builders are
 * pure and tested directly; the EChart wrapper is tested against a fake
 * engine — jsdom can't lay out a real figure.
 */

const fakeChart = {
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  on: vi.fn(),
};
const init = vi.fn(() => fakeChart);
vi.mock('@/components/ui/charts/echarts/engine', () => ({
  loadEcharts: () => Promise.resolve({ init }),
}));

const { EChart, flowOption, calendarOption, treemapOption } = await import('@/components/ui/charts');
const { fillDays, steps } = await import('@/components/ui/charts/echarts/CalendarHeatmap');
const { readableOn } = await import('@/components/ui/charts/echarts/Treemap');
const { mix } = await import('@/components/ui/charts/echarts/colors');

const C: EChartColors = {
  series: ['rgb(1, 1, 1)', 'rgb(2, 2, 2)', 'rgb(3, 3, 3)', 'rgb(4, 4, 4)', 'rgb(5, 5, 5)'],
  other: 'rgb(9, 9, 9)',
  good: 'rgb(0, 200, 0)',
  warn: 'rgb(200, 200, 0)',
  bad: 'rgb(200, 0, 0)',
  info: 'rgb(0, 0, 200)',
  ink: 'rgb(255, 255, 255)',
  muted: 'rgb(192, 208, 224)',
  grid: 'rgb(20, 43, 82)',
  surface: 'rgb(11, 24, 50)',
  font: 'Geist',
};

type AnySeries = Record<string, unknown> & { data: Array<Record<string, unknown>>; links?: unknown[] };
const seriesOf = (o: unknown) => (o as { series: AnySeries[] }).series[0]!;

afterEach(() => {
  vi.clearAllMocks();
});

describe('flowOption', () => {
  it('colours steps in series order and outcomes by meaning, and drops empty links and orphan nodes', () => {
    const s = seriesOf(
      flowOption(
        [
          { id: 'a', label: 'Applied' },
          { id: 'b', label: 'Screening' },
          { id: 'h', label: 'Hired', tone: 'good' },
          { id: 'r', label: 'Rejected', tone: 'bad' },
          { id: 'w', label: 'Withdrew', tone: 'warn' },
        ],
        [
          { source: 'a', target: 'b', value: 10 },
          { source: 'b', target: 'h', value: 4 },
          { source: 'a', target: 'r', value: 3 },
          { source: 'b', target: 'w', value: 0 },
        ],
        C,
      ),
    );
    expect(s.type).toBe('sankey');
    const color = Object.fromEntries(s.data.map((d) => [d.name, (d.itemStyle as { color: string }).color]));
    expect(color).toEqual({ a: C.series[0], b: C.series[1], h: C.good, r: C.bad });
    expect(s.links).toHaveLength(3);
  });
});

describe('calendarOption', () => {
  it('zero-fills every day of the range and keys cells by date', () => {
    expect(fillDays([{ date: '2026-02-28', value: 3 }], '2026-02-27', '2026-03-02')).toEqual([
      ['2026-02-27', 0],
      ['2026-02-28', 3],
      ['2026-03-01', 0],
      ['2026-03-02', 0],
    ]);
  });

  it('cuts the scale at 1/2/3/4+ for a quiet year and at quarters of the busiest day otherwise', () => {
    expect(steps(2)).toEqual([1, 2, 3]);
    expect(steps(20)).toEqual([5, 10, 15]);
    expect(steps(5)).toEqual([2, 3, 4]);
  });

  it('draws zero as the empty cell and the rest in the tone, starting the week where asked', () => {
    const o = calendarOption([{ date: '2026-10-20', value: 8 }], { from: '2026-10-01', to: '2026-10-23' }, C, { unit: 'call-outs', tone: 'bad', firstDay: 6 }) as {
      visualMap: { pieces: Array<{ color: string }> };
      calendar: { range: string[]; dayLabel: { firstDay: number } };
    };
    expect(o.calendar.range).toEqual(['2026-10-01', '2026-10-23']);
    expect(o.calendar.dayLabel.firstDay).toBe(6);
    expect(o.visualMap.pieces[0]!.color).toBe('rgba(20, 43, 82, 0.9)');
    expect(o.visualMap.pieces[4]!.color).toBe(C.bad);
    expect(seriesOf(o).data).toHaveLength(23);
  });

  it('says "1 call-out", not "1 call-outs"', () => {
    const o = calendarOption([], { from: '2026-10-01', to: '2026-10-02' }, C, { unit: 'call-outs', unitOne: 'call-out' }) as {
      tooltip: { formatter: (p: { data: [string, number] }) => string };
    };
    expect(o.tooltip.formatter({ data: ['2026-10-01', 1] })).toMatch(/<b>1<\/b> call-out$/);
    expect(o.tooltip.formatter({ data: ['2026-10-01', 2] })).toMatch(/<b>2<\/b> call-outs$/);
  });
});

describe('treemapOption', () => {
  it('sorts groups by size, gives each a series colour (never gold), steps its children toward the surface, and folds past the fifth', () => {
    const groups = Array.from({ length: 6 }, (_, i) => ({ name: `C${i}`, value: 10 + i, children: [{ name: `S${i}`, value: 10 + i }] }));
    const s = seriesOf(treemapOption(groups, C));
    expect(s.data.map((d) => d.name)).toEqual(['C5', 'C4', 'C3', 'C2', 'C1', 'C0']);
    // Gold (chart-1) is punctuation, not a card-sized fill: the first group takes chart-2.
    expect((s.data[0]!.itemStyle as { color: string }).color).toBe(C.series[1]);
    expect(s.data.some((d) => (d.itemStyle as { color: string }).color === C.series[0])).toBe(false);
    expect((s.data[4]!.itemStyle as { color: string }).color).toBe(C.other);
    expect((s.data[5]!.itemStyle as { color: string }).color).toBe(C.other);
    const child = (s.data[0]!.children as Array<{ itemStyle: { color: string; borderColor: string } }>)[0]!;
    expect(child.itemStyle.color).toBe(mix(C.series[1]!, C.surface, 0.2));
    // A parent's border colour is its name strip: its own shade, never the card.
    expect((s.data[0]!.itemStyle as { borderColor: string }).borderColor).toBe(C.series[1]);
  });

  it('lists its blocks deepest-first, largest first, and says them as a list below three', async () => {
    const { Treemap, treemapLeaves } = await import('@/components/ui/charts');
    const tree = [{ name: 'Coastal', value: 105, children: [{ name: 'Front Beach', value: 105, children: [{ name: 'Deli', value: 105 }] }] }];
    expect(treemapLeaves(tree)).toEqual([{ path: ['Coastal', 'Front Beach', 'Deli'], value: 105 }]);
    render(<Treemap data={tree} format={(n) => `$${n}`} />);
    expect(screen.getByTestId('treemap-few')).toHaveTextContent('Coastal › Front Beach › Deli$105');
    // A caller can say it its own way.
    const { unmount } = render(<Treemap data={tree} few={(leaves) => <p>Only {leaves[0]!.path.at(-1)}</p>} />);
    expect(screen.getByText('Only Deli')).toBeInTheDocument();
    unmount();
  });

  it('puts navy text on light blocks and white text on dark ones', () => {
    expect(readableOn('rgb(237, 178, 60)')).toBe('rgb(11, 24, 50)');
    expect(readableOn('rgb(74, 58, 167)')).toBe('rgb(255, 255, 255)');
  });
});

describe('EChart', () => {
  it('draws with SVG once the engine arrives, redraws on a theme flip, and cleans up', async () => {
    const build = vi.fn(() => ({ series: [] }));
    const { unmount } = render(<EChart build={build} height={200} />);
    await act(async () => {});
    expect(init).toHaveBeenCalledWith(expect.any(HTMLElement), undefined, { renderer: 'svg' });
    expect(fakeChart.setOption).toHaveBeenCalledTimes(1);
    expect(fakeChart.setOption.mock.calls[0]![1]).toEqual({ notMerge: true });

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light');
      await Promise.resolve();
    });
    expect(build).toHaveBeenCalledTimes(2);

    unmount();
    expect(fakeChart.dispose).toHaveBeenCalled();
  });

  it('keeps the drawing out of the accessibility tree and shows a skeleton until the engine loads', () => {
    init.mockClear();
    const { container } = render(<EChart build={() => ({})} height={120} />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
