import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { BottomTabBar } from '@/components/BottomTabBar';

function renderBar(caps: Capability[]) {
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
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.includes(c),
  };
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter>
        <BottomTabBar onOpenMenu={vi.fn()} />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('<BottomTabBar>', () => {
  it('shows the everyday destinations the user can access plus More', () => {
    renderBar(['view:scheduling', 'view:time', 'view:payroll'] as Capability[]);
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /schedule/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /clock/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /time off/i })).toBeInTheDocument();
    // Capped at 4 destinations — Pay lives behind More when everything
    // else is visible.
    expect(screen.queryByRole('link', { name: /^pay$/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /more/i }),
    ).toBeInTheDocument();
  });

  it('collapses to Home + More when the user has no module capabilities', () => {
    renderBar([]);
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /schedule/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more/i })).toBeInTheDocument();
  });
});
