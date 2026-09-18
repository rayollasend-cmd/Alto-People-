import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  getMyShiftDetail: vi.fn(),
  acknowledgeMyShift: vi.fn(),
}));
vi.mock('@/lib/qualApi', () => ({
  listOpenShifts: vi.fn(),
}));
vi.mock('@/lib/payrollApi', () => ({
  listMyPayrollItems: vi.fn(),
  getMyNextPayday: vi.fn().mockResolvedValue({ nextPayday: null }),
}));
vi.mock('@/lib/timeOffApi', () => ({
  getMyBalance: vi.fn(),
}));
vi.mock('@/lib/agreements122Api', () => ({
  listMyAgreements: vi.fn(),
}));
vi.mock('@/lib/documentsApi', () => ({
  listMyDocuments: vi.fn(),
}));
vi.mock('@/lib/communicationsApi', () => ({
  listMyInbox: vi.fn(),
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
import { getMyShiftDetail, listMyShifts } from '@/lib/schedulingApi';
import { listOpenShifts } from '@/lib/qualApi';
import { listMyAgreements } from '@/lib/agreements122Api';
import { listMyDocuments } from '@/lib/documentsApi';
import { listMyInbox } from '@/lib/communicationsApi';
import { listMyPayrollItems } from '@/lib/payrollApi';
import { getMyBalance } from '@/lib/timeOffApi';
import { ApiError } from '@/lib/api';
import { AssociateDashboard } from '@/pages/AssociateDashboard';

const shiftFixture = (startsAt: Date, endsAt: Date) =>
  ({
    id: 's1',
    clientId: 'c1',
    clientName: 'Publix 1424',
    position: 'F&D Morning Shift',
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    location: null,
    hourlyRate: null,
    payRate: null,
    status: 'ASSIGNED',
    notes: null,
    locationId: null,
    locationName: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    assignedAssociateId: 'a',
    assignedAssociateName: 'Maria Lopez',
    assignedAt: null,
    cancellationReason: null,
    scheduledMinutes: 480,
    publishedAt: new Date().toISOString(),
    lateNoticeReason: null,
    acknowledgedAt: null,
  }) as never;

function renderDashboard() {
  // Fresh client per render so cached data never leaks between tests;
  // retry off so a mocked one-shot failure surfaces immediately (the
  // app-level client retries once, but that's a prod resilience knob).
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
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
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={value}>
        <MemoryRouter>
          <AssociateDashboard />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(getActiveTimeEntry).mockResolvedValue({ active: null });
  vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] });
  vi.mocked(listMyPayrollItems).mockResolvedValue({ items: [] });
  vi.mocked(getMyBalance).mockResolvedValue({ balances: [], recentLedger: [] });
  vi.mocked(listMyAgreements).mockResolvedValue({ agreements: [] } as never);
  vi.mocked(listMyDocuments).mockResolvedValue({ documents: [] } as never);
  vi.mocked(listMyInbox).mockResolvedValue({ notifications: [] } as never);
  vi.mocked(listOpenShifts).mockResolvedValue({ shifts: [] });
  vi.mocked(getMyShiftDetail).mockResolvedValue({ shift: {} as never, teammates: [], supervisors: [] });
});

describe('<AssociateDashboard>', () => {
  it('greets the associate by name', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText(/Hey Maria/)).toBeInTheDocument();
    });
  });

  it('shows "Off the clock" with a kiosk hint and no clock button', async () => {
    renderDashboard();
    await waitFor(() => expect(getActiveTimeEntry).toHaveBeenCalled());

    expect(await screen.findByText(/Off the clock/)).toBeInTheDocument();
    expect(screen.getByText(/worksite kiosk/i)).toBeInTheDocument();
    // Associates punch at the kiosk only — the dashboard must not offer
    // an in-app clock button (the API would 403 it anyway).
    expect(
      screen.queryByRole('button', { name: /clock (in|out)/i })
    ).not.toBeInTheDocument();
    expect(clockIn).not.toHaveBeenCalled();
  });

  it('shows "On the clock" with the kiosk start time when clocked in', async () => {
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
    renderDashboard();
    await waitFor(() => expect(getActiveTimeEntry).toHaveBeenCalled());

    expect((await screen.findAllByText(/On the clock/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Started/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /clock (in|out)/i })
    ).not.toBeInTheDocument();
    expect(clockOut).not.toHaveBeenCalled();
  });

  it('renders "Nothing scheduled" when there are no upcoming shifts', async () => {
    renderDashboard();
    await waitFor(() => expect(listMyShifts).toHaveBeenCalled());
    expect(await screen.findByText(/Nothing scheduled/)).toBeInTheDocument();
  });

  it('an in-progress shift stays the "next shift" until it ends', async () => {
    // Started 2h ago, ends in 6h. The old startsAt-based picker skipped this
    // and (with nothing after it) claimed "Nothing scheduled" mid-shift.
    vi.mocked(listMyShifts).mockResolvedValue({
      shifts: [
        shiftFixture(
          new Date(Date.now() - 2 * 3_600_000),
          new Date(Date.now() + 6 * 3_600_000),
        ),
      ],
    });
    renderDashboard();
    await waitFor(() => expect(listMyShifts).toHaveBeenCalled());
    // Assert on the shift itself, not the "Today" label — a suite run just
    // after midnight makes a started-2h-ago shift correctly label as
    // yesterday, and this test is about the picker, not the label.
    expect(await screen.findByText(/F&D Morning Shift/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing scheduled/)).not.toBeInTheDocument();
  });

  it('a real fetch failure shows a retry card, NOT "Nothing scheduled"', async () => {
    vi.mocked(listMyShifts).mockRejectedValueOnce(new Error('network down'));
    renderDashboard();
    await waitFor(() => expect(listMyShifts).toHaveBeenCalled());
    expect(await screen.findByText(/Couldn't load this/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing scheduled/)).not.toBeInTheDocument();

    // Retry refetches; this time it succeeds and the empty state is honest.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/Nothing scheduled/)).toBeInTheDocument();
  });

  it('an expected 403 still renders as a plain empty state', async () => {
    vi.mocked(listMyShifts).mockRejectedValue(
      new ApiError(403, 'forbidden', 'Forbidden'),
    );
    renderDashboard();
    await waitFor(() => expect(listMyShifts).toHaveBeenCalled());
    expect(await screen.findByText(/Nothing scheduled/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load this/)).not.toBeInTheDocument();
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

describe("<AssociateDashboard> action-needed card", () => {
  it("says all caught up when every source loaded and found nothing", async () => {
    renderDashboard();
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  it("stays silent instead of claiming all caught up when a source failed", async () => {
    // The sources swallow errors to null, which is indistinguishable from
    // "nothing pending" once the row is omitted. Rendering the all-clear off
    // that told associates they had no unsigned agreements when we simply
    // had not managed to check.
    vi.mocked(listMyAgreements).mockRejectedValue(new Error("network down"));
    renderDashboard();

    // Wait for a settled dashboard before asserting the absence.
    await screen.findByText(/my schedule|upcoming|next shift/i);
    await waitFor(() =>
      expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument(),
    );
  });

  it("still lists the rows it did manage to load", async () => {
    vi.mocked(listMyAgreements).mockResolvedValue({
      agreements: [{ id: "ag-1", status: "PENDING_SIGNATURE" }],
    } as never);
    renderDashboard();

    expect(await screen.findByText(/agreement/i)).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });
});

describe('<AssociateDashboard> — the shift hero', () => {
  it('a started shift with no punch reads as late, amber, and points to the tablet', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({
      shifts: [shiftFixture(new Date(Date.now() - 25 * 60_000), new Date(Date.now() + 7 * 3_600_000))],
    });
    renderDashboard();
    expect(await screen.findByText('Your shift started 25m ago')).toBeInTheDocument();
    expect(screen.getByText(/punch in with your PIN at the worksite kiosk tablet/)).toBeInTheDocument();
    expect(screen.getByText('Not clocked in')).toBeInTheDocument();
  });

  it('an upcoming shift names who runs it and who is on with them, and asks for the confirm', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({
      shifts: [shiftFixture(new Date(Date.now() + 3 * 3_600_000), new Date(Date.now() + 11 * 3_600_000))],
    });
    vi.mocked(getMyShiftDetail).mockResolvedValue({
      shift: {} as never,
      teammates: [
        { associateId: 'b', name: 'Ann Lee', position: 'Stocker', startsAt: '', endsAt: '', location: null },
        { associateId: 'c', name: 'Ben Ray', position: 'Stocker', startsAt: '', endsAt: '', location: null },
      ] as never,
      supervisors: [{ userId: 'u-dana', name: 'Dana Reyes', associateId: 'd' }],
    });
    renderDashboard();
    expect(await screen.findByText('Starts in 3h')).toBeInTheDocument();
    expect(await screen.findByText('Dana Reyes')).toBeInTheDocument();
    expect(screen.getByText('2 teammates on with you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /I'll be there/ })).toBeInTheDocument();
  });

  it('nothing scheduled: the open shifts are the way out', async () => {
    vi.mocked(listOpenShifts).mockResolvedValue({ shifts: [{ id: 'o1' }, { id: 'o2' }] as never });
    renderDashboard();
    expect(await screen.findByText('2 open shifts you can pick up.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pick up a shift' })).toHaveAttribute('href', '/marketplace');
  });
});

describe('<AssociateDashboard> — their numbers and their week', () => {
  it('tiles: hours this week, last paycheck, time off, open shifts — each opens where it is worked', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({
      shifts: [shiftFixture(new Date(Date.now() + 3 * 3_600_000), new Date(Date.now() + 11 * 3_600_000))],
    });
    renderDashboard();
    expect(await screen.findByText('This week')).toBeInTheDocument();
    expect(screen.getByText('Last paycheck').closest('a')).toHaveAttribute('href', '/payroll');
    expect(screen.getByText('Open shifts').closest('a')).toHaveAttribute('href', '/marketplace');
    expect(screen.getByText('Time off').closest('a')).toHaveAttribute('href', '/time-off');
  });

  it('the week strip marks the days on and the ones still to confirm', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({
      shifts: [shiftFixture(new Date(Date.now() + 26 * 3_600_000), new Date(Date.now() + 30 * 3_600_000))],
    });
    renderDashboard();
    expect(await screen.findByText('Your week')).toBeInTheDocument();
    expect(screen.getByText('1 day on')).toBeInTheDocument();
    expect(screen.getAllByText('Off').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText('Needs your confirm')).toBeInTheDocument();
  });
});
