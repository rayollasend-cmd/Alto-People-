import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from '@/lib/auth';
import { CommandPalette } from '@/components/ui/CommandPalette';

vi.mock('@/lib/productEvents', () => ({ noteSearchLanded: vi.fn() }));
vi.mock('@/lib/searchApi', () => ({ universalSearch: vi.fn(async () => ({ groups: [] })) }));
vi.mock('@/lib/usePaletteSearch', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/usePaletteSearch')>();
  return { ...mod, usePeopleSearch: () => ({ results: [], isSearching: false }) };
});
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [], isLoading: false }) }));

import { noteSearchLanded } from '@/lib/productEvents';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
Element.prototype.scrollIntoView = () => undefined;

function renderPalette() {
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u1', email: 'x@y.z', role: 'HR_ADMINISTRATOR', status: 'ACTIVE', clientId: null, associateId: null },
    role: 'HR_ADMINISTRATOR',
    capabilities: new Set(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => true,
  };
  return render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AuthContext.Provider value={auth as any}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <CommandPalette open onOpenChange={() => undefined} onShowKeyboardShortcuts={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

/** ux-upgrade §6: a ⌘K search whose result opens a settings page is reported with the words typed. */
describe('⌘K — a search that ends on a settings page', () => {
  it('reports the query and the path it landed on', async () => {
    renderPalette();
    await userEvent.type(screen.getByPlaceholderText(/Search pages, people/), 'users');
    const row = await screen.findByText('Users & access', {}, { timeout: 2000 });
    await userEvent.click(row);
    expect(noteSearchLanded).toHaveBeenCalledWith('users', '/admin/users');
  });
});
