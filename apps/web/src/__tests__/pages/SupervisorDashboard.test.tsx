import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/schedulingApi', () => ({
  listShifts: vi.fn(),
  getSchedulingKpis: vi.fn(),
}));
vi.mock('@/lib/clientsApi', () => ({ listClientLocations: vi.fn() }));
vi.mock('@/components/RoleDecisionQueue', () => ({ RoleDecisionQueue: () => <div>decision queue</div> }));
vi.mock('@/components/MyPlanCard', () => ({ MyPlanCard: () => <div>my plan</div> }));
vi.mock('@/pages/portal/portalCharts', async (orig) => ({
  ...(await orig<typeof import('@/pages/portal/portalCharts')>()),
  CoverageCurve: () => <div>coverage curve</div>,
  WeekFillChart: () => <div>week chart</div>,
}));

import { apiFetch } from '@/lib/api';
import { getSchedulingKpis, listShifts } from '@/lib/schedulingApi';
import { listClientLocations } from '@/lib/clientsApi';
import { SupervisorDashboard } from '@/pages/SupervisorDashboard';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const row = (id: string, name: string | null, state: string, from = -2, to = 6) => ({
  shiftId: id,
  associateId: name ? `a-${id}` : null,
  name,
  position: 'Server',
  isLead: false,
  clockInAt: state === 'on-floor' ? at(from) : null,
  clockOutAt: null,
  startsAt: at(from),
  endsAt: at(to),
  timezone: tz,
  locationName: 'Front Beach 218',
  state,
});

function day(roster: ReturnType<typeof row>[]) {
  return {
    client: { id: 'c1', name: 'Coastal Resort Holdings' },
    store: null,
    date: new Date().toISOString().slice(0, 10),
    today: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    target: 4,
    roster,
    summary: { expected: 3, worked: 2, onFloor: 2, missed: 0, open: 1 },
  };
}

function renderPage() {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/client-portal/day?date=')) return day([row('t1', 'Cy Dale', 'unconfirmed', 20, 28)]);
    if (path.startsWith('/client-portal/day'))
      return day([
        row('s1', 'Ann Lee', 'on-floor'),
        row('s2', 'Ben Ray', 'on-floor'),
        row('s3', 'Cy Dale', 'not-in'),
        row('s4', null, 'open'),
      ]);
    if (path === '/approvals/count')
      return { swaps: 1, pickups: 2, timeOff: 2, timesheets: 6, clockIns: 1, total: 12 };
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(listShifts).mockResolvedValue({ shifts: [] } as never);
  vi.mocked(getSchedulingKpis).mockResolvedValue({
    fillRatePercent: 94,
    assignedShifts: 80,
    completedShifts: 8,
    openShifts: 6,
    draftShifts: 0,
    totalShifts: 94,
    totalScheduledMinutes: 0,
    projectedLaborCost: null,
    shiftsWithoutRate: null,
    from: '',
    to: '',
  });
  vi.mocked(listClientLocations).mockResolvedValue({
    locations: [
      {
        id: 'l1',
        clientId: 'c1',
        name: 'Front Beach 218',
        addressLine1: '15495 Panama City Beach Pkwy',
        addressLine2: null,
        city: 'Panama City Beach',
        state: 'FL',
        zip: '32413',
        latitude: null,
        longitude: null,
        geofenceRadiusMeters: null,
        isActive: true,
      },
    ],
  } as never);

  const caps = ROLE_CAPABILITIES.SHIFT_SUPERVISOR;
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      email: 'dana.reyes@altohr.com',
      role: 'SHIFT_SUPERVISOR' as const,
      status: 'ACTIVE' as const,
      clientId: 'c1',
      clientName: 'Coastal Resort Holdings',
      associateId: 'a',
    },
    role: 'SHIFT_SUPERVISOR' as const,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <SupervisorDashboard />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<SupervisorDashboard> — My floor', () => {
  it('leads with the place and the floor against the contracted line', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Front Beach 218' })).toBeInTheDocument();
    expect(screen.getByText(/15495 Panama City Beach Pkwy · Panama City Beach, FL 32413/)).toBeInTheDocument();
    expect(screen.getByText('/ 4')).toBeInTheDocument();
    expect(screen.getByText(/2 short of the contracted headcount/)).toBeInTheDocument();
    expect(screen.getByText('coverage curve')).toBeInTheDocument();
  });

  it('carries the four numbers the week runs on, each explained', async () => {
    renderPage();
    expect(await screen.findByText('94%')).toBeInTheDocument();
    expect(screen.getByText('88 of 94 shifts filled')).toBeInTheDocument();
    expect(await screen.findByText('1 walk-in · 1 swap · 2 pickups · 2 time off · 6 timesheets')).toBeInTheDocument();
    expect(screen.getByText('Waiting on you').closest('a')).toHaveAttribute('href', '/approvals');
    expect(await screen.findByText(/1 awaiting confirmation/)).toBeInTheDocument();
  });

  it('shows shifts as waves and people as faces — never a roster of names, never money', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Front Beach 218' });
    expect(screen.getByText('Who is in').closest('a')).toHaveAttribute('href', '/today');
    for (const link of screen.getAllByRole('link', { name: /open schedule/i })) {
      expect(link).toHaveAttribute('href', '/scheduling');
    }
    // The names live on the face wall (/today), not as rows here.
    expect(screen.queryByText('Ann Lee')).not.toBeInTheDocument();
    expect(screen.queryByText('Cy Dale')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$/);
  });
});
