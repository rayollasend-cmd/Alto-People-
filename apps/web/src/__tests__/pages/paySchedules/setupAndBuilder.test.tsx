import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderPage } from './render';
import { COASTAL, FACETS, THANKSGIVING, WEEKLY, candidate, detail, impact, period } from './fixtures';

const api = vi.hoisted(() => ({
  previewPattern: vi.fn(),
  listScheduleCandidates: vi.fn(),
  createPaySchedule: vi.fn(),
  previewMembership: vi.fn(),
  applyMembership: vi.fn(),
}));
vi.mock('@/lib/paySchedulesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/paySchedulesApi')>()), ...api }));

import { NewPaySchedulePage } from '@/pages/payroll/schedules/NewPaySchedulePage';
import { AddPeopleBuilder } from '@/pages/payroll/schedules/AddPeopleBuilder';

const ANA = candidate({ associateId: 'p1', name: 'Ana Ruiz' });
const BEN = candidate({ associateId: 'p2', name: 'Ben Cole', currentScheduleId: 's1', currentScheduleName: 'Biweekly Hourly' });
const CARA = candidate({ associateId: 'p3', name: 'Cara Diaz', status: 'NEW_HIRE' });

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.previewPattern.mockResolvedValue({ periods: [period({ periodStart: '2099-01-03', periodEnd: '2099-01-16', payDate: '2099-01-23' }), THANKSGIVING] });
  api.listScheduleCandidates.mockImplementation(async (f: { cursor?: string }) =>
    f.cursor === 'c2'
      ? { people: [CARA], total: 3, nextCursor: null, facets: FACETS }
      : { people: [ANA, BEN], total: 3, nextCursor: 'c2', facets: FACETS },
  );
});

describe('<NewPaySchedulePage>', () => {
  it('walks pattern → calendar (with the holiday move) → who → review, and creates with the people and the default', async () => {
    const user = userEvent.setup();
    api.createPaySchedule.mockResolvedValue({ schedule: detail({ id: 'new1', name: 'Biweekly' }) });
    renderPage(<NewPaySchedulePage />, '/payroll/schedules/new');
    // Biweekly, paid the Friday after, is the starting point.
    expect(await screen.findByRole('radiogroup', { name: 'How often' })).toBeInTheDocument();
    expect(screen.getByText(/In plain words/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Thanksgiving Day on .* — paid .* instead/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    // Who's on it: everyone at Coastal, and the company default.
    await user.click(await screen.findByRole('button', { name: /Everyone at Coastal Resort/ }));
    await user.click(screen.getByRole('checkbox', { name: /Make this the company default/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Everyone at Coastal Resort')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create schedule/ }));
    await waitFor(() => expect(api.createPaySchedule).toHaveBeenCalledTimes(1));
    const body = api.createPaySchedule.mock.calls[0][0];
    expect(body).toMatchObject({ frequency: 'BIWEEKLY', payDateOffsetDays: 7, isDefault: true, notes: null });
    expect(body.name).toMatch(/Biweekly/);
    expect(body.membership).toEqual({ add: [{ kind: 'CLIENT', clientId: COASTAL }], endRuleIds: [], effectiveFrom: '2099-01-03' });
    expect(await screen.findByText('Navigated away')).toBeInTheDocument();
  });
});

describe('<AddPeopleBuilder>', () => {
  const schedule = { id: WEEKLY.id, name: WEEKLY.name, nextPeriodStart: '2099-10-24', nextPayDate: '2099-11-05' };

  it('chooses a whole client, selects all matching across pages, leaves one out, sets the date, previews live and applies', async () => {
    const user = userEvent.setup();
    api.previewMembership.mockResolvedValue(impact({ joins: 4, newHires: 1, movingFrom: [{ scheduleId: 's1', name: 'Biweekly Hourly', count: 1 }] }));
    api.applyMembership.mockResolvedValue({ impact: impact({ joins: 4, effectiveFrom: '2099-11-07' }) });
    const onOpenChange = vi.fn();
    renderPage(<AddPeopleBuilder open onOpenChange={onOpenChange} schedule={schedule} />, '/payroll/schedules/s2');

    expect(await screen.findByText('Choose who joins.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Everyone at Harbor Inn/ }));
    expect(await screen.findByText('3 matching')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Select all 3 matching' }));
    await waitFor(() => expect(api.listScheduleCandidates).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'c2' })));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Add Ben Cole' })).toBeChecked());
    expect(screen.getByText(/on Biweekly Hourly/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave out Ben Cole' }));
    expect(screen.getByRole('checkbox', { name: 'Add Ben Cole' })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('First day on this schedule'), { target: { value: '2099-11-07' } });

    const expected = {
      add: [
        { kind: 'CLIENT', clientId: 'c0000000-0000-4000-8000-000000000002' },
        { kind: 'INDIVIDUAL', associateId: 'p1' },
        { kind: 'INDIVIDUAL', associateId: 'p3' },
        { kind: 'EXCLUDE', associateId: 'p2' },
      ],
      endRuleIds: [],
      effectiveFrom: '2099-11-07',
    };
    await waitFor(() => expect(api.previewMembership).toHaveBeenLastCalledWith('s2', expected));
    expect(await screen.findByText('4 people join · 1 from Biweekly Hourly · 1 new hire')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Review 4 changes/ }));
    await user.click(await screen.findByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(api.applyMembership).toHaveBeenCalledWith('s2', expected));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
