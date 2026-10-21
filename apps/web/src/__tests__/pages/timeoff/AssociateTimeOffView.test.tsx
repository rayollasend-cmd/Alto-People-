import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/schedulingApi', () => ({
  listMyShifts: vi.fn(),
}));

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
import { listMyShifts } from '@/lib/schedulingApi';
import { AssociateTimeOffView, defaultCategory } from '@/pages/timeoff/AssociateTimeOffView';

function renderView(path = '/time-off') {
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
        <MemoryRouter initialEntries={[path]}>
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
  vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] } as never);
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
        // The category starts on the one with time in it.
        category: 'SICK',
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

describe('<AssociateTimeOffView> form defaults', () => {
  it('starts on the category with time in it, vacation when none has any', () => {
    expect(defaultCategory([{ category: 'SICK', balanceMinutes: 240 }, { category: 'VACATION', balanceMinutes: 0 }] as never)).toBe('SICK');
    expect(defaultCategory([{ category: 'SICK', balanceMinutes: 0 }] as never)).toBe('VACATION');
    expect(defaultCategory(null)).toBe('VACATION');
  });

  it('starts tomorrow', async () => {
    const user = userEvent.setup();
    renderView();
    await waitFor(() => expect(getMyBalance).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /request time off/i }));
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const tomorrow = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(screen.getByLabelText(/start date/i)).toHaveValue(tomorrow);
  });

  it('a shift card’s "Request this shift off" opens on that day with the shift’s hours', async () => {
    // A Saturday 7:00–13:30 shift (paid 5.5 h after its unpaid meal break),
    // on a day the weekday count would call zero.
    vi.mocked(listMyShifts).mockResolvedValue({
      shifts: [
        {
          id: 's1',
          status: 'ASSIGNED',
          startsAt: new Date(2026, 10, 7, 7, 0).toISOString(),
          endsAt: new Date(2026, 10, 7, 13, 30).toISOString(),
        },
      ],
    } as never);
    vi.mocked(createMyRequest).mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderView('/time-off?new=1&date=2026-11-07&shift=s1');
    expect(await screen.findByDisplayValue('2026-11-07')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('spinbutton')).toHaveValue(5.5));
    expect(screen.getByText(/hours from your schedule/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() =>
      expect(createMyRequest).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-11-07', endDate: '2026-11-07', hours: 5.5 })),
    );
  });
});
