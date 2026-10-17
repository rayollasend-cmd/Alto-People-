import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT, type TenantSession } from '@/lib/auth';

/** An HR administrator (view:org + manage:org) on the default tenant, or on the tenant given. */
export function renderAsAdmin(ui: ReactNode, route = '/', tenant: TenantSession = DEFAULT_TENANT) {
  const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
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
            refreshUser: vi.fn(),
            switchRole: vi.fn(),
            can: (c: Capability) => caps.has(c),
          }}
        >
          {ui}
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
