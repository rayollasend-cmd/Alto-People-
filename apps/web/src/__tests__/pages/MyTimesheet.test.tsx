import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimeEntry } from '@alto-people/shared';

vi.mock('@/lib/timeApi', () => ({
  listMyTimeEntries: vi.fn(),
}));

import { listMyTimeEntries } from '@/lib/timeApi';
import { MyTimesheet } from '@/pages/time/MyTimesheet';

const entryFixture = (over: Partial<TimeEntry>): TimeEntry =>
  ({
    id: 'e1',
    associateId: 'a',
    associateName: 'Maria Lopez',
    clientId: null,
    clientName: null,
    clockInAt: '2026-07-01T13:02:00.000Z',
    clockOutAt: '2026-07-01T21:04:00.000Z',
    status: 'APPROVED',
    notes: null,
    rejectionReason: null,
    approvedById: null,
    approverEmail: null,
    approvedAt: null,
    minutesElapsed: 482,
    netMinutes: 452,
    breaks: [
      {
        id: 'b1',
        type: 'MEAL',
        startedAt: '2026-07-01T17:00:00.000Z',
        endedAt: '2026-07-01T17:30:00.000Z',
        minutes: 30,
      },
    ],
    ...over,
  }) as TimeEntry;

function renderSheet() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MyTimesheet />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('<MyTimesheet>', () => {
  it('shows punch times, net hours, status, and the approved total', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({
      entries: [
        entryFixture({}),
        entryFixture({
          id: 'e2',
          clockInAt: '2026-07-02T13:00:00.000Z',
          clockOutAt: '2026-07-02T17:00:00.000Z',
          status: 'COMPLETED',
          minutesElapsed: 240,
          netMinutes: 240,
          breaks: [],
        }),
      ],
    });
    renderSheet();
    await waitFor(() => expect(listMyTimeEntries).toHaveBeenCalled());

    // Approved row: net hours + status badge + break subline.
    expect(await screen.findByText('7.5h')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText(/30m break/)).toBeInTheDocument();
    // Pending row.
    expect(screen.getByText('4.0h')).toBeInTheDocument();
    expect(screen.getByText('Pending review')).toBeInTheDocument();
    // Range totals.
    expect(screen.getByText('7.5h approved')).toBeInTheDocument();
    expect(screen.getByText('4.0h pending review')).toBeInTheDocument();
  });

  it('renders the empty state when there are no punches', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [] });
    renderSheet();
    expect(await screen.findByText('No punches in this range')).toBeInTheDocument();
  });
});
