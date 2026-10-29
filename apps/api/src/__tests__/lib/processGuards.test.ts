import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPendingNotifications, trackNotificationWork } from '../../lib/notify.js';
import { installProcessGuards, onUnhandledRejection } from '../../lib/processGuards.js';
import { logger } from '../../lib/logger.js';

/**
 * Audit 2026-10-29 CODE-22: a failed fire-and-forget notice must never become
 * an unhandled rejection (without Sentry's handler Node exits the API on one),
 * and a rejection nobody caught is logged, not fatal.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('trackNotificationWork', () => {
  it('a rejected notice the caller catches leaves no unhandled rejection behind', async () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const p = trackNotificationWork(Promise.reject(new Error('db blip')));
      await expect(p).rejects.toThrow('db blip');
      await flushPendingNotifications();
      // Unhandled rejections are reported after the microtask queue drains.
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('process guards', () => {
  it('installs one unhandledRejection listener, once', () => {
    const before = process.listenerCount('unhandledRejection');
    installProcessGuards();
    installProcessGuards();
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    process.off('unhandledRejection', onUnhandledRejection);
  });

  it('logs the reason (an Error, a string, a cyclic object) and never throws', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => onUnhandledRejection(new Error('boom'))).not.toThrow();
    expect(() => onUnhandledRejection('plain')).not.toThrow();
    expect(() => onUnhandledRejection(cyclic)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(3);
    const first = error.mock.calls[0]![0] as unknown as { err: Error };
    expect(first.err.message).toBe('boom');
    expect((error.mock.calls[1]![0] as unknown as { err: Error }).err.message).toBe('plain');
  });
});
