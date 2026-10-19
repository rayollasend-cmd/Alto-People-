import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderPage } from './render';
import { BIWEEKLY, COASTAL, FACETS, MARIA, THANKSGIVING, WEEKLY, candidate, impact, summary } from './fixtures';

const api = vi.hoisted(() => ({
  listPaySchedules: vi.fn(),
  listUnassigned: vi.fn(),
  updatePaySchedule: vi.fn(),
  getPayCalendar: vi.fn(),
  previewMove: vi.fn(),
  applyMove: vi.fn(),
  getPayScheduleRoster: vi.fn(),
  listScheduleCandidates: vi.fn(),
  previewMembership: vi.fn(),
  applyMembership: vi.fn(),
}));
vi.mock('@/lib/paySchedulesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/paySchedulesApi')>()), ...api }));

import { PaySchedulesPage } from '@/pages/payroll/schedules/PaySchedulesPage';

const UNASSIGNED = [candidate({ associateId: 'u1', name: 'Ana Ruiz', status: 'NEW_HIRE' }), candidate({ associateId: 'u2', name: 'Ben Cole' })];

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  localStorage.clear();
  api.getPayCalendar.mockResolvedValue({ periods: [] });
  api.listPaySchedules.mockResolvedValue({
    schedules: [summary({ ...BIWEEKLY, nextPeriod: THANKSGIVING }), WEEKLY, summary({ id: 's3', name: 'Old monthly', isActive: false })],
    unassigned: 2,
  });
  api.listUnassigned.mockResolvedValue({ people: UNASSIGNED, total: 2 });
  api.listScheduleCandidates.mockResolvedValue({ people: [], total: 0, nextCursor: null, facets: FACETS });
  api.previewMembership.mockResolvedValue(impact({ joins: 2, newHires: 1 }));
});

describe('<PaySchedulesPage>', () => {
  it('lists every schedule with its payday, holiday move, people and readiness', async () => {
    renderPage(<PaySchedulesPage />, '/payroll/schedules');
    expect(await screen.findByRole('heading', { name: 'Pay schedules' })).toBeInTheDocument();
    const grid = await screen.findByRole('table');
    expect(within(grid).getAllByText('Biweekly Hourly').length).toBeGreaterThan(0);
    expect(within(grid).getAllByText('Weekly').length).toBeGreaterThan(0);
    expect(within(grid).getAllByText(/Thanksgiving Day/).length).toBeGreaterThan(0);
    expect(within(grid).getAllByText(/Inactive/).length).toBeGreaterThan(0);
    // Two active schedules; the inactive one is counted apart.
    expect(screen.getByText('1 inactive')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /New schedule/ })).toHaveAttribute('href', '/payroll/schedules/new');
  });

  it('pins the people on no schedule on top, and makes a schedule the default after a confirm', async () => {
    const user = userEvent.setup();
    api.updatePaySchedule.mockResolvedValue({ schedule: { ...BIWEEKLY, isDefault: true, rules: [], versions: [] } });
    renderPage(<PaySchedulesPage />, '/payroll/schedules');
    expect(await screen.findByText(/2 people are on no pay schedule/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Make one the default/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Biweekly Hourly/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Make Biweekly Hourly the company default\?/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(api.updatePaySchedule).toHaveBeenCalledWith('s1', { isDefault: true }));
  });

  it('“Add them to…” opens the builder with the unassigned people already chosen and previews the effect', async () => {
    const user = userEvent.setup();
    renderPage(<PaySchedulesPage />, '/payroll/schedules');
    await screen.findByText(/2 people are on no pay schedule/);
    await user.click(screen.getByRole('button', { name: /Add them to/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Weekly/ }));
    expect(await screen.findByText('Add people to Weekly')).toBeInTheDocument();
    await waitFor(() =>
      expect(api.previewMembership).toHaveBeenCalledWith('s2', {
        add: [
          { kind: 'INDIVIDUAL', associateId: 'u1' },
          { kind: 'INDIVIDUAL', associateId: 'u2' },
        ],
        endRuleIds: [],
        effectiveFrom: '2099-10-24',
      }),
    );
    expect((await screen.findAllByText(/2 people join · 1 new hire/)).length).toBeGreaterThan(0);
  });

  it('opens on the people no schedule covers when the inbox links with ?view=unassigned', async () => {
    renderPage(<PaySchedulesPage />, '/payroll/schedules?view=unassigned', '/payroll/schedules');
    const bucket = await screen.findByRole('list', { name: 'On no pay schedule' });
    expect(within(bucket).getByRole('link', { name: /Ana Ruiz/ })).toHaveAttribute('href', '/people/u1');
    expect(within(bucket).getByText('New hire')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide names' })).toHaveAttribute('aria-expanded', 'true');
  });

  describe('the board', () => {
    beforeEach(() => {
      api.getPayScheduleRoster.mockImplementation(async (id: string) =>
        id === 's1'
          ? { groups: [{ clientId: COASTAL, clientName: 'Coastal Resort', people: [MARIA], counts: { total: 1, ready: 1, attention: 0, blocked: 0 } }], totals: { total: 1, ready: 1, attention: 0, blocked: 0 } }
          : { groups: [], totals: { total: 0, ready: 0, attention: 0, blocked: 0 } },
      );
      api.previewMove.mockResolvedValue(impact({ joins: 1 }));
      api.applyMove.mockResolvedValue({ impact: impact({ joins: 1 }) });
    });

    it('moves a whole client group with the keyboard “Move to…” menu: preview, then apply', async () => {
      const user = userEvent.setup();
      renderPage(<PaySchedulesPage />, '/payroll/schedules');
      await user.click(await screen.findByRole('button', { name: 'Board' }));
      await user.click(await screen.findByRole('button', { name: 'Move Coastal Resort to another schedule' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Weekly' }));
      expect(await screen.findByText('Move everyone at Coastal Resort to Weekly')).toBeInTheDocument();
      const body = { toScheduleId: 's2', fromScheduleId: 's1', associateIds: [], clientIds: [COASTAL], effectiveFrom: '2099-10-24' };
      await waitFor(() => expect(api.previewMove).toHaveBeenCalledWith(body));
      await user.click(await screen.findByRole('button', { name: /Move 1/ }));
      await waitFor(() => expect(api.applyMove).toHaveBeenCalledWith(body));
    });

    it('a person dropped on another column opens the same preview', async () => {
      const user = userEvent.setup();
      renderPage(<PaySchedulesPage />, '/payroll/schedules');
      await user.click(await screen.findByRole('button', { name: 'Board' }));
      const payload = JSON.stringify({ kind: 'person', associateId: 'a1', name: 'Maria Lopez', fromScheduleId: 's1' });
      const column = await screen.findByRole('listitem', { name: 'Weekly' });
      fireEvent.drop(column, { dataTransfer: { getData: () => payload } });
      expect(await screen.findByText('Move Maria Lopez to Weekly')).toBeInTheDocument();
      await waitFor(() => expect(api.previewMove).toHaveBeenCalledWith(expect.objectContaining({ associateIds: ['a1'], toScheduleId: 's2' })));
    });
  });
});
