import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, defaultTenantProfile, type Capability } from '@alto-people/shared';
import { AuthContext, type TenantSession } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { makeShift } from './scheduling/scheduleHarness';

/**
 * Role walk, ops 15 — New shift opens ready: client, location and position
 * from the board filter, else the last values used here, else the last
 * shift at that site; a client with no locations is never the default.
 */

const EMPTY = '88888888-8888-4888-8888-888888888888';
const HOTEL = '22222222-2222-4222-8222-222222222222';
const SITE = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/orgApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/orgApi')>()),
  listShiftPositions: vi.fn(async () => ({ shiftPositions: [{ id: 'p1', clientId: HOTEL, name: 'Housekeeper', sortOrder: 0, isLead: false }, { id: 'p2', clientId: HOTEL, name: 'Bellhop', sortOrder: 1, isLead: false }] })),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/clientsApi')>()),
  listClientLocations: vi.fn(async (clientId: string) => ({
    locations: clientId === HOTEL
      ? [{ id: SITE, clientId: HOTEL, name: 'Front Beach', addressLine1: null, addressLine2: null, city: null, state: 'FL', zip: null, latitude: null, longitude: null, geofenceRadiusMeters: null, isActive: true, timezone: 'America/Chicago' }]
      : [],
  })),
}));
vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  listSchedulingAssociates: vi.fn(async () => ({ associates: [], truncated: false })),
  getLastShift: vi.fn(async () => ({ shift: makeShift({ id: '99999999-9999-4999-8999-999999999999', position: 'Bellhop', startsAt: '2026-07-14T20:00:00.000Z', endsAt: '2026-07-15T04:00:00.000Z', timezone: 'America/Chicago' }) })),
}));

import { getLastShift } from '@/lib/schedulingApi';
import { CreateShiftDialog } from '@/pages/scheduling/AdminSchedulingView';

const clients = [
  { id: EMPTY, name: 'Alto HR — Internal Hires', industry: null, status: 'ACTIVE', contactEmail: null, state: null },
  { id: HOTEL, name: 'The Grand Hotel', industry: null, status: 'ACTIVE', contactEmail: null, state: 'FL' },
];

function renderDialog(props: Partial<React.ComponentProps<typeof CreateShiftDialog>> = {}) {
  const role = 'HR_ADMINISTRATOR' as const;
  const caps = ROLE_CAPABILITIES[role];
  const tenant: TenantSession = { id: 't', ...defaultTenantProfile('WORKFORCE_PROVIDER') };
  render(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <TooltipProvider>
          <MemoryRouter>
            <ConfirmProvider>
              <AuthContext.Provider
                value={{
                  isInitializing: false, isOffline: false,
                  user: { id: 'u1', email: 'hr@example.com', role, status: 'ACTIVE', clientId: null, locationId: null, regionId: null, associateId: null, language: 'en', additionalRoles: [], activeRole: null, pinnedModules: [] } as never,
                  role, primaryRole: role, availableRoles: [role], capabilities: caps, tenant,
                  signIn: vi.fn(), submitMfaChallenge: vi.fn(), signOut: vi.fn(), refreshUser: vi.fn(), switchRole: vi.fn(),
                  can: (c: Capability) => caps.has(c),
                }}
              >
                <CreateShiftDialog open clients={clients as never} associates={[]} onOpenChange={vi.fn()} onCreated={vi.fn()} {...props} />
              </AuthContext.Provider>
            </ConfirmProvider>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('<CreateShiftDialog> prefill', () => {
  it('skips a client with no locations, labels it, and takes the times and position from the last shift at the site', async () => {
    renderDialog();
    const client = await screen.findByLabelText(/^client/i);
    await waitFor(() => expect((client as HTMLSelectElement).value).toBe(HOTEL));
    expect(screen.getByRole('option', { name: /Alto HR — Internal Hires \(no locations\)/ })).toBeDisabled();
    await waitFor(() => expect(getLastShift).toHaveBeenCalledWith(expect.objectContaining({ locationId: SITE })));
    // 20:00Z on a July day is 3:00 PM in Chicago; the wall-clock, not UTC.
    await waitFor(() => expect((screen.getByLabelText(/start time/i) as HTMLInputElement).value).toBe('15:00'));
    expect((screen.getByLabelText(/end time/i) as HTMLInputElement).value).toBe('23:00');
    await waitFor(() => expect((screen.getByLabelText(/position/i) as HTMLSelectElement).value).toBe('Bellhop'));
  });

  it('the last values used in this browser win over the site history', async () => {
    window.localStorage.setItem('alto:sched.newShift.last.v1', JSON.stringify({ clientId: HOTEL, locationId: SITE, position: 'Housekeeper', startTime: '07:00', endTime: '15:00' }));
    renderDialog();
    await waitFor(() => expect((screen.getByLabelText(/start time/i) as HTMLInputElement).value).toBe('07:00'));
    expect((screen.getByLabelText(/end time/i) as HTMLInputElement).value).toBe('15:00');
    await waitFor(() => expect((screen.getByLabelText(/position/i) as HTMLSelectElement).value).toBe('Housekeeper'));
    expect(getLastShift).not.toHaveBeenCalled();
  });

  it('the board filter wins over everything', async () => {
    window.localStorage.setItem('alto:sched.newShift.last.v1', JSON.stringify({ clientId: EMPTY, position: 'Bellhop' }));
    renderDialog({ initialClientId: HOTEL, initialLocationId: SITE, initialPosition: 'Housekeeper' });
    const client = await screen.findByLabelText(/^client/i);
    await waitFor(() => expect((client as HTMLSelectElement).value).toBe(HOTEL));
    await waitFor(() => expect((screen.getByLabelText(/position/i) as HTMLSelectElement).value).toBe('Housekeeper'));
  });
});
