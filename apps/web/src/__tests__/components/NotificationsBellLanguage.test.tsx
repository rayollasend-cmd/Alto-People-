import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Notification } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { I18nProvider } from '@/lib/i18n';
import { tr } from '@/lib/i18n/tr';
import { TooltipProvider } from '@/components/ui/Tooltip';

vi.mock('@/lib/communicationsApi', () => ({
  listMyInbox: vi.fn(),
  markAllRead: vi.fn(async () => ({ updated: 1 })),
  markAllSeen: vi.fn(async () => ({ updated: 1 })),
  markRead: vi.fn(),
}));

import { listMyInbox } from '@/lib/communicationsApi';
import { NotificationsBell } from '@/components/NotificationsBell';

/**
 * Deep audit 2026-10-29: the bell said "11 new notifications — 11 unseen" in
 * English to a screen reader on every page load (ASSOC-24), and its group
 * titles and category chips stayed English in every language (ASSOC-11).
 */

const note = (i: number, over: Partial<Notification> = {}): Notification =>
  ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    channel: 'IN_APP',
    status: 'SENT',
    subject: `Your shift moved ${i}`,
    body: 'Your Saturday shift starts an hour later.',
    category: 'shift_changed',
    readAt: null,
    seenAt: null,
    linkUrl: '/scheduling',
    createdAt: new Date().toISOString(),
    ...over,
  }) as Notification;

function renderBell() {
  const caps = ROLE_CAPABILITIES.ASSOCIATE;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'maria@example.com', role: 'ASSOCIATE', status: 'ACTIVE', clientId: null, associateId: 'a1' },
          role: 'ASSOCIATE',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <I18nProvider>
          <TooltipProvider delayDuration={0}>
            <MemoryRouter>
              <NotificationsBell />
            </MemoryRouter>
          </TooltipProvider>
        </I18nProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(listMyInbox).mockResolvedValue({ notifications: [note(1), note(2), note(3)], total: 3 } as never);
});

describe('<NotificationsBell> in the reader’s language', () => {
  it('announces nothing for what was already waiting when the page loaded', async () => {
    renderBell();
    await screen.findByRole('button', { name: /Notifications \(3 new for you\)/ });
    await waitFor(() => expect(listMyInbox).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('names a folded group and its chips in Turkish', async () => {
    localStorage.setItem('alto.lang', 'tr');
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(tr['bell.title']!) }));
    const label = tr['bell.cat.scheduling']!;
    expect(await screen.findByText(`${label} (3)`)).toBeInTheDocument();
    expect(screen.queryByText(/schedule changes/i)).not.toBeInTheDocument();
  });
});
