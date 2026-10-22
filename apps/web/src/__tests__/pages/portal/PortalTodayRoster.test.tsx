import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ymdLocal } from '@/lib/format';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { PortalToday } from '@/pages/portal/PortalToday';

/**
 * The Today roster on a phone (role walk floor 20): a row per person with
 * their name, what they're doing now, and call/text — not a face wall with
 * "tap a face for the name". The shift's one text to everyone sits in its
 * header, and the date is said once in the date row, not three times.
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();
const row = (id: string, name: string, state: string, over: Record<string, unknown> = {}) => ({
  shiftId: id,
  associateId: `a-${id}`,
  name,
  position: 'Stocker',
  isLead: false,
  clockInAt: state === 'on-floor' ? at(-50) : null,
  clockOutAt: null,
  startsAt: at(-62),
  endsAt: at(6 * 60),
  timezone: tz,
  locationId: 'l1',
  locationName: 'Front Beach 218',
  phone: '+13055550101',
  messageUserId: null,
  state,
  ...over,
});

function renderToday(role: Role) {
  const today = ymdLocal();
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/me/shift-windows') return { windows: [] };
    return {
      client: { id: 'c1', name: 'Coastal' },
      store: { id: 'l1', name: 'Front Beach 218', timezone: tz },
      date: today,
      today,
      generatedAt: new Date().toISOString(),
      target: 3,
      roster: [row('s1', 'Ann Lee', 'on-floor'), row('s2', 'Cy Dale', 'not-in')],
      onFloorNow: [{ associateId: 'a-s1', name: 'Ann Lee', clockInAt: at(-50), position: 'Stocker' }],
      summary: { expected: 2, worked: 0, onFloor: 1, missed: 0, open: 0 },
      windowLeads: [],
    };
  });
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'dana@example.com', role, status: 'ACTIVE', clientId: 'c1', associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter initialEntries={['/today']}>
          <PortalToday />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<PortalToday> — the roster on a phone', () => {
  it('the shift supervisor reads names and status, with call and text on each row', async () => {
    renderToday('SHIFT_SUPERVISOR');
    const rows = await screen.findByTestId('roster-rows');
    // Phone-only list; the face wall takes over from sm.
    expect(rows.className).toContain('sm:hidden');
    const items = within(rows).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Ann Lee')).toBeInTheDocument();
    expect(within(items[0]!).getByText(/^In /)).toBeInTheDocument();
    expect(within(items[1]!).getByText('Cy Dale')).toBeInTheDocument();
    expect(within(items[1]!).getByText(/^Late 1h 2m$|^Late 1h 1m$/)).toBeInTheDocument();
    expect(within(items[1]!).getByRole('link', { name: 'Call Cy Dale' })).toHaveAttribute('href', 'tel:+13055550101');
    expect(within(items[1]!).getByRole('link', { name: 'Text Cy Dale' })).toHaveAttribute('href', 'sms:+13055550101');
  });

  it('one text to the whole shift sits in the shift’s header', async () => {
    renderToday('SHIFT_SUPERVISOR');
    const button = await screen.findByRole('button', { name: 'Text this shift (2)' });
    await userEvent.click(button);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Text the crew');
  });

  it('the store manager’s portal reads punch times only — no "late" label, no phone numbers', async () => {
    renderToday('CLIENT_PORTAL');
    const rows = await screen.findByTestId('roster-rows');
    expect(within(rows).queryByText(/^Late/)).not.toBeInTheDocument();
    expect(within(rows).getByText('Not in yet')).toBeInTheDocument();
    expect(within(rows).queryByRole('link', { name: /^Call / })).not.toBeInTheDocument();
  });

  it('the subtitle names the store without repeating the date', async () => {
    renderToday('SHIFT_SUPERVISOR');
    expect(await screen.findByText(/^Front Beach 218 · /)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`Front Beach 218 · ${new Date().getDate()}`))).not.toBeInTheDocument();
  });
});
