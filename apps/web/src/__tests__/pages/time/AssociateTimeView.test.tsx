import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Capability, TimeEntry } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/timeApi', () => ({
  getActiveTimeEntry: vi.fn(),
  listMyTimeEntries: vi.fn(),
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  startBreak: vi.fn(),
  endBreak: vi.fn(),
  // jsdom doesn't expose navigator.geolocation; the helper resolves null
  // there anyway, but stubbing keeps the test free of timing on the 5s
  // geolocation timeout.
  tryGetGeolocation: vi.fn(async () => null),
}));

vi.mock('@/lib/jobsApi', () => ({
  listJobs: vi.fn(async () => ({ jobs: [] })),
}));

import {
  clockIn,
  clockOut,
  getActiveTimeEntry,
  listMyTimeEntries,
} from '@/lib/timeApi';
import { AssociateTimeView } from '@/pages/time/AssociateTimeView';

function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    associateId: '00000000-0000-4000-8000-000000000002',
    associateName: 'Maria Lopez',
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
    ...overrides,
  };
}

function renderView() {
  const value = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      email: 'maria@example.com',
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
        <AssociateTimeView />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(getActiveTimeEntry).mockReset();
  vi.mocked(listMyTimeEntries).mockReset();
  vi.mocked(clockIn).mockReset();
  vi.mocked(clockOut).mockReset();
});

describe('<AssociateTimeView>', () => {
  it('shows the Clock in button when no active entry', async () => {
    vi.mocked(getActiveTimeEntry).mockResolvedValueOnce({ active: null });
    vi.mocked(listMyTimeEntries).mockResolvedValueOnce({ entries: [] });
    renderView();

    expect(await screen.findByRole('button', { name: /clock in/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clock out/i })).not.toBeInTheDocument();
    expect(screen.getByText(/not clocked in/i)).toBeInTheDocument();
  });

  it('shows the Clock out button when there is an active entry', async () => {
    vi.mocked(getActiveTimeEntry).mockResolvedValueOnce({ active: entry() });
    vi.mocked(listMyTimeEntries).mockResolvedValueOnce({ entries: [] });
    renderView();

    expect(await screen.findByRole('button', { name: /clock out/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^clock in$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/currently clocked in/i)).toBeInTheDocument();
  });

  it('clicking Clock in calls the API and re-fetches', async () => {
    vi.mocked(getActiveTimeEntry)
      .mockResolvedValueOnce({ active: null })
      .mockResolvedValueOnce({ active: entry() });
    vi.mocked(listMyTimeEntries)
      .mockResolvedValueOnce({ entries: [] })
      .mockResolvedValueOnce({ entries: [entry()] });
    vi.mocked(clockIn).mockResolvedValueOnce(entry());

    const user = userEvent.setup();
    renderView();
    const btn = await screen.findByRole('button', { name: /clock in/i });
    await user.click(btn);

    await waitFor(() => expect(clockIn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getActiveTimeEntry).toHaveBeenCalledTimes(2));
  });

  it('renders recent entry rows with status badges', async () => {
    vi.mocked(getActiveTimeEntry).mockResolvedValueOnce({ active: null });
    vi.mocked(listMyTimeEntries).mockResolvedValueOnce({
      entries: [
        entry({ id: 'e1', status: 'APPROVED', clockOutAt: new Date().toISOString(), minutesElapsed: 480 }),
        entry({ id: 'e2', status: 'REJECTED', clockOutAt: new Date().toISOString(), minutesElapsed: 60, rejectionReason: 'no clock-out' }),
      ],
    });
    renderView();

    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText(/no clock-out/i)).toBeInTheDocument();
  });
});

describe("<AssociateTimeView> overtime nudge", () => {
  // The in-progress shift is in BOTH the active payload and the history list
  // (/me/entries has no status filter, and minutesElapsed on an open entry is
  // now - clockInAt). Summing the list and then adding the live counter
  // counted it twice and tripped the warning hours early.
  const HOURS = (h: number) => h * 60;

  function activeShift(minutes: number) {
    return entry({
      id: "active-1",
      clockInAt: new Date(Date.now() - minutes * 60_000).toISOString(),
      minutesElapsed: minutes,
      status: "ACTIVE",
    });
  }

  function finished(id: string, minutes: number, daysAgo = 0) {
    // Anchored after this week’s Sunday so it lands inside the window.
    const start = new Date();
    start.setHours(12, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay() + daysAgo);
    return entry({
      id,
      clockInAt: start.toISOString(),
      clockOutAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
      minutesElapsed: minutes,
      status: "COMPLETED",
    });
  }

  it("counts the open shift once, not twice", async () => {
    const open = activeShift(HOURS(4));
    vi.mocked(getActiveTimeEntry).mockResolvedValueOnce({ active: open });
    vi.mocked(listMyTimeEntries).mockResolvedValueOnce({
      entries: [open, finished("done-1", HOURS(33))],
    });
    renderView();

    // 33h history + 4h open = 37h. Double-counting the open shift gives 41h
    // and flips the copy to the past-40 warning.
    expect(await screen.findByText(/37.0h this workweek/)).toBeInTheDocument();
    expect(screen.queryByText(/past the 40h line/i)).not.toBeInTheDocument();
  });

  it("ignores rejected time", async () => {
    vi.mocked(getActiveTimeEntry).mockResolvedValueOnce({ active: null });
    vi.mocked(listMyTimeEntries).mockResolvedValueOnce({
      entries: [
        finished("done-1", HOURS(36)),
        entry({
          id: "rej-1",
          clockInAt: finished("x", 0).clockInAt,
          clockOutAt: new Date().toISOString(),
          minutesElapsed: HOURS(8),
          status: "REJECTED",
        }),
      ],
    });
    renderView();

    expect(await screen.findByText(/36.0h this workweek/)).toBeInTheDocument();
  });
});
