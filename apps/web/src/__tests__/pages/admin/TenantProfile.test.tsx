import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, defaultTenantProfile, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT, type TenantSession } from '@/lib/auth';

vi.mock('@/lib/tenantProfileApi', () => ({ getTenantProfile: vi.fn(), saveTenantProfile: vi.fn() }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));

import { getTenantProfile, saveTenantProfile } from '@/lib/tenantProfileApi';
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
  vi.mocked(getTenantProfile).mockResolvedValue({
    tenantId: 't1',
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
    const transport = await screen.findByRole('checkbox', { name: /^Transportation/ });
    expect(transport).toBeChecked();
    expect(screen.getByDisplayValue('Workforce provider')).toBeInTheDocument();

    await user.click(transport);
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
    await screen.findByRole('checkbox', { name: /^Transportation/ });
    expect(screen.getByText(/The words here reach the navigation, the roles and Coco\./)).toBeInTheDocument();
    expect(screen.getByText(/the screens and Coco use/)).toBeInTheDocument();
    expect(screen.queryByText(/Hugo/)).toBeNull();
    cleanup();

    renderPage({ ...DEFAULT_TENANT, assistantName: 'Max' });
    await screen.findByRole('checkbox', { name: /^Transportation/ });
    expect(screen.getByText(/the roles and Max\./)).toBeInTheDocument();
    expect(screen.queryByText(/Coco/)).toBeNull();
  });

  it('resets to the model\'s defaults after a confirm', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('checkbox', { name: /^Transportation/ });
    await user.click(screen.getByRole('button', { name: "Reset to the model's defaults" }));
    await waitFor(() => expect(saveTenantProfile).toHaveBeenCalledWith({ businessModel: 'WORKFORCE_PROVIDER', resetToDefaults: true }));
  });
});
