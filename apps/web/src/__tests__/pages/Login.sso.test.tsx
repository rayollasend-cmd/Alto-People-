import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Capability } from '@alto-people/shared';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) =>
    path === '/auth/oidc/config' ? { enabled: true, buttonLabel: 'Sign in with Alto SSO' } : {},
  ),
}));

import { AuthContext } from '@/lib/auth';
import { Login } from '@/pages/Login';

function renderLogin(entry: Parameters<typeof MemoryRouter>[0]['initialEntries']) {
  const value = {
    isInitializing: false,
    isOffline: false,
    user: null,
    role: null,
    capabilities: new Set<Capability>(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => false,
  };
  render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={entry}>
        <Login />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const assign = vi.fn();
vi.stubGlobal('location', { ...window.location, assign });
afterEach(() => assign.mockClear());

/**
 * A notification link opened while signed out lands on /login carrying the
 * page. Password sign-in always went back there; the SSO button dropped it
 * and everyone landed on the dashboard.
 */
describe('<Login> — SSO keeps the page you were headed to', () => {
  it('hands the page to the SSO start', async () => {
    const target = '/scheduling?view=week&associate=a1&week=2026-09-26';
    renderLogin([{ pathname: '/login', state: { from: target } }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Alto SSO' }));
    expect(assign).toHaveBeenCalledWith(`/api/auth/oidc/start?next=${encodeURIComponent(target)}`);
  });

  it('with nowhere in particular to go, starts plain', async () => {
    renderLogin(['/login']);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Alto SSO' }));
    expect(assign).toHaveBeenCalledWith('/api/auth/oidc/start');
  });

  it('never passes an off-site destination along', async () => {
    renderLogin(['/login?next=//evil.example/x']);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Alto SSO' }));
    expect(assign).toHaveBeenCalledWith('/api/auth/oidc/start');
  });
});
