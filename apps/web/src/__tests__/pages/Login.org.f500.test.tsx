import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Capability } from '@alto-people/shared';

/**
 * /login/<slug> names the organization (F500 G5): "Sign in to Harbor
 * Staffing" with its logo; an unknown address says so with the way back to
 * /login; one status link (the footer), pointing at the hosted status page
 * when the deployment names one; a tagline that speaks to everyone.
 */

let statusPageUrl: string | null = null;
const apiFetch = vi.fn(async (path: string) => {
  if (path === '/auth/org/harbor-staffing') return { org: { name: 'Harbor Staffing', slug: 'harbor-staffing', logoUrl: '/auth/org/harbor-staffing/logo?v=1' } };
  if (path === '/auth/org/nobody-here') {
    const { ApiError } = await import('@/lib/api');
    throw new ApiError(404, 'org_not_found', 'x');
  }
  if (path === '/support/config') return { statusPageUrl };
  if (path === '/auth/oidc/config') return { enabled: false, buttonLabel: null };
  return { connections: [] };
});
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: (path: string) => apiFetch(path) }));

import { AuthContext } from '@/lib/auth';
import { Login } from '@/pages/Login';
import { __resetAuthShellStatusCache } from '@/components/ui/AuthHeading';

function renderLogin(entry: string) {
  const value = { isInitializing: false, isOffline: false, user: null, role: null, capabilities: new Set<Capability>(), signIn: vi.fn(), signOut: vi.fn(), can: () => false };
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

describe('<Login> for an organization (F500 G5)', () => {
  it('says "Sign in to <Org>" with the organization’s logo', async () => {
    renderLogin('/login/harbor-staffing');
    const org = await screen.findByTestId('login-org');
    expect(within(org).getByRole('heading', { level: 1 })).toHaveTextContent('Sign in to Harbor Staffing');
    expect(org.querySelector('img')).toHaveAttribute('src', '/api/auth/org/harbor-staffing/logo?v=1');
  });

  it('an unknown address says so and links the main sign-in page', async () => {
    renderLogin('/login/nobody-here');
    const box = await screen.findByTestId('login-org-unknown');
    expect(box).toHaveTextContent('We don’t recognise that sign-in address');
    expect(within(box).getByRole('link', { name: 'Go to the sign-in page' })).toHaveAttribute('href', '/login');
  });

  it('one status link — the footer’s, to the hosted page when one is set — and a tagline for everyone', async () => {
    statusPageUrl = 'https://status.example.com';
    __resetAuthShellStatusCache();
    renderLogin('/login');
    const nav = screen.getByRole('navigation', { name: 'About the platform' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Status' })).toHaveAttribute('href', 'https://status.example.com'));
    expect(screen.queryByText('System status')).not.toBeInTheDocument();
    expect(screen.getByText('Workforce, time and pay in one place')).toBeInTheDocument();
    statusPageUrl = null;
  });
});
