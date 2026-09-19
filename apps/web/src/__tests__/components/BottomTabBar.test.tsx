import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { BottomTabBar } from '@/components/BottomTabBar';

vi.mock('@/lib/useApprovalsCount', () => ({ useApprovalsCount: () => 3 }));
vi.mock('@/lib/messagesApi', () => ({ unreadMessages: async () => ({ unread: 0 }) }));

function renderBar(caps: Capability[], role: Role = 'ASSOCIATE') {
  const value = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      email: 'maria@example.com',
      role,
      status: 'ACTIVE' as const,
      clientId: null,
      associateId: 'a',
    },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.includes(c),
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={value}>
        <MemoryRouter>
          <BottomTabBar onOpenMenu={vi.fn()} />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<BottomTabBar>', () => {
  it('shows the everyday destinations the user can access plus More', () => {
    renderBar([...ROLE_CAPABILITIES.ASSOCIATE]);
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /schedule/i })).toBeInTheDocument();
    // Associates get Pay as a first-class tab; the old "Clock" tab is gone
    // (it dead-ended at the kiosk-only page for them).
    expect(screen.getByRole('link', { name: /^pay$/i })).toBeInTheDocument();
    // The Alto vans took Time off's tab; Time off lives in More.
    expect(screen.getByRole('link', { name: /^ride$/i })).toHaveAttribute('href', '/rides');
    expect(screen.queryByRole('link', { name: /time off/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /clock/i })).not.toBeInTheDocument();
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

  it("gives the shift supervisor the store manager's grammar, kept through iPad widths", () => {
    renderBar([...ROLE_CAPABILITIES.SHIFT_SUPERVISOR], 'SHIFT_SUPERVISOR');
    expect(screen.getByRole('link', { name: /my floor/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /^today$/i })).toHaveAttribute('href', '/today');
    expect(screen.getByRole('link', { name: /schedule/i })).toHaveAttribute('href', '/scheduling');
    const approvals = screen.getByRole('link', { name: /approvals/i });
    expect(approvals).toHaveAttribute('href', '/approvals');
    expect(approvals).toHaveTextContent('3');
    // Labeled tabs, not an icon rail, on an iPad.
    expect(screen.getByRole('navigation', { name: /primary/i }).className).toContain('lg:hidden');
  });

  it('gives the driver their runs and messages', () => {
    renderBar([...ROLE_CAPABILITIES.DRIVER], 'DRIVER');
    expect(screen.getByRole('link', { name: /my runs/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /messages/i })).toHaveAttribute('href', '/messages');
    expect(screen.queryByRole('link', { name: /schedule/i })).not.toBeInTheDocument();
  });

  it('gives the transportation director the command center', () => {
    renderBar([...ROLE_CAPABILITIES.TRANSPORTATION_DIRECTOR], 'TRANSPORTATION_DIRECTOR');
    expect(screen.getByRole('link', { name: /command center/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /messages/i })).toBeInTheDocument();
  });
});
