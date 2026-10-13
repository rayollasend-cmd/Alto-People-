import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import type { AccessReport, AdminUser } from '@/lib/usersAdminApi';

vi.mock('@/lib/usersAdminApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/usersAdminApi')>();
  return {
    ...actual,
    listAdminUsers: vi.fn(),
    patchAdminUser: vi.fn(),
    forcePasswordReset: vi.fn(),
    unlockUser: vi.fn(),
    getAccessReport: vi.fn(),
    downloadAccessReportCsv: vi.fn(),
    deactivateUsers: vi.fn(),
    reactivateUser: vi.fn(),
  };
});
vi.mock('@/lib/clientsApi', () => ({ listClients: vi.fn(), listClientLocations: vi.fn() }));
vi.mock('@/lib/regionsApi', () => ({ listRegions: vi.fn() }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));
vi.mock('@/components/ShiftLeadsCard', () => ({ ShiftLeadsCard: () => null }));

import { deactivateUsers, getAccessReport, listAdminUsers, patchAdminUser, reactivateUser } from '@/lib/usersAdminApi';
import { listClients } from '@/lib/clientsApi';
import { listRegions } from '@/lib/regionsApi';
import { UsersAdmin } from '@/pages/admin/UsersAdmin';

const ME = 'u1';
const HR2 = '22222222-2222-4222-8222-222222222222';
const ANA = '33333333-3333-4333-8333-333333333333';
const BO = '44444444-4444-4444-8444-444444444444';
const PORTAL = '55555555-5555-4555-8555-555555555555';

function adminUser(over: Partial<AdminUser>): AdminUser {
  return {
    id: 'x',
    email: 'x@example.com',
    role: 'ASSOCIATE',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    associateId: null,
    associateName: null,
    clientId: null,
    clientName: null,
    locationId: null,
    locationName: null,
    regionId: null,
    regionName: null,
    lockedUntil: null,
    ...over,
  };
}

const users: AdminUser[] = [
  adminUser({ id: ME, email: 'me@alto.example', role: 'HR_ADMINISTRATOR' }),
  adminUser({ id: HR2, email: 'pat@alto.example', role: 'HR_ADMINISTRATOR', associateName: 'Pat Chair' }),
  adminUser({ id: PORTAL, email: 'store@client.example', role: 'CLIENT_PORTAL', clientId: 'c1', clientName: 'Coastal Resort' }),
];

const report: AccessReport = {
  generatedAt: '2026-10-13T12:00:00.000Z',
  counts: {
    totalAccounts: 4,
    byStatus: { ACTIVE: 3, INVITED: 0, DISABLED: 1 },
    byRole: { HR_ADMINISTRATOR: 1, ASSOCIATE: 2, CLIENT_PORTAL: 1 },
    activeAssociates: 1,
    flaggedAccounts: 3,
    byFlag: { PORTAL_PERSONAL_EMAIL: 1, REGION_SCOPE: 0, DUPLICATE_PERSON: 0, NO_EMPLOYMENT_RECORD: 0, EMPLOYMENT_ENDED: 1, NO_SIGN_IN_90D: 1, PENDING_DELETION: 1 },
  },
  rows: [
    { id: ME, email: 'me@alto.example', personalEmail: false, role: 'HR_ADMINISTRATOR', additionalRoles: [], status: 'ACTIVE', scope: 'Org-wide', clientId: null, locationId: null, regionId: null, associateId: null, personName: null, employment: 'NOT_APPLICABLE', createdAt: '2026-01-01T00:00:00.000Z', lastSignInAt: '2026-10-13T08:00:00.000Z', daysSinceSignIn: 0, deactivatedAt: null, deactivationReason: null, purgeAfter: null, flags: [] },
    { id: ANA, email: 'ana@example.com', personalEmail: false, role: 'ASSOCIATE', additionalRoles: [], status: 'ACTIVE', scope: 'Org-wide', clientId: null, locationId: null, regionId: null, associateId: 'a1', personName: 'Ana Reyes', employment: 'SEPARATED', createdAt: '2026-01-01T00:00:00.000Z', lastSignInAt: '2026-05-01T08:00:00.000Z', daysSinceSignIn: 165, deactivatedAt: null, deactivationReason: null, purgeAfter: null, flags: ['EMPLOYMENT_ENDED', 'NO_SIGN_IN_90D'] },
    { id: PORTAL, email: 'store.manager@gmail.com', personalEmail: true, role: 'CLIENT_PORTAL', additionalRoles: [], status: 'ACTIVE', scope: 'Coastal Resort · Pier Park', clientId: 'c1', locationId: 'l1', regionId: null, associateId: null, personName: null, employment: 'NOT_APPLICABLE', createdAt: '2026-06-01T00:00:00.000Z', lastSignInAt: '2026-10-12T08:00:00.000Z', daysSinceSignIn: 1, deactivatedAt: null, deactivationReason: null, purgeAfter: null, flags: ['PORTAL_PERSONAL_EMAIL'] },
    { id: BO, email: 'bo@example.com', personalEmail: false, role: 'ASSOCIATE', additionalRoles: [], status: 'DISABLED', scope: 'Org-wide', clientId: null, locationId: null, regionId: null, associateId: 'a2', personName: 'Bo Lee', employment: 'EMPLOYED', createdAt: '2026-01-01T00:00:00.000Z', lastSignInAt: null, daysSinceSignIn: null, deactivatedAt: '2026-10-01T00:00:00.000Z', deactivationReason: 'Left in September', purgeAfter: '2026-10-31T00:00:00.000Z', flags: ['PENDING_DELETION'] },
  ],
};

function renderPage(role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: ME, email: 'me@alto.example', role, status: 'ACTIVE' },
          loading: false,
          can: (c: Capability) => caps.has(c),
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/admin/users']}>
          <UsersAdmin />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAdminUsers).mockResolvedValue({ users, total: users.length });
  vi.mocked(listClients).mockResolvedValue({ clients: [{ id: 'c1', name: 'Coastal Resort' } as never] } as never);
  vi.mocked(listRegions).mockResolvedValue({ regions: [{ id: 'r1', name: 'Panhandle' } as never] } as never);
  vi.mocked(getAccessReport).mockResolvedValue(report);
  vi.mocked(patchAdminUser).mockResolvedValue(undefined);
  vi.mocked(deactivateUsers).mockResolvedValue({ deactivated: [{ id: ANA, email: 'ana@example.com', purgeAfter: '2026-11-12T00:00:00.000Z' }], skipped: [] });
  vi.mocked(reactivateUser).mockResolvedValue({ id: BO, status: 'ACTIVE' });
});

describe('UsersAdmin — Brief 1A-4', () => {
  it('shows the access report: counts, flags with their numbers, and the flagged rows first', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('me@alto.example');
    await user.click(screen.getByRole('radio', { name: 'Access report' }));
    expect(await screen.findByText('Flagged accounts')).toBeInTheDocument();
    expect(screen.getByText('Active associates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /No sign-in in 90 days 1/ })).toBeInTheDocument();
    expect(screen.getAllByText('Employment ended, account still on').length).toBeGreaterThan(0);
    expect(screen.getByText('store.manager@gmail.com')).toBeInTheDocument();
    expect(screen.getByText(/deletes/)).toBeInTheDocument();

    // A flag narrows the rows.
    await user.click(screen.getByRole('button', { name: /Portal login on a personal email 1/ }));
    await waitFor(() => expect(screen.queryByText('ana@example.com')).not.toBeInTheDocument());
    expect(screen.getByText('store.manager@gmail.com')).toBeInTheDocument();
  });

  it('deactivates the selected accounts with a reason and reactivates within the grace period', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('me@alto.example');
    await user.click(screen.getByRole('radio', { name: 'Access report' }));
    await screen.findByText('ana@example.com');

    const anaRow = screen.getByText('ana@example.com').closest('tr')!;
    await user.click(within(anaRow).getByRole('checkbox'));
    await user.click(await screen.findByRole('button', { name: /Deactivate selected/ }));
    const dialog = await screen.findByRole('dialog');
    const go = within(dialog).getByRole('button', { name: 'Deactivate' });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Left the company in September');
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() => expect(deactivateUsers).toHaveBeenCalledWith([ANA], 'Left the company in September'));

    // The pending-deletion row offers Reactivate.
    const boRow = screen.getByText('bo@example.com').closest('tr')!;
    await user.click(within(boRow).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(reactivateUser).toHaveBeenCalledWith(BO));
  });

  it('asks for a named approver before a portal account goes on a region', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('store@client.example');
    const regionSelect = screen.getByLabelText('Assign region') as HTMLSelectElement;
    await user.click(regionSelect);
    await waitFor(() => expect(within(regionSelect).getByRole('option', { name: 'Panhandle' })).toBeInTheDocument());
    await user.selectOptions(regionSelect, 'r1');
    const dialog = await screen.findByRole('dialog');
    expect(patchAdminUser).not.toHaveBeenCalled();
    const assign = within(dialog).getByRole('button', { name: 'Assign region' });
    expect(assign).toBeDisabled();
    const approver = within(dialog).getByLabelText(/Approved by/) as HTMLSelectElement;
    await waitFor(() => expect(within(approver).getByRole('option', { name: /Pat Chair/ })).toBeInTheDocument());
    await user.selectOptions(approver, HR2);
    await user.click(assign);
    await waitFor(() => expect(patchAdminUser).toHaveBeenCalledWith(PORTAL, { regionId: 'r1', approvedByUserId: HR2 }));
  });
});

describe('UsersAdmin — bulk Disabled goes the reversible way', () => {
  it('opens the deactivate dialog with a required reason instead of the plain status PATCH', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('store@client.example');
    const row = screen.getByText('store@client.example').closest('tr')!;
    await user.click(within(row).getByRole('checkbox'));
    await user.selectOptions(await screen.findByLabelText('Set status for selected users'), 'DISABLED');
    const dialog = await screen.findByRole('dialog');
    expect(patchAdminUser).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Store closed');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(deactivateUsers).toHaveBeenCalledWith([PORTAL], 'Store closed'));
    expect(patchAdminUser).not.toHaveBeenCalled();
  });
});
