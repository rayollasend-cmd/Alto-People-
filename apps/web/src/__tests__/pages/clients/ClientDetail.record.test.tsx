import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClientSummary } from '@alto-people/shared';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true }),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock('@/lib/clientsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/clientsApi')>()),
  getClient: vi.fn(),
}));
// The sections have their own queries and their own tests; here only the
// record at the top of the page matters.
vi.mock('@/pages/clients/JobsSection', () => ({ JobsSection: () => null }));
vi.mock('@/pages/clients/RateDefaultsSection', () => ({ RateDefaultsSection: () => null }));
vi.mock('@/pages/clients/StatementsSection', () => ({ StatementsSection: () => null }));
vi.mock('@/pages/clients/LocationsSection', () => ({ LocationsSection: () => null }));
vi.mock('@/pages/clients/BenefitsPlansSection', () => ({ BenefitsPlansSection: () => null }));
vi.mock('@/pages/clients/QuickbooksSection', () => ({ QuickbooksSection: () => null }));
vi.mock('@/pages/clients/PortalAccessSection', () => ({ PortalAccessSection: () => null }));

import { getClient } from '@/lib/clientsApi';
import { ClientDetail } from '@/pages/clients/ClientDetail';

const CLIENT_A = '00000000-0000-4000-8000-00000000aaa1';
const CLIENT_B = '00000000-0000-4000-8000-00000000bbb2';

function client(id: string, name: string): ClientSummary {
  return { id, name, industry: null, status: 'ACTIVE', contactEmail: null, state: null };
}

/**
 * /clients/:id keeps the same element mounted from one client's URL to the
 * next. The query used to be keyed ['ClientDetail', 'client'] with no id,
 * so within the stale window the second URL painted the first client's
 * record. The key now carries the route id.
 */
describe('ClientDetail — the record follows the URL', () => {
  it('shows the second client after navigating from the first', async () => {
    vi.mocked(getClient).mockImplementation(async (id: string) =>
      client(id, id === CLIENT_A ? 'Acme Resort' : 'Beta Foods'),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    render(
      <MemoryRouter initialEntries={[`/clients/${CLIENT_A}`]}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route
              path="/clients/:id"
              element={
                <>
                  <ClientDetail />
                  <Link to={`/clients/${CLIENT_B}`}>Next client</Link>
                </>
              }
            />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Acme Resort' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Next client' }));
    expect(await screen.findByRole('heading', { name: 'Beta Foods' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Acme Resort' })).not.toBeInTheDocument();
    expect(getClient).toHaveBeenCalledWith(CLIENT_B);
  });
});
