import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability, type HeadcountOverview, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/headcount110Api', () => ({
  getHeadcountOverview: vi.fn(),
  getTurnover: vi.fn(),
}));
vi.mock('@/lib/brandingApi', () => ({
  getOrgBranding: vi.fn(),
  patchOrgBranding: vi.fn(),
}));

import { getHeadcountOverview, getTurnover } from '@/lib/headcount110Api';
import { patchOrgBranding } from '@/lib/brandingApi';
import { HeadcountHome } from '@/pages/headcount/HeadcountHome';

function overview(over: Partial<HeadcountOverview> = {}): HeadcountOverview {
  return {
    asOf: '2026-10-13T12:00:00.000Z',
    windowDays: 14,
    active: 1234,
    scheduledThisWeek: 980,
    onPayrollLastPeriod: { count: 1210, periodStart: '2026-09-26', periodEnd: '2026-10-02', finalizedOn: '2026-10-05' },
    inHousing: null,
    notActive: { employedNotPlaced: 12, placedNoRecentWork: 40, separated: 300, deactivated: 7, onboarding: 25 },
    byClient: [{ id: 'c1', name: 'Coastal Resort', active: 800, scheduledThisWeek: 640, withoutRate: null }],
    byStore: [{ id: 'l1', name: 'Destin', clientName: 'Coastal Resort', active: 500, scheduledThisWeek: 400, withoutRate: null }],
    byDepartment: [{ id: 'd1', name: 'Housekeeping', active: 700 }],
    byEmploymentType: [{ employmentType: 'W2_EMPLOYEE', active: 1100 }],
    reconciliation: null,
    ...over,
  };
}

function renderPage(role: Role = 'HR_ADMINISTRATOR') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'x@example.com', role, status: 'ACTIVE' },
          loading: false,
          can: (c: Capability) => caps.has(c),
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/headcount']}>
          <HeadcountHome />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getHeadcountOverview).mockResolvedValue(overview());
  vi.mocked(getTurnover).mockResolvedValue({ days: 90, hires: 50, terminations: 20, netChange: 30, annualizedTurnoverRate: 6.5, currentActive: 1234 });
  vi.mocked(patchOrgBranding).mockResolvedValue({} as never);
});

describe('HeadcountHome', () => {
  it('shows the active count as the hero with the window from the overview', async () => {
    renderPage();
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    // "Working": one of the two named numbers every page shows (F500 SH-4).
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByText('Worked in the last 14 days or scheduled ahead')).toBeInTheDocument();
    // The definition rides the number's tooltip, not the subtitle (F500 G1).
    expect(screen.getByText("Who's working, where, and how that's changing.")).toBeInTheDocument();
    // The companions beside the hero.
    expect(screen.getByText('980')).toBeInTheDocument();
    // The last payroll run, named and dated — not "last period" (F500 G1).
    // Paychecks in that run, said with their unit ("Last payroll run 0" read as zero of nothing).
    expect(screen.getByText('Paid in the last payroll')).toBeInTheDocument();
    expect(screen.getByText('1,210')).toBeInTheDocument();
    expect(screen.getByText('paychecks')).toBeInTheDocument();
    expect(screen.getByText('Sep 26 – Oct 2, 2026 · finalized Oct 5')).toBeInTheDocument();
    // Headcount plan is a sibling page, not a button.
    expect(screen.getByRole('link', { name: 'Headcount plan' })).toHaveAttribute('href', '/headcount/plan');
    // No housing link: no "In housing" tile at all (a dash said nothing; F500 G1).
    expect(screen.queryByText('In housing')).not.toBeInTheDocument();
    // Turnover rides its own query keyed on the window.
    expect(screen.getByText('6.5%')).toBeInTheDocument();
    expect(getTurnover).toHaveBeenCalledWith(90);
  });

  it('says when no reconciliation has run, and shows the variances when one has', async () => {
    const { unmount } = renderPage();
    expect(await screen.findByText(/No reconciliation yet/)).toBeInTheDocument();
    // Plain words for the people reading it — never a script to run.
    expect(screen.queryByText(/scripts\/reconcile-payroll/)).toBeNull();
    unmount();

    vi.mocked(getHeadcountOverview).mockResolvedValue(
      overview({
        reconciliation: {
          periodStart: '2026-09-26',
          periodEnd: '2026-10-02',
          ranAt: '2026-10-05T14:00:00.000Z',
          platformActive: 1234,
          platformPaid: 1210,
          payrollPaid: 1207,
          headcountVariance: 3,
          hoursVariance: -2.5,
          grossVariance: null,
          varianceLines: 4,
          payrollProvided: true,
        },
      }),
    );
    renderPage();
    expect(await screen.findByText('4 variance lines.')).toBeInTheDocument();
    expect(screen.getByTestId('variance-headcount')).toHaveTextContent('+3');
    expect(screen.getByTestId('variance-hours')).toHaveTextContent('-2.5h');
    expect(screen.getByTestId('variance-gross')).toHaveTextContent('—');
    expect(screen.getByText('1,207')).toBeInTheDocument();
  });

  it('explains a Working count below the scheduled one', async () => {
    vi.mocked(getHeadcountOverview).mockResolvedValue(overview({ active: 0, scheduledThisWeek: 2, scheduledNotWorking: 2 }));
    renderPage();
    expect(await screen.findByText("2 scheduled this week haven't worked in 14 days")).toBeInTheDocument();
  });

  it('says plainly when no payroll has run', async () => {
    vi.mocked(getHeadcountOverview).mockResolvedValue(overview({ onPayrollLastPeriod: null }));
    renderPage();
    expect(await screen.findByText('No payroll run yet')).toBeInTheDocument();
  });

  it('lets manage:org change the activity window from the header and PATCHes the org setting', async () => {
    const user = userEvent.setup();
    renderPage('HR_ADMINISTRATOR');
    // Not a form in the middle of the page: a header action opens it.
    expect(screen.queryByLabelText('Activity window (days)')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Activity window/ }));
    const input = (await screen.findByLabelText('Activity window (days)')) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveValue(14));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.clear(input);
    await user.type(input, '21');
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(patchOrgBranding).toHaveBeenCalledWith({ activeWindowDays: 21 }));
    expect(getHeadcountOverview).toHaveBeenCalledTimes(2);
  });

  it('gives a read-only role no window control; the tile names the window', async () => {
    renderPage('FINANCE_ACCOUNTANT');
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('Worked in the last 14 days or scheduled ahead')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Activity window/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Activity window (days)')).not.toBeInTheDocument();
  });

  it('lists the not-active reasons plainly and cuts the grid by store or client', async () => {
    const user = userEvent.setup();
    renderPage();
    // The People directory's words, each a link to the people it counts (F500 SH-4).
    expect(await screen.findByRole('link', { name: 'No recent shifts' })).toHaveAttribute('href', '/people?workStatus=PLACED_NOT_ACTIVE');
    expect(screen.getByRole('link', { name: 'Not placed' })).toHaveAttribute('href', '/people?workStatus=NOT_PLACED');
    expect(screen.getByText('Destin')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'By client' }));
    expect(await screen.findByRole('link', { name: 'Coastal Resort' })).toHaveAttribute('href', '/clients/c1');
  });
});
