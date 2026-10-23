import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import type { AccessReport as AccessReportData, AdminUser } from '@/lib/usersAdminApi';

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
    inviteUser: vi.fn(),
  };
});
vi.mock('@/lib/clientsApi', () => ({ listClients: vi.fn(), listClientLocations: vi.fn(), invitePortalUser: vi.fn() }));
vi.mock('@/lib/regionsApi', () => ({ listRegions: vi.fn() }));
vi.mock('@/lib/shiftWindowsApi', async (importOriginal) => ({ ...(await importOriginal<object>()), getShiftCoverageGaps: vi.fn() }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn(), useConfirmIfMounted: () => null }));

import { deactivateUsers, getAccessReport, inviteUser, listAdminUsers, patchAdminUser, reactivateUser } from '@/lib/usersAdminApi';
import { listClients } from '@/lib/clientsApi';
import { listRegions } from '@/lib/regionsApi';
import { getShiftCoverageGaps } from '@/lib/shiftWindowsApi';
import { UsersAdmin } from '@/pages/admin/UsersAdmin';
import { AccessReport } from '@/pages/admin/AccessReport';

/**
 * Users & access (F500 G4): a read-only list — one line per account, the
 * status chips and default view, a drawer where anything changes, and
 * Invite user. The access report lives on Access certifications now.
 */

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
  adminUser({ id: ME, email: 'me@alto.example', role: 'HR_ADMINISTRATOR', mfaEnabled: true, lastSeenAt: new Date().toISOString() }),
  adminUser({ id: HR2, email: 'pat@alto.example', role: 'HR_ADMINISTRATOR', associateName: 'Pat Chair', additionalRoles: ['DRIVER'], scopeSiteIds: ['s1', 's2'] }),
  adminUser({ id: PORTAL, email: 'store@client.example', role: 'CLIENT_PORTAL', clientId: 'c1', clientName: 'Coastal Resort', locationId: 'l1', locationName: 'Pier Park' }),
];

const report: AccessReportData = {
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

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function renderPage(path = '/admin/users', role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR', body: React.ReactNode = <UsersAdmin />) {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: ME, email: 'me@alto.example', role, status: 'ACTIVE' },
          tenant: DEFAULT_TENANT,
          loading: false,
          can: (c: Capability) => caps.has(c),
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/admin/users" element={<>{body}<Where /></>} />
            <Route path="/admin/access-certifications" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAdminUsers).mockResolvedValue({ users, total: users.length, counts: { ACTIVE: 3, INVITED: 1, DISABLED: 8 } });
  vi.mocked(listClients).mockResolvedValue({ clients: [{ id: 'c1', name: 'Coastal Resort' } as never] } as never);
  vi.mocked(listRegions).mockResolvedValue({ regions: [{ id: 'r1', name: 'Panhandle' } as never] } as never);
  vi.mocked(getShiftCoverageGaps).mockResolvedValue({ total: 3, covered: 1, clients: [] } as never);
  vi.mocked(getAccessReport).mockResolvedValue(report);
  vi.mocked(patchAdminUser).mockResolvedValue(undefined);
  vi.mocked(deactivateUsers).mockResolvedValue({ deactivated: [{ id: ANA, email: 'ana@example.com', purgeAfter: '2026-11-12T00:00:00.000Z' }], skipped: [] });
  vi.mocked(reactivateUser).mockResolvedValue({ id: BO, status: 'ACTIVE' });
});

describe('Users & access — a list you read', () => {
  it('opens on active and invited accounts, one line each, with no form in any row', async () => {
    renderPage();
    const row = (await screen.findByText('Pat Chair')).closest('tr')!;
    expect(listAdminUsers).toHaveBeenCalledWith({ q: undefined, role: undefined, status: ['ACTIVE', 'INVITED'] });
    // Role as text with its extra role counted, scope in words, two-step and last active.
    expect(within(row).getByText('HR Administrator')).toBeInTheDocument();
    expect(within(row).getByText('+1')).toBeInTheDocument();
    expect(within(row).getByText('2 places')).toBeInTheDocument();
    expect(within(row).getByText('Off')).toBeInTheDocument();
    expect(within(row).getByText('Never')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    const portal = screen.getByText('store@client.example').closest('tr')!;
    expect(within(portal).getByText('Coastal Resort · Pier Park')).toBeInTheDocument();
    const mine = screen.getByText('me@alto.example').closest('tr')!;
    expect(within(mine).getByText('On')).toBeInTheDocument();
    expect(within(mine).getByText('just now')).toBeInTheDocument();
  });

  it('the status chips count each status and switch the list, in the URL', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Pat Chair');
    // Active and Invited are on by default; the counts are the server's.
    expect(screen.getByRole('button', { name: 'Active 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Invited 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Disabled 8' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'All 12' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disabled 8' }));
    await waitFor(() => expect(listAdminUsers).toHaveBeenLastCalledWith({ q: undefined, role: undefined, status: ['DISABLED'] }));
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/users?status=DISABLED');
    await user.click(screen.getByRole('button', { name: 'All 12' }));
    await waitFor(() => expect(listAdminUsers).toHaveBeenLastCalledWith({ q: undefined, role: undefined, status: undefined }));
  });

  it('a row opens the account in a drawer kept in the URL; changes happen there', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('Pat Chair'));
    const drawer = await screen.findByRole('dialog');
    expect(screen.getByTestId('where')).toHaveTextContent(`user=${HR2}`);
    expect(within(drawer).getByRole('heading', { name: 'Access' })).toBeInTheDocument();
    expect(within(drawer).getByRole('heading', { name: 'Security' })).toBeInTheDocument();
    expect(within(drawer).getByRole('heading', { name: 'Turn off' })).toBeInTheDocument();
    await user.selectOptions(within(drawer).getByLabelText('Role'), 'WORKFORCE_MANAGER');
    await waitFor(() => expect(patchAdminUser).toHaveBeenCalledWith(HR2, { role: 'WORKFORCE_MANAGER' }));
  });

  it('a staff login with no person record says so in the row, and its drawer sets one up', async () => {
    const user = userEvent.setup();
    renderPage();
    // Pat (HR, no person record): the row says it; the portal login never does.
    const pat = (await screen.findByText('Pat Chair')).closest('tr')!;
    expect(within(pat).getByText('No person record')).toBeInTheDocument();
    const store = screen.getByText('store@client.example').closest('tr')!;
    expect(within(store).queryByText('No person record')).not.toBeInTheDocument();
    await user.click(screen.getByText('Pat Chair'));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Set it up' }));
    expect(await screen.findByRole('dialog', { name: 'Set up their person record' })).toBeInTheDocument();
  });

  it('asks for a named approver before a portal account goes on a region', async () => {
    const user = userEvent.setup();
    renderPage(`/admin/users?user=${PORTAL}`);
    const drawer = await screen.findByRole('dialog');
    const regionSelect = within(drawer).getByLabelText('Region') as HTMLSelectElement;
    await user.click(regionSelect);
    await waitFor(() => expect(within(regionSelect).getByRole('option', { name: 'Panhandle' })).toBeInTheDocument());
    await user.selectOptions(regionSelect, 'r1');
    const dialog = await screen.findByRole('dialog', { name: /Put store@client.example on Panhandle/ });
    expect(patchAdminUser).not.toHaveBeenCalled();
    const assign = within(dialog).getByRole('button', { name: 'Assign region' });
    expect(assign).toBeDisabled();
    const approver = within(dialog).getByLabelText(/Approved by/) as HTMLSelectElement;
    await waitFor(() => expect(within(approver).getByRole('option', { name: /Pat Chair/ })).toBeInTheDocument());
    await user.selectOptions(approver, HR2);
    await user.click(assign);
    await waitFor(() => expect(patchAdminUser).toHaveBeenCalledWith(PORTAL, { regionId: 'r1', approvedByUserId: HR2 }));
  });

  it('a reader without manage:org sees the drawer with nothing to press and no Invite', async () => {
    renderPage(`/admin/users?user=${HR2}`, 'EXECUTIVE_CHAIRMAN');
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByLabelText('Role')).toBeDisabled();
    expect(within(drawer).queryByRole('heading', { name: 'Turn off' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite user' })).not.toBeInTheDocument();
  });

  it('points shifts without a lead to Store leads in one line, instead of a card above the accounts', async () => {
    vi.mocked(getShiftCoverageGaps).mockResolvedValue({
      total: 3,
      covered: 1,
      clients: [{ clientId: 'c1', clientName: 'Coastal Resort', uncovered: [{ locationId: 'l1', locationName: 'Pier Park', label: 'Morning', startMinute: 360, endMinute: 840 }, { locationId: 'l1', locationName: 'Pier Park', label: 'Overnight', startMinute: 1320, endMinute: 360 }], noShift: [], supervisors: [] }],
    } as never);
    renderPage();
    const line = await screen.findByTestId('shift-leads-line');
    expect(line).toHaveTextContent('2 shifts have no lead.');
    expect(within(line).getByRole('link')).toHaveAttribute('href', '/scheduling/supervisors');
  });

  it('the old access-report link lands on Access certifications', async () => {
    renderPage('/admin/users?view=report');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/access-certifications?tab=report'));
  });
});

describe('Users & access — Invite user', () => {
  it('invites someone on staff by role, email and client', async () => {
    vi.mocked(inviteUser).mockResolvedValue({ user: { id: 'new1', email: 'pat@example.com', status: 'INVITED', role: 'FINANCE_ACCOUNTANT' }, emailFailed: null, expiresAt: null });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Pat Chair');
    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite user' });
    const send = within(dialog).getByRole('button', { name: 'Send invite' });
    expect(send).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText(/Role/), 'FINANCE_ACCOUNTANT');
    await user.type(within(dialog).getByLabelText(/Email/), 'pat@example.com');
    await user.type(within(dialog).getByLabelText(/Name/), 'Pat Rivera');
    await user.click(send);
    await waitFor(() => expect(inviteUser).toHaveBeenCalledWith({ email: 'pat@example.com', name: 'Pat Rivera', role: 'FINANCE_ACCOUNTANT', clientId: null }));
  });

  it('sends an associate to Onboarding instead', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Pat Chair');
    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite user' });
    await user.selectOptions(within(dialog).getByLabelText(/Role/), 'ASSOCIATE');
    expect(within(dialog).getByRole('link', { name: 'Invite from Onboarding' })).toHaveAttribute('href', '/onboarding?new=invite');
    expect(within(dialog).queryByRole('button', { name: 'Send invite' })).not.toBeInTheDocument();
  });

  it('a supervisor needs a client before the invite can go', async () => {
    vi.mocked(inviteUser).mockResolvedValue({ pending: true, approvalId: 'ap1', title: 'Invite', user: { id: 'h1', email: 's@example.com' } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Pat Chair');
    await user.click(screen.getByRole('button', { name: 'Invite user' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite user' });
    await user.selectOptions(within(dialog).getByLabelText(/Role/), 'SHIFT_SUPERVISOR');
    await user.type(within(dialog).getByLabelText(/Email/), 's@example.com');
    const send = within(dialog).getByRole('button', { name: 'Send invite' });
    expect(send).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText(/Client/), 'c1');
    await user.click(send);
    await waitFor(() => expect(inviteUser).toHaveBeenCalledWith({ email: 's@example.com', name: undefined, role: 'SHIFT_SUPERVISOR', clientId: 'c1' }));
  });
});

describe('Users & access — bulk Disabled goes the reversible way', () => {
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

describe('The access report (on Access certifications)', () => {
  it('shows the counts, flags with their numbers, and the flagged rows first', async () => {
    const user = userEvent.setup();
    renderPage('/admin/users', 'HR_ADMINISTRATOR', <AccessReport />);
    expect(await screen.findByText('Flagged accounts')).toBeInTheDocument();
    expect(screen.getByText('Associates working')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /No sign-in in 90 days 1/ })).toBeInTheDocument();
    expect(screen.getAllByText('Employment ended, account still on').length).toBeGreaterThan(0);
    expect(screen.getByText('store.manager@gmail.com')).toBeInTheDocument();
    expect(screen.getByText(/deletes/)).toBeInTheDocument();

    // A flag narrows the rows, and is kept in the URL.
    await user.click(screen.getByRole('button', { name: /Portal login on a personal email 1/ }));
    await waitFor(() => expect(screen.queryByText('ana@example.com')).not.toBeInTheDocument());
    expect(screen.getByText('store.manager@gmail.com')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('flag=PORTAL_PERSONAL_EMAIL');
  });

  it('deactivates the selected accounts with a reason and reactivates within the grace period', async () => {
    const user = userEvent.setup();
    renderPage('/admin/users', 'HR_ADMINISTRATOR', <AccessReport />);
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

    const boRow = screen.getByText('bo@example.com').closest('tr')!;
    await user.click(within(boRow).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(reactivateUser).toHaveBeenCalledWith(BO));
  });
});
