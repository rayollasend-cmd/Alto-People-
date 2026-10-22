import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ControlRoomResponse } from '@alto-people/shared';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true }),
  useTenant: () => ({ id: 't1', modules: { robotics: true, scheduling: true }, moduleOn: () => true }),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock('@/lib/controlRoomApi', () => ({ listControlRoomSites: vi.fn(), getControlRoom: vi.fn() }));
vi.mock('@/lib/robotsApi', () => ({ stopRobot: vi.fn(), resumeRobot: vi.fn() }));
vi.mock('@/lib/tasksApi', () => ({ handOffTask: vi.fn() }));
vi.mock('@/lib/agentsApi', () => ({ resumeAllAgents: vi.fn(), suspendAllAgents: vi.fn() }));
vi.mock('@/pages/admin/AgentRegistryAdmin', () => ({ SuspendAllDialog: () => null }));

import { getControlRoom, listControlRoomSites } from '@/lib/controlRoomApi';
import { ControlRoomPage } from '@/pages/controlRoom/ControlRoomPage';

const room: ControlRoomResponse = {
  site: { id: 's1', name: 'Front Beach 218', timezone: 'America/Chicago', clientName: 'Coastal Resort Holdings' },
  asOf: '2026-10-15T20:00:00.000Z',
  strip: { onFloor: 5, expectedNow: 6, robotsRunning: 1, robotsOnShift: 2, exceptions: 2, waiting: 1 },
  people: [
    { associateId: 'a1', workerId: 'w1', name: 'Dana Reyes', position: 'Shift lead', shiftId: 'sh1', shiftStart: '2026-10-15T14:00:00.000Z', shiftEnd: '2026-10-15T22:00:00.000Z', clockedIn: true, clockInAt: '2026-10-15T13:58:00.000Z', late: false, crewLead: true },
    { associateId: 'a2', workerId: 'w2', name: 'Mateo Delgado', position: 'Stocker', shiftId: 'sh2', shiftStart: '2026-10-15T14:00:00.000Z', shiftEnd: '2026-10-15T22:00:00.000Z', clockedIn: false, clockInAt: null, late: true, crewLead: false },
  ],
  robots: [
    { id: 'r1', name: 'Servi 01', status: 'ACTIVE', fleetStatus: 'WORKING', batteryPct: 67, currentTask: 'Bussing · section A', x: 12, y: 12, readAt: '2026-10-15T19:59:00.000Z', onShift: true, shift: { id: 'rs1', startsAt: '2026-10-15T14:00:00.000Z', endsAt: '2026-10-15T22:00:00.000Z', position: 'Bussing' }, checklistReady: true, commissioned: true, openIncidents: 0 },
    { id: 'r2', name: 'Scrubber 02', status: 'ACTIVE', fleetStatus: 'ERROR', batteryPct: 40, currentTask: null, x: 30, y: 8, readAt: '2026-10-15T19:58:00.000Z', onShift: true, shift: null, checklistReady: false, commissioned: true, openIncidents: 1 },
  ],
  agents: [{ id: 'ag1', name: 'Workforce agent', family: 'workforce', capability: 'Fill open shifts', status: 'ACTIVE', lastActiveAt: '2026-10-15T19:00:00.000Z', pendingApprovals: 1 }],
  exceptions: [
    { kind: 'ROBOT_ERROR', id: 'robot:r2:error', robotId: 'r2', title: 'Scrubber 02', detail: 'The fleet reports an error', at: '2026-10-15T19:58:00.000Z', link: '/robots/r2' },
    { kind: 'TASK_STALLED', id: 'task:t1', taskId: 't1', title: 'Shelf scan · aisle 4', detail: 'Held by Servi 01', at: '2026-10-15T19:50:00.000Z', link: '/tasks?task=t1' },
  ],
  waiting: [{ kind: 'AGENT_APPROVAL', id: 'approval:ap1', title: 'Workforce agent asks: Fill tomorrow with Mateo Delgado', detail: 'Expires 2026-10-16 05:19', at: '2026-10-15T18:00:00.000Z', link: '/agents?approval=ap1' }],
  zones: [{ id: 'z1', locationId: 's1', name: 'Lobby', shape: { type: 'rect', x: 0, y: 0, w: 40, h: 20 }, guestOccupied: true, robotsAllowedWhenOccupied: false, occupiedSince: '2026-10-15T19:30:00.000Z' }],
  span: { robots: 2, leads: 1, maxPerLead: 4, allowed: 4, exceeded: false, text: '2 robots for 1 crew lead (4 per lead allowed).' },
  agentsSuspended: false,
  roboticsOn: true,
};

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/control-room?site=s1']}>
        <Routes>
          <Route path="/control-room" element={<ControlRoomPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<ControlRoomPage> (Brief 3-3)', () => {
  it('shows the site live: people and robots on one screen, the exceptions, what waits, the span', async () => {
    vi.mocked(listControlRoomSites).mockResolvedValue({ sites: [{ id: 's1', name: 'Front Beach 218', clientName: 'Coastal Resort Holdings', timezone: 'America/Chicago' }] });
    vi.mocked(getControlRoom).mockResolvedValue(room);
    renderPage();
    expect((await screen.findAllByText('Dana Reyes')).length).toBeGreaterThan(0);
    expect(screen.getByText('Crew lead')).toBeInTheDocument();
    expect(screen.getByText('Late')).toBeInTheDocument();
    expect(screen.getAllByText('Servi 01').length).toBeGreaterThan(0);
    expect(screen.getByText('Bussing · section A')).toBeInTheDocument();
    expect(screen.getByText('Workforce agent')).toBeInTheDocument();
    expect(screen.getByText('Robot error')).toBeInTheDocument();
    expect(screen.getByText('Task stalled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hand to a person/ })).toBeInTheDocument();
    expect(screen.getByText(/Workforce agent asks/)).toBeInTheDocument();
    expect(screen.getByText('2 robots for 1 crew lead (4 per lead allowed).')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Site map with 1 zones and 2 robots/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Stop/ }).length).toBeGreaterThan(0);
    // Stopping every agent is destructive: it waits in "More", behind its own confirm.
    expect(screen.queryByRole('button', { name: /Suspend all agents/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Suspend all agents/ })).toBeInTheDocument();
  });

  it('while the site loads, the page says so and offers nothing to act on', async () => {
    vi.mocked(listControlRoomSites).mockResolvedValue({ sites: [{ id: 's1', name: 'Front Beach 218', clientName: null, timezone: 'America/Chicago' }] });
    vi.mocked(getControlRoom).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByLabelText('Loading the control room')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument();
  });

  it('when the read fails, the page shows the error with a retry', async () => {
    vi.mocked(listControlRoomSites).mockResolvedValue({ sites: [{ id: 's1', name: 'Front Beach 218', clientName: null, timezone: 'America/Chicago' }] });
    vi.mocked(getControlRoom).mockRejectedValue(new Error('offline'));
    renderPage();
    expect(await screen.findByRole('button', { name: /Retry|Try again/i })).toBeInTheDocument();
  });
});
