import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from '@/lib/auth';
import { I18nProvider } from '@/lib/i18n';
import { WhatsNew } from '@/components/WhatsNew';

vi.mock('@/lib/releaseNotesApi', () => ({
  getLatestReleaseNote: vi.fn(async () => ({
    note: {
      id: 'note-1',
      day: '2026-10-01',
      publishedAt: '2026-10-01T12:00:00Z',
      items: [
        { audience: 'ALL', en: 'Faster schedule loads.', es: 'El horario carga más rápido.' },
        { audience: 'ALL', en: 'Only in English.', es: null },
      ],
    },
  })),
}));

function renderCard(path = '/') {
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u1', email: 'x@y.z', role: 'ASSOCIATE', status: 'ACTIVE', clientId: null, associateId: null },
    role: 'ASSOCIATE',
    capabilities: new Set(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => false,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AuthContext.Provider value={auth as any}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={[path]}>
            <WhatsNew />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('<WhatsNew> — the release-note card', () => {
  beforeEach(() => window.localStorage.clear());

  it('shows the API note once, in the reader’s language, and stays dismissed', async () => {
    renderCard();
    expect(await screen.findByText('Faster schedule loads.')).toBeInTheDocument();
    expect(screen.getByText('Only in English.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See everything new' })).toHaveAttribute('href', '/whats-new');

    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText('Faster schedule loads.')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('alto.whatsnew.seen.v2')).toBe('note-1');

    renderCard();
    await waitFor(() => expect(screen.queryByText('Faster schedule loads.')).not.toBeInTheDocument());
  });

  it('speaks Spanish when the app does, falling back per bullet', async () => {
    window.localStorage.setItem('alto.lang', 'es');
    renderCard();
    expect(await screen.findByText('El horario carga más rápido.')).toBeInTheDocument();
    expect(screen.getByText('Only in English.')).toBeInTheDocument();
  });

  it('stays off every route but home', async () => {
    renderCard('/scheduling');
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
