import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import type { OpenShiftListItem } from '@/lib/qualApi';

vi.mock('@/lib/qualApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/qualApi')>()),
  listOpenShifts: vi.fn(),
  claimShift: vi.fn(),
}));
vi.mock('@/lib/openShiftInvitesApi', () => ({
  listInviteCounts: vi.fn().mockResolvedValue({ counts: [] }),
  rebroadcastShift: vi.fn(),
  declineOpenShift: vi.fn(),
  undoDeclineOpenShift: vi.fn(),
}));
vi.mock('@/lib/settingsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/settingsApi')>()),
  patchNotificationPreference: vi.fn().mockResolvedValue({}),
}));
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { listOpenShifts } from '@/lib/qualApi';
import { declineOpenShift, undoDeclineOpenShift } from '@/lib/openShiftInvitesApi';
import { MarketplaceHome } from '@/pages/marketplace/MarketplaceHome';
import { patchNotificationPreference } from '@/lib/settingsApi';

/**
 * The associate's side of Rebroadcast (role walk, ops 11): "Not for me" on
 * an open shift records the decline (the manager's tab counts it, nobody
 * asks again), folds the card away, and Undo brings it back. The card reads
 * the shift on its store's clock, not the phone's.
 */

const ZONE = 'Pacific/Honolulu';
const startsAt = new Date(Math.ceil((Date.now() + 30 * 3_600_000) / 3_600_000) * 3_600_000);
const row = (over: Partial<OpenShiftListItem> = {}): OpenShiftListItem => ({
  id: 'sh-1',
  clientId: 'c1',
  clientName: 'Grand Hotel',
  position: 'Housekeeper',
  startsAt: startsAt.toISOString(),
  endsAt: new Date(startsAt.getTime() + 4 * 3_600_000).toISOString(),
  location: null,
  locationId: 'l1',
  locationName: 'Waikiki',
  timezone: ZONE,
  newForYou: false,
  declinedByMe: false,
  payRate: null,
  requirements: [],
  myPendingClaim: null,
  ...over,
});

function renderAsAssociate() {
  const role = 'ASSOCIATE' as const;
  const caps = ROLE_CAPABILITIES[role];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{ isInitializing: false, isOffline: false, user: { id: 'u', email: 'a@x.com', role, status: 'ACTIVE', clientId: null, associateId: 'assoc-1' }, role, capabilities: new Set<Capability>(caps), signIn: vi.fn(), signOut: vi.fn(), can: (c: Capability) => caps.has(c) } as never}
      >
        <MemoryRouter>
          <MarketplaceHome />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Not for me', () => {
  it('shows the shift on its store’s clock and hides the ones already passed on', async () => {
    vi.mocked(listOpenShifts).mockResolvedValue({ shifts: [row(), row({ id: 'sh-2', position: 'Cook', declinedByMe: true })] });
    renderAsAssociate();
    expect(await screen.findByText('Housekeeper')).toBeInTheDocument();
    expect(screen.queryByText('Cook')).not.toBeInTheDocument();
    const hawaii = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' }).format(startsAt);
    expect(screen.getByText(new RegExp(`^${hawaii.replace(/\s/g, '\\s')} –`))).toBeInTheDocument();
  });

  it('records the decline, folds the card away, and Undo brings it back', async () => {
    vi.mocked(listOpenShifts).mockResolvedValue({ shifts: [row(), row({ id: 'sh-2', position: 'Cook' })] });
    vi.mocked(declineOpenShift).mockResolvedValue({ ok: true });
    vi.mocked(undoDeclineOpenShift).mockResolvedValue({ ok: true });
    const user = renderAsAssociate();
    const card = (await screen.findByText('Housekeeper')).closest('[data-card]') as HTMLElement | null;
    const scope = card ? within(card) : screen;
    await user.click(scope.getAllByRole('button', { name: 'Not for me' })[0]!);
    await waitFor(() => expect(declineOpenShift).toHaveBeenCalledWith('sh-1'));
    await waitFor(() => expect(screen.queryByText('Housekeeper')).not.toBeInTheDocument());
    expect(screen.getByText('Cook')).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith('Got it. We won’t ask you about this one again.', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }));
    const undo = toastMock.mock.calls[0]![1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(undoDeclineOpenShift).toHaveBeenCalledWith('sh-1'));
    expect(await screen.findByText('Housekeeper')).toBeInTheDocument();
  });

  it('puts the card back and says so when the decline does not save', async () => {
    vi.mocked(listOpenShifts).mockResolvedValue({ shifts: [row()] });
    vi.mocked(declineOpenShift).mockRejectedValue(new Error('offline'));
    const user = renderAsAssociate();
    await user.click(await screen.findByRole('button', { name: 'Not for me' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not save that. Try again.'));
    expect(screen.getByText('Housekeeper')).toBeInTheDocument();
  });
});

describe('Open shifts for an associate (F500 G2)', () => {
  it('reads to the associate, carries no hand-written "Time & Pay" crumb, and an empty board offers availability and Notify me', async () => {
    vi.mocked(listOpenShifts).mockResolvedValue({ shifts: [] });
    const user = renderAsAssociate();
    expect(await screen.findByText(/Open shifts you're qualified to pick up\. A manager approves each pickup\./)).toBeInTheDocument();
    expect(screen.queryByText('Time & Pay')).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /set my availability/i })).toHaveAttribute('href', '/scheduling?sheet=availability');
    expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /notify me/i }));
    await waitFor(() => expect(patchNotificationPreference).toHaveBeenCalledWith('scheduling', { inAppEnabled: true, emailEnabled: true, pushEnabled: true }));
    expect(await screen.findByText('You’ll be told when a shift opens')).toBeInTheDocument();
  });
});
