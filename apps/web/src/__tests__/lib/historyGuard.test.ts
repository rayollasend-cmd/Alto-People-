import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureException = vi.fn();
vi.mock('@sentry/react', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

import { __resetHistoryGuardForTests, guardHistory } from '@/lib/historyGuard';

/**
 * Safari throws once a page calls history.replaceState 100 times in a
 * window, and the error arrives from inside React Router with a stack
 * that names nobody. The guard keeps the page under the budget by
 * coalescing a burst into its latest write; the diagnostic names the
 * caller while it is still on the stack.
 */

const realPush = window.history.pushState.bind(window.history);
const realReplace = window.history.replaceState.bind(window.history);

beforeEach(() => {
  captureException.mockClear();
  __resetHistoryGuardForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  window.history.pushState = realPush;
  window.history.replaceState = realReplace;
  realReplace(null, '', '/');
});

function spyOnReal() {
  const replaced = vi.fn((...args: Parameters<History['replaceState']>) => realReplace(...args));
  window.history.replaceState = replaced as unknown as History['replaceState'];
  return replaced;
}

describe('history guard', () => {
  it('lets ordinary navigation straight through', () => {
    const real = spyOnReal();
    guardHistory();
    for (let i = 0; i < 20; i += 1) window.history.replaceState(null, '', `/people?p=${i}`);
    expect(real).toHaveBeenCalledTimes(20);
    expect(window.location.search).toBe('?p=19');
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a burst is coalesced under the budget, and the last write still lands', () => {
    const real = spyOnReal();
    guardHistory();
    for (let i = 0; i < 200; i += 1) window.history.replaceState(null, '', `/people?p=${i}`);
    // Thirty went through; the rest collapsed into one pending write.
    expect(real).toHaveBeenCalledTimes(30);
    expect(window.location.search).toBe('?p=29');
    // Once the window turns, the newest one is written — not the 170 others.
    vi.advanceTimersByTime(10_100);
    expect(real).toHaveBeenCalledTimes(31);
    expect(window.location.search).toBe('?p=199');
  });

  it('reports the burst once, naming the method, even while absorbing it', () => {
    spyOnReal();
    guardHistory();
    for (let i = 0; i < 80; i += 1) window.history.replaceState(null, '', `/people?p=${i}`);
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0] as [
      Error,
      { tags: { churn: string }; extra: { callsInWindow: number; deferred: boolean } },
    ];
    expect(err.message).toMatch(/history\.replaceState called \d+ times in 10s/);
    expect(ctx.tags.churn).toBe('replaceState');
    expect(ctx.extra.callsInWindow).toBeGreaterThanOrEqual(60);
    expect(ctx.extra.deferred).toBe(true);
    for (let i = 0; i < 80; i += 1) window.history.replaceState(null, '', `/people?q=${i}`);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('never defers pushState — an overlay’s Back sentinel must land now — but counts it', () => {
    const pushed = vi.fn((...args: Parameters<History['pushState']>) => realPush(...args));
    window.history.pushState = pushed as unknown as History['pushState'];
    const real = spyOnReal();
    guardHistory();
    for (let i = 0; i < 40; i += 1) window.history.pushState(null, '', `/people?n=${i}`);
    expect(pushed).toHaveBeenCalledTimes(40);
    // The budget is spent: the next replace waits for the window.
    window.history.replaceState(null, '', '/people?after=push');
    expect(real).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_100);
    expect(real).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?after=push');
  });
});
