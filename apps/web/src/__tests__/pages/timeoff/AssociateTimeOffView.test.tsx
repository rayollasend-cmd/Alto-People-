import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/timeOffApi', () => ({
  getMyBalance: vi.fn(),
  listMyRequests: vi.fn(),
  createMyRequest: vi.fn(),
  cancelMyRequest: vi.fn(),
}));

import {
  cancelMyRequest,
  createMyRequest,
  getMyBalance,
  listMyRequests,
} from '@/lib/timeOffApi';
import { AssociateTimeOffView } from '@/pages/timeoff/AssociateTimeOffView';

function renderView() {
  // Fresh client per render so cached lists never leak between tests;
  // retry off so mocked failures surface immediately.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const value = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      email: 'maria@example.com',
      role: 'ASSOCIATE' as const,
      status: 'ACTIVE' as const,
      clientId: null,
      associateId: 'a',
    },
    role: 'ASSOCIATE' as const,
    capabilities: new Set<Capability>(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => false,
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={value}>
        <MemoryRouter>
          <AssociateTimeOffView />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(getMyBalance).mockResolvedValue({
    balances: [{ category: 'SICK', balanceMinutes: 240 }],
    recentLedger: [],
  });
  vi.mocked(listMyRequests).mockResolvedValue({ requests: [] });
});

describe('<AssociateTimeOffView>', () => {
  it('renders accrued balance after load', async () => {
    renderView();
    await waitFor(() => {
      expect(screen.getByText('Sick')).toBeInTheDocument();
      expect(screen.getByText('4h')).toBeInTheDocument();
    });
  });

  it('submits a request with the form values', async () => {
    vi.mocked(createMyRequest).mockResolvedValue({
      request: {
        id: 'r1',
        associateId: 'a',
        associateName: 'Maria',
        category: 'VACATION',
        startDate: '2026-05-04',
        endDate: '2026-05-04',
        requestedMinutes: 480,
        reason: null,
        status: 'PENDING',
        reviewerUserId: null,
        reviewerEmail: null,
        reviewerNote: null,
        decidedAt: null,
        cancelledAt: null,
        createdAt: new Date().toISOString(),
      },
    });
    const user = userEvent.setup();
    renderView();

    await waitFor(() => expect(getMyBalance).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /request time off/i }));
    // The dates prefill to today; fireEvent.change replaces the whole value
    // (user.type appends segment-wise into a filled date input in jsdom).
    fireEvent.change(screen.getByLabelText(/start date/i), {
      target: { value: '2026-05-04' },
    });
    fireEvent.change(screen.getByLabelText(/end date/i), {
      target: { value: '2026-05-04' },
    });
    // hours auto-computes: one business day = 8.
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => {
      expect(createMyRequest).toHaveBeenCalledWith({
        category: 'VACATION',
        startDate: '2026-05-04',
        endDate: '2026-05-04',
        hours: 8,
        reason: undefined,
      });
    });
  });

  it('Esc on a dirty dialog asks before discarding; Keep editing stays, Discard closes', async () => {
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(getMyBalance).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /request time off/i }));
    // Dirty the form — the reason field is part of the dirty predicate.
    await user.type(screen.getByLabelText(/reason/i), 'dentist');

    // Esc is intercepted: the discard confirm shows, the dialog survives.
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(screen.getByLabelText(/reason/i)).toBeInTheDocument();

    // Cancelling the confirm keeps the dialog (and the typed value).
    await user.click(screen.getByRole('button', { name: /keep editing/i }));
    await waitFor(() =>
      expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/reason/i)).toHaveValue('dentist');

    // Confirming the discard actually closes the dialog.
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: /^discard$/i }));
    await waitFor(() =>
      expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument(),
    );
  });

  it('Esc on a clean dialog closes without prompting', async () => {
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(getMyBalance).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /request time off/i }));
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument(),
    );
  });

  it('submit-close does not prompt to discard', async () => {
    vi.mocked(createMyRequest).mockClear();
    vi.mocked(createMyRequest).mockResolvedValue({
      request: {
        id: 'r1',
        associateId: 'a',
        associateName: 'Maria',
        category: 'VACATION',
        startDate: '2026-05-04',
        endDate: '2026-05-04',
        requestedMinutes: 480,
        reason: null,
        status: 'PENDING',
        reviewerUserId: null,
        reviewerEmail: null,
        reviewerNote: null,
        decidedAt: null,
        cancelledAt: null,
        createdAt: new Date().toISOString(),
      },
    });
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(getMyBalance).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /request time off/i }));
    // Dirty the form, then submit — the programmatic close after success
    // must NOT run through the discard guard.
    await user.type(screen.getByLabelText(/reason/i), 'dentist');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => expect(createMyRequest).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
  });

  it('Enter in a field submits the form-wrapped dialog', async () => {
    // No clearMocks config in this suite — reset the count so the earlier
    // submit tests can't satisfy the toHaveBeenCalledTimes below.
    vi.mocked(createMyRequest).mockClear();
    vi.mocked(createMyRequest).mockResolvedValue({
      request: {
        id: 'r1',
        associateId: 'a',
        associateName: 'Maria',
        category: 'VACATION',
        startDate: '2026-05-04',
        endDate: '2026-05-04',
        requestedMinutes: 480,
        reason: null,
        status: 'PENDING',
        reviewerUserId: null,
        reviewerEmail: null,
        reviewerNote: null,
        decidedAt: null,
        cancelledAt: null,
        createdAt: new Date().toISOString(),
      },
    });
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(getMyBalance).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /request time off/i }));
    await user.type(screen.getByLabelText(/reason/i), 'dentist{Enter}');

    await waitFor(() => expect(createMyRequest).toHaveBeenCalledTimes(1));
    expect(createMyRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'dentist' }),
    );
  });

  it('shows withdraw button for PENDING requests and not for APPROVED', async () => {
    vi.mocked(listMyRequests).mockResolvedValue({
      requests: [
        {
          id: 'r1',
          associateId: 'a',
          associateName: 'Maria',
          category: 'VACATION',
          startDate: '2026-05-04',
          endDate: '2026-05-04',
          requestedMinutes: 480,
          reason: null,
          status: 'PENDING',
          reviewerUserId: null,
          reviewerEmail: null,
          reviewerNote: null,
          decidedAt: null,
          cancelledAt: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'r2',
          associateId: 'a',
          associateName: 'Maria',
          category: 'VACATION',
          startDate: '2026-04-26',
          endDate: '2026-04-26',
          requestedMinutes: 480,
          reason: null,
          status: 'APPROVED',
          reviewerUserId: 'h',
          reviewerEmail: 'hr@altohr.com',
          reviewerNote: null,
          decidedAt: new Date().toISOString(),
          cancelledAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    vi.mocked(cancelMyRequest).mockResolvedValue({} as never);
    renderView();
    await waitFor(() => {
      expect(screen.getAllByText('Vacation · 8h')).toHaveLength(2);
    });
    // Only one Withdraw button (for the PENDING row). Exact-match the
    // accessible name so the "Withdrawn" status filter chip doesn't count.
    const withdrawButtons = screen.getAllByRole('button', { name: /^withdraw$/i });
    expect(withdrawButtons).toHaveLength(1);
  });
});
