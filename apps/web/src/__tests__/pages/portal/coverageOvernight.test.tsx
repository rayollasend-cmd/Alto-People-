import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { coverageByHour } from '@/pages/portal/coverage';
import { PortalSchedule } from '@/pages/portal/PortalSchedule';

/**
 * LEAD-3 (deep audit 2026-10-29): every 12a–6a cell of the client's
 * schedule heatmap read "0 scheduled · below the contract" with two
 * overnight stockers on, because each day was fed only the shifts that
 * START that day. An overnight counts in the hours it covers, both days.
 */

const NY = 'America/New_York';
const night = (state: 'confirmed' | 'open' = 'confirmed') => ({
  // Friday Oct 23, 10 PM → Saturday Oct 24, 6 AM, New York.
  startsAt: '2026-10-24T02:00:00.000Z',
  endsAt: '2026-10-24T10:00:00.000Z',
  timezone: NY,
  state,
});

describe('coverageByHour', () => {
  it('counts an overnight in the next day\'s first hours, and in its own day\'s last', () => {
    const sat = coverageByHour([night()], '2026-10-24', NY);
    expect(sat.slice(0, 6).map((p) => p.scheduled)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(sat[6]!.scheduled).toBe(0);
    const fri = coverageByHour([night()], '2026-10-23', NY);
    expect(fri[22]!.scheduled).toBe(1);
    expect(fri[23]!.scheduled).toBe(1);
    expect(fri[21]!.scheduled).toBe(0);
  });

  it('never counts a shift on a day it does not touch, however many days it is handed', () => {
    const tuesday = { startsAt: '2026-10-27T10:00:00.000Z', endsAt: '2026-10-27T18:00:00.000Z', timezone: NY, state: 'confirmed' as const };
    expect(coverageByHour([night(), tuesday], '2026-10-25', NY).every((p) => p.scheduled === 0)).toBe(true);
  });

  it('an unfilled overnight is unfilled in both days\' hours', () => {
    expect(coverageByHour([night('open')], '2026-10-24', NY)[3]).toMatchObject({ scheduled: 0, open: 1 });
  });
});

describe('/portal/schedule heatmap', () => {
  it('fills Saturday 12a–6a from last Friday\'s overnight (the carry-in) and Sunday\'s from Saturday night\'s', async () => {
    const days = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 9, 24 + i, 12)).toISOString().slice(0, 10));
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path.startsWith('/client-portal/schedule')) {
        return {
          client: { id: 'c1', name: 'Coastal' },
          store: { id: 'l1', name: 'Front Beach 218' },
          week: { start: days[0], end: days[6] },
          days: days.map((date, i) => ({
            date,
            // Saturday night's overnight: 10 PM Sat → 6 AM Sun.
            shifts: i === 0 ? [{ shiftId: 's1', associateId: 'a1', name: 'Ana', position: 'Stocker', startsAt: '2026-10-25T02:00:00.000Z', endsAt: '2026-10-25T10:00:00.000Z', timezone: NY, locationName: null, state: 'confirmed' }] : [],
          })),
          carryIn: [night('confirmed')].map((s) => ({ ...s, state: 'done' })),
          filled: 1,
          open: 0,
          targets: [{ locationId: 'l1', label: 'Overnight', startMinute: 1320, endMinute: 360, headcount: 1 }],
          generatedAt: new Date().toISOString(),
        } as never;
      }
      if (path.startsWith('/client-portal/overview')) return { now: { target: 1 }, store: { timezone: NY } } as never;
      throw new Error(`unexpected ${path}`);
    });
    const role = 'CLIENT_PORTAL' as const;
    const caps = ROLE_CAPABILITIES[role];
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: { id: 'u', email: 'sm@x.com', role, status: 'ACTIVE', clientId: 'c1', associateId: null } as never,
            role,
            capabilities: new Set<Capability>(caps),
            signIn: vi.fn(),
            signOut: vi.fn(),
            can: (c: Capability) => caps.has(c),
          }}
        >
          <MemoryRouter initialEntries={['/portal/schedule?week=2026-10-24']}>
            <PortalSchedule />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    // The cells name their counts: Saturday 3 AM and Sunday 3 AM are each covered by one person.
    const sat3 = await screen.findAllByRole('button', { name: /^Sat 3a · 1 scheduled/ });
    expect(sat3.length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^Sun 3a · 1 scheduled/ }).length).toBeGreaterThan(0);
    // And a night with nobody on reads 0 there.
    expect(screen.getAllByRole('button', { name: /^Mon 3a · 0 scheduled/ }).length).toBeGreaterThan(0);
  });
});
