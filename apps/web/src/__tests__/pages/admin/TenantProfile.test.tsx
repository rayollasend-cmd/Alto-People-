import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, defaultTenantProfile, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT, type TenantSession } from '@/lib/auth';

vi.mock('@/lib/tenantProfileApi', () => ({ getTenantProfile: vi.fn(), saveTenantProfile: vi.fn() }));
vi.mock('@/lib/brandingApi', () => ({ getOrgBranding: vi.fn(), patchOrgBranding: vi.fn() }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));

import { getTenantProfile, saveTenantProfile } from '@/lib/tenantProfileApi';
import { getOrgBranding, patchOrgBranding } from '@/lib/brandingApi';
import { TenantProfileHome } from '@/pages/admin/TenantProfileHome';

const profile = defaultTenantProfile('WORKFORCE_PROVIDER');
const refreshUser = vi.fn().mockResolvedValue(undefined);

function renderPage(tenant: TenantSession = DEFAULT_TENANT) {
  const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: { id: 'u1', email: 'hr@example.com', role: 'HR_ADMINISTRATOR' } as never,
            role: 'HR_ADMINISTRATOR',
            primaryRole: 'HR_ADMINISTRATOR',
            availableRoles: ['HR_ADMINISTRATOR'],
            capabilities: caps,
            tenant,
            signIn: vi.fn(),
            submitMfaChallenge: vi.fn(),
            signOut: vi.fn(),
            refreshUser,
            switchRole: vi.fn(),
            can: (c: Capability) => caps.has(c),
          }}
        >
          <TenantProfileHome />
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getOrgBranding).mockResolvedValue({ weekStartsOn: 6, timezone: 'America/New_York' } as never);
  vi.mocked(patchOrgBranding).mockImplementation(async (body) => ({ weekStartsOn: 6, timezone: 'America/New_York', ...body }) as never);
  vi.mocked(getTenantProfile).mockResolvedValue({
    tenantId: 't1',
    facts: { name: 'Coastal Resort Holdings', plan: 'growth', createdAt: '2025-03-01T12:00:00.000Z', onTheBooks: 212, sites: 9 },
    profile,
    defaults: { modules: profile.modules, terminology: profile.terminology },
    catalog: { businessModels: ['DIRECT_EMPLOYER', 'WORKFORCE_PROVIDER', 'MANAGED_PROGRAM', 'HYBRID'], modules: [], termKeys: [] },
  });
  vi.mocked(saveTenantProfile).mockResolvedValue({ tenantId: 't1', profile: { ...profile, modules: { ...profile.modules, transportation: false } } });
  refreshUser.mockClear();
});

describe('Organization profile', () => {
  it('loads the profile, toggles a module, edits a term and sends only what changed', async () => {
    const user = userEvent.setup();
    renderPage();
    const transport = await screen.findByRole('switch', { name: 'Transportation' });
    expect(transport).toBeChecked();
    expect(screen.getByDisplayValue('Workforce provider')).toBeInTheDocument();

    await user.click(transport);
    // The pending switch says what it does to the menu before Save.
    expect(screen.getByText(/When you save:/)).toBeInTheDocument();
    // The words are on their own tab; the draft carries across tabs to one Save.
    await user.click(screen.getByRole('tab', { name: 'Terminology' }));
    const workerEn = screen.getByLabelText('Worker (one) in English');
    await user.clear(workerEn);
    await user.type(workerEn, 'Team member');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveTenantProfile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveTenantProfile).mock.calls[0]![0]).toEqual({
      modules: { transportation: false },
      terminology: { worker: { en: 'Team member' } },
    });
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });

  it('names the assistant by what this tenant calls it: two tenants, two names, never a fixed one', async () => {
    renderPage({ ...DEFAULT_TENANT, assistantName: 'Coco' });
    await screen.findByRole('switch', { name: 'Transportation' });
    expect(screen.getByText(/The words here reach the navigation, the roles and Coco\./)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Terminology' }));
    expect(screen.getByText(/the screens and Coco use/)).toBeInTheDocument();
    expect(screen.queryByText(/Hugo/)).toBeNull();
    cleanup();

    renderPage({ ...DEFAULT_TENANT, assistantName: 'Max' });
    await screen.findByRole('switch', { name: 'Transportation' });
    expect(screen.getByText(/the roles and Max\./)).toBeInTheDocument();
    expect(screen.queryByText(/Coco/)).toBeNull();
  });

  it('resets to the model\'s defaults after a confirm', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('switch', { name: 'Transportation' });
    await user.click(screen.getByRole('button', { name: "Reset to the model's defaults" }));
    await waitFor(() => expect(saveTenantProfile).toHaveBeenCalledWith({ businessModel: 'WORKFORCE_PROVIDER', resetToDefaults: true }));
  });

  it('the header says what this organization is, each number linked to its list', async () => {
    renderPage();
    await screen.findByRole('switch', { name: 'Transportation' });
    const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling!;
    expect(fact('Name')).toHaveTextContent('Coastal Resort Holdings');
    expect(fact('Plan')).toHaveTextContent('Growth');
    expect(fact('People on the books')).toHaveTextContent('212');
    expect(fact('People on the books').querySelector('a')).toHaveAttribute('href', '/people');
    // No row of link chips that repeats the Settings rail.
    expect(screen.queryByRole('navigation', { name: 'Organization' })).toBeNull();
  });

  it('the workweek and time zone moved here from Branding, and save from the same bar', async () => {
    vi.mocked(saveTenantProfile).mockClear();
    const user = userEvent.setup();
    renderPage();
    const week = (await screen.findByLabelText('Workweek starts on')) as HTMLSelectElement;
    await waitFor(() => expect(week.value).toBe('6'));
    await user.selectOptions(week, '1');
    const bar = screen.getByTestId('settings-save-bar');
    expect(bar).toHaveTextContent('1 unsaved change.');
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchOrgBranding).toHaveBeenCalledWith({ weekStartsOn: 1, timezone: 'America/New_York' }));
    // Only the calendar changed: the profile is not re-sent.
    expect(saveTenantProfile).not.toHaveBeenCalled();
  });
});

describe('Organization › Modules reads cleanly (F500 2026-10-26)', () => {
  it('short titles in the menu’s words, each page named once, and no "answer not found"', async () => {
    renderPage();
    const time = await screen.findByRole('switch', { name: 'Time & attendance' });
    const card = time.closest('li')!;
    const menu = within(card).getByText(/^Menu:/).textContent ?? '';
    expect(menu.match(/Time & attendance/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(screen.getByRole('switch', { name: 'Talent programs' })).toBeInTheDocument();
    expect(screen.queryByText(/\(skills, career/)).toBeNull();
    expect(screen.queryByText(/answer not found/)).toBeNull();
  });
});
