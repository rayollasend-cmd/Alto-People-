import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { PageTitleProvider } from '@/lib/pageTitle';

/**
 * The top bar on a page that always covers every client (deep audit
 * LEAD-16): with a client picked, it says "Every client on this page"
 * instead of showing a picker the page would ignore.
 */

vi.mock('@/lib/communicationsApi', () => ({
  listMyInbox: vi.fn(async () => ({ notifications: [], total: 0 })),
  markAllRead: vi.fn(),
  markAllSeen: vi.fn(),
  markRead: vi.fn(),
}));

const followed = vi.hoisted(() => ({ current: false }));
vi.mock('@/lib/storeScope', async (orig) => ({
  ...(await orig<typeof import('@/lib/storeScope')>()),
  useStoreScope: () => ({
    enabled: true,
    ready: true,
    clientId: 'c1',
    setClientId: vi.fn(),
    clients: [
      { id: 'c1', name: 'Coastal Resort Holdings' },
      { id: 'c2', name: 'Seaside Hospitality Group' },
    ],
  }),
  useStoreScopeFollowed: () => followed.current,
}));

import { Topbar } from '@/components/Topbar';

describe('<Topbar> on a page that does not follow the picker', () => {
  it('shows "Every client on this page" in place of the picker when a client is picked, and the picker on a page that follows', async () => {
    const caps = ROLE_CAPABILITIES.EXECUTIVE_CHAIRMAN;
    const ui = (
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'exec@altohr.com', role: 'EXECUTIVE_CHAIRMAN', status: 'ACTIVE', clientId: null, associateId: null },
          role: 'EXECUTIVE_CHAIRMAN',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <PageTitleProvider>
            <TooltipProvider>
              <MemoryRouter initialEntries={['/executive/financials']}>
                <Topbar onOpenCommandPalette={vi.fn()} onOpenHelp={vi.fn()} />
              </MemoryRouter>
            </TooltipProvider>
          </PageTitleProvider>
        </QueryClientProvider>
      </AuthContext.Provider>
    );
    followed.current = false;
    const { unmount } = render(ui);
    expect(screen.getByTestId('store-scope-not-here')).toHaveTextContent('Every client on this page');
    expect(screen.queryByTestId('store-scope-select')).toBeNull();
    unmount();
    followed.current = true;
    render(ui);
    expect(screen.getByTestId('store-scope-select')).toBeInTheDocument();
    expect(screen.queryByTestId('store-scope-not-here')).toBeNull();
  });
});
