import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/timeApi', () => ({ listMyTimeEntries: vi.fn() }));
vi.mock('@/lib/schedulingApi', () => ({ listMyShifts: vi.fn() }));
vi.mock('@/components/EarningsCard', () => ({ useMyEarnings: vi.fn(() => ({ data: undefined })) }));

import { listMyTimeEntries } from '@/lib/timeApi';
import { listMyShifts } from '@/lib/schedulingApi';
import { useMyEarnings } from '@/components/EarningsCard';
import { MyWeekHours } from '@/pages/time/MyWeekHours';
import { workweekStart } from '@/lib/workweek';

/** A moment inside this Sat→Fri workweek. */
function thisWeek(hoursAfterSaturdayMidnight: number): Date {
  return new Date(workweekStart().getTime() + hoursAfterSaturdayMidnight * 3_600_000);
}

const entry = (minutes: number, split?: { ot?: number; dt?: number }) =>
  ({
    status: 'APPROVED',
    netMinutes: minutes,
    minutesElapsed: minutes,
    ...(split ? { hours: { regularMinutes: minutes - (split.ot ?? 0) - (split.dt ?? 0), overtimeMinutes: split.ot ?? 0, doubleTimeMinutes: split.dt ?? 0, overtimeMultiplier: 1.5, doubleMultiplier: 2 } } : {}),
  }) as never;
const shift = (startH: number, hours: number) =>
  ({
    status: 'ASSIGNED',
    startsAt: thisWeek(startH).toISOString(),
    endsAt: new Date(thisWeek(startH).getTime() + hours * 3_600_000).toISOString(),
  }) as never;

function renderIt() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MyWeekHours />
    </QueryClientProvider>,
  );
}

describe('<MyWeekHours> — the week at a glance on the Time page', () => {
  it('worked against scheduled, and what is left', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [entry(4 * 60), entry(4 * 60)] });
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [shift(10, 4), shift(34, 4), shift(58, 4)] });
    renderIt();
    expect(await screen.findByText('8h')).toBeInTheDocument();
    expect(screen.getByText(/\/ 12h scheduled/)).toBeInTheDocument();
    expect(screen.getByText('4h to go')).toBeInTheDocument();
  });

  it('names the overtime the server split — the paycheck’s — not hours minus 40', async () => {
    // 42 h worked; the server put 2 h of the last punch in overtime.
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [...Array.from({ length: 5 }, () => entry(7 * 60, { ot: 0 })), entry(7 * 60, { ot: 120 })] });
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] });
    renderIt();
    expect(await screen.findByText('2h of overtime this week')).toBeInTheDocument();
  });

  it('a daily-overtime state: 30 hours can already carry overtime, and the tile says so', async () => {
    // Three live-California 10-hour days: 2 h overtime each, though the week is under 40.
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [entry(600, { ot: 120 }), entry(600, { ot: 120 }), entry(600, { ot: 120 })] });
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] });
    renderIt();
    expect(await screen.findByText('6h of overtime this week')).toBeInTheDocument();
  });

  it('never works out overtime itself: past 40 with no server split names none', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: Array.from({ length: 6 }, () => entry(7 * 60)) });
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] });
    renderIt();
    expect(await screen.findByText('42h')).toBeInTheDocument();
    expect(screen.queryByText(/overtime this week/)).not.toBeInTheDocument();
  });

  it('the schedule’s projected overtime comes from the earnings estimate', async () => {
    vi.mocked(useMyEarnings).mockReturnValue({ data: { overtime: { projectedOtHours: 4 } } } as never);
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [entry(4 * 60)] });
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [shift(10, 4)] });
    renderIt();
    expect(await screen.findByText('Your schedule adds up to 4h of overtime this week')).toBeInTheDocument();
    vi.mocked(useMyEarnings).mockReturnValue({ data: undefined } as never);
  });

  it('stays out of the way with nothing worked or scheduled', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [] });
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] });
    const { container } = renderIt();
    // Waiting on the CALL isn't enough any more: the tile now holds a
    // skeleton of its own height while the two queries are in flight, so
    // the page doesn't jump when the hero number lands. Empty is the
    // resting state, not the loading one.
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('says so — with a way to retry — when the hours cannot be loaded', async () => {
    // It used to swallow the error, which made the query *succeed* with
    // null: no retry, no message, and a tile that simply wasn't there.
    vi.mocked(listMyTimeEntries).mockRejectedValue(new Error('network'));
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] });
    renderIt();
    expect(await screen.findByText(/Couldn’t load your hours this week/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('the workweek is Saturday → Friday', () => {
  it('a Saturday starts its own week; a Friday ends the one that began the Saturday before', async () => {
    const sat = new Date(2026, 8, 19, 15); // Sat Sep 19 2026, 3 PM
    expect(workweekStart(sat).getDate()).toBe(19);
    const fri = new Date(2026, 8, 25, 23); // Fri Sep 25, 11 PM
    expect(workweekStart(fri).getDate()).toBe(19);
    const sun = new Date(2026, 8, 20, 9); // Sun Sep 20
    expect(workweekStart(sun).getDate()).toBe(19);
  });
});
