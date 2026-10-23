import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RosterPerson } from '@alto-people/shared';
import { renderPage } from './render';
import { BIWEEKLY, COASTAL, FACETS, HARBOR, KIM, MARIA, SAM, THANKSGIVING, WEEKLY, detail, impact, period, person } from './fixtures';

const api = vi.hoisted(() => ({
  getPaySchedule: vi.fn(),
  getPayScheduleRoster: vi.fn(),
  listPaySchedules: vi.fn(),
  getPayCalendar: vi.fn(),
  getPayScheduleHistory: vi.fn(),
  previewMove: vi.fn(),
  applyMove: vi.fn(),
  endScheduleRule: vi.fn(),
  updatePaySchedule: vi.fn(),
  previewPattern: vi.fn(),
  applyMembership: vi.fn(),
  previewMembership: vi.fn(),
  listScheduleCandidates: vi.fn(),
}));
vi.mock('@/lib/paySchedulesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/paySchedulesApi')>()), ...api }));

import { ApiError } from '@/lib/api';
import { PayScheduleDetailPage, suggestedDate } from '@/pages/payroll/schedules/PayScheduleDetailPage';
import { estimateChangeDate } from '@/pages/payroll/schedules/scheduleKit';

const counts = (ps: RosterPerson[]) => ({
  total: ps.length,
  ready: ps.filter((p) => p.readiness === 'READY').length,
  attention: ps.filter((p) => p.readiness === 'ATTENTION').length,
  blocked: ps.filter((p) => p.readiness === 'BLOCKED').length,
});
const HARBOR_CROWD = Array.from({ length: 75 }, (_, i) => person({ associateId: `h${i}`, name: `Harbor Person ${i}`, clientId: HARBOR, clientName: 'Harbor Inn' }));

function roster() {
  const coastal = [MARIA, SAM, KIM];
  return {
    groups: [
      { clientId: COASTAL, clientName: 'Coastal Resort', people: coastal, counts: counts(coastal) },
      { clientId: HARBOR, clientName: 'Harbor Inn', people: HARBOR_CROWD, counts: counts(HARBOR_CROWD) },
    ],
    totals: counts([...coastal, ...HARBOR_CROWD]),
  };
}

const open = () => renderPage(<PayScheduleDetailPage />, '/payroll/schedules/s1', '/payroll/schedules/:id');

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  localStorage.clear();
  api.getPaySchedule.mockResolvedValue({ schedule: detail() });
  api.getPayScheduleRoster.mockResolvedValue(roster());
  api.listPaySchedules.mockResolvedValue({ schedules: [BIWEEKLY, WEEKLY], unassigned: 0 });
  api.getPayCalendar.mockResolvedValue({ periods: [period(), THANKSGIVING] });
  api.getPayScheduleHistory.mockResolvedValue({ events: [{ at: '2099-10-01T15:00:00Z', actorName: null, summary: 'Kim Nguyen joined (hired at Coastal Resort)', kind: 'PERSON_JOINED' }] });
});

describe('<PayScheduleDetailPage>', () => {
  it('shows faces with readiness rings grouped by client; a large group starts collapsed and opens on demand', async () => {
    const user = userEvent.setup();
    open();
    expect(await screen.findByRole('heading', { name: 'Biweekly Hourly' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Sam Okafor — Won’t be paid correctly: No W-4 on file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maria Lopez — Ready to be paid' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kim Nguyen — Needs a look: First paycheck' })).toBeInTheDocument();
    // 75 at Harbor: collapsed to a stack until opened.
    const harbor = screen.getAllByRole('button', { name: /Harbor Inn/ }).find((b) => b.hasAttribute('aria-expanded'))!;
    expect(screen.getByRole('button', { name: 'Move everyone at Harbor Inn' })).toBeInTheDocument();
    expect(harbor).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /Harbor Person 3 —/ })).not.toBeInTheDocument();
    await user.click(harbor);
    expect(harbor).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Harbor Person 3 —/ })).toBeInTheDocument();
  });

  it('filters to the blocked, and the quick card carries the fix', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('button', { name: /Maria Lopez —/ });
    await user.click(screen.getByRole('button', { name: /^Blocked/ }));
    expect(screen.queryByRole('button', { name: /Maria Lopez —/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Sam Okafor —/ }));
    const card = await screen.findByRole('dialog');
    expect(within(card).getByText('$18.50/h')).toBeInTheDocument();
    expect(within(card).getByText(/On Biweekly Hourly since .* — they work for Coastal Resort/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Collect W-4' })).toHaveAttribute('href', '/people/a2?tab=tax');
    expect(within(card).getByRole('link', { name: 'Open profile' })).toHaveAttribute('href', '/people/a2');
  });

  it('“Move to…” previews who moves and the bridging paychecks, then applies', async () => {
    const user = userEvent.setup();
    api.previewMove.mockResolvedValue(
      impact({
        joins: 1,
        movingFrom: [{ scheduleId: 's1', name: 'Biweekly Hourly', count: 1 }],
        people: [{ associateId: 'a1', name: 'Maria Lopez', photoUrl: null, fromScheduleId: 's1', fromScheduleName: 'Biweekly Hourly', toScheduleId: 's2', toScheduleName: 'Weekly', effectiveFrom: '2099-10-24', because: 'Individual', transition: { lastOldPayDate: '2099-10-30', firstNewPayDate: '2099-11-05', note: null }, conflict: null }],
      }),
    );
    api.applyMove.mockResolvedValue({ impact: impact({ joins: 1 }) });
    open();
    await screen.findByRole('button', { name: /Maria Lopez —/ });
    await user.click(screen.getByRole('button', { name: 'Move Maria Lopez' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Weekly' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Move Maria Lopez to Weekly')).toBeInTheDocument();
    expect(await within(dialog).findByText('1 person join · 1 from Biweekly Hourly')).toBeInTheDocument();
    expect(within(dialog).getByText(/last check on the old schedule/)).toBeInTheDocument();
    expect(api.previewMove).toHaveBeenCalledWith({ toScheduleId: 's2', fromScheduleId: 's1', associateIds: ['a1'], clientIds: [], effectiveFrom: '2099-10-24' });
    await user.click(within(dialog).getByRole('button', { name: /Move 1/ }));
    await waitFor(() => expect(api.applyMove).toHaveBeenCalledWith({ toScheduleId: 's2', fromScheduleId: 's1', associateIds: ['a1'], clientIds: [], effectiveFrom: '2099-10-24' }));
  });

  it('the list view selects people for a bulk move', async () => {
    const user = userEvent.setup();
    api.previewMove.mockResolvedValue(impact({ joins: 2 }));
    open();
    await screen.findByRole('button', { name: /Maria Lopez —/ });
    await user.click(screen.getByRole('button', { name: 'List' }));
    const grid = await screen.findByRole('table');
    await user.click(within(grid).getByRole('checkbox', { name: /Maria Lopez/ }));
    await user.click(within(grid).getByRole('checkbox', { name: /Sam Okafor/ }));
    await user.click(screen.getByRole('button', { name: /Move to…/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Weekly' }));
    expect(await screen.findByText('Move 2 people to Weekly')).toBeInTheDocument();
    await waitFor(() => expect(api.previewMove).toHaveBeenCalledWith(expect.objectContaining({ associateIds: ['a1', 'a2'], toScheduleId: 's2' })));
  });

  it('Rules reads the rules in plain words and ends one from a date', async () => {
    const user = userEvent.setup();
    api.endScheduleRule.mockResolvedValue({ impact: impact({ leaves: 3, effectiveFrom: '2099-10-24' }) });
    open();
    await screen.findByRole('heading', { name: 'Biweekly Hourly' });
    await user.click(screen.getByRole('tab', { name: /^Rules/ }));
    expect(await screen.findByText('Everyone at Coastal Resort')).toBeInTheDocument();
    expect(screen.getByText('Except Lee Park')).toBeInTheDocument();
    expect(screen.getByText(/3 people · since/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'End from a date' })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'End rule' }));
    await waitFor(() => expect(api.endScheduleRule).toHaveBeenCalledWith('s1', 'r1', '2099-10-24'));
  });

  it('the calendar explains a holiday payday, and history says who changed what', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole('heading', { name: 'Biweekly Hourly' });
    await user.click(screen.getByRole('tab', { name: 'Calendar' }));
    expect(await screen.findByText(/Thanksgiving Day on .* — paid .* instead/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByText('Kim Nguyen joined (hired at Coastal Resort)')).toBeInTheDocument();
    expect(screen.getByText(/automatic/)).toBeInTheDocument();
  });

  it('a change starts with the first period that hasn’t begun, read from the calendar', async () => {
    const user = userEvent.setup();
    api.getPaySchedule.mockResolvedValue({ schedule: detail({ nextPeriod: period({ periodStart: '2026-01-03', periodEnd: '2026-01-16', payDate: '2099-11-06' }) }) });
    api.getPayCalendar.mockResolvedValue({ periods: [period({ periodStart: '2026-01-17' }), period({ periodStart: '2099-10-31' })] });
    api.listScheduleCandidates.mockResolvedValue({ people: [], total: 0, nextCursor: null, facets: FACETS });
    open();
    await screen.findByRole('button', { name: /Maria Lopez —/ });
    await user.click(screen.getAllByRole('button', { name: /Add people/ })[0]!);
    expect(await screen.findByLabelText('First day on this schedule')).toHaveValue('2099-10-31');
  });

  it('shows joiners under their own chip', async () => {
    const user = userEvent.setup();
    const joiner = person({ associateId: 'a7', name: 'Jo Future', onScheduleSince: '2099-10-24', because: 'Individual' });
    const r = roster();
    r.groups[0]!.people.push(joiner);
    api.getPayScheduleRoster.mockResolvedValue(r);
    open();
    await screen.findByRole('button', { name: /Maria Lopez —/ });
    await user.click(screen.getByRole('button', { name: /^Joining/ }));
    expect(screen.queryByRole('button', { name: /Maria Lopez —/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Jo Future —/ }));
    expect(await screen.findByText(/Joins Biweekly Hourly on .* — chosen for them by name/)).toBeInTheDocument();
    expect(api.getPayScheduleRoster).toHaveBeenCalledWith('s1');
  });

  it('a pattern change that doesn’t start a period shows why and offers the date the API suggests', async () => {
    const user = userEvent.setup();
    api.getPayCalendar.mockResolvedValue({ periods: [period({ periodStart: '2099-10-24' }), period({ periodStart: '2099-11-07' })] });
    api.previewPattern.mockResolvedValue({ periods: [period({ payDate: '2099-11-05' })] });
    api.updatePaySchedule
      .mockRejectedValueOnce(new ApiError(400, 'not_a_period_start', 'Oct 24 isn’t the start of a pay period on this schedule. The next one starts Nov 7.'))
      .mockResolvedValueOnce({ schedule: detail() });
    open();
    await screen.findByRole('heading', { name: 'Biweekly Hourly' });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Change the pay pattern/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('How often'), { target: { value: 'WEEKLY' } });
    await user.click(within(dialog).getByRole('button', { name: 'Schedule the change' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/The next one starts Nov 7/);
    await user.click(within(dialog).getByRole('button', { name: /Start .*Nov 7 instead/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Schedule the change' }));
    await waitFor(() => expect(api.updatePaySchedule).toHaveBeenLastCalledWith('s1', { frequency: 'WEEKLY', payDateOffsetDays: 7, effectiveFrom: suggestedDate('starts Nov 7.') }));
  });

  it('a pattern whose periods don’t line up shows the short bridge period before it is saved', async () => {
    const user = userEvent.setup();
    api.getPayCalendar.mockResolvedValue({ periods: [period({ periodStart: '2099-11-07' })] });
    api.previewPattern.mockResolvedValue({
      periods: [period({ periodStart: '2099-11-07', periodEnd: '2099-11-15', payDate: '2099-11-20', bridge: true, versionChange: true }), period({ periodStart: '2099-11-16', periodEnd: '2099-11-30', payDate: '2099-12-04' })],
    });
    open();
    await screen.findByRole('heading', { name: 'Biweekly Hourly' });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Change the pay pattern/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('How often'), { target: { value: 'SEMIMONTHLY' } });
    expect(await within(dialog).findByText(/one short period, .*paid .*joins the two/)).toBeInTheDocument();
    expect(api.previewPattern).toHaveBeenLastCalledWith(expect.objectContaining({ frequency: 'SEMIMONTHLY', scheduleId: 's1', effectiveFrom: '2099-11-07' }));
  });
});

describe('suggestedDate', () => {
  it('reads the next such day from the API’s refusal', () => {
    expect(suggestedDate('Oct 25 isn’t the start of a pay period on this schedule. The next one starts Nov 14.', '2026-10-19')).toBe('2026-11-14');
    expect(suggestedDate('…The first date both patterns start a period is Jan 2.', '2026-12-20')).toBe('2027-01-02');
    expect(suggestedDate('A pattern change starts at a future pay period: say which.', '2026-10-19')).toBeNull();
  });
});

describe('estimateChangeDate', () => {
  const p = (periodStart: string, periodEnd: string) => period({ periodStart, periodEnd });
  it('steps a week-based schedule forward from the next payday’s period, which may be over', () => {
    expect(estimateChangeDate({ frequency: 'WEEKLY', nextPeriod: p('2026-10-10', '2026-10-16') }, '2026-10-19')).toBe('2026-10-24');
    expect(estimateChangeDate({ frequency: 'BIWEEKLY', nextPeriod: p('2026-10-10', '2026-10-23') }, '2026-10-19')).toBe('2026-10-24');
    expect(estimateChangeDate({ frequency: 'WEEKLY', nextPeriod: p('2026-10-24', '2026-10-30') }, '2026-10-19')).toBe('2026-10-24');
  });
  it('lands on the 1st or 16th for calendar-based schedules', () => {
    expect(estimateChangeDate({ frequency: 'SEMIMONTHLY', nextPeriod: p('2026-10-01', '2026-10-15') }, '2026-10-19')).toBe('2026-11-01');
    expect(estimateChangeDate({ frequency: 'SEMIMONTHLY', nextPeriod: p('2026-09-16', '2026-09-30') }, '2026-10-12')).toBe('2026-10-16');
    expect(estimateChangeDate({ frequency: 'MONTHLY', nextPeriod: p('2026-09-01', '2026-09-30') }, '2026-10-19')).toBe('2026-11-01');
  });
});
