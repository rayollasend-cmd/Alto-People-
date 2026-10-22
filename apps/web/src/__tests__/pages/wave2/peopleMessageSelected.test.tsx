import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * People → pick people → "Message selected" (HR walk, wave 2): the one
 * broadcast composer opens with the picked people as its list, and the
 * audience it counts is that list.
 */

const calls: Array<{ path: string; method: string; body?: unknown }> = [];
const entry = (id: string, firstName: string, lastName: string) => ({
  id,
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}@example.com`,
  phone: null,
  employmentType: 'W2_EMPLOYEE',
  j1Status: false,
  status: 'ACTIVE',
  workplaceClientId: null,
  workplaceClientName: null,
  position: null,
  startDate: null,
  payAmount: null,
  payType: null,
  payCurrency: null,
  managerId: null,
  managerName: null,
  departmentId: null,
  departmentName: null,
  jobProfileId: null,
  jobProfileTitle: null,
  onboardingPercent: null,
});
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body: init?.body });
      const p = path.split('?')[0];
      if (method === 'GET' && p === '/people/directory') {
        return { associates: [entry('00000000-0000-4000-8000-0000000000a1', 'Ana', 'Lopez'), entry('00000000-0000-4000-8000-0000000000b2', 'Ben', 'Ray')], nextCursor: null };
      }
      if (method === 'POST' && p === '/broadcasts/audience-count') return { people: 2, withAccount: 2, withPhone: 0, withEmail: 2 };
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { PeopleDirectory } from '@/pages/people/PeopleDirectory';

describe('Message selected', () => {
  it('opens the composer with the people picked', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <PeopleDirectory />, '/people');
    await screen.findAllByText(/Ana/);
    await user.click(await screen.findByRole('checkbox', { name: 'Select every row' }));
    await user.click(await screen.findByRole('button', { name: 'Message selected' }));
    expect(await screen.findByText('Message 2 people')).toBeInTheDocument();
    expect(screen.getByTestId('broadcast-recipients')).toHaveTextContent('Ana Lopez, Ben Ray');
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/broadcasts/audience-count' && JSON.stringify(c.body).includes('0000000000a1'))).toBe(true),
    );
  });
});
