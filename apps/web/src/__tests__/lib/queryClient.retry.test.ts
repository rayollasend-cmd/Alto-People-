import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError, TimeoutError } from '@/lib/api';
import { queryClient, shouldRetryQuery } from '@/lib/queryClient';

/**
 * A 403 or a 404 answers the same way twice: retrying it doubled every
 * refused read and held its error state back about a second (deep audit
 * 2026-10-29, CRAWL-14). One retry stays for what might pass next time.
 */
describe('query retries', () => {
  it('never retries a 4xx', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(shouldRetryQuery(0, new ApiError(status, 'x', 'x')), String(status)).toBe(false);
    }
  });

  it('retries a 5xx, a dropped connection or a timeout once', () => {
    for (const err of [new ApiError(500, 'internal', 'x'), new ApiError(503, 'x', 'x'), new NetworkError(new Error('x')), new TimeoutError(), new Error('boom')]) {
      expect(shouldRetryQuery(0, err)).toBe(true);
      expect(shouldRetryQuery(1, err)).toBe(false);
    }
  });

  it('is the app-wide default', () => {
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(shouldRetryQuery);
  });
});
