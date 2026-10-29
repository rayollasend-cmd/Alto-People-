import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: api.apiFetch }));
const gaps = vi.hoisted(() => ({ getShiftCoverageGaps: vi.fn() }));
vi.mock('@/lib/shiftWindowsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/shiftWindowsApi')>()), getShiftCoverageGaps: gaps.getShiftCoverageGaps }));

import { OpsStoresToday, type OpsStoreRow } from '@/components/home/OpsStoresToday';

/**
 * LEAD-10 (deep audit 2026-10-29): the ops home's "Stores today" drew one
 * row per CLIENT under a "Store" header — "2 stores" with four, Coastal's
 * three rolled into one, so Front Beach at 0 of 2 on the floor was invisible.
 */

const base = { onFloor: 0, scheduledNow: 0, scheduledToday: 0, openToday: 0, callOutsToday: 0, confirmedTomorrow: 0, unconfirmedTomorrow: 0, openTomorrow: 0, noShowsToday: 0, incidentsToday: 0, unscheduledNow: 0, status: 'green' as const };
const site = (over: Partial<OpsStoreRow>): OpsStoreRow => ({ ...base, clientId: 'c1', clientName: 'Coastal Resort Holdings', ...over });

describe('<OpsStoresToday> one row per store', () => {
  it('lists every store with its client under it, and the store that is short', async () => {
    api.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/workforce/overview') {
        return {
          today: {
            stores: [site({ key: undefined, scheduledToday: 9 }), site({ clientId: 'c2', clientName: 'Seaside Hospitality Group' })],
            sites: [
              site({ key: 'c1|l1', locationId: 'l1', locationName: 'Front Beach 218', onFloor: 0, scheduledNow: 2, scheduledToday: 4, status: 'red' }),
              site({ key: 'c1|l2', locationId: 'l2', locationName: 'Bayfront 12', onFloor: 3, scheduledNow: 3, scheduledToday: 3 }),
              site({ key: 'c1|l3', locationId: 'l3', locationName: 'Harbor 7', scheduledToday: 2 }),
              site({ key: 'c2|l4', locationId: 'l4', locationName: 'Seaside Main', clientId: 'c2', clientName: 'Seaside Hospitality Group', scheduledToday: 5 }),
            ],
          },
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    gaps.getShiftCoverageGaps.mockResolvedValue({ clients: [{ clientId: 'c1', clientName: 'Coastal', uncovered: [{ locationId: 'l1', locationName: 'Front Beach 218', label: 'Overnight', startMinute: 1320, endMinute: 360 }] }] });
    const role = 'OPERATIONS_MANAGER' as const;
    const caps = ROLE_CAPABILITIES[role];
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: { id: 'u', email: 'ops@x.example', role, status: 'ACTIVE', clientId: null, associateId: null } as never,
            role,
            capabilities: new Set<Capability>(caps),
            signIn: vi.fn(),
            signOut: vi.fn(),
            can: (c: Capability) => caps.has(c),
          }}
        >
          <MemoryRouter>
            <OpsStoresToday />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    const front = (await screen.findAllByText('Front Beach 218'))[0]!;
    expect(screen.getAllByText('Bayfront 12').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Harbor 7').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Seaside Main').length).toBeGreaterThan(0);
    // The client is named under its store; it is not a row of its own.
    const row = front.closest('tr') ?? front.closest('li') ?? front.parentElement!.parentElement!;
    expect(within(row as HTMLElement).getByText(/Coastal Resort Holdings/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/0 of 2/)).toBeInTheDocument();
    expect(screen.getAllByText(/4 stores/i).length).toBeGreaterThan(0);
  });
});
