import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Shift } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  listShifts: vi.fn(),
}));
vi.mock('@/lib/qualApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/qualApi')>()),
  listPendingClaims: vi.fn().mockResolvedValue({ claims: [] }),
  listQualifications: vi.fn().mockResolvedValue({ qualifications: [] }),
}));
vi.mock('@/lib/callOutsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callOutsApi')>()),
  listCallOuts: vi.fn().mockResolvedValue({ range: 'week', total: 0, covered: 0, looking: 0, uncovered: 0, late: 0, truncated: false, items: [] }),
}));
vi.mock('@/lib/openShiftInvitesApi', () => ({
  listInviteCounts: vi.fn().mockResolvedValue({ counts: [] }),
  rebroadcastShift: vi.fn(),
  declineOpenShift: vi.fn(),
  undoDeclineOpenShift: vi.fn(),
}));
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { listShifts } from '@/lib/schedulingApi';
import { listPendingClaims } from '@/lib/qualApi';
import { listInviteCounts, rebroadcastShift, type RebroadcastResult } from '@/lib/openShiftInvitesApi';
import { MarketplaceHome } from '@/pages/marketplace/MarketplaceHome';
import { openShiftsForManager, rebroadcastMessage, startsInParts } from '@/pages/marketplace/ManagerOpenShifts';

/**
 * Role walk, ops 11: "Open shifts" in the sidebar landed managers on
 * Pending claims with no shifts. The manager tab lists the real open
 * shifts — the shared isOpenShift rule, so an open shift that already
 * ended is not offered.
 */

const H = 3_600_000;
const shift = (over: Partial<Shift> = {}): Shift =>
  ({
    id: 'open-1',
    clientId: 'c1',
    clientName: 'Grand Hotel',
    position: 'Housekeeper',
    startsAt: new Date(Date.now() + 5 * H).toISOString(),
    endsAt: new Date(Date.now() + 13 * H).toISOString(),
    location: null,
    locationId: 'l1',
    locationName: 'Front Beach',
    timezone: 'America/New_York',
    hourlyRate: null,
    payRate: null,
    effectivePayRate: null,
    status: 'OPEN',
    notes: null,
    assignedAssociateId: null,
    assignedAssociateName: null,
    assignedAt: null,
    cancellationReason: null,
    scheduledMinutes: 480,
    publishedAt: new Date().toISOString(),
    lateNoticeReason: null,
    acknowledgedAt: null,
    ...over,
  }) as Shift;

function renderHome() {
  const role = 'HR_ADMINISTRATOR' as const;
  const caps = ROLE_CAPABILITIES[role];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{ isInitializing: false, isOffline: false, user: { id: 'u', email: 'hr@x.com', role, status: 'ACTIVE', clientId: null, associateId: null }, role, capabilities: new Set<Capability>(caps), signIn: vi.fn(), signOut: vi.fn(), can: (c: Capability) => caps.has(c) } as never}
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
  vi.mocked(listPendingClaims).mockResolvedValue({ claims: [] });
  vi.mocked(listInviteCounts).mockResolvedValue({ counts: [] });
});

const result = (over: Partial<RebroadcastResult> = {}): RebroadcastResult => ({
  shiftId: 'open-1',
  sent: 0,
  held: 0,
  skipped: { declined: 0, timeOff: 0, unavailable: 0, unqualified: 0, recent: 0 },
  benchSize: 0,
  counts: { shiftId: 'open-1', sent: 0, declined: 0, lastSentAt: null },
  ...over,
});

describe('manager open shifts', () => {
  it('keeps only published, unfilled shifts that have not ended, soonest first', () => {
    const past = shift({ id: 'past', startsAt: new Date(Date.now() - 10 * H).toISOString(), endsAt: new Date(Date.now() - 2 * H).toISOString() });
    const later = shift({ id: 'later', startsAt: new Date(Date.now() + 30 * H).toISOString(), endsAt: new Date(Date.now() + 38 * H).toISOString() });
    const draft = shift({ id: 'draft', status: 'DRAFT', publishedAt: null });
    expect(openShiftsForManager([later, past, draft, shift()]).map((s) => s.id)).toEqual(['open-1', 'later']);
  });

  it('says how soon the hole opens', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(startsInParts('2026-10-22T15:30:00Z', now)).toEqual({ kind: 'hours', h: 3, m: 30 });
    expect(startsInParts('2026-10-25T12:00:00Z', now)).toEqual({ kind: 'days', d: 3 });
    expect(startsInParts('2026-10-22T11:00:00Z', now)).toEqual({ kind: 'started' });
  });

  it('words the Rebroadcast answer: who got it, whose phone waits for morning, or why nobody was asked', () => {
    const t = ((key: string, vars?: Record<string, string | number>) => `${key}${vars?.n !== undefined ? `:${vars.n}` : ''}`) as never;
    expect(rebroadcastMessage(result({ sent: 3 }), t)).toEqual({ tone: 'success', text: 'mk.mgr.rebroadcastSent:3' });
    expect(rebroadcastMessage(result({ sent: 3, held: 1 }), t)).toEqual({ tone: 'success', text: 'mk.mgr.rebroadcastSent:3 mk.mgr.rebroadcastHeld:1' });
    expect(rebroadcastMessage(result({ skipped: { declined: 0, timeOff: 0, unavailable: 0, unqualified: 0, recent: 4 } }), t).text).toBe('mk.mgr.rebroadcastRecent');
    expect(rebroadcastMessage(result({ skipped: { declined: 2, timeOff: 1, unavailable: 0, unqualified: 0, recent: 0 } }), t).text).toBe('mk.mgr.rebroadcastNone');
  });

  it('opens on the manager tab with the real open shifts, who was asked and who passed, an Assign link and Rebroadcast', async () => {
    vi.mocked(listShifts).mockResolvedValue({
      shifts: [shift(), shift({ id: 'past', startsAt: new Date(Date.now() - 10 * H).toISOString(), endsAt: new Date(Date.now() - 2 * H).toISOString() })],
      truncated: false,
    });
    vi.mocked(listPendingClaims).mockResolvedValue({
      claims: [{ id: 'cl1', shiftId: 'open-1', associateId: 'a', associateName: 'Ana', position: 'Housekeeper', clientName: 'Grand Hotel', startsAt: '', endsAt: '', createdAt: '' }],
    });
    vi.mocked(listInviteCounts).mockResolvedValue({ counts: [{ shiftId: 'open-1', sent: 6, declined: 2, lastSentAt: new Date().toISOString() }] });
    vi.mocked(rebroadcastShift).mockResolvedValue(result({ sent: 4, held: 1 }));
    const user = renderHome();
    expect(await screen.findByText('1 open in the next 14 days')).toBeInTheDocument();
    expect(listShifts).toHaveBeenCalledWith(expect.objectContaining({ status: 'OPEN' }));
    expect(listInviteCounts).toHaveBeenCalledWith(14);
    expect(screen.getByText('1 pending claims')).toBeInTheDocument();
    expect(await screen.findByText('6 asked')).toBeInTheDocument();
    expect(screen.getByText('2 passed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Assign/ })).toHaveAttribute('href', '/scheduling?view=list&open=1&shift=open-1');
    await user.click(screen.getByRole('button', { name: /Rebroadcast/ }));
    await waitFor(() => expect(rebroadcastShift).toHaveBeenCalledWith('open-1'));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(expect.stringMatching(/^Sent to 4 on the bench\. 1 are in quiet hours/)));
    // The counts are read again after a send.
    await waitFor(() => expect(vi.mocked(listInviteCounts).mock.calls.length).toBeGreaterThan(1));
  });

  it('says why nobody was asked, and says so when the send fails', async () => {
    vi.mocked(listShifts).mockResolvedValue({ shifts: [shift()], truncated: false });
    vi.mocked(rebroadcastShift).mockResolvedValueOnce(result({ skipped: { declined: 0, timeOff: 0, unavailable: 0, unqualified: 0, recent: 3 } }));
    const user = renderHome();
    await user.click(await screen.findByRole('button', { name: /Rebroadcast/ }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Everyone who can take it was asked in the last half hour.'));
    vi.mocked(rebroadcastShift).mockRejectedValueOnce(new Error('boom'));
    await user.click(screen.getByRole('button', { name: /Rebroadcast/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not rebroadcast this shift.'));
  });

  it('says so plainly when every published shift has someone', async () => {
    vi.mocked(listShifts).mockResolvedValue({ shifts: [], truncated: false });
    renderHome();
    expect(await screen.findByText('Every published shift has someone')).toBeInTheDocument();
  });
});
