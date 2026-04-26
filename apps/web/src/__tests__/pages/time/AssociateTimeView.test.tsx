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
