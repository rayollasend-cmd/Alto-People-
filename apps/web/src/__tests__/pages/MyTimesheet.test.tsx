import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
      {/* Router context — the dispute toast's "View in My cases" action
          navigates via useNavigate. */}
      <MemoryRouter>
        <MyTimesheet />
      </MemoryRouter>
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

    // The hero: gross leads (7.533h × $20 = $150.67, cents kept), with
    // approved hours + pending folded into the one sentence under it.
    expect(await screen.findByText('$150.67')).toBeInTheDocument();
    expect(
      screen.getByText(/7\.53h approved — estimated gross, before taxes/),
    ).toBeInTheDocument();
    expect(screen.getByText(/4h awaiting review/)).toBeInTheDocument();
    // Rows: net hours in the shared dialect ("4h", not "4.00h") + badges.
    expect(screen.getByText('7.53h')).toBeInTheDocument();
    expect(screen.getByText('4h')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Pending review')).toBeInTheDocument();
    expect(screen.getByText(/0\.5h break/)).toBeInTheDocument();
    // Weekly grouping header (h3) — the label depends on how far real
    // time has moved past the fixed fixtures ("This week" → "Last week"
    // → "Week of …"), so accept all three. Role-scoped because preset
    // chips with the same words also exist.
    expect(
      screen.getByRole('heading', { name: /This week|Last week|Week of / }),
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
