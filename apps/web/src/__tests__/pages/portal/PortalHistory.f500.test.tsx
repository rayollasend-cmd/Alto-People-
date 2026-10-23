import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { PortalHistory } from '@/pages/portal/PortalHistory';

/**
 * /portal/history (F500 G5): "delivered" is the grade's figure only (capped
 * at the contract each hour); the hours tile is "worked", and more worked
 * than scheduled is said as such — it read "444.1h of 56.5h scheduled"
 * with a full meter beside "509 of 4800 contracted person-hours delivered".
 */

function payload(totals: Record<string, unknown>) {
  return {
    client: { id: 'c1', name: 'Coastal' },
    store: { id: 'l1', name: 'Front Beach 218' },
    range: { from: '2026-09-01', to: '2026-09-30', days: 30 },
    generatedAt: new Date().toISOString(),
    days: [],
    totals: {
      published: 10, filled: 9, open: 1, ended: 10, showed: 8, fillPct: 90, reliabilityPct: 11, grade: 'F', basis: 'contract',
      contractedHours: 4800, deliveredHours: 509, showedUpPct: 80, scheduledHours: 56.5, workedHours: 444.1,
      ...totals,
    },
    incidents: { noCallNoShows: 0, callOuts: 0, lates: 0, replacementsFound: 0 },
    ops: null,
    safety: { incidents: 0, open: 0 },
    statements: [],
    serviceReports: [],
    stores: [],
  };
}

function renderPage(body: unknown) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/client-portal/history')) return body as never;
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
        <MemoryRouter initialEntries={['/portal/history?range=lastMonth']}>
          <PortalHistory />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('/portal/history (F500 G5)', () => {
  it('names worked hours as worked, and says the off-schedule hours in warning', async () => {
    renderPage(payload({ offScheduleHours: 387.6 }));
    expect(await screen.findByText('Hours worked · this period')).toBeInTheDocument();
    expect(screen.getByTestId('hist-off-schedule')).toHaveTextContent('444h worked · 57h scheduled · 388h off-schedule');
    expect(screen.getByTestId('hist-off-schedule')).toHaveClass('text-warning');
    // "Delivered" is the grade's alone.
    expect(screen.getByText('509 of 4800 contracted person-hours delivered')).toBeInTheDocument();
    expect(screen.queryByText(/Hours delivered/)).not.toBeInTheDocument();
  });

  it('within the schedule it reads "of N scheduled", no warning', async () => {
    renderPage(payload({ workedHours: 40, scheduledHours: 56.5, offScheduleHours: 0 }));
    expect(await screen.findByText('Hours worked · this period')).toBeInTheDocument();
    expect(screen.queryByTestId('hist-off-schedule')).not.toBeInTheDocument();
    expect(screen.getByText(/^of 56\.5h scheduled$/)).toBeInTheDocument();
  });
});
