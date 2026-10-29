import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { StoreScopeProvider, useStoreScope, useStoreScopeFollowed } from '@/lib/storeScope';

/**
 * The client picker applies only where a page follows it (deep audit
 * LEAD-16): it showed on the executive pages, Analytics, Clients, Reports
 * and the ops home, which ignore it. A page follows the scope by reading
 * it; the shell's own picker reads it with { shell: true } and never counts.
 */

function Providers({ children }: { children: React.ReactNode }) {
  const caps = ROLE_CAPABILITIES.OPERATIONS_MANAGER;
  return (
    <AuthContext.Provider
      value={{
        isInitializing: false,
        isOffline: false,
        user: { id: 'u', email: 'ops@altohr.com', role: 'OPERATIONS_MANAGER', status: 'ACTIVE', clientId: null, associateId: null },
        role: 'OPERATIONS_MANAGER',
        capabilities: new Set<Capability>(caps),
        signIn: vi.fn(),
        signOut: vi.fn(),
        can: (c: Capability) => caps.has(c),
      }}
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>
        <StoreScopeProvider>{children}</StoreScopeProvider>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
}

function Follower() {
  useStoreScope();
  return <div>a page that follows the scope</div>;
}
function Shell() {
  useStoreScope({ shell: true });
  return <div data-testid="followed">{String(useStoreScopeFollowed())}</div>;
}

describe('store scope followers', () => {
  it('is followed only while a page that reads the scope is on screen — the shell never counts itself', () => {
    let show: (v: boolean) => void = () => {};
    function Page() {
      const [on, setOn] = useState(false);
      show = setOn;
      return on ? <Follower /> : <div>a company-wide page</div>;
    }
    render(
      <Providers>
        <Shell />
        <Page />
      </Providers>,
    );
    expect(screen.getByTestId('followed')).toHaveTextContent('false');
    act(() => show(true));
    expect(screen.getByTestId('followed')).toHaveTextContent('true');
    act(() => show(false));
    expect(screen.getByTestId('followed')).toHaveTextContent('false');
  });

  it('outside a provider nothing is tracked, so the picker shows as before', () => {
    function Probe() {
      return <div data-testid="followed">{String(useStoreScopeFollowed())}</div>;
    }
    render(<Probe />);
    expect(screen.getByTestId('followed')).toHaveTextContent('true');
  });
});

