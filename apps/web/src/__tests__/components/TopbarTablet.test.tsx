import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { PageTitleProvider } from '@/lib/pageTitle';

/**
 * The top bar at 1024px (role walk ops 5): the four-store segmented
 * switcher took ~510px and pushed Help and the bell past the right edge
 * of a tablet. Below 1280px it is one dropdown; the segments come back at
 * xl; Help and the bell never shrink.
 */

vi.mock('@/lib/storeScope', async (orig) => ({
  ...(await orig<typeof import('@/lib/storeScope')>()),
  useStoreScope: () => ({
    enabled: true,
    ready: true,
    clientId: '',
    setClientId: vi.fn(),
    clients: [
      { id: 'c1', name: 'Walmart Santa Rosa Beach' },
      { id: 'c2', name: 'Walmart Destin' },
      { id: 'c3', name: 'Walmart Fort Walton' },
      { id: 'c4', name: 'Walmart Panama City' },
    ],
  }),
}));
vi.mock('@/lib/communicationsApi', () => ({
  listMyInbox: vi.fn(async () => ({ notifications: [], total: 0 })),
  markAllRead: vi.fn(),
  markAllSeen: vi.fn(),
  markRead: vi.fn(),
}));

import { Topbar } from '@/components/Topbar';

function renderTopbar() {
  const caps = ROLE_CAPABILITIES.OPERATIONS_MANAGER;
  return render(
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
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PageTitleProvider>
          <TooltipProvider>
            <MemoryRouter initialEntries={['/scheduling']}>
              <Topbar onOpenCommandPalette={vi.fn()} onOpenHelp={vi.fn()} />
            </MemoryRouter>
          </TooltipProvider>
        </PageTitleProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('<Topbar> at tablet widths', () => {
  it('between 1024 and 1280 the store switcher is one dropdown; the segments are xl only', () => {
    renderTopbar();
    const dropdown = screen.getByTestId('store-scope-select');
    expect(dropdown.className).toContain('lg:block');
    expect(dropdown.className).toContain('xl:hidden');
    expect(screen.getByRole('combobox', { name: 'Store scope' })).toBeInTheDocument();
    const segments = screen.getByTestId('store-scope-segments');
    expect(segments.className).toContain('hidden');
    expect(segments.className).toContain('xl:inline-flex');
    expect(segments.className).not.toMatch(/(^|\s)lg:inline-flex/);
  });

  it('Help and the bell never shrink off the edge', async () => {
    renderTopbar();
    expect(screen.getByRole('button', { name: 'Help for this page' }).className).toContain('shrink-0');
    const bell = await screen.findByRole('button', { name: 'Notifications' });
    expect(bell.closest('[data-tour="bell"]')?.className).toContain('shrink-0');
  });
});
