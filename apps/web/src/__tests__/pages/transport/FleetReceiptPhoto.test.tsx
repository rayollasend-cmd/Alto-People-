import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { zonedDayKey } from '@/lib/format';
import type { FleetVan, TransportBoard } from '@/lib/transportApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/components/transport/LazyLiveMap', () => ({
  LazyLiveMap: ({ ariaLabel }: { ariaLabel: string }) => <div aria-label={ariaLabel} />,
}));

import { apiFetch } from '@/lib/api';
import { TransportHome } from '@/pages/transport/TransportHome';

/**
 * The driver's fuel receipt (transport walk 9 follow-up). The photo used to
 * be a key buried in the service log's note; it is the entry's own field
 * now, and the director sees it: a thumbnail on the van's Fleet card that
 * opens the receipt full size, and the same in the van's service log.
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PHOTO = '/transport/photos/0b1c2d3e-0000-4000-8000-00000000000a.jpg';

function renderAs(role: Role, ui: React.ReactElement) {
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'x@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: 'a' },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <ConfirmProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

function fleetVan(over: Partial<FleetVan> = {}): FleetVan {
  return {
    id: 'v1',
    name: 'Van 1',
    plate: 'ALT 101',
    capacity: 12,
    isActive: true,
    notes: null,
    make: 'Ford',
    model: 'Transit',
    color: 'White',
    year: 2023,
    look: 'White Ford Transit 2023',
    driver: null,
    stats: { revenueCents: 12500, waivedCents: 0, runs: 6, riders: 24, noShows: 1, seatFill: 33, miles: 84.5, daily: [] },
    now: null,
    ...over,
  };
}

const board = (): TransportBoard => ({
  date: zonedDayKey(new Date(), tz),
  settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10, shortNoticeMinutes: 90, dispatchPhone: null },
  kpis: { booked: 0, needsVan: 0, scheduled: 0, onBoard: 0, completed: 0, noShows: 0, cancelled: 0, vansOut: 0, runs: 0, openIssues: 0 },
  rides: [],
  runs: [],
  vans: [{ id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12, driverUserId: null }],
  drivers: [{ userId: 'd1', name: 'Mike Chen', role: 'DRIVER', phone: null }],
});

function routes(vans: FleetVan[]) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/transport/board')) return board() as never;
    if (path.startsWith('/transport/fleet')) return { from: '2026-09-22', to: '2026-10-21', vans } as never;
    if (path === '/transport/driver-access') return { rows: [], clients: [], drivers: [] } as never;
    if (path === '/transport/vans') return { vans: [] } as never;
    if (path === '/transport/vans/v1/record')
      return {
        record: {
          id: 'v1',
          name: 'Van 1',
          plate: 'ALT 101',
          vin: null,
          odometerMiles: 40_120,
          registrationExpiresAt: null,
          insuranceExpiresAt: null,
          inspectionDueAt: null,
          outOfService: null,
          documents: [],
        },
        serviceLog: [
          { id: 'e1', kind: 'FUEL', occurredAt: '2026-10-20', odometerMiles: 40_120, costCents: 6_212, vendor: null, notes: '18.4 gal', photoUrl: PHOTO },
          { id: 'e2', kind: 'OIL_CHANGE', occurredAt: '2026-09-01', odometerMiles: 35_300, costCents: 8_000, vendor: 'Jiffy', notes: null, photoUrl: null },
        ],
        checks: [],
        incidents: [],
      } as never;
    if (path === '/transport/me/live') return { live: null } as never;
    throw new Error(`unexpected ${path}`);
  });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the fuel receipt on the Fleet card', () => {
  it('shows the last fill-up with the receipt as a thumbnail that opens full size', async () => {
    routes([fleetVan({ lastFuel: { occurredAt: '2026-10-20', costCents: 6_212, notes: '18.4 gal', photoUrl: PHOTO } })]);
    renderAs('TRANSPORTATION_DIRECTOR', <TransportHome />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Fleet' }));
    const line = await screen.findByTestId('fleet-last-fuel');
    expect(line).toHaveTextContent('$62.12');
    expect(line).toHaveTextContent('18.4 gal');
    const link = within(line).getByRole('link', { name: /Van 1 fuel receipt — open full size/ });
    expect(link).toHaveAttribute('href', `/api${PHOTO}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(line).getByRole('img', { name: 'Van 1 fuel receipt' })).toHaveAttribute('src', `/api${PHOTO}`);
  });

  it('says so when the last fill-up has no receipt photo, and shows nothing for a van never fuelled', async () => {
    routes([
      fleetVan({ lastFuel: { occurredAt: '2026-10-20', costCents: 3_000, notes: null, photoUrl: null } }),
      fleetVan({ id: 'v2', name: 'Van 2', plate: 'ALT 102', lastFuel: null }),
    ]);
    renderAs('TRANSPORTATION_DIRECTOR', <TransportHome />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Fleet' }));
    const lines = await screen.findAllByTestId('fleet-last-fuel');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('no receipt photo');
    expect(within(lines[0]!).queryByRole('img')).toBeNull();
  });

  it('the van’s service log shows the receipt beside the fuel line', async () => {
    routes([fleetVan({ lastFuel: { occurredAt: '2026-10-20', costCents: 6_212, notes: '18.4 gal', photoUrl: PHOTO } })]);
    renderAs('TRANSPORTATION_DIRECTOR', <TransportHome />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Fleet' }));
    await screen.findByTestId('fleet-last-fuel');
    await userEvent.click(screen.getAllByRole('button', { name: 'Record' })[0]!);
    const dialog = await screen.findByRole('dialog');
    const receipt = await within(dialog).findByRole('link', { name: /Fuel receipt — open full size/ });
    expect(receipt).toHaveAttribute('href', `/api${PHOTO}`);
    // Only the fuel line carries a photo.
    expect(within(dialog).getAllByRole('img', { name: /receipt/i })).toHaveLength(1);
  });
});
