import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async () => ({
    associates: [{ id: 'a1', firstName: 'Dana', lastName: 'Diaz' }],
    nextCursor: null,
  })),
}));

import { directoryQuery } from '@/lib/directoryApi';

/**
 * Opening People crashed with "Cannot read properties of undefined
 * (reading 'length')" for anyone who had hovered the People link first:
 * the hover-prefetch wrote ['directory', {}] as a bare array, and the page
 * reads that key as an infinite query. Both now come from directoryQuery.
 */
describe('directoryQuery', () => {
  it('what the People link prefetches is what the page reads', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The prefetch, exactly as App.tsx fires it on hover.
    await qc.prefetchInfiniteQuery(directoryQuery({}));
    expect(qc.getQueryData(['directory', {}])).toMatchObject({ pages: [expect.anything()], pageParams: [undefined] });

    // The page, opened with no filters set.
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useInfiniteQuery({ ...directoryQuery({}), staleTime: 60_000 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.pages.flatMap((p) => p.associates).map((a) => a.id)).toEqual(['a1']);
    expect(result.current.hasNextPage).toBe(false);
  });
});
