import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/schedulingApi', () => ({
  listMyShifts: vi.fn(),
  getMyShiftDetail: vi.fn(),
  listSwapCandidates: vi.fn(),
  createSwap: vi.fn(),
  getMyCalendarUrl: vi.fn(),
  rotateMyCalendarUrl: vi.fn(),
  listSwapsIncoming: vi.fn().mockResolvedValue({ requests: [] }),
  listSwapsOutgoing: vi.fn().mockResolvedValue({ requests: [] }),
  getMyAvailability: vi.fn().mockResolvedValue({ windows: [] }),
  replaceMyAvailability: vi.fn(),
  listMyShiftHistory: vi.fn().mockResolvedValue({ shifts: [], nextBefore: null }),
  acknowledgeMyShift: vi.fn(),
  listMyOpenShifts: vi.fn().mockResolvedValue({ shifts: [] }),
  claimOpenShift: vi.fn(),
  withdrawOpenShiftClaim: vi.fn(),
  listTradeOptions: vi.fn().mockResolvedValue({ options: [] }),
  listMyAvailabilityExceptions: vi.fn().mockResolvedValue({ exceptions: [] }),
  addAvailabilityException: vi.fn(),
  deleteAvailabilityException: vi.fn(),
}));
vi.mock('@/lib/settingsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/settingsApi')>()),
  patchNotificationPreference: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/lib/timeOffApi', () => ({
  listMyRequests: vi.fn().mockResolvedValue({ requests: [] }),
}));
vi.mock('@/lib/timeApi', () => ({
  getActiveTimeEntry: vi.fn().mockResolvedValue({ active: null }),
}));

import {
  getMyCalendarUrl,
  getMyShiftDetail,
  listMyOpenShifts,
  listMyShifts,
  listSwapCandidates,
} from '@/lib/schedulingApi';
import { AssociateScheduleView } from '@/pages/scheduling/AssociateScheduleView';
import { patchNotificationPreference } from '@/lib/settingsApi';
import { ConfirmProvider } from '@/lib/confirm';

const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const shift = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  clientId: 'c1',
  clientName: 'Publix 1424',
  position: 'F&D Morning Shift',
  startsAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + 32 * 3_600_000).toISOString(),
  location: 'Front end',
  hourlyRate: null,
  payRate: null,
  status: 'ASSIGNED',
  notes: 'Bring your food-safety card.',
  locationId: 'l1',
  locationName: 'Store 1424',
  timezone: browserTz,
  assignedAssociateId: 'a',
  assignedAssociateName: 'Maria Lopez',
  assignedAt: null,
  cancellationReason: null,
  scheduledMinutes: 480,
  publishedAt: new Date().toISOString(),
  lateNoticeReason: null,
  acknowledgedAt: null,
  ...over,
});

beforeEach(() => {
  // The view toggle persists to localStorage; clear so every test starts
  // in the default list view.
  localStorage.clear();
  vi.mocked(listMyShifts).mockResolvedValue({ shifts: [shift()] as never });
  vi.mocked(getMyCalendarUrl).mockResolvedValue({
    url: 'https://x.test/api/calendar/v1/a/tok.ics',
    webcalUrl: 'webcal://x.test/api/calendar/v1/a/tok.ics',
  });
  vi.mocked(getMyShiftDetail).mockResolvedValue({
    shift: shift() as never,
    teammates: [
      {
        associateId: 'b',
        name: 'Pat Nguyen',
        position: 'Cashier',
        startsAt: new Date(Date.now() + 25 * 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 33 * 3_600_000).toISOString(),
        location: null,
      },
    ],
  });
  vi.mocked(listSwapCandidates).mockResolvedValue({
    candidates: [
      { associateId: 'b', name: 'Pat Nguyen', busy: false },
      { associateId: 'c', name: 'Bob Busy', busy: true },
    ],
  });
});

let lastSearch = '';
function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}

function renderView(path = '/scheduling') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <AssociateScheduleView />
          <LocationProbe />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

/**
 * F500 G2 — My schedule leads with the next shift. With none coming up,
 * the hero's place says so and offers the two ways to get one; the set-up
 * jobs (availability with its one-time days off, adding the shifts to a
 * calendar) are sheets from the header, not cards under the schedule.
 */
describe('<AssociateScheduleView> — no next shift', () => {
  const past = () =>
    shift({
      id: 'gone',
      startsAt: new Date(Date.now() - 30 * 3_600_000).toISOString(),
      endsAt: new Date(Date.now() - 22 * 3_600_000).toISOString(),
    });

  it('says nothing is coming up and offers to pick up one of the open shifts', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [past()] as never });
    vi.mocked(listMyOpenShifts).mockResolvedValue({
      shifts: [
        { ...(shift({ id: 'os1', status: 'OPEN', assignedAssociateId: null, assignedAssociateName: null }) as object), myClaimStatus: null, myClaimId: null },
        { ...(shift({ id: 'os2', status: 'OPEN', assignedAssociateId: null, assignedAssociateName: null }) as object), myClaimStatus: null, myClaimId: null },
      ] as never,
    });
    renderView();
    const hero = await screen.findByTestId('no-next-shift');
    expect(hero).toHaveTextContent('No shifts coming up');
    await waitFor(() => expect(hero).toHaveTextContent('2 open shifts you could pick up.'));
    expect(within(hero).getByRole('button', { name: /pick up an open shift/i })).toBeInTheDocument();
    expect(within(hero).getByRole('button', { name: /notify me/i })).toBeInTheDocument();
  });

  it('with nothing open, offers "Notify me" once (not a second card below)', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] as never });
    vi.mocked(listMyOpenShifts).mockResolvedValue({ shifts: [] as never });
    const user = userEvent.setup();
    renderView();
    const hero = await screen.findByTestId('no-next-shift');
    await waitFor(() => expect(hero).toHaveTextContent("When you're scheduled, your next shift shows here."));
    expect(screen.queryByTestId('no-open-shifts')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /notify me/i })).toHaveLength(1);
    await user.click(within(hero).getByRole('button', { name: /notify me/i }));
    await waitFor(() => expect(patchNotificationPreference).toHaveBeenCalledWith('scheduling', { inAppEnabled: true, emailEnabled: true }));
  });

  it('a next shift is the hero; no empty card', async () => {
    renderView();
    expect(await screen.findAllByText('F&D Morning Shift')).not.toHaveLength(0);
    expect(screen.queryByTestId('no-next-shift')).not.toBeInTheDocument();
  });
});

describe('<AssociateScheduleView> — set-up lives in sheets', () => {
  it('"My availability" opens a sheet with the weekly hours, the one-time days off and a pointer to Time off', async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findAllByText('F&D Morning Shift');
    // Not inline under the schedule any more.
    expect(screen.queryByText('Pick when you can work')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'My availability' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'My availability' })).toBeInTheDocument();
    expect(await within(sheet).findByText('Pick when you can work')).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'Request time off' })).toHaveAttribute('href', '/time-off');
    expect(lastSearch).toBe('?sheet=availability');
  });

  it('?sheet=calendar opens "Add to calendar": Apple, Google and Copy — no raw feed address on the page', async () => {
    renderView('/scheduling?sheet=calendar');
    const sheet = await screen.findByTestId('calendar-sheet');
    expect(within(sheet).getByRole('link', { name: /apple calendar/i })).toHaveAttribute('href', 'webcal://x.test/api/calendar/v1/a/tok.ics');
    expect(within(sheet).getByRole('link', { name: /google calendar/i })).toHaveAttribute(
      'href',
      `https://calendar.google.com/calendar/r?cid=${encodeURIComponent('webcal://x.test/api/calendar/v1/a/tok.ics')}`,
    );
    expect(within(sheet).getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect(screen.queryByText('https://x.test/api/calendar/v1/a/tok.ics')).not.toBeInTheDocument();
  });
});
