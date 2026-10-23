import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import type { DirectReport, TeamDashboard } from '@/lib/teamApi';

vi.mock('@/lib/teamApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/teamApi')>()),
  getTeamDashboard: vi.fn(),
  getTeamInbox: vi.fn(),
  listReports: vi.fn(),
  listTeamTimesheets: vi.fn(),
  listTeamTimeOff: vi.fn(),
}));
vi.mock('@/lib/delegationsApi', () => ({ getMyDelegations: vi.fn().mockResolvedValue({ received: [], given: [], today: '2026-10-14' }) }));

import { getTeamDashboard, getTeamInbox, listReports, listTeamTimeOff, listTeamTimesheets } from '@/lib/teamApi';
import { TeamHome } from '@/pages/team/TeamHome';

/**
 * My team (F500 2026-10-22): the manager's landing page shows the team in
 * numbers, says plainly when no one reports to them, and keeps its tab in
 * the URL so /team?tab=timesheets lands on Timesheets.
 */

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function renderPage(path = '/team', role: Role = 'MANAGER', without: Capability[] = []) {
  const caps = new Set<Capability>([...ROLE_CAPABILITIES[role]].filter((c) => !without.includes(c)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'm@example.com', role, status: 'ACTIVE' as const, clientId: null, associateId: 'me' },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <TeamHome />
            <Where />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const dashboard: TeamDashboard = {
  directReports: 3,
  pendingTimesheets: 2,
  pendingTimeOff: 1,
  pendingReimbursements: 0,
  atRiskGoals: 0,
  onboardingInProgress: 0,
  team: {
    weekStart: '2026-10-10',
    weekEnd: '2026-10-17',
    onClockNow: 1,
    scheduledToday: 2,
    hoursWorked: 45.8,
    hoursScheduled: 14,
    lateOrNoShow7d: 2,
    lateOrNoShowPeople7d: 1,
    overtimeRisk: 1,
    overtimeThresholdHours: 40,
  },
};

const report = (id: string, first: string, week: DirectReport['week']): DirectReport => ({
  id,
  firstName: first,
  lastName: 'Reyes',
  email: `${first.toLowerCase()}@example.com`,
  phone: null,
  employmentType: 'W2',
  departmentName: null,
  jobTitle: null,
  lastOneOnOneAt: null,
  nextOneOnOne: null,
  week,
});

beforeEach(() => {
  vi.mocked(getTeamDashboard).mockResolvedValue(dashboard);
  vi.mocked(getTeamInbox).mockResolvedValue({ items: [], total: 0 } as never);
  vi.mocked(listReports).mockResolvedValue({
    reports: [
      report('a', 'Ana', { workedHours: 42, projectedHours: 44, onClock: true, lateOrNoShow7d: 0 }),
      report('b', 'Ben', { workedHours: 3.8, projectedHours: 7.8, onClock: false, lateOrNoShow7d: 2 }),
    ],
  });
  vi.mocked(listTeamTimesheets).mockResolvedValue({ entries: [] } as never);
  vi.mocked(listTeamTimeOff).mockResolvedValue({ requests: [] } as never);
});

describe('My team', () => {
  it('shows the team in numbers, each linking to the list behind it', async () => {
    renderPage();
    const strip = await screen.findByRole('group', { name: 'Your team this week' });
    const tile = (label: string) => within(strip).getByText(label).closest('a')!;
    expect(tile('On the clock')).toHaveAttribute('href', '/team?tab=reports');
    expect(within(tile('On the clock')).getByText('2 scheduled today')).toBeInTheDocument();
    expect(within(tile('Hours this week')).getByText('45.8 h')).toBeInTheDocument();
    expect(within(tile('Hours this week')).getByText('of 14 h scheduled')).toBeInTheDocument();
    expect(tile('Hours this week')).toHaveAttribute('href', '/team?tab=timesheets');
    expect(within(tile('Late or no-show · 7 days')).getByText('1 person')).toBeInTheDocument();
    expect(within(tile('Overtime risk')).getByText('On track for more than 40 h this week')).toBeInTheDocument();
    // The pending counts moved to the header facts and the tab badges.
    const facts = screen.getByTestId('page-facts');
    expect(within(facts).getByText('Direct reports').nextElementSibling).toHaveTextContent('3');
    expect(within(facts).getByText('Waiting on you').nextElementSibling).toHaveTextContent('3');
  });

  it('says so plainly when no one reports to you — no zero tiles, no "Inbox zero"', async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue({ ...dashboard, directReports: 0, pendingTimesheets: 0, pendingTimeOff: 0, team: undefined });
    renderPage('/team', 'MANAGER', ['manage:org']);
    expect(await screen.findByText('No one reports to you yet')).toBeInTheDocument();
    expect(screen.getByText(/Ask HR to set reporting lines/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Your team this week' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Inbox' })).toHaveAttribute('href', '/inbox');
    // Without manage:org there is no door to set them.
    expect(screen.queryByRole('link', { name: 'Set reporting lines' })).not.toBeInTheDocument();
  });

  it('offers to set reporting lines to someone who manages the org', async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue({ ...dashboard, directReports: 0, team: undefined });
    renderPage('/team', 'MANAGER');
    expect(await screen.findByRole('link', { name: 'Set reporting lines' })).toHaveAttribute('href', '/org/chart');
  });

  it('opens the tab named in the URL, and writes the tab it switches to', async () => {
    renderPage('/team?tab=reports');
    expect(await screen.findByRole('tab', { name: /Reports/, selected: true })).toBeInTheDocument();
    // Each report's week: worked → on track for, and lates over seven days.
    expect(await screen.findByText('Ana Reyes')).toBeInTheDocument();
    expect(screen.getAllByText('On the clock').length).toBeGreaterThan(0);
    expect(screen.getByText('→ 44 h')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Timesheets/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/team?tab=timesheets');
  });

  it('points an empty team inbox at the company Inbox', async () => {
    renderPage();
    expect(await screen.findByText('Nothing from your team is waiting')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Inbox' })).toHaveAttribute('href', '/inbox');
  });
});
