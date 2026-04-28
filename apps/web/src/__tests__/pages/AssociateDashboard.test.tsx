import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/timeApi', () => ({
  getActiveTimeEntry: vi.fn(),
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  tryGetGeolocation: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/schedulingApi', () => ({
  listMyShifts: vi.fn(),
}));
vi.mock('@/lib/payrollApi', () => ({
  listMyPayrollItems: vi.fn(),
}));
vi.mock('@/lib/timeOffApi', () => ({
  getMyBalance: vi.fn(),
}));
vi.mock('@/lib/onboardingApi', () => ({
  listApplications: vi.fn().mockResolvedValue({
    applications: [],
    total: 0,
    page: 1,
    pageSize: 50,
  }),
}));

import { clockIn, clockOut, getActiveTimeEntry } from '@/lib/timeApi';
import { listMyShifts } from '@/lib/schedulingApi';
import { listMyPayrollItems } from '@/lib/payrollApi';
import { getMyBalance } from '@/lib/timeOffApi';
import { AssociateDashboard } from '@/pages/AssociateDashboard';

function renderDashboard() {
  const value = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      email: 'maria.lopez@example.com',
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
        <AssociateDashboard />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(getActiveTimeEntry).mockResolvedValue({ active: null });
  vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] });
  vi.mocked(listMyPayrollItems).mockResolvedValue({ items: [] });
  vi.mocked(getMyBalance).mockResolvedValue({ balances: [], recentLedger: [] });
});

describe('<AssociateDashboard>', () => {
  it('greets the associate by name', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText(/Hey Maria/)).toBeInTheDocument();
    });
  });

  it('shows "Clock in" when not on the clock and calls clockIn on tap', async () => {
    const user = userEvent.setup();
    renderDashboard();
    await waitFor(() => expect(getActiveTimeEntry).toHaveBeenCalled());

    const btn = await screen.findByRole('button', { name: /clock in/i });
    await user.click(btn);

    await waitFor(() => {
      expect(clockIn).toHaveBeenCalledTimes(1);
    });
  });

  it('shows "Clock out" when on the clock and calls clockOut on tap', async () => {
    vi.mocked(getActiveTimeEntry).mockResolvedValue({
      active: {
        id: 't1',
        associateId: 'a',
        associateName: 'Maria',
        clientId: null,
        clientName: null,
        clockInAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        clockOutAt: null,
        status: 'ACTIVE',
        notes: null,
        rejectionReason: null,
        approvedById: null,
        approverEmail: null,
        approvedAt: null,
        minutesElapsed: 30,
        jobId: null,
        jobName: null,
        clockInGeo: null,
        clockOutGeo: null,
        breaks: [],
      } as never,
    });
    const user = userEvent.setup();
    renderDashboard();
    await waitFor(() => expect(getActiveTimeEntry).toHaveBeenCalled());

    expect(await screen.findByText(/On the clock/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /clock out/i }));
    await waitFor(() => {
      expect(clockOut).toHaveBeenCalledTimes(1);
    });
  });

  it('renders "Nothing scheduled" when there are no upcoming shifts', async () => {
    renderDashboard();
    await waitFor(() => expect(listMyShifts).toHaveBeenCalled());
    expect(await screen.findByText(/Nothing scheduled/)).toBeInTheDocument();
  });

  it('shows the latest paystub net pay when present', async () => {
    vi.mocked(listMyPayrollItems).mockResolvedValue({
      items: [
        {
          id: 'p1',
          payrollRunId: 'r1',
          associateId: 'a',
          associateName: 'Maria',
          hoursWorked: 32.5,
          hourlyRate: 18,
          grossPay: 585,
          federalWithholding: 50,
          fica: 36.27,
          medicare: 8.48,
          stateWithholding: 0,
          taxState: 'TX',
          ytdWages: 5000,
          ytdMedicareWages: 5000,
          employerFica: 36.27,
          employerMedicare: 8.48,
          employerFuta: 3.51,
          employerSuta: 17.55,
          netPay: 490.25,
          status: 'DISBURSED',
          disbursementRef: 'STUB-1',
          disbursedAt: new Date().toISOString(),
          failureReason: null,
        } as never,
      ],
    });
    renderDashboard();
    await waitFor(() => expect(listMyPayrollItems).toHaveBeenCalled());
    expect(await screen.findByText(/\$490\.25/)).toBeInTheDocument();
  });
});
