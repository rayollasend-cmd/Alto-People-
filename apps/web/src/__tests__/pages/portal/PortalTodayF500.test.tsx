import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
import { PortalToday, dayRecord } from '@/pages/portal/PortalToday';

/**
 * F500 G2 — /today: a region account picks a store instead of a dead red
 * banner; a day with nothing scheduled says when the next shift is and
 * offers the two ways forward; a past day says "worked", the hours and the
 * late arrivals.
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

describe('<PortalToday> F500', () => {
  it('a region account with no store named picks one from its region — never calls the day API', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path.startsWith('/region/overview')) {
        return {
          region: { id: 'r1', name: 'Gulf' },
          stores: [
            { id: 's1', name: 'Front Beach 218', clientName: 'Coastal', now: { onFloor: 4 } },
            { id: 's2', name: 'Destin 301', clientName: 'Coastal', now: { onFloor: 0 } },
          ],
        };
      }
      if (path === '/me/shift-windows') return { windows: [] };
      throw new Error(`unexpected ${path}`);
    });
    renderAs('CLIENT_PORTAL', { regionId: 'r1' }, '/today');
    const picker = await screen.findByTestId('region-store-picker');
    const links = within(picker).getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/today?locationId=s1');
    expect(links[0]).toHaveTextContent('4 on the floor now');
    expect(vi.mocked(apiFetch).mock.calls.some(([p]) => String(p).startsWith('/client-portal/day'))).toBe(false);
    expect(screen.queryByText("Couldn't load your store view.")).not.toBeInTheDocument();
  });

  it('a day with nothing scheduled names the next shift and offers Request staff and Full schedule', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/me/shift-windows') return { windows: [] };
      return day({ nextShift: { startsAt: '2026-10-24T19:00:00.000Z', endsAt: '2026-10-25T03:00:00.000Z', position: 'Stocker', timezone: tz } });
    });
    renderAs('CLIENT_PORTAL', { clientId: 'c1', locationId: 'l1' }, '/today');
    expect(await screen.findByText('No shifts scheduled today.')).toBeInTheDocument();
    expect(screen.getByText(/^The next shift is .*Oct 24.* · Stocker\.$/)).toBeInTheDocument();
    // The request opens filled in with the day (F500 G5).
    const req = screen.getByRole('link', { name: 'Request staff' }).getAttribute('href')!;
    expect(req.startsWith('/portal/requests?new=STAFFING&subject=Coverage+for+')).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Full schedule' }).length).toBeGreaterThan(0);
  });

  it('a past day says "worked", the hours and the late arrivals', async () => {
    const yesterday = shiftDays(ymdLocal(), -1);
    const base = Date.now() - 30 * 3_600_000;
    const iso = (mins: number) => new Date(base + mins * 60_000).toISOString();
    const row = (id: string, inMin: number | null, outMin: number | null, state: string) => ({
      shiftId: id, associateId: `a-${id}`, name: `P ${id}`, position: 'Stocker', isLead: false,
      startsAt: iso(0), endsAt: iso(8 * 60), timezone: tz, locationId: 'l1', locationName: 'Front Beach 218',
      clockInAt: inMin === null ? null : iso(inMin), clockOutAt: outMin === null ? null : iso(outMin), state,
    });
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/me/shift-windows') return { windows: [] };
      return day({
        date: yesterday,
        roster: [row('1', 0, 480, 'worked'), row('2', 20, 470, 'worked'), row('3', null, null, 'missed')],
        summary: { expected: 3, worked: 2, onFloor: 0, missed: 1, open: 0 },
      });
    });
    renderAs('CLIENT_PORTAL', { clientId: 'c1', locationId: 'l1' }, `/today?date=${yesterday}`);
    // 8h + 7.5h worked of 3 × 8h scheduled; one in 20 minutes after start.
    expect(
      await screen.findByText(/^2 of 3 worked · 1 did not punch in · 0 unfilled · 15.5h worked of 24h scheduled · 1 late arrival/),
    ).toBeInTheDocument();
  });
});

describe('dayRecord', () => {
  it('counts scheduled and worked minutes and the late punches past the grace', () => {
    const r = (start: string, end: string, inAt: string | null, outAt: string | null, state = 'worked') =>
      ({ startsAt: start, endsAt: end, clockInAt: inAt, clockOutAt: outAt, state }) as never;
    const out = dayRecord([
      r('2026-10-20T14:00:00Z', '2026-10-20T22:00:00Z', '2026-10-20T14:07:00Z', '2026-10-20T22:00:00Z'), // 7 min: inside the grace
      r('2026-10-20T14:00:00Z', '2026-10-20T22:00:00Z', '2026-10-20T14:08:00Z', '2026-10-20T21:08:00Z'), // late
      r('2026-10-20T14:00:00Z', '2026-10-20T18:00:00Z', null, null, 'open'), // unfilled: not scheduled hours
    ]);
    expect(out).toEqual({ scheduledMin: 960, workedMin: 473 + 420, late: 1 });
  });
});
