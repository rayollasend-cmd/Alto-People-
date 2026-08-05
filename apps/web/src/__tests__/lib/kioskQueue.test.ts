import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/kiosk99Api', () => ({
  kioskPunch: vi.fn(),
}));

import { kioskPunch } from '@/lib/kiosk99Api';
import {
  clearDroppedCount,
  clearQueue,
  drainQueue,
  droppedCount,
  enqueuePunch,
  listQueue,
} from '@/lib/kioskQueue';

/**
 * The offline queue is the only copy of worked time a disconnected kiosk
 * has. These tests pin the failure-handling rules that decide whether that
 * time survives — most importantly that a device-auth failure (an expired
 * or rotated token) is treated as "the DEVICE has a problem", never as a
 * per-item verdict. The old rule classed any 4xx as permanent, so a token
 * that expired while punches were queued deleted the entire backlog in one
 * drain: days of worked time, no server trace, no notice.
 */

class FakeApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function queuePunch(key: string) {
  enqueuePunch({
    idempotencyKey: key,
    deviceToken: 'old-token',
    pin: '1234',
    selfie: null,
    faceDescriptor: null,
    latitude: null,
    longitude: null,
    capturedAt: new Date().toISOString(),
    intent: null,
  });
}

beforeEach(() => {
  clearQueue();
  clearDroppedCount();
  vi.mocked(kioskPunch).mockReset();
});

describe('drainQueue', () => {
  it('sends every queued punch and empties the queue', async () => {
    queuePunch('a');
    queuePunch('b');
    vi.mocked(kioskPunch).mockResolvedValue({
      action: 'CLOCK_IN',
      associateName: 'x',
      at: '',
      punchId: 'p',
    });

    const r = await drainQueue();
    expect(r).toEqual({ synced: 2, remaining: 0, errors: 0 });
    expect(listQueue()).toHaveLength(0);
  }, 10_000);

  it('keeps the whole queue when the device token has expired', async () => {
    queuePunch('a');
    queuePunch('b');
    vi.mocked(kioskPunch).mockRejectedValue(
      new FakeApiError(401, 'device_token_expired'),
    );

    const r = await drainQueue();
    // Nothing dropped, nothing counted as an error — HR re-pairs the
    // tablet and the next drain delivers the backlog.
    expect(r.errors).toBe(0);
    expect(r.remaining).toBe(2);
    expect(listQueue()).toHaveLength(2);
    expect(droppedCount()).toBe(0);
    // And it stopped after the FIRST failure instead of burning a
    // throttle-spaced request per item on a device that can't auth.
    expect(kioskPunch).toHaveBeenCalledTimes(1);
  });

  it('replays with the current token, not the token frozen into the item', async () => {
    queuePunch('a');
    vi.mocked(kioskPunch).mockResolvedValue({
      action: 'CLOCK_IN',
      associateName: 'x',
      at: '',
      punchId: 'p',
    });

    await drainQueue('fresh-token');
    expect(vi.mocked(kioskPunch).mock.calls[0][0].deviceToken).toBe(
      'fresh-token',
    );
  });

  it('drops a permanently-rejected punch and records the loss', async () => {
    queuePunch('a');
    vi.mocked(kioskPunch).mockRejectedValue(
      new FakeApiError(400, 'punch_too_old'),
    );

    const r = await drainQueue();
    expect(r.errors).toBe(1);
    expect(listQueue()).toHaveLength(0);
    // The dropped counter is what the idle screen surfaces — the loss must
    // not be silent.
    expect(droppedCount()).toBe(1);
  });

  it('keeps and retries on network failure', async () => {
    queuePunch('a');
    vi.mocked(kioskPunch).mockRejectedValue(new Error('network down'));

    const r = await drainQueue();
    expect(r.errors).toBe(0);
    expect(r.remaining).toBe(1);
    expect(listQueue()[0].attempts).toBe(1);
    expect(droppedCount()).toBe(0);
  });
});
