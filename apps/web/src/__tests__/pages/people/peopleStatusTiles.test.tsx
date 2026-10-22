import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * The People directory in the one status vocabulary (F500 SH-4): its tiles
 * are exact counts for the whole filtered population from
 * /people/directory/summary — the numbers Headcount shows — and each tile and
 * chip is the filter. It used to count only the loaded page ("Active 0+ /
 * Inactive 21+").
 */

const paths: string[] = [];
const SUMMARY = { ACTIVE: 1, PLACED_NOT_ACTIVE: 10, NOT_PLACED: 3, ONBOARDING: 1, DEACTIVATED: 8, SEPARATED: 0, onTheBooks: 22, total: 23, windowDays: 14 };
const ROW = {
  id: '00000000-0000-4000-8000-0000000000a1', firstName: 'Tomas', lastName: 'Ortiz', email: 't@example.com', phone: null, employmentType: 'W2_EMPLOYEE', j1Status: false,
  status: 'INACTIVE', workStatus: 'PLACED_NOT_ACTIVE', workplaceClientId: null, workplaceClientName: null, position: null, startDate: null, payAmount: null, payType: null, payCurrency: null,
  managerId: null, managerName: null, departmentId: null, departmentName: null, jobProfileId: null, jobProfileTitle: null, onboardingPercent: null, applicationId: null,
  createdAt: '2026-09-01T00:00:00.000Z', photoUrl: null, currentLocationId: null, currentLocationName: null, currentAssignmentStartedAt: null,
};
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string) => {
      paths.push(path);
      const base = path.split('?')[0];
      if (base === '/people/directory/summary') return SUMMARY;
      if (base === '/people/directory') return { associates: [ROW], nextCursor: null };
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { PeopleDirectory } from '@/pages/people/PeopleDirectory';

afterEach(() => {
  paths.length = 0;
  window.history.replaceState({}, '', '/');
  try {
    window.localStorage.clear();
  } catch {
    // storage may be unavailable
  }
});

describe('People directory — one status per person', () => {
  it('tiles count the whole population by the one status; a row says No recent shifts, not Inactive', async () => {
    renderAs('HR_ADMINISTRATOR', <PeopleDirectory />, '/people');
    const tile = (await screen.findByText('On the books', {}, { timeout: 5000 })).closest('[data-metric-card], div')!.parentElement!;
    await waitFor(() => expect(tile).toHaveTextContent('22'), { timeout: 5000 });
    expect(screen.getByText('Working (14 days)')).toBeInTheDocument();
    expect((await screen.findAllByText('No recent shifts', {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect(screen.queryByText('Inactive')).not.toBeInTheDocument();
    expect(paths.some((p) => p.startsWith('/people/directory/summary'))).toBe(true);
  });

  it('a chip is the filter: the list asks for that status', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <PeopleDirectory />, '/people');
    const chip = await screen.findByRole('button', { name: /^Paused/ }, { timeout: 5000 });
    await waitFor(() => expect(chip).toHaveTextContent('8'), { timeout: 5000 });
    await user.click(chip);
    await waitFor(() => expect(paths.some((p) => p.startsWith('/people/directory?') && p.includes('workStatus=DEACTIVATED'))).toBe(true), { timeout: 5000 });
  });
});
