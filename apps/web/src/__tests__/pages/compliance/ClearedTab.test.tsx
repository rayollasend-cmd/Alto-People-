import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClearedListResponse, ClearedRow } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * The Cleared to work tab (owner, 2026-11-03): opens on the current
 * workforce, one row per person with each check in words, the exceptions
 * queue with blockers and shifts booked past them first, the Inbox's
 * ?status=scheduled link landing on exactly those people, and the overrides.
 */

vi.mock('@/lib/clearedToWorkApi', () => ({ listCleared: vi.fn() }));
import { listCleared } from '@/lib/clearedToWorkApi';
import { ClearedTab, cellWords } from '@/pages/compliance/ClearedTab';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cell = (state: ClearedRow['i9']['state'], date: string | null = null) => ({ state, date });

function row(n: number, name: string, over: Partial<ClearedRow>): ClearedRow {
  return {
    associateId: ID(n),
    associateName: name,
    associateEmail: `${name.toLowerCase().replace(' ', '.')}@example.com`,
    associatePhotoUrl: null,
    workStatus: 'ACTIVE',
    standing: 'CLEARED',
    i9: cell('done', '2026-10-01'),
    everify: cell('done', '2026-10-02'),
    workAuth: cell('not_required'),
    j1: cell('not_required'),
    background: cell('not_required'),
    drugTest: cell('not_required'),
    blockers: [],
    warnings: [],
    upcoming: [],
    nextShift: null,
    scheduledAfterBlock: [],
    ...over,
  };
}

const SHIFT = { id: ID(90), startsAt: '2026-11-10T15:00:00.000Z', endsAt: '2026-11-10T23:00:00.000Z', timezone: 'America/New_York', position: 'Cook', place: 'North Store' };
const FIX = `/compliance?tab=i9&associateId=${ID(2)}&return=%2Fcompliance%3Ftab%3Dcleared`;

const DATA: ClearedListResponse = {
  asOf: '2026-11-04',
  workforce: 'current',
  workforceCounts: { current: 3, starting: 1, paused: 2, former: 4, all: 10 },
  rows: [
    row(1, 'Cleo Clear', {}),
    row(2, 'Ned Ended', {
      standing: 'NOT_CLEARED',
      workAuth: cell('ended', '2026-11-02'),
      blockers: [{ kind: 'WORK_AUTH_ENDED', endsOn: '2026-11-02', since: '2026-11-03', message: "Ned Ended's work authorization ended on Nov 2, 2026. Record the re-verification on the I-9 first.", fixLink: FIX }],
      nextShift: SHIFT,
      scheduledAfterBlock: [SHIFT],
    }),
    row(3, 'Ava Attention', {
      standing: 'NEEDS_ATTENTION',
      workAuth: cell('ending', '2026-11-20'),
      warnings: [{ kind: 'WORK_AUTH_ENDING', dueBy: '2026-11-20', message: "Ava Attention's work authorization ends on Nov 20, 2026.", fixLink: FIX }],
    }),
  ],
  exceptions: [
    { associateId: ID(2), associateName: 'Ned Ended', severity: 'blocker', kind: 'WORK_AUTH_ENDED', date: '2026-11-02', message: "Ned Ended's work authorization ended on Nov 2, 2026. Record the re-verification on the I-9 first.", fixLink: FIX, shift: null },
    { associateId: ID(2), associateName: 'Ned Ended', severity: 'scheduled', kind: 'SCHEDULED_AFTER_BLOCK', date: '2026-11-10', message: 'Ned Ended is scheduled Tue, Nov 10 (Cook at North Store), but their work authorization ended on Nov 2, 2026.', fixLink: FIX, shift: SHIFT },
    { associateId: ID(3), associateName: 'Ava Attention', severity: 'warning', kind: 'WORK_AUTH_ENDING', date: '2026-11-20', message: "Ava Attention's work authorization ends on Nov 20, 2026.", fixLink: FIX, shift: null },
  ],
  overrides: [{ id: ID(80), at: '2026-11-01T15:00:00.000Z', actorName: 'Hana HR', associateId: ID(2), associateName: 'Ned Ended', shiftId: ID(91), blockerKind: 'WORK_AUTH_ENDED', reason: 'Receipt notice on file, auto-extended' }],
};

beforeEach(() => {
  vi.mocked(listCleared).mockReset();
  vi.mocked(listCleared).mockResolvedValue(DATA);
  window.localStorage.clear();
});

describe('<ClearedTab>', () => {
  it('opens on the current workforce: tiles, the exceptions queue blockers first with links, and the overrides', async () => {
    renderAs('HR_ADMINISTRATOR', <ClearedTab />, '/compliance?tab=cleared');
    await waitFor(() => expect(listCleared).toHaveBeenCalledWith({ workforce: 'current' }));
    const queue = await screen.findByTestId('cleared-exceptions');
    const items = within(queue).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Not cleared');
    expect(items[1]).toHaveTextContent('Booked past it');
    expect(items[2]).toHaveTextContent('Needs attention');
    expect(within(items[0]).getByRole('link', { name: 'Fix' })).toHaveAttribute('href', FIX);
    expect(within(items[1]).getByRole('link', { name: 'Open shift' })).toHaveAttribute('href', `/scheduling?shift=${SHIFT.id}`);
    // The tiles count the group's rows; each is a filter.
    expect(screen.getByRole('button', { name: /Not cleared/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Booked past their end/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /^Cleared\s*1$/ })).toBeInTheDocument();
    // The chips carry each group's count.
    expect(within(screen.getByTestId('compliance-workforce')).getByRole('button', { name: /Paused/ })).toHaveTextContent('2');
    expect(within(screen.getByTestId('cleared-overrides')).getByText(/Receipt notice on file/)).toBeInTheDocument();
  });

  it('the Inbox link (?workforce=current&status=scheduled) lands on exactly the people booked past their end', async () => {
    renderAs('HR_ADMINISTRATOR', <ClearedTab />, '/compliance?tab=cleared&workforce=current&status=scheduled');
    expect((await screen.findAllByText('Ned Ended')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryAllByText('Cleo Clear')).toHaveLength(0));
    expect(screen.queryAllByText('Ava Attention').filter((el) => el.closest('[data-testid="cleared-exceptions"]') === null)).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Booked past their end/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a group chip asks the server for that group', async () => {
    renderAs('HR_ADMINISTRATOR', <ClearedTab />, '/compliance?tab=cleared');
    await screen.findByTestId('cleared-exceptions');
    await userEvent.click(within(screen.getByTestId('compliance-workforce')).getByRole('button', { name: /Paused/ }));
    await waitFor(() => expect(listCleared).toHaveBeenCalledWith({ workforce: 'paused' }));
  });
});

describe('cellWords', () => {
  it('says each state in plain words', () => {
    expect(cellWords('i9', cell('late', '2026-10-29')).text).toMatch(/^Late, was due Oct 29, 2026$/);
    expect(cellWords('everify', cell('done', '2026-10-02')).text).toBe('Authorized');
    expect(cellWords('workAuth', cell('ended', '2026-11-02'))).toEqual({ text: 'Ended Nov 2, 2026', tone: 'destructive' });
    expect(cellWords('background', cell('missing'))).toEqual({ text: 'Missing', tone: 'destructive' });
    expect(cellWords('drugTest', cell('due', '2026-12-01')).text).toBe('Repeat by Dec 1, 2026');
    expect(cellWords('j1', cell('not_required'))).toEqual({ text: 'Not required', tone: null });
    expect(cellWords('everify', cell('blocked')).text).toBe('Final nonconfirmation');
  });
});
