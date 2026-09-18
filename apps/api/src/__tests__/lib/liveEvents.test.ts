import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import {
  emitLiveEvent,
  liveStreamCount,
  registerLiveStream,
} from '../../lib/liveEvents.js';

function fakeRes() {
  const listeners: Record<string, () => void> = {};
  return {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
    }),
    _close: () => listeners['close']?.(),
  } as unknown as Response & { _close: () => void; write: ReturnType<typeof vi.fn> };
}

describe('liveEvents registry', () => {
  it('emits typed frames to every open stream of the user only', () => {
    const a1 = fakeRes();
    const a2 = fakeRes();
    const b = fakeRes();
    registerLiveStream('user-a', a1);
    registerLiveStream('user-a', a2);
    registerLiveStream('user-b', b);

    emitLiveEvent('user-a', 'notification');

    const frame = 'event: notification\ndata: {}\n\n';
    expect(a1.write).toHaveBeenCalledWith(frame);
    expect(a2.write).toHaveBeenCalledWith(frame);
    expect(b.write).not.toHaveBeenCalledWith(frame);

    a1._close();
    a2._close();
    b._close();
  });

  it('cleans up on close and caps streams per user', () => {
    const before = liveStreamCount();
    const streams = [fakeRes(), fakeRes(), fakeRes(), fakeRes()];
    for (const s of streams) registerLiveStream('user-cap', s);
    // Cap is 3: the oldest was evicted and ended.
    expect(liveStreamCount()).toBe(before + 3);
    expect(streams[0].end).toHaveBeenCalled();

    for (const s of streams) s._close();
    expect(liveStreamCount()).toBe(before);

    // Emitting to a user with no streams is a no-op.
    emitLiveEvent('user-cap', 'notification');
  });

  it('retires a stream before the 15-minute request ceiling', () => {
    vi.useFakeTimers();
    try {
      const before = liveStreamCount();
      const s = fakeRes();
      registerLiveStream('user-lifetime', s);
      expect(liveStreamCount()).toBe(before + 1);

      // Still open at 13 minutes.
      vi.advanceTimersByTime(13 * 60_000);
      expect(liveStreamCount()).toBe(before + 1);
      expect(s.end).not.toHaveBeenCalled();

      // Retired at 14, with a reconnect hint so the browser comes back.
      vi.advanceTimersByTime(60_000 + 1);
      expect(s.write).toHaveBeenCalledWith('retry: 1000\n\n');
      expect(s.end).toHaveBeenCalled();
      expect(liveStreamCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
