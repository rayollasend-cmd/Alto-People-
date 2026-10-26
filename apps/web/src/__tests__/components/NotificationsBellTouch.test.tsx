import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Notification } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { TooltipProvider } from '@/components/ui/Tooltip';

vi.mock('@/lib/communicationsApi', () => ({
  listMyInbox: vi.fn(),
  markAllRead: vi.fn(async () => ({ updated: 1 })),
  markAllSeen: vi.fn(async () => ({ updated: 1 })),
  markRead: vi.fn(),
}));

import { listMyInbox, markAllRead } from '@/lib/communicationsApi';
import { NotificationsBell, groupTitle } from '@/components/NotificationsBell';

/**
 * The bell on a phone (role walk floor 23): one tap opens the panel. The
 * "Notifications" tooltip used to open on that same tap and sit over
 * "Mark all read"; touch now gets no tooltip at all.
 */

const note = (i: number, over: Partial<Notification> = {}): Notification =>
  ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    channel: 'IN_APP',
    status: 'SENT',
    subject: `Overdue at Coastal Resort Holdings ${i}`,
    body: 'A timesheet is waiting.',
    category: 'overdue_timesheet_reminder',
    readAt: null,
    seenAt: null,
    linkUrl: '/time-attendance',
    createdAt: new Date().toISOString(),
    ...over,
  }) as Notification;

function renderBell() {
  const caps = ROLE_CAPABILITIES.SHIFT_SUPERVISOR;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'dana@example.com', role: 'SHIFT_SUPERVISOR', status: 'ACTIVE', clientId: 'c1', associateId: null },
          role: 'SHIFT_SUPERVISOR',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <TooltipProvider delayDuration={0}>
          <MemoryRouter>
            <NotificationsBell />
          </MemoryRouter>
        </TooltipProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(listMyInbox).mockResolvedValue({
    notifications: [note(1), note(2), note(3)],
    total: 3,
  } as never);
});

describe('<NotificationsBell> on touch', () => {
  it('one tap opens the panel; no tooltip covers Mark all read, and it works', async () => {
    renderBell();
    const bell = await screen.findByRole('button', { name: 'Notifications (3 new for you)' });
    await userEvent.click(bell);

    const markAll = await screen.findByRole('button', { name: /Mark all read/ });
    // No tooltip anywhere — the tap was for the panel.
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await userEvent.click(markAll);
    expect(markAllRead).toHaveBeenCalled();
  });

  it('a folded group is named by its kind, not by a fragment of one of them', async () => {
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    expect(await screen.findByText('3 overdue timesheet reminders')).toBeInTheDocument();
    expect(screen.queryByText(/like “/)).not.toBeInTheDocument();
  });
});

describe('groupTitle', () => {
  it('uses the bucket’s name when there is one, else the kind in words', () => {
    expect(groupTitle(12, 'scheduling', 'Schedule changes')).toBe('12 schedule changes');
    expect(groupTitle(10, 'overdue_timesheet_reminder', null)).toBe('10 overdue timesheet reminders');
    expect(groupTitle(4, 'kiosk.device_offline', null)).toBe('4 kiosk device offline notifications');
    expect(groupTitle(3, null, null)).toBe('3 notifications');
  });
});
