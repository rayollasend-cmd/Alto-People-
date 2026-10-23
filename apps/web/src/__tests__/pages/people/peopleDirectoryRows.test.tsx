import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';

/**
 * The People list as HR reads it (F500 fix-up, G1):
 *   - a row is "who, where they stand, where they work, when they last
 *     worked, their hours in the window, how to reach them" — position,
 *     type, pay, manager and start are in Columns;
 *   - pay is a column only for a login the API sends pay to;
 *   - a row opens the person's record — one home — and the old drawer
 *     links (/people?associateId=…&tab=…) land there on the right tab;
 *   - Invite is the one header action; Mass update lives in the bulk bar
 *     and Export in the grid's toolbar, exporting every match;
 *   - on a phone the six statuses are one row of chips, not six tiles.
 */

const paths: string[] = [];
const SUMMARY = { ACTIVE: 1, PLACED_NOT_ACTIVE: 1, NOT_PLACED: 0, ONBOARDING: 0, DEACTIVATED: 0, SEPARATED: 0, onTheBooks: 2, total: 2, windowDays: 14 };
const base = {
  email: 'x@example.com', phone: null, employmentType: 'W2_EMPLOYEE', j1Status: false, position: 'Front-of-house associate', startDate: '2026-03-02',
  managerId: null, managerName: null, departmentId: null, departmentName: null, jobProfileId: null, jobProfileTitle: null, onboardingPercent: null, applicationId: null,
  createdAt: '2026-09-01T00:00:00.000Z', photoUrl: null, currentAssignmentStartedAt: null,
};
const ANA = {
  ...base, id: '00000000-0000-4000-8000-0000000000a1', firstName: 'Ana', lastName: 'Reyes', email: 'ana@example.com', phone: '850-555-0142',
  status: 'ACTIVE', workStatus: 'ACTIVE', workplaceClientId: '00000000-0000-4000-8000-0000000000c1', workplaceClientName: 'Coastal Resort Holdings',
  currentLocationId: '00000000-0000-4000-8000-0000000000d1', currentLocationName: 'Front Beach 218',
  lastWorkedAt: '2026-10-20T13:00:00.000Z', recentMinutes: 690,
  payAmount: '18.50', payType: 'HOURLY', payCurrency: 'USD',
};
const TOMAS = {
  ...base, id: '00000000-0000-4000-8000-0000000000b2', firstName: 'Tomas', lastName: 'Ortiz',
  status: 'INACTIVE', workStatus: 'PLACED_NOT_ACTIVE', workplaceClientId: null, workplaceClientName: null, currentLocationId: null, currentLocationName: null,
  lastWorkedAt: null, recentMinutes: 0,
  payAmount: null, payType: null, payCurrency: null,
};
let withPay = true;
const strip = (r: Record<string, unknown>) => {
  if (withPay) return r;
  const { payAmount: _a, payType: _t, payCurrency: _c, ...rest } = r;
  return rest;
};

vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string) => {
      paths.push(path);
      const p = path.split('?')[0];
      if (p === '/people/directory/summary') return SUMMARY;
      if (p === '/people/directory') return { associates: [strip(ANA), strip(TOMAS)], nextCursor: null };
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { PeopleDirectory } from '@/pages/people/PeopleDirectory';

let here = '';
function Probe() {
  const loc = useLocation();
  here = `${loc.pathname}${loc.search}`;
  return <div>record page</div>;
}
const routes = (
  <Routes>
    <Route path="/people" element={<PeopleDirectory />} />
    <Route path="/people/:associateId" element={<Probe />} />
  </Routes>
);

afterEach(() => {
  paths.length = 0;
  here = '';
  withPay = true;
  window.history.replaceState({}, '', '/');
  try {
    window.localStorage.clear();
  } catch {
    // storage may be unavailable
  }
});

describe('People list rows', () => {
  it('shows status, client · store, last shift, hours in the window and phone by default; the rest are in Columns', async () => {
    renderAs('HR_ADMINISTRATOR', routes, '/people');
    const table = await screen.findByRole('table', {}, { timeout: 5000 });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim()).filter(Boolean);
    expect(headers).toEqual(['Associate', 'Status', 'Client · Store', 'Last shift', 'Hours (14 days)', 'Phone']);
    const ana = within(table).getByText('Ana Reyes').closest('tr')!;
    expect(ana).toHaveTextContent('Coastal Resort Holdings');
    expect(ana).toHaveTextContent('Front Beach 218');
    expect(ana).toHaveTextContent('Oct 20, 2026');
    expect(ana).toHaveTextContent('11.5h');
    expect(ana).toHaveTextContent('(850) 555-0142');
    const tomas = within(table).getByText('Tomas Ortiz').closest('tr')!;
    expect(tomas).toHaveTextContent('Never');
    expect(tomas).toHaveTextContent('0h');
    // Pay is a hidden column for a login that reads pay.
    await userEvent.click(screen.getByRole('button', { name: /choose columns/i }));
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Pay rate' })).not.toBeChecked();
  });

  it('a phone and an email copy from the row, as on the retired Directory, without opening the record', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAs('HR_ADMINISTRATOR', routes, '/people');
    const table = await screen.findByRole('table', {}, { timeout: 5000 });
    const ana = within(table).getByText('Ana Reyes').closest('tr')!;
    expect(within(ana).getByRole('link', { name: 'ana@example.com' })).toHaveAttribute('href', 'mailto:ana@example.com');
    await userEvent.click(within(ana).getByRole('button', { name: 'Copy ana@example.com' }));
    await userEvent.click(within(ana).getByRole('button', { name: 'Copy (850) 555-0142' }));
    expect(writeText.mock.calls).toEqual([['ana@example.com'], ['(850) 555-0142']]);
    expect(here).toBe('');
  });

  it('no pay column at all for a login the API sends no pay to', async () => {
    withPay = false;
    renderAs('INTERNAL_RECRUITER', routes, '/people');
    await screen.findByRole('table', {}, { timeout: 5000 });
    await userEvent.click(screen.getByRole('button', { name: /choose columns/i }));
    await screen.findByRole('menuitemcheckbox', { name: 'Position' });
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Pay rate' })).toBeNull();
  });

  it('a row opens the person’s record', async () => {
    renderAs('HR_ADMINISTRATOR', routes, '/people');
    const table = await screen.findByRole('table', {}, { timeout: 5000 });
    await userEvent.click(within(table).getByText('Front Beach 218'));
    await waitFor(() => expect(here).toBe(`/people/${ANA.id}`));
  });

  it('the old drawer links land on the record, on the tab they asked for', async () => {
    renderAs('HR_ADMINISTRATOR', routes, `/people?associateId=${ANA.id}&tab=compensation`);
    await waitFor(() => expect(here).toBe(`/people/${ANA.id}?tab=pay`));
  });

  it('a drawer link with no tab opens the record on its default tab', async () => {
    renderAs('HR_ADMINISTRATOR', routes, `/people?associateId=${ANA.id}&return=%2Fpayroll`);
    await waitFor(() => expect(here).toBe(`/people/${ANA.id}`));
  });

  it('Invite is the one header action; Export is the grid’s and exports every match', async () => {
    renderAs('HR_ADMINISTRATOR', routes, '/people');
    await screen.findByRole('table', {}, { timeout: 5000 });
    const header = screen.getByTestId('page-actions');
    expect(within(header).getByRole('link', { name: /Invite associates/ })).toHaveAttribute('href', '/onboarding');
    expect(within(header).queryByRole('link', { name: 'Mass update' })).toBeNull();
    expect(within(header).queryByRole('button', { name: /Export/ })).toBeNull();
    // The sibling roster is a link, not a button.
    expect(screen.getByRole('link', { name: 'Workforce roster' })).toHaveAttribute('href', '/workers?type=PERSON');
    // The grid's Export walks every page of the filtered list.
    const before = paths.filter((p) => p.startsWith('/people/directory?') || p === '/people/directory').length;
    const csv = vi.spyOn(await import('@/lib/csv'), 'downloadCsv').mockImplementation(() => undefined);
    await userEvent.click(screen.getByRole('button', { name: /Export .* as CSV/ }));
    await waitFor(() => expect(csv).toHaveBeenCalled());
    expect(paths.filter((p) => p.startsWith('/people/directory?') || p === '/people/directory').length).toBeGreaterThan(before);
    const rows = csv.mock.calls[0]![1] as string[][];
    expect(rows[0]).toEqual(['Name', 'Status', 'Email', 'Phone', 'Client', 'Store', 'Last shift', 'Hours (14 days)', 'Type', 'Pay rate', 'Start date']);
    expect(rows[1]).toEqual(['Ana Reyes', 'Working', 'ana@example.com', '850-555-0142', 'Coastal Resort Holdings', 'Front Beach 218', '2026-10-20', '11.5', 'W-2', '$18.50/hr', '2026-03-02']);
    csv.mockRestore();
  });

  it('on a phone the six statuses are one row of chips (each the filter), not six tiles', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    try {
      const user = userEvent.setup();
      renderAs('HR_ADMINISTRATOR', routes, '/people');
      const chips = await screen.findByTestId('people-status-chips', {}, { timeout: 5000 });
      await waitFor(() => expect(within(chips).getByRole('button', { name: /^All/ })).toHaveTextContent('2'));
      expect(document.querySelector('[data-metric-strip]')).toBeNull();
      await user.click(within(chips).getByRole('button', { name: /^No recent shifts/ }));
      await waitFor(() => expect(paths.some((p) => p.startsWith('/people/directory?') && p.includes('workStatus=PLACED_NOT_ACTIVE'))).toBe(true));
    } finally {
      window.matchMedia = original;
    }
  });
});
