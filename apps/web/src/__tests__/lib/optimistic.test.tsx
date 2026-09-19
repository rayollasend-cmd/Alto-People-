import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { removeFromLists, useOptimisticMutation } from '@/lib/optimistic';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { toast } from 'sonner';

/**
 * Act now, reconcile later. What matters is the order: the cache moves
 * before the request goes out, a failure puts back exactly what was there,
 * and the server always gets the last word.
 */

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

describe('removeFromLists', () => {
  it('drops rows from a bare array and from every envelope shape', () => {
    qc.setQueryData(['team', 'bare'], [{ id: 'a' }, { id: 'b' }]);
    qc.setQueryData(['team', 'entries'], { entries: [{ id: 'a' }, { id: 'c' }], total: 2 });
    qc.setQueryData(['team', 'inbox'], { items: [{ id: 'a' }], categories: { pending: 1 } });

    removeFromLists(qc, [['team']], ['a']);

    expect(qc.getQueryData(['team', 'bare'])).toEqual([{ id: 'b' }]);
    // Non-array fields on the envelope are left alone.
    expect(qc.getQueryData(['team', 'entries'])).toEqual({ entries: [{ id: 'c' }], total: 2 });
    expect(qc.getQueryData(['team', 'inbox'])).toEqual({ items: [], categories: { pending: 1 } });
  });

  it('clears one decision out of several lists at once', () => {
    // Approving a timesheet empties it from the queue AND the inbox.
    qc.setQueryData(['team', 'timesheets', 'COMPLETED'], { entries: [{ id: 't1' }, { id: 't2' }] });
    qc.setQueryData(['team', 'inbox'], { items: [{ id: 't1' }, { id: 'p9' }] });
    removeFromLists(qc, [['team']], ['t1']);
    expect(qc.getQueryData(['team', 'timesheets', 'COMPLETED'])).toEqual({ entries: [{ id: 't2' }] });
    expect(qc.getQueryData(['team', 'inbox'])).toEqual({ items: [{ id: 'p9' }] });
  });

  it('leaves untouched data untouched', () => {
    const before = { items: [{ id: 'x' }] };
    qc.setQueryData(['team', 'other'], before);
    removeFromLists(qc, [['team']], ['nope']);
    // Same object identity — no needless re-render of an unaffected list.
    expect(qc.getQueryData(['team', 'other'])).toBe(before);
  });
});

describe('useOptimisticMutation', () => {
  it('moves the cache before the request resolves', async () => {
    qc.setQueryData(['team', 'inbox'], { items: [{ id: 'a' }, { id: 'b' }] });
    let release: (v: unknown) => void = () => {};
    const inFlight = new Promise((r) => {
      release = r;
    });

    const { result } = renderHook(
      () =>
        useOptimisticMutation({
          mutationFn: () => inFlight,
          keys: [['team']],
          apply: (_vars: string, c) => removeFromLists(c, [['team']], ['a']),
        }),
      { wrapper },
    );

    act(() => result.current.mutate('a'));
    // The row is gone while the request is still open — the whole point.
    await waitFor(() =>
      expect(qc.getQueryData(['team', 'inbox'])).toEqual({ items: [{ id: 'b' }] }),
    );
    await act(async () => {
      release(undefined);
      await inFlight;
    });
  });

  it('puts the row back and says so when the server refuses', async () => {
    qc.setQueryData(['team', 'inbox'], { items: [{ id: 'a' }, { id: 'b' }] });

    const { result } = renderHook(
      () =>
        useOptimisticMutation({
          mutationFn: () => Promise.reject(new Error('nope')),
          keys: [['team']],
          apply: (_vars: string, c) => removeFromLists(c, [['team']], ['a']),
          errorMessage: 'Approve failed.',
        }),
      { wrapper },
    );

    act(() => result.current.mutate('a'));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData(['team', 'inbox'])).toEqual({ items: [{ id: 'a' }, { id: 'b' }] });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Approve failed.');
  });

  it('restores every affected list, not just the one the caller thought about', async () => {
    qc.setQueryData(['team', 'timesheets'], { entries: [{ id: 'a' }] });
    qc.setQueryData(['team', 'inbox'], { items: [{ id: 'a' }] });

    const { result } = renderHook(
      () =>
        useOptimisticMutation({
          mutationFn: () => Promise.reject(new Error('nope')),
          keys: [['team']],
          apply: (_vars: string, c) => removeFromLists(c, [['team']], ['a']),
        }),
      { wrapper },
    );

    act(() => result.current.mutate('a'));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(qc.getQueryData(['team', 'timesheets'])).toEqual({ entries: [{ id: 'a' }] });
    expect(qc.getQueryData(['team', 'inbox'])).toEqual({ items: [{ id: 'a' }] });
  });

  it('gives the server the last word on success', async () => {
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(
      () =>
        useOptimisticMutation({
          mutationFn: () => Promise.resolve('ok'),
          keys: [['team']],
          apply: () => {},
        }),
      { wrapper },
    );
    act(() => result.current.mutate('a'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['team'] });
  });

  it('cancels in-flight refetches so a late response cannot undo the patch', async () => {
    const cancel = vi.spyOn(qc, 'cancelQueries');
    const { result } = renderHook(
      () =>
        useOptimisticMutation({
          mutationFn: () => Promise.resolve('ok'),
          keys: [['team'], ['relay']],
          apply: () => {},
        }),
      { wrapper },
    );
    act(() => result.current.mutate('a'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(cancel).toHaveBeenCalledWith({ queryKey: ['team'] });
    expect(cancel).toHaveBeenCalledWith({ queryKey: ['relay'] });
  });
});
