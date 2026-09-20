import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '@/lib/confirm';
import { ROLE_CAPABILITIES, type Capability, type Role, type TimeOffRequest } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

// The unconfirmed-shifts panel is integration-tested with the scheduling
// page; the swap/pickup panels are now ApprovalsHome-local, so their API
// calls are mocked below instead.
vi.mock('@/pages/scheduling/AdminApprovalPanels', () => ({
  AdminUnconfirmedPanel: () => null,
}));
vi.mock('@/lib/timeOffApi', () => ({
  listAdminRequests: vi.fn(),
  approveAdminRequest: vi.fn(),
  denyAdminRequest: vi.fn(),
  bulkDecideRequests: vi.fn(),
}));
vi.mock('@/lib/schedulingApi', () => ({
  listAdminSwaps: vi.fn(),
  listOpenShiftClaims: vi.fn(),
  managerApproveSwap: vi.fn(),
  managerRejectSwap: vi.fn(),
  approveOpenShiftClaim: vi.fn(),
  rejectOpenShiftClaim: vi.fn(),
}));
vi.mock('@/lib/timeApi', () => ({
  countAdminTimeEntries: vi.fn(),
  listClockInRequests: vi.fn(async () => ({ requests: [] })),
  approveClockInRequest: vi.fn(),
  denyClockInRequest: vi.fn(),
}));

import {
  approveAdminRequest,
  listAdminRequests,
} from '@/lib/timeOffApi';
import { listAdminSwaps, listOpenShiftClaims } from '@/lib/schedulingApi';
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

function renderPage(role: Role = 'HR_ADMINISTRATOR') {
  // Fresh client per render so cached lists never leak between tests;
  // retry off so mocked failures surface immediately.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      email: 'someone@altohr.com',
      role,
      status: 'ACTIVE' as const,
      clientId: role === 'SHIFT_SUPERVISOR' ? 'c1' : null,
      associateId: null,
    },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        {/* main.tsx wraps the whole app in this; approving past a balance
            asks for a reason through it. */}
        <ConfirmProvider>
          <MemoryRouter>
            <ApprovalsHome />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

const claimFixture = {
  id: 'claim-1',
  shiftId: 'shift-1',
  associateId: 'assoc-9',
  associateName: 'Victor Diaz',
  shiftPosition: 'Front Desk',
  shiftClientName: 'Coastal Resort Holdings',
  // "Now", so the relative day is "Today" at any hour the suite runs
  // (+3h read "Tomorrow" after 9 PM).
  shiftStartsAt: new Date().toISOString(),
  status: 'PENDING',
  wouldExceed40h: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAdminRequests).mockResolvedValue({ requests: [] });
  vi.mocked(listAdminSwaps).mockResolvedValue({
    requests: [],
  } as unknown as Awaited<ReturnType<typeof listAdminSwaps>>);
  vi.mocked(listOpenShiftClaims).mockResolvedValue({
    claims: [],
  } as unknown as Awaited<ReturnType<typeof listOpenShiftClaims>>);
  vi.mocked(countAdminTimeEntries).mockResolvedValue({ count: 3 });
});

describe('<ApprovalsHome>', () => {
  it('with every queue empty: one clear state, the tiles, and no empty cards', async () => {
    renderPage();
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument();
    // The timesheet tile still carries its count and opens the review queue.
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('Timesheets', { selector: 'div' }).closest('a')).toHaveAttribute(
      'href',
      '/time-attendance?tab=queue',
    );
    // Empty queues don't render a card of their own.
    expect(screen.queryByRole('heading', { name: /^Swaps/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Open-shift pickups/ })).not.toBeInTheDocument();
  });

  it('a queue with work renders as a card with the face, the count and a relative time', async () => {
    vi.mocked(listOpenShiftClaims).mockResolvedValue({
      claims: [claimFixture],
    } as unknown as Awaited<ReturnType<typeof listOpenShiftClaims>>);
    renderPage();
    expect(await screen.findByRole('heading', { name: /Open-shift pickups/ })).toBeInTheDocument();
    expect(await screen.findByText(/1 decision waiting/)).toBeInTheDocument();
    expect(screen.getByText(/Today · /)).toBeInTheDocument();
    // An org-wide approver sees which client the shift belongs to…
    expect(screen.getByText(/Coastal Resort Holdings · Today/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing waiting on you')).not.toBeInTheDocument();
  });

  it("a store-bound supervisor's rows drop the client they never leave", async () => {
    vi.mocked(listOpenShiftClaims).mockResolvedValue({
      claims: [claimFixture],
    } as unknown as Awaited<ReturnType<typeof listOpenShiftClaims>>);
    renderPage('SHIFT_SUPERVISOR');
    expect(await screen.findByRole('heading', { name: /Open-shift pickups/ })).toBeInTheDocument();
    expect(screen.queryByText(/Coastal Resort Holdings/)).not.toBeInTheDocument();
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
