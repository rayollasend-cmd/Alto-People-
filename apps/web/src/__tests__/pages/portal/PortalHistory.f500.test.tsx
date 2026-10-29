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

const OVERVIEW = {
  statements: [
    {
      id: 's4', number: 4, periodStart: '2026-08-29', periodEnd: '2026-09-04', amount: 2880, hours: 128, storeHours: null,
      storeAmount: null, paidAt: null, dueAt: '2026-10-07', daysPastDue: 19, poNumber: null, pdfUrl: '/api/x.pdf', reviewed: null,
    },
  ],
  balance: { count: 1, amount: 2880, pastDue: 1 },
};

function renderPage(body: unknown) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/client-portal/history')) return body as never;
    // Billing reads the home's overview: the latest statements, whatever the range.
    if (path.startsWith('/client-portal/overview')) return OVERVIEW as never;
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
    expect(screen.getByTestId('hist-off-schedule')).toHaveTextContent('444.1h worked · 56.5h scheduled · 387.6h off-schedule');
    expect(screen.getByTestId('hist-off-schedule')).toHaveClass('text-warning');
    // "Delivered" is the grade's alone.
    expect(screen.getByText('509 of 4,800 contracted person-hours delivered')).toBeInTheDocument();
    // A percentage of contracted hours, never a letter grade (F500 2026-10-26).
    // The range is in the bar: the label fits its two lines at 1024 (LEAD-32).
    expect(screen.getByText('Contract hours delivered')).toBeInTheDocument();
    expect(screen.queryByText(/^[ABCDF]$/)).toBeNull();
    expect(screen.queryByText(/Hours delivered/)).not.toBeInTheDocument();
  });

  it('within the schedule it reads "of N scheduled", no warning', async () => {
    renderPage(payload({ workedHours: 40, scheduledHours: 56.5, offScheduleHours: 0 }));
    expect(await screen.findByText('Hours worked · this period')).toBeInTheDocument();
    expect(screen.queryByTestId('hist-off-schedule')).not.toBeInTheDocument();
    expect(screen.getByText(/^of 56\.5h scheduled$/)).toBeInTheDocument();
  });

  it('reviews only weeks that have ended, and keeps Billing apart from the range (F500 2026-10-26)', async () => {
    const today = new Date();
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ago = (n: number) => ymd(new Date(today.getTime() - n * 86_400_000));
    const body = {
      ...payload({}),
      serviceReports: [
        { weekStart: ago(10), weekEnd: ago(4), url: '/api/r1.pdf', reviewed: null },
        { weekStart: ago(3), weekEnd: ago(-3), url: '/api/r2.pdf', reviewed: null },
      ],
    };
    renderPage(body);
    expect(await screen.findByText('Service reports')).toBeInTheDocument();
    // One report to review (the finished week); the week in progress is said, not offered.
    expect(screen.getAllByRole('button', { name: /Mark reviewed/ })).toHaveLength(2); // the ended week + the unpaid statement
    expect(screen.getByText(/Week in progress/)).toBeInTheDocument();
    const billing = await screen.findByTestId('portal-billing');
    expect(billing).toHaveTextContent('Billing');
    expect(billing).toHaveTextContent('$2,880.00');
    expect(billing).toHaveTextContent('19 days past due');
  });
});
