import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import type { MyTransport } from '@/lib/transportApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { RideHome } from '@/pages/transport/RideHome';

/**
 * F500 G2 — the Ride page: the hero, then one view at a time (Upcoming ·
 * History · Charges · Places, kept in ?view=), a sound switch that says
 * what it is, and the transportation director sent to the board's Rides
 * tab instead of the rider pitch.
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function me(over: Partial<MyTransport> = {}): MyTransport {
  return {
    settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10, shortNoticeMinutes: 90, dispatchPhone: null },
    consent: { acceptedAt: new Date().toISOString() },
    authorization: {
      current: true,
      signedAt: '2026-10-01T12:00:00.000Z',
      signedName: 'Kim Nguyen',
      version: 1,
      fareCents: 500,
      noShowFeeCents: 100,
      withdrawnAt: null,
      documentId: 'doc-1',
      reason: null,
      agreement: null,
    },
    places: [],
    stops: [{ id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' }],
    stores: [{ id: 'l1', name: 'Front Beach 218', timezone: tz, clientName: 'Coastal Resort Holdings', address: null }],
    shifts: [],
    rides: [],
    defaultPickup: null,
    defaultStoreId: 'l1',
    charges: { pendingCents: 0, rides: 0, noShows: 0, nextPayday: null },
    ...over,
  } as MyTransport;
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function renderAs(role: Role, entry = '/rides') {
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
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route path="/rides" element={<RideHome />} />
              <Route path="/transport" element={<p>The board</p>} />
            </Routes>
            <Where />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

function serve(data: MyTransport) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/transport/me') return data as never;
    if (path === '/transport/me/live') return { live: null } as never;
    throw new Error(`unexpected ${path}`);
  });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the Ride page, one view at a time', () => {
  it('opens on Upcoming and keeps the picked view in the URL', async () => {
    serve(me({ places: [{ id: 'p1', label: 'Home', address: '12 Palm St', lat: null, lng: null }] as MyTransport['places'] }));
    renderAs('ASSOCIATE');
    const upcoming = await screen.findByRole('radio', { name: 'Upcoming' });
    expect(upcoming).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ride-view-upcoming')).toBeInTheDocument();
    // Charges, the authorization and saved places are not stacked below it.
    expect(screen.queryByText(/Signed .* as Kim Nguyen/)).not.toBeInTheDocument();
    expect(screen.queryByText('12 Palm St')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Places' }));
    expect(await screen.findByText('12 Palm St')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/rides?view=places');

    await userEvent.click(screen.getByRole('radio', { name: 'History' }));
    expect(await screen.findByText('No past rides yet.')).toBeInTheDocument();
  });

  it('a link to ?view=charges opens on the charges and the signed authorization', async () => {
    serve(me());
    renderAs('ASSOCIATE', '/rides?view=charges');
    expect(await screen.findByText(/Signed .* as Kim Nguyen/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Charges' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the sound switch says what it is', async () => {
    serve(me());
    renderAs('ASSOCIATE');
    const toggle = await screen.findByRole('button', { name: /Sounds (on|off) — tap/ });
    expect(toggle).toHaveTextContent(/Sounds (on|off)/);
  });
});

describe('the transportation director', () => {
  it('who is placed nowhere is sent to the board’s Rides tab, not the rider pitch', async () => {
    serve(me({ stores: [], rides: [] }));
    renderAs('TRANSPORTATION_DIRECTOR');
    expect(await screen.findByText('The board')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/transport?tab=rides');
  });

  it('an associate with no placement still sees their own page', async () => {
    serve(me({ stores: [], authorization: null, consent: null } as Partial<MyTransport>));
    renderAs('ASSOCIATE');
    expect(await screen.findByRole('heading', { level: 1, name: 'Ride' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/rides');
  });
});
