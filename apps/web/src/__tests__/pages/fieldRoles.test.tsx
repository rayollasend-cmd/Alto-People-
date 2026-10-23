import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

/**
 * The field roles' new pages (2026-10): the credential wallet and its
 * public link, the supervisor corps, and a season plan tried on the live
 * week.
 */

vi.mock('@/lib/walletApi', () => ({
  getMyWallet: vi.fn(),
  shareMyWallet: vi.fn(),
  getPublicWallet: vi.fn(),
  // The worker badge card on the wallet page (WorkerBadgeCard): no badge for this person.
  getWorkerBadge: vi.fn().mockRejectedValue(Object.assign(new Error('no badge'), { code: 'no_badge' })),
  getAppleWalletLink: vi.fn(),
  getGoogleWalletLink: vi.fn(),
}));
vi.mock('@/lib/workforceApi', () => ({
  listSupervisorCorps: vi.fn(),
  placeSupervisor: vi.fn(),
}));
vi.mock('@/lib/shiftWindowsApi', () => ({
  listClientShiftWindows: vi.fn().mockResolvedValue({ stores: [{ locationId: 'l2', locationName: 'Pier Park', timezone: 'America/Chicago', windows: [{ label: 'Morning', startMinute: 360, endMinute: 840, targetCount: 4, leads: [] }] }] }),
  setSupervisorShiftWindows: vi.fn().mockResolvedValue({ windows: [] }),
  getShiftCoverageGaps: vi.fn().mockResolvedValue({ total: 0, covered: 0, clients: [] }),
  setFloorSupervisorLead: vi.fn(),
  getLeadFloorTeam: vi.fn(),
}));
vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn().mockResolvedValue({ clients: [{ id: 'c1', name: 'Walmart 218' }, { id: 'c2', name: 'Target 9' }], nextCursor: null }),
  listClientLocations: vi.fn().mockResolvedValue({ locations: [{ id: 'l2', clientId: 'c2', name: 'Pier Park', isActive: true }] }),
}));
vi.mock('@/lib/seasonPlansApi', () => ({
  getSeasonPlanLive: vi.fn(),
  applySeasonPlanLive: vi.fn(),
  discardSeasonPlanLive: vi.fn(),
}));

import { getMyWallet, getPublicWallet, shareMyWallet } from '@/lib/walletApi';
import { listSupervisorCorps, placeSupervisor } from '@/lib/workforceApi';
import { setSupervisorShiftWindows } from '@/lib/shiftWindowsApi';
import { applySeasonPlanLive, getSeasonPlanLive } from '@/lib/seasonPlansApi';
import { MyWallet } from '@/pages/me/MyWallet';
import { WalletVerifyPage } from '@/pages/public/WalletVerifyPage';
import { SupervisorCorps } from '@/pages/scheduling/SupervisorCorps';
import { LiveWhatIfCard } from '@/components/planner/LiveWhatIfCard';

function renderAs(role: Role, ui: React.ReactNode, path = '/') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'me@example.com', role, status: 'ACTIVE', clientId: null, associateId: role === 'ASSOCIATE' ? 'a' : null } as never,
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        } as never}
      >
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const wallet = {
  person: { name: 'Ana Lopez', since: '2025-01-01T00:00:00Z' },
  items: [
    { kind: 'qualification' as const, id: 'q1', title: 'Forklift certified', issuer: 'Walmart 218', earnedAt: '2026-01-02T00:00:00Z', expiresAt: '2026-10-27T00:00:00Z', state: 'expiring' as const },
    { kind: 'training' as const, id: 't1', title: 'Food safety', issuer: null, earnedAt: '2026-03-01T00:00:00Z', expiresAt: null, state: 'valid' as const },
  ],
};

beforeEach(() => {
  vi.mocked(getMyWallet).mockResolvedValue(wallet);
});

describe('the credential wallet', () => {
  it('lists each credential with its state and expiry, and makes a link that expires', async () => {
    vi.mocked(shareMyWallet).mockResolvedValue({ token: 'tok', path: '/w/tok', expiresAt: '2026-10-24T00:00:00Z' });
    renderAs('ASSOCIATE', <MyWallet />);
    expect(await screen.findByText('Forklift certified')).toBeInTheDocument();
    expect(screen.getByText('Expiring soon')).toBeInTheDocument();
    expect(screen.getByText('No expiry', { exact: false })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share a link' }));
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(shareMyWallet).toHaveBeenCalledWith(7);
    expect(await screen.findByDisplayValue(`${window.location.origin}/w/tok`)).toBeInTheDocument();
  });

  it('the shared link shows the name and the credentials, and says so plainly when it has expired', async () => {
    vi.mocked(getPublicWallet).mockResolvedValue({ ...wallet, expiresAt: '2026-10-24T00:00:00Z' });
    renderAs('ASSOCIATE', <Routes><Route path="/w/:token" element={<WalletVerifyPage />} /></Routes>, '/w/tok');
    const card = await screen.findByTestId('wallet-public');
    expect(within(card).getByRole('heading', { name: 'Ana Lopez' })).toBeInTheDocument();
    expect(card).toHaveTextContent('2 credentials on record');
    expect(card).toHaveTextContent('Forklift certified');
  });
});

describe('the supervisor corps', () => {
  it('groups the corps by client, flags the unplaced, and places one at a client, store and shift', async () => {
    vi.mocked(listSupervisorCorps).mockResolvedValue({
      supervisors: [
        { userId: 'u1', role: 'SHIFT_SUPERVISOR', email: 'dana@x.com', name: 'Dana Reyes', phone: null, associateId: null, clientId: 'c1', clientName: 'Walmart 218', locationId: null, windows: [{ locationId: 'l1', label: 'Overnight' }], lead: null },
        { userId: 'u2', role: 'FLOOR_SUPERVISOR', email: 'omar@x.com', name: 'Omar Diaz', phone: null, associateId: null, clientId: null, clientName: null, locationId: null, windows: [], lead: null },
      ],
    });
    vi.mocked(placeSupervisor).mockResolvedValue({ userId: 'u2', clientId: 'c2', locationId: 'l2', windowsDropped: false });
    renderAs('WORKFORCE_MANAGER', <SupervisorCorps />);
    expect(await screen.findByText('Dana Reyes')).toBeInTheDocument();
    // The filter is the kit's pill row; each card says what its count is.
    expect(screen.getByRole('radio', { name: 'Not placed (1)' })).toBeInTheDocument();
    expect(screen.getAllByTestId('corps-count').map((n) => n.textContent)).toEqual(['1 not placed', '1 placed']);
    expect(screen.getByText('Overnight')).toBeInTheDocument();

    const user = userEvent.setup();
    const omarRow = screen.getByText('Omar Diaz').closest('li')!;
    await user.click(within(omarRow).getByRole('button', { name: 'Place' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place Omar Diaz' });
    const [client, store, shift] = within(dialog).getAllByRole('combobox');
    await user.selectOptions(client!, 'c2');
    await within(dialog).findByRole('option', { name: 'Pier Park' });
    await user.selectOptions(store!, 'l2');
    await within(dialog).findByRole('option', { name: 'Morning' });
    await user.selectOptions(shift!, 'Morning');
    await user.click(within(dialog).getByRole('button', { name: 'Place' }));
    expect(placeSupervisor).toHaveBeenCalledWith('u2', { clientId: 'c2', locationId: 'l2' });
    expect(setSupervisorShiftWindows).toHaveBeenCalledWith('u2', [{ locationId: 'l2', label: 'Morning' }]);
  });
});

describe('a season plan on the live week', () => {
  const live = {
    planId: 'p1',
    week: '2026-10-17',
    shiftHours: 8,
    rows: [
      { locationId: 'l1', siteName: 'Front Beach', clientId: 'c1', clientName: 'Walmart', date: '2026-10-18', part: 'day' as const, planned: 3, scheduled: 1, gap: 2, over: 0, drafted: 0 },
    ],
    totals: { planned: 3, scheduled: 1, gap: 2, over: 0, drafted: 0, gapHours: 16, gapCost: 320, unpriced: 0 },
  };

  it('shows the gap, its hours and cost, and applies it as drafts', async () => {
    vi.mocked(getSeasonPlanLive).mockResolvedValue(live);
    vi.mocked(applySeasonPlanLive).mockResolvedValue({ week: '2026-10-17', created: 2 });
    renderAs('WORKFORCE_MANAGER', <LiveWhatIfCard planId="p1" weeks={['2026-10-17', '2026-10-24']} />);
    const card = await screen.findByTestId('live-what-if');
    expect((await within(card).findAllByText('Front Beach'))[0]).toBeInTheDocument();
    expect(card).toHaveTextContent('2 short');
    expect(card).toHaveTextContent('$320.00');
    await userEvent.setup().click(within(card).getByRole('button', { name: /apply as draft shifts/i }));
    expect(applySeasonPlanLive).toHaveBeenCalledWith('p1', '2026-10-17');
  });

  it('a reader without manage:scheduling sees the preview and no buttons', async () => {
    vi.mocked(getSeasonPlanLive).mockResolvedValue(live);
    renderAs('EXECUTIVE_CHAIRMAN', <LiveWhatIfCard planId="p1" weeks={['2026-10-17']} />);
    const card = await screen.findByTestId('live-what-if');
    expect((await within(card).findAllByText('Front Beach'))[0]).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
  });
});
