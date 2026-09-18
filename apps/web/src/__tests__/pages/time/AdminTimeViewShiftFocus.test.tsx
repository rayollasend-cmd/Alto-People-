import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, minuteOfDayInZone, type Capability } from '@alto-people/shared';

vi.mock('@/lib/timeApi', () => ({
  countAdminTimeEntries: vi.fn(async () => ({ count: 0 })),
  getActiveDashboard: vi.fn(),
  listAdminTimeEntries: vi.fn(async () => ({ entries: [] })),
  listPayPeriods: vi.fn(async () => ({ periods: [] })),
}));
vi.mock('@/lib/directoryApi', () => ({ listDirectory: vi.fn(async () => ({ associates: [] })) }));
vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn(async () => ({ clients: [] })),
  listClientLocations: vi.fn(async () => ({ locations: [] })),
}));
vi.mock('@/lib/schedulingApi', () => ({
  listShifts: vi.fn(async () => ({ shifts: [] })),
  listSchedulingAssociates: vi.fn(async () => ({ associates: [] })),
}));
vi.mock('@/lib/shiftWindowsApi', () => ({ getMyShiftWindows: vi.fn() }));

import { getActiveDashboard } from '@/lib/timeApi';
import { getMyShiftWindows } from '@/lib/shiftWindowsApi';
import { AdminTimeView } from '@/pages/time/AdminTimeView';
import { AuthContext } from '@/lib/auth';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const mod = (h: number) => minuteOfDayInZone(new Date(Date.now() + h * 3_600_000), tz);

const entry = (id: string, name: string, shiftFrom: number | null, locationId = 'l1') => ({
  id,
  associateId: `a-${id}`,
  associateName: name,
  clientId: 'c1',
  clientName: 'Coastal',
  jobId: null,
  jobName: null,
  clockInAt: at(shiftFrom ?? 0),
  minutesElapsed: 30,
  onBreak: false,
  geofenceOk: true,
  clockInLat: null,
  clockInLng: null,
  locationTimezone: tz,
  locationId,
  shiftStartsAt: shiftFrom === null ? null : at(shiftFrom),
  shiftEndsAt: shiftFrom === null ? null : at(shiftFrom + 8),
});

beforeEach(() => {
  sessionStorage.removeItem('alto.floor.focus');
  // Swing runs from 3 hours ago to an hour from now at store l1.
  vi.mocked(getMyShiftWindows).mockResolvedValue({
    windows: [
      { locationId: 'l1', locationName: 'Front Beach 218', timezone: tz, label: 'Swing', startMinute: mod(-3), endMinute: mod(1), targetCount: 4 },
    ],
  });
  vi.mocked(getActiveDashboard).mockResolvedValue({
    entries: [
      entry('e1', 'Ann Lee', -2), // on Swing
      entry('e2', 'Zed Old', -8), // an earlier shift
      entry('e3', 'Wes Park', null), // walk-in, clocked in now → Swing
      entry('e4', 'Pat Oh', -2, 'l2'), // Swing hours, another store
    ],
  } as never);
});

function renderBoard() {
  const caps = ROLE_CAPABILITIES.SHIFT_SUPERVISOR;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'dana@altohr.com', role: 'SHIFT_SUPERVISOR', status: 'ACTIVE', clientId: 'c1', associateId: null },
          role: 'SHIFT_SUPERVISOR',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter>
          <AdminTimeView canManage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('<AdminTimeView> live board — a supervisor opens on their shift', () => {
  it('shows their crew (walk-ins by clock-in), and the whole store one tap away', async () => {
    const user = renderBoard();
    expect(await screen.findByRole('radio', { name: /My shift · Swing/ })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByText('Ann Lee')).toBeInTheDocument();
    expect(screen.getByText('Wes Park')).toBeInTheDocument();
    expect(screen.queryByText('Zed Old')).not.toBeInTheDocument();
    expect(screen.queryByText('Pat Oh')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Whole store' }));
    expect(await screen.findByText('Zed Old')).toBeInTheDocument();
    expect(screen.getByText('Pat Oh')).toBeInTheDocument();
  });

  it("says when nobody on their shift is in, and offers the whole store", async () => {
    vi.mocked(getActiveDashboard).mockResolvedValue({ entries: [entry('e2', 'Zed Old', -8)] } as never);
    const user = renderBoard();
    expect(await screen.findByText('No one on your shift is clocked in')).toBeInTheDocument();
    expect(screen.getByText('1 clocked in on other shifts.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show the whole store' }));
    expect(await screen.findByText('Zed Old')).toBeInTheDocument();
  });
});
