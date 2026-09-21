import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackChunk } from '@/lib/chunkLoading';

/**
 * A deploy replaces every hashed bundle. A tab open across one asks for
 * chunk names that no longer exist, and the route it was about to show
 * dies on an import error — on a page that works perfectly, one reload
 * away. So the first such failure reloads into the new build instead of
 * rendering a failure the user can do nothing with.
 *
 * The guard rail is a cooldown: anything else that breaks an import must
 * surface as an error rather than a reload loop.
 */

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  window.sessionStorage.clear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const staleBuild = () =>
  Promise.reject(
    new Error(
      'Failed to fetch dynamically imported module: https://x/assets/AdminDashboard-BfLLMHRD.js',
    ),
  );

describe('a page chunk that never arrives', () => {
  it('reloads into the new build and never settles', async () => {
    let settled = false;
    void trackChunk(staleBuild).then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });

  it('reloads once, then lets the error through', async () => {
    void trackChunk(staleBuild).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);

    await expect(trackChunk(staleBuild)).rejects.toThrow(/dynamically imported/);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves every other failure alone', async () => {
    await expect(
      trackChunk(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(reload).not.toHaveBeenCalled();
  });

  it('passes a loaded chunk straight through', async () => {
    await expect(trackChunk(() => Promise.resolve('page'))).resolves.toBe('page');
    expect(reload).not.toHaveBeenCalled();
  });
});
