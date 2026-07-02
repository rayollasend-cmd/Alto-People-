import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

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
}));

import {
  createSwap,
  getMyCalendarUrl,
  getMyShiftDetail,
  listMyShifts,
  listSwapCandidates,
  listSwapsIncoming,
} from '@/lib/schedulingApi';
import { AssociateScheduleView } from '@/pages/scheduling/AssociateScheduleView';

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
  ...over,
});

beforeEach(() => {
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

function renderView() {
  return render(
    <MemoryRouter>
      <AssociateScheduleView />
    </MemoryRouter>,
  );
}

describe('<AssociateScheduleView> shift detail', () => {
  it('expanding a shift card shows teammates, duration, site, and the manager note', async () => {
    const user = userEvent.setup();
    renderView();

    const card = await screen.findByRole('button', {
      name: /F&D Morning Shift/,
    });
    expect(card).toHaveAttribute('aria-expanded', 'false');
    await user.click(card);
    expect(card).toHaveAttribute('aria-expanded', 'true');

    // Teammates from the detail endpoint.
    expect(await screen.findByText('Pat Nguyen')).toBeInTheDocument();
    expect(screen.getByText(/Cashier/)).toBeInTheDocument();
    // Duration, site, and manager note.
    expect(screen.getByText('8h')).toBeInTheDocument();
    expect(screen.getByText(/Store 1424 · Front end/)).toBeInTheDocument();
    expect(screen.getByText(/Bring your food-safety card\./)).toBeInTheDocument();
    expect(getMyShiftDetail).toHaveBeenCalledWith('s1');
  });

  it('says so when nobody else is on the shift', async () => {
    vi.mocked(getMyShiftDetail).mockResolvedValue({
      shift: shift() as never,
      teammates: [],
    });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole('button', { name: /F&D Morning Shift/ }));
    expect(
      await screen.findByText(/No one else is scheduled alongside this shift/),
    ).toBeInTheDocument();
  });

  it('offers the shift to a free teammate; busy ones are not selectable', async () => {
    vi.mocked(createSwap).mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByRole('button', { name: /F&D Morning Shift/ }));
    await user.click(
      await screen.findByRole('button', { name: /offer this shift to a teammate/i }),
    );

    const picker = await screen.findByLabelText(/offer to/i);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Pat Nguyen/ })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('option', { name: /Bob Busy — busy during this shift/ }),
    ).toHaveProperty('disabled', true);

    await user.selectOptions(picker, 'b');
    await user.type(screen.getByLabelText(/note/i), 'Dentist that morning');
    await user.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() =>
      expect(createSwap).toHaveBeenCalledWith({
        shiftId: 's1',
        counterpartyAssociateId: 'b',
        note: 'Dentist that morning',
      }),
    );
    // The swaps section below refetches (its active tab) so the new
    // request shows up without a manual reload.
    await waitFor(() =>
      expect(vi.mocked(listSwapsIncoming).mock.calls.length).toBeGreaterThan(1),
    );
  });

  it('past shifts do not offer a swap', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({
      shifts: [
        shift({
          id: 's2',
          status: 'COMPLETED',
          startsAt: new Date(Date.now() - 32 * 3_600_000).toISOString(),
          endsAt: new Date(Date.now() - 24 * 3_600_000).toISOString(),
        }),
      ] as never,
    });
    vi.mocked(getMyShiftDetail).mockResolvedValue({
      shift: shift({ id: 's2', status: 'COMPLETED' }) as never,
      teammates: [],
    });
    const user = userEvent.setup();
    renderView();

    // Past shifts sit behind the "Show recent shifts" toggle.
    await user.click(await screen.findByRole('button', { name: /show recent shifts/i }));
    await user.click(await screen.findByRole('button', { name: /F&D Morning Shift/ }));
    await screen.findByText(/No one else is scheduled alongside this shift/);
    expect(
      screen.queryByRole('button', { name: /offer this shift to a teammate/i }),
    ).not.toBeInTheDocument();
  });
});
