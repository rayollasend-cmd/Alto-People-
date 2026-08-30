import { beforeEach, describe, expect, it, vi } from 'vitest';

// The bulk contracts cap entryIds at 200 per request while the queue can
// select up to 500 — timeApi must chunk transparently and hand back ONE
// aggregated BulkTimeResponse.
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/timeEntriesChannel', () => ({
  announceTimeEntriesChanged: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import {
  bulkApproveTimeEntries,
  bulkRejectTimeEntries,
} from '@/lib/timeApi';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  // Echo a per-chunk response: everything succeeds except the first id of
  // each chunk, so aggregation of BOTH counters is observable.
  vi.mocked(apiFetch).mockImplementation((async (
    _url: string,
    opts?: { body?: unknown },
  ) => {
    const body = (opts?.body ?? {}) as { entryIds: string[] };
    return {
      succeeded: body.entryIds.length - 1,
      failed: 1,
      results: body.entryIds.map((entryId, i) => ({
        entryId,
        ok: i > 0,
        errorCode: i > 0 ? null : 'nope',
        errorMessage: i > 0 ? null : 'nope',
      })),
    };
  }) as never);
});

describe('bulkApproveTimeEntries chunking', () => {
  it('splits 347 ids into 200 + 147 and sums the counts', async () => {
    const res = await bulkApproveTimeEntries({ entryIds: ids(347) });

    const calls = vi.mocked(apiFetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('/time/admin/bulk-approve');
    const first = (calls[0][1] as { body: { entryIds: string[] } }).body;
    const second = (calls[1][1] as { body: { entryIds: string[] } }).body;
    expect(first.entryIds).toHaveLength(200);
    expect(second.entryIds).toHaveLength(147);
    // No id lost or duplicated across the chunks.
    expect([...first.entryIds, ...second.entryIds]).toEqual(ids(347));

    expect(res.succeeded).toBe(345);
    expect(res.failed).toBe(2);
    expect(res.results).toHaveLength(347);
  });

  it('sends a ≤200 selection unchunked', async () => {
    const res = await bulkApproveTimeEntries({ entryIds: ids(200) });
    expect(vi.mocked(apiFetch).mock.calls).toHaveLength(1);
    expect(res.succeeded).toBe(199);
    expect(res.failed).toBe(1);
  });
});

describe('bulkRejectTimeEntries chunking', () => {
  it('carries the reason into every chunk', async () => {
    await bulkRejectTimeEntries({ entryIds: ids(250), reason: 'duplicate' });

    const calls = vi.mocked(apiFetch).mock.calls;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[0]).toBe('/time/admin/bulk-reject');
      expect((call[1] as { body: { reason: string } }).body.reason).toBe(
        'duplicate',
      );
    }
  });
});
