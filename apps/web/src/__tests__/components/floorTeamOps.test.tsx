import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../pages/hrPack/harness';

/**
 * Builder S's pieces: the coverage gap in Needs you, the ops board's
 * never-closed shifts, the 1:1 rhythm on team rows and the 1:1 drawer, the
 * review composer's record, the floor's activity feed, and store labels.
 */

const floor = vi.hoisted(() => ({ coverShift: vi.fn() }));
vi.mock('@/lib/floorApi', () => floor);
const ops = vi.hoisted(() => ({ closeOutOpsShift: vi.fn(), cancelOpsShift: vi.fn() }));
vi.mock('@/lib/opsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/opsApi')>()), ...ops }));
const team = vi.hoisted(() => ({ bookTeamOneOnOne: vi.fn() }));
vi.mock('@/lib/teamApi', async (orig) => ({ ...(await orig<typeof import('@/lib/teamApi')>()), ...team }));
const perf = vi.hoisted(() => ({
  updateOneOnOne: vi.fn(),
  addOneOnOneActionItem: vi.fn(),
  updateOneOnOneActionItem: vi.fn(),
  deleteOneOnOneActionItem: vi.fn(),
}));
vi.mock('@/lib/perf84Api', async (orig) => ({ ...(await orig<typeof import('@/lib/perf84Api')>()), ...perf }));
const review = vi.hoisted(() => ({ getReviewContext: vi.fn() }));
vi.mock('@/lib/performanceApi', async (orig) => ({ ...(await orig<typeof import('@/lib/performanceApi')>()), ...review }));
const activity = vi.hoisted(() => ({ getOpsActivity: vi.fn() }));
vi.mock('@/lib/opsActivityApi', () => activity);

import { CoverageGapNotice, coverageGaps } from '@/components/floor/CoverageGapNotice';
import { NeverClosedCard } from '@/pages/ops/NeverClosedCard';
import { OneOnOneCell, oneOnOneSummary } from '@/components/team/OneOnOneCell';
import { OneOnOneDrawer } from '@/pages/performance/OneOnOneDrawer';
import { ReviewRecordPanel } from '@/pages/performance/ReviewRecordPanel';
import { OpsActivityFeed } from '@/components/home/OpsActivityFeed';
import { disambiguateStores } from '@/lib/laborCostLabels';
import type { MyShiftWindow } from '@/lib/shiftWindowsApi';
import type { WaveRow } from '@/pages/portal/waves';
import type { OpsShiftRow } from '@/lib/opsApi';
import type { DirectReport } from '@/lib/teamApi';
import type { OneOnOne } from '@/lib/perf84Api';

beforeEach(() => {
  vi.clearAllMocks();
});

const swing: MyShiftWindow = { locationId: 'L1', locationName: 'Front Beach 218', timezone: 'UTC', label: 'Swing', startMinute: 14 * 60, endMinute: 22 * 60, targetCount: 6 };
const row = (over: Partial<WaveRow>): WaveRow => ({
  shiftId: 's1',
  associateId: 'a1',
  name: 'Ana Reyes',
  position: 'Housekeeper',
  isLead: false,
  clockInAt: null,
  clockOutAt: null,
  startsAt: '2026-10-21T15:00:00.000Z',
  endsAt: '2026-10-21T21:00:00.000Z',
  timezone: 'UTC',
  locationId: 'L1',
  locationName: 'Front Beach 218',
  state: 'confirmed',
  ...over,
});

describe('coverage gaps in Needs you', () => {
  it('finds a short window that has not ended, counting open shifts apart', () => {
    const roster = [row({ shiftId: 's1' }), row({ shiftId: 's2', state: 'open', associateId: null })];
    const at10 = new Date('2026-10-21T10:00:00.000Z');
    expect(coverageGaps(roster, [swing], at10)).toEqual([{ window: swing, scheduled: 1, openShiftIds: ['s2'] }]);
    // After the window ends, it's history — no gap.
    expect(coverageGaps(roster, [swing], new Date('2026-10-21T23:00:00.000Z'))).toEqual([]);
    // Fully staffed: no gap.
    const full = Array.from({ length: 6 }, (_, i) => row({ shiftId: `f${i}` }));
    expect(coverageGaps(full, [swing], at10)).toEqual([]);
  });

  it('fills a gap from the bench in one tap, or opens the schedule when nothing is posted', async () => {
    floor.coverShift.mockResolvedValue({ shiftId: 's2', steps: [] });
    const user = userEvent.setup();
    const { unmount } = renderAs('SHIFT_SUPERVISOR', <CoverageGapNotice today="2026-10-21" gaps={[{ window: swing, scheduled: 0, openShiftIds: ['s2', 's3'] }]} />);
    expect(screen.getByText("Today's swing: 0 of 6 scheduled")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fill from bench' }));
    expect(floor.coverShift).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('button', { name: 'Bench asked' })).toBeDisabled();
    unmount();
    renderAs('SHIFT_SUPERVISOR', <CoverageGapNotice today="2026-10-21" gaps={[{ window: { ...swing, startMinute: 18 * 60 }, scheduled: 0, openShiftIds: [] }]} />);
    expect(screen.getByText("Tonight's swing: 0 of 6 scheduled")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add shifts/ })).toHaveAttribute('href', '/scheduling?view=day&date=2026-10-21');
  });
});

describe('never-closed shifts on the ops board', () => {
  const shift = { id: 'o1', department: 'Housekeeping', locationName: 'Destin', clientName: 'Coastal', openedAt: '2026-09-18T20:00:00.000Z', dueAt: '2026-09-19T04:00:00.000Z', taskDone: 3, taskTotal: 7, openedByEmail: 'dana@x.com' } as unknown as OpsShiftRow;

  it('lists them apart and closes one out with an optional note', async () => {
    ops.closeOutOpsShift.mockResolvedValue({ ok: true, id: 'o1', closedIncomplete: true });
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <NeverClosedCard shifts={[shift]} onOpenRecord={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Never closed' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close out' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Close out' }));
    expect(ops.closeOutOpsShift).toHaveBeenCalledWith('o1', undefined);
  });

  it('renders nothing when every shift was closed', () => {
    const { container } = renderAs('HR_ADMINISTRATOR', <NeverClosedCard shifts={[]} onOpenRecord={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the 1:1 rhythm on a team row', () => {
  const report: DirectReport = { id: 'a1', firstName: 'Ana', lastName: 'Reyes', email: 'ana@x.com', phone: null, employmentType: 'W2', departmentName: null, jobTitle: null };

  it('says when the next is and how long since the last', () => {
    const twelve = new Date(Date.now() - 12 * 86_400_000).toISOString();
    expect(oneOnOneSummary({ lastOneOnOneAt: twelve, nextOneOnOne: null })).toBe('last 12d ago');
    expect(oneOnOneSummary({ lastOneOnOneAt: null, nextOneOnOne: null })).toBe('none held yet');
  });

  it('books a weekly 1:1 from the row, prefilled', async () => {
    team.bookTeamOneOnOne.mockResolvedValue({ id: 'm1', scheduledFor: '2026-10-22T14:00:00.000Z' });
    const user = userEvent.setup();
    renderAs('MANAGER', <OneOnOneCell report={report} />);
    await user.click(screen.getByRole('button', { name: 'Book a 1:1 with Ana' }));
    await user.click(await screen.findByRole('button', { name: 'Book 1:1' }));
    expect(team.bookTeamOneOnOne).toHaveBeenCalledWith('a1', expect.objectContaining({ cadence: 'WEEKLY' }));
  });
});

describe('a 1:1, worked in place', () => {
  const meeting: OneOnOne = {
    id: 'm1',
    associateId: 'a1',
    associateName: 'Ana Reyes',
    managerUserId: 'u1',
    managerEmail: 'me@example.com',
    scheduledFor: '2026-10-22T14:00:00.000Z',
    completedAt: null,
    agenda: 'Schedule for November',
    managerNotes: null,
    associateNotes: null,
    status: 'SCHEDULED',
    cadence: 'WEEKLY',
    seriesId: 'm1',
    actionItems: [{ id: 'i1', text: 'Send the new rota', ownerIsManager: true, doneAt: null, carried: true, createdAt: '2026-10-15T14:00:00.000Z' }],
  };

  it('shows carried-over items, adds one, and completes into the next meeting', async () => {
    perf.addOneOnOneActionItem.mockResolvedValue({ item: { id: 'i2', text: 'Check her availability', ownerIsManager: true, doneAt: null, carried: false, createdAt: '' } });
    perf.updateOneOnOne.mockResolvedValue({ ok: true, nextId: 'm2' });
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <OneOnOneDrawer meeting={meeting} canManage queryKey={['perf']} onClose={vi.fn()} />);
    expect(screen.getByText('carried over')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'New action item' }), 'Check her availability');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(perf.addOneOnOneActionItem).toHaveBeenCalledWith('m1', { text: 'Check her availability' });
    expect(await screen.findByText('Check her availability')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Complete & book next/ }));
    expect(perf.updateOneOnOne).toHaveBeenCalledWith('m1', expect.objectContaining({ status: 'COMPLETED' }));
  });
});

describe('the review composer’s record', () => {
  it('shows goals, attendance, 1:1s, kudos and the last review for the period', async () => {
    review.getReviewContext.mockResolvedValue({
      associate: { id: 'a1', name: 'Ana Reyes' },
      from: '2026-07-01',
      to: '2026-09-30',
      goals: [{ id: 'g1', title: 'Cut room turn time', status: 'ACTIVE', progressPct: 60, periodEnd: '2026-12-31' }],
      kudos: [{ id: 'k1', message: 'Covered three shifts', from: 'dana@x.com', at: '2026-08-01T00:00:00.000Z' }],
      oneOnOnes: [{ id: 'm1', at: '2026-09-01T14:00:00.000Z', notes: 'Wants to lead', agenda: null, itemsDone: 1, itemsOpen: 1 }],
      attendance: { late: 2, noCallNoShow: 1, callOut: 0, earlyOut: 0 },
      lastReview: { id: 'r1', periodStart: '2026-04-01', periodEnd: '2026-06-30', overallRating: 4, summary: 'Strong quarter.' },
    });
    renderAs('HR_ADMINISTRATOR', <ReviewRecordPanel associateId="a1" from="2026-07-01" to="2026-09-30" />);
    expect(await screen.findByText('Cut room turn time')).toBeInTheDocument();
    expect(screen.getByText('No-call no-shows').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Wants to lead')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 action items done')).toBeInTheDocument();
    expect(screen.getByText(/Covered three shifts/)).toBeInTheDocument();
    expect(screen.getByText(/4 of 5/)).toBeInTheDocument();
    expect(review.getReviewContext).toHaveBeenCalledWith('a1', '2026-07-01', '2026-09-30');
  });
});

describe('recent activity on the floor', () => {
  it('lists call-outs, publishes, swaps and incidents, each linking where it is worked', async () => {
    activity.getOpsActivity.mockResolvedValue({
      days: 7,
      items: [
        { id: 'callout:c1', kind: 'call_out', at: new Date().toISOString(), title: 'Ana Reyes called out', detail: 'Housekeeper · needs cover', href: '/call-outs?callout=c1' },
        { id: 'published:x', kind: 'published', at: new Date().toISOString(), title: '42 shifts published', detail: 'Coastal Resort', href: '/scheduling?view=week&date=2026-10-24' },
      ],
    });
    renderAs('HR_ADMINISTRATOR', <OpsActivityFeed auditLink />);
    expect(await screen.findByRole('link', { name: /Ana Reyes called out/ })).toHaveAttribute('href', '/call-outs?callout=c1');
    expect(screen.getByRole('link', { name: /42 shifts published/ })).toHaveAttribute('href', '/scheduling?view=week&date=2026-10-24');
    expect(screen.getByRole('link', { name: /Audit log/ })).toHaveAttribute('href', '/audit');
  });
});

describe('store labels on labor costs', () => {
  it('names repeated stores by client, then by a short id', () => {
    const rows = [
      { locationId: 'aaaa1111', locationName: 'The Grand Hotel', clientName: 'Coastal' },
      { locationId: 'bbbb2222', locationName: 'The Grand Hotel', clientName: 'Seaside' },
      { locationId: 'cccc3333', locationName: 'The Grand Hotel', clientName: 'Seaside' },
      { locationId: 'dddd4444', locationName: 'Front Beach', clientName: 'Coastal' },
    ];
    expect(disambiguateStores(rows).map((r) => r.locationName)).toEqual([
      'The Grand Hotel — Coastal',
      'The Grand Hotel — Seaside · #bbbb',
      'The Grand Hotel — Seaside · #cccc',
      'Front Beach',
    ]);
  });
});
