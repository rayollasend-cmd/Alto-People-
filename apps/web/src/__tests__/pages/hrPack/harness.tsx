import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

/** A signed-in person of `role` on the default tenant, at `route`. */
export function renderAs(role: Role, ui: ReactNode, route = '/', extra: { associateId?: string | null } = {}) {
  const caps = ROLE_CAPABILITIES[role];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: { id: 'u1', email: 'me@example.com', role, status: 'ACTIVE', clientId: null, associateId: extra.associateId ?? null } as never,
            role,
            primaryRole: role,
            availableRoles: [role],
            capabilities: caps,
            tenant: DEFAULT_TENANT,
            signIn: vi.fn(),
            submitMfaChallenge: vi.fn(),
            signOut: vi.fn(),
            refreshUser: vi.fn(),
            switchRole: vi.fn(),
            can: (c: Capability) => caps.has(c),
          }}
        >
          <ConfirmProvider>{ui}</ConfirmProvider>
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
