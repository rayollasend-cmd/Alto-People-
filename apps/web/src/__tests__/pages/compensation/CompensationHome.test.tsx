import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import type { CompOverview } from '@/lib/compApi';

vi.mock('@/lib/compApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/compApi')>()),
  getCompOverview: vi.fn(),
  listBands: vi.fn(),
  listCycles: vi.fn(),
}));
const scope = vi.hoisted(() => ({ clientId: 'c1', setClientId: vi.fn() }));
vi.mock('@/lib/storeScope', () => ({
  useStoreScope: () => ({ clientId: scope.clientId, setClientId: scope.setClientId, clients: [{ id: 'c1', name: 'Harbor Inn' }], enabled: true, ready: true }),
}));

import { getCompOverview, listBands, listCycles } from '@/lib/compApi';
import { CompensationHome } from '@/pages/compensation/CompensationHome';

/**
 * Compensation (F500 2026-10-22) opens on an Overview — who is paid outside
 * their band, pay changes waiting, the live merit cycle — instead of the
 * band editor for a client picked in a separate card.
 */

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function renderPage(path = '/compensation') {
  const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'hr@example.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE' as const, clientId: null, associateId: null },
          role: 'HR_ADMINISTRATOR',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <CompensationHome />
            <Where />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const overview: CompOverview = {
  people: 7,
  belowMin: 1,
  aboveMax: 1,
  inBand: 2,
  noBand: 2,
  noRate: 1,
  outsideBand: [
    { associateId: 'a1', name: 'Ana Test', payType: 'HOURLY', amount: '15.00', band: 'Housekeeping', min: '16.00', max: '22.00', where: 'BELOW' },
    { associateId: 'a2', name: 'Cy Test', payType: 'HOURLY', amount: '24.00', band: 'Housekeeping', min: '16.00', max: '22.00', where: 'ABOVE' },
  ],
  outsideTruncated: false,
  pendingPayChanges: 2,
  cycle: { id: 'cy', name: 'FY27 merit', status: 'OPEN', effectiveDate: '2026-12-01', budget: '10000.00', spent: '3120.00', people: 2, pending: 1 },
};

beforeEach(() => {
  scope.clientId = 'c1';
  vi.mocked(getCompOverview).mockResolvedValue(overview);
  vi.mocked(listBands).mockResolvedValue({ bands: [] });
  vi.mocked(listCycles).mockResolvedValue({ cycles: [] });
});

describe('Compensation', () => {
  it('opens on the overview for the topbar’s client: outside the band, waiting, the cycle', async () => {
    renderPage();
    expect(screen.getByRole('tab', { name: 'Overview', selected: true })).toBeInTheDocument();
    const strip = await screen.findByRole('group', { name: 'Compensation at a glance' });
    expect(getCompOverview).toHaveBeenCalledWith('c1');
    const tile = (label: string) => within(strip).getByText(label).parentElement!.parentElement!;
    expect(within(strip).getByText('Below band minimum')).toBeInTheDocument();
    expect(within(strip).getAllByText('of 4 people with a band')).toHaveLength(2);
    expect(within(strip).getByText('Pay changes waiting').closest('a')).toHaveAttribute('href', '/approvals?queue=requests');
    expect(within(strip).getByText('31% of budget')).toBeInTheDocument();
    expect(within(strip).getByText(/FY27 merit · \$3,120\.00 of \$10,000\.00 · 1 still open/)).toBeInTheDocument();
    expect(tile('Merit cycle')).toBeTruthy();
    expect(screen.getByText(/7 people · 2 paid inside their band · 2 with no band for their role · 1 with no rate on file/)).toBeInTheDocument();
    expect(await screen.findByText('Ana Test')).toBeInTheDocument();
    expect(screen.getByText('Below minimum')).toBeInTheDocument();
    expect(screen.getByText('$15.00/hr')).toBeInTheDocument();
  });

  it('says there are no bands instead of showing zeros, and offers to make one', async () => {
    vi.mocked(getCompOverview).mockResolvedValue({ ...overview, belowMin: 0, aboveMax: 0, inBand: 0, noBand: 6, outsideBand: [], cycle: null });
    renderPage();
    expect(await screen.findByText('No pay bands yet')).toBeInTheDocument();
    expect(screen.getAllByText('No one has a band yet')).toHaveLength(2);
    expect(screen.getByText('No merit cycle running')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /New band/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/compensation?tab=bands'));
  });

  it('keeps the tab in the URL — Planning included, which used to fall back to Pay bands', async () => {
    renderPage('/compensation?tab=planning');
    expect(screen.getByRole('tab', { name: 'Planning', selected: true })).toBeInTheDocument();
  });

  it('gives an empty band list an icon and a New band action', async () => {
    renderPage('/compensation?tab=bands');
    expect(await screen.findByText('No pay bands yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New band/ }).length).toBeGreaterThan(0);
  });
});
