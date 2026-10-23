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
  getTeamHome: vi.fn(),
  listReports: vi.fn(),
  listTeamTimesheets: vi.fn(),
  listTeamTimeOff: vi.fn(),
  bulkApproveTeamTimesheets: vi.fn(),
}));
// The role's own queue, the plan card and Hugo have their own tests; here they
// are stubs so the page's order and words are what is under test.
vi.mock('@/components/RoleDecisionQueue', () => ({
  RoleDecisionQueue: ({ hideWhenEmpty }: { hideWhenEmpty?: boolean }) =>
    hideWhenEmpty ? null : <div>Nothing needs you.</div>,
}));
vi.mock('@/components/MyPlanCard', () => ({ MyPlanCard: () => <div>my plan</div> }));
vi.mock('@/components/home/HugoSeat', () => ({ HugoSeat: () => null }));
const hours = vi.hoisted(() => ({ getTeamHours: vi.fn() }));
vi.mock('@/lib/attendanceInsightsApi', () => hours);

import { getTeamDashboard, getTeamHome, listReports, listTeamTimeOff, listTeamTimesheets, type TeamHome } from '@/lib/teamApi';
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

/** The company decision queue's rows (the shared ['me','decisions'] query the count reads). */
let queueRows: Array<{ key: string }> = [];

function renderPage(user: { firstName?: string; email: string } = { firstName: 'Dana', email: 'dana.reyes@example.com' }) {
  const caps = ROLE_CAPABILITIES.MANAGER;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['me', 'decisions'], { decisions: queueRows });
  render(
    <QueryClientProvider client={client}>
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

const emptyHome: TeamHome = {
  due: { reviews: [], oneOnOnes: [], probations: [], rampMilestones: [], documents: [], credentials: [], pips: [] },
  today: { shifts: [], onClock: [], out: [], celebrations: [] },
  suggestions: [],
};

beforeEach(() => {
  queueRows = [];
  hours.getTeamHours.mockResolvedValue({ weekStart: '2026-10-17', weekEnd: '2026-10-24', thresholdHours: 40, people: [] });
  vi.mocked(getTeamHome).mockResolvedValue(emptyHome);
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
  it('draws each report\u2019s hours this week against 40, naming who is heading into overtime', async () => {
    hours.getTeamHours.mockResolvedValue({
      weekStart: '2026-10-17',
      weekEnd: '2026-10-24',
      thresholdHours: 40,
      people: [
        { associateId: 'a-1', name: 'Ann Lee', workedHours: 30, scheduledHours: 16, projectedHours: 46, onClock: true },
        { associateId: 'a-2', name: 'Bo Chen', workedHours: 12, scheduledHours: 8, projectedHours: 20, onClock: false },
      ],
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Hours this week' })).toBeInTheDocument();
    expect(screen.getByText(/1 person is heading into overtime/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Ann Lee \(46h\)/ })).toBeInTheDocument();
  });

  it('leads with ONE counted "Needs you": the approvals ranked, the decision queue folded while they wait', async () => {
    renderPage();
    await screen.findByText('Timesheets to review');
    const heading = screen.getByRole('heading', { name: /Needs you/ });
    // The count is what is listed: two cards (timesheets, time off), no queue rows.
    expect(heading).toHaveTextContent('Needs you2');
    const section = heading.closest('section')!;
    expect(within(section).getByText('Time-off request waiting')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Approve all 2' })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing needs you/)).not.toBeInTheDocument();
    expect(screen.queryByText('Manager view')).not.toBeInTheDocument();
    expect(screen.queryByText(/Needs your approval/)).not.toBeInTheDocument();
  });

  it('counts the company queue’s rows with the cards — the number is what the section lists', async () => {
    queueRows = [{ key: 'claims:pending:x' }, { key: 'compliance:expired:y' }];
    renderPage();
    await screen.findByText('Timesheets to review');
    expect(screen.getByTestId('needs-you-count')).toHaveTextContent('4');
  });

  it('the snapshot follows: on the clock first, then today, out and due — no direct-reports tile, no repeats', async () => {
    renderPage();
    await screen.findByText('of 6 on your team');
    const snapshot = screen.getByRole('region', { name: 'Team snapshot' });
    const labels = within(snapshot)
      .getAllByText(/^(On the clock now|Scheduled today|Out today|Due this month|Direct reports)$/)
      .map((el) => el.textContent);
    expect(labels).toEqual(['On the clock now', 'Scheduled today', 'Out today', 'Due this month']);
    // Zeros say so in words, once: the sections they would repeat are gone.
    expect(within(snapshot).getByText('Everyone is in')).toBeInTheDocument();
    expect(within(snapshot).getByText('Nothing due this month')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Today on your team' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Due on your team' })).not.toBeInTheDocument();
    expect(screen.queryByText(/All clear/)).not.toBeInTheDocument();
    // The subtitle names the team.
    expect(screen.getByText('You have 6 direct reports on your team.')).toBeInTheDocument();
    // The queues are counted once, in Needs you — never again as tiles.
    expect(within(snapshot).queryByText('Pending timesheets')).not.toBeInTheDocument();
    expect(within(snapshot).queryByText('Pending time off')).not.toBeInTheDocument();
  });

  it('what is due on the team, today on the team, and the suggestions those add up to', async () => {
    vi.mocked(getTeamHome).mockResolvedValue({
      due: {
        ...emptyHome.due,
        reviews: [{ associateId: 'a-1', associateName: 'Ann Lee', lastPeriodEnd: '2025-06-30', overdueDays: 109 }],
        probations: [{ id: 'p1', associateId: 'a-2', associateName: 'Bo Chen', endDate: '2026-10-28' }],
      },
      today: {
        shifts: [{ id: 's1', associateId: 'a-1', associateName: 'Ann Lee', startsAt: '2026-10-17T13:00:00.000Z', endsAt: '2026-10-17T21:00:00.000Z', position: 'Cashier', location: 'Destin' }],
        onClock: [],
        out: [{ associateId: 'a-3', associateName: 'Cy Diaz', category: 'PTO', until: '2026-10-19' }],
        celebrations: [{ associateId: 'a-2', associateName: 'Bo Chen', kind: 'ANNIVERSARY', years: 3 }],
      },
      suggestions: [{ key: 'reviews', text: '1 review is more than a year old — schedule them.', link: '/performance', count: 1 }],
    });
    renderPage();
    expect(await screen.findByText('1 review is more than a year old — schedule them.')).toBeInTheDocument();
    const due = screen.getByRole('region', { name: 'Due on your team' });
    expect(within(due).getByText('Reviews due')).toBeInTheDocument();
    expect(within(due).getByText('Probation decisions')).toBeInTheDocument();
    const today = screen.getByRole('region', { name: 'Today on your team' });
    expect(within(today).getByText('Cy Diaz')).toBeInTheDocument();
    expect(within(today).getByText('3 years with us')).toBeInTheDocument();
    // Only the cards with something in them: no "Shifts today" padding when there are shifts…
    expect(within(today).getByText('Ann Lee')).toBeInTheDocument();
    // …and the tiles are the way into those sections, not a second copy of them.
    const snapshot = screen.getByRole('region', { name: 'Team snapshot' });
    expect(within(snapshot).getByText('Reviews, 1:1s, probations and expiries')).toBeInTheDocument();
    expect(within(snapshot).getByRole('button', { name: /Due this month/ })).toBeInTheDocument();
    expect(within(snapshot).getByRole('button', { name: /Out today/ })).toBeInTheDocument();
  });

  it('with nothing waiting, ONE all-clear line speaks for the section', async () => {
    vi.mocked(listTeamTimesheets).mockResolvedValue({ entries: [] });
    vi.mocked(listTeamTimeOff).mockResolvedValue({ requests: [] });
    renderPage();
    expect(await screen.findByText(/Your team is clear/)).toBeInTheDocument();
    // The queue's own "Nothing needs you." no longer stacks above it.
    expect(screen.queryByText(/Nothing needs you/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Needs you/ })).not.toHaveTextContent(/\d/);
  });

  it('a manager nobody reports to yet: one setup state leads, the empty team sections are gone', async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue({ directReports: 0, pendingTimesheets: 0, pendingTimeOff: 0, pendingReimbursements: 0, atRiskGoals: 0, onboardingInProgress: 0 });
    vi.mocked(listReports).mockResolvedValue({ reports: [] });
    vi.mocked(listTeamTimesheets).mockResolvedValue({ entries: [] });
    vi.mocked(listTeamTimeOff).mockResolvedValue({ requests: [] });
    renderPage();
    const setup = await screen.findByTestId('manager-no-team');
    expect(within(setup).getByText('You don’t have a team here yet')).toBeInTheDocument();
    expect(within(setup).getByRole('link', { name: 'Open My team' })).toHaveAttribute('href', '/team');
    expect(within(setup).getByRole('link', { name: 'Message HR' })).toHaveAttribute('href', '/messages');
    // It comes before Needs you, and nothing below repeats it as zeros.
    const needs = screen.getByRole('heading', { name: /Needs you/ });
    expect(setup.compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const name of ['Team snapshot', 'Today on your team', 'Due on your team', 'My team']) {
      expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
    }
    // No team to call "clear", and no jargon subtitle.
    expect(screen.queryByText(/Your team is clear/)).not.toBeInTheDocument();
    expect(screen.queryByText(/team-scoped/)).not.toBeInTheDocument();
  });

  it('greets by first name, and without one greets with no name at all', async () => {
    renderPage({ email: 'workforce@example.com' });
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).not.toHaveTextContent(/Workforce/);
    expect(h1).not.toHaveTextContent(',');
  });
});
