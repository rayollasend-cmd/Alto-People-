import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
let caps = new Set<string>();
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ user: { id: 'me-1', role: 'HR_ADMINISTRATOR' }, can: (c: string) => caps.has(c) }),
}));
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { approvalRequestHref, useGatedMutation } from '@/lib/useGatedMutation';
import type { Gated } from '@/lib/approvalRequestsApi';

/**
 * Typed 202 (CODE-12 / MONEY-11): a bill- or pay-rate change that goes to a
 * second person answers 202 { pending, approvalId, title }. The screen says
 * "Sent for approval" and puts the old value back — never "Rate saved".
 */

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  </MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  caps = new Set(['manage:clients']);
  qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});

type Row = { id: string; payRate: number };

function setup(answer: () => Promise<Gated<Row>>) {
  const onApplied = vi.fn();
  const onPending = vi.fn();
  const onDone = vi.fn();
  const { result } = renderHook(
    () =>
      useGatedMutation({
        mutationFn: (_v: { payRate: number }) => answer(),
        applied: (_r, v) => `Default rate saved at ${v.payRate}.`,
        failed: 'Could not save the rate.',
        onApplied,
        onPending,
        onDone,
      }),
    { wrapper },
  );
  return { result, onApplied, onPending, onDone };
}

describe('useGatedMutation', () => {
  it('a change that landed: the success line, onApplied', async () => {
    const h = setup(() => Promise.resolve({ id: 'r1', payRate: 16 }));
    await act(async () => {
      await h.result.current.mutateAsync({ payRate: 16 });
    });
    expect(toast.success).toHaveBeenCalledWith('Default rate saved at 16.');
    expect(h.onApplied).toHaveBeenCalledWith({ id: 'r1', payRate: 16 }, { payRate: 16 });
    expect(h.onPending).not.toHaveBeenCalled();
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it('a 202 pending: "Sent for approval" with the request and a link — not the success line', async () => {
    const h = setup(() => Promise.resolve({ pending: true, approvalId: 'ap-9', title: 'Stocker: bill $21.00 → $23.89' }));
    await act(async () => {
      await h.result.current.mutateAsync({ payRate: 16 });
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
    const [title, opts] = vi.mocked(toast.success).mock.calls[0]!;
    expect(title).toBe('Sent for approval');
    const o = opts as { description: string; action: { label: string } };
    expect(o.description).toMatch(/Stocker: bill \$21\.00 → \$23\.89/);
    expect(o.description).toMatch(/nothing changes until a second person approves it/);
    expect(o.action.label).toBe('View request');
    expect(h.onPending).toHaveBeenCalledWith({ pending: true, approvalId: 'ap-9', title: 'Stocker: bill $21.00 → $23.89' }, { payRate: 16 });
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  it('a refusal: the error toast with the server sentence', async () => {
    const h = setup(() => Promise.reject(new ApiError(409, 'approval_pending', 'A rate change for this role is already waiting on a decision.')));
    await act(async () => {
      await h.result.current.mutateAsync({ payRate: 16 }).catch(() => undefined);
    });
    expect(toast.error).toHaveBeenCalledWith('Could not save the rate.', { description: 'A rate change for this role is already waiting on a decision.' });
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('approvalRequestHref', () => {
  it('the record of my pending requests when I can open it, else the request in the approvals queue', () => {
    expect(approvalRequestHref({ approvalId: 'ap-9' }, { canRecord: true, userId: 'me-1' })).toBe('/audit/approvals?status=PENDING&requester=me-1');
    expect(approvalRequestHref({ approvalId: 'ap-9' }, { canRecord: false, userId: 'me-1' })).toBe('/approvals?tab=requests&approval=ap-9');
  });
});
