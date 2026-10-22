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
import { listQueuedWrites, replayQueuedWrites } from '@/lib/offlineQueue';
import { forgetDriverFix, rememberDriverFix, currentDriverFix } from '@/lib/driverPosition';
import { pendingFor, pendingMarks, tapArrived, tapBoard, tapNoShow, tapUndo } from '@/lib/offlineTransport';

/**
 * Floor walk 5 and 17 — the driver's taps survive a dead spot and carry
 * where the van was. Online, a tap goes now with the phone's fix and an
 * idempotency key. With no signal it is queued (marked as a replay, so a
 * mark that did land answers 200 instead of being dropped), the rows read
 * it back as "(sending)", and the queue sends it when the signal returns.
 */

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const ride = { id: 'r1', rider: { name: 'Maria Lopez' } };

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  forgetDriverFix();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('a tap with signal', () => {
  it('goes now, with the phone’s fix and an idempotency key', async () => {
    rememberDriverFix({ lat: 30.19, lng: -85.82, accuracy: 9 });
    fetchMock.mockResolvedValueOnce({ ride: { id: 'r1', status: 'BOARDED' } });
    const r = await tapBoard(ride);
    expect(r.queued).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/transport/driver/rides/r1/board', {
      method: 'POST',
      body: { lat: 30.19, lng: -85.82, accuracy: 9, idempotencyKey: expect.any(String) },
    });
    expect(listQueuedWrites()).toHaveLength(0);
  });

  it('a stale fix is not evidence — it is left out', () => {
    rememberDriverFix({ lat: 1, lng: 2, accuracy: 5 }, Date.now() - 5 * 60_000);
    expect(currentDriverFix()).toBeNull();
  });

  it('a server refusal is the server’s word — not queued', async () => {
    fetchMock.mockRejectedValueOnce(new ApiError(409, 'not_arrived', 'Tap Arrived at the stop first.'));
    await expect(tapNoShow(ride)).rejects.toBeInstanceOf(ApiError);
    expect(listQueuedWrites()).toHaveLength(0);
  });
});

describe('a tap with no signal', () => {
  it('is queued as a replay, and the rows read it back as on its way', async () => {
    fetchMock.mockRejectedValueOnce(new NetworkError('offline'));
    const r = await tapBoard(ride);
    expect(r.queued).toBe(true);
    const [q] = listQueuedWrites();
    expect(q).toMatchObject({ kind: 'transport-tap', label: 'Maria Lopez on board', method: 'POST', path: '/transport/driver/rides/r1/board' });
    expect(q!.body).toMatchObject({ replay: true, idempotencyKey: expect.any(String) });
    expect(pendingMarks()).toEqual([expect.objectContaining({ kind: 'board', id: 'r1' })]);
    expect(pendingFor('r1', 'run1', pendingMarks())).toBe('board');
  });

  it('when the browser says offline, nothing is tried — Arrived queues for the whole stop', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const r = await tapArrived('run1', ['r1', 'r2'], 'Seaside Housing');
    expect(r.queued).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const marks = pendingMarks();
    expect(pendingFor('r2', 'run1', marks)).toBe('arrived');
    expect(pendingFor('r3', 'run1', marks)).toBeNull();
    expect(listQueuedWrites()[0]!.body).toMatchObject({ rideIds: ['r1', 'r2'], replay: true });
  });

  it('the queue sends them in order when the signal is back, and the pending marks clear', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await tapBoard(ride);
    await tapUndo(ride);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    fetchMock.mockResolvedValue({ ride: {} });
    const out = await replayQueuedWrites();
    expect(out).toMatchObject({ sent: 2, remaining: 0 });
    expect(fetchMock.mock.calls.map(([p]) => p)).toEqual(['/transport/driver/rides/r1/board', '/transport/driver/rides/r1/undo']);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: expect.objectContaining({ replay: true }) });
    expect(pendingMarks()).toEqual([]);
  });
});
