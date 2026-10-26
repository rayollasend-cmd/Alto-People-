import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ymdLocal } from '@/lib/format';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { PortalToday } from '@/pages/portal/PortalToday';

/**
 * F500 G5 — /portal/today: an empty day says what the contract asks for; a
 * finished shift with a slot nobody filled says so on its line; the header's
 * actions are one list (a phone gets one "More").
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function shiftDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

function renderAs(role: Role, user: Record<string, unknown>, entry: string) {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'x@example.com', role, status: 'ACTIVE', clientId: null, associateId: null, ...user } as never,
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter initialEntries={[entry]}>
          <PortalToday />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const day = (over: Record<string, unknown>) => ({
  client: { id: 'c1', name: 'Coastal' },
  store: { id: 'l1', name: 'Front Beach 218', timezone: tz },
  date: ymdLocal(),
  today: ymdLocal(),
  generatedAt: new Date().toISOString(),
  target: 3,
  roster: [],
  onFloorNow: [],
  summary: { expected: 0, worked: 0, onFloor: 0, missed: 0, open: 0 },
  windowLeads: [],
  ...over,
});

describe('<PortalToday> F500 G5', () => {
  it('an empty day says what the contract asks for, and the request opens filled in for the day', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/me/shift-windows') return { windows: [] };
      return day({
        nextShift: null,
        windowLeads: [{ locationId: 'l1', label: 'Morning', startMinute: 360, endMinute: 840, leads: [], targetCount: 8 }],
      });
    });
    renderAs('CLIENT_PORTAL', { clientId: 'c1', locationId: 'l1' }, '/portal/today');
    expect(await screen.findByTestId('today-contract-gap')).toHaveTextContent('Nothing scheduled against your contracted 8 (Morning).');
    const href = screen.getByRole('link', { name: 'Make a request' }).getAttribute('href')!;
    expect(new URLSearchParams(href.split('?')[1]).get('subject')).toMatch(/^Coverage for /);
  });

  it('two contracted windows are named with their counts', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/me/shift-windows') return { windows: [] };
      return day({
        nextShift: null,
        windowLeads: [
          { locationId: 'l1', label: 'Morning', startMinute: 360, endMinute: 840, leads: [], targetCount: 8 },
          { locationId: 'l1', label: 'Swing', startMinute: 840, endMinute: 1320, leads: [], targetCount: 6 },
        ],
      });
    });
    renderAs('CLIENT_PORTAL', { clientId: 'c1', locationId: 'l1' }, '/portal/today');
    expect(await screen.findByTestId('today-contract-gap')).toHaveTextContent('contracted 14 (Morning 8, Swing 6)');
  });

  it('a finished shift with a slot nobody filled says "Unfilled · 1 slot" on its line', async () => {
    const yesterday = shiftDays(ymdLocal(), -1);
    const base = Date.now() - 30 * 3_600_000;
    const iso = (mins: number) => new Date(base + mins * 60_000).toISOString();
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/me/shift-windows') return { windows: [] };
      return day({
        date: yesterday,
        roster: [
          {
            shiftId: 'o1', associateId: null, name: null, position: 'Stocker', isLead: false,
            startsAt: iso(0), endsAt: iso(8 * 60), timezone: tz, locationId: 'l1', locationName: 'Front Beach 218',
            clockInAt: null, clockOutAt: null, state: 'open',
          },
        ],
        summary: { expected: 0, worked: 0, onFloor: 0, missed: 0, open: 1 },
      });
    });
    renderAs('CLIENT_PORTAL', { clientId: 'c1', locationId: 'l1' }, `/portal/today?date=${yesterday}`);
    expect(await screen.findByTestId('wave-unfilled')).toHaveTextContent('Unfilled · 1 slot');
  });

  it('the header is one action list: report, schedule, CSV and print', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/me/shift-windows') return { windows: [] };
      return day({ nextShift: null });
    });
    renderAs('CLIENT_PORTAL', { clientId: 'c1', locationId: 'l1' }, '/portal/today');
    await screen.findByText('No shifts scheduled today.');
    // Two in view beside no primary, the rest in More (PageHeader's own rule).
    expect(screen.getByRole('button', { name: /Service report/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });
});
