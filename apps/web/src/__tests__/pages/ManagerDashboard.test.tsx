import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import type { TeamTimeEntry, TeamTimeOffRequest } from '@/lib/teamApi';

vi.mock('@/lib/teamApi', () => ({
  getTeamDashboard: vi.fn(),
  listReports: vi.fn(),
  listTeamTimesheets: vi.fn(),
  listTeamTimeOff: vi.fn(),
  bulkApproveTeamTimesheets: vi.fn(),
}));
// The role's own queue, the plan card and Hugo have their own tests; here they
// are stubs so the page's order and words are what is under test.
vi.mock('@/components/RoleDecisionQueue', () => ({
  RoleDecisionQueue: ({ hideWhenEmpty }: { hideWhenEmpty?: boolean }) =>
    hideWhenEmpty ? null : <div>All systems nominal — nothing needs your decision.</div>,
}));
vi.mock('@/components/MyPlanCard', () => ({ MyPlanCard: () => <div>my plan</div> }));
vi.mock('@/components/home/HugoSeat', () => ({ HugoSeat: () => null }));

import { getTeamDashboard, listReports, listTeamTimeOff, listTeamTimesheets } from '@/lib/teamApi';
import { ManagerDashboard } from '@/pages/ManagerDashboard';

const entry = (id: string, status: TeamTimeEntry['status']): TeamTimeEntry => ({
  id,
  associateId: `a-${id}`,
  associateName: 'Ann Lee',
  clientId: null,
  clientName: null,
  clockInAt: '2026-10-15T13:00:00.000Z',
  clockOutAt: status === 'ACTIVE' ? null : '2026-10-15T21:00:00.000Z',
  status,
  notes: null,
  rejectionReason: null,
  payRate: null,
});
const request = (id: string): TeamTimeOffRequest => ({
  id,
  associateId: `a-${id}`,
  associateName: 'Ann Lee',
  category: 'PTO',
  startDate: '2026-10-20',
  endDate: '2026-10-21',
  requestedMinutes: 480,
  reason: null,
  status: 'PENDING',
  reviewerEmail: null,
});

function renderPage(user: { firstName?: string; email: string } = { firstName: 'Dana', email: 'dana.reyes@example.com' }) {
  const caps = ROLE_CAPABILITIES.MANAGER;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', ...user, role: 'MANAGER', status: 'ACTIVE' as const, clientId: null, associateId: 'me' },
          role: 'MANAGER',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter>
            <ManagerDashboard />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getTeamDashboard).mockResolvedValue({
    directReports: 6,
    pendingTimesheets: 2,
    pendingTimeOff: 1,
    pendingReimbursements: 0,
    atRiskGoals: 0,
    onboardingInProgress: 0,
  });
  vi.mocked(listReports).mockResolvedValue({
    reports: [
      { id: 'a-1', firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: null, employmentType: 'W2', departmentName: null, jobTitle: 'Cashier' },
    ],
  });
  vi.mocked(listTeamTimesheets).mockImplementation(async (status: string) => ({
    entries: status === 'COMPLETED' ? [entry('t1', 'COMPLETED'), entry('t2', 'COMPLETED')] : status === 'ACTIVE' ? [entry('t3', 'ACTIVE')] : [],
  }));
  vi.mocked(listTeamTimeOff).mockImplementation(async (status: string) => ({
    requests: status === 'PENDING' ? [request('r1')] : [],
  }));
});

describe('<ManagerDashboard>', () => {
  it('leads with ONE counted "Needs you": the approvals ranked, the decision queue folded while they wait', async () => {
    renderPage();
    await screen.findByText('Timesheets to review');
    const heading = screen.getByRole('heading', { name: /Needs you/ });
    expect(heading).toHaveTextContent('Needs you3');
    const section = heading.closest('section')!;
    expect(within(section).getByText('Time-off request waiting')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Approve all 2' })).toBeInTheDocument();
    expect(screen.queryByText(/All systems nominal/)).not.toBeInTheDocument();
    expect(screen.queryByText('Manager view')).not.toBeInTheDocument();
    expect(screen.queryByText(/Needs your approval/)).not.toBeInTheDocument();
  });

  it('the snapshot follows: on the clock first, direct reports last, time off without a hyphen', async () => {
    renderPage();
    await screen.findByText('1 of 6');
    const snapshot = screen.getByRole('region', { name: 'Team snapshot' });
    const labels = within(snapshot)
      .getAllByText(/On the clock now|Pending timesheets|Pending time off|Direct reports/)
      .map((el) => el.textContent);
    expect(labels).toEqual(['On the clock now', 'Pending timesheets', 'Pending time off', 'Direct reports']);
  });

  it('with nothing waiting, the decision queue speaks for the section', async () => {
    vi.mocked(listTeamTimesheets).mockResolvedValue({ entries: [] });
    vi.mocked(listTeamTimeOff).mockResolvedValue({ requests: [] });
    renderPage();
    expect(await screen.findByText(/All systems nominal/)).toBeInTheDocument();
    expect(screen.getByText(/Inbox zero/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Needs you/ })).not.toHaveTextContent(/\d/);
  });

  it('greets by first name, and without one greets with no name at all', async () => {
    renderPage({ email: 'workforce@example.com' });
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).not.toHaveTextContent(/Workforce/);
    expect(h1).not.toHaveTextContent(',');
  });
});
