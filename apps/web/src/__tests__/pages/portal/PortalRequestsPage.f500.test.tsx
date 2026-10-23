import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { PortalRequestsPage } from '@/pages/portal/PortalRequestsPage';

/**
 * /portal/requests (F500 G5): "Make a request" is the page's header action,
 * the list doesn't repeat the title, Open | Resolved tabs live in the URL,
 * and a link to one request (?id=) opens on its tab.
 */

const req = (id: string, status: string, subject: string) => ({
  id,
  kind: 'STAFFING',
  subject,
  body: 'body',
  status,
  resolution: status === 'RESOLVED' ? 'Done.' : null,
  createdAt: '2026-10-01T12:00:00.000Z',
  resolvedAt: null,
  dueAt: '2026-10-03T12:00:00.000Z',
  desk: 'Staffing',
  owner: status === 'IN_PROGRESS' ? 'Dana' : null,
  overdue: status !== 'RESOLVED',
  associateId: null,
  associateName: null,
});

function renderPage(entry = '/portal/requests') {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/client-portal/requests') {
      return { requests: [req('r1', 'RECEIVED', 'Two more overnight stockers'), req('r2', 'IN_PROGRESS', 'Badge printer'), req('r3', 'RESOLVED', 'Thanks for Thursday')] } as never;
    }
    if (path === '/client-portal/people') return { people: [] } as never;
    throw new Error(`unexpected ${path}`);
  });
  const role = 'CLIENT_PORTAL' as const;
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'sm@x.com', role, status: 'ACTIVE', clientId: 'c1', associateId: null } as never,
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter initialEntries={[entry]}>
          <PortalRequestsPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('/portal/requests (F500 G5)', () => {
  it('opens on the open requests, with Resolved one tap away; "Requests" is said once', async () => {
    const user = userEvent.setup();
    renderPage();
    const tabs = await screen.findByRole('radiogroup', { name: 'Which requests' });
    expect(within(tabs).getByRole('radio', { name: /Open/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByTestId('portal-request')).toHaveLength(2);
    expect(screen.getAllByText('Requests').filter((el) => el.tagName !== 'A')).toHaveLength(1);
    await user.click(within(tabs).getByRole('radio', { name: /Resolved/ }));
    expect(screen.getAllByTestId('portal-request')).toHaveLength(1);
    expect(screen.getByText('Thanks for Thursday')).toBeInTheDocument();
  });

  it('"Make a request" is the header action and opens the request form', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('portal-request');
    await user.click(screen.getByRole('button', { name: /Make a request/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('a link to a resolved request opens on the Resolved tab, marked', async () => {
    renderPage('/portal/requests?id=r3');
    expect(await screen.findByText('Thanks for Thursday')).toBeInTheDocument();
    expect(screen.getAllByTestId('portal-request')).toHaveLength(1);
  });
});
