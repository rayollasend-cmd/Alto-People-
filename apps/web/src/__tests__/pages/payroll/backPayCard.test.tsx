import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '@/lib/confirm';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/components/ui/Toaster', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/Toaster';
import { BackPayCard } from '@/pages/payroll/BackPayCard';
import type { BackPayOwed } from '@/lib/payrollDeskApi';

/**
 * The payroll home's back-pay card (the owner's answer to the deep audit:
 * pay the evening hours the old UTC cut missed): who is owed what, and one
 * action that adds it to the next regular run — only after the money
 * confirm names the total.
 */

const owed: BackPayOwed = {
  total: 180,
  waitingForRun: 0,
  people: [
    {
      associateId: '11111111-1111-4111-8111-111111111111',
      name: 'Ana Reyes',
      punches: [{ timeEntryId: 'e1', workDay: '2026-10-09', hours: 6, rate: 20, sourceRunId: 'r1', amount: 180 }],
      hours: 6,
      rates: [20],
      overtimeHours: 6,
      overtimePremium: 60,
      amount: 180,
      periods: [{ periodStart: '2026-09-26', periodEnd: '2026-10-09' }],
      target: { runId: 'run-open', periodStart: '2026-10-24', periodEnd: '2026-11-06' },
    },
  ],
};

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <MemoryRouter>
          <BackPayCard canProcess />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(toast.success).mockReset();
});

describe('back pay on the payroll home', () => {
  it('lists the person, days, hours, rate, overtime and amount', async () => {
    vi.mocked(apiFetch).mockResolvedValue(owed as never);
    renderCard();
    const card = await screen.findByTestId('back-pay-card');
    expect(within(card).getByRole('heading', { name: /Back pay: evening hours the old cut missed/ })).toBeInTheDocument();
    const row = within(card).getByTestId('back-pay-row');
    expect(row).toHaveTextContent('Ana Reyes');
    expect(row).toHaveTextContent(/Fri, Oct 9/);
    expect(row).toHaveTextContent('$20.00');
    expect(row).toHaveTextContent('$60.00');
    expect(row).toHaveTextContent('$180.00');
    expect(row).toHaveTextContent(/On the Oct 24 – Nov 6, 2026 run/);
  });

  it('adds it only after the money confirm names the total', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/payroll/back-pay/add' && opts?.method === 'POST') return { people: [], total: 180, waiting: [] } as never;
      return owed as never;
    });
    renderCard();
    const card = await screen.findByTestId('back-pay-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Add to the next regular run' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('money-confirm-facts')).toHaveTextContent('$180.00');
    expect(apiFetch).not.toHaveBeenCalledWith('/payroll/back-pay/add', expect.anything());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add $180.00' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/payroll/back-pay/add', { method: 'POST', body: {}, headers: { 'Idempotency-Key': expect.stringMatching(/^backpay-/) } }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Added $180.00 back pay to the next regular run.'));
  });

  it('says when it went to a second person, and when no run is open', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/payroll/back-pay/add' && opts?.method === 'POST') return { people: [], total: 180, waiting: [], pending: true, approvalId: 'ap1' } as never;
      return owed as never;
    });
    renderCard();
    fireEvent.click(within(await screen.findByTestId('back-pay-card')).getByRole('button', { name: 'Add to the next regular run' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Add $180.00' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Sent for approval: \$180\.00 back pay/)));
  });

  it('with no open run, the action waits and says why; nothing owed renders nothing', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ...owed, waitingForRun: 1, people: [{ ...owed.people[0]!, target: null }] } as never);
    const { unmount } = renderCard();
    const card = await screen.findByTestId('back-pay-card');
    expect(within(card).getByRole('button', { name: 'Add to the next regular run' })).toBeDisabled();
    expect(within(card).getByText(/No regular run is open/)).toBeInTheDocument();
    unmount();
    vi.mocked(apiFetch).mockResolvedValue({ total: 0, people: [], waitingForRun: 0 } as never);
    renderCard();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('back-pay-card')).toBeNull();
  });
});
