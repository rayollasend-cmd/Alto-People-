import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, defaultTenantProfile, type Capability, type TenantProfile } from '@alto-people/shared';
import { AuthContext, type TenantSession } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/Tooltip';

/**
 * Brief 2-1b — a hotel creates a shift from the schedule page: no client
 * field, the tenant's sites in the location picker, the people placed at
 * the chosen site in the assignee picker, and a create that names only the
 * site. With the client portal on, the dialog still asks for a client.
 */

const SITE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

vi.mock('@/lib/orgApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/orgApi')>()),
  listSites: vi.fn(async () => ({
    sites: [
      { id: SITE, name: 'The Grand Hotel', type: 'PROPERTY', timezone: 'America/Chicago', state: 'FL', isActive: true, clientId: null, clientName: null, orgUnitId: null, orgUnitName: null, orgUnitType: null },
    ],
  })),
  listShiftPositions: vi.fn(async () => ({ shiftPositions: [{ id: 'p1', clientId: '', name: 'Housekeeper', sortOrder: 0, isLead: false }] })),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/clientsApi')>()),
  listClientLocations: vi.fn(async () => ({ locations: [] })),
}));
vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  createShift: vi.fn(async () => ({ id: 's1' })),
  bulkCreateShifts: vi.fn(async () => ({ created: 1, skipped: [] })),
  listSchedulingAssociates: vi.fn(async () => ({ associates: [{ id: 'a1', firstName: 'Tess', lastName: 'Member', email: 'tess@example.com' }] })),
}));

import { createShift, listSchedulingAssociates } from '@/lib/schedulingApi';
import { listClientLocations } from '@/lib/clientsApi';
import { CreateShiftDialog } from '@/pages/scheduling/AdminSchedulingView';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(profile: TenantProfile, clients: Array<{ id: string; name: string }> = []) {
  const role = 'HR_ADMINISTRATOR' as const;
  const caps = ROLE_CAPABILITIES[role];
  const tenant: TenantSession = { id: 't', ...profile };
  const onCreated = vi.fn();
  render(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <TooltipProvider>
          <MemoryRouter>
            <ConfirmProvider>
              <AuthContext.Provider
                value={{
                  isInitializing: false,
                  isOffline: false,
                  user: { id: 'u1', email: 'hr@hotel.example', role, status: 'ACTIVE', clientId: null, locationId: null, regionId: null, associateId: null, language: 'en', additionalRoles: [], activeRole: null, pinnedModules: [] } as never,
                  role,
                  primaryRole: role,
                  availableRoles: [role],
                  capabilities: caps,
                  tenant,
                  signIn: vi.fn(),
                  submitMfaChallenge: vi.fn(),
                  signOut: vi.fn(),
                  refreshUser: vi.fn(),
                  switchRole: vi.fn(),
                  can: (c: Capability) => caps.has(c),
                }}
              >
                <CreateShiftDialog
                  open
                  clients={clients as never}
                  associates={[]}
                  onOpenChange={vi.fn()}
                  onCreated={onCreated}
                />
              </AuthContext.Provider>
            </ConfirmProvider>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { onCreated };
}

describe('<CreateShiftDialog> for a tenant without clients', () => {
  it('asks for no client, offers the tenant\'s sites, and creates a shift that names only the site', async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog(defaultTenantProfile('DIRECT_EMPLOYER'));

    // The site is picked for the single-site case; no client field at all.
    const location = await screen.findByLabelText(/location/i);
    await waitFor(() => expect((location as HTMLSelectElement).value).toBe(SITE));
    expect(screen.queryByLabelText(/^client/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no clients available/i)).not.toBeInTheDocument();

    // The assignee picker reads the people placed at that site.
    await waitFor(() => expect(listSchedulingAssociates).toHaveBeenCalledWith({ locationId: SITE }));
    expect(listClientLocations).not.toHaveBeenCalled();

    const position = screen.getByLabelText(/position/i);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Housekeeper' })).toBeInTheDocument());
    await user.selectOptions(position, 'Housekeeper');
    await user.click(screen.getByRole('button', { name: /save as draft/i }));

    await waitFor(() => expect(createShift).toHaveBeenCalledTimes(1));
    const body = vi.mocked(createShift).mock.calls[0]![0];
    expect(body).toMatchObject({ locationId: SITE, position: 'Housekeeper', status: 'DRAFT' });
    expect(body).not.toHaveProperty('clientId');
    expect(onCreated).toHaveBeenCalled();
  });

  it('with the client portal on, the client field is still there and the create names the client', async () => {
    const user = userEvent.setup();
    vi.mocked(listClientLocations).mockResolvedValueOnce({
      locations: [{ id: SITE, clientId: CLIENT, name: 'Front Beach 218', addressLine1: null, addressLine2: null, city: null, state: 'FL', zip: null, latitude: null, longitude: null, geofenceRadiusMeters: null, isActive: true, timezone: 'America/Chicago' }],
    } as never);
    renderDialog(defaultTenantProfile('WORKFORCE_PROVIDER'), [{ id: CLIENT, name: 'Coastal Resort Holdings' }]);

    expect(await screen.findByLabelText(/^client/i)).toBeInTheDocument();
    const location = screen.getByLabelText(/location/i);
    await waitFor(() => expect((location as HTMLSelectElement).value).toBe(SITE));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Housekeeper' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText(/position/i), 'Housekeeper');
    await user.click(screen.getByRole('button', { name: /save as draft/i }));

    await waitFor(() => expect(createShift).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createShift).mock.calls[0]![0]).toMatchObject({ clientId: CLIENT, locationId: SITE });
  });
});
