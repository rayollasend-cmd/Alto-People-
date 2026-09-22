import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureException = vi.fn();
vi.mock('@sentry/react', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

import { watchHistoryChurn } from '@/lib/historyChurn';

/**
 * The Safari SecurityError this exists for arrives as an unhandled promise
 * rejection from inside React Router, so its stack names the router and
 * the route chunk and nothing that would let you fix it. This trips below
 * Safari's limit and reports while the caller is still on the stack.
 */

const realPush = window.history.pushState.bind(window.history);
const realReplace = window.history.replaceState.bind(window.history);

beforeEach(() => {
  captureException.mockClear();
  vi.resetModules();
});

afterEach(() => {
  window.history.pushState = realPush;
  window.history.replaceState = realReplace;
});

describe('history churn watch', () => {
  it('says nothing for ordinary navigation', async () => {
    watchHistoryChurn();
    for (let i = 0; i < 20; i += 1) {
      window.history.replaceState(null, '', `/people?p=${i}`);
    }
    expect(captureException).not.toHaveBeenCalled();
  });

  it('reports once when a burst crosses the threshold, and names the method', async () => {
    watchHistoryChurn();
    for (let i = 0; i < 80; i += 1) {
      window.history.replaceState(null, '', `/people?p=${i}`);
    }
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0] as [
      Error,
      { tags: { churn: string }; extra: { callsInWindow: number } },
    ];
    expect(err.message).toMatch(/history\.replaceState called \d+ times in 10s/);
    expect(ctx.tags.churn).toBe('replaceState');
    expect(ctx.extra.callsInWindow).toBeGreaterThanOrEqual(60);

    // Once per page load — the condition repeats by definition, and a
    // report per call would be its own flood.
    for (let i = 0; i < 80; i += 1) {
      window.history.replaceState(null, '', `/people?q=${i}`);
    }
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('still performs the navigation it is measuring', async () => {
    watchHistoryChurn();
    window.history.replaceState(null, '', '/people?kept=yes');
    expect(window.location.search).toBe('?kept=yes');
  });

  it('counts pushState too — the overlay sentinel shares Safari’s budget', async () => {
    const mod = await import('@/lib/historyChurn');
    mod.watchHistoryChurn();
    for (let i = 0; i < 80; i += 1) {
      window.history.pushState(null, '', `/people?n=${i}`);
    }
    expect(captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = captureException.mock.calls[0] as [Error, { tags: { churn: string } }];
    expect(ctx.tags.churn).toBe('pushState');
  });
});
