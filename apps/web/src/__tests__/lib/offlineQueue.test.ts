import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
    }
  }
  class NetworkError extends Error {}
  class TimeoutError extends Error {}
  return { apiFetch: vi.fn(), ApiError, NetworkError, TimeoutError };
});
vi.mock('@/lib/sessionEvents', () => ({ onApiConnectivity: vi.fn(() => () => undefined) }));

import { ApiError, NetworkError, apiFetch } from '@/lib/api';
import { enqueueWrite, isQueued, listQueuedWrites, replayQueuedWrites, withOfflineQueue } from '@/lib/offlineQueue';

/**
 * Access pack — offline writes: a request with no signal is queued; the
 * replay sends in order, keeps what the network still refuses, and DROPS
 * what the server refuses (a conflict) with its message.
 */

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('withOfflineQueue', () => {
  it('passes a server answer through and queues a network failure', async () => {
    const ok = await withOfflineQueue(async () => ({ id: 1 }), { kind: 'x', label: 'do x', method: 'POST', path: '/x', body: {} });
    expect(ok).toEqual({ id: 1 });
    expect(listQueuedWrites()).toHaveLength(0);

    const queued = await withOfflineQueue(async () => { throw new NetworkError('offline'); }, { kind: 'x', label: 'do x', method: 'POST', path: '/x', body: { a: 1 } });
    expect(isQueued(queued)).toBe(true);
    expect(listQueuedWrites()).toHaveLength(1);
    expect(listQueuedWrites()[0]).toMatchObject({ path: '/x', method: 'POST', body: { a: 1 }, label: 'do x' });
  });

  it('a server refusal is not queued — the person is online and the server said no', async () => {
    await expect(
      withOfflineQueue(async () => { throw new ApiError(409, 'illegal_state', 'Already decided'); }, { kind: 'x', label: 'do x', method: 'POST', path: '/x', body: {} }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(listQueuedWrites()).toHaveLength(0);
  });

  it('queues without trying when the browser says it is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const send = vi.fn(async () => 'never');
    const r = await withOfflineQueue(send, { kind: 'x', label: 'do x', method: 'POST', path: '/x', body: {} });
    expect(isQueued(r)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('replayQueuedWrites', () => {
  it('sends in order, drops a conflict with its message, keeps the rest on a network failure', async () => {
    enqueueWrite({ kind: 't', label: 'first', method: 'POST', path: '/1', body: {} });
    enqueueWrite({ kind: 't', label: 'second', method: 'POST', path: '/2', body: {} });
    enqueueWrite({ kind: 't', label: 'third', method: 'POST', path: '/3', body: {} });
    fetchMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ApiError(409, 'already_decided', 'This item is already APPROVED.'))
      .mockRejectedValueOnce(new NetworkError('gone again'));
    const out = await replayQueuedWrites();
    expect(out.sent).toBe(1);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]!.item.label).toBe('second');
    expect(out.dropped[0]!.message).toBe('This item is already APPROVED.');
    expect(out.remaining).toBe(1);
    const left = listQueuedWrites();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ label: 'third', attempts: 1 });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/1', '/2', '/3']);
  });
});
