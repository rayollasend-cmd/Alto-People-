import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { PortalSchedule, hourlyContract } from '@/pages/portal/PortalSchedule';

/**
 * /portal/schedule (F500 G5): titled "Schedule" like its siblings, Request
 * coverage leads the header, the week says scheduled against contracted
 * hours, and the stacked "This week" bars that repeated the heatmap are gone.
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const week = (start: string) =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${start}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

function renderPage() {
  const days = week('2026-10-17');
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/client-portal/schedule')) {
      return {
        client: { id: 'c1', name: 'Coastal' },
        store: { id: 'l1', name: 'Front Beach 218' },
        week: { start: days[0], end: days[6] },
        days: days.map((date, i) => ({
          date,
          shifts:
            i === 0
              ? [{ shiftId: 's1', associateId: 'a1', name: 'Ana', position: 'Stocker', startsAt: `${date}T13:00:00.000Z`, endsAt: `${date}T21:00:00.000Z`, timezone: tz, locationName: null, state: 'confirmed' }]
              : [],
        })),
        filled: 1,
        open: 0,
        targets: [{ locationId: 'l1', label: 'Morning', startMinute: 360, endMinute: 840, headcount: 8 }],
        generatedAt: new Date().toISOString(),
      } as never;
    }
    if (path.startsWith('/client-portal/overview')) return { now: { target: 8 }, store: { timezone: tz } } as never;
    throw new Error(`unexpected ${path}`);
  });
  const role = 'CLIENT_PORTAL' as const;
  const caps = ROLE_CAPABILITIES[role];
  return render(
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
        <MemoryRouter initialEntries={['/portal/schedule?week=2026-10-17']}>
          <PortalSchedule />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('/portal/schedule (F500 G5)', () => {
  it('is titled by page, leads with Make a request (one name for one action), and says scheduled against contracted hours', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Schedule' })).toBeInTheDocument();
    expect(await screen.findByText(/^Front Beach 218 · Week of /)).toBeInTheDocument();
    const req = screen.getByRole('link', { name: /Make a request/ });
    const params = new URLSearchParams(req.getAttribute('href')!.split('?')[1]);
    expect(params.get('new')).toBe('STAFFING');
    expect(params.get('subject')).toMatch(/^Coverage for the week of /);
    // 8h scheduled against 8 people × 8h × 7 days = 448h contracted.
    expect(screen.getByTestId('sched-summary')).toHaveTextContent('8h scheduled of 448h contracted');
    // The stacked "This week" chart that repeated the heatmap is gone.
    expect(screen.queryByRole('heading', { name: 'This week' })).not.toBeInTheDocument();
  });

  it('turns windows into the contracted headcount at each hour, across midnight too', () => {
    const byHour = hourlyContract([
      { locationId: 'l1', label: 'Morning', startMinute: 360, endMinute: 840, headcount: 8 },
      { locationId: 'l1', label: 'Overnight', startMinute: 1320, endMinute: 360, headcount: 3 },
    ]);
    expect(byHour[6]).toBe(8);
    expect(byHour[13]).toBe(8);
    expect(byHour[14]).toBe(0);
    expect(byHour[23]).toBe(3);
    expect(byHour[2]).toBe(3);
    expect(byHour[5]).toBe(3);
  });
});
