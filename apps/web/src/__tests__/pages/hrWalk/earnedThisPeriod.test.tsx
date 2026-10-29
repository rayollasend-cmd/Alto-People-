import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';

/**
 * Floor walk 26 / ASSOC-3, -4, -27: the associate home's pay-period ring —
 * what this pay period has earned so far, the one take-home estimate, and
 * the day of the period, all from GET /time/me/earnings `period` (counted on
 * the company's day), so Home, My time and Pay read the same numbers.
 */

vi.mock('@/lib/timeApi', () => ({
  getActiveTimeEntry: vi.fn().mockResolvedValue(null),
  listMyTimeEntries: vi.fn(),
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  tryGetGeolocation: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/schedulingApi', () => ({
  listMyShifts: vi.fn().mockResolvedValue({ shifts: [] }),
  getMyShiftDetail: vi.fn(),
  acknowledgeMyShift: vi.fn(),
}));
vi.mock('@/lib/qualApi', () => ({ listOpenShifts: vi.fn().mockResolvedValue({ shifts: [] }) }));
vi.mock('@/lib/payrollApi', () => ({
  listMyPayrollItems: vi.fn().mockResolvedValue({ items: [] }),
  getMyNextPayday: vi.fn().mockResolvedValue({ nextPayday: null }),
}));
vi.mock('@/lib/timeOffApi', () => ({ getMyBalance: vi.fn().mockResolvedValue({ balances: [] }) }));
vi.mock('@/lib/inboxApi', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    getInbox: vi.fn(),
    INBOX_QUERY_KEY: ['inbox'],
    useInbox: () => useQuery({ queryKey: ['inbox'], queryFn: () => ({ total: 0, sources: [] }) }),
  };
});
vi.mock('@/lib/lms94Api', () => ({ getMyTraining: vi.fn().mockResolvedValue({ enrollments: [] }) }));
vi.mock('@/lib/emergencyApi', () => ({
  getMyEmergency: vi.fn().mockResolvedValue({ emergency: null, checkIn: null }),
  emergencyCheckIn: vi.fn(),
}));
vi.mock('@/lib/onboardingApi', () => ({
  listApplications: vi.fn().mockResolvedValue({ applications: [], total: 0, page: 1, pageSize: 50 }),
}));
const earningsState: { data: unknown } = { data: undefined };
vi.mock('@/components/EarningsCard', () => ({
  EarningsCard: () => null,
  useMyEarnings: () => ({ data: earningsState.data, dataUpdatedAt: 0, isSuccess: true }),
  useTickSeconds: () => 0,
}));

import { AssociateDashboard } from '@/pages/AssociateDashboard';

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const caps = new Set<Capability>(['view:dashboard']);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: { id: 'u1', email: 'maria@example.com', role: 'ASSOCIATE', status: 'ACTIVE', clientId: null, associateId: 'a1' } as never,
            role: 'ASSOCIATE',
            primaryRole: 'ASSOCIATE',
            availableRoles: ['ASSOCIATE'],
            capabilities: caps,
            tenant: DEFAULT_TENANT,
            signIn: vi.fn(),
            submitMfaChallenge: vi.fn(),
            signOut: vi.fn(),
            refreshUser: vi.fn(),
            switchRole: vi.fn(),
            can: (c: Capability) => caps.has(c),
          }}
        >
          <AssociateDashboard />
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const period = (over: Record<string, unknown> = {}) => ({
  start: '2026-10-24',
  end: '2026-11-06',
  payDate: '2026-11-13',
  today: '2026-10-29',
  day: 6,
  days: 14,
  workedHours: 23.43,
  earned: 351.45,
  takeHome: { gross: 351.45, taxes: 26.84, deductions: 0, advances: 0, net: 324.61, basis: 'W4' },
  ...over,
});

describe('<AssociateDashboard> — earned this pay period', () => {
  it('reads the server’s period: its money, hours, take-home and the company’s day of it', async () => {
    earningsState.data = { hourlyRate: 15, onClock: false, period: period() };
    renderHome();
    const card = await screen.findByTestId('earned-this-period');
    expect(card).toHaveTextContent('$351.45');
    expect(card).toHaveTextContent('23.43h worked');
    expect(card).toHaveTextContent('About $324.61 after taxes');
    expect(card).toHaveTextContent('Earned this pay period');
    // The company's day (Thursday, day 6), never the phone's — a phone in LA at 11 PM read "Day 5".
    expect(screen.getByRole('meter', { name: 'Day 6 of 14' })).toBeInTheDocument();
  });

  it('is hidden when there is no pay schedule to measure a period by', async () => {
    earningsState.data = { hourlyRate: 15, onClock: false, period: null };
    renderHome();
    // No shifts ahead: the 14-day strip is one line (F500 G5) — the page has rendered.
    expect(await screen.findByTestId('next-14-none')).toHaveTextContent('No shifts in the next 14 days.');
    expect(screen.queryByTestId('earned-this-period')).not.toBeInTheDocument();
  });

  it('is hidden with nothing clocked this period — no "$0.00 · 0h" beside a day ring (F500 G5)', async () => {
    earningsState.data = { hourlyRate: 15, onClock: false, period: period({ workedHours: 0, earned: 0, takeHome: null }) };
    renderHome();
    expect(await screen.findByTestId('next-14-none')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('earned-this-period')).not.toBeInTheDocument();
  });
});

describe('<AssociateDashboard> — the numbers strip (ASSOC-15, ASSOC-29)', () => {
  it('no accrual rule: "No balance yet", never "accrues as you work"', async () => {
    earningsState.data = { hourlyRate: 15, onClock: false, period: null };
    const { getMyBalance } = await import('@/lib/timeOffApi');
    vi.mocked(getMyBalance).mockResolvedValue({ balances: [], sickAccrual: null } as never);
    renderHome();
    expect(await screen.findByText('No balance yet')).toBeInTheDocument();
    expect(screen.queryByText(/accrue/i)).not.toBeInTheDocument();
  });

  it('an accrual rule: "Accrues as you work"', async () => {
    earningsState.data = { hourlyRate: 15, onClock: false, period: null };
    const { getMyBalance } = await import('@/lib/timeOffApi');
    vi.mocked(getMyBalance).mockResolvedValue({ balances: [], sickAccrual: { hoursWorkedPerHour: 30 } } as never);
    renderHome();
    expect(await screen.findByText('Accrues as you work')).toBeInTheDocument();
  });

  it('open shifts ride on the quick link — no third tile alone on a row', async () => {
    earningsState.data = { hourlyRate: 15, onClock: false, period: null };
    const { listOpenShifts } = await import('@/lib/qualApi');
    vi.mocked(listOpenShifts).mockResolvedValue({ shifts: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] } as never);
    renderHome();
    expect(await screen.findByLabelText('3 open shifts you can pick up')).toBeInTheDocument();
    const strip = screen.getByRole('group', { name: /numbers/i });
    expect(strip.querySelectorAll('[data-metric-strip] > div, :scope > div').length).toBe(2);
  });
});
