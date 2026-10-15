import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Capability } from '@alto-people/shared';

/**
 * Brief 2-3 step 2 — the login page finds an organization's own sign-in
 * from the email's domain (only the domain is sent), or from /login/<slug>;
 * a staff password refused for SSO says what to do instead.
 */

const apiFetch = vi.fn(async (path: string) => {
  if (path === '/auth/oidc/config') return { enabled: false, buttonLabel: null };
  if (path === `/auth/oidc/discover?email=${encodeURIComponent('x@acme-hotels.test')}`) return { connections: [{ id: 'c0ffee00-0000-4000-8000-000000000001', label: 'Continue with Okta' }] };
  if (path === '/auth/oidc/tenant/acme-hotels') return { connections: [{ id: 'c0ffee00-0000-4000-8000-000000000002', label: 'Continue with Acme' }] };
  return { connections: [] };
});

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: (path: string) => apiFetch(path),
}));

import { ApiError } from '@/lib/api';
import { AuthContext } from '@/lib/auth';
import { Login } from '@/pages/Login';

function renderLogin(entry: string, signIn = vi.fn()) {
  const value = { isInitializing: false, isOffline: false, user: null, role: null, capabilities: new Set<Capability>(), signIn, signOut: vi.fn(), can: () => false };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/login/:slug" element={<Login />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const assign = vi.fn();
vi.stubGlobal('location', { ...window.location, assign });
afterEach(() => {
  assign.mockClear();
  apiFetch.mockClear();
});

describe('<Login> — an organization’s own sign-in', () => {
  it('appears for a verified domain once the email is typed, and starts that connection', async () => {
    renderLogin('/login');
    const email = screen.getByLabelText(/email/i);
    await userEvent.clear(email);
    await userEvent.type(email, 'maria@acme-hotels.test');
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Okta' }, { timeout: 3000 }));
    expect(assign).toHaveBeenCalledWith('/api/auth/oidc/start?connection=c0ffee00-0000-4000-8000-000000000001');
    // The person's address never leaves the page; only its domain does.
    expect(apiFetch.mock.calls.some(([p]) => String(p).includes('maria'))).toBe(false);
  });

  it('by slug, for a shared domain', async () => {
    renderLogin('/login/acme-hotels');
    expect(await screen.findByRole('button', { name: 'Continue with Acme' })).toBeTruthy();
  });

  it('a staff password refused for SSO says to use the organization’s sign-in', async () => {
    const signIn = vi.fn(async () => {
      throw new ApiError(403, 'sso_required', 'x');
    });
    renderLogin('/login', signIn);
    const email = screen.getByLabelText(/email/i);
    await userEvent.clear(email);
    await userEvent.type(email, 'boss@acme-hotels.test');
    await userEvent.type(screen.getByLabelText(/^password/i), 'whatever-password');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByText(/signs in with its own sign-in/i)).toBeTruthy();
  });
});
