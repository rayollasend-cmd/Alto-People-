import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimeOffRequest } from '@alto-people/shared';

// The scheduling panels are integration-tested with the scheduling page;
// here they'd drag in the whole admin scheduling API surface, so stub them.
vi.mock('@/pages/scheduling/AdminApprovalPanels', () => ({
  AdminSwapsPanel: () => <div data-testid="swaps-panel" />,
  AdminPickupPanel: () => <div data-testid="pickup-panel" />,
  AdminUnconfirmedPanel: () => null,
}));
vi.mock('@/lib/timeOffApi', () => ({
  listAdminRequests: vi.fn(),
  approveAdminRequest: vi.fn(),
  denyAdminRequest: vi.fn(),
}));
vi.mock('@/lib/timeApi', () => ({
  countAdminTimeEntries: vi.fn(),
}));

import {
  approveAdminRequest,
  listAdminRequests,
} from '@/lib/timeOffApi';
import { countAdminTimeEntries } from '@/lib/timeApi';
import { ApprovalsHome } from '@/pages/approvals/ApprovalsHome';

const requestFixture: TimeOffRequest = {
  id: 'e2a3a3f0-0000-4000-8000-000000000001',
  associateId: 'e2a3a3f0-0000-4000-8000-000000000002',
  associateName: 'Maria Lopez',
  category: 'PTO',
  startDate: '2026-07-10',
  endDate: '2026-07-11',
  requestedMinutes: 960,
  reason: 'Family trip',
  status: 'PENDING',
  reviewerUserId: null,
  reviewerEmail: null,
  reviewerNote: null,
  decidedAt: null,
  cancelledAt: null,
  createdAt: new Date().toISOString(),
} as TimeOffRequest;

function renderPage() {
  // Fresh client per render so cached lists never leak between tests;
  // retry off so mocked failures surface immediately.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ApprovalsHome />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAdminRequests).mockResolvedValue({ requests: [] });
  vi.mocked(countAdminTimeEntries).mockResolvedValue({ count: 3 });
});

describe('<ApprovalsHome>', () => {
  it('renders every queue plus the timesheet KPI', async () => {
    renderPage();
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(screen.getByTestId('swaps-panel')).toBeInTheDocument();
    expect(screen.getByTestId('pickup-panel')).toBeInTheDocument();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(
      await screen.findByText(/No time-off requests waiting/)
    ).toBeInTheDocument();
  });

  it('lists pending time off and approves on tap', async () => {
    vi.mocked(listAdminRequests).mockResolvedValue({
      requests: [requestFixture],
    });
    vi.mocked(approveAdminRequest).mockResolvedValue({
      request: { ...requestFixture, status: 'APPROVED' },
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => {
      expect(approveAdminRequest).toHaveBeenCalledWith(requestFixture.id);
    });
    // The queue refetches after a decision so the row disappears.
    expect(listAdminRequests).toHaveBeenCalledTimes(2);
  });
});
