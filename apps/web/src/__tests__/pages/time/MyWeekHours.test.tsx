import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/timeApi', () => ({ listMyTimeEntries: vi.fn() }));
vi.mock('@/lib/schedulingApi', () => ({ listMyShifts: vi.fn() }));

import { listMyTimeEntries } from '@/lib/timeApi';
import { listMyShifts } from '@/lib/schedulingApi';
import { MyWeekHours } from '@/pages/time/MyWeekHours';
import { workweekStart } from '@/lib/workweek';

/** A moment inside this Sat→Fri workweek. */
function thisWeek(hoursAfterSaturdayMidnight: number): Date {
  return new Date(workweekStart().getTime() + hoursAfterSaturdayMidnight * 3_600_000);
}

const entry = (minutes: number) => ({ status: 'APPROVED', netMinutes: minutes, minutesElapsed: minutes }) as never;
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

  it('past 40 hours it says so — that is overtime', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: Array.from({ length: 6 }, () => entry(7 * 60)) });
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] });
    renderIt();
    expect(await screen.findByText('2h past 40 — this is overtime')).toBeInTheDocument();
  });

  it('stays out of the way with nothing worked or scheduled', async () => {
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [] });
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [] });
    const { container } = renderIt();
    await vi.waitFor(() => expect(listMyShifts).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
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
