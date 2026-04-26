import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
    <AuthContext.Provider value={value}>
      <MemoryRouter>
        <AssociateTimeOffView />
      </MemoryRouter>
    </AuthContext.Provider>
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
    await user.type(screen.getByLabelText(/start date/i), '2026-05-04');
    await user.type(screen.getByLabelText(/end date/i), '2026-05-04');
    // hours defaults to 8.
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
    // Only one Withdraw button (for the PENDING row).
    const withdrawButtons = screen.getAllByRole('button', { name: /withdraw/i });
    expect(withdrawButtons).toHaveLength(1);
  });
});
