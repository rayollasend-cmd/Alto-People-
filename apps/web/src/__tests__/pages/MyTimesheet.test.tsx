import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TimeEntry } from '@alto-people/shared';

vi.mock('@/lib/timeApi', () => ({
  listMyTimeEntries: vi.fn(),
}));
vi.mock('@/lib/hrCases123Api', () => ({
  fileCase: vi.fn(),
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
    payRate: 20,
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

    // Approved: hours appear in the summary band AND on the row; the
    // status word appears as the band label AND the row badge.
    expect(await screen.findAllByText('7.5h')).toHaveLength(2);
    expect(screen.getAllByText('Approved')).toHaveLength(2);
    expect(screen.getByText(/30m break/)).toBeInTheDocument();
    // Pending: same duality.
    expect(screen.getAllByText('4.0h')).toHaveLength(2);
    expect(screen.getAllByText('Pending review')).toHaveLength(2);
    // Gross estimate stat (7.53h × $20 ≈ $151).
    expect(screen.getByText('≈ Est. gross')).toBeInTheDocument();
    expect(screen.getByText('$151')).toBeInTheDocument();
    // Weekly grouping header (h3) — "This week" while the fixtures are
    // fresh, "Week of …" once real time moves past their week. Role-
    // scoped because a "This week" preset chip also exists.
    expect(
      screen.getByRole('heading', { name: /This week|Week of / }),
    ).toBeInTheDocument();
    // Each row offers the dispute entry point.
    expect(screen.getAllByRole('button', { name: /report an issue/i })).toHaveLength(2);
  });

  it('renders the empty state when there are no punches', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [] });
    renderSheet();
    expect(await screen.findByText('No punches in this range')).toBeInTheDocument();
  });
});
