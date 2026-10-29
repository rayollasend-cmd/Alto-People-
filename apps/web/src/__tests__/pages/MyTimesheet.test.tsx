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
// The pay period as Home counts it (GET /time/me/earnings `period`); none = no pay schedule.
const earningsState: { data: unknown } = { data: { earnedSoFar: 0, workedHours: 0, period: null } };
vi.mock('@/components/EarningsCard', () => ({
  useMyEarnings: () => ({ data: earningsState.data, isSuccess: true, isError: false }),
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
  earningsState.data = { earnedSoFar: 0, workedHours: 0, period: null };
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
    // No pay schedule: the window is the last 14 days and the hero says so — never "This period".
    expect(screen.getByTestId('timesheet-hero-label')).toHaveTextContent('Last 14 days');
    // Rows: hours as every associate screen writes them (fmtHours, up to 2 decimals — ASSOC-28) + badges.
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

  it('overtime and double time are the server’s split, and the estimated gross pays them at their multipliers', async () => {
    // One live-California 13-hour day: the server split it 8 regular / 4 overtime / 1 double time.
    vi.mocked(listMyTimeEntries).mockResolvedValue({
      entries: [
        entryFixture({
          minutesElapsed: 780,
          netMinutes: 780,
          breaks: [],
          hours: { regularMinutes: 480, overtimeMinutes: 240, doubleTimeMinutes: 60, overtimeMultiplier: 1.5, doubleMultiplier: 2 },
        }),
      ],
    });
    renderSheet();
    expect(await screen.findByText('includes 4h overtime')).toBeInTheDocument();
    expect(screen.getByText('and 1h double time')).toBeInTheDocument();
    // 8 × $20 + 4 × $30 + 1 × $40 = $320 — what the paycheck pays, not 13 × $20.
    expect(screen.getAllByText('$320.00').length).toBeGreaterThan(0);
  });

  it('works out no overtime itself: a 45-hour week with no server split shows none', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({
      entries: Array.from({ length: 5 }, (_, i) =>
        entryFixture({ id: `e${i}`, clockInAt: `2026-07-0${i + 4}T14:00:00.000Z`, clockOutAt: `2026-07-0${i + 4}T23:00:00.000Z`, minutesElapsed: 540, netMinutes: 540, breaks: [] }),
      ),
    });
    renderSheet();
    await waitFor(() => expect(listMyTimeEntries).toHaveBeenCalled());
    await screen.findAllByText('9h');
    expect(screen.queryByText(/overtime/)).not.toBeInTheDocument();
  });

  it('opens on the pay period Home counts, and its hero is Home’s number (ASSOC-3)', async () => {
    earningsState.data = {
      earnedSoFar: 351.45,
      workedHours: 23.43,
      period: { start: '2026-10-24', end: '2026-11-06', payDate: '2026-11-13', today: '2026-10-29', day: 6, days: 14, workedHours: 23.43, earned: 351.45, takeHome: null },
    };
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [entryFixture({ clockInAt: '2026-10-26T11:00:00.000Z', clockOutAt: '2026-10-26T19:00:00.000Z' })] });
    renderSheet();
    await waitFor(() => expect(listMyTimeEntries).toHaveBeenCalled());
    // The range asked for is the period, not the last 14 days.
    const range = vi.mocked(listMyTimeEntries).mock.calls[0]![0] as { from: string; to: string };
    expect(new Date(range.from).getDate()).toBe(24);
    expect(await screen.findByTestId('timesheet-hero-label')).toHaveTextContent('This pay period · Oct 24 – Nov 6, 2026');
    expect(await screen.findByText('$351.45')).toBeInTheDocument();
    expect(screen.getByText(/23\.43h worked — estimated gross, before taxes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'This pay period', pressed: true })).toBeInTheDocument();
  });

  it('renders the empty state when there are no punches', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [] });
    renderSheet();
    expect(await screen.findByText('No punches in this range')).toBeInTheDocument();
  });
});
