import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
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

import { TimeHome } from '@/pages/time/TimeHome';

function renderAt(url: string, role: Role = 'SHIFT_SUPERVISOR') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
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
    </AuthContext.Provider>,
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
