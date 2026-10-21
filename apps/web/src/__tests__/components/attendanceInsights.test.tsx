import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../pages/hrPack/harness';

const api = vi.hoisted(() => ({
  getAttendanceTrends: vi.fn(),
  getAttendanceHeatmap: vi.fn(),
  getLateNow: vi.fn(),
  getTeamHours: vi.fn(),
}));
vi.mock('@/lib/attendanceInsightsApi', () => api);
const floor = vi.hoisted(() => ({ textCrew: vi.fn() }));
vi.mock('@/lib/floorApi', () => floor);

import { AttendanceTrendTiles } from '@/components/attendance/AttendanceTrendTiles';
import { AttendanceHeatmapCard, heatmapSummary } from '@/components/attendance/AttendanceHeatmapCard';
import { NotInYetCard } from '@/components/attendance/NotInYetCard';
import { FillRateTrendCard } from '@/components/attendance/FillRateTrendCard';
import { TeamHoursCard } from '@/components/attendance/TeamHoursCard';

/** The attendance insights on the floor homes: trend tiles, the heatmap, not-in-yet, the fill line, team hours. */

const week = (weekStart: string, over: Record<string, unknown> = {}) => ({
  weekStart,
  inProgress: false,
  scheduledShifts: 20,
  filledShifts: 19,
  fillRatePct: 95,
  noCallNoShows: 0,
  callOuts: 1,
  lates: 2,
  overtimeHours: 0,
  ...over,
});

const trends = () => ({
  generatedAt: '2026-10-20T12:00:00.000Z',
  siteId: null,
  fillTargetPct: 95,
  weeks: [
    week('2026-09-26'),
    week('2026-10-03', { fillRatePct: 90, lates: 4, noCallNoShows: 1 }),
    week('2026-10-10', { fillRatePct: 85, lates: 6, noCallNoShows: 3, callOuts: 2 }),
    week('2026-10-17', { inProgress: true, fillRatePct: 80, lates: 1, noCallNoShows: 0 }),
  ],
});

const person = (over: Record<string, unknown> = {}) => ({
  shiftId: 's1',
  associateId: 'a1',
  name: 'Ana Reyes',
  position: 'Housekeeper',
  clientId: 'c1',
  siteId: 'l1',
  siteName: 'Harbor Inn',
  startsAt: '2026-10-20T11:00:00.000Z',
  endsAt: '2026-10-20T19:00:00.000Z',
  timezone: 'America/New_York',
  minutesLate: 12,
  status: 'late',
  hasPhone: true,
  phone: '+15555550101',
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  floor.textCrew.mockReset();
});

describe('<AttendanceTrendTiles>', () => {
  it('heads each tile with the last complete week and its change from the week before', async () => {
    api.getAttendanceTrends.mockResolvedValue(trends());
    renderAs('WORKFORCE_MANAGER', <AttendanceTrendTiles />);
    expect(await screen.findByText('Fill rate · last week')).toBeInTheDocument();
    // Last complete week = Oct 10: 85%, 3 no-shows, 6 lates.
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText(/This week so far: 80% · target 95%/)).toBeInTheDocument();
    expect(screen.getByText('1 so far this week')).toBeInTheDocument();
    const lates = screen.getByText('Late arrivals').closest('a')!;
    expect(lates).toHaveAttribute('href', '/time-attendance');
    // Lates rose by 2 (4 → 6): the chip reads up.
    expect(within(lates).getByText('up', { exact: true })).toBeInTheDocument();
  });
});

describe('<AttendanceHeatmapCard>', () => {
  it('switches between lateness, overtime and call-outs', async () => {
    api.getAttendanceHeatmap.mockImplementation(async ({ metric }: { metric: string }) => ({
      metric,
      from: '2026-08-26',
      to: '2026-10-20',
      siteId: null,
      by: 'site',
      unit: metric === 'overtime' ? 'hours' : 'count',
      days: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      rows: [{ key: 'l1', label: 'Harbor Inn', values: [0, 1, 4, 0, 0, 0, 2], total: 7 }],
      max: 4,
      total: 7,
    }));
    const user = userEvent.setup();
    renderAs('WORKFORCE_MANAGER', <AttendanceHeatmapCard />);
    expect(await screen.findByRole('heading', { name: 'Lateness by day and location' })).toBeInTheDocument();
    expect(api.getAttendanceHeatmap).toHaveBeenLastCalledWith({ metric: 'late', siteId: undefined });
    await user.click(screen.getByRole('radio', { name: 'Overtime' }));
    expect(await screen.findByRole('heading', { name: 'Overtime by day and location' })).toBeInTheDocument();
    expect(api.getAttendanceHeatmap).toHaveBeenLastCalledWith({ metric: 'overtime', siteId: undefined });
  });

  it('says where it gathers, in a sentence', () => {
    const s = heatmapSummary(
      { metric: 'late', from: '', to: '', siteId: null, by: 'site', unit: 'count', days: ['Sat', 'Sun', 'Mon'], rows: [{ key: 'a', label: 'Harbor Inn', values: [1, 0, 5], total: 6 }, { key: 'b', label: 'Dune', values: [2, 0, 0], total: 2 }], max: 5, total: 8 },
      'late arrivals',
    );
    expect(s).toBe('8 late arrivals in all. The most fall on Mon at Harbor Inn (5).');
  });
});

describe('<NotInYetCard>', () => {
  it('lists who isn’t in with Call and Text, texts all of them at once, and sends a no-show to find cover', async () => {
    api.getLateNow.mockResolvedValue({
      generatedAt: '2026-10-20T12:00:00.000Z',
      graceMinutes: 7,
      noShowRiskMinutes: 30,
      canText: true,
      people: [
        person({ shiftId: 's9', associateId: 'a9', name: 'Ben Cole', minutesLate: 45, status: 'no-show-risk' }),
        person(),
        person({ shiftId: 's3', associateId: 'a3', name: 'Dee Ward', status: 'called-out', hasPhone: false, phone: null }),
      ],
    });
    floor.textCrew.mockResolvedValue({ sent: 2, noPhone: [] });
    const user = userEvent.setup();
    renderAs('SHIFT_SUPERVISOR', <NotInYetCard canCover />);
    const list = await screen.findByRole('list', { name: 'Not in yet' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('45 min late')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: /No-show → find cover/ })).toHaveAttribute('href', '/scheduling?shift=s9');
    expect(within(rows[1]!).getByRole('link', { name: 'Call Ana Reyes' })).toHaveAttribute('href', 'tel:+15555550101');
    expect(within(rows[1]!).getByRole('link', { name: 'Text Ana Reyes' })).toHaveAttribute('href', 'sms:+15555550101');
    expect(within(rows[2]!).getByRole('link', { name: /Find cover/ })).toHaveAttribute('href', '/call-outs');

    // The two who are missing (not the one who called out) get one text.
    await user.click(screen.getByRole('button', { name: 'Text the 2 not in' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Are you on your way?');
    await user.click(within(dialog).getByRole('button', { name: 'Send to 2' }));
    expect(floor.textCrew).toHaveBeenCalledWith({ shiftIds: ['s9', 's1'], body: 'Are you on your way?' });
  });

  it('a watch-only lead sees who, without calls, texts or cover — and an all-clear when everyone’s in', async () => {
    api.getLateNow.mockResolvedValueOnce({ generatedAt: '', graceMinutes: 7, noShowRiskMinutes: 30, canText: false, people: [person({ phone: null, status: 'no-show-risk', minutesLate: 50 })] });
    const { unmount } = renderAs('FLOOR_SUPERVISOR', <NotInYetCard />);
    expect(await screen.findByText('Ana Reyes')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Call/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /find cover/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Text the/ })).toBeNull();
    unmount();

    api.getLateNow.mockResolvedValueOnce({ generatedAt: '', graceMinutes: 7, noShowRiskMinutes: 30, canText: true, people: [] });
    renderAs('SHIFT_SUPERVISOR', <NotInYetCard />);
    expect(await screen.findByText('Everyone’s in')).toBeInTheDocument();
  });
});

describe('<FillRateTrendCard>', () => {
  it('reads the eight weeks against the 95% target', async () => {
    api.getAttendanceTrends.mockResolvedValue(trends());
    renderAs('SHIFT_SUPERVISOR', <FillRateTrendCard />);
    expect(await screen.findByRole('heading', { name: 'Fill rate · 8 weeks' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Fill rate met the 95% target in 1 of 4 weeks; this week so far is 80%.' })).toBeInTheDocument();
  });
});

describe('<TeamHoursCard>', () => {
  it('names who is heading into overtime against the 40-hour line', async () => {
    api.getTeamHours.mockResolvedValue({
      weekStart: '2026-10-17',
      weekEnd: '2026-10-24',
      thresholdHours: 40,
      people: [
        { associateId: 'a1', name: 'Ana Reyes', workedHours: 32, scheduledHours: 16, projectedHours: 48, onClock: true },
        { associateId: 'a2', name: 'Ben Cole', workedHours: 20, scheduledHours: 8, projectedHours: 28, onClock: false },
      ],
    });
    renderAs('MANAGER', <TeamHoursCard />);
    expect(await screen.findByRole('heading', { name: 'Hours this week' })).toBeInTheDocument();
    expect(screen.getByText(/1 person is heading into overtime/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '1 of 2 on course to pass 40 hours this week: Ana Reyes (48h).' })).toBeInTheDocument();
  });

  it('shows nothing for a manager with no team', async () => {
    api.getTeamHours.mockResolvedValue({ weekStart: '2026-10-17', weekEnd: '2026-10-24', thresholdHours: 40, people: [] });
    const { container } = renderAs('MANAGER', <TeamHoursCard />);
    await vi.waitFor(() => expect(api.getTeamHours).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).not.toMatch(/Hours this week/);
  });
});
