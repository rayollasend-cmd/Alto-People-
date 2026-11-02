import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: api.apiFetch }));

import { ApiError } from '@/lib/api';
import { startLiveEvents, stopLiveEvents } from '@/lib/liveEvents';

/** A stand-in EventSource: each one is kept so a test can fail it. */
class FakeEventSource {
  static CLOSED = 2;
  static made: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.made.push(this);
  }
  addEventListener() {}
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  /** The server refused or dropped it for good. */
  refuse() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

describe('live events after the stream is refused', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.made = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    api.apiFetch.mockReset();
  });
  afterEach(() => {
    stopLiveEvents();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a dead session stops the channel instead of retrying every minute', async () => {
    api.apiFetch.mockRejectedValue(new ApiError(401, 'unauthenticated', 'Sign in first'));
    startLiveEvents();
    FakeEventSource.made[0]!.refuse();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(api.apiFetch).toHaveBeenCalledWith('/auth/me');
    expect(FakeEventSource.made).toHaveLength(1);
  });

  it('a live session (the server restarting) reconnects with backoff', async () => {
    api.apiFetch.mockResolvedValue({ user: {} });
    startLiveEvents();
    FakeEventSource.made[0]!.refuse();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeEventSource.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.made).toHaveLength(2);
  });

  it('a network failure on the check still retries', async () => {
    api.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    startLiveEvents();
    FakeEventSource.made[0]!.refuse();
    // The backoff is module state (it grew in the test before): at most a minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.made).toHaveLength(2);
  });

  it('signing out while the check is in flight keeps the channel down', async () => {
    let answer!: (v: unknown) => void;
    api.apiFetch.mockReturnValue(new Promise((r) => (answer = r)));
    startLiveEvents();
    FakeEventSource.made[0]!.refuse();
    stopLiveEvents();
    answer({ user: {} });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(FakeEventSource.made).toHaveLength(1);
  });
});
