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
const floor = vi.hoisted(() => ({ textCrew: vi.fn(), raiseFloorFlag: vi.fn() }));
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
  calledOutHow: null,
  hasPhone: true,
  textable: true,
  phone: '+15555550101',
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  floor.textCrew.mockReset();
  floor.raiseFloorFlag.mockReset();
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

describe('<AttendanceTrendTiles> with no shifts last week (F500)', () => {
  it('shows this week so far instead of "—" over a sparkline with values, in warning below target', async () => {
    const data = trends();
    data.weeks[2] = week('2026-10-10', { fillRatePct: null, scheduledShifts: 0, filledShifts: 0 });
    data.weeks[3] = week('2026-10-17', { inProgress: true, fillRatePct: 18 });
    api.getAttendanceTrends.mockResolvedValue(data);
    renderAs('WORKFORCE_MANAGER', <AttendanceTrendTiles />);
    expect(await screen.findByText('Fill rate · this week')).toBeInTheDocument();
    expect(screen.queryByText('Fill rate · last week')).toBeNull();
    expect(screen.getByText('So far · target 95%')).toBeInTheDocument();
    // The value counts up to 18%.
    expect(await screen.findByText('18%')).toBeInTheDocument();
    expect(screen.getByText('Fill rate · this week').closest('a')).toHaveAttribute('href', '/scheduling');
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

  it('narrows to one location by hour — from the picker or a tap on its row', async () => {
    api.getAttendanceHeatmap.mockImplementation(async ({ metric, siteId }: { metric: string; siteId?: string }) => ({
      metric,
      from: '2026-08-26',
      to: '2026-10-20',
      siteId: siteId ?? null,
      by: siteId ? 'hour' : 'site',
      unit: 'count',
      days: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      rows: siteId
        ? [{ key: '06', label: '6 AM', values: [0, 1, 0, 0, 0, 0, 0], total: 1 }]
        : [
            { key: 'l1', label: 'Harbor Inn', values: [0, 1, 4, 0, 0, 0, 2], total: 7 },
            { key: 'l2', label: 'Dune Resort', values: [0, 0, 1, 0, 0, 0, 0], total: 1 },
          ],
      max: 4,
      total: siteId ? 1 : 8,
    }));
    const user = userEvent.setup();
    renderAs('WORKFORCE_MANAGER', <AttendanceHeatmapCard />);
    const picker = await screen.findByRole('combobox', { name: 'Location' });
    await user.selectOptions(picker, 'l2');
    expect(await screen.findByRole('heading', { name: 'Lateness by day and hour · Dune Resort' })).toBeInTheDocument();
    expect(api.getAttendanceHeatmap).toHaveBeenLastCalledWith({ metric: 'late', siteId: 'l2' });
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
        person({ shiftId: 's3', associateId: 'a3', name: 'Dee Ward', status: 'called-out', calledOutHow: 'unconfirmed', hasPhone: false, textable: false, phone: null }),
        // Two minutes past start: inside the grace — listed, never texted.
        person({ shiftId: 's4', associateId: 'a4', name: 'Eve Lin', minutesLate: 2, status: 'due', phone: '(305) 555-0104' }),
        person({ shiftId: 's5', associateId: 'a5', name: 'Fay Ross', minutesLate: 40, status: 'on-leave', clientId: 'c2' }),
      ],
    });
    floor.textCrew.mockResolvedValue({ sent: 2, failed: 0, optedOut: 0, noPhone: [], notConfigured: null });
    const user = userEvent.setup();
    renderAs('SHIFT_SUPERVISOR', <NotInYetCard canCover />);
    const list = await screen.findByRole('list', { name: 'Not in yet' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText('45 min late')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: /No-show → find cover/ })).toHaveAttribute('href', '/scheduling?shift=s9');
    expect(within(rows[1]!).getByRole('link', { name: 'Call Ana Reyes' })).toHaveAttribute('href', 'tel:+15555550101');
    expect(within(rows[1]!).getByRole('link', { name: 'Text Ana Reyes' })).toHaveAttribute('href', 'sms:+15555550101');
    // Called out (still theirs) and on leave: the shift itself, to cover.
    expect(within(rows[2]!).getByText('Said they can’t make it · not confirmed')).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('link', { name: /Find cover/ })).toHaveAttribute('href', '/scheduling?shift=s3');
    expect(within(rows[4]!).getByText('On approved time off')).toBeInTheDocument();
    expect(within(rows[4]!).getByRole('link', { name: /Find cover/ })).toHaveAttribute('href', '/scheduling?shift=s5');
    // A formatted number dials as digits.
    expect(within(rows[3]!).getByRole('link', { name: 'Call Eve Lin' })).toHaveAttribute('href', 'tel:3055550104');

    // The two who are late (not the one who called out, the one on leave, or
    // the one a minute past start) get one text — through their client.
    await user.click(screen.getByRole('button', { name: 'Text the 2 late' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Are you on your way?');
    await user.click(within(dialog).getByRole('button', { name: 'Send to 2' }));
    expect(floor.textCrew).toHaveBeenCalledWith({ clientId: 'c1', shiftIds: ['s9', 's1'], body: 'Are you on your way?' });
  });

  it('a watch-only lead sees who, without calls, texts or cover — and an all-clear when everyone’s in', async () => {
    api.getLateNow.mockResolvedValueOnce({ generatedAt: '', graceMinutes: 7, noShowRiskMinutes: 30, canText: false, people: [person({ phone: null, textable: false, status: 'no-show-risk', minutesLate: 50 })] });
    floor.raiseFloorFlag.mockResolvedValue({ id: 'f1' });
    const user = userEvent.setup();
    const { unmount } = renderAs('FLOOR_SUPERVISOR', <NotInYetCard />);
    expect(await screen.findByText('Ana Reyes')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Call/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /find cover/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Text the/ })).toBeNull();
    // What they can do: put it in front of the supervisor.
    await user.click(screen.getByRole('button', { name: 'Flag to supervisor' }));
    expect(floor.raiseFloorFlag).toHaveBeenCalledWith(expect.objectContaining({ kind: 'NO_SHOW', associateId: 'a1', shiftId: 's1', clientId: 'c1' }));
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
    expect(screen.getByRole('img', { name: 'Fill rate met the 95% target in 1 of 4 weeks with shifts; this week so far is 80%.' })).toBeInTheDocument();
  });

  it('keeps a week with nothing scheduled as a gap, said so, and collapses to one line when every week is empty', async () => {
    const t = trends();
    t.weeks[1] = week('2026-10-03', { fillRatePct: null, scheduledShifts: 0, filledShifts: 0 });
    api.getAttendanceTrends.mockResolvedValue(t);
    const { unmount } = renderAs('SHIFT_SUPERVISOR', <FillRateTrendCard />);
    expect(await screen.findByRole('img', { name: /in 1 of 3 weeks with shifts; .* 1 week had nothing scheduled\./ })).toBeInTheDocument();
    unmount();
    api.getAttendanceTrends.mockResolvedValue({ ...trends(), weeks: trends().weeks.map((w) => ({ ...w, fillRatePct: null })) });
    renderAs('SHIFT_SUPERVISOR', <FillRateTrendCard />);
    // One quiet EmptyState line, not an empty chart or a bordered paragraph.
    expect(await screen.findByText(/Nothing scheduled yet — the line starts with the first published week/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Fill rate · 8 weeks');
    expect(screen.queryByRole('heading', { name: 'Fill rate · 8 weeks' })).toBeNull();
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
