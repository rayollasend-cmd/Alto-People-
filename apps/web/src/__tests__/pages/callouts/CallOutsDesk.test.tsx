import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

/**
 * Call-outs: a shift still looking for cover offers its best-ranked free
 * person in one click, and the shift itself one click away; a
 * notification's ?callout=<id> rings the call-out it is about.
 */

vi.mock('@/lib/callOutsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callOutsApi')>()),
  listCallOuts: vi.fn(),
  recordCallOutFor: vi.fn(),
}));
vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  getAutoFillBatch: vi.fn(),
  assignShift: vi.fn(),
  listShifts: vi.fn(async () => ({ shifts: [], truncated: false })),
}));

import { listCallOuts, type CallOutItem } from '@/lib/callOutsApi';
import { assignShift, getAutoFillBatch } from '@/lib/schedulingApi';
import { CallOutsDesk } from '@/pages/callouts/CallOutsDesk';

const SHIFT = '11111111-1111-4111-8111-111111111111';
const item = (over: Partial<CallOutItem> = {}): CallOutItem => ({
  id: 'co-1',
  associateId: 'a-out',
  name: 'Ana Reyes',
  photoUrl: null,
  channel: 'SMS',
  reason: 'SICK',
  note: null,
  late: false,
  excused: false,
  excusedWhy: null,
  minutesBeforeStart: 300,
  hasRecording: false,
  calledOutAt: new Date().toISOString(),
  shift: { id: SHIFT, position: 'Cashier', startsAt: new Date(Date.now() + 5 * 3_600_000).toISOString(), endsAt: new Date(Date.now() + 13 * 3_600_000).toISOString(), place: 'Store 12', timezone: null },
  cover: { state: 'looking', by: null, steps: [] },
  ...over,
});
const list = (items: CallOutItem[]) => ({ range: 'today' as const, total: items.length, covered: 0, looking: items.length, uncovered: 0, late: 0, truncated: false, items });

function renderDesk(path = '/call-outs') {
  const role = 'HR_ADMINISTRATOR' as const;
  const caps = ROLE_CAPABILITIES[role];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <AuthContext.Provider
        value={{ isInitializing: false, isOffline: false, user: { id: 'u', email: 'hr@x.com', role, status: 'ACTIVE', clientId: null, associateId: null }, role, capabilities: new Set<Capability>(caps), signIn: vi.fn(), signOut: vi.fn(), can: (c: Capability) => caps.has(c) } as never}
      >
        <MemoryRouter initialEntries={[path]}>
          <CallOutsDesk />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAutoFillBatch).mockResolvedValue({
    byShift: {
      [SHIFT]: [
        // The person who called out never comes back as the cover.
        { associateId: 'a-out', associateName: 'Ana Reyes', weeklyMinutesScheduled: 0, weeklyMinutesActual: 0, matchesAvailability: true, noConflict: true, onApprovedTimeOff: false, score: 1 },
        { associateId: 'a-busy', associateName: 'Omar Busy', weeklyMinutesScheduled: 600, weeklyMinutesActual: 0, matchesAvailability: true, noConflict: false, onApprovedTimeOff: false, score: 0.8 },
        // Free and no clash, but would cross 40 hours — not a one-tap pick.
        { associateId: 'a-tired', associateName: 'Ola Overtime', weeklyMinutesScheduled: 2280, weeklyMinutesActual: 0, matchesAvailability: true, noConflict: true, onApprovedTimeOff: false, score: 0.8 },
        { associateId: 'a-free', associateName: 'Tess Free', weeklyMinutesScheduled: 1200, weeklyMinutesActual: 0, matchesAvailability: true, noConflict: true, onApprovedTimeOff: false, score: 1 },
      ],
    },
  });
});

describe('<CallOutsDesk>', () => {
  it('assigns the top free pick in one click and links the shift', async () => {
    vi.mocked(listCallOuts).mockResolvedValue(list([item()]));
    vi.mocked(assignShift).mockResolvedValue({} as never);
    const user = renderDesk();
    const assign = await screen.findByRole('button', { name: /assign tess free/i });
    expect(screen.getByRole('link', { name: /open shift/i })).toHaveAttribute('href', `/scheduling?shift=${SHIFT}`);
    // One request ranks every row.
    expect(getAutoFillBatch).toHaveBeenCalledTimes(1);
    await user.click(assign);
    // Only if it's still unassigned — a lead who filled it meanwhile wins.
    await waitFor(() => expect(assignShift).toHaveBeenCalledWith(SHIFT, { associateId: 'a-free', expectUnassigned: true }));
  });

  it('offers no one-tap pick when nobody at the store is free for all of it', async () => {
    vi.mocked(listCallOuts).mockResolvedValue(list([item()]));
    vi.mocked(getAutoFillBatch).mockResolvedValue({
      byShift: {
        [SHIFT]: [{ associateId: 'a-maybe', associateName: 'May Be', weeklyMinutesScheduled: 0, weeklyMinutesActual: 0, matchesAvailability: false, noConflict: true, onApprovedTimeOff: false, score: 0.5 }],
      },
    });
    renderDesk();
    expect(await screen.findByText(/nobody at this store is free for all of it/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^assign /i })).not.toBeInTheDocument();
  });

  it('a covered call-out offers no assign, only the shift', async () => {
    vi.mocked(listCallOuts).mockResolvedValue(list([item({ cover: { state: 'covered', by: 'Ben', steps: [] } })]));
    renderDesk();
    expect(await screen.findByRole('link', { name: /open shift/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^assign /i })).not.toBeInTheDocument();
    expect(getAutoFillBatch).not.toHaveBeenCalled();
  });

  it('?callout=<id> rings that call-out, widening to the week when it is later', async () => {
    vi.mocked(listCallOuts).mockImplementation(async (range) => (range === 'today' ? list([]) : list([item({ id: 'co-9' })])));
    renderDesk('/call-outs?callout=co-9');
    await waitFor(() => expect(listCallOuts).toHaveBeenCalledWith('week', null));
    await waitFor(() => expect(document.getElementById('callout-co-9')?.className).toMatch(/ring-gold/));
  });

  // F500 G4: a quiet day says what the week held instead of four zero tiles.
  it('a quiet range is one line with the last seven days\' record, not a row of zeros', async () => {
    vi.mocked(listCallOuts).mockResolvedValue({ ...list([]), last7Days: { total: 3, covered: 3, coveredPct: 100, medianMinutesToCover: 42 } });
    renderDesk();
    expect(await screen.findByText('No call-outs today or tomorrow · last 7 days: 3 call-outs, 100% covered, median 42 min to cover.')).toBeInTheDocument();
    expect(screen.queryByText('Looking for cover')).not.toBeInTheDocument();
  });

  it('the range and site live in the URL; 30 days adds the time to cover and names the repeat callers', async () => {
    vi.mocked(listCallOuts).mockResolvedValue({
      ...list([item({ cover: { state: 'covered', by: 'Ben', steps: [] } })]),
      range: '30d',
      covered: 1,
      looking: 0,
      sites: [{ id: 's1', name: 'Back Bay' }, { id: 's2', name: 'Front Beach' }],
      medianMinutesToCover: 95,
      repeatCallers: [{ associateId: 'a-out', name: 'Ana Reyes', count: 3 }],
    });
    const user = renderDesk('/call-outs?range=30d');
    await waitFor(() => expect(listCallOuts).toHaveBeenCalledWith('30d', null));
    expect(await screen.findByText('1 h 35 min')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ana Reyes' })).toHaveAttribute('href', '/people/a-out');
    expect(screen.getByText('3 call-outs')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Site' }), 's1');
    await waitFor(() => expect(listCallOuts).toHaveBeenCalledWith('30d', 's1'));
  });
});
