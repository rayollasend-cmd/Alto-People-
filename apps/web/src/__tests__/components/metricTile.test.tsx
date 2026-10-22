import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MetricCard, effectiveTone, isZeroValue } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { StatTile } from '@/components/ui/charts';

/**
 * The one KPI tile (F500 SH-2): tone by meaning that never colours a zero,
 * an honest "nothing to count" state, a tile that can BE a filter, an
 * in-app link that doesn't reload the app, a value that never clips
 * silently, and a strip that is two-up on a phone with no orphan tile.
 */

const valueOf = (container: HTMLElement) => container.querySelector('[data-metric-value]') as HTMLElement | null;

describe('MetricCard', () => {
  it('colours by tone, but a zero never wears warning or alert', () => {
    expect(isZeroValue(0)).toBe(true);
    expect(isZeroValue('0')).toBe(true);
    expect(isZeroValue('$0.00')).toBe(true);
    expect(isZeroValue('0%')).toBe(true);
    expect(isZeroValue('0 / 8')).toBe(false);
    expect(isZeroValue('10')).toBe(false);
    expect(effectiveTone('alert', '0')).toBe('default');
    expect(effectiveTone('alert', '3')).toBe('alert');
    expect(effectiveTone('good', 0)).toBe('good');

    const zero = render(<MetricCard label="Overdue" value="0" tone="alert" />);
    expect(valueOf(zero.container)).toHaveClass('text-gold');
    expect(valueOf(zero.container)).not.toHaveClass('text-alert');
    zero.unmount();

    const three = render(<MetricCard label="Overdue" value="3" tone="alert" />);
    expect(valueOf(three.container)).toHaveClass('text-alert');
    three.unmount();

    // The legacy `accent` still means warning.
    const legacy = render(<MetricCard label="Late" value="2" accent />);
    expect(valueOf(legacy.container)).toHaveClass('text-warning');
  });

  it('says "nothing to count" in words instead of a 0 dressed as good news', () => {
    const { container } = render(<MetricCard label="Coverage today" value="0 / 0" hint="Every shift filled" nothing="No shifts today" tone="good" />);
    expect(screen.getByText('No shifts today')).toBeInTheDocument();
    expect(valueOf(container)).toBeNull();
    expect(screen.queryByText('0 / 0')).toBeNull();
    expect(screen.queryByText('Every shift filled')).toBeNull();
  });

  it('a tile can be a filter: a button with aria-pressed', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<MetricCard label="Late" value="4" onClick={onClick} selected={false} />);
    const btn = screen.getByRole('button', { name: /Late/ });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<MetricCard label="Late" value="4" onClick={onClick} selected />);
    expect(screen.getByRole('button', { name: /Late/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('an in-app href goes through the router (no full reload); outside a router it is a plain link', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MetricCard label="Open bills" value="12" href="/books/bills?tab=unpaid" />} />
          <Route path="/books/bills" element={<p>Bills page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('link', { name: /Open bills/ }));
    expect(screen.getByText('Bills page')).toBeInTheDocument();
  });

  it('plain links still work without a router', () => {
    render(<MetricCard label="Docs" value="3" href="https://example.com/docs" />);
    expect(screen.getByRole('link', { name: /Docs/ })).toHaveAttribute('href', 'https://example.com/docs');
  });

  it('the value never clips silently: one line, an ellipsis, the whole value as a tooltip', () => {
    const { container } = render(<MetricCard label="Cash" value="$212,627.40" />);
    const v = valueOf(container)!;
    expect(v).toHaveAttribute('title', '$212,627.40');
    expect(v.className).toMatch(/whitespace-nowrap/);
    expect(v.className).toMatch(/text-ellipsis/);
    expect(v.className).toMatch(/clamp\(/);
    // The label wraps to two lines, never truncates mid-word at 1440.
    expect(screen.getByText('Cash')).toHaveClass('line-clamp-2');
  });

  it('a value too wide for its tile steps its font down to fit before the ellipsis', () => {
    const observers: Array<() => void> = [];
    const RO = class {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    };
    vi.stubGlobal('ResizeObserver', RO);
    const widths = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-metric-value') ? 150 : 0;
    });
    const scrolls = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      // 30px type needs 200px for "$212,627.40"; it scales with the font size.
      if (!this.hasAttribute('data-metric-value')) return 0;
      const fs = parseFloat(this.style.fontSize) || 30;
      return Math.round((200 * fs) / 30);
    });
    const cs = vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ fontSize: '30px' }) as CSSStyleDeclaration);
    try {
      const { container } = render(<MetricCard label="Cash" value="$212,627.40" />);
      const v = valueOf(container)!;
      // 30px × 150/200 × 0.97 → 21px: the whole figure, smaller, not "$212,627.4(".
      expect(v.style.fontSize).toBe('21px');
      expect(observers.length).toBeGreaterThan(0);
    } finally {
      widths.mockRestore();
      scrolls.mockRestore();
      cs.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('carries a unit, a delta in words and a meter (the portal tile is this tile)', () => {
    const { container } = render(<StatTile label="Tomorrow" value={5} unit="/ 8" delta="+2 pts" deltaTone="good" meter={{ percent: 62, tone: 'warn' }} sub="3 open" />);
    expect(screen.getByText('/ 8')).toBeInTheDocument();
    expect(screen.getByText('+2 pts')).toHaveClass('text-success');
    expect(screen.getByText('3 open')).toBeInTheDocument();
    expect(container.querySelector('[style*="width: 62%"]')).not.toBeNull();
  });

  it('draws a delta chip without a sparkline', () => {
    render(<MetricCard label="Hires" value="12" delta={{ value: 3, label: 'vs last week' }} />);
    expect(screen.getByText('vs last week')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('MetricStrip', () => {
  const tiles = (n: number) => Array.from({ length: n }, (_, i) => <MetricCard key={i} label={`Tile ${i}`} value={String(i + 1)} hint={`hint ${i}`} href="/x" />);
  const cells = (container: HTMLElement) => [...container.querySelectorAll('[data-metric-strip] > div')] as HTMLElement[];

  it('is two-up on a phone and four-up from lg', () => {
    const { container } = render(<MetricStrip label="At a glance">{tiles(4)}</MetricStrip>);
    const grid = container.querySelector('[data-metric-strip]')!;
    expect(grid).toHaveClass('grid-cols-2', 'lg:grid-cols-4');
    expect(screen.getByRole('group', { name: 'At a glance' })).toBe(grid);
    expect(cells(container).every((c) => !/col-span/.test(c.className))).toBe(true);
  });

  it('never strands a tile alone on a row', () => {
    const three = render(<MetricStrip>{tiles(3)}</MetricStrip>);
    expect(three.container.querySelector('[data-metric-strip]')).toHaveClass('lg:grid-cols-3');
    expect(cells(three.container).at(-1)).toHaveClass('col-span-2', 'lg:col-span-1');
    three.unmount();

    const five = render(<MetricStrip>{tiles(5)}</MetricStrip>);
    expect(five.container.querySelector('[data-metric-strip]')).toHaveClass('lg:grid-cols-3', 'xl:grid-cols-5');
    expect(cells(five.container).at(-1)).toHaveClass('col-span-2', 'lg:col-span-2', 'xl:col-span-1');
    five.unmount();

    const seven = render(<MetricStrip>{tiles(7)}</MetricStrip>);
    expect(cells(seven.container).at(-1)).toHaveClass('col-span-2', 'lg:col-span-2');
    seven.unmount();

    const nine = render(<MetricStrip>{tiles(9)}</MetricStrip>);
    expect(cells(nine.container).at(-1)).toHaveClass('col-span-2', 'lg:col-span-4');
  });

  it('tiles inside are phone-compact (hint hidden below sm) and drop the repeated CTA', () => {
    render(<MetricStrip>{tiles(2)}</MetricStrip>);
    expect(screen.getByText('hint 0')).toHaveClass('hidden', 'sm:block');
    expect(screen.queryByText(/View details/)).toBeNull();
  });

  it('a standalone linked tile keeps its CTA', () => {
    render(<MetricCard label="Alone" value="1" href="https://example.com" />);
    expect(screen.getByText(/View details/)).toBeInTheDocument();
  });

  it('hides over an empty list, or says it in one line', () => {
    const hidden = render(<MetricStrip empty>{tiles(4)}</MetricStrip>);
    expect(hidden.container.innerHTML).toBe('');
    hidden.unmount();
    render(<MetricStrip empty="No call-outs in the last 7 days">{tiles(4)}</MetricStrip>);
    expect(screen.getByText('No call-outs in the last 7 days')).toBeInTheDocument();
    expect(screen.queryByText('Tile 0')).toBeNull();
  });

  it('skips null and false children when laying out', () => {
    const { container } = render(
      <MetricStrip>
        <MetricCard label="A" value="1" />
        {null}
        {false}
        <MetricCard label="B" value="2" />
      </MetricStrip>,
    );
    expect(cells(container)).toHaveLength(2);
    expect(container.querySelector('[data-metric-strip]')).toHaveClass('grid-cols-2');
  });
});
