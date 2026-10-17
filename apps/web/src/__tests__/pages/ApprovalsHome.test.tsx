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
// Agent proposals: their own queue on this page ("agents propose, people decide").
vi.mock('@/lib/agentProposalsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/agentProposalsApi')>()),
  listMyProposals: vi.fn(async () => ({ approvals: [] })),
  decideProposal: vi.fn(),
}));

// Second-person requests (the approval engine): their own queue on this page.
vi.mock('@/lib/approvalRequestsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/approvalRequestsApi')>()),
  listApprovalRequests: vi.fn(async () => ({ requests: [] })),
  decideApprovalRequest: vi.fn(),
  cancelApprovalRequest: vi.fn(),
  listMyDelegations: vi.fn(async () => ({ given: [], covering: [] })),
}));

import {
  approveAdminRequest,
  listAdminRequests,
} from '@/lib/timeOffApi';
import { decideApprovalRequest, listApprovalRequests } from '@/lib/approvalRequestsApi';
import { listAdminSwaps, listOpenShiftClaims } from '@/lib/schedulingApi';
import { countAdminTimeEntries } from '@/lib/timeApi';
import { listMyProposals } from '@/lib/agentProposalsApi';
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

function renderPage(role: Role = 'HR_ADMINISTRATOR', initialPath = '/approvals') {
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
          <MemoryRouter initialEntries={[initialPath]}>
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
  vi.mocked(listMyProposals).mockResolvedValue({ approvals: [] });
  vi.mocked(listApprovalRequests).mockResolvedValue({ requests: [] });
});

const proposalFixture = {
  id: '33333333-3333-4333-8333-333333333333',
  workerId: '22222222-2222-4222-8222-222222222222',
  agentName: 'Workforce agent',
  agentFamily: 'workforce' as const,
  agentOwner: { id: 'u-hr', name: 'Dana Ortiz' },
  action: 'SHIFT_ASSIGN' as const,
  summary: 'Assign Tess Free to Housekeeper at The Grand Hotel, Oct 14 7:00 AM–3:00 PM. The open-shift broadcast went unanswered.',
  payload: {},
  status: 'PENDING' as const,
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  consumedAt: null,
  proposalId: 'p-1',
  capabilityKey: 'shift.fill',
  evidence: {
    why: 'Tess Free is placed at The Grand Hotel and is free.',
    alternatives: [{ label: 'Omar Busy', note: 'already on a shift that overlaps' }],
    impact: [{ label: 'Overtime', value: 'None expected' }],
    policy: "Shift assignment always needs a person's approval (platform rule).",
    affects: [{ kind: 'person' as const, id: 'a-1', name: 'Tess Free' }],
  },
  mayDecide: true,
};

const requestFixtureA = {
  id: '44444444-4444-4444-8444-444444444444',
  kind: 'PAY_RATE_CHANGE' as const,
  status: 'PENDING' as const,
  subjectType: 'Associate',
  subjectId: '55555555-5555-4555-8555-555555555555',
  title: 'Ana Lopez: $20.00 → $25.00 per hour',
  summary: 'merit, effective 2026-11-01',
  proposed: { associateId: '55555555-5555-4555-8555-555555555555', payType: 'HOURLY', amount: 25, reason: 'MERIT', effectiveFrom: '2026-11-01T00:00:00.000Z' },
  before: { payType: 'HOURLY', amount: 20 },
  requester: { id: '66666666-6666-4666-8666-666666666666', name: 'Hana Ruiz' },
  approverRule: { capability: 'manage:comp', userId: null, role: null },
  clientId: null,
  associateId: '55555555-5555-4555-8555-555555555555',
  decidedBy: null,
  decidedAt: null,
  reason: null,
  appliedAt: null,
  applyError: null,
  createdAt: new Date().toISOString(),
  mayDecide: true,
};

describe('<ApprovalsHome> second-person requests', () => {
  it('a pay change waiting on a second person is its own queue, shows before → after, and approving applies it', async () => {
    vi.mocked(listApprovalRequests).mockResolvedValue({ requests: [requestFixtureA] });
    vi.mocked(decideApprovalRequest).mockResolvedValue({ ...requestFixtureA, status: 'APPROVED', mayDecide: false, decidedBy: { id: 'u', name: 'You' }, decidedAt: new Date().toISOString(), appliedAt: new Date().toISOString() });
    renderPage('HR_ADMINISTRATOR', `/approvals?tab=requests&approval=${requestFixtureA.id}`);
    expect(await screen.findByText('Second person')).toBeInTheDocument();
    const card = await screen.findByTestId('approval-request-card');
    expect(card).toHaveTextContent('Ana Lopez: $20.00 → $25.00 per hour');
    expect(card).toHaveTextContent('$20.00 per hour');
    expect(card).toHaveTextContent('$25.00 per hour');
    expect(card).toHaveTextContent('Hana Ruiz');
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(decideApprovalRequest).toHaveBeenCalledWith(requestFixtureA.id, { decision: 'APPROVE' }));
    expect(await screen.findByText('Approved and applied')).toBeInTheDocument();
  });

  it('rejecting asks why before it is sent', async () => {
    vi.mocked(listApprovalRequests).mockResolvedValue({ requests: [requestFixtureA] });
    vi.mocked(decideApprovalRequest).mockResolvedValue({ ...requestFixtureA, status: 'REJECTED', mayDecide: false, reason: 'Out of band' });
    renderPage('HR_ADMINISTRATOR', '/approvals?tab=requests');
    await screen.findByTestId('approval-request-card');
    await userEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    expect(screen.getByRole('button', { name: /confirm rejection/i })).toBeDisabled();
    await userEvent.type(screen.getByTestId('approval-reject-reason'), 'Out of band');
    await userEvent.click(screen.getByRole('button', { name: /confirm rejection/i }));
    await waitFor(() => expect(decideApprovalRequest).toHaveBeenCalledWith(requestFixtureA.id, { decision: 'REJECT', reason: 'Out of band' }));
  });
});

describe('<ApprovalsHome> agent proposals', () => {
  it('a proposal waiting on the supervisor is its own queue, counted, and opens with its evidence from ?tab=proposals&proposal=', async () => {
    vi.mocked(listMyProposals).mockResolvedValue({ approvals: [proposalFixture] });
    renderPage('SHIFT_SUPERVISOR', `/approvals?tab=proposals&proposal=${proposalFixture.id}`);
    // The queue tile with its count…
    expect(await screen.findByText('Agent proposals')).toBeInTheDocument();
    expect(await screen.findByText('1 decision waiting.')).toBeInTheDocument();
    // …and the open item: the card with the proposal, the evidence and the decision.
    expect(await screen.findByRole('heading', { name: /Assign Tess Free to Housekeeper/ })).toBeInTheDocument();
    expect(screen.getByText(/Tess Free is placed at The Grand Hotel/)).toBeInTheDocument();
    expect(screen.getByText('Omar Busy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });
});

describe('<ApprovalsHome>', () => {
  it('with every queue empty: one clear state, the tiles, and no empty cards', async () => {
    renderPage();
    expect(screen.getByText('Approvals')).toBeInTheDocument();
    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument();
    // The timesheet tile still carries its count and opens the review queue.
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('Review on Time & attendance').closest('a')).toHaveAttribute(
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
