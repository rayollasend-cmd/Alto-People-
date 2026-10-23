import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RobotDetail } from '@alto-people/shared';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true }),
  useTenant: () => ({ modules: { robotics: true }, moduleOn: () => true }),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock('@/lib/robotsApi', () => ({
  getRobot: vi.fn(),
  listRobotSamples: vi.fn(async () => ({ samples: [] })),
  listRobotEvents: vi.fn(async () => ({ events: [] })),
  listChecklistRuns: vi.fn(async () => ({ runs: [] })),
  listChecklistTemplates: vi.fn(async () => ({ templates: [] })),
  listRobotIncidents: vi.fn(async () => ({ incidents: [] })),
  listMaintenance: vi.fn(async () => ({ maintenance: [] })),
  getRobotIncident: vi.fn(),
  stopRobot: vi.fn(),
  resumeRobot: vi.fn(),
  startRobotShift: vi.fn(),
  completeChecklist: vi.fn(),
  saveCommissioning: vi.fn(),
  signOffCommissioning: vi.fn(),
  addMaintenance: vi.fn(),
  reportRobotIncident: vi.fn(),
  updateRobotProfile: vi.fn(),
  listSafetyZones: vi.fn(async () => ({
    zones: [{ id: 'z1', locationId: 's1', name: 'Lobby bar', shape: { type: 'rect', x: 0, y: 0, w: 40, h: 20 }, guestOccupied: false, robotsAllowedWhenOccupied: false, occupiedSince: null }],
  })),
}));
vi.mock('@/lib/clientsApi', () => ({ listClients: vi.fn(async () => ({ clients: [] })), listClientLocations: vi.fn(async () => ({ locations: [] })) }));
vi.mock('@/lib/usersAdminApi', () => ({ listAdminUsers: vi.fn(async () => ({ users: [] })) }));

import { getRobot } from '@/lib/robotsApi';
import { RobotRecord } from '@/pages/robots/RobotRecord';

const robot: RobotDetail = {
  id: 'r1',
  name: 'Servi 01',
  status: 'ACTIVE',
  owner: { id: 'u1', name: 'Dana Reyes' },
  capabilities: ['food-service'],
  profile: { manufacturer: 'Bear Robotics', model: 'Servi Plus', serial: 'SV-0001', firmware: '4.2.1', ownership: 'OWNED', leaseEndsOn: null, connectorProvider: 'SIMULATED', connectorExternalId: 'sim-01', certifications: [], notes: null },
  site: { id: 's1', name: 'Front Beach 218' },
  latest: { at: '2026-10-15T20:00:00.000Z', status: 'WORKING', batteryPct: 67, x: 12, y: 12, currentTask: 'Bussing · section A', errorCode: null },
  commissioned: true,
  checklistReady: false,
  openIncidents: 0,
  notes: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  commissionings: [{ id: 'c1', locationId: 's1', locationName: 'Front Beach 218', mapUrl: null, mapNotes: null, chargingStations: [{ label: 'Dock A', x: 2, y: 2 }], safetyLead: { id: 'u2', name: 'Dana Reyes' }, signedOffAt: '2026-10-02T00:00:00.000Z', notes: null }],
  recentEvents: [],
  upcomingShifts: [{ id: 'sh1', startsAt: '2026-10-16T14:00:00.000Z', endsAt: '2026-10-16T22:00:00.000Z', position: 'Room delivery', locationName: 'Front Beach 218', status: 'ASSIGNED', checklistDone: false }],
};

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/robots/r1']}>
        <Routes>
          <Route path="/robots/:id" element={<RobotRecord />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<RobotRecord>', () => {
  it('shows the loading state while the robot is fetched', () => {
    vi.mocked(getRobot).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByLabelText('Loading the robot')).toBeInTheDocument();
  });

  it('says so when the robot cannot be loaded', async () => {
    vi.mocked(getRobot).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });

  it('renders the record: name, fleet reading, battery, the shift waiting on its checklist, and the emergency stop', async () => {
    vi.mocked(getRobot).mockResolvedValue(robot);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Servi 01' })).toBeInTheDocument();
    expect(screen.getAllByText('Working').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Battery 67 percent')).toBeInTheDocument();
    expect(screen.getByText('Room delivery')).toBeInTheDocument();
    expect(screen.getByText('Due')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /emergency stop/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start shift/i })).toBeInTheDocument();
  });

  it('says where the robot is in the site\'s words: the zone, with the map units beside it (F500 G2)', async () => {
    renderPage();
    expect(await screen.findByText('Lobby bar')).toBeInTheDocument();
    expect(screen.getByText('Front Beach 218 · 12, 12 map units')).toBeInTheDocument();
  });
});
