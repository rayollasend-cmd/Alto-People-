import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from '@/lib/auth';
import { CommandPalette } from '@/components/ui/CommandPalette';

vi.mock('@/lib/searchApi', () => ({
  universalSearch: vi.fn(async () => ({
    groups: [
      { kind: 'people', hits: [{ id: 'p1', title: 'Dee Destinova', hint: 'dee@example.com', href: '/people?associateId=p1' }] },
      { kind: 'shifts', hits: [{ id: 's1', title: 'Destin Overnight — Destin Grocery', hint: '2026-09-24 · open', href: '/scheduling?view=week&week=2026-09-24&client=c1' }] },
      { kind: 'documents', hits: [{ id: 'd1', title: 'destin-license.png', hint: 'Dee Destinova · id · uploaded', href: '/people?associateId=p1&tab=documents' }] },
    ],
  })),
}));
vi.mock('@/lib/usePaletteSearch', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/usePaletteSearch')>();
  return { ...mod, usePeopleSearch: () => ({ results: [], isSearching: false }) };
});
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [], isLoading: false }) }));

// cmdk measures its list with ResizeObserver, which jsdom lacks.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AuthContext.Provider value={auth as any}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CommandPalette open onOpenChange={() => undefined} onShowKeyboardShortcuts={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('⌘K — universal search groups', () => {
  it('lists shifts and documents from one query, and skips the people group it already has', async () => {
    renderPalette();
    await userEvent.type(screen.getByPlaceholderText(/Search pages, people, clients, shifts/), 'dest');
    expect(await screen.findByText('Destin Overnight — Destin Grocery', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('destin-license.png')).toBeInTheDocument();
    expect(screen.getByText('Shifts')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
    // People come from the palette's own directory search, not this group.
    expect(screen.queryByText('Dee Destinova')).not.toBeInTheDocument();
  });
});
