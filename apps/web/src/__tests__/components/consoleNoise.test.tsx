import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { LineChart, Line } from 'recharts';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ResponsiveContainer } from '@/components/ui/charts/container.plot';

/**
 * The console noise of the 2026-10-29 crawl (CRAWL-17, MONEY-30, PEOPLE-25,
 * FLOOR-28): validateDOMNesting from EmptyState's description and from a
 * Skeleton inside a <p>, and recharts' "width(-1) and height(-1)" on every
 * chart mount.
 */

function consoleErrors() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { spy, nesting: () => spy.mock.calls.filter((c) => /validateDOMNesting|cannot be a descendant|cannot appear as a descendant|cannot contain a nested/i.test(c.map(String).join(' '))) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DOM nesting', () => {
  it('an EmptyState description may hold a <details> (Reliability)', () => {
    const c = consoleErrors();
    render(
      <EmptyState
        title="Nothing recorded yet"
        description={
          <>
            Readings land here hourly.
            <details>
              <summary>What this covers</summary>
              Every service the app depends on.
            </details>
          </>
        }
      />,
    );
    expect(c.nesting()).toHaveLength(0);
  });

  it('a Skeleton is valid inside a line of text', () => {
    const c = consoleErrors();
    const { container } = render(
      <p>
        Assigned to <Skeleton className="inline-block h-3 w-24" />
      </p>,
    );
    expect(c.nesting()).toHaveLength(0);
    expect(container.querySelector('[aria-busy="true"]')?.tagName).toBe('SPAN');
  });
});

describe('the kit ResponsiveContainer', () => {
  function stubLayout(w0: number, h0: number) {
    const box = { width: w0, height: h0 };
    let fire: ((w: number, h: number) => void) | null = null;
    class RO {
      constructor(cb: ResizeObserverCallback) {
        fire = (w, h) => cb([{ contentRect: { width: w, height: h } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const { width, height } = box;
      return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    return {
      resize: (w: number, h: number) =>
        act(() => {
          box.width = w;
          box.height = h;
          fire?.(w, h);
        }),
    };
  }

  const chart = (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={[{ x: 1, y: 2 }, { x: 2, y: 3 }]}>
        <Line dataKey="y" />
      </LineChart>
    </ResponsiveContainer>
  );

  it('a measured box mounts the chart at its size — never the -1 × -1 warning', () => {
    stubLayout(480, 240);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(<div style={{ width: 480, height: 240 }}>{chart}</div>);
    expect(container.querySelector('.recharts-responsive-container')).not.toBeNull();
    expect(warn.mock.calls.filter((c) => /width\(-1\)|should be greater than 0/.test(String(c[0])))).toHaveLength(0);
  });

  it('a 0 × 0 box (a hidden tab) waits, then draws once it has a size', () => {
    const layout = stubLayout(0, 0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(chart);
    expect(container.querySelector('[data-chart-box]')).not.toBeNull();
    expect(container.querySelector('.recharts-responsive-container')).toBeNull();
    layout.resize(320, 200);
    expect(container.querySelector('.recharts-responsive-container')).not.toBeNull();
    expect(warn.mock.calls.filter((c) => /should be greater than 0/.test(String(c[0])))).toHaveLength(0);
  });
});
