import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/pages/time/AdminTimeView', () => ({
  AdminTimeView: ({ personal }: { personal?: ReactNode }) => (
    <div>
      <h1>floor view</h1>
      {personal}
    </div>
  ),
}));
vi.mock('@/pages/time/AssociateTimeView', () => ({
  AssociateTimeView: ({ variant = 'full', headerActions }: { variant?: string; headerActions?: ReactNode }) => (
    <div>
      personal {variant}
      {headerActions}
    </div>
  ),
}));

vi.mock('@/pages/time/MyTimesheet', () => ({ MyTimesheet: () => <div>my timesheet</div> }));
vi.mock('@/lib/timeApi', () => ({
  getActiveTimeEntry: vi.fn().mockResolvedValue({ active: { id: 'e1', clockInAt: new Date().toISOString() } }),
  listMyTimeEntries: vi.fn().mockResolvedValue({ entries: [] }),
}));
vi.mock('@/lib/schedulingApi', () => ({
  listMyShifts: vi.fn().mockResolvedValue({ shifts: [] }),
}));

import { TimeHome } from '@/pages/time/TimeHome';

function renderAt(url: string, role: Role = 'SHIFT_SUPERVISOR') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AuthContext.Provider
      value={{
        isInitializing: false,
        isOffline: false,
        user: { id: 'u', email: 'dana@altohr.com', role, status: 'ACTIVE', clientId: 'c1', associateId: 'a1' },
        role,
        capabilities: new Set<Capability>(caps),
        signIn: vi.fn(),
        signOut: vi.fn(),
        can: (c: Capability) => caps.has(c),
      }}
    >
      <MemoryRouter initialEntries={[url]}>
        <TimeHome />
      </MemoryRouter>
    </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<TimeHome> — one page for people who run the floor and punch', () => {
  it('shows the floor with the personal clock as a strip, not a second page', () => {
    renderAt('/time-attendance');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('floor view')).toBeInTheDocument();
    expect(screen.getByText('personal strip')).toBeInTheDocument();
    expect(screen.queryByText('personal full')).not.toBeInTheDocument();
  });

  it('"My time" is the full personal view, with the way back to the floor', () => {
    renderAt('/time-attendance?mine=1');
    expect(screen.getByText('personal full')).toBeInTheDocument();
    expect(screen.queryByText('floor view')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /the floor/i })).toHaveAttribute('href', '/time-attendance');
  });
});

describe('<TimeHome> — the floor supervisor punches at the tablet only', () => {
  it('the live board with their clock read-only — no clock buttons, where to punch instead', async () => {
    renderAt('/time-attendance', 'FLOOR_SUPERVISOR');
    expect(screen.getByText('floor view')).toBeInTheDocument();
    expect(screen.queryByText('personal strip')).not.toBeInTheDocument();
    expect(await screen.findByText(/On the clock since/)).toBeInTheDocument();
    expect(screen.getByText('Punch in and out at the store tablet with your PIN.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clock (in|out)/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My time →' })).toHaveAttribute('href', '/time-attendance?mine=1');
  });

  it('"My time" is their timesheet and the tablet note — never the clock-in screen', () => {
    renderAt('/time-attendance?mine=1', 'FLOOR_SUPERVISOR');
    expect(screen.getByText('my timesheet')).toBeInTheDocument();
    expect(screen.getByText(/clock in and out at the store tablet/)).toBeInTheDocument();
    expect(screen.queryByText('personal full')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /the floor/i })).toHaveAttribute('href', '/time-attendance');
  });
});
