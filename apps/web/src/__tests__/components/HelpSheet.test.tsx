import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from '@/lib/auth';
import { I18nProvider } from '@/lib/i18n';
import { HelpSheet } from '@/components/HelpSheet';
import { helpFor, HELP } from '@/lib/help';

vi.mock('@/lib/kb124Api', () => ({
  searchKb: vi.fn(async () => ({
    articles: [
      { id: 'a1', slug: 'reading-a-profile', title: 'Reading an associate profile', category: 'People', tags: [], views: 0, helpful: 0, notHelpful: 0, publishedAt: null },
    ],
  })),
}));

function renderSheet(path: string) {
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
        <I18nProvider>
          <MemoryRouter initialEntries={[path]}>
            <HelpSheet open onOpenChange={() => undefined} onShowKeyboardShortcuts={() => undefined} />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('the help sheet', () => {
  it('every entry has both languages, and the same number of actions in each', () => {
    for (const e of HELP) {
      expect(e.en.actions.length, e.key).toBeGreaterThan(0);
      expect(e.es.actions.length, e.key).toBe(e.en.actions.length);
      expect(e.es.intro, e.key).not.toBe(e.en.intro);
    }
    expect(helpFor('/people?x=1', 'en')?.key).toBe('people');
    expect(helpFor('/time-attendance/timesheets', 'en')?.key).toBe('timesheets');
    expect(helpFor('/nowhere', 'en')).toBeNull();
  });

  it('explains the page you are on and reaches the help center', async () => {
    renderSheet('/people');
    expect(screen.getByRole('heading', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByText(/Search by name or email/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Reading an associate profile/ })).toHaveAttribute(
      'href',
      '/help-center?article=reading-a-profile',
    );
    expect(screen.getByRole('link', { name: /Open the help center/ })).toHaveAttribute('href', '/help-center');
  });

  it('falls back to the generic sheet on a page without an entry', () => {
    renderSheet('/nowhere');
    expect(screen.getByRole('heading', { name: 'Help' })).toBeInTheDocument();
    expect(screen.queryByText('You can')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keyboard shortcuts/ })).toBeInTheDocument();
  });
});
