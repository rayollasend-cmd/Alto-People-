import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { J1ListResponse, J1Profile } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * The J-1 tab, cleared to work (owner, 2026-11-03): opens on the current
 * workforce, the last program day reads "Last day" (it read −1), a shift
 * booked or a punch after the end is flagged, and the tiles are filters.
 */

vi.mock('@/lib/complianceApi', () => ({ listJ1Profiles: vi.fn(), upsertJ1: vi.fn() }));
import { listJ1Profiles } from '@/lib/complianceApi';
import { J1Tab, daysLeftWords } from '@/pages/compliance/J1Tab';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHIFT = { id: ID(90), startsAt: '2026-11-05T15:00:00.000Z', endsAt: '2026-11-05T23:00:00.000Z', timezone: 'America/New_York', position: 'Cook', place: 'North Store' };

function profile(n: number, name: string, over: Partial<J1Profile>): J1Profile {
  return {
    id: ID(100 + n),
    associateId: ID(n),
    associateName: name,
    associateEmail: `${n}@example.com`,
    associatePhotoUrl: null,
    programStartDate: '2026-05-01',
    programEndDate: '2026-12-31',
    ds2019Number: `N${n}`,
    sponsorAgency: 'Sponsor',
    visaNumber: null,
    sevisId: null,
    country: 'Peru',
    daysUntilEnd: 57,
    workStatus: 'ACTIVE',
    programEndSource: 'profile',
    ds2019ExpiresOn: null,
    graceEndsOn: '2027-01-30',
    nextShift: null,
    scheduledAfterEnd: null,
    workedAfterEndOn: null,
    ...over,
  };
}

const DATA: J1ListResponse = {
  workforce: 'current',
  workforceCounts: { current: 3, starting: 0, paused: 1, former: 5, all: 9 },
  truncated: false,
  profiles: [
    profile(1, 'Lia Lastday', { programEndDate: '2026-11-04', daysUntilEnd: 0, nextShift: SHIFT, scheduledAfterEnd: SHIFT }),
    profile(2, 'Wes Worked', { programEndDate: '2026-10-28', daysUntilEnd: -7, workedAfterEndOn: '2026-11-02' }),
    profile(3, 'Ola Ongoing', {}),
  ],
};

beforeEach(() => {
  vi.mocked(listJ1Profiles).mockReset();
  vi.mocked(listJ1Profiles).mockResolvedValue(DATA);
  window.localStorage.clear();
});

describe('<J1Tab>', () => {
  it('opens on the current workforce, reads the last day as "Last day", and flags shifts and punches after the end', async () => {
    renderAs('HR_ADMINISTRATOR', <J1Tab canManage />, '/compliance?tab=j1');
    await waitFor(() => expect(listJ1Profiles).toHaveBeenCalledWith({ workforce: 'current' }));
    expect((await screen.findAllByText('Last day')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ended 7d ago').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Scheduled after program end').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Worked after program end').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('compliance-workforce')).getByRole('button', { name: /Former/ })).toHaveTextContent('5');
  });

  it('the "Scheduled after end" tile filters the list to those people', async () => {
    renderAs('HR_ADMINISTRATOR', <J1Tab canManage />, '/compliance?tab=j1');
    await screen.findAllByText('Ola Ongoing');
    await userEvent.click(screen.getByRole('button', { name: /Scheduled after end/ }));
    await waitFor(() => expect(screen.queryAllByText('Ola Ongoing')).toHaveLength(0));
    expect(screen.getAllByText('Lia Lastday').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Wes Worked')).toHaveLength(0);
  });

  it('a link to one person opens on All', async () => {
    renderAs('HR_ADMINISTRATOR', <J1Tab canManage />, `/compliance?tab=j1&associateId=${ID(2)}`);
    await waitFor(() => expect(listJ1Profiles).toHaveBeenCalledWith({ workforce: 'all' }));
  });
});

describe('daysLeftWords', () => {
  it('counts the last program day as the last day, not −1', () => {
    expect(daysLeftWords(0)).toBe('Last day');
    expect(daysLeftWords(1)).toBe('1d left');
    expect(daysLeftWords(-1)).toBe('Ended 1d ago');
  });
});
