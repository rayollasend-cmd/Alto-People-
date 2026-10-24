import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../pages/hrPack/harness';

// The engine never loads in jsdom: the plot stays a skeleton, the frame's summary and table carry the figure.
vi.mock('@/components/ui/charts/echarts/engine', () => ({ loadEcharts: () => new Promise(() => {}) }));
const api = vi.hoisted(() => ({ getAttendanceCalendar: vi.fn() }));
vi.mock('@/lib/attendanceInsightsApi', () => api);
vi.mock('@/lib/callOutsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/callOutsApi')>()), listCallOuts: vi.fn() }));
vi.mock('@/lib/schedulingApi', async (orig) => ({ ...(await orig<typeof import('@/lib/schedulingApi')>()), getAutoFillBatch: vi.fn(), listShifts: vi.fn(async () => ({ shifts: [] })) }));

import type { AttendanceCalendarResponse } from '@alto-people/shared';
import { listCallOuts } from '@/lib/callOutsApi';
import { fmtDateOnly } from '@/lib/format';
import { AttendanceCalendarCard, calendarSummary } from '@/components/attendance/AttendanceCalendarCard';
import { CallOutsDesk } from '@/pages/callouts/CallOutsDesk';

/**
 * The year in attendance: call-outs, no-shows or late arrivals, one cell a
 * day for twelve months — the switch changes the request and the title, the
 * sentence names the total and the busiest day, the table lists the days.
 */

const SITE = '33333333-3333-4333-8333-333333333333';

function calendar(over: Partial<AttendanceCalendarResponse> = {}): AttendanceCalendarResponse {
  return {
    metric: 'callouts',
    from: '2025-10-24',
    to: '2026-10-23',
    siteId: null,
    firstDay: 6,
    days: [
      { date: '2026-07-03', value: 2 },
      { date: '2026-07-04', value: 14 },
      { date: '2026-10-17', value: 3 },
    ],
    total: 19,
    busiest: { date: '2026-07-04', value: 14 },
    // Jul 4 and Oct 17, 2026 are Saturdays; Jul 3 a Friday.
    weekdayTotals: [0, 0, 0, 0, 0, 2, 17],
    ...over,
  };
}

beforeEach(() => {
  api.getAttendanceCalendar.mockReset();
  vi.mocked(listCallOuts).mockReset();
});

describe('<AttendanceCalendarCard>', () => {
  it('shows the year in call-outs — the sentence, the days newest first — and the switch changes the request and the title', async () => {
    api.getAttendanceCalendar.mockImplementation(async ({ metric }: { metric: AttendanceCalendarResponse['metric'] }) =>
      metric === 'callouts' ? calendar() : calendar({ metric, days: [{ date: '2026-09-01', value: 1 }], total: 1, busiest: { date: '2026-09-01', value: 1 }, weekdayTotals: [0, 0, 1, 0, 0, 0, 0] }),
    );
    const user = userEvent.setup();
    renderAs('WORKFORCE_MANAGER', <AttendanceCalendarCard />);

    expect(await screen.findByRole('heading', { name: 'The year in call-outs' })).toBeInTheDocument();
    expect(api.getAttendanceCalendar).toHaveBeenLastCalledWith({ metric: 'callouts', siteId: undefined });
    const busiest = fmtDateOnly('2026-07-04', { weekday: true, year: 'auto' });
    expect(screen.getByRole('img', { name: `19 call-outs in the last 12 months; the busiest day was ${busiest} (14), and Saturdays carry the most (17).` })).toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      [fmtDateOnly('2026-10-17', { weekday: true }), '3'],
      [fmtDateOnly('2026-07-04', { weekday: true }), '14'],
      [fmtDateOnly('2026-07-03', { weekday: true }), '2'],
    ]);
    expect(screen.getByRole('radio', { name: 'Call-outs' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: 'No-shows' }));
    expect(await screen.findByRole('heading', { name: 'The year in no-shows' })).toBeInTheDocument();
    expect(api.getAttendanceCalendar).toHaveBeenLastCalledWith({ metric: 'noshows', siteId: undefined });
    expect(screen.getByRole('img', { name: /^1 no-show in the last 12 months; the busiest day was .+ \(1\)\.$/ })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Late' }));
    expect(await screen.findByRole('heading', { name: 'The year in late arrivals' })).toBeInTheDocument();
    expect(api.getAttendanceCalendar).toHaveBeenLastCalledWith({ metric: 'late', siteId: undefined });
  });

  it('a quiet year is an empty state, not a blank calendar; a host’s site is passed through', async () => {
    api.getAttendanceCalendar.mockResolvedValue(calendar({ siteId: SITE, days: [], total: 0, busiest: null, weekdayTotals: [0, 0, 0, 0, 0, 0, 0] }));
    renderAs('WORKFORCE_MANAGER', <AttendanceCalendarCard siteId={SITE} />);
    expect(await screen.findByText('No call-outs in the last 12 months')).toBeInTheDocument();
    expect(api.getAttendanceCalendar).toHaveBeenLastCalledWith({ metric: 'callouts', siteId: SITE });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says the year in one sentence — the weekday only when one clearly leads', () => {
    const m = { one: 'late arrival', noun: 'late arrivals' };
    const day = fmtDateOnly('2026-07-04', { weekday: true, year: 'auto' });
    expect(calendarSummary(calendar({ metric: 'late', total: 312, busiest: { date: '2026-07-04', value: 14 }, weekdayTotals: [30, 40, 40, 40, 40, 64, 58] }), m)).toBe(
      `312 late arrivals in the last 12 months; the busiest day was ${day} (14), and Fridays carry the most (64).`,
    );
    // A tie at the top says nothing about weekdays.
    expect(calendarSummary(calendar({ total: 20, weekdayTotals: [0, 0, 0, 0, 0, 10, 10] }), m)).toBe(`20 late arrivals in the last 12 months; the busiest day was ${day} (14).`);
    expect(calendarSummary(calendar({ total: 0, days: [], busiest: null }), m)).toBe('No late arrivals in the last 12 months.');
    // Last year's busiest day carries its year.
    expect(calendarSummary(calendar({ total: 1, busiest: { date: '2025-11-28', value: 1 }, weekdayTotals: [0, 0, 0, 0, 0, 1, 0] }), { one: 'call-out', noun: 'call-outs' })).toMatch(
      /^1 call-out in the last 12 months; the busiest day was Fri, Nov 28, 2025 \(1\)\.$/,
    );
  });
});

describe('the call-outs desk', () => {
  const list = { range: 'today' as const, total: 0, covered: 0, looking: 0, uncovered: 0, late: 0, truncated: false, items: [], sites: [{ id: SITE, name: 'Store 12' }] };

  it('puts the year under the live list, for the site the desk is filtered to', async () => {
    vi.mocked(listCallOuts).mockResolvedValue(list as never);
    api.getAttendanceCalendar.mockResolvedValue(calendar({ siteId: SITE }));
    renderAs('SHIFT_SUPERVISOR', <CallOutsDesk />, `/call-outs?site=${SITE}`);
    expect(await screen.findByRole('heading', { name: 'The year in call-outs' })).toBeInTheDocument();
    // A quiet day still shows the year behind it.
    expect(screen.getAllByText(/No call-outs today or tomorrow/).length).toBeGreaterThan(0);
    expect(api.getAttendanceCalendar).toHaveBeenLastCalledWith({ metric: 'callouts', siteId: SITE });
  });

  it('leaves it out for someone outside the attendance-insights gate', async () => {
    vi.mocked(listCallOuts).mockResolvedValue(list as never);
    renderAs('ASSOCIATE', <CallOutsDesk />, '/call-outs');
    expect(await screen.findAllByText(/No call-outs today or tomorrow/)).not.toHaveLength(0);
    expect(screen.queryByRole('heading', { name: /The year in/ })).not.toBeInTheDocument();
    expect(api.getAttendanceCalendar).not.toHaveBeenCalled();
  });
});
