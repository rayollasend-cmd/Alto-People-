import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/timeApi', () => ({ listMyTimeEntries: vi.fn() }));
vi.mock('@/lib/schedulingApi', () => ({ listMyShifts: vi.fn() }));

import { listMyTimeEntries } from '@/lib/timeApi';
import { listMyShifts } from '@/lib/schedulingApi';
import { MyWeekHours } from '@/pages/time/MyWeekHours';

/** A moment inside this local Sunday-start week. */
function thisWeek(hoursAfterSundayMidnight: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return new Date(d.getTime() + hoursAfterSundayMidnight * 3_600_000);
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
