import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EChartColors } from '@/components/ui/charts/echarts/colors';

/**
 * ScatterMatrix (the chairman's client matrix): the option builder is pure
 * and tested directly — bubble area by size, colour by health on the status
 * scale, quadrant lines, names that never run off the right edge — and the
 * component against a fake engine, as the rest of the ECharts kit is.
 */

const fakeChart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() };
const init = vi.fn(() => fakeChart);
vi.mock('@/components/ui/charts/echarts/engine', () => ({
  loadEcharts: () => Promise.resolve({ init }),
}));

const { ScatterMatrix, scatterOption, scatterFrame, placeLabels, bubbleSizes, middleOf, resolveToneColors, SCATTER_MIN_POINTS } = await import('@/components/ui/charts');

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
const TONES = { good: 'rgb(10, 160, 100)', watch: 'rgb(210, 120, 0)', bad: 'rgb(240, 100, 90)', none: 'rgb(90, 100, 120)' };

const POINTS = [
  { id: 'a', name: 'Coastal Resort', x: 62406, y: 20.8, size: 26, tone: 'watch' as const },
  { id: 'b', name: 'Seaside', x: 19783, y: 20.8, size: 10, tone: 'good' as const },
  { id: 'c', name: 'Emerald <Foods>', x: 9800, y: 12.1, size: 0, tone: 'bad' as const },
  { id: 'd', name: 'Pine Ridge', x: 6100, y: 27.9, size: 3, tone: 'none' as const },
];

type Item = { id: string; name: string; tone: string; value: number[]; symbolSize: number; label: { show: boolean; position?: string }; itemStyle: { color: string; borderColor: string } };
type Opt = {
  series: Array<{ type: string; data: Item[]; markLine?: unknown }>;
  xAxis: { min: number; max: number; axisLabel: { formatter: (v: number) => string } };
  yAxis: { min: number; max: number };
  tooltip: { formatter: (p: { data?: unknown }) => string };
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('scatterOption', () => {
  it('sizes bubbles by area (the square root), the largest at the cap, nothing under the floor', () => {
    const s = bubbleSizes([100, 25, 0, Number.NaN], 12, 40);
    expect(s[0]).toBe(40);
    expect(s[1]).toBe(20); // a quarter of the people: half the diameter
    expect(s[2]).toBe(12);
    expect(s[3]).toBe(12);
    expect(middleOf([3, 1, 2])).toBe(2);
    expect(middleOf([4, 1, 2, 3])).toBe(2.5);
    expect(middleOf([])).toBe(0);
  });

  it('colours each bubble by its health on the status scale, largest drawn first, and splits the field where asked', () => {
    const o = scatterOption(POINTS, C, TONES, { xName: 'Billed', yName: 'Margin rate', sizeName: 'People', split: { x: 24000, y: 19.5 } }) as unknown as Opt;
    const s = o.series[0]!;
    expect(s.type).toBe('scatter');
    expect(s.data.map((d) => d.id)).toEqual(['a', 'b', 'd', 'c']);
    const byId = Object.fromEntries(s.data.map((d) => [d.id, d]));
    expect(byId.a!.itemStyle.borderColor).toBe(TONES.watch);
    expect(byId.a!.itemStyle.color).toBe('rgba(210, 120, 0, 0.72)');
    expect(byId.b!.itemStyle.borderColor).toBe(TONES.good);
    expect(byId.c!.itemStyle.borderColor).toBe(TONES.bad);
    expect(byId.d!.itemStyle.borderColor).toBe(TONES.none);
    // Never a series hue for a status.
    expect(s.data.some((d) => C.series.includes(d.itemStyle.borderColor))).toBe(false);
    expect(byId.a!.value).toEqual([62406, 20.8, 26]);
    expect(byId.a!.symbolSize).toBeGreaterThan(byId.b!.symbolSize);
    // The quadrant lines are the page's HTML, not a markLine the engine would need registered.
    expect(s.markLine).toBeUndefined();
    expect([o.xAxis.min, o.xAxis.max]).toEqual([0, 80000]);
    expect([o.yAxis.min, o.yAxis.max]).toEqual([5, 35]);
  });

  it('pads the field round, from zero across, and splits at the middle unless told', () => {
    const f = scatterFrame(POINTS);
    expect(f.x).toEqual([0, 80000]);
    expect(f.y[0]).toBeLessThan(12.1);
    expect(f.y[1]).toBeGreaterThan(27.9);
    expect(f.split).toEqual({ x: (9800 + 19783) / 2, y: 20.8 });
    expect(scatterFrame(POINTS, { x: 1, y: 2 }).split).toEqual({ x: 1, y: 2 });
    // Every client on one margin rate still gets a field around it.
    const flat = scatterFrame(POINTS.map((p) => ({ ...p, y: 20.8 })));
    expect(flat.y[0]).toBeLessThan(20.8);
    expect(flat.y[1]).toBeGreaterThan(20.8);
  });

  it('places names clear of each other: the right edge reads leftward, a crowded one moves, one with no room is left to the tooltip', () => {
    const sizes = bubbleSizes(POINTS.map((p) => p.size));
    const sides = placeLabels(POINTS, sizes, scatterFrame(POINTS));
    expect(sides[0]).toBe('left'); // Coastal sits past the right third.
    expect(sides[1]).toBe('right');
    const twins = [
      { id: 'x', name: 'Alpha Hotels', x: 10000, y: 20, size: 5, tone: 'good' as const },
      { id: 'y', name: 'Alpha Resorts', x: 10100, y: 20.05, size: 5, tone: 'good' as const },
      { id: 'z', name: 'Alpha Suites', x: 10200, y: 20.1, size: 5, tone: 'good' as const },
      { id: 'w', name: 'Alpha Inns', x: 10050, y: 19.95, size: 5, tone: 'good' as const },
      { id: 'v', name: 'Alpha Lodges', x: 10150, y: 20.02, size: 5, tone: 'good' as const },
      { id: 'big', name: 'Big', x: 50000, y: 30, size: 40, tone: 'good' as const },
    ];
    const s2 = placeLabels(twins, bubbleSizes(twins.map((p) => p.size)), scatterFrame(twins));
    const placed = s2.slice(0, 5).filter(Boolean);
    expect(new Set(placed).size).toBe(placed.length);
    expect(s2.slice(0, 5)).toContain(null);
    const o = scatterOption(twins, C, TONES, { xName: 'Billed', yName: 'Margin rate', sizeName: 'People' }) as unknown as Opt;
    expect(o.series[0]!.data.some((d) => d.label.show === false)).toBe(true);
  });

  it('formats ticks with the axis formatter and escapes names in the tooltip', () => {
    const o = scatterOption(POINTS, C, TONES, {
      xName: 'Billed',
      yName: 'Margin rate',
      sizeName: 'People',
      formatX: (n) => `$${n}`,
      axisX: (n) => `$${n / 1000}k`,
      toneWords: { good: 'Good', watch: 'Watch', bad: 'At risk', none: 'No score' },
    }) as unknown as Opt;
    expect(o.xAxis.axisLabel.formatter(20000)).toBe('$20k');
    const c = o.series[0]!.data.find((d) => d.id === 'c')!;
    expect(o.tooltip.formatter({ data: c })).toBe('<b>Emerald &lt;Foods&gt;</b> · At risk<br/>Billed: $9800<br/>Margin rate: 12.1<br/>People: 0');
  });

  it('reads the tone colours off the theme, with the dark values when there is no stylesheet', () => {
    expect(resolveToneColors()).toEqual({ good: 'rgb(55, 166, 112)', watch: 'rgb(214, 127, 1)', bad: 'rgb(242, 103, 95)', none: 'rgb(91, 103, 127)' });
  });
});

describe('ScatterMatrix', () => {
  it('draws through the engine, names the quadrants and the tones in use, and opens a bubble on click', async () => {
    const open = vi.fn();
    render(
      <ScatterMatrix
        points={POINTS}
        xName="Billed"
        yName="Margin rate"
        sizeName="People"
        toneWords={{ good: 'Good', watch: 'Watch', bad: 'At risk', none: 'No score' }}
        sizeNote="Bubble size: people placed"
        quadrants={{ topLeft: 'High margin, small', topRight: 'High margin, large', bottomLeft: 'Low margin, small', bottomRight: 'Low margin, large' }}
        onPointClick={open}
        height={300}
      />,
    );
    await act(async () => {});
    expect(init).toHaveBeenCalledWith(expect.any(HTMLElement), undefined, { renderer: 'svg' });
    expect(fakeChart.setOption).toHaveBeenCalledTimes(1);
    expect(screen.getByText('High margin, small')).toBeInTheDocument();
    expect(screen.getByText('Low margin, large')).toBeInTheDocument();
    expect(screen.getByText('Bubble size: people placed')).toBeInTheDocument();
    expect(screen.getByText('At risk')).toBeInTheDocument();
    // The quadrant lines cross where the split falls in the padded field.
    const xLine = document.querySelector('[data-split="x"]') as HTMLElement;
    expect(xLine.style.left).toContain(String(((9800 + 19783) / 2 / 80000).toFixed(4)));
    const onClick = fakeChart.on.mock.calls.find((c) => c[0] === 'click')![1] as (p: unknown) => void;
    onClick({ data: { id: 'b' } });
    expect(open).toHaveBeenCalledWith('b');
  });

  it('is a short list below three points', () => {
    expect(SCATTER_MIN_POINTS).toBe(3);
    render(<ScatterMatrix points={POINTS.slice(0, 2)} xName="Billed" yName="Margin rate" sizeName="People" formatX={(n) => `$${n}`} formatY={(n) => `${n}%`} />);
    expect(screen.getByTestId('scatter-few')).toHaveTextContent('Coastal Resort$62406 · 20.8%');
    expect(init).not.toHaveBeenCalled();
  });
});
